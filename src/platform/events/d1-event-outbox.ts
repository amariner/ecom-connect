/** Persistencia D1 del sobre y de sus entregas (R1.7). */

import type { EventEnvelope, EventIdentity } from '../../shared-kernel/events';

export type EventOrderGuard = Readonly<{
  orderId: number;
  expectedStatus: string;
  requireNoActiveRefund?: boolean;
  requireNoActiveHold?: boolean;
  forbidActiveHoldReason?: string;
  ignoreExistingIdempotencyKey?: boolean;
  payment?: Readonly<{ id: number; status: string; version: number }>;
  refund?: Readonly<{ id: number; status: string; version: number }>;
}>;

export type EventAmendmentGuard = Readonly<{
  orderId: number;
  expectedOrderVersion: number;
  amendmentId: string;
  amendmentStatus: string | readonly string[];
  amendmentVersion: number;
}>;

export type EventHoldGuard = Readonly<{
  orderId: number;
  holdId: string;
  holdStatus: 'active';
  holdVersion: number;
}>;

export type EventReturnGuard = Readonly<{
  returnId: string;
  expectedStatus: string;
  expectedVersion: number;
  orderId: number;
  expectedOrderStatus: string;
  payment?: Readonly<{ id: number; status: string; version: number }>;
  refund?: Readonly<{ id: number; status: string; version: number }>;
}>;

function eventValues(event: EventEnvelope): readonly unknown[] {
  return [
    event.event_id,
    event.type,
    event.version,
    event.occurred_at,
    event.actor.kind,
    event.actor.id,
    event.actor.label ?? null,
    event.entity.type,
    event.entity.id,
    event.entity.reference ?? null,
    event.correlation_id,
    event.causation_id,
    event.idempotency_key,
    JSON.stringify(event.payload),
    event.occurred_at,
  ];
}

