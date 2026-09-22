import type {Product} from '../../lib/demo-types';
import {categoryMatches} from './catalog';
export const CATALOG_PAGE_SIZE=24;
const normalize=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es');
export function queryCatalog(all:Product[],params:URLSearchParams){
 const q=params.get('q')?.trim()||'', category=params.get('categoria')||'',brand=params.get('marca')||'',offers=params.get('ofertas')==='1',order=params.get('orden')||'destacados';
 const filtered=all.filter(p=>p.active&&(!q||normalize(`${p.name} ${p.brand} ${p.sku} ${p.ean} ${p.source_reference||''}`).includes(normalize(q)))&&categoryMatches(p,category)&&(!brand||p.brand===brand)&&(!offers||(p.compare_at_price_cents||0)>p.price_cents));
 filtered.sort((a,b)=>order==='precio-asc'?a.price_cents-b.price_cents||a.id-b.id:order==='precio-desc'?b.price_cents-a.price_cents||a.id-b.id:order==='nombre'?a.name.localeCompare(b.name,'es')||a.id-b.id:Number(Boolean(b.source_url))-Number(Boolean(a.source_url))||a.id-b.id);
 const total=filtered.length,pages=Math.max(1,Math.ceil(total/CATALOG_PAGE_SIZE));
 const input=params.get('pagina')||'1',requested=/^\d+$/.test(input)?Number(input):1;
 const page=Math.min(pages,Math.max(1,Number.isSafeInteger(requested)?requested:1));
 return {products:filtered.slice((page-1)*CATALOG_PAGE_SIZE,page*CATALOG_PAGE_SIZE),total,page,pages,start:total?(page-1)*CATALOG_PAGE_SIZE+1:0,end:Math.min(page*CATALOG_PAGE_SIZE,total)};
}
export function catalogPagePath(params:URLSearchParams,page:number){const next=new URLSearchParams(params);if(page>1)next.set('pagina',String(page));else next.delete('pagina');return `/tienda${next.size?'?'+next:''}`;}
