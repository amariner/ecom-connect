import type { InventoryBalance, InventoryReservationState } from './inventory-ledger';

export const INVENTORY_RESERVATION_POLICY = Object.freeze({
  // Un minuto de margen sobre el mínimo de 30 min aceptado por Stripe evita
  // que latencia o pequeño clock skew conviertan expires_at en inválido.
  ttlSeconds: 31 * 60,
  expiryBatchSize: 100,
  maxOwnerIdLength: 160,
  maxIdempotencyKeyLength: 200,
});

export type InventoryReservationOwnerType = 'cart' | 'checkout' | 'order';

export type InventoryReservationLine = Readonly<{
  variant_id: number;
  product_id: number;
  is_default: boolean;
  quantity: number;
  balance: InventoryBalance & { reservation_version: number };
}>;

export type InventoryReservation = Readonly<{
  id: string;
  owner_type: InventoryReservationOwnerType;
  owner_id: string;
  status: InventoryReservationState;
  idempotency_key: string;
  expires_at: string;
  version: number;
  lines: readonly InventoryReservationLine[];
}>;

function assertText(value: string, field: string, max: number): void {
  const length = value.trim().length;
  if (length < 1 || length > max) throw new RangeError(`${field} debe medir entre 1 y ${max}.`);
}

export function reservationExpiry(createdAt: string, ttlSeconds = INVENTORY_RESERVATION_POLICY.ttlSeconds): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) throw new RangeError('created_at debe ser una fecha ISO válida.');
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 24 * 60 * 60) {
    throw new RangeError('ttlSeconds debe estar entre 60 y 86400.');
  }
  return new Date(timestamp + ttlSeconds * 1000).toISOString();
}

export function assertReservationCreation(input: Readonly<{
  owner_type: InventoryReservationOwnerType;
  owner_id: string;
  idempotency_key: string;
  created_at: string;
  expires_at: string;
  lines: readonly InventoryReservationLine[];
}>): void {
  assertText(input.owner_id, 'owner_id', INVENTORY_RESERVATION_POLICY.maxOwnerIdLength);
  assertText(input.idempotency_key, 'idempotency_key', INVENTORY_RESERVATION_POLICY.maxIdempotencyKeyLength);
  const created = Date.parse(input.created_at);
  const expires = Date.parse(input.expires_at);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) {
    throw new RangeError('expires_at debe ser posterior a created_at.');
  }
  if (input.lines.length < 1) throw new RangeError('La reserva exige al menos una línea.');
  const variants = new Set<number>();
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.variant_id) || line.variant_id < 1 || variants.has(line.variant_id)) {
      throw new RangeError('Cada variant_id debe ser único y >= 1.');
    }
    variants.add(line.variant_id);
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) {
      throw new RangeError('quantity debe ser un entero seguro >= 1.');
    }
    if (line.balance.on_hand - line.balance.reserved < line.quantity) {
      throw new RangeError('inventario disponible insuficiente para reservar.');
    }
  }
}

export function assertReservationTransition(
  reservation: InventoryReservation,
  to: Exclude<InventoryReservationState, 'active'>,
  occurredAt: string,
  idempotencyKey: string,
): void {
  if (reservation.status !== 'active') throw new RangeError('La reserva ya es terminal.');
  assertText(idempotencyKey, 'idempotency_key', INVENTORY_RESERVATION_POLICY.maxIdempotencyKeyLength);
  const occurred = Date.parse(occurredAt);
  const expires = Date.parse(reservation.expires_at);
  if (!Number.isFinite(occurred) || !Number.isFinite(expires)) throw new RangeError('Fecha de transición inválida.');
  if (to === 'expired' && occurred < expires) throw new RangeError('La reserva todavía no ha vencido.');
  if (to === 'consumed' && occurred >= expires) throw new RangeError('No se puede consumir una reserva vencida.');
}
