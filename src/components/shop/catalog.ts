import taxonomy from '../../data/catalog-taxonomy.json';
export const categories = taxonomy;
export const subcategories = taxonomy.flatMap(group => group.children.map(child => ({...child,parent:group.id})));
export const euros = (value: number) => new Intl.NumberFormat('es-ES', {style:'currency',currency:'EUR'}).format(value / 100);
export const categoryName = (id: string) => categories.find(category => category.id === id)?.name ?? subcategories.find(category => category.id === id)?.name ?? id;
export function categoryMatches(product: {category: string;source_categories?: string}, id: string): boolean {
  if (!id || product.category === id) return true;
  try { const source: unknown = JSON.parse(product.source_categories || '[]'); return Array.isArray(source) && source.includes(id); }
  catch { return false; }
}

export const homeCategories = [...categories, ...['fh-187','fh-252','fh-23','fh-19','fh-340','fh-45'].map(id=>{
  const child=subcategories.find(item=>item.id===id)!;
  const parent=categories.find(item=>item.id===child.parent)!;
  return {...parent,id:child.id,name:child.name,short:child.name};
})];
