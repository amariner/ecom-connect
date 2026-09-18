import type { CanonicalCatalogRepository, CatalogQuery, CatalogSortOption } from '../application/catalog-reader';
import { escapeCatalogSearch } from '../application/catalog-reader';
import {
  createCatalogEntry,
  type CatalogEntry,
  type ProductOptionSelection,
  type ProductVariant,
  type ProductVariantStatus,
} from '../domain/product';

type ProductRow = Readonly<{
  id: number;
  slug: string;
  name: string;
  description: string;
  stock: number;
  image: string;
  category: string;
  active: number;
  created_at: string;
  collection: string;
  subtitle: string | null;
  specs_json: string | null;
}>;

type VariantOptionRow = Readonly<{
  id: number;
  product_id: number;
  sku: string;
  gtin: string | null;
  mpn: string | null;
  title: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  status: ProductVariantStatus;
  is_default: number;
  option_signature: string | null;
  created_at: string;
  updated_at: string;
  option_id: number | null;
  option_name: string | null;
  option_position: number | null;
  value_id: number | null;
  option_value: string | null;
  value_position: number | null;
}>;

const CANONICAL_SORT_SQL: Readonly<Record<CatalogSortOption, string>> = {
  featured: 'p.category, p.id',
  'price-asc': 'default_variant.price_cents ASC, p.name',
  'price-desc': 'default_variant.price_cents DESC, p.name',
  name: 'p.name COLLATE NOCASE',
};

const ACTIVE_DEFAULT_JOIN = `
  JOIN product_variants default_variant
    ON default_variant.product_id = p.id
   AND default_variant.is_default = 1
   AND default_variant.status = 'active'`;

function productSelect(where: string, orderBy: string): string {
  return `
    SELECT p.id, p.slug, p.name, p.description,
           inventory.on_hand - inventory.reserved AS stock,
           p.image, p.category,
           p.active, p.created_at, p.collection, p.subtitle, p.specs_json
    FROM products p
    ${ACTIVE_DEFAULT_JOIN}
    JOIN inventory_balances inventory ON inventory.variant_id = default_variant.id
    WHERE ${where}
    ORDER BY ${orderBy}`;
}

function variantSelect(placeholders: string): string {
  return `
    SELECT pv.id, pv.product_id, pv.sku, pv.gtin, pv.mpn, pv.title,
           pv.price_cents, pv.compare_at_price_cents, pv.status,
           pv.is_default, pv.option_signature, pv.created_at, pv.updated_at,
           po.id AS option_id, po.name AS option_name,
           po.position AS option_position, pov.id AS value_id,
           pov.value AS option_value, pov.position AS value_position
    FROM product_variants pv
    LEFT JOIN product_variant_option_values pvov ON pvov.variant_id = pv.id
    LEFT JOIN product_options po ON po.id = pvov.option_id
    LEFT JOIN product_option_values pov ON pov.id = pvov.option_value_id
    WHERE pv.product_id IN (${placeholders})
    ORDER BY pv.product_id, pv.is_default DESC, pv.id, po.position, po.id`;
}

function optionFromRow(row: VariantOptionRow): ProductOptionSelection | null {
  if (
    row.option_id === null ||
    row.option_name === null ||
    row.option_position === null ||
    row.value_id === null ||
    row.option_value === null ||
    row.value_position === null
  ) {
    return null;
  }
  return {
    option_id: row.option_id,
    option_name: row.option_name,
    option_position: row.option_position,
    value_id: row.value_id,
    value: row.option_value,
    value_position: row.value_position,
  };
}

async function hydrate(db: D1Database, products: readonly ProductRow[]): Promise<readonly CatalogEntry[]> {
  if (products.length === 0) return [];
  const ids = products.map((product) => product.id);
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db
    .prepare(variantSelect(placeholders))
    .bind(...ids)
    .all<VariantOptionRow>();

  const rowsByVariant = new Map<number, VariantOptionRow[]>();
  for (const row of results) {
    const rows = rowsByVariant.get(row.id) ?? [];
    rows.push(row);
    rowsByVariant.set(row.id, rows);
  }

  const variantsByProduct = new Map<number, ProductVariant[]>();
  for (const rows of rowsByVariant.values()) {
    const row = rows[0];
    if (!row) continue;
    const options = rows.flatMap((candidate) => {
      const option = optionFromRow(candidate);
      return option ? [option] : [];
    });
    const variant: ProductVariant = {
      id: row.id,
      product_id: row.product_id,
      sku: row.sku,
      gtin: row.gtin,
      mpn: row.mpn,
      title: row.title,
      price_cents: row.price_cents,
      compare_at_price_cents: row.compare_at_price_cents,
      status: row.status,
      is_default: row.is_default === 1,
      option_signature: row.option_signature,
      options,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    const variants = variantsByProduct.get(row.product_id) ?? [];
    variants.push(variant);
    variantsByProduct.set(row.product_id, variants);
  }

  return products.map((row) => createCatalogEntry({
    product: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      image: row.image,
      category: row.category,
      collection: row.collection,
      active: row.active === 1,
      subtitle: row.subtitle,
      specs_json: row.specs_json,
      created_at: row.created_at,
    },
    variants: variantsByProduct.get(row.id) ?? [],
    available_stock: row.stock,
  }));
}

export function createD1CatalogRepository(db: D1Database): CanonicalCatalogRepository {
  return {
    async listActive(collection, query: CatalogQuery = {}) {
      const conditions = ['p.active = 1', 'p.collection = ?'];
      const params: string[] = [collection];
      if (query.category) {
        conditions.push('p.category = ?');
        params.push(query.category);
      }
      if (query.search) {
        const escaped = escapeCatalogSearch(query.search);
        conditions.push("(p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')");
        params.push(`%${escaped}%`, `%${escaped}%`);
      }
      const sql = productSelect(conditions.join(' AND '), CANONICAL_SORT_SQL[query.sort ?? 'featured']);
      const { results } = await db.prepare(sql).bind(...params).all<ProductRow>();
      return hydrate(db, results);
    },
    async findActive(collection, slug) {
      const row = await db
        .prepare(productSelect('p.slug = ? AND p.collection = ? AND p.active = 1', 'p.id'))
        .bind(slug, collection)
        .first<ProductRow>();
      if (!row) return null;
      return (await hydrate(db, [row]))[0] ?? null;
    },
    async findActiveBySlugs(slugs) {
      if (slugs.length === 0) return [];
      const placeholders = slugs.map(() => '?').join(',');
      const { results } = await db
        .prepare(productSelect(`p.slug IN (${placeholders}) AND p.active = 1`, 'p.id'))
        .bind(...slugs)
        .all<ProductRow>();
      return hydrate(db, results);
    },
  };
}
