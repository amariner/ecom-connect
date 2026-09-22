import taxonomy from '../../data/catalog-taxonomy.json';
export const categories = taxonomy;
export const subcategories = taxonomy.flatMap(group => group.children.map(child => ({...child,parent:group.id})));
const currencyFormatter = new Intl.NumberFormat('es-ES', {style:'currency',currency:'EUR'});
export const euros = (value: number) => currencyFormatter.format(value / 100);
export const categoryName = (id: string) => categories.find(category => category.id === id)?.name ?? subcategories.find(category => category.id === id)?.name ?? id;
const categoryCache = new WeakMap<object,{raw:string|undefined;ids:string[]}>();
export function categoryMatches(product: {category: string;source_categories?: string}, id: string): boolean {
  if (!id || product.category === id) return true;
  let cached = categoryCache.get(product);
  if (!cached || cached.raw !== product.source_categories) {
    let ids: string[] = [];
    try { const source: unknown = JSON.parse(product.source_categories || '[]'); if (Array.isArray(source)) ids = source; } catch {}
    cached = {raw:product.source_categories,ids}; categoryCache.set(product,cached);
  }
  return cached.ids.includes(id);
}

export const homeCategories = [...categories, ...['fh-187','fh-252','fh-23','fh-19','fh-340','fh-45'].map(id=>{
  const child=subcategories.find(item=>item.id===id)!;
  const parent=categories.find(item=>item.id===child.parent)!;
  return {...parent,id:child.id,name:child.name,short:child.name};
})];
