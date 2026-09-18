export const INVENTORY_LOCATION_KINDS = ['warehouse', 'store'] as const;
export const INVENTORY_LOCATION_STATUSES = ['active', 'inactive'] as const;

export type InventoryLocationKind = (typeof INVENTORY_LOCATION_KINDS)[number];
export type InventoryLocationStatus = (typeof INVENTORY_LOCATION_STATUSES)[number];

export function normalizeInventoryLocationCode(value: string): string {
  return value.trim().toLocaleLowerCase('en')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

export function assertInventoryLocationInput(input: Readonly<{
  code: string; name: string; timezone: string;
}>): void {
  if (input.code !== normalizeInventoryLocationCode(input.code) || input.code.length < 2) {
    throw new RangeError('Código de ubicación inválido.');
  }
  if (input.name.trim().length < 2 || input.name.trim().length > 100) {
    throw new RangeError('Nombre de ubicación inválido.');
  }
  if (input.timezone.trim().length < 3 || input.timezone.trim().length > 64 || !input.timezone.includes('/')) {
    throw new RangeError('Zona horaria inválida.');
  }
}
