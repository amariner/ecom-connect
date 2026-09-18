/** Fachada legacy: el SQL de catálogo ya vive en `modules/catalog`. */

import {
  createCatalogReader,
  escapeCatalogSearch,
  isCatalogSortOption,
  type CatalogReadMode,
  type CatalogSortOption,
  type StorefrontProductRow,
} from '../modules/catalog';

export type ProductRow = StorefrontProductRow;

/** Fila de ficha técnica ya validada. */
export type ProductSpec = { label: string; value: string };

/**
 * Lee `specs_json` de forma defensiva: es TEXT libre en D1, así que se valida la
 * forma antes de renderizar y cualquier cosa rara se descarta en silencio (una
 * ficha técnica malformada no debe tumbar la página de producto).
 */
export function parseSpecs(specsJson: string | null): ProductSpec[] {
  if (!specsJson) return [];
  try {
    const parsed: unknown = JSON.parse(specsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row): ProductSpec[] => {
      if (typeof row !== 'object' || row === null) return [];
      const { label, value } = row as Record<string, unknown>;
      return typeof label === 'string' && typeof value === 'string' ? [{ label, value }] : [];
    });
  } catch {
    return [];
  }
}

export type ShippingRateRow = {
  id: number;
  zone: string;
  label: string;
  price_cents: number;
  free_over_cents: number | null;
  active: number;
};

export type SortOption = CatalogSortOption;

export function isSortOption(value: string): value is SortOption {
  return isCatalogSortOption(value);
}

/** Escapa %, _ y \ para que un LIKE ... ESCAPE '\' trate el término de búsqueda como literal. */
export function escapeLikePattern(term: string): string {
  return escapeCatalogSearch(term);
}

/**
 * Catálogo de UNA colección.
 *
 * `collection` es obligatorio a propósito: así el compilador obliga a cada punto
 * de lectura a declarar de qué tienda está tirando, y ningún tema puede leer la
 * tabla entera por olvido. Debe venir ya validado contra el registro de
 * `collections.ts` (que es quien lo resuelve desde la URL).
 */
export async function getActiveProducts(
  db: D1Database,
  collection: string,
  opts: { category?: string | undefined; sort?: SortOption | undefined; search?: string | undefined } = {},
  readMode: CatalogReadMode = 'shadow',
): Promise<ProductRow[]> {
  return [...await createCatalogReader(db, readMode).listActive(collection, opts)];
}

/**
 * Ficha de producto DENTRO de su colección.
 *
 * El slug es único global (ver migración 0002), así que la colección no hace
 * falta para encontrarlo — pero sí para que `/demo/tiendas/street/aove-picual`
 * sea un 404 en vez de enseñar el producto de otra tienda bajo la URL de Street.
 */
export async function getProductBySlug(
  db: D1Database,
  collection: string,
  slug: string,
  readMode: CatalogReadMode = 'shadow',
): Promise<ProductRow | null> {
  return createCatalogReader(db, readMode).findActive(collection, slug);
}

/**
 * Lee varios productos por slug (para revalidar carritos). Devuelve solo los activos.
 *
 * Deliberadamente AGNÓSTICO de colección: el slug es la clave del carrito y del
 * checkout, y es única global. Meter la colección aquí obligaría a propagarla a
 * `cart-client.ts`, a `/api/cart/quote` y a `/api/checkout/session` — es decir, a
 * bifurcar la ruta de cobro, que es lo único que esta arquitectura no permite.
 */
export async function getProductsBySlugs(
  db: D1Database,
  slugs: string[],
  readMode: CatalogReadMode = 'shadow',
): Promise<ProductRow[]> {
  return [...await createCatalogReader(db, readMode).findActiveBySlugs(slugs)];
}

/**
 * Mapa slug → id de producto para el snapshot de líneas del pedido (y el
 * decremento de stock posterior). Sin filtrar por `active`: el checkout ya
 * revalidó la compra contra `getProductsBySlugs`, y un producto despublicado
 * entre ambas lecturas no debe perder su id en el pedido.
 */
export async function getProductIdsBySlugs(db: D1Database, slugs: readonly string[]): Promise<Map<string, number>> {
  if (slugs.length === 0) return new Map();
  const placeholders = slugs.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT id, slug FROM products WHERE slug IN (${placeholders})`)
    .bind(...slugs)
    .all<{ id: number; slug: string }>();
  return new Map(results.map((row) => [row.slug, row.id]));
}

export async function getRateForZone(db: D1Database, zone: string): Promise<ShippingRateRow | null> {
  return await db
    .prepare('SELECT * FROM shipping_rates WHERE zone = ? AND active = 1 ORDER BY price_cents LIMIT 1')
    .bind(zone)
    .first<ShippingRateRow>();
}
