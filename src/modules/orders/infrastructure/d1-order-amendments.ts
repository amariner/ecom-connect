import type {
  EditableOrderLineSnapshot,
  EditableOrderSnapshot,
  OrderAmendmentStatus,
  OrderAmendmentVariant,
  PlannedOrderAmendment,
  PlannedOrderAmendmentLine,
} from '../domain/order-amendment';

export type OrderAmendmentRecord = Readonly<{
  id: string;
  order_id: number;
  order_number: string;
  status: OrderAmendmentStatus;
  expected_order_version: number;
  reason: string;
  currency: string;
  address_before_json: string;
  address_after_json: string;
  subtotal_before_cents: number;
  shipping_before_cents: number;
  total_before_cents: number;
  subtotal_after_cents: number;
  shipping_after_cents: number;
  total_after_cents: number;
  delta_cents: number;
  stripe_session_id: string | null;
  expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
  expired_at: string | null;
}>;

export type OrderAmendmentContext = Readonly<{
  order: EditableOrderSnapshot;
  lines: readonly EditableOrderLineSnapshot[];
  variants: readonly OrderAmendmentVariant[];
  hasActiveFulfillment: boolean;
  hasActiveAmendment: boolean;
}>;

type AmendmentLineRow = PlannedOrderAmendmentLine & Readonly<{ id: number }>;
type OrderAmendmentVariantRow = Omit<OrderAmendmentVariant, 'active'> & Readonly<{ active: number }>;

