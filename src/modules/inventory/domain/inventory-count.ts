export const INVENTORY_COUNT_STATUSES = ['draft', 'pending_approval', 'applied'] as const;
export const INVENTORY_COUNT_REASONS = ['cycle_count', 'reconciliation', 'damage'] as const;

export type InventoryCountStatus = (typeof INVENTORY_COUNT_STATUSES)[number];
export type InventoryCountReason = (typeof INVENTORY_COUNT_REASONS)[number];

export const INVENTORY_COUNT_POLICY = Object.freeze({
  maxLines: 100,
  maxQuantity: 1_000_000,
  maxNoteLength: 500,
  maxActorLength: 120,
});

export type InventoryCountLineDraft = Readonly<{
  variantId: number;
  countedQuantity: number;
}>;

export function assertInventoryCountDraft(input: Readonly<{
  locationId: number;
  reason: InventoryCountReason;
  countedBy: string;
  lines: readonly InventoryCountLineDraft[];
  note?: string;
}>): void {
  if (!Number.isSafeInteger(input.locationId) || input.locationId < 1) {
    throw new RangeError('location_id debe ser un entero seguro positivo.');
  }
  if (!INVENTORY_COUNT_REASONS.includes(input.reason)) throw new RangeError('Motivo de conteo inválido.');
  if (input.countedBy.trim() !== input.countedBy || input.countedBy.length < 2 || input.countedBy.length > INVENTORY_COUNT_POLICY.maxActorLength) {
    throw new RangeError('La referencia del contador debe medir entre 2 y 120 caracteres.');
  }
  if (input.lines.length < 1 || input.lines.length > INVENTORY_COUNT_POLICY.maxLines) {
    throw new RangeError(`El conteo admite entre 1 y ${INVENTORY_COUNT_POLICY.maxLines} líneas.`);
  }
  const variants = new Set<number>();
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.variantId) || line.variantId < 1) throw new RangeError('variant_id inválido.');
    if (!Number.isSafeInteger(line.countedQuantity) || line.countedQuantity < 0 || line.countedQuantity > INVENTORY_COUNT_POLICY.maxQuantity) {
      throw new RangeError('La cantidad contada debe ser un entero entre 0 y 1000000.');
    }
    if (variants.has(line.variantId)) throw new RangeError('Cada variante solo puede aparecer una vez.');
    variants.add(line.variantId);
  }
  if ((input.note?.trim().length ?? 0) > INVENTORY_COUNT_POLICY.maxNoteLength) {
    throw new RangeError('La nota de conteo supera el máximo permitido.');
  }
}

export function assertInventoryCountReviewer(countedBy: string, reviewedBy: string): void {
  if (reviewedBy.trim() !== reviewedBy || reviewedBy.length < 2 || reviewedBy.length > INVENTORY_COUNT_POLICY.maxActorLength) {
    throw new RangeError('La referencia del revisor debe medir entre 2 y 120 caracteres.');
  }
  if (reviewedBy === countedBy) throw new RangeError('El revisor debe ser distinto del contador.');
}
