import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {catalogImportSql} from '../scripts/catalog/import-sql.mjs';
import {d1Adapter} from './helpers/d1.mjs';
import {createDemoOrder,getProduct,syncSupplier} from '../src/lib/demo';
const snapshot=JSON.parse(readFileSync(new URL('../seed/farmahouse-catalog.json',import.meta.url),'utf8'));
let sqlite;
beforeEach(()=>{
 sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
 sqlite.exec("INSERT INTO shipping_rates(zone,label,price_cents,free_over_cents) VALUES ('peninsula','Envío demo',490,4900)");
});
afterEach(()=>sqlite.close());
describe('public catalog import',()=>{
 it('imports at least 500 unique sourced products with balanced demo inventory',()=>{
  expect(snapshot.products.length).toBeGreaterThanOrEqual(500);
  sqlite.exec(catalogImportSql(snapshot.products));
  expect(sqlite.prepare('SELECT COUNT(*) AS total FROM products').get().total).toBe(snapshot.count);
  expect(sqlite.prepare('SELECT COUNT(*) AS total FROM products p JOIN product_variants v ON v.product_id=p.id JOIN inventory_balances b ON b.variant_id=v.id WHERE p.stock=b.on_hand AND p.price_cents=v.price_cents AND p.source_url IS NOT NULL').get().total).toBe(snapshot.count);
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 });
 it('preserves a completed demo purchase, its inventory and provenance when imported again and synchronized',async()=>{
  const sample=snapshot.products[0];const sql=catalogImportSql([sample]);sqlite.exec(sql);
  const db=d1Adapter(sqlite);
  await createDemoOrder(db,{lines:[{slug:sample.slug,qty:1}],customer:{name:'Cliente Demo',email:'catalog@example.test',street:'Calle Ficticia 1',city:'Castellón',postal_code:'12001'},idempotency_key:crypto.randomUUID()});
  const before=await getProduct(db,sample.slug);
  expect(before.stock).toBe(23);
  sqlite.exec(sql);await syncSupplier(db);
  const after=await getProduct(db,sample.slug);
  expect(after.stock).toBe(23);expect(after.source_url).toBe(sample.source_url);
  expect(after.price_cents).toBe(sample.price_cents);
  expect(sqlite.prepare('SELECT COUNT(*) AS total FROM orders').get().total).toBe(1);
  expect(sqlite.prepare("SELECT COUNT(*) AS total FROM inventory_movements WHERE actor_id='public-catalog-demo'").get().total).toBe(1);
 });
 it('synchronizes 650 references with a constant query budget and preserves unchanged inventory on replay',async()=>{
  sqlite.exec(catalogImportSql(snapshot.products));
  sqlite.exec("UPDATE supplier_products SET stock=19,price_cents=price_cents+1 WHERE code NOT IN (SELECT code FROM supplier_catalog_links WHERE linked=0)");
  const base=d1Adapter(sqlite);let statements=0;
  const db={...base,prepare(sql){statements++;return base.prepare(sql);}};
  expect(await syncSupplier(db)).toMatchObject({processed:500,updated:500,errors:0});
  expect(statements).toBeLessThanOrEqual(12);
  expect(sqlite.prepare("SELECT count(*) total FROM products WHERE active=1 AND stock=19").get().total).toBe(500);
  const movements=sqlite.prepare('SELECT count(*) total FROM inventory_movements').get().total;
  expect(await syncSupplier(db)).toMatchObject({processed:500,updated:0,errors:0});
  expect(sqlite.prepare('SELECT count(*) total FROM inventory_movements').get().total).toBe(movements);
  expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 });
 it('rejects duplicate ids, invalid money and untrusted URLs before producing SQL',()=>{
  const p=snapshot.products[0];
  expect(()=>catalogImportSql([p,p])).toThrow(/duplicate/);
  expect(()=>catalogImportSql([{...p,price_cents:2.5}])).toThrow(/price/);
  expect(()=>catalogImportSql([{...p,source_url:'https://example.test/item.html'}])).toThrow(/URL/);
 });
});
