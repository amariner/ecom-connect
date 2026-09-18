import {
  escapeCatalogSearch,
  type CatalogQuery,
  type CatalogSortOption,
  type LegacyCatalogReader,
  type StorefrontProductRow,
} from '../application/catalog-reader';

const LEGACY_SORT_SQL: Readonly<Record<CatalogSortOption, string>> = {
  featured: 'category, id',
  'price-asc': 'price_cents ASC, name',
  'price-desc': 'price_cents DESC, name',
  name: 'name COLLATE NOCASE',
};

function listQuery(query: CatalogQuery): Readonly<{ sql: string; params: string[] }> {
  const conditions = ['active = 1', 'collection = ?'];
  const params: string[] = [];
  if (query.category) {
    conditions.push('category = ?');
    params.push(query.category);
  }
  if (query.search) {
    const escaped = escapeCatalogSearch(query.search);
    conditions.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`);
  }
  const sort = LEGACY_SORT_SQL[query.sort ?? 'featured'];
  return {
    sql: `SELECT * FROM products WHERE ${conditions.join(' AND ')} ORDER BY ${sort}`,
    params,
  };
}

export function createD1LegacyCatalogReader(db: D1Database): LegacyCatalogReader {
  return {
    async listActive(collection, query = {}) {
      const built = listQuery(query);
      const { results } = await db
        .prepare(built.sql)
        .bind(collection, ...built.params)
        .all<StorefrontProductRow>();
      return results;
    },
    findActive(collection, slug) {
      return db
        .prepare('SELECT * FROM products WHERE slug = ? AND collection = ? AND active = 1')
        .bind(slug, collection)
        .first<StorefrontProductRow>();
    },
    async findActiveBySlugs(slugs) {
      if (slugs.length === 0) return [];
      const placeholders = slugs.map(() => '?').join(',');
      const { results } = await db
        .prepare(`SELECT * FROM products WHERE slug IN (${placeholders}) AND active = 1`)
        .bind(...slugs)
        .all<StorefrontProductRow>();
      return results;
    },
  };
}
