import type {
  ProductOptionAdminRow,
  ProductVariantAdminDetails,
  ProductVariantAdminRow,
} from './product-admin';

export type ProductOptionCreate = Readonly<{ product_id: number; name: string }>;
export type ProductOptionPatch = Readonly<{ name: string }>;
export type ProductOptionValueCreate = Readonly<{ option_id: number; value: string }>;
export type ProductOptionValuePatch = Readonly<{ value: string }>;

export type ProductVariantWrite = Readonly<{
  sku: string;
  gtin: string | null;
  mpn: string | null;
  title: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  status: 'draft' | 'active' | 'archived';
  option_value_ids: readonly number[];
  make_default?: boolean | undefined;
}>;

export type ProductVariantCreate = ProductVariantWrite & Readonly<{ product_id: number }>;

export type CatalogAdminErrorCode =
  | 'default-protected'
  | 'in-use'
  | 'inventory-history'
  | 'invalid-selection'
  | 'missing-options';

export class CatalogAdminError extends Error {
  constructor(readonly code: CatalogAdminErrorCode, message: string) {
    super(message);
    this.name = 'CatalogAdminError';
  }
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('es');
}

function selectionByOption(
  options: readonly ProductOptionAdminRow[],
  optionValueIds: readonly number[],
): Map<number, number> {
  const selected = new Set(optionValueIds);
  if (selected.size !== optionValueIds.length) {
    throw new CatalogAdminError('invalid-selection', 'Una combinación no puede repetir valores.');
  }
  const byOption = new Map<number, number>();
  for (const option of options) {
    const matches = option.values.filter((value) => selected.has(value.id));
    if (matches.length !== 1) {
      throw new CatalogAdminError(
        'invalid-selection',
        `Selecciona exactamente un valor de «${option.name}».`,
      );
    }
    byOption.set(option.id, matches[0]!.id);
  }
  if (byOption.size !== optionValueIds.length) {
    throw new CatalogAdminError('invalid-selection', 'La combinación contiene valores ajenos al producto.');
  }
  return byOption;
}

export function validateOptionName(
  options: readonly ProductOptionAdminRow[],
  name: string,
  exceptId?: number,
): void {
  if (options.some((option) => option.id !== exceptId && normalized(option.name) === normalized(name))) {
    throw new CatalogAdminError('invalid-selection', 'Ya existe una opción con ese nombre.');
  }
}

export function validateOptionValue(
  option: ProductOptionAdminRow,
  value: string,
  exceptId?: number,
): void {
  if (option.values.some((candidate) => candidate.id !== exceptId && normalized(candidate.value) === normalized(value))) {
    throw new CatalogAdminError('invalid-selection', 'Ese valor ya existe en la opción.');
  }
}

export function validateVariantWrite(
  details: ProductVariantAdminDetails,
  write: ProductVariantWrite,
  existing?: ProductVariantAdminRow,
): readonly number[] {
  if (details.options.length === 0) {
    throw new CatalogAdminError(
      'missing-options',
      'Crea al menos una opción y sus valores antes de añadir combinaciones.',
    );
  }
  const byOption = selectionByOption(details.options, write.option_value_ids);
  const signatureIds = [...byOption.values()].toSorted((a, b) => a - b);
  const signature = JSON.stringify(signatureIds);
  if (details.variants.some((variant) => variant.id !== existing?.id && variant.option_signature === signature)) {
    throw new CatalogAdminError('invalid-selection', 'Ya existe una variante con esa combinación.');
  }
  const sku = normalized(write.sku);
  if (details.variants.some((variant) => variant.id !== existing?.id && normalized(variant.sku) === sku)) {
    throw new CatalogAdminError('invalid-selection', 'Ese SKU ya pertenece a otra variante del producto.');
  }
  if (write.compare_at_price_cents !== null && write.compare_at_price_cents <= write.price_cents) {
    throw new CatalogAdminError(
      'invalid-selection',
      'El precio anterior debe ser mayor que el precio actual.',
    );
  }
  return Object.freeze(signatureIds);
}
