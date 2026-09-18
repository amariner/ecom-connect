export const INVENTORY_MOVEMENT_REASONS = [
  'legacy_opening_balance',
  'sale',
  'cancellation_restock',
  'return_restock',
  'manual_adjustment',
  'reconciliation_correction',
  'damage',
] as const;

export type InventoryMovementReason = (typeof INVENTORY_MOVEMENT_REASONS)[number];
export type InventoryActorKind = 'system' | 'admin' | 'provider';

export type InventoryBalance = Readonly<{
  variant_id: number;
  on_hand: number;
  reserved: number;
  version: number;
}>;

export type InventoryMovementDraft = Readonly<{
  delta: number;
  reason: InventoryMovementReason;
  actor_kind: InventoryActorKind;
  actor_id: string;
  reference_type: string;
  reference_id: string;
  idempotency_key: string;
  correlation_id: string;
}>;

const REASON_DIRECTION = Object.freeze({
  legacy_opening_balance: 'any',
  sale: 'out',
  cancellation_restock: 'in',
  return_restock: 'in',
  manual_adjustment: 'any_nonzero',
  reconciliation_correction: 'any_nonzero',
  damage: 'out',
} as const satisfies Record<InventoryMovementReason, 'in' | 'out' | 'any' | 'any_nonzero'>);

export const INVENTORY_POLICY = Object.freeze({
  maxActorIdLength: 120,
  maxReferenceTypeLength: 80,
  maxReferenceIdLength: 160,
  maxIdempotencyKeyLength: 200,
  maxCorrelationIdLength: 160,
});

export function availableStock(balance: Pick<InventoryBalance, 'on_hand' | 'reserved'>): number {
  return balance.on_hand - balance.reserved;
}

function assertInteger(value: number, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${field} debe ser un entero seguro >= ${minimum}.`);
  }
}

function assertText(value: string, field: string, max: number): void {
  const length = value.trim().length;
  if (length < 1 || length > max) throw new RangeError(`${field} debe medir entre 1 y ${max}.`);
}

export function planInventoryMovement(
  balance: InventoryBalance,
  draft: InventoryMovementDraft,
): Readonly<InventoryBalance & { balance_after: number; version_after: number }> {
  assertInteger(balance.variant_id, 'variant_id', 1);
  assertInteger(balance.on_hand, 'on_hand');
  assertInteger(balance.reserved, 'reserved');
  assertInteger(balance.version, 'version', 1);
  if (balance.reserved > balance.on_hand) throw new RangeError('reserved no puede superar on_hand.');
  if (!Number.isSafeInteger(draft.delta)) throw new RangeError('delta debe ser un entero seguro.');

  const direction = REASON_DIRECTION[draft.reason];
  if (direction === undefined) throw new RangeError('reason no pertenece al contrato cerrado.');
  if (direction === 'in' && draft.delta <= 0) throw new RangeError(`${draft.reason} exige delta positivo.`);
  if (direction === 'out' && draft.delta >= 0) throw new RangeError(`${draft.reason} exige delta negativo.`);
  if (direction === 'any_nonzero' && draft.delta === 0) throw new RangeError(`${draft.reason} exige delta distinto de cero.`);
  if (draft.delta === 0 && draft.reason !== 'legacy_opening_balance') {
    throw new RangeError('solo la apertura legacy admite delta cero.');
  }

  assertText(draft.actor_id, 'actor_id', INVENTORY_POLICY.maxActorIdLength);
  assertText(draft.reference_type, 'reference_type', INVENTORY_POLICY.maxReferenceTypeLength);
  assertText(draft.reference_id, 'reference_id', INVENTORY_POLICY.maxReferenceIdLength);
  assertText(draft.idempotency_key, 'idempotency_key', INVENTORY_POLICY.maxIdempotencyKeyLength);
  assertText(draft.correlation_id, 'correlation_id', INVENTORY_POLICY.maxCorrelationIdLength);

  const onHand = balance.on_hand + draft.delta;
  if (!Number.isSafeInteger(onHand) || onHand < balance.reserved) {
    throw new RangeError('el movimiento dejaría disponibilidad negativa.');
  }
  const version = balance.version + 1;
  return Object.freeze({
    variant_id: balance.variant_id,
    on_hand: onHand,
    reserved: balance.reserved,
    version,
    balance_after: onHand,
    version_after: version,
  });
}

export const INVENTORY_RESERVATION_STATES = ['active', 'released', 'consumed', 'expired'] as const;
export type InventoryReservationState = (typeof INVENTORY_RESERVATION_STATES)[number];

const RESERVATION_TRANSITIONS: Readonly<Record<InventoryReservationState, readonly InventoryReservationState[]>> = {
  active: ['released', 'consumed', 'expired'],
  released: [],
  consumed: [],
  expired: [],
};

export function canTransitionReservation(from: InventoryReservationState, to: InventoryReservationState): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}

/**
 * Primer paso de una batch de R2.7: gana solo con versión vigente,
 * disponibilidad suficiente y una clave que todavía no existe.
 */
export const APPLY_INVENTORY_DELTA_SQL = `
UPDATE inventory_balances
SET on_hand = on_hand + ?1,
    version = version + 1,
    updated_at = ?5
WHERE variant_id = ?2
  AND version = ?3
  AND on_hand + ?1 >= reserved
  AND NOT EXISTS (
    SELECT 1 FROM inventory_movements WHERE idempotency_key = ?4
  )
RETURNING variant_id, on_hand, reserved, version;
`.trim();
