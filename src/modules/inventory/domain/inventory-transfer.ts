export const INVENTORY_TRANSFER_STATUSES = [
  'draft',
  'in_transit',
  'partially_received',
  'received',
] as const;

export type InventoryTransferStatus = (typeof INVENTORY_TRANSFER_STATUSES)[number];

export const INVENTORY_TRANSFER_POLICY = Object.freeze({
  maxLines: 100,
  maxQuantityPerLine: 100_000,
  maxNoteLength: 500,
  maxIdempotencyKeyLength: 160,
});

export type InventoryTransferLineDraft = Readonly<{
  variantId: number;
  quantity: number;
}>;

export type InventoryTransferReceiptDraft = Readonly<{
  transferLineId: string;
  receivedQuantity: number;
  discrepancyQuantity: number;
}>;

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} debe ser un entero seguro positivo.`);
  }
}

export function assertInventoryTransferDraft(input: Readonly<{
  sourceLocationId: number;
  destinationLocationId: number;
  lines: readonly InventoryTransferLineDraft[];
  note?: string;
}>): void {
  assertPositiveInteger(input.sourceLocationId, 'source_location_id');
  assertPositiveInteger(input.destinationLocationId, 'destination_location_id');
  if (input.sourceLocationId === input.destinationLocationId) {
    throw new RangeError('El origen y el destino deben ser distintos.');
  }
  if (input.lines.length < 1 || input.lines.length > INVENTORY_TRANSFER_POLICY.maxLines) {
    throw new RangeError(`La transferencia admite entre 1 y ${INVENTORY_TRANSFER_POLICY.maxLines} líneas.`);
  }
  const variants = new Set<number>();
  for (const line of input.lines) {
    assertPositiveInteger(line.variantId, 'variant_id');
    assertPositiveInteger(line.quantity, 'quantity');
    if (line.quantity > INVENTORY_TRANSFER_POLICY.maxQuantityPerLine) {
      throw new RangeError('La cantidad de una línea supera el máximo operativo.');
    }
    if (variants.has(line.variantId)) throw new RangeError('Cada variante solo puede aparecer una vez.');
    variants.add(line.variantId);
  }
  if ((input.note?.trim().length ?? 0) > INVENTORY_TRANSFER_POLICY.maxNoteLength) {
    throw new RangeError('La nota de transferencia supera el máximo permitido.');
  }
}

export function assertInventoryTransferReceipt(
  current: readonly Readonly<{
    id: string;
    sentQuantity: number;
    receivedQuantity: number;
    discrepancyQuantity: number;
  }>[],
  receipt: readonly InventoryTransferReceiptDraft[],
): void {
  if (receipt.length < 1 || receipt.length > INVENTORY_TRANSFER_POLICY.maxLines) {
    throw new RangeError('La recepción debe incluir al menos una línea.');
  }
  const byId = new Map(current.map((line) => [line.id, line]));
  const seen = new Set<string>();
  for (const line of receipt) {
    if (seen.has(line.transferLineId)) throw new RangeError('La recepción contiene una línea duplicada.');
    seen.add(line.transferLineId);
    const currentLine = byId.get(line.transferLineId);
    if (!currentLine) throw new RangeError('La línea no pertenece a la transferencia.');
    if (!Number.isSafeInteger(line.receivedQuantity) || line.receivedQuantity < 0 ||
        !Number.isSafeInteger(line.discrepancyQuantity) || line.discrepancyQuantity < 0) {
      throw new RangeError('Las cantidades recibidas y discrepantes deben ser enteros no negativos.');
    }
    if (line.receivedQuantity + line.discrepancyQuantity < 1) {
      throw new RangeError('Cada línea informada debe recibir o declarar al menos una unidad discrepante.');
    }
    const remaining = currentLine.sentQuantity - currentLine.receivedQuantity - currentLine.discrepancyQuantity;
    if (line.receivedQuantity + line.discrepancyQuantity > remaining) {
      throw new RangeError('La recepción supera las unidades pendientes de la línea.');
    }
  }
}

export function transferStatusAfterReceipt(lines: readonly Readonly<{
  sentQuantity: number;
  receivedQuantity: number;
  discrepancyQuantity: number;
}>[]): 'partially_received' | 'received' {
  return lines.every((line) => line.receivedQuantity + line.discrepancyQuantity === line.sentQuantity)
    ? 'received'
    : 'partially_received';
}
