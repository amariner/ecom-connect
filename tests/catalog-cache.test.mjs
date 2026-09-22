import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { d1Adapter, hookedD1, migratedDatabase } from './helpers/d1.mjs';
import { getProduct } from '../src/lib/demo';
import { getPublicProduct, getPublicProducts, getRelatedPublicProducts, invalidatePublicCatalog, PUBLIC_CATALOG_TTL_MS } from '../src/lib/catalog-cache';

let sqlite, db, queries;
beforeEach(() => {
  sqlite = migratedDatabase();
  const insert = sqlite.prepare('INSERT INTO products(slug,name,price_cents,stock,category,active) VALUES (?,?,1000,20,?,?)');
  for (let index = 0; index < 12; index++) insert.run(`facial-${index}`, `Producto ${index}`, 'facial', index === 2 ? 0 : 1);
  for (let index = 0; index < 500; index++) insert.run(`other-${index}`, `Otro producto ${index}`, 'capilar', 1);
  queries = [];
  const adapter = d1Adapter(sqlite);
  db = { ...adapter, prepare(sql) { queries.push(sql); return adapter.prepare(sql); } };
});
afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

describe('public catalog read cache', () => {
  it('shares concurrent and repeated public reads without exposing inactive products', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => getPublicProducts(db)));
    expect(queries).toHaveLength(1);
    expect(results[0]).toHaveLength(511);
    expect(results.every(products => products.every(product => product.active === 1))).toBe(true);
    const product = await getPublicProduct(db, 'facial-0');
    expect(await getPublicProduct(db, 'facial-2')).toBeNull();
    expect(await getPublicProduct(db, 'missing')).toBeNull();
    expect((await getRelatedPublicProducts(db, product)).map(item => item.slug)).toEqual(['facial-1', 'facial-3', 'facial-4', 'facial-5']);
    expect(queries).toHaveLength(1);
  });

  it('returns defensive copies and expires display data after 60 seconds', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const initial = await getPublicProducts(db);
    initial[0].price_cents = 1;
    initial.pop();
    sqlite.exec("UPDATE products SET price_cents=2000,stock=9 WHERE slug='facial-0'");
    now += PUBLIC_CATALOG_TTL_MS - 1;
    expect((await getPublicProducts(db))[0]).toMatchObject({ price_cents: 1000, stock: 20 });
    expect(await getPublicProducts(db)).toHaveLength(511);
    expect(queries).toHaveLength(1);
    now += 1;
    expect((await getPublicProducts(db))[0]).toMatchObject({ price_cents: 2000, stock: 9 });
    expect(queries).toHaveLength(2);
  });

  it('keeps uncached operational reads current and invalidates cached display data immediately', async () => {
    await getPublicProducts(db);
    sqlite.exec("UPDATE products SET price_cents=2000,stock=3 WHERE slug='facial-0'");
    expect(await getPublicProduct(db, 'facial-0')).toMatchObject({ price_cents: 1000, stock: 20 });
    expect(await getProduct(db, 'facial-0')).toMatchObject({ price_cents: 2000, stock: 3 });
    invalidatePublicCatalog(db);
    expect(await getPublicProduct(db, 'facial-0')).toMatchObject({ price_cents: 2000, stock: 3 });
  });

  it('uses two indexed queries for a cold detail instead of reading the whole catalog', async () => {
    const product = await getPublicProduct(db, 'facial-0');
    expect((await getRelatedPublicProducts(db, product)).map(item => item.slug)).toEqual(['facial-1', 'facial-3', 'facial-4', 'facial-5']);
    expect(queries).toHaveLength(2);
    const detailPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all('facial-0');
    const relatedPlan = sqlite.prepare(`EXPLAIN QUERY PLAN ${queries[1]}`).all('facial', 'facial-0');
    expect(detailPlan.some(row => /SEARCH products USING INDEX/.test(row.detail))).toBe(true);
    expect(relatedPlan.some(row => /SEARCH products USING INDEX idx_products_category/.test(row.detail))).toBe(true);
    expect(relatedPlan.every(row => !/TEMP B-TREE/.test(row.detail))).toBe(true);
    await getPublicProduct(db, 'facial-0');
    await getRelatedPublicProducts(db, product);
    expect(queries).toHaveLength(2);
  });

  it('isolates different database bindings and caches negative lookups', async () => {
    expect(await getPublicProduct(db, 'missing')).toBeNull();
    expect(await getPublicProduct(db, 'missing')).toBeNull();
    expect(queries).toHaveLength(1);
    await getPublicProducts(db);
    sqlite.exec("UPDATE products SET price_cents=3000 WHERE slug='facial-0'");
    const otherBinding = d1Adapter(sqlite);
    expect(await getPublicProduct(otherBinding, 'facial-0')).toMatchObject({ price_cents: 3000 });
    expect(await getPublicProduct(db, 'facial-0')).toMatchObject({ price_cents: 1000 });
  });

  it('does not repopulate an invalidated cache from an older in-flight read', async () => {
    const hooked = hookedD1(sqlite);
    let release, reached;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { reached = resolve; });
    hooked.on(/SELECT \* FROM products WHERE active=1/, async () => { reached(); await gate; }, 'after');
    const oldRead = getPublicProducts(hooked.db);
    await started;
    sqlite.exec("UPDATE products SET price_cents=4000 WHERE slug='facial-0'");
    invalidatePublicCatalog(hooked.db);
    expect((await getPublicProducts(hooked.db))[0].price_cents).toBe(4000);
    release();
    expect((await oldRead)[0].price_cents).toBe(1000);
    expect((await getPublicProducts(hooked.db))[0].price_cents).toBe(4000);
  });

  it('bounds retained slug entries and retries a failed read instead of caching the error', async () => {
    for (let index = 0; index < 129; index++) await getPublicProduct(db, `missing-${index}`);
    expect(queries).toHaveLength(129);
    await getPublicProduct(db, 'missing-128');
    expect(queries).toHaveLength(129);
    await getPublicProduct(db, 'missing-0');
    expect(queries).toHaveLength(130);
    const adapter = d1Adapter(sqlite);
    let attempts = 0;
    const flaky = { ...adapter, prepare(sql) { if (++attempts === 1) throw new Error('D1 unavailable'); return adapter.prepare(sql); } };
    await expect(getPublicProducts(flaky)).rejects.toThrow('D1 unavailable');
    expect(await getPublicProducts(flaky)).toHaveLength(511);
    expect(attempts).toBe(2);
  });

  it('does not retain a catalog larger than the memory budget', async () => {
    sqlite.prepare("UPDATE products SET description=? WHERE slug='facial-0'").run('x'.repeat(2 * 1024 * 1024));
    await getPublicProducts(db);
    await getPublicProducts(db);
    expect(queries).toHaveLength(2);
  });
});
