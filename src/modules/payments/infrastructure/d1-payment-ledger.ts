import {
  planPaymentCapture,
  type PlannedPartialRefund,
  type PlannedTotalRefund,
  type PaymentCaptureDraft,
  type PaymentLedgerEntry,
  type PaymentProvider,
  type PlannedRefundCaptureAllocation,
  type RefundableCapture,
  type RefundLedgerEntry,
  type RefundStatus,
} from '../domain/payment-ledger';
import type { RefundGatewayResult } from '../application/refund-gateway';

export type PaymentLedgerGuard = Readonly<{ eventId: string }>;

export type PendingPaymentInput = Readonly<{
  provider: Exclude<PaymentProvider, 'legacy'>;
  provider_reference: string;
  currency: string;
  occurred_at: string;
  stored_value_expected_cents?: number;
}>;

export type TotalRefundIntentInput = Readonly<{
  order_id: number;
  reason: string;
  occurred_at: string;
  idempotency_key: string;
  planned: PlannedTotalRefund;
  allocations?: readonly PlannedRefundCaptureAllocation[];
}>;

export type PartialRefundIntentInput = Readonly<{
  order_id: number;
  reason: string;
  occurred_at: string;
  idempotency_key: string;
  planned: PlannedPartialRefund;
  allocations?: readonly PlannedRefundCaptureAllocation[];
}>;

export type AdjustmentRefundIntentInput = Readonly<{
  amendment_id: string;
  order_id: number;
  reason: string;
  occurred_at: string;
  idempotency_key: string;
  total_cents: number;
  allocations?: readonly PlannedRefundCaptureAllocation[];
}>;

export type ReturnRefundIntentInput = Readonly<{
  order_id: number;
  reason: string;
  occurred_at: string;
  idempotency_key: string;
  lines: readonly Readonly<{
    order_item_id: number;
    quantity: number;
    amount_cents: number;
  }>[];
  total_cents: number;
  allocations?: readonly PlannedRefundCaptureAllocation[];
}>;

export type RefundPaymentAllocationRecord = Readonly<{
  id: number;
  refund_id: number;
  payment_id: number;
  capture_transaction_id: number;
  amount_cents: number;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'requires_review' | 'cancelled';
  provider_reference: string | null;
  payment_reference: string;
  idempotency_key: string;
  version: number;
}>;

export type RefundItemLedgerLine = Readonly<{
  order_item_id: number;
  quantity: number;
  amount_cents: number;
  restock_decision: 'pending' | 'none' | 'restock';
}>;

