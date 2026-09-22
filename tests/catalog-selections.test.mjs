import {readFileSync} from 'node:fs';
import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {migratedDatabase,d1Adapter} from './helpers/d1.mjs';
import {catalogImportSql} from '../scripts/catalog/import-sql.mjs';
import {selectionCatalog,saveSelection,readSelections} from '../src/lib/catalog-selection';
import {feedProducts,getProduct,syncSupplier,regenerateFeed,performAction} from '../src/lib/demo';
import {POST} from '../src/pages/api/demo/catalog-selection';
const snapshot=JSON.parse(readFileSync(new URL('../seed/farmahouse-catalog.json',import.meta.url),'utf8')).products;
const samples=[snapshot[0],snapshot[1],snapshot.at(-1)];
const code=p=>`DEMO-FH-${p.source_id}`;
let sqlite,db;
beforeEach(()=>{sqlite=migratedDatabase();db=d1Adapter(sqlite);sqlite.exec(catalogImportSql(samples));});
afterEach(()=>sqlite.close());
describe('catalog onboarding and independent product destinations',()=>{
 it('initializes 650 real references with 500 visible and 150 staged, including fresh imports and reimports',async()=>{
  sqlite.exec(catalogImportSql(snapshot));
  const state=await selectionCatalog(db);
  expect(state.products).toHaveLength(650);
  expect(state.products.filter(p=>p.loaded)).toHaveLength(500);
  expect(state.products.filter(p=>!p.linked)).toHaveLength(150);
  sqlite.exec(catalogImportSql(snapshot));
  expect(sqlite.prepare("SELECT count(*) total FROM product_variants WHERE status='active'").get().total).toBe(500);
 });
 it('keeps unlinked products out of normal sync and publishes only after link plus sync, without duplicates',async()=>{
  const pending=samples[2];
  await syncSupplier(db);expect(await getProduct(db,pending.slug)).toBeNull();
  await saveSelection(db,{scope:'supplier',codes:[code(pending)]});
  await saveSelection(db,{scope:'supplier',codes:[code(pending)]});
  expect(await getProduct(db,pending.slug)).toBeNull();
  await syncSupplier(db);
  expect((await getProduct(db,pending.slug)).source_url).toBe(pending.source_url);
  await syncSupplier(db);sqlite.exec(catalogImportSql(samples));
  expect((await getProduct(db,pending.slug)).active).toBe(1);
  expect(sqlite.prepare('SELECT count(*) total FROM products').get().total).toBe(3);
  expect(sqlite.prepare('SELECT count(*) total FROM inventory_movements').get().total).toBe(3);
 });
 it('imports a genuinely new supplier-only reference only after it has been linked',async()=>{
  sqlite.exec("INSERT INTO supplier_products(code,slug,name,description,brand,ean,price_cents,category,image,sku,stock) VALUES ('NEW','new-supplier','Nuevo demo','Descripción demo','Marca demo','8400000000000',1500,'facial','/images/test.png','NEW',5); INSERT INTO supplier_catalog_links VALUES ('NEW',0)");
  await syncSupplier(db);expect(await getProduct(db,'new-supplier')).toBeNull();
  await saveSelection(db,{scope:'supplier',codes:['NEW']});await syncSupplier(db);
  expect((await getProduct(db,'new-supplier')).stock).toBe(5);
 });
 it('keeps feeds independent, persists an empty feed and filters inactive selected products',async()=>{
  await saveSelection(db,{scope:'google',codes:[],revision:0});
  await saveSelection(db,{scope:'meta',codes:[code(samples[1]),code(samples[2])],revision:0});
  expect(await feedProducts(db,'https://demo.test','google')).toHaveLength(0);
  expect(await feedProducts(db,'https://demo.test','meta')).toHaveLength(1);
  expect(await feedProducts(db,'https://demo.test','lighthouse')).toHaveLength(2);
  await saveSelection(db,{scope:'supplier',codes:[code(samples[2])]});await syncSupplier(db);
  expect(await feedProducts(db,'https://demo.test','meta')).toHaveLength(2);
  expect(await feedProducts(db,'https://demo.test','google')).toHaveLength(0);
 });
 it('intersects each marketplace with Lighthouse and rejects orders from excluded products',async()=>{
  await saveSelection(db,{scope:'lighthouse',codes:[code(samples[0])],revision:0});
  await saveSelection(db,{scope:'AMAZON',codes:[code(samples[1])],revision:0});
  await saveSelection(db,{scope:'MIRAVIA',codes:[code(samples[0])],revision:0});
  await regenerateFeed(db,'https://demo.test');
  const rows=sqlite.prepare('SELECT channel,published FROM marketplace_publications').all();
  expect(rows.find(r=>r.channel==='AMAZON').published).toBe(0);
  expect(rows.find(r=>r.channel==='MIRAVIA').published).toBe(1);
  expect(rows.find(r=>r.channel==='EBAY').published).toBe(1);
  await expect(performAction(db,{action:'simulate-order',channel:'AMAZON',slug:samples[0].slug,qty:1},'https://demo.test')).rejects.toThrow(/no está incluido/);
 });
 it('recovers an existing marketplace attempt after its product is removed from that channel',async()=>{
  sqlite.exec("INSERT INTO shipping_rates(zone,label,price_cents,free_over_cents) VALUES ('peninsula','Envío demo',490,4900)");
  const action={action:'simulate-order',channel:'AMAZON',slug:samples[0].slug,qty:1,idempotency_key:crypto.randomUUID()};
  const first=await performAction(db,action,'https://demo.test');
  await saveSelection(db,{scope:'AMAZON',codes:[],revision:0});
  const retry=await performAction(db,action,'https://demo.test');
  expect(retry.order_id).toBe(first.order_id);
  expect(sqlite.prepare('SELECT count(*) total FROM orders').get().total).toBe(1);
 });
 it('rejects unknown codes and scopes, handles replays and protects concurrent edits',async()=>{
  await expect(saveSelection(db,{scope:'google',codes:['UNKNOWN'],revision:0})).rejects.toThrow(/referencias/);
  await expect(saveSelection(db,{scope:'unknown',codes:[],revision:0})).rejects.toThrow();
  const first=await saveSelection(db,{scope:'google',codes:[code(samples[0])],revision:0});
  const replay=await saveSelection(db,{scope:'google',codes:[code(samples[0]),code(samples[0])],revision:0});
  expect(replay.revision).toBe(first.revision);
  await saveSelection(db,{scope:'google',codes:[],revision:1});
  await expect(saveSelection(db,{scope:'google',codes:[code(samples[0])],revision:0})).rejects.toThrow(/otra ventana/);
  expect((await readSelections(db)).find(s=>s.scope==='google').codes).toEqual([]);
 });
 it('guards mutations by demo flags and same-origin, and validates malformed bodies',async()=>{
  const context=(origin='https://demo.test',enabled=true,body={scope:'google',codes:[],revision:0})=>({request:new Request('https://demo.test/api/demo/catalog-selection',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}),locals:{runtime:{env:{DB:db,DEMO_MODE:String(enabled),OMNICHANNEL_DEMO:'true'}}}});
  expect((await POST(context('https://evil.test'))).status).toBe(403);
  expect((await POST(context('https://demo.test',false))).status).toBe(403);
  expect((await POST(context('https://demo.test',true,{scope:'google',codes:[3]}))).status).toBe(400);
  expect((await POST(context())).status).toBe(200);
 });
});
