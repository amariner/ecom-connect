import type { CatalogSelection } from './catalog-selection';
export function selectionAllows(selections:CatalogSelection[],scope:string,code:string):boolean {
  const selection=selections.find(s=>s.scope===scope);
  return !selection?.codes || selection.codes.includes(code);
}
