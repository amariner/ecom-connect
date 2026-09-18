/**
 * Adaptador D1 de escritura de pedidos (R1.5–R1.7).
 *
 * Todas las escrituras devuelven sentencias al composition root. Desde R1.7 el
 * evento se inserta condicionado al estado leído y estas mutaciones exigen ese
 * `event_id`: pedido, stock, timeline y entregas se confirman en UNA batch.
 *
 * Desde R2.7 el inventario lo compone `order-operations`; este adaptador solo
 * persiste pedido, líneas y timeline.
 */

import type { OrderTimelineEntry } from '../domain/order-events';
import type { OrderForPayment, OrderItemForPayment } from '../domain/payment-transition';

export type NewOrderInput = Readonly<{
  order_number: string;
  email: string;
  customer_name: string;
  address_json: string;
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  stripe_session_id: string;
  currency: string;
  /** FK interna opcional; email/dirección del pedido siguen siendo snapshots. */
  customer_profile_id?: string | null;
  /** Metadatos de entrada omnicanal; no modifican la lógica de pago. */
  channel?: string;
  request_hash?: string;
}>;

export type NewOrderLine = Readonly<{
  product_id: number;
  name_snapshot: string;
  unit_price_cents: number;
  base_unit_price_cents?: number;
  pricing_snapshot_json?: string;
  qty: number;
}>;

export type OrderForTransition = Readonly<{
  id: number;
  order_number: string;
  email: string;
  customer_name: string;
  status: string;
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
}>;

const ORDER_ITEMS_COLUMNS = `
  oi.id AS order_item_id,
  oi.product_id,
  COALESCE(item_variant.id, default_variant.id) AS variant_id,
  COALESCE(item_variant.id, default_variant.id) = default_variant.id AS is_default,
  oi.name_snapshot, oi.unit_price_cents, COALESCE(oi.current_qty, oi.qty) AS qty`;

