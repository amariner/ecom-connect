/**
 * Agregado canónico de catálogo R2.3.
 *
 * `Product` conserva identidad y contenido editorial; `ProductVariant` es la
 * unidad vendible. El stock todavía llega como una proyección legacy separada
 * desde R2.7 sale del ledger de inventario por variante.
 */

export const PRODUCT_VARIANT_STATUSES = ['draft', 'active', 'archived'] as const;

export type ProductVariantStatus = (typeof PRODUCT_VARIANT_STATUSES)[number];

export type ProductOptionSelection = Readonly<{
  option_id: number;
  option_name: string;
  option_position: number;
  value_id: number;
  value: string;
  value_position: number;
}>;

export type ProductVariant = Readonly<{
  id: number;
  product_id: number;
  sku: string;
  gtin: string | null;
  mpn: string | null;
  title: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  status: ProductVariantStatus;
  is_default: boolean;
  option_signature: string | null;
  options: readonly ProductOptionSelection[];
  created_at: string;
  updated_at: string;
}>;

export type Product = Readonly<{
  id: number;
  slug: string;
  name: string;
  description: string;
  image: string;
  category: string;
  collection: string;
  active: boolean;
  subtitle: string | null;
  specs_json: string | null;
  created_at: string;
  variants: readonly ProductVariant[];
}>;

export type CatalogEntry = Readonly<{
  product: Product;
  /** Disponibilidad canónica `on_hand - reserved` de la variante por defecto. */
  available_stock: number;
}>;

export type CatalogEntryDraft = Readonly<{
  product: Omit<Product, 'variants'>;
  variants: readonly ProductVariant[];
  available_stock: number;
}>;

export class CatalogInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogInvariantError';
  }
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CatalogInvariantError(message);
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function optionSignature(options: readonly ProductOptionSelection[]): string | null {
  if (options.length === 0) return null;
  return JSON.stringify(options.map((option) => option.value_id).toSorted((a, b) => a - b));
}

/** Valida y congela el agregado antes de que salga del repositorio. */
export function createCatalogEntry(draft: CatalogEntryDraft): CatalogEntry {
  const { product } = draft;
  invariant(positiveInteger(product.id), 'product.id debe ser un entero positivo');
  invariant(product.slug.trim().length > 0, `producto ${product.id}: slug vacío`);
  invariant(product.name.trim().length > 0, `producto ${product.id}: name vacío`);
  invariant(nonNegativeInteger(draft.available_stock), `producto ${product.id}: stock legacy inválido`);
  invariant(draft.variants.length > 0, `producto ${product.id}: falta variante vendible`);

  const ids = new Set<number>();
  const skus = new Set<string>();
  const signatures = new Set<string>();
  let defaultCount = 0;

  const variants = draft.variants.map((variant): ProductVariant => {
    invariant(positiveInteger(variant.id), `producto ${product.id}: variant.id inválido`);
    invariant(variant.product_id === product.id, `variante ${variant.id}: pertenece a otro producto`);
    invariant(!ids.has(variant.id), `producto ${product.id}: variant.id duplicado`);
    ids.add(variant.id);

    const normalizedSku = variant.sku.trim().toLocaleLowerCase('en');
    invariant(normalizedSku.length > 0 && normalizedSku.length <= 100, `variante ${variant.id}: SKU inválido`);
    invariant(!skus.has(normalizedSku), `producto ${product.id}: SKU duplicado`);
    skus.add(normalizedSku);

    invariant(nonNegativeInteger(variant.price_cents), `variante ${variant.id}: price_cents inválido`);
    invariant(
      variant.compare_at_price_cents === null ||
        (Number.isInteger(variant.compare_at_price_cents) && variant.compare_at_price_cents > variant.price_cents),
      `variante ${variant.id}: compare_at_price_cents inválido`,
    );
    invariant(
      PRODUCT_VARIANT_STATUSES.includes(variant.status),
      `variante ${variant.id}: status inválido`,
    );
    if (variant.is_default) defaultCount += 1;

    const optionIds = new Set<number>();
    const valueIds = new Set<number>();
    const options = variant.options.map((option): ProductOptionSelection => {
      invariant(positiveInteger(option.option_id), `variante ${variant.id}: option_id inválido`);
      invariant(positiveInteger(option.value_id), `variante ${variant.id}: value_id inválido`);
      invariant(nonNegativeInteger(option.option_position), `variante ${variant.id}: option_position inválida`);
      invariant(nonNegativeInteger(option.value_position), `variante ${variant.id}: value_position inválida`);
      invariant(option.option_name.trim().length > 0, `variante ${variant.id}: option_name vacío`);
      invariant(option.value.trim().length > 0, `variante ${variant.id}: option value vacío`);
      invariant(!optionIds.has(option.option_id), `variante ${variant.id}: opción repetida`);
      invariant(!valueIds.has(option.value_id), `variante ${variant.id}: valor repetido`);
      optionIds.add(option.option_id);
      valueIds.add(option.value_id);
      return Object.freeze({ ...option });
    }).toSorted((a, b) => a.option_position - b.option_position || a.option_id - b.option_id);

    const expectedSignature = optionSignature(options);
    invariant(
      variant.option_signature === expectedSignature,
      `variante ${variant.id}: option_signature no coincide con sus valores`,
    );
    const combinationKey = expectedSignature ?? 'simple';
    invariant(!signatures.has(combinationKey), `producto ${product.id}: combinación de opciones duplicada`);
    signatures.add(combinationKey);

    return Object.freeze({ ...variant, options: Object.freeze(options) });
  });

  invariant(defaultCount === 1, `producto ${product.id}: debe tener exactamente una variante default`);
  const defaultVariant = variants.find((variant) => variant.is_default);
  invariant(defaultVariant !== undefined, `producto ${product.id}: falta variante default`);
  invariant(
    !product.active || defaultVariant.status === 'active',
    `producto ${product.id}: el default de un producto activo debe estar activo`,
  );

  return Object.freeze({
    product: Object.freeze({ ...product, variants: Object.freeze(variants) }),
    available_stock: draft.available_stock,
  });
}

export function defaultProductVariant(entry: CatalogEntry): ProductVariant {
  const variant = entry.product.variants.find((candidate) => candidate.is_default);
  if (!variant) throw new CatalogInvariantError(`producto ${entry.product.id}: falta variante default`);
  return variant;
}
