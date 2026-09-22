import type { Product } from './demo-types';

/** Display data only. Quotes, checkout, feeds and administration read D1 directly. */
export const PUBLIC_CATALOG_TTL_MS = 60_000;
const MAX_ENTRIES = 128;
const MAX_BYTES = 4 * 1024 * 1024;
const CATALOG_KEY = 'catalog';
type Entry = { value?: Product[]; expiresAt: number; bytes: number; pending?: Promise<Product[]> };
type Store = { entries: Map<string, Entry>; bytes: number };
const stores = new WeakMap<D1Database, Store>();

function storeFor(db: D1Database): Store {
  let store = stores.get(db);
  if (!store) { store = { entries: new Map(), bytes: 0 }; stores.set(db, store); }
  return store;
}

function remove(store: Store, key: string): void {
  const entry = store.entries.get(key);
  if (entry) { store.bytes -= entry.bytes; store.entries.delete(key); }
}

function fresh(store: Store, key: string): Product[] | undefined {
  const entry = store.entries.get(key);
  if (entry?.value && entry.expiresAt > Date.now()) return entry.value;
  if (entry && !entry.pending) remove(store, key);
  return undefined;
}

const copy = (products: Product[]): Product[] => products.map(product => ({ ...product }));

async function read(db: D1Database, key: string, query: () => Promise<Product[]>): Promise<Product[]> {
  const store = storeFor(db);
  const cached = fresh(store, key);
  if (cached) return copy(cached);
  const pending = store.entries.get(key)?.pending;
  if (pending) return copy(await pending);
  // Includes in-flight keys and negative lookups: arbitrary slugs cannot grow memory forever.
  while (store.entries.size >= MAX_ENTRIES) remove(store, store.entries.keys().next().value!);
  const entry: Entry = { expiresAt: 0, bytes: 0 };
  store.entries.set(key, entry);
  entry.pending = query().then(products => {
    const bytes = JSON.stringify(products).length * 2;
    // Invalidating during a read must not let its older response repopulate the cache.
    if (store.entries.get(key) === entry) {
      if (bytes > MAX_BYTES) remove(store, key);
      else {
        entry.value = products;
        entry.bytes = bytes;
        entry.expiresAt = Date.now() + PUBLIC_CATALOG_TTL_MS;
        store.bytes += bytes;
        while (store.bytes > MAX_BYTES) remove(store, store.entries.keys().next().value!);
      }
    }
    return products;
  }).catch(error => {
    if (store.entries.get(key) === entry) remove(store, key);
    throw error;
  }).finally(() => { delete entry.pending; });
  return copy(await entry.pending);
}

/** Clears only the current isolate; another isolate expires its display data within 60 seconds. */
export function invalidatePublicCatalog(db: D1Database): void {
  const store = stores.get(db);
  if (store) { store.entries.clear(); store.bytes = 0; }
}

export function getPublicProducts(db: D1Database): Promise<Product[]> {
  return read(db, CATALOG_KEY, async () =>
    (await db.prepare('SELECT * FROM products WHERE active=1 ORDER BY id').all<Product>()).results);
}

export async function getPublicProduct(db: D1Database, slug: string): Promise<Product | null> {
  const catalog = fresh(storeFor(db), CATALOG_KEY);
  if (catalog) {
    const product = catalog.find(item => item.slug === slug);
    return product ? { ...product } : null;
  }
  const products = await read(db, `product:${slug}`, async () => {
    const product = await db.prepare('SELECT * FROM products WHERE slug=? AND active=1').bind(slug).first<Product>();
    return product ? [product] : [];
  });
  return products[0] ?? null;
}

export async function getRelatedPublicProducts(db: D1Database, product: Product): Promise<Product[]> {
  const catalog = fresh(storeFor(db), CATALOG_KEY);
  if (catalog) return copy(catalog.filter(item => item.category === product.category && item.slug !== product.slug).slice(0, 4));
  return read(db, `related:${JSON.stringify([product.category, product.slug])}`, async () =>
    // The existing category index selects a small range; rowid preserves the previous ID order.
    (await db.prepare('SELECT * FROM products INDEXED BY idx_products_category WHERE category=? AND active=1 AND slug<>? ORDER BY id LIMIT 4')
      .bind(product.category, product.slug).all<Product>()).results);
}
