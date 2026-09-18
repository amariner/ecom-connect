import type {
  OrderHoldOwner,
  OrderHoldSnapshot,
  PlannedOrderHold,
  PlannedOrderHoldAssignment,
  PlannedOrderHoldResolution,
} from '../domain/order-hold';

export type OrderHoldRecord = Readonly<{
  id: string;
  order_id: number;
  status: 'active' | 'resolved';
  source: 'manual' | 'automatic';
  reason_code: OrderHoldSnapshot['reason_code'];
  owner_kind: OrderHoldOwner['kind'];
  owner_id: string;
  owner_label: string;
  due_at: string;
  idempotency_key: string;
  version: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution_code: OrderHoldSnapshot['resolution_code'];
}>;

export function orderHoldSnapshot(record: OrderHoldRecord): OrderHoldSnapshot {
  return Object.freeze({
    id: record.id,
    order_id: record.order_id,
    status: record.status,
    source: record.source,
    reason_code: record.reason_code,
    owner: Object.freeze({
      kind: record.owner_kind,
      id: record.owner_id,
      label: record.owner_label,
    }),
    due_at: record.due_at,
    version: record.version,
    created_at: record.created_at,
    resolved_at: record.resolved_at,
    resolution_code: record.resolution_code,
  });
}

const ADMIN_ACTOR = Object.freeze({
  kind: 'admin', id: 'admin-panel', label: 'Panel de administración',
} as const);
const SYSTEM_ACTOR = Object.freeze({
  kind: 'system', id: 'order-hold-policy', label: 'Política de incidencias',
} as const);

export function createD1OrderHolds(db: D1Database) {
  return Object.freeze({
    findById(id: string): Promise<OrderHoldRecord | null> {
      return db.prepare('SELECT * FROM order_holds WHERE id = ?').bind(id).first<OrderHoldRecord>();
    },

    findByIdempotencyKey(key: string): Promise<OrderHoldRecord | null> {
      return db.prepare('SELECT * FROM order_holds WHERE idempotency_key = ?')
        .bind(key.trim()).first<OrderHoldRecord>();
    },

    async listForOrder(orderId: number): Promise<readonly OrderHoldRecord[]> {
      return (await db.prepare(`SELECT * FROM order_holds WHERE order_id = ?
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, due_at, created_at, id`)
        .bind(orderId).all<OrderHoldRecord>()).results;
    },

    createStatements(input: Readonly<{
      id: string;
      orderId: number;
      plan: PlannedOrderHold;
      eventId: string;
    }>): readonly D1PreparedStatement[] {
      const actor = input.plan.source === 'automatic' ? SYSTEM_ACTOR : ADMIN_ACTOR;
      const hold = db.prepare(`INSERT INTO order_holds (
        id, order_id, status, source, reason_code, owner_kind, owner_id,
        owner_label, due_at, idempotency_key, version, created_at, updated_at
      ) SELECT ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
      WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)`)
        .bind(
          input.id, input.orderId, input.plan.source, input.plan.reason_code,
          input.plan.owner.kind, input.plan.owner.id, input.plan.owner.label,
          input.plan.due_at, input.plan.idempotency_key, input.plan.created_at,
          input.plan.created_at, input.eventId,
        );
      const history = db.prepare(`INSERT INTO order_hold_events (
        id, hold_id, order_id, event_type, hold_version, source, reason_code,
        owner_kind, owner_id, owner_label, actor_kind, actor_id, actor_label, created_at
      ) SELECT ?, ?, ?, 'created', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        AND EXISTS (SELECT 1 FROM order_holds WHERE id = ? AND order_id = ? AND version = 1)`)
        .bind(
          input.eventId, input.id, input.orderId, input.plan.source,
          input.plan.reason_code, input.plan.owner.kind, input.plan.owner.id,
          input.plan.owner.label, actor.kind, actor.id, actor.label,
          input.plan.created_at, input.eventId, input.id, input.orderId,
        );
      return Object.freeze([hold, history]);
    },

    assignmentStatements(input: Readonly<{
      hold: OrderHoldRecord;
      plan: PlannedOrderHoldAssignment;
      eventId: string;
    }>): readonly D1PreparedStatement[] {
      const update = db.prepare(`UPDATE order_holds SET
        owner_kind = ?, owner_id = ?, owner_label = ?, version = ?, updated_at = ?
        WHERE id = ? AND order_id = ? AND status = 'active' AND version = ?
          AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)`)
        .bind(
          input.plan.owner.kind, input.plan.owner.id, input.plan.owner.label,
          input.plan.version, input.plan.assigned_at, input.hold.id,
          input.hold.order_id, input.hold.version, input.eventId,
        );
      const history = db.prepare(`INSERT INTO order_hold_events (
        id, hold_id, order_id, event_type, hold_version,
        owner_kind, owner_id, owner_label, actor_kind, actor_id, actor_label, created_at
      ) SELECT ?, ?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        AND EXISTS (SELECT 1 FROM order_holds WHERE id = ? AND order_id = ? AND version = ?)`)
        .bind(
          input.eventId, input.hold.id, input.hold.order_id, input.plan.version,
          input.plan.owner.kind, input.plan.owner.id, input.plan.owner.label,
          ADMIN_ACTOR.kind, ADMIN_ACTOR.id, ADMIN_ACTOR.label,
          input.plan.assigned_at, input.eventId, input.hold.id,
          input.hold.order_id, input.plan.version,
        );
      return Object.freeze([update, history]);
    },

    resolutionStatements(input: Readonly<{
      hold: OrderHoldRecord;
      plan: PlannedOrderHoldResolution;
      eventId: string;
    }>): readonly D1PreparedStatement[] {
      const update = db.prepare(`UPDATE order_holds SET status = 'resolved',
        resolution_code = ?, resolved_at = ?, version = ?, updated_at = ?
        WHERE id = ? AND order_id = ? AND status = 'active' AND version = ?
          AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)`)
        .bind(
          input.plan.resolution_code, input.plan.resolved_at, input.plan.version,
          input.plan.resolved_at, input.hold.id, input.hold.order_id,
          input.hold.version, input.eventId,
        );
      const history = db.prepare(`INSERT INTO order_hold_events (
        id, hold_id, order_id, event_type, hold_version, resolution_code,
        actor_kind, actor_id, actor_label, created_at
      ) SELECT ?, ?, ?, 'resolved', ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
        AND EXISTS (SELECT 1 FROM order_holds WHERE id = ? AND order_id = ?
          AND status = 'resolved' AND version = ?)`)
        .bind(
          input.eventId, input.hold.id, input.hold.order_id, input.plan.version,
          input.plan.resolution_code, ADMIN_ACTOR.kind, ADMIN_ACTOR.id,
          ADMIN_ACTOR.label, input.plan.resolved_at, input.eventId,
          input.hold.id, input.hold.order_id, input.plan.version,
        );
      return Object.freeze([update, history]);
    },
  });
}

export type D1OrderHolds = ReturnType<typeof createD1OrderHolds>;
