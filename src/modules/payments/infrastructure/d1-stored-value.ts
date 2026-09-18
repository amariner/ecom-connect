import {
  authorizeStoredValue,
  giftCardCodeHash,
  type StoredValueAccount,
  type StoredValueAuthorization,
  type StoredValueKind,
  type StoredValueState,
} from '../domain/stored-value';

export type StoredValueIssueInput = Readonly<{
  id: string;
  kind: StoredValueKind;
  label: string;
  currency: string;
  amountCents: number;
  codeHash?: string;
  ownerKeyHash?: string;
  expiresAt: string | null;
  policy: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  occurredAt: string;
}>;

export type StoredValueReservationRecord = Readonly<{
  id: string;
  account_id: string;
  order_id: number;
  amount_cents: number;
  status: 'active' | 'captured' | 'released';
  snapshot_json: string;
  idempotency_key: string;
  version: number;
}>;

export type StoredValueApplicationRecord = Readonly<{
  id: string;
  account_id: string;
  reservation_id: string;
  order_id: number;
  amount_cents: number;
  snapshot_json: string;
  refundable_cents?: number;
}>;

export type StoredValueRefundAllocationRecord = Readonly<{
  id: string;
  refund_id: number;
  application_id: string;
  account_id: string;
  amount_cents: number;
  status: 'pending' | 'succeeded' | 'cancelled';
  idempotency_key: string;
  version: number;
}>;

export type StoredValueGuard = Readonly<{ eventId: string }>;

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function assertHash(value: string | undefined, field: string): void {
  if (value !== undefined && !/^[a-f0-9]{64}$/.test(value)) throw new RangeError(`${field} inválido.`);
}

