/**
 * Contrato aprobado por código para el diseño del outbox (R1.6).
 *
 * La política nació como contrato sin I/O en R1.6 y R1.7 la consume desde la
 * migración y el dispatcher. El DDL aprobado conserva su evidencia en
 * `docs/plataforma/sql/0004_event_outbox.proposed.sql`.
 */

export const OUTBOX_DELIVERY_STATES = ['pending', 'processing', 'delivered', 'dead'] as const;
export type OutboxDeliveryState = (typeof OUTBOX_DELIVERY_STATES)[number];

export const OUTBOX_POLICY = Object.freeze({
  claimBatchSize: 25,
  leaseSeconds: 60,
  maxAttempts: 8,
  retryDelaysSeconds: Object.freeze([30, 120, 600, 1_800, 7_200, 21_600, 86_400] as const),
  deliveredRetentionDays: 30,
  maxErrorCodeLength: 80,
  maxErrorMessageLength: 500,
});

export type OutboxFailureDecision =
  | Readonly<{ state: 'pending'; retryAfterSeconds: number }>
  | Readonly<{ state: 'dead'; retryAfterSeconds: null }>;

/**
 * `attemptCount` incluye el intento que acaba de fallar. El octavo fallo pasa
 * a dead-letter; antes se aplica el backoff exacto fijado por el ADR.
 */
export function decideOutboxFailure(attemptCount: number): OutboxFailureDecision {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new RangeError('attemptCount debe ser un entero mayor o igual que 1.');
  }
  if (attemptCount >= OUTBOX_POLICY.maxAttempts) {
    return Object.freeze({ state: 'dead', retryAfterSeconds: null });
  }
  const retryAfterSeconds = OUTBOX_POLICY.retryDelaysSeconds[attemptCount - 1];
  if (retryAfterSeconds === undefined) {
    throw new RangeError('No existe una demora para ese intento.');
  }
  return Object.freeze({
    state: 'pending',
    retryAfterSeconds,
  });
}

/** SQL atómico de claim que R1.7 ejecutará después de normalizar leases vencidos. */
export const CLAIM_OUTBOX_DELIVERIES_SQL = `
UPDATE event_outbox_deliveries
SET status = 'processing',
    attempt_count = attempt_count + 1,
    claimed_at = ?1,
    claim_expires_at = ?2,
    claimed_by = ?3,
    updated_at = ?1
WHERE id IN (
  SELECT id
  FROM event_outbox_deliveries
  WHERE status = 'pending'
    AND available_at <= ?1
    AND attempt_count < ?4
  ORDER BY available_at ASC, id ASC
  LIMIT ?5
)
RETURNING id, event_id, consumer_id, attempt_count, claim_expires_at;
`.trim();
