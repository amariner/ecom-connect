export const productStates = ['activo', 'inactivo'] as const;
export const productStockLevels = ['con-stock', 'bajo', 'sin-stock'] as const;
export type ProductFilters = { q: string; category: string; state: string; stock: string };
type FilterableProduct = { name: string; sku: string; supplier_sku?: string; ean: string; brand: string; category: string; active: boolean | number; stock: number };
const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es').trim();

export function readProductFilters(search: string, categories?: readonly string[]): ProductFilters {
  const params = new URLSearchParams(search);
  const category = (params.get('categoria') || '').trim().slice(0, 120);
  const state = (params.get('estado') || '').trim();
  const stock = (params.get('stock') || '').trim();
  return {
    q: (params.get('q') || '').trim().slice(0, 120),
    category: !categories || categories.includes(category) ? category : '',
    state: productStates.some(value => value === state) ? state : '',
    stock: productStockLevels.some(value => value === stock) ? stock : '',
  };
}

export function productListPath(filters: ProductFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim().slice(0, 120));
  if (filters.category.trim()) params.set('categoria', filters.category.trim().slice(0, 120));
  if (productStates.some(value => value === filters.state)) params.set('estado', filters.state);
  if (productStockLevels.some(value => value === filters.stock)) params.set('stock', filters.stock);
  return `/admin/productos${params.size ? `?${params}` : ''}`;
}

export function matchesProductFilters(product: FilterableProduct, filters: ProductFilters): boolean {
  if (filters.category && product.category !== filters.category) return false;
  if (filters.state === 'activo' && !product.active) return false;
  if (filters.state === 'inactivo' && product.active) return false;
  if (filters.stock === 'con-stock' && product.stock <= 0) return false;
  if (filters.stock === 'bajo' && (product.stock < 1 || product.stock > 5)) return false;
  if (filters.stock === 'sin-stock' && product.stock > 0) return false;
  const query = normalized(filters.q);
  return !query || [product.name, product.sku, product.supplier_sku || '', product.ean, product.brand].some(value => normalized(value).includes(query));
}
