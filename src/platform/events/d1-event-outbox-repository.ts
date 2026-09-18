import {
  CLAIM_OUTBOX_DELIVERIES_SQL,
  OUTBOX_POLICY,
  decideOutboxFailure,
} from './outbox-contract';
import { isEventEnvelope, type EventEnvelope } from '../../shared-kernel/events';

export type ClaimedOutboxDelivery = Readonly<{
  deliveryId: number;
  consumerId: string;
  attemptCount: number;
  event: EventEnvelope;
}>;

type ClaimedRow = Readonly<{
  delivery_id: number;
  consumer_id: string;
  attempt_count: number;
  event_id: string;
  event_type: string;
  event_version: number;
  occurred_at: string;
  actor_kind: string;
  actor_id: string;
  actor_label: string | null;
  entity_type: string;
  entity_id: string;
  entity_reference: string | null;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string;
  payload_json: string;
}>;

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function hydrate(row: ClaimedRow): ClaimedOutboxDelivery {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    throw new Error('invalid-event-payload');
  }
  const event: EventEnvelope = {
    event_id: row.event_id,
    type: row.event_type,
    version: row.event_version,
    occurred_at: row.occurred_at,
    actor: {
      kind: row.actor_kind as EventEnvelope['actor']['kind'],
      id: row.actor_id,
      ...(row.actor_label ? { label: row.actor_label } : {}),
    },
    entity: {
      type: row.entity_type,
      id: row.entity_id,
      ...(row.entity_reference ? { reference: row.entity_reference } : {}),
    },
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    idempotency_key: row.idempotency_key,
    payload,
  };
  if (!isEventEnvelope(event)) throw new Error('invalid-event-envelope');
  return Object.freeze({
    deliveryId: row.delivery_id,
    consumerId: row.consumer_id,
    attemptCount: row.attempt_count,
    event: Object.freeze(event),
  });
}

export function createD1EventOutboxRepository(db: D1Database) {
  return {
    async claim(now: string, workerId: string): Promise<readonly ClaimedOutboxDelivery[]> {
      const leaseEnd = addSeconds(now, OUTBOX_POLICY.leaseSeconds);
      await db.batch([
        db.prepare(`
          UPDATE event_outbox_deliveries
          SET status = 'pending', available_at = ?,
              claimed_at = NULL, claim_expires_at = NULL, claimed_by = NULL,
              updated_at = ?
          WHERE status = 'processing' AND claim_expires_at <= ? AND attempt_count < ?
        `).bind(now, now, now, OUTBOX_POLICY.maxAttempts),
        db.prepare(`
          UPDATE event_outbox_deliveries
          SET status = 'dead', dead_at = ?,
              claimed_at = NULL, claim_expires_at = NULL, claimed_by = NULL,
              last_error_code = 'lease-expired',
              last_error_message = 'El consumidor agotó su lease en el último intento.',
              updated_at = ?
          WHERE status = 'processing' AND claim_expires_at <= ? AND attempt_count >= ?
        `).bind(now, now, now, OUTBOX_POLICY.maxAttempts),
        db.prepare(CLAIM_OUTBOX_DELIVERIES_SQL).bind(
          now,
          leaseEnd,
          workerId,
          OUTBOX_POLICY.maxAttempts,
          OUTBOX_POLICY.claimBatchSize,
        ),
      ]);

      const { results } = await db.prepare(`
        SELECT
          d.id AS delivery_id, d.consumer_id, d.attempt_count,
          e.event_id, e.event_type, e.event_version, e.occurred_at,
          e.actor_kind, e.actor_id, e.actor_label,
          e.entity_type, e.entity_id, e.entity_reference,
          e.correlation_id, e.causation_id, e.idempotency_key, e.payload_json
        FROM event_outbox_deliveries d
        JOIN event_outbox_events e ON e.event_id = d.event_id
        WHERE d.status = 'processing' AND d.claimed_by = ? AND d.claimed_at = ?
        ORDER BY d.id
        LIMIT ?
      `).bind(workerId, now, OUTBOX_POLICY.claimBatchSize).all<ClaimedRow>();
      return Object.freeze(results.map(hydrate));
    },

    deliveredStatement(deliveryId: number, workerId: string, now: string): D1PreparedStatement {
      return db.prepare(`
        UPDATE event_outbox_deliveries
        SET status = 'delivered', delivered_at = ?,
            claimed_at = NULL, claim_expires_at = NULL, claimed_by = NULL,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing' AND claimed_by = ?
      `).bind(now, now, deliveryId, workerId);
    },

    async fail(
      delivery: ClaimedOutboxDelivery,
      workerId: string,
      now: string,
      error: Readonly<{ code: string; message: string }>,
    ): Promise<void> {
      const decision = decideOutboxFailure(delivery.attemptCount);
      if (decision.state === 'dead') {
        await db.prepare(`
          UPDATE event_outbox_deliveries
          SET status = 'dead', dead_at = ?,
              claimed_at = NULL, claim_expires_at = NULL, claimed_by = NULL,
              last_error_code = ?, last_error_message = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND claimed_by = ?
        `).bind(now, error.code, error.message, now, delivery.deliveryId, workerId).run();
        return;
      }
      await db.prepare(`
        UPDATE event_outbox_deliveries
        SET status = 'pending', available_at = ?,
            claimed_at = NULL, claim_expires_at = NULL, claimed_by = NULL,
            last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND claimed_by = ?
      `).bind(
        addSeconds(now, decision.retryAfterSeconds),
        error.code,
        error.message,
        now,
        delivery.deliveryId,
        workerId,
      ).run();
    },

    async purge(now: string): Promise<void> {
      const cutoff = new Date(Date.parse(now) - OUTBOX_POLICY.deliveredRetentionDays * 86_400_000).toISOString();
      await db.batch([
        db.prepare(`
          DELETE FROM event_outbox_deliveries
          WHERE id IN (
            SELECT id FROM event_outbox_deliveries
            WHERE status = 'delivered' AND delivered_at < ?
            ORDER BY delivered_at, id LIMIT 100
          )
        `).bind(cutoff),
        db.prepare(`
          DELETE FROM event_outbox_events
          WHERE event_id IN (
            SELECT e.event_id FROM event_outbox_events e
            LEFT JOIN event_outbox_deliveries d ON d.event_id = e.event_id
            WHERE d.id IS NULL AND e.created_at < ?
            ORDER BY e.created_at, e.event_id LIMIT 100
          )
        `).bind(cutoff),
      ]);
    },

    /** Puerto interno para una futura acción admin autenticada (R1.8/R1.11). */
    async replayDead(deliveryId: number, now: string): Promise<boolean> {
      const result = await db.prepare(`
        UPDATE event_outbox_deliveries
        SET status = 'pending', attempt_count = 0, available_at = ?,
            dead_at = NULL, last_error_code = NULL, last_error_message = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'dead'
      `).bind(now, now, deliveryId).run();
      return result.meta.changes === 1;
    },
  };
}

export type D1EventOutboxRepository = ReturnType<typeof createD1EventOutboxRepository>;