function assertId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} inválido.`);
}

export function createD1OrderAmendments(db: D1Database) {
  return Object.freeze({
    async context(orderId: number): Promise<OrderAmendmentContext | null> {
      assertId(orderId, 'order_id');
      const order = await db.prepare(`
        SELECT id, order_number, email, status, edit_version, address_json,
               subtotal_cents, shipping_cents, total_cents, currency
        FROM orders WHERE id = ?
      `).bind(orderId).first<EditableOrderSnapshot>();
      if (!order) return null;
      const [lineResult, variantResult, fulfillment, active] = await Promise.all([
        db.prepare(`
          SELECT oi.id AS order_item_id, oi.product_id,
                 COALESCE(oi.variant_id, default_variant.id) AS variant_id,
                 oi.name_snapshot,
                 COALESCE(oi.sku_snapshot, default_variant.sku) AS sku_snapshot,
                 oi.variant_name_snapshot,
                 oi.unit_price_cents,
                 COALESCE(oi.current_qty, oi.qty) AS current_quantity,
                 COALESCE((
                   SELECT sum(fi.quantity)
                   FROM fulfillment_items fi
                   JOIN fulfillments f ON f.id = fi.fulfillment_id
                   WHERE fi.order_item_id = oi.id AND f.status <> 'cancelled'
                 ), 0) AS fulfilled_quantity,
                 COALESCE((
                   SELECT sum(ri.quantity)
                   FROM refund_items ri
                   JOIN refunds r ON r.id = ri.refund_id
                   WHERE ri.order_item_id = oi.id
                     AND r.operation_type IN ('total_cancellation', 'partial_cancellation')
                     AND r.status = 'succeeded'
                 ), 0) AS cancelled_quantity
          FROM order_items oi
          JOIN product_variants default_variant
            ON default_variant.product_id = oi.product_id AND default_variant.is_default = 1
          WHERE oi.order_id = ?
          ORDER BY oi.id
        `).bind(orderId).all<EditableOrderLineSnapshot>(),
        db.prepare(`
          SELECT p.id AS product_id, pv.id AS variant_id, p.name,
                 pv.sku, NULLIF(pv.title, '') AS variant_name,
                 pv.price_cents AS unit_price_cents,
                 b.on_hand - b.reserved AS available_quantity,
                 CASE WHEN p.active = 1 AND pv.status = 'active' THEN 1 ELSE 0 END AS active
          FROM product_variants pv
          JOIN products p ON p.id = pv.product_id
          JOIN inventory_balances b ON b.variant_id = pv.id
          WHERE p.active = 1 AND pv.status = 'active'
          ORDER BY p.name COLLATE NOCASE, pv.is_default DESC, pv.id
          LIMIT 500
        `).all<OrderAmendmentVariantRow>(),
        db.prepare(`
          SELECT 1 AS active FROM fulfillments
          WHERE order_id = ? AND status <> 'cancelled' LIMIT 1
        `).bind(orderId).first<{ active: number }>(),
        db.prepare(`
          SELECT 1 AS active FROM order_amendments
          WHERE order_id = ?
            AND status IN ('pending_payment', 'pending_refund', 'ready', 'requires_review')
          LIMIT 1
        `).bind(orderId).first<{ active: number }>(),
      ]);
      return Object.freeze({
        order: Object.freeze(order),
        lines: Object.freeze(lineResult.results.map((line) => Object.freeze(line))),
        variants: Object.freeze(variantResult.results.map((variant) => Object.freeze({
          ...variant,
          active: variant.active === 1,
        }))),
        hasActiveFulfillment: Boolean(fulfillment),
        hasActiveAmendment: Boolean(active),
      });
    },

    findById(id: string): Promise<OrderAmendmentRecord | null> {
      return db.prepare(`
        SELECT a.*, o.order_number
        FROM order_amendments a JOIN orders o ON o.id = a.order_id
        WHERE a.id = ?
      `).bind(id).first<OrderAmendmentRecord>();
    },

    findByStripeSession(sessionId: string): Promise<OrderAmendmentRecord | null> {
      return db.prepare(`
        SELECT a.*, o.order_number
        FROM order_amendments a JOIN orders o ON o.id = a.order_id
        WHERE a.stripe_session_id = ?
      `).bind(sessionId).first<OrderAmendmentRecord>();
    },

    async listForOrder(orderId: number): Promise<readonly OrderAmendmentRecord[]> {
      assertId(orderId, 'order_id');
      const { results } = await db.prepare(`
        SELECT a.*, o.order_number
        FROM order_amendments a JOIN orders o ON o.id = a.order_id
        WHERE a.order_id = ? ORDER BY a.created_at DESC, a.id DESC
      `).bind(orderId).all<OrderAmendmentRecord>();
      return Object.freeze(results.map((amendment) => Object.freeze(amendment)));
    },

    async lines(amendmentId: string): Promise<readonly AmendmentLineRow[]> {
      const { results } = await db.prepare(`
        SELECT id, order_item_id, product_id, variant_id, name_snapshot,
               sku_snapshot, variant_name_snapshot, unit_price_cents,
               quantity_before, quantity_after, quantity_delta,
               amount_delta_cents
        FROM order_amendment_lines WHERE amendment_id = ? ORDER BY id
      `).bind(amendmentId).all<AmendmentLineRow>();
      return Object.freeze(results.map((line) => Object.freeze(line)));
    },

    intentStatements(input: Readonly<{
      id: string;
      plan: PlannedOrderAmendment;
      reason: string;
      createdAt: string;
      stripeSessionId?: string | null;
      expiresAt?: string | null;
    }>): readonly D1PreparedStatement[] {
      const reason = input.reason.trim();
      if (reason.length < 1 || reason.length > 240) throw new RangeError('motivo de edición inválido.');
      const plan = input.plan;
      const header = db.prepare(`
        INSERT INTO order_amendments (
          id, order_id, status, expected_order_version, reason, currency,
          address_before_json, address_after_json,
          subtotal_before_cents, shipping_before_cents, total_before_cents,
          subtotal_after_cents, shipping_after_cents, total_after_cents,
          delta_cents, stripe_session_id, expires_at, version,
          created_at, updated_at
        )
        SELECT ?, o.id, ?, o.edit_version, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
        FROM orders o
        WHERE o.id = ? AND o.status = 'paid' AND o.edit_version = ?
          AND NOT EXISTS (
            SELECT 1 FROM order_amendments active
            WHERE active.order_id = o.id
              AND active.status IN ('pending_payment', 'pending_refund', 'ready', 'requires_review')
          )
      `).bind(
        input.id, plan.status, reason, plan.currency,
        plan.address_before_json, plan.address_after_json,
        plan.subtotal_before_cents, plan.shipping_before_cents, plan.total_before_cents,
        plan.subtotal_after_cents, plan.shipping_after_cents, plan.total_after_cents,
        plan.delta_cents, input.stripeSessionId ?? null, input.expiresAt ?? null,
        input.createdAt, input.createdAt,
        plan.order_id, plan.expected_order_version,
      );
      const lines = plan.lines.map((line) => db.prepare(`
        INSERT INTO order_amendment_lines (
          amendment_id, order_id, order_item_id, product_id, variant_id,
          name_snapshot, sku_snapshot, variant_name_snapshot,
          unit_price_cents, quantity_before, quantity_after,
          quantity_delta, amount_delta_cents, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM order_amendments WHERE id = ? AND order_id = ?)
      `).bind(
        input.id, plan.order_id, line.order_item_id, line.product_id, line.variant_id,
        line.name_snapshot, line.sku_snapshot, line.variant_name_snapshot,
        line.unit_price_cents, line.quantity_before, line.quantity_after,
        line.quantity_delta, line.amount_delta_cents, input.createdAt,
        input.id, plan.order_id,
      ));
      return Object.freeze([header, ...lines]);
    },

    applyStatements(input: Readonly<{
      amendment: OrderAmendmentRecord;
      eventId: string;
      occurredAt: string;
    }>): readonly D1PreparedStatement[] {
      const { amendment } = input;
      return Object.freeze([
        db.prepare(`
          UPDATE order_items
          SET current_qty = (
            SELECT l.quantity_after FROM order_amendment_lines l
            WHERE l.amendment_id = ? AND l.order_item_id = order_items.id
          )
          WHERE order_id = ?
            AND id IN (
              SELECT order_item_id FROM order_amendment_lines
              WHERE amendment_id = ? AND order_item_id IS NOT NULL
            )
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(amendment.id, amendment.order_id, amendment.id, input.eventId),
        db.prepare(`
          INSERT INTO order_items (
            order_id, product_id, variant_id, name_snapshot, sku_snapshot,
            product_name_snapshot, variant_name_snapshot,
            unit_price_cents, qty, current_qty
          )
          SELECT l.order_id, l.product_id, l.variant_id, l.name_snapshot,
                 l.sku_snapshot, l.name_snapshot, l.variant_name_snapshot,
                 l.unit_price_cents, l.quantity_after, l.quantity_after
          FROM order_amendment_lines l
          WHERE l.amendment_id = ? AND l.order_item_id IS NULL
            AND l.quantity_after > 0
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(amendment.id, input.eventId),
        db.prepare(`
          UPDATE order_amendment_lines
          SET order_item_id = (
            SELECT oi.id FROM order_items oi
            WHERE oi.order_id = order_amendment_lines.order_id
              AND oi.variant_id = order_amendment_lines.variant_id
          )
          WHERE amendment_id = ? AND order_item_id IS NULL
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(amendment.id, input.eventId),
        db.prepare(`
          UPDATE orders
          SET address_json = ?, subtotal_cents = ?, shipping_cents = ?, total_cents = ?,
              edit_version = edit_version + 1, updated_at = ?
          WHERE id = ? AND status = 'paid' AND edit_version = ?
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        `).bind(
          amendment.address_after_json,
          amendment.subtotal_after_cents,
          amendment.shipping_after_cents,
          amendment.total_after_cents,
          input.occurredAt,
          amendment.order_id,
          amendment.expected_order_version,
          input.eventId,
        ),
        db.prepare(`
          UPDATE order_amendments
          SET status = 'applied', applied_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND order_id = ? AND version = ?
            AND status IN ('pending_payment', 'pending_refund', 'ready', 'requires_review')
            AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
            AND EXISTS (
              SELECT 1 FROM orders
              WHERE id = order_amendments.order_id
                AND edit_version = order_amendments.expected_order_version + 1
            )
        `).bind(
          input.occurredAt, input.occurredAt,
          amendment.id, amendment.order_id, amendment.version, input.eventId,
        ),
      ]);
    },

    expireStatement(amendment: OrderAmendmentRecord, eventId: string, occurredAt: string): D1PreparedStatement {
      return db.prepare(`
        UPDATE order_amendments
        SET status = 'expired', expired_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'pending_payment' AND version = ?
          AND expires_at <= ?
          AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
      `).bind(occurredAt, occurredAt, amendment.id, amendment.version, occurredAt, eventId);
    },

    reviewStatement(amendment: OrderAmendmentRecord, occurredAt: string): D1PreparedStatement {
      return db.prepare(`
        UPDATE order_amendments
        SET status = 'requires_review', updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND status IN ('pending_refund', 'requires_review')
      `).bind(occurredAt, amendment.id, amendment.version);
    },
  });
}

export type D1OrderAmendments = ReturnType<typeof createD1OrderAmendments>;