export function createD1EventOutboxWriter(db: D1Database) {
  return {
    /** El evento solo nace si el pedido sigue en el estado que leyó el caso de uso. */
    guardedEventStatement(event: EventEnvelope, guard: EventOrderGuard): D1PreparedStatement {
      const refundGuard = guard.requireNoActiveRefund
        ? `AND NOT EXISTS (
            SELECT 1 FROM refunds
            WHERE order_id = ? AND status IN ('pending', 'processing', 'failed', 'requires_review')
          )`
        : '';
      const refundBindings = guard.requireNoActiveRefund ? [guard.orderId] : [];
      const holdGuard = guard.requireNoActiveHold
        ? `AND NOT EXISTS (
            SELECT 1 FROM order_holds
            WHERE order_id = ? AND status = 'active'
          )`
        : '';
      const holdBindings = guard.requireNoActiveHold ? [guard.orderId] : [];
      const holdReasonGuard = guard.forbidActiveHoldReason
        ? `AND NOT EXISTS (
            SELECT 1 FROM order_holds
            WHERE order_id = ? AND status = 'active' AND reason_code = ?
          )`
        : '';
      const holdReasonBindings = guard.forbidActiveHoldReason
        ? [guard.orderId, guard.forbidActiveHoldReason]
        : [];
      const idempotencyGuard = guard.ignoreExistingIdempotencyKey
        ? 'AND NOT EXISTS (SELECT 1 FROM event_outbox_events WHERE idempotency_key = ?)'
        : '';
      const idempotencyBindings = guard.ignoreExistingIdempotencyKey ? [event.idempotency_key] : [];
      const paymentGuard = guard.payment
        ? `AND EXISTS (
            SELECT 1 FROM payments
            WHERE id = ? AND status = ? AND version = ?
          )`
        : '';
      const paymentBindings = guard.payment
        ? [guard.payment.id, guard.payment.status, guard.payment.version]
        : [];
      const refundGuardSql = guard.refund
        ? `AND EXISTS (
            SELECT 1 FROM refunds
            WHERE id = ? AND status = ? AND version = ?
          )`
        : '';
      const refundGuardBindings = guard.refund
        ? [guard.refund.id, guard.refund.status, guard.refund.version]
        : [];
      return db.prepare(`
        INSERT INTO event_outbox_events (
          event_id, event_type, event_version, occurred_at,
          actor_kind, actor_id, actor_label,
          entity_type, entity_id, entity_reference,
          correlation_id, causation_id, idempotency_key, payload_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM orders WHERE id = ? AND status = ? ${refundGuard} ${holdGuard} ${holdReasonGuard}
        )
        ${paymentGuard}
        ${refundGuardSql}
        ${idempotencyGuard}
      `).bind(
        ...eventValues(event),
        guard.orderId,
        guard.expectedStatus,
        ...refundBindings,
        ...holdBindings,
        ...holdReasonBindings,
        ...paymentBindings,
        ...refundGuardBindings,
        ...idempotencyBindings,
      );
    },

    /** Guarda una mutación de hold solo para la versión activa observada. */
    guardedHoldEventStatement(event: EventEnvelope, guard: EventHoldGuard): D1PreparedStatement {
      return db.prepare(`
        INSERT INTO event_outbox_events (
          event_id, event_type, event_version, occurred_at,
          actor_kind, actor_id, actor_label,
          entity_type, entity_id, entity_reference,
          correlation_id, causation_id, idempotency_key, payload_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM order_holds
          WHERE id = ? AND order_id = ? AND status = ? AND version = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_outbox_events WHERE idempotency_key = ?
        )
      `).bind(
        ...eventValues(event),
        guard.holdId,
        guard.orderId,
        guard.holdStatus,
        guard.holdVersion,
        event.idempotency_key,
      );
    },

    guardedReturnEventStatement(event: EventEnvelope, guard: EventReturnGuard): D1PreparedStatement {
      const paymentGuard = guard.payment
        ? 'AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND status = ? AND version = ?)'
        : '';
      const paymentBindings = guard.payment
        ? [guard.payment.id, guard.payment.status, guard.payment.version]
        : [];
      const refundGuard = guard.refund
        ? 'AND EXISTS (SELECT 1 FROM refunds WHERE id = ? AND status = ? AND version = ?)'
        : '';
      const refundBindings = guard.refund
        ? [guard.refund.id, guard.refund.status, guard.refund.version]
        : [];
      return db.prepare(`
        INSERT INTO event_outbox_events (
          event_id, event_type, event_version, occurred_at,
          actor_kind, actor_id, actor_label,
          entity_type, entity_id, entity_reference,
          correlation_id, causation_id, idempotency_key, payload_json, created_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM return_requests r JOIN orders o ON o.id = r.order_id
          WHERE r.id = ? AND r.status = ? AND r.version = ?
            AND r.order_id = ? AND o.status = ?
        )
        ${paymentGuard} ${refundGuard}
        AND NOT EXISTS (SELECT 1 FROM event_outbox_events WHERE idempotency_key = ?)
      `).bind(
        ...eventValues(event), guard.returnId, guard.expectedStatus,
        guard.expectedVersion, guard.orderId, guard.expectedOrderStatus,
        ...paymentBindings, ...refundBindings, event.idempotency_key,
      );
    },

    /** Guarda una edición por versión de pedido y estado/version de intención. */
    guardedAmendmentEventStatement(
      event: EventEnvelope,
      guard: EventAmendmentGuard,
    ): D1PreparedStatement {
      const statuses = Array.isArray(guard.amendmentStatus)
        ? guard.amendmentStatus
        : [guard.amendmentStatus];
      if (statuses.length === 0) throw new RangeError('amendmentStatus no puede estar vacío.');
      return db.prepare(`
        INSERT INTO event_outbox_events (
          event_id, event_type, event_version, occurred_at,
          actor_kind, actor_id, actor_label,
          entity_type, entity_id, entity_reference,
          correlation_id, causation_id, idempotency_key, payload_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1
          FROM order_amendments a
          JOIN orders o ON o.id = a.order_id
          WHERE a.id = ? AND a.order_id = ?
            AND a.status IN (${statuses.map(() => '?').join(',')})
            AND a.version = ?
            AND o.status = 'paid' AND o.edit_version = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_outbox_events WHERE idempotency_key = ?
        )
      `).bind(
        ...eventValues(event),
        guard.amendmentId,
        guard.orderId,
        ...statuses,
        guard.amendmentVersion,
        guard.expectedOrderVersion,
        event.idempotency_key,
      );
    },

    /**
     * El alta conoce `order_number` antes del lote, pero D1 asigna `order_id`.
     * La segunda sentencia de la batch materializa ambos campos desde la fila
     * recién insertada; después el caso de uso reconstruye el mismo sobre.
     */
    placedEventStatement(identity: EventIdentity, orderNumber: string): D1PreparedStatement {
      const correlationId = `order:${orderNumber}`;
      return db.prepare(`
        INSERT INTO event_outbox_events (
          event_id, event_type, event_version, occurred_at,
          actor_kind, actor_id, actor_label,
          entity_type, entity_id, entity_reference,
          correlation_id, causation_id, idempotency_key, payload_json, created_at
        )
        SELECT ?, 'orders.order_placed', 1, ?,
          'customer', 'guest-checkout', 'Comprador invitado',
          'order', CAST(id AS TEXT), order_number,
          ?, NULL, ?,
          json_object(
            'order_id', id,
            'order_number', order_number,
            'from_status', NULL,
            'to_status', 'pending'
          ), ?
        FROM orders
        WHERE order_number = ?
      `).bind(
        identity.event_id,
        identity.occurred_at,
        correlationId,
        `${correlationId}:order_placed`,
        identity.occurred_at,
        orderNumber,
      );
    },

    deliveryStatements(
      eventId: string,
      availableAt: string,
      consumerIds: readonly string[],
    ): D1PreparedStatement[] {
      return consumerIds.map((consumerId) => db.prepare(`
        INSERT INTO event_outbox_deliveries (
          event_id, consumer_id, available_at, created_at, updated_at
        )
        SELECT event_id, ?, ?, ?, ?
        FROM event_outbox_events
        WHERE event_id = ?
      `).bind(consumerId, availableAt, availableAt, availableAt, eventId));
    },
  };
}

export type D1EventOutboxWriter = ReturnType<typeof createD1EventOutboxWriter>;
