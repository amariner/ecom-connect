import { describe, expect, it } from 'vitest';
import { matchesProductFilters, productListPath, readProductFilters, type ProductFilters } from '../src/components/admin/product-filters';

const empty: ProductFilters = { q: '', category: '', state: '', stock: '' };
const product = { name: 'Champú de bebé', sku: 'FH-001', supplier_sku: 'PRV-001', ean: '843000000001', brand: 'Farma Demo', category: 'bebe', active: 1, stock: 3 };

describe('administrative product filter combinations', () => {
  it('combines search, category, visibility and stock without hiding inactive products by default', () => {
    expect(matchesProductFilters({ ...product, active: 0 }, empty)).toBe(true);
    expect(matchesProductFilters({ ...product, active: 0 }, { q: 'CHAMPU', category: 'bebe', state: 'inactivo', stock: 'bajo' })).toBe(true);
    expect(matchesProductFilters({ ...product, active: 0 }, { ...empty, state: 'activo' })).toBe(false);
    expect(matchesProductFilters(product, { ...empty, state: 'inactivo' })).toBe(false);
    expect(matchesProductFilters(product, { ...empty, category: 'facial' })).toBe(false);
  });

  it.each([['CHAMPU',true],['BEBÉ',true],['prv-001',true],['843000',true],['farma demo',true],['%_',false]])('searches names and product references literally (%s)', (q, expected) => {
    expect(matchesProductFilters(product, { ...empty, q: String(q) })).toBe(expected);
  });

  it.each([[0,false],[1,true],[5,true],[6,false]])('uses stock 1–5 as low stock, excluding exhausted stock (%i)', (stock, expected) => {
    expect(matchesProductFilters({ ...product, stock: Number(stock) }, { ...empty, stock: 'bajo' })).toBe(expected);
  });

  it('keeps stock and public visibility independent', () => {
    expect(matchesProductFilters({ ...product, active: 0, stock: 9 }, { ...empty, state: 'inactivo', stock: 'con-stock' })).toBe(true);
    expect(matchesProductFilters({ ...product, stock: 0 }, { ...empty, state: 'activo', stock: 'sin-stock' })).toBe(true);
    expect(matchesProductFilters({ ...product, stock: 0 }, { ...empty, stock: 'con-stock' })).toBe(false);
    expect(matchesProductFilters(product, { ...empty, stock: 'sin-stock' })).toBe(false);
  });
});

describe('administrative product filter URL state', () => {
  it('restores all four filters from the URL after reload or returning from a product', () => {
    const filters = { q: 'Champú & bebé + demo', category: 'bebe', state: 'inactivo', stock: 'bajo' };
    const path = productListPath(filters);
    expect(path.startsWith('/admin/productos?')).toBe(true);
    expect(readProductFilters(new URL(path, 'https://demo.test').search, ['bebe', 'facial'])).toEqual(filters);
  });

  it('canonicalizes only supported fields and values, trimming and bounding the search', () => {
    const parsed = readProductFilters('?q=%20Champ%C3%BA%20&categoria=missing&estado=all&stock=negative&return=https://elsewhere.test', ['bebe']);
    expect(parsed).toEqual({ ...empty, q: 'Champú' });
    expect(productListPath(parsed)).toBe('/admin/productos?q=Champ%C3%BA');
    expect(readProductFilters(`?q=${'a'.repeat(130)}`).q).toHaveLength(120);
    expect(productListPath(empty)).toBe('/admin/productos');
  });

  it('retains a category before catalog load and validates it once categories are known', () => {
    expect(readProductFilters('?categoria=dermocosmetica').category).toBe('dermocosmetica');
    expect(readProductFilters('?categoria=dermocosmetica', ['dermocosmetica']).category).toBe('dermocosmetica');
    expect(readProductFilters('?categoria=dermocosmetica', ['bebe']).category).toBe('');
  });

  it('cannot turn an encoded search into a navigation target or additional filter', () => {
    const path = productListPath({ ...empty, q: '/admin/configuracion?estado=inactivo&stock=bajo#test' });
    const url = new URL(path, 'https://demo.test');
    expect(url.pathname).toBe('/admin/productos');
    expect(url.searchParams.get('estado')).toBeNull();
    expect(url.hash).toBe('');
    expect(readProductFilters(url.search).q).toBe('/admin/configuracion?estado=inactivo&stock=bajo#test');
  });
});
