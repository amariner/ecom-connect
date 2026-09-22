import {describe,it,expect} from 'vitest';
import {queryCatalog,catalogPagePath} from '../src/components/shop/catalog-query';
import {categoryMatches} from '../src/components/shop/catalog';
import type {Product} from '../src/lib/demo-types';
const items=Array.from({length:65},(_,i)=>({id:i+1,slug:`product-${i}`,name:`Producto ${i}`,category:i%2?'facial':'bebe',source_categories:JSON.stringify(i%2?['facial','fh-326']:['bebe','fh-97']),active:1,stock:24,brand:i%2?'Marca A':'Marca B',price_cents:100+i,compare_at_price_cents:null,description:'',image:'',sku:`SKU-${i}`,supplier_sku:'',ean:'',vat:21,last_synced_at:null}) satisfies Product);
describe('catalog browsing',()=>{
 it('paginates without overlap and clamps invalid pages',()=>{
  const first=queryCatalog(items,new URLSearchParams());const second=queryCatalog(items,new URLSearchParams('pagina=2'));
  expect(first.products).toHaveLength(24);expect(second.products).toHaveLength(24);
  expect(first.products.some(p=>second.products.includes(p))).toBe(false);
  expect(queryCatalog(items,new URLSearchParams('pagina=999')).page).toBe(3);
  expect(queryCatalog(items,new URLSearchParams('pagina=-1')).page).toBe(1);
 });
 it('combines real subcategories, brand, search and stable price sorting',()=>{
  const found=queryCatalog(items,new URLSearchParams('categoria=fh-326&marca=Marca+A&orden=precio-desc'));
  expect(found.total).toBe(32);expect(found.products[0]?.price_cents).toBe(163);
  expect(queryCatalog(items,new URLSearchParams('categoria=fh-326&q=Producto+63')).total).toBe(1);
  expect(queryCatalog(items,new URLSearchParams('categoria=no-existe')).total).toBe(0);
 });
 it('preserves filters when paging and tolerates legacy or malformed category metadata',()=>{
  expect(catalogPagePath(new URLSearchParams('categoria=fh-326&marca=Marca+A'),2)).toBe('/tienda?categoria=fh-326&marca=Marca+A&pagina=2');
  expect(categoryMatches({category:'facial'},'facial')).toBe(true);
  expect(categoryMatches({category:'facial',source_categories:'invalid'},'fh-326')).toBe(false);
 });
});