export function createD1OrderWriter(db: D1Database) {
  return {
    insertPendingOrderStatement(order: NewOrderInput): D1PreparedStatement {
      return db
        .prepare(
          `INSERT INTO orders (order_number, email, customer_name, address_json, subtotal_cents, shipping_cents, total_cents, status, stripe_session_id, currency, customer_profile_id, channel, request_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .bind(
          order.order_number,
          order.email,
          order.customer_name,
          order.address_json,
          order.subtotal_cents,
          order.shipping_cents,
          order.total_cents,
          order.stripe_session_id,
          order.currency,
          order.customer_profile_id ?? null,
          order.channel ?? 'WEB',
          order.request_hash ?? null,
        );
    },

    lineStatementsForOrderNumber(orderNumber: string, lines: readonly NewOrderLine[]): D1PreparedStatement[] {
      return lines.map((line) => db.prepare(`
        INSERT INTO order_items (
          order_id, product_id, variant_id, name_snapshot, sku_snapshot,
          product_name_snapshot, variant_name_snapshot, unit_price_cents,
          base_unit_price_cents, pricing_snapshot_json, qty
        )
        VALUES (
          (SELECT o.id FROM orders o
           JOIN product_variants required_variant
             ON required_variant.product_id = ? AND required_variant.is_default = 1
           WHERE o.order_number = ?),
          ?,
          (SELECT id FROM product_variants WHERE product_id = ? AND is_default = 1),
          ?,
          (SELECT sku FROM product_variants WHERE product_id = ? AND is_default = 1),
          ?,
          (SELECT NULLIF(title, '') FROM product_variants WHERE product_id = ? AND is_default = 1),
          ?, ?, ?, ?
        )
      `).bind(
        line.product_id || null,
        orderNumber,
        line.product_id || null,
        line.product_id || null,
        line.name_snapshot,
        line.product_id || null,
        line.name_snapshot,
        line.product_id || null,
        line.unit_price_cents,
        line.base_unit_price_cents ?? line.unit_price_cents,
        line.pricing_snapshot_json ?? JSON.stringify({
          schema: 1,
          source: 'order-writer-fallback',
          base_unit_price_cents: line.unit_price_cents,
          unit_price_cents: line.unit_price_cents,
          quantity: line.qty,
          base_subtotal_cents: line.unit_price_cents * line.qty,
          discount_cents: 0,
          subtotal_cents: line.unit_price_cents * line.qty,
          applied_rule: null,
          evaluations: [],
        }),
        line.qty,
      ));
    },

    findOrderForPaymentBySession(stripeSessionId: string): Promise<OrderForPayment | null> {
      return db
        .prepare(
          'SELECT id, order_number, status, email, customer_name, subtotal_cents, shipping_cents, total_cents, currency FROM orders WHERE stripe_session_id = ?',
        )
        .bind(stripeSessionId)
        .first<OrderForPayment>();
    },

    findOrderForPaymentById(orderId: number): Promise<OrderForPayment | null> {
      return db
        .prepare(
          'SELECT id, order_number, status, email, customer_name, subtotal_cents, shipping_cents, total_cents, currency FROM orders WHERE id = ?',
        )
        .bind(orderId)
        .first<OrderForPayment>();
    },

    findOrderForTransition(orderId: number): Promise<OrderForTransition | null> {
      return db
        .prepare(
          'SELECT id, order_number, email, customer_name, status, subtotal_cents, shipping_cents, total_cents FROM orders WHERE id = ?',
        )
        .bind(orderId)
        .first<OrderForTransition>();
    },

    async items(orderId: number): Promise<OrderItemForPayment[]> {
      const { results } = await db
        .prepare(`
          SELECT ${ORDER_ITEMS_COLUMNS}
          FROM order_items oi
          JOIN product_variants default_variant
            ON default_variant.product_id = oi.product_id AND default_variant.is_default = 1
          LEFT JOIN product_variants item_variant ON item_variant.id = oi.variant_id
          WHERE oi.order_id = ?
        `)
        .bind(orderId)
        .all<OrderItemForPayment>();
      return results;
    },

    guardedPaidStatement(orderId: number, paymentIntent: string | null, eventId: string): D1PreparedStatement {
      return db.prepare(`
        UPDATE orders
        SET status = 'paid', stripe_payment_intent = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
          AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
      `).bind(paymentIntent, orderId, eventId);
    },

    guardedExpiredStatement(orderId: number, eventId: string): D1PreparedStatement {
      return db.prepare(`
        UPDATE orders SET status = 'cancelled', updated_at = datetime('now')
        WHERE id = ? AND status = 'pending'
          AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
      `).bind(orderId, eventId);
    },

    guardedTransitionStatement(input: {
      orderId: number;
      from: string;
      to: string;
      tracking: { carrier: string; number: string } | null;
      eventId: string;
      requireNoActiveRefund?: boolean;
    }): D1PreparedStatement {
      const refundGuard = input.requireNoActiveRefund
        ? `AND NOT EXISTS (
            SELECT 1 FROM refunds
            WHERE order_id = ? AND status IN ('pending', 'processing', 'failed', 'requires_review')
          )`
        : '';
      const refundBindings = input.requireNoActiveRefund ? [input.orderId] : [];
      return input.tracking
        ? db.prepare(`
            UPDATE orders
            SET status = ?, tracking_carrier = ?, tracking_number = ?, updated_at = datetime('now')
            WHERE id = ? AND status = ?
              ${refundGuard}
              AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
          `).bind(
            input.to,
            input.tracking.carrier,
            input.tracking.number,
            input.orderId,
            input.from,
            ...refundBindings,
            input.eventId,
          )
        : db.prepare(`
            UPDATE orders SET status = ?, updated_at = datetime('now')
            WHERE id = ? AND status = ?
              ${refundGuard}
              AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
          `).bind(input.to, input.orderId, input.from, ...refundBindings, input.eventId);
    },

    timelineStatementForOrderNumber(orderNumber: string, entry: OrderTimelineEntry): D1PreparedStatement {
      return db.prepare(`
        INSERT INTO order_events (order_id, from_status, to_status, note)
        SELECT id, ?, ?, ? FROM orders WHERE order_number = ?
      `).bind(entry.from_status, entry.to_status, entry.note, orderNumber);
    },

    guardedTimelineStatement(orderId: number, entry: OrderTimelineEntry, eventId: string): D1PreparedStatement {
      return db.prepare(`
        INSERT INTO order_events (order_id, from_status, to_status, note)
        SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
      `).bind(orderId, entry.from_status, entry.to_status, entry.note, eventId);
    },

    guardedProjectedTimelineStatement(
      orderId: number,
      entry: OrderTimelineEntry,
      eventId: string,
    ): D1PreparedStatement {
      return db.prepare(`
        INSERT INTO order_events (order_id, from_status, to_status, note)
        SELECT ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
          AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = ?)
          AND NOT EXISTS (
            SELECT 1 FROM order_events WHERE order_id = ? AND to_status = ?
          )
      `).bind(
        orderId,
        entry.from_status,
        entry.to_status,
        entry.note,
        eventId,
        orderId,
        entry.to_status,
        orderId,
        entry.to_status,
      );
    },

    /** Unidad de trabajo: el primer resultado decide quién ganó la carrera. */
    async commitResults(statements: readonly D1PreparedStatement[]): Promise<D1Result[]> {
      if (statements.length === 0) return [];
      return db.batch([...statements]);
    },
  };
}

export type D1OrderWriter = ReturnType<typeof createD1OrderWriter>;