export function createD1PaymentLedger(db: D1Database) {
  function allocationStatements(
    refundKey: string,
    allocations: readonly PlannedRefundCaptureAllocation[],
    occurredAt: string,
  ): readonly D1PreparedStatement[] {
    if (allocations.length < 1) throw new RangeError('el reembolso exige saldo de captura asignado.');
    return allocations.map((allocation, index) => db.prepare(`
      INSERT INTO refund_payment_allocations (
        refund_id, payment_id, capture_transaction_id, amount_cents,
        status, provider_reference, idempotency_key, version,
        created_at, updated_at
      )
      SELECT r.id, r.payment_id, capture.id, ?, 'pending', NULL, ?, 1, ?, ?
      FROM refunds r
      JOIN payment_transactions capture
        ON capture.id = ? AND capture.payment_id = r.payment_id
      WHERE r.idempotency_key = ?
        AND NOT EXISTS (
          SELECT 1 FROM refund_payment_allocations existing
          WHERE existing.idempotency_key = ?
        )
    `).bind(
      allocation.amount_cents,
      `${refundKey}:allocation:${index + 1}`,
      occurredAt,
      occurredAt,
      allocation.capture_transaction_id,
      refundKey,
      `${refundKey}:allocation:${index + 1}`,
    ));
  }

  return Object.freeze({
    pendingForOrderStatement(
      orderNumber: string,
      input: PendingPaymentInput,
      guard: PaymentLedgerGuard,
    ): D1PreparedStatement {
      const storedValueCents = input.stored_value_expected_cents ?? 0;
      if (!Number.isSafeInteger(storedValueCents) || storedValueCents < 0) {
        throw new RangeError('stored_value_expected_cents inválido.');
      }
      return db.prepare(`
        INSERT INTO payments (
          order_id, provider, provider_reference, currency,
          expected_amount_cents, stored_value_expected_cents, status, version, idempotency_key,
          created_at, updated_at
        )
        SELECT
          o.id, ?, ?, o.currency, o.total_cents-?, ?, 'pending', 1,
          'r2:payment:order:' || o.id || ':primary', ?, ?
        FROM orders o
        WHERE o.order_number = ? AND o.currency = ?
          AND o.total_cents >= ?
          AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
      `).bind(
        input.provider,
        input.provider_reference,
        storedValueCents,
        storedValueCents,
        input.occurred_at,
        input.occurred_at,
        orderNumber,
        input.currency,
        storedValueCents,
        guard.eventId,
      );
    },

    findByOrderId(orderId: number): Promise<PaymentLedgerEntry | null> {
      return db.prepare(`
        SELECT id, order_id, provider, provider_reference, currency,
               expected_amount_cents, stored_value_expected_cents, status, version,
               COALESCE((
                 SELECT sum(t.amount_cents) FROM payment_transactions t
                 WHERE t.payment_id = payments.id
                   AND t.type = 'refund' AND t.status = 'succeeded'
               ), 0) + COALESCE((
                 SELECT sum(allocation.amount_cents)
                 FROM stored_value_refund_allocations allocation
                 JOIN refunds refund ON refund.id=allocation.refund_id
                 WHERE refund.payment_id=payments.id AND allocation.status='succeeded'
               ), 0) AS refunded_cents,
               COALESCE((
                 SELECT sum(r.total_cents) FROM refunds r
                 WHERE r.payment_id = payments.id
                   AND r.operation_type = 'adjustment' AND r.status = 'succeeded'
               ), 0) AS adjustment_refunded_cents,
               COALESCE((
                 SELECT sum(r.total_cents) FROM refunds r
                 WHERE r.payment_id = payments.id
                   AND r.operation_type <> 'adjustment' AND r.status = 'succeeded'
               ), 0) AS cancellation_refunded_cents
        FROM payments
        WHERE order_id = ? AND idempotency_key = ?
        LIMIT 1
      `).bind(orderId, `r2:payment:order:${orderId}:primary`).first<PaymentLedgerEntry>();
    },

    async refundableCaptures(orderId: number): Promise<readonly RefundableCapture[]> {
      const { results } = await db.prepare(`
        SELECT capture.id AS transaction_id, capture.payment_id,
               capture.provider_reference, capture.amount_cents,
               COALESCE((
                 SELECT sum(allocation.amount_cents)
                 FROM refund_payment_allocations allocation
                 WHERE allocation.capture_transaction_id = capture.id
                   AND allocation.status <> 'cancelled'
               ), 0) AS allocated_cents,
               capture.occurred_at
        FROM payment_transactions capture
        JOIN payments p ON p.id = capture.payment_id
        WHERE p.order_id = ?
          AND capture.type = 'capture' AND capture.status = 'succeeded'
          AND capture.provider_reference IS NOT NULL
        ORDER BY capture.occurred_at DESC, capture.id DESC
      `).bind(orderId).all<RefundableCapture>();
      return Object.freeze(results.map((capture) => Object.freeze(capture)));
    },

    findTotalRefundByOrderId(orderId: number): Promise<RefundLedgerEntry | null> {
      return db.prepare(`
        SELECT r.id, r.order_id, r.payment_id, r.status, r.reason,
               r.subtotal_cents, r.shipping_cents, r.total_cents,
               r.provider_reference, r.idempotency_key, r.version,
               r.operation_type,
               COALESCE((
                 SELECT min(ri.restock_decision) FROM refund_items ri
                 WHERE ri.refund_id = r.id AND ri.restock_decision IN ('none', 'restock')
               ), 'none') AS restock_decision
        FROM refunds r
        WHERE r.order_id = ? AND r.operation_type = 'total_cancellation'
        ORDER BY r.id
        LIMIT 1
      `).bind(orderId).first<RefundLedgerEntry>();
    },

    findRefundByIdempotencyKey(idempotencyKey: string): Promise<RefundLedgerEntry | null> {
      return db.prepare(`
        SELECT r.id, r.order_id, r.payment_id, r.status, r.reason,
               r.subtotal_cents, r.shipping_cents, r.total_cents,
               r.provider_reference, r.idempotency_key, r.version,
               r.operation_type,
               COALESCE((
                 SELECT min(ri.restock_decision) FROM refund_items ri
                 WHERE ri.refund_id = r.id AND ri.restock_decision IN ('none', 'restock')
               ), 'none') AS restock_decision
        FROM refunds r WHERE r.idempotency_key = ? LIMIT 1
      `).bind(idempotencyKey).first<RefundLedgerEntry>();
    },

    findRefundByAmendmentId(amendmentId: string): Promise<RefundLedgerEntry | null> {
      return db.prepare(`
        SELECT r.id, r.order_id, r.payment_id, r.status, r.reason,
               r.subtotal_cents, r.shipping_cents, r.total_cents,
               r.provider_reference, r.idempotency_key, r.version,
               r.operation_type, r.amendment_id, 'none' AS restock_decision
        FROM refunds r WHERE r.amendment_id = ? LIMIT 1
      `).bind(amendmentId).first<RefundLedgerEntry>();
    },

    async listRefundsForOrder(orderId: number): Promise<readonly RefundLedgerEntry[]> {
      const { results } = await db.prepare(`
        SELECT r.id, r.order_id, r.payment_id, r.status, r.reason,
               r.subtotal_cents, r.shipping_cents, r.total_cents,
               r.provider_reference, r.idempotency_key, r.version,
               r.operation_type,
               COALESCE((
                 SELECT min(ri.restock_decision) FROM refund_items ri
                 WHERE ri.refund_id = r.id AND ri.restock_decision IN ('none', 'restock')
               ), 'none') AS restock_decision
        FROM refunds r WHERE r.order_id = ? ORDER BY r.id DESC
      `).bind(orderId).all<RefundLedgerEntry>();
      return results;
    },

    async refundItems(refundId: number): Promise<readonly RefundItemLedgerLine[]> {
      const { results } = await db.prepare(`
        SELECT order_item_id, quantity, amount_cents, restock_decision
        FROM refund_items WHERE refund_id = ? ORDER BY order_item_id
      `).bind(refundId).all<RefundItemLedgerLine>();
      return results;
    },

    createTotalRefundIntentStatements(
      payment: PaymentLedgerEntry,
      input: TotalRefundIntentInput,
    ): readonly D1PreparedStatement[] {
      const reason = input.reason.trim();
      if (reason.length < 1 || reason.length > 240) throw new RangeError('motivo de reembolso inválido.');
      const statements: D1PreparedStatement[] = [
        db.prepare(`
          INSERT INTO refunds (
            order_id, payment_id, status, reason, subtotal_cents,
            shipping_cents, total_cents, provider_reference,
            idempotency_key, version, created_at, updated_at, operation_type
          )
          SELECT o.id, p.id, 'pending', ?, ?, ?, ?, NULL, ?, 1, ?, ?,
                 'total_cancellation'
          FROM payments p
          JOIN orders o ON o.id = p.order_id
          WHERE p.id = ? AND p.order_id = ? AND p.status = ? AND p.version = ?
            AND o.status = 'paid'
            AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.idempotency_key = ?)
        `).bind(
          reason,
          input.planned.subtotal_cents,
          input.planned.shipping_cents,
          input.planned.total_cents,
          input.idempotency_key,
          input.occurred_at,
          input.occurred_at,
          payment.id,
          input.order_id,
          payment.status,
          payment.version,
          input.idempotency_key,
        ),
      ];
      for (const line of input.planned.lines) {
        statements.push(db.prepare(`
          INSERT INTO refund_items (
            refund_id, order_item_id, quantity, amount_cents, restock_decision
          )
          SELECT r.id, ?, ?, ?, ?
          FROM refunds r
          WHERE r.idempotency_key = ?
            AND NOT EXISTS (
              SELECT 1 FROM refund_items ri
              WHERE ri.refund_id = r.id AND ri.order_item_id = ?
            )
        `).bind(
          line.order_item_id,
          line.quantity,
          line.amount_cents,
          input.planned.restock_decision,
          input.idempotency_key,
          line.order_item_id,
        ));
      }
      if (input.allocations && input.allocations.length > 0) {
        statements.push(...allocationStatements(input.idempotency_key, input.allocations, input.occurred_at));
      }
      return statements;
    },

    createPartialRefundIntentStatements(
      payment: PaymentLedgerEntry,
      input: PartialRefundIntentInput,
    ): readonly D1PreparedStatement[] {
      const reason = input.reason.trim();
      if (reason.length < 1 || reason.length > 240) {
        throw new RangeError('motivo de reembolso inválido.');
      }
      const statements: D1PreparedStatement[] = [
        db.prepare(`
          INSERT INTO refunds (
            order_id, payment_id, status, reason, subtotal_cents,
            shipping_cents, total_cents, provider_reference,
            idempotency_key, version, created_at, updated_at, operation_type
          )
          SELECT o.id, p.id, 'pending', ?, ?, ?, ?, NULL, ?, 1, ?, ?,
                 'partial_cancellation'
          FROM payments p
          JOIN orders o ON o.id = p.order_id
          WHERE p.id = ? AND p.order_id = ? AND p.status = ? AND p.version = ?
            AND o.status = 'paid'
            AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.idempotency_key = ?)
        `).bind(
          reason,
          input.planned.subtotal_cents,
          input.planned.shipping_cents,
          input.planned.total_cents,
          input.idempotency_key,
          input.occurred_at,
          input.occurred_at,
          payment.id,
          input.order_id,
          payment.status,
          payment.version,
          input.idempotency_key,
        ),
      ];
      for (const line of input.planned.lines) {
        statements.push(db.prepare(`
          INSERT INTO refund_items (
            refund_id, order_item_id, quantity, amount_cents, restock_decision
          )
          SELECT r.id, ?, ?, ?, ?
          FROM refunds r
          WHERE r.idempotency_key = ?
            AND NOT EXISTS (
              SELECT 1 FROM refund_items ri
              WHERE ri.refund_id = r.id AND ri.order_item_id = ?
            )
        `).bind(
          line.order_item_id,
          line.quantity,
          line.amount_cents,
          input.planned.restock_decision,
          input.idempotency_key,
          line.order_item_id,
        ));
      }
      if (input.allocations && input.allocations.length > 0) {
        statements.push(...allocationStatements(input.idempotency_key, input.allocations, input.occurred_at));
      }
      return statements;
    },

    createAdjustmentRefundIntentStatements(
      payment: PaymentLedgerEntry,
      input: AdjustmentRefundIntentInput,
    ): readonly D1PreparedStatement[] {
      const reason = input.reason.trim();
      if (reason.length < 1 || reason.length > 240) throw new RangeError('motivo de edición inválido.');
      if (!Number.isSafeInteger(input.total_cents) || input.total_cents < 1) {
        throw new RangeError('total_cents de ajuste inválido.');
      }
      const header = db.prepare(`
        INSERT INTO refunds (
          order_id, payment_id, status, reason, subtotal_cents,
          shipping_cents, total_cents, provider_reference,
          idempotency_key, version, created_at, updated_at,
          operation_type, amendment_id
        )
        SELECT o.id, p.id, 'pending', ?, ?, 0, ?, NULL, ?, 1, ?, ?,
               'adjustment', ?
        FROM payments p
        JOIN orders o ON o.id = p.order_id
        JOIN order_amendments amendment
          ON amendment.id = ? AND amendment.order_id = o.id
        WHERE p.id = ? AND p.order_id = ? AND p.status IN ('captured', 'partially_refunded')
          AND p.version = ? AND o.status = 'paid'
          AND amendment.status = 'pending_refund'
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.idempotency_key = ?)
      `).bind(
        reason,
        input.total_cents,
        input.total_cents,
        input.idempotency_key,
        input.occurred_at,
        input.occurred_at,
        input.amendment_id,
        input.amendment_id,
        payment.id,
        input.order_id,
        payment.version,
        input.idempotency_key,
      );
      return Object.freeze([
        header,
        ...(input.allocations && input.allocations.length > 0
          ? allocationStatements(input.idempotency_key, input.allocations, input.occurred_at)
          : []),
      ]);
    },

    createReturnRefundIntentStatements(
      payment: PaymentLedgerEntry,
      input: ReturnRefundIntentInput,
    ): readonly D1PreparedStatement[] {
      const reason = input.reason.trim();
      if (reason.length < 1 || reason.length > 240) throw new RangeError('motivo de devolución inválido.');
      if (!Number.isSafeInteger(input.total_cents) || input.total_cents < 1) {
        throw new RangeError('total_cents de devolución inválido.');
      }
      if (input.lines.length < 1 || input.lines.some((line) =>
        !Number.isSafeInteger(line.order_item_id) || line.order_item_id < 1 ||
        !Number.isSafeInteger(line.quantity) || line.quantity < 1 ||
        !Number.isSafeInteger(line.amount_cents) || line.amount_cents < 0)) {
        throw new RangeError('líneas de devolución inválidas.');
      }
      const statements: D1PreparedStatement[] = [db.prepare(`
        INSERT INTO refunds (
          order_id, payment_id, status, reason, subtotal_cents,
          shipping_cents, total_cents, provider_reference,
          idempotency_key, version, created_at, updated_at, operation_type
        )
        SELECT o.id, p.id, 'pending', ?, ?, 0, ?, NULL, ?, 1, ?, ?, 'return'
        FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.id = ? AND p.order_id = ?
          AND p.status IN ('captured', 'partially_refunded') AND p.version = ?
          AND o.status = 'delivered'
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.idempotency_key = ?)
      `).bind(reason, input.total_cents, input.total_cents, input.idempotency_key,
        input.occurred_at, input.occurred_at, payment.id, input.order_id,
        payment.version, input.idempotency_key)];
      for (const line of input.lines) {
        statements.push(db.prepare(`INSERT INTO refund_items (
          refund_id, order_item_id, quantity, amount_cents, restock_decision
        ) SELECT r.id, ?, ?, ?, 'none' FROM refunds r
          WHERE r.idempotency_key = ?
            AND NOT EXISTS (SELECT 1 FROM refund_items ri
              WHERE ri.refund_id = r.id AND ri.order_item_id = ?)`)
          .bind(line.order_item_id, line.quantity, line.amount_cents,
            input.idempotency_key, line.order_item_id));
      }
      if (input.allocations && input.allocations.length > 0) {
        statements.push(...allocationStatements(input.idempotency_key, input.allocations, input.occurred_at));
      }
      return Object.freeze(statements);
    },

    async refundAllocations(refundId: number): Promise<readonly RefundPaymentAllocationRecord[]> {
      const { results } = await db.prepare(`
        SELECT allocation.id, allocation.refund_id, allocation.payment_id,
               allocation.capture_transaction_id, allocation.amount_cents,
               allocation.status, allocation.provider_reference,
               capture.provider_reference AS payment_reference,
               allocation.idempotency_key, allocation.version
        FROM refund_payment_allocations allocation
        JOIN payment_transactions capture
          ON capture.id = allocation.capture_transaction_id
         AND capture.payment_id = allocation.payment_id
        WHERE allocation.refund_id = ? ORDER BY allocation.id
      `).bind(refundId).all<RefundPaymentAllocationRecord>();
      return Object.freeze(results.map((allocation) => Object.freeze(allocation)));
    },

    refundGatewayOutcomeStatement(
      refund: RefundLedgerEntry,
      result: RefundGatewayResult,
      occurredAt: string,
    ): D1PreparedStatement {
      if (result.status === 'succeeded') {
        throw new RangeError('un reembolso succeeded debe cerrarse con refundSuccessStatements.');
      }
      const status: Exclude<RefundStatus, 'pending' | 'succeeded' | 'cancelled'> = result.status;
      return db.prepare(`
        UPDATE refunds
        SET status = ?, provider_reference = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status <> 'succeeded'
      `).bind(status, result.providerReference, occurredAt, refund.id, refund.version);
    },

    refundAllocationOutcomeStatement(
      allocation: RefundPaymentAllocationRecord,
      result: RefundGatewayResult,
      occurredAt: string,
    ): D1PreparedStatement {
      const status = result.status === 'succeeded' ? 'processing' : result.status;
      return db.prepare(`
        UPDATE refund_payment_allocations
        SET status = ?, provider_reference = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status <> 'succeeded'
      `).bind(
        status, result.providerReference, occurredAt, allocation.id, allocation.version,
      );
    },

    refundStatusStatement(
      refund: RefundLedgerEntry,
      status: Extract<RefundStatus, 'pending' | 'processing' | 'failed' | 'requires_review'>,
      occurredAt: string,
    ): D1PreparedStatement {
      return db.prepare(`
        UPDATE refunds
        SET status = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status <> 'succeeded'
      `).bind(status, occurredAt, refund.id, refund.version);
    },

    refundAllocationSuccessStatements(
      allocation: RefundPaymentAllocationRecord,
      occurredAt: string,
      guard: PaymentLedgerGuard,
    ): readonly D1PreparedStatement[] {
      const transactionKey = `${allocation.idempotency_key}:transaction`;
      const providerReference = allocation.provider_reference;
      if (!providerReference?.trim()) throw new RangeError('la asignación no tiene referencia de reembolso.');
      return Object.freeze([
        db.prepare(`
          INSERT INTO payment_transactions (
            payment_id, type, amount_cents, currency, status,
            provider_reference, idempotency_key, occurred_at, created_at
          )
          SELECT allocation.payment_id, 'refund', allocation.amount_cents,
                 payment.currency, 'succeeded', allocation.provider_reference,
                 ?, ?, ?
          FROM refund_payment_allocations allocation
          JOIN payments payment ON payment.id = allocation.payment_id
          WHERE allocation.id = ? AND allocation.version = ?
            AND allocation.status = 'processing'
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM payment_transactions WHERE idempotency_key = ?
            )
        `).bind(
          transactionKey, occurredAt, occurredAt,
          allocation.id, allocation.version, guard.eventId, transactionKey,
        ),
        db.prepare(`
          UPDATE refund_payment_allocations
          SET status = 'succeeded', version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM payment_transactions
              WHERE payment_id = refund_payment_allocations.payment_id
                AND idempotency_key = ?
            )
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(
          occurredAt, allocation.id, allocation.version, transactionKey, guard.eventId,
        ),
      ]);
    },

    completeAllocatedRefundStatements(
      payment: PaymentLedgerEntry,
      refund: RefundLedgerEntry,
      paymentStatusAfter: 'partially_refunded' | 'refunded',
      occurredAt: string,
      guard: PaymentLedgerGuard,
    ): readonly D1PreparedStatement[] {
      return Object.freeze([
        db.prepare(`
          UPDATE payments
          SET status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = ? AND version = ?
            AND NOT EXISTS (
              SELECT 1 FROM refund_payment_allocations allocation
              WHERE allocation.refund_id = ? AND allocation.status <> 'succeeded'
            )
            AND NOT EXISTS (
              SELECT 1 FROM stored_value_refund_allocations allocation
              WHERE allocation.refund_id = ? AND allocation.status <> 'succeeded'
            )
            AND EXISTS (
              SELECT 1 FROM refund_payment_allocations allocation WHERE allocation.refund_id = ?
              UNION ALL
              SELECT 1 FROM stored_value_refund_allocations allocation WHERE allocation.refund_id = ?
            )
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(
          paymentStatusAfter, occurredAt, payment.id, payment.status,
          payment.version, refund.id, refund.id, refund.id, refund.id, guard.eventId,
        ),
        db.prepare(`
          UPDATE refunds
          SET status = 'succeeded',
              provider_reference = (
                SELECT COALESCE(
                  (SELECT min(provider_reference) FROM refund_payment_allocations
                   WHERE refund_id = refunds.id AND status = 'succeeded'),
                  'stored-value:' || refunds.id
                )
              ),
              version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND status <> 'succeeded'
            AND NOT EXISTS (
              SELECT 1 FROM refund_payment_allocations allocation
              WHERE allocation.refund_id = refunds.id AND allocation.status <> 'succeeded'
            )
            AND NOT EXISTS (
              SELECT 1 FROM stored_value_refund_allocations allocation
              WHERE allocation.refund_id = refunds.id AND allocation.status <> 'succeeded'
            )
            AND EXISTS (
              SELECT 1 FROM refund_payment_allocations allocation WHERE allocation.refund_id = refunds.id
              UNION ALL
              SELECT 1 FROM stored_value_refund_allocations allocation WHERE allocation.refund_id = refunds.id
            )
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(occurredAt, refund.id, refund.version, guard.eventId),
      ]);
    },

    additionalCaptureStatements(
      payment: PaymentLedgerEntry,
      input: Readonly<{
        amount_cents: number;
        provider_reference: string;
        idempotency_key: string;
        occurred_at: string;
      }>,
      guard: PaymentLedgerGuard,
    ): readonly D1PreparedStatement[] {
      if (!Number.isSafeInteger(input.amount_cents) || input.amount_cents < 1) {
        throw new RangeError('importe de captura adicional inválido.');
      }
      if (!input.provider_reference.trim() || !input.idempotency_key.trim()) {
        throw new RangeError('identidad de captura adicional inválida.');
      }
      const statusAfter = payment.refunded_cents > 0 ? 'partially_refunded' : 'captured';
      return Object.freeze([
        db.prepare(`
          UPDATE payments
          SET expected_amount_cents = expected_amount_cents + ?,
              status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status IN ('captured', 'partially_refunded') AND version = ?
            AND provider = ?
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(
          input.amount_cents, statusAfter, input.occurred_at,
          payment.id, payment.version, payment.provider, guard.eventId,
        ),
        db.prepare(`
          INSERT INTO payment_transactions (
            payment_id, type, amount_cents, currency, status,
            provider_reference, idempotency_key, occurred_at, created_at
          )
          SELECT id, 'capture', ?, currency, 'succeeded', ?, ?, ?, ?
          FROM payments
          WHERE id = ? AND version = ?
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM payment_transactions WHERE idempotency_key = ?
            )
        `).bind(
          input.amount_cents, input.provider_reference, input.idempotency_key,
          input.occurred_at, input.occurred_at,
          payment.id, payment.version + 1, guard.eventId, input.idempotency_key,
        ),
      ]);
    },

    refundSuccessStatements(
      payment: PaymentLedgerEntry,
      refund: RefundLedgerEntry,
      providerReference: string,
      occurredAt: string,
      guard: PaymentLedgerGuard,
      paymentStatusAfter: 'partially_refunded' | 'refunded' = 'refunded',
    ): readonly D1PreparedStatement[] {
      const transactionKey = `${refund.idempotency_key}:transaction`;
      return [
        db.prepare(`
          INSERT INTO payment_transactions (
            payment_id, type, amount_cents, currency, status,
            provider_reference, idempotency_key, occurred_at, created_at
          )
          SELECT ?, 'refund', ?, ?, 'succeeded', ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
            AND EXISTS (
              SELECT 1 FROM payments
              WHERE id = ? AND status = ? AND version = ?
            )
            AND EXISTS (
              SELECT 1 FROM refunds
              WHERE id = ? AND version = ? AND status <> 'succeeded'
            )
        `).bind(
          payment.id,
          refund.total_cents,
          payment.currency,
          providerReference,
          transactionKey,
          occurredAt,
          occurredAt,
          guard.eventId,
          payment.id,
          payment.status,
          payment.version,
          refund.id,
          refund.version,
        ),
        db.prepare(`
          UPDATE payments
          SET status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = ? AND version = ?
            AND EXISTS (
              SELECT 1 FROM payment_transactions
              WHERE payment_id = payments.id AND idempotency_key = ?
            )
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(
          paymentStatusAfter,
          occurredAt,
          payment.id,
          payment.status,
          payment.version,
          transactionKey,
          guard.eventId,
        ),
        db.prepare(`
          UPDATE refunds
          SET status = 'succeeded', provider_reference = ?,
              version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND status <> 'succeeded'
            AND EXISTS (
              SELECT 1 FROM payment_transactions
              WHERE payment_id = ? AND idempotency_key = ?
            )
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(
          providerReference,
          occurredAt,
          refund.id,
          refund.version,
          payment.id,
          transactionKey,
          guard.eventId,
        ),
      ];
    },

    captureStatements(
      payment: PaymentLedgerEntry,
      draft: PaymentCaptureDraft,
      guard: PaymentLedgerGuard,
    ): readonly D1PreparedStatement[] {
      const planned = planPaymentCapture(payment, draft);
      return [
        db.prepare(`
          INSERT INTO payment_transactions (
            payment_id, type, amount_cents, currency, status,
            provider_reference, idempotency_key, occurred_at, created_at
          )
          SELECT ?, 'capture', ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
            AND EXISTS (
              SELECT 1 FROM payments
              WHERE id = ? AND status = 'pending' AND version = ?
            )
        `).bind(
          payment.id,
          planned.amount_cents,
          planned.currency,
          planned.transaction_status,
          planned.provider_reference,
          planned.idempotency_key,
          planned.occurred_at,
          planned.occurred_at,
          guard.eventId,
          payment.id,
          payment.version,
        ),
        db.prepare(`
          UPDATE payments
          SET status = ?, provider_reference = ?, version = ?, updated_at = ?
          WHERE id = ? AND status = 'pending' AND version = ?
            AND EXISTS (
              SELECT 1 FROM payment_transactions
              WHERE idempotency_key = ? AND payment_id = payments.id
            )
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(
          planned.status,
          planned.provider_reference,
          planned.version_after,
          planned.occurred_at,
          payment.id,
          payment.version,
          planned.idempotency_key,
          guard.eventId,
        ),
      ];
    },

    cancelPendingStatement(
      payment: PaymentLedgerEntry,
      occurredAt: string,
      guard: PaymentLedgerGuard,
    ): D1PreparedStatement {
      return db.prepare(`
        UPDATE payments
        SET status = 'cancelled', version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'pending' AND version = ?
          AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
      `).bind(occurredAt, payment.id, payment.version, guard.eventId);
    },

    requireReviewStatement(
      payment: PaymentLedgerEntry,
      occurredAt: string,
      guard: PaymentLedgerGuard,
    ): D1PreparedStatement {
      return db.prepare(`
        UPDATE payments
        SET status = 'requires_review', version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'captured' AND version = ?
          AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
      `).bind(occurredAt, payment.id, payment.version, guard.eventId);
    },
  });
}

export type D1PaymentLedger = ReturnType<typeof createD1PaymentLedger>;
