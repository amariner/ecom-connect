import { defaultProductVariant, type CatalogEntry } from '../domain/product';

export const CATALOG_READ_MODES = ['legacy', 'shadow', 'variant'] as const;
export type CatalogReadMode = (typeof CATALOG_READ_MODES)[number];

export type CatalogSortOption = 'featured' | 'price-asc' | 'price-desc' | 'name';

export type CatalogQuery = Readonly<{
  category?: string | undefined;
  sort?: CatalogSortOption | undefined;
  search?: string | undefined;
}>;

/** Contrato compatible que consumen storefront y checkout durante expand/contract. */
export type StorefrontProductRow = Readonly<{
  id: number;
  slug: string;
  name: string;
  description: string;
  price_cents: number;
  stock: number;
  image: string;
  category: string;
  active: number;
  created_at: string;
  collection: string;
  subtitle: string | null;
  compare_at_price_cents: number | null;
  specs_json: string | null;
}>;

export interface CanonicalCatalogRepository {
  listActive(collection: string, query?: CatalogQuery): Promise<readonly CatalogEntry[]>;
  findActive(collection: string, slug: string): Promise<CatalogEntry | null>;
  findActiveBySlugs(slugs: readonly string[]): Promise<readonly CatalogEntry[]>;
}

export interface LegacyCatalogReader {
  listActive(collection: string, query?: CatalogQuery): Promise<readonly StorefrontProductRow[]>;
  findActive(collection: string, slug: string): Promise<StorefrontProductRow | null>;
  findActiveBySlugs(slugs: readonly string[]): Promise<readonly StorefrontProductRow[]>;
}

export interface CatalogReader extends LegacyCatalogReader {}

export class CatalogReadConfigurationError extends Error {
  constructor(value: string) {
    super(`CATALOG_READ_MODE no válido: ${value}`);
    this.name = 'CatalogReadConfigurationError';
  }
}

export class CatalogShadowReadMismatchError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`catalog-shadow-read-mismatch:${operation}`);
    this.name = 'CatalogShadowReadMismatchError';
    this.operation = operation;
  }
}

export function resolveCatalogReadMode(value: string | undefined): CatalogReadMode {
  if (value === undefined || value.trim() === '') return 'shadow';
  if (CATALOG_READ_MODES.includes(value as CatalogReadMode)) return value as CatalogReadMode;
  throw new CatalogReadConfigurationError(value);
}

export function isCatalogSortOption(value: string): value is CatalogSortOption {
  return value === 'featured' || value === 'price-asc' || value === 'price-desc' || value === 'name';
}

/** Escapa `%`, `_` y `\` para un `LIKE ... ESCAPE '\'` literal. */
export function escapeCatalogSearch(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function projectDefaultVariant(entry: CatalogEntry): StorefrontProductRow {
  const variant = defaultProductVariant(entry);
  const product = entry.product;
  return Object.freeze({
    id: product.id,
    slug: product.slug,
    name: product.name,
    description: product.description,
    price_cents: variant.price_cents,
    stock: entry.available_stock,
    image: product.image,
    category: product.category,
    active: product.active ? 1 : 0,
    created_at: product.created_at,
    collection: product.collection,
    subtitle: product.subtitle,
    compare_at_price_cents: variant.compare_at_price_cents,
    specs_json: product.specs_json,
  });
}

function canonicalReader(repository: CanonicalCatalogRepository): CatalogReader {
  return {
    async listActive(collection, query) {
      return (await repository.listActive(collection, query)).map(projectDefaultVariant);
    },
    async findActive(collection, slug) {
      const entry = await repository.findActive(collection, slug);
      return entry ? projectDefaultVariant(entry) : null;
    },
    async findActiveBySlugs(slugs) {
      return (await repository.findActiveBySlugs(slugs)).map(projectDefaultVariant);
    },
  };
}

function comparable(
  value: readonly StorefrontProductRow[] | StorefrontProductRow | null,
  unordered: boolean,
): string {
  if (Array.isArray(value)) {
    return JSON.stringify(unordered ? [...value].toSorted((a, b) => a.slug.localeCompare(b.slug)) : value);
  }
  return JSON.stringify(value);
}

function assertSame(
  operation: string,
  legacy: readonly StorefrontProductRow[] | StorefrontProductRow | null,
  canonical: readonly StorefrontProductRow[] | StorefrontProductRow | null,
  unordered = false,
): void {
  if (comparable(legacy, unordered) !== comparable(canonical, unordered)) {
    throw new CatalogShadowReadMismatchError(operation);
  }
}

/**
 * Rollout reversible de R2.3.
 *
 * `shadow` sirve el contrato legacy después de contrastarlo con el canónico;
 * `variant` corta al canónico; `legacy` permite volver sin cambiar el binario.
 */
export function createCompatibleCatalogReader(
  legacy: LegacyCatalogReader,
  repository: CanonicalCatalogRepository,
  mode: CatalogReadMode,
): CatalogReader {
  const canonical = canonicalReader(repository);
  if (mode === 'legacy') return legacy;
  if (mode === 'variant') return canonical;

  return {
    async listActive(collection, query) {
      const [previous, next] = await Promise.all([
        legacy.listActive(collection, query),
        canonical.listActive(collection, query),
      ]);
      assertSame('list-active', previous, next);
      return previous;
    },
    async findActive(collection, slug) {
      const [previous, next] = await Promise.all([
        legacy.findActive(collection, slug),
        canonical.findActive(collection, slug),
      ]);
      assertSame('find-active', previous, next);
      return previous;
    },
    async findActiveBySlugs(slugs) {
      const [previous, next] = await Promise.all([
        legacy.findActiveBySlugs(slugs),
        canonical.findActiveBySlugs(slugs),
      ]);
      assertSame('find-active-by-slugs', previous, next, true);
      return previous;
    },
  };
}