export function createD1StoredValue(db: D1Database) {
  async function findByGiftCardCode(code: string): Promise<StoredValueAccount | null> {
    const hash = await giftCardCodeHash(code);
    return db.prepare(`SELECT id, kind, state, currency, label, balance_cents,
      reserved_cents, version, expires_at FROM stored_value_accounts
      WHERE kind='gift_card' AND code_hash=?`).bind(hash).first<StoredValueAccount>();
  }

  return Object.freeze({
    issueStatements(input: StoredValueIssueInput): readonly D1PreparedStatement[] {
      if (!/^[A-Z]{3}$/.test(input.currency) || !Number.isSafeInteger(input.amountCents) || input.amountCents < 1) {
        throw new RangeError('Moneda o importe de emisión inválido.');
      }
      assertHash(input.codeHash, 'codeHash');
      assertHash(input.ownerKeyHash, 'ownerKeyHash');
      if ((input.kind === 'gift_card') !== (input.codeHash !== undefined) ||
          (input.kind === 'store_credit') !== (input.ownerKeyHash !== undefined)) {
        throw new RangeError('Identidad de saldo incompatible con su tipo.');
      }
      const policyJson = JSON.stringify(input.policy);
      const metadataJson = JSON.stringify({ schema: 1, source: 'admin_issuance' });
      return Object.freeze([
        db.prepare(`INSERT INTO stored_value_accounts (
          id, kind, state, currency, label, code_hash, owner_key_hash,
          balance_cents, reserved_cents, expires_at, policy_json, version,
          created_at, updated_at
        ) SELECT ?, ?, 'active', ?, ?, ?, ?, 0, 0, ?, ?, 1, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE idempotency_key=?)`)
          .bind(input.id, input.kind, input.currency, input.label.trim(), input.codeHash ?? null,
            input.ownerKeyHash ?? null, input.expiresAt, policyJson, input.occurredAt,
            input.occurredAt, input.idempotencyKey),
        db.prepare(`INSERT INTO stored_value_ledger_entries (
          id, account_id, type, balance_delta_cents, reserved_delta_cents,
          balance_after_cents, reserved_after_cents, version_after,
          order_id, refund_id, idempotency_key, metadata_json, occurred_at
        ) SELECT ?, id, 'issuance', ?, 0, ?, 0, 2, NULL, NULL, ?, ?, ?
          FROM stored_value_accounts WHERE id=? AND version=1 AND balance_cents=0
            AND NOT EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE idempotency_key=?)`)
          .bind(randomId('svle'), input.amountCents, input.amountCents, input.idempotencyKey,
            metadataJson, input.occurredAt, input.id, input.idempotencyKey),
        db.prepare(`UPDATE stored_value_accounts SET balance_cents=?, version=2, updated_at=?
          WHERE id=? AND version=1 AND balance_cents=0 AND EXISTS (
            SELECT 1 FROM stored_value_ledger_entries
            WHERE account_id=stored_value_accounts.id AND idempotency_key=?
              AND balance_after_cents=? AND version_after=2
          )`).bind(input.amountCents, input.occurredAt, input.id, input.idempotencyKey, input.amountCents),
      ]);
    },

    creditStatements(
      account: StoredValueAccount,
      amountCents: number,
      idempotencyKey: string,
      occurredAt: string,
      metadata: Readonly<Record<string, unknown>> = {},
    ): readonly D1PreparedStatement[] {
      if (!Number.isSafeInteger(amountCents) || amountCents < 1 || !idempotencyKey.trim()) {
        throw new RangeError('Crédito de saldo inválido.');
      }
      const after = account.balance_cents + amountCents;
      if (!Number.isSafeInteger(after)) throw new RangeError('El saldo supera el entero seguro.');
      return Object.freeze([
        db.prepare(`INSERT INTO stored_value_ledger_entries (
          id, account_id, type, balance_delta_cents, reserved_delta_cents,
          balance_after_cents, reserved_after_cents, version_after,
          order_id, refund_id, idempotency_key, metadata_json, occurred_at
        ) SELECT ?, id, 'issuance', ?, 0, balance_cents+?, reserved_cents,
          version+1, NULL, NULL, ?, ?, ? FROM stored_value_accounts
          WHERE id=? AND version=?
            AND NOT EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE idempotency_key=?)`)
          .bind(randomId('svle'), amountCents, amountCents, idempotencyKey,
            JSON.stringify(metadata), occurredAt, account.id, account.version, idempotencyKey),
        db.prepare(`UPDATE stored_value_accounts SET balance_cents=balance_cents+?,
          version=version+1, updated_at=? WHERE id=? AND version=?
            AND EXISTS (SELECT 1 FROM stored_value_ledger_entries
              WHERE account_id=? AND idempotency_key=? AND version_after=?)`)
          .bind(amountCents, occurredAt, account.id, account.version, account.id,
            idempotencyKey, account.version + 1),
      ]);
    },

    findById(id: string): Promise<StoredValueAccount | null> {
      return db.prepare(`SELECT id, kind, state, currency, label, balance_cents,
        reserved_cents, version, expires_at FROM stored_value_accounts WHERE id=?`)
        .bind(id).first<StoredValueAccount>();
    },

    ledgerAccountId(idempotencyKey: string): Promise<{ account_id: string } | null> {
      return db.prepare(`SELECT account_id FROM stored_value_ledger_entries
        WHERE idempotency_key=?`).bind(idempotencyKey).first<{ account_id: string }>();
    },

    findByGiftCardCode,

    findByOwnerKeyHash(ownerKeyHash: string, currency: string): Promise<StoredValueAccount | null> {
      assertHash(ownerKeyHash, 'ownerKeyHash');
      return db.prepare(`SELECT id, kind, state, currency, label, balance_cents,
        reserved_cents, version, expires_at FROM stored_value_accounts
        WHERE kind='store_credit' AND owner_key_hash=? AND currency=? ORDER BY id LIMIT 1`)
        .bind(ownerKeyHash, currency).first<StoredValueAccount>();
    },

    async authorizeGiftCard(input: Readonly<{
      code: string; requestedCents: number; orderTotalCents: number; currency: string; at: string;
    }>): Promise<StoredValueAuthorization | null> {
      const account = await findByGiftCardCode(input.code);
      return account ? authorizeStoredValue({ account, ...input }) : null;
    },

    reservationStatements(
      orderNumber: string,
      authorization: StoredValueAuthorization,
      occurredAt: string,
      guard: StoredValueGuard,
    ): readonly D1PreparedStatement[] {
      const reservationId = randomId('svr');
      const idempotencyKey = `stored-value:order:${orderNumber}:reservation`;
      const ledgerKey = `${idempotencyKey}:ledger`;
      const snapshotJson = JSON.stringify(authorization.snapshot);
      return Object.freeze([
        db.prepare(`INSERT INTO stored_value_reservations (
          id, account_id, order_id, amount_cents, status, snapshot_json,
          idempotency_key, version, created_at, updated_at, captured_at, released_at
        ) SELECT ?, account.id, orders.id, ?, 'active', ?, ?, 1, ?, ?, NULL, NULL
          FROM stored_value_accounts account JOIN orders ON orders.order_number=?
          WHERE account.id=? AND account.version=? AND account.state='active'
            AND account.currency=? AND account.balance_cents-account.reserved_cents>=?
            AND (account.expires_at IS NULL OR account.expires_at>?)
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id=?)
            AND NOT EXISTS (SELECT 1 FROM stored_value_reservations WHERE order_id=orders.id)`)
          .bind(reservationId, authorization.amountCents, snapshotJson, idempotencyKey,
            occurredAt, occurredAt, orderNumber, authorization.accountId,
            authorization.accountVersion, authorization.currency, authorization.amountCents,
            occurredAt, guard.eventId),
        db.prepare(`INSERT INTO stored_value_ledger_entries (
          id, account_id, type, balance_delta_cents, reserved_delta_cents,
          balance_after_cents, reserved_after_cents, version_after,
          order_id, refund_id, idempotency_key, metadata_json, occurred_at
        ) SELECT ?, account.id, 'reservation', 0, reservation.amount_cents,
          account.balance_cents, account.reserved_cents+reservation.amount_cents,
          account.version+1, reservation.order_id, NULL, ?, '{}', ?
          FROM stored_value_reservations reservation
          JOIN stored_value_accounts account ON account.id=reservation.account_id
          WHERE reservation.id=? AND account.version=?
            AND NOT EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE idempotency_key=?)`)
          .bind(randomId('svle'), ledgerKey, occurredAt, reservationId,
            authorization.accountVersion, ledgerKey),
        db.prepare(`UPDATE stored_value_accounts SET
          reserved_cents=reserved_cents+?, version=version+1, updated_at=?
          WHERE id=? AND version=? AND EXISTS (
            SELECT 1 FROM stored_value_ledger_entries WHERE account_id=?
              AND idempotency_key=? AND version_after=?
          )`).bind(authorization.amountCents, occurredAt, authorization.accountId,
            authorization.accountVersion, authorization.accountId, ledgerKey,
            authorization.accountVersion + 1),
      ]);
    },

    reservationForOrder(orderId: number): Promise<StoredValueReservationRecord | null> {
      return db.prepare(`SELECT id, account_id, order_id, amount_cents, status,
        snapshot_json, idempotency_key, version FROM stored_value_reservations WHERE order_id=?`)
        .bind(orderId).first<StoredValueReservationRecord>();
    },

    applicationForOrder(orderId: number): Promise<StoredValueApplicationRecord | null> {
      return db.prepare(`SELECT id, account_id, reservation_id, order_id,
        amount_cents, snapshot_json FROM stored_value_applications WHERE order_id=?`)
        .bind(orderId).first<StoredValueApplicationRecord>();
    },

    refundableApplication(orderId: number): Promise<StoredValueApplicationRecord | null> {
      return db.prepare(`SELECT application.id, application.account_id,
        application.reservation_id, application.order_id, application.amount_cents,
        application.snapshot_json, application.amount_cents-COALESCE((
          SELECT sum(allocation.amount_cents) FROM stored_value_refund_allocations allocation
          WHERE allocation.application_id=application.id AND allocation.status<>'cancelled'
        ),0) AS refundable_cents
        FROM stored_value_applications application WHERE application.order_id=?`)
        .bind(orderId).first<StoredValueApplicationRecord>();
    },

    refundAllocationStatement(
      refundKey: string,
      amountCents: number,
      occurredAt: string,
    ): D1PreparedStatement {
      if (!Number.isSafeInteger(amountCents) || amountCents < 1) {
        throw new RangeError('Asignación de devolución de saldo inválida.');
      }
      const idempotencyKey = `${refundKey}:stored-value:allocation`;
      return db.prepare(`INSERT INTO stored_value_refund_allocations (
        id, refund_id, application_id, account_id, amount_cents, status,
        idempotency_key, version, created_at, updated_at
      ) SELECT ?, refund.id, application.id, application.account_id, ?, 'pending', ?, 1, ?, ?
        FROM refunds refund JOIN stored_value_applications application
          ON application.order_id=refund.order_id
        WHERE refund.idempotency_key=?
          AND NOT EXISTS (SELECT 1 FROM stored_value_refund_allocations WHERE idempotency_key=?)`)
        .bind(randomId('svra'), amountCents, idempotencyKey, occurredAt, occurredAt,
          refundKey, idempotencyKey);
    },

    async refundAllocations(refundId: number): Promise<readonly StoredValueRefundAllocationRecord[]> {
      const { results } = await db.prepare(`SELECT id,refund_id,application_id,account_id,
        amount_cents,status,idempotency_key,version FROM stored_value_refund_allocations
        WHERE refund_id=? ORDER BY id`).bind(refundId).all<StoredValueRefundAllocationRecord>();
      return Object.freeze(results.map((row) => Object.freeze(row)));
    },

    refundSuccessStatements(
      allocation: StoredValueRefundAllocationRecord,
      account: StoredValueAccount,
      orderId: number,
      occurredAt: string,
      guard: StoredValueGuard,
    ): readonly D1PreparedStatement[] {
      if (allocation.status !== 'pending' || allocation.account_id !== account.id) {
        throw new RangeError('Asignación de saldo no reembolsable.');
      }
      const ledgerKey = `${allocation.idempotency_key}:ledger`;
      return Object.freeze([
        db.prepare(`INSERT INTO stored_value_ledger_entries (
          id,account_id,type,balance_delta_cents,reserved_delta_cents,
          balance_after_cents,reserved_after_cents,version_after,order_id,refund_id,
          idempotency_key,metadata_json,occurred_at
        ) SELECT ?,account.id,'refund',allocation.amount_cents,0,
          account.balance_cents+allocation.amount_cents,account.reserved_cents,
          account.version+1,?,allocation.refund_id,?,'{}',?
          FROM stored_value_refund_allocations allocation
          JOIN stored_value_accounts account ON account.id=allocation.account_id
          WHERE allocation.id=? AND allocation.version=? AND allocation.status='pending'
            AND account.id=? AND account.version=?
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id=?)
            AND NOT EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE idempotency_key=?)`)
          .bind(randomId('svle'), orderId, ledgerKey, occurredAt, allocation.id,
            allocation.version, account.id, account.version, guard.eventId, ledgerKey),
        db.prepare(`UPDATE stored_value_accounts SET balance_cents=balance_cents+?,
          version=version+1,updated_at=? WHERE id=? AND version=?
            AND EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE account_id=?
              AND idempotency_key=? AND version_after=?)`)
          .bind(allocation.amount_cents, occurredAt, account.id, account.version,
            account.id, ledgerKey, account.version + 1),
        db.prepare(`UPDATE stored_value_refund_allocations SET status='succeeded',
          version=version+1,updated_at=? WHERE id=? AND version=? AND status='pending'
            AND EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE idempotency_key=?)`)
          .bind(occurredAt, allocation.id, allocation.version, ledgerKey),
      ]);
    },

    captureStatements(
      reservation: StoredValueReservationRecord,
      account: StoredValueAccount,
      occurredAt: string,
      guard: StoredValueGuard,
    ): readonly D1PreparedStatement[] {
      if (reservation.status !== 'active' || reservation.account_id !== account.id ||
          account.reserved_cents < reservation.amount_cents || account.balance_cents < reservation.amount_cents) {
        throw new RangeError('Reserva de valor almacenado no capturable.');
      }
      const ledgerKey = `${reservation.idempotency_key}:capture`;
      const applicationKey = `${reservation.idempotency_key}:application`;
      return Object.freeze([
        db.prepare(`INSERT INTO stored_value_ledger_entries (
          id, account_id, type, balance_delta_cents, reserved_delta_cents,
          balance_after_cents, reserved_after_cents, version_after,
          order_id, refund_id, idempotency_key, metadata_json, occurred_at
        ) SELECT ?, account.id, 'capture', -reservation.amount_cents, -reservation.amount_cents,
          account.balance_cents-reservation.amount_cents,
          account.reserved_cents-reservation.amount_cents, account.version+1,
          reservation.order_id, NULL, ?, '{}', ?
          FROM stored_value_reservations reservation
          JOIN stored_value_accounts account ON account.id=reservation.account_id
          WHERE reservation.id=? AND reservation.status='active' AND reservation.version=?
            AND account.id=? AND account.version=?
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id=?)
            AND NOT EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE idempotency_key=?)`)
          .bind(randomId('svle'), ledgerKey, occurredAt, reservation.id, reservation.version,
            account.id, account.version, guard.eventId, ledgerKey),
        db.prepare(`UPDATE stored_value_accounts SET balance_cents=balance_cents-?,
          reserved_cents=reserved_cents-?, version=version+1, updated_at=?
          WHERE id=? AND version=? AND EXISTS (SELECT 1 FROM stored_value_ledger_entries
            WHERE account_id=? AND idempotency_key=? AND version_after=?)`)
          .bind(reservation.amount_cents, reservation.amount_cents, occurredAt, account.id,
            account.version, account.id, ledgerKey, account.version + 1),
        db.prepare(`UPDATE stored_value_reservations SET status='captured', version=version+1,
          updated_at=?, captured_at=? WHERE id=? AND version=? AND status='active'
            AND EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE idempotency_key=?)`)
          .bind(occurredAt, occurredAt, reservation.id, reservation.version, ledgerKey),
        db.prepare(`INSERT INTO stored_value_applications (
          id, account_id, reservation_id, order_id, amount_cents,
          snapshot_json, idempotency_key, applied_at
        ) SELECT ?, account_id, id, order_id, amount_cents, snapshot_json, ?, ?
          FROM stored_value_reservations WHERE id=? AND status='captured'
            AND NOT EXISTS (SELECT 1 FROM stored_value_applications WHERE reservation_id=?)`)
          .bind(randomId('sva'), applicationKey, occurredAt, reservation.id, reservation.id),
      ]);
    },

    releaseStatements(
      reservation: StoredValueReservationRecord,
      account: StoredValueAccount,
      occurredAt: string,
      guard: StoredValueGuard,
    ): readonly D1PreparedStatement[] {
      if (reservation.status !== 'active' || reservation.account_id !== account.id ||
          account.reserved_cents < reservation.amount_cents) {
        throw new RangeError('Reserva de valor almacenado no liberable.');
      }
      const ledgerKey = `${reservation.idempotency_key}:release`;
      return Object.freeze([
        db.prepare(`INSERT INTO stored_value_ledger_entries (
          id, account_id, type, balance_delta_cents, reserved_delta_cents,
          balance_after_cents, reserved_after_cents, version_after,
          order_id, refund_id, idempotency_key, metadata_json, occurred_at
        ) SELECT ?, account.id, 'release', 0, -reservation.amount_cents,
          account.balance_cents, account.reserved_cents-reservation.amount_cents,
          account.version+1, reservation.order_id, NULL, ?, '{}', ?
          FROM stored_value_reservations reservation
          JOIN stored_value_accounts account ON account.id=reservation.account_id
          WHERE reservation.id=? AND reservation.status='active' AND reservation.version=?
            AND account.version=? AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id=?)
            AND NOT EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE idempotency_key=?)`)
          .bind(randomId('svle'), ledgerKey, occurredAt, reservation.id, reservation.version,
            account.version, guard.eventId, ledgerKey),
        db.prepare(`UPDATE stored_value_accounts SET reserved_cents=reserved_cents-?,
          version=version+1, updated_at=? WHERE id=? AND version=?
            AND EXISTS (SELECT 1 FROM stored_value_ledger_entries
              WHERE account_id=? AND idempotency_key=? AND version_after=?)`)
          .bind(reservation.amount_cents, occurredAt, account.id, account.version,
            account.id, ledgerKey, account.version + 1),
        db.prepare(`UPDATE stored_value_reservations SET status='released', version=version+1,
          updated_at=?, released_at=? WHERE id=? AND version=? AND status='active'
            AND EXISTS (SELECT 1 FROM stored_value_ledger_entries WHERE idempotency_key=?)`)
          .bind(occurredAt, occurredAt, reservation.id, reservation.version, ledgerKey),
      ]);
    },

    async list(limit = 100): Promise<readonly (StoredValueAccount & Readonly<{ available_cents: number }>)[]> {
      const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
      const { results } = await db.prepare(`SELECT id, kind, state, currency, label, balance_cents,
        reserved_cents, balance_cents-reserved_cents AS available_cents, version, expires_at
        FROM stored_value_accounts ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(safeLimit).all<StoredValueAccount & Readonly<{ available_cents: number }>>();
      return Object.freeze(results.map((row) => Object.freeze(row)));
    },

    stateStatement(account: StoredValueAccount, to: StoredValueState, occurredAt: string): D1PreparedStatement {
      if (!['active', 'disabled', 'closed'].includes(to) || account.state === 'closed' || account.state === to) {
        throw new RangeError('Transición de saldo inválida.');
      }
      return db.prepare(`UPDATE stored_value_accounts SET state=?, version=version+1, updated_at=?
        WHERE id=? AND state=? AND version=?`).bind(to, occurredAt, account.id, account.state, account.version);
    },
  });
}

export type D1StoredValue = ReturnType<typeof createD1StoredValue>;
