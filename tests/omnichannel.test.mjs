import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertDemo, assertSameOrigin, createDemoOrder, dispatchOrder, advanceOrder,
  feedProducts, getConfirmation, getOrderDetail, getProducts, getState,
  performAction, processPendingOrders, renderFeedXml, syncSupplier,upsertSupplierProduct,
} from '../src/lib/demo';

/** Ejecuta el SQL real en SQLite; batch tiene la misma atomicidad que D1. */
function d1Adapter(sqlite) {
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql,values); }
    runSync() {
      const result = sqlite.prepare(this.sql).run(...this.values);
      return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)},results:[]};
    }
    async run() { return this.runSync(); }
    async all() { return {success:true,results:sqlite.prepare(this.sql).all(...this.values),meta:{}}; }
    async first(column) {
      const row = sqlite.prepare(this.sql).get(...this.values);
      return row ? column ? row[column] : row : null;
    }
  }
  const adapter = {
    prepare(sql) { return new Statement(sql); },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = statements.map((statement) => statement.runSync()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return adapter;
}

let sqlite;
let db;
const customer = {name:'Laura Demo',email:'laura@example.test',street:'Calle Ficticia 10',city:'Castellón',postal_code:'12001'};
function checkout(qty = 2) { return {lines:[{slug:'champu-demo',qty}],customer,idempotency_key:crypto.randomUUID()}; }
beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../migrations/',import.meta.url)).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
  }
  sqlite.exec(`INSERT INTO supplier_products(code,slug,name,description,price_cents,pvp_cents,brand,category,image,ean,sku,stock)
    VALUES ('SUP-001','champu-demo','Champú & cuidado','Producto <ficticio>',1290,1590,'Dermocare','capilar','/images/demo.svg','2000000000008','FH-001',18);
    INSERT INTO shipping_rates(zone,label,price_cents,free_over_cents) VALUES ('peninsula','Envío demo',490,4900);`);
  db = d1Adapter(sqlite);
  await syncSupplier(db);
});
afterEach(() => { sqlite.close(); });

describe('demo safety and feed',() => {
  it('fails closed unless both flags and a matching Origin are present',() => {
    expect(() => assertDemo({DEMO_MODE:'true'})).toThrow();
    expect(() => assertDemo({DEMO_MODE:'false',OMNICHANNEL_DEMO:'true'})).toThrow();
    expect(() => assertDemo({DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'})).not.toThrow();
    expect(() => assertSameOrigin(new Request('https://demo.test/api/demo/action',{method:'POST'}))).toThrow();
    expect(() => assertSameOrigin(new Request('https://demo.test/api/demo/action',{method:'POST',headers:{Origin:'https://evil.test'}}))).toThrow();
    expect(() => assertSameOrigin(new Request('https://demo.test/api/demo/action',{method:'POST',headers:{Origin:'https://demo.test'}}))).not.toThrow();
  });
  it('publishes absolute URLs, availability and escaped Google-style fields',async () => {
    const products = await feedProducts(db,'https://demo.test');
    expect(products[0]).toMatchObject({link:'https://demo.test/tienda/champu-demo',image_link:'https://demo.test/images/demo.svg',price:'12.90 EUR',availability:'in_stock'});
    const xml = renderFeedXml(products,'https://demo.test');
    expect(xml).toContain('Champú &amp; cuidado');
    expect(xml).toContain('&lt;ficticio&gt;');
    expect(xml).toContain('<g:gtin>2000000000008</g:gtin>');
  });
});

describe('persistent omnichannel commerce',() => {
  it('records a sync collision as an error without claiming an update',async () => {
    sqlite.exec("UPDATE products SET supplier_sku='LOCAL-OTHER' WHERE slug='champu-demo'");
    const log = vi.spyOn(console,'error').mockImplementation(() => {});
    try {
      expect(await syncSupplier(db)).toMatchObject({processed:1,updated:0,errors:1});
      expect((await getState(db,'https://demo.test')).integrations.supplier.errors).toBe(1);
    } finally { log.mockRestore(); }
  });
  it('confirms the paid checkout when immediate dispatch encounters insufficient supplier stock',async () => {
    await performAction(db,{action:'settings',dispatch_mode:'immediate'},'https://demo.test');
    sqlite.exec('UPDATE supplier_products SET stock=0');
    const placed = await createDemoOrder(db,checkout());
    expect(placed.supplier_warning).toContain('stock suficiente');
    expect((await getOrderDetail(db,placed.order_id)).order).toMatchObject({status:'paid',supplier_status:'ERROR'});
    expect((await getProducts(db))[0]?.stock).toBe(16);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get()?.n).toBe(0);
  });
  it('imports new supplier references and keeps inactive items in the panel only',async () => {
    await upsertSupplierProduct(db,{code:'SUP-002',slug:'gel-demo',name:'Gel de demo',description:'Gel ficticio para demostración',
      price_cents:650,pvp_cents:790,brand:'Demo',category:'higiene',image:'/images/demo.svg',ean:'2000000000015',sku:'FH-002',stock:9});
    expect((await syncSupplier(db)).errors).toBe(0);
    expect((await getProducts(db)).find((product) => product.slug === 'gel-demo')).toMatchObject({stock:9,price_cents:650});
    await upsertSupplierProduct(db,{code:'SUP-002',active:0});
    await syncSupplier(db);
    expect((await getProducts(db)).some((product) => product.slug === 'gel-demo')).toBe(false);
    expect((await getState(db,'https://demo.test')).products.find((product) => product.slug === 'gel-demo')?.active).toBe(0);
  });
  it('reuses quote, order snapshots and stock ledger without accepting client prices',async () => {
    const input = checkout();
    const placed = await createDemoOrder(db,input,'AMAZON');
    const detail = await getOrderDetail(db,placed.order_id);
    expect(detail.order).toMatchObject({channel:'AMAZON',status:'paid',supplier_status:'PENDING_SUPPLIER',total_cents:3070});
    expect(detail.items[0]).toMatchObject({unit_price_cents:1290,qty:2});
    expect((await getProducts(db))[0]?.stock).toBe(16);
    expect(sqlite.prepare('SELECT on_hand FROM inventory_balances').get()?.on_hand).toBe(16);
    const again = await createDemoOrder(db,input,'AMAZON');
    expect(again.order_id).toBe(placed.order_id);
    expect((await getProducts(db))[0]?.stock).toBe(16);
    const session = new URL(placed.url,'https://demo.test').searchParams.get('session');
    expect(await getConfirmation(db,session)).toMatchObject({order_number:placed.order_number,status:'paid'});
    await expect(createDemoOrder(db,{...input,lines:[{slug:'champu-demo',qty:3}]},'AMAZON')).rejects.toThrow('otro pedido');
  });
  it('deduplicates concurrent checkout attempts and prevents overselling',async () => {
    const input = checkout(17);
    const results = await Promise.all([createDemoOrder(db,input),createDemoOrder(db,input)]);
    expect(new Set(results.map((result) => result.order_id)).size).toBe(1);
    expect((await getProducts(db))[0]?.stock).toBe(1);
    const racing = await Promise.allSettled([createDemoOrder(db,checkout(1)),createDemoOrder(db,checkout(1))]);
    expect(racing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await getProducts(db))[0]?.stock).toBe(0);
    expect(sqlite.prepare("SELECT count(*) n FROM orders WHERE status='paid'").get()?.n).toBe(2);
    const pending = sqlite.prepare("SELECT stripe_session_id FROM orders WHERE status='pending'").get();
    expect(pending).toBeTruthy();
    await expect(getConfirmation(db,pending.stripe_session_id)).rejects.toThrow('Confirmación no encontrada');
  });
  it('keeps local commitments through sync and sends each order to the supplier once',async () => {
    const order = await createDemoOrder(db,checkout());
    await syncSupplier(db);
    expect((await getProducts(db))[0]?.stock).toBe(16);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get()?.stock).toBe(18);
    await Promise.all([dispatchOrder(db,order.order_id),dispatchOrder(db,order.order_id)]);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get()?.stock).toBe(16);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get()?.n).toBe(1);
    await syncSupplier(db);
    expect((await getProducts(db))[0]?.stock).toBe(16);
    await advanceOrder(db,order.order_id,'partial');
    expect((await getOrderDetail(db,order.order_id)).order.supplier_status).toBe('SUPPLIER_PARTIAL');
    await Promise.all([advanceOrder(db,order.order_id,'processing'),advanceOrder(db,order.order_id,'shipped')]);
    const shipped = (await getOrderDetail(db,order.order_id)).order;
    expect(shipped.status).toBe('shipped');
    expect(shipped.tracking_number).toMatch(/^DEMO-/);
  });
  it('demonstrates grouped and immediate dispatch and a supplier stock change',async () => {
    const grouped = await createDemoOrder(db,checkout(1));
    expect((await getOrderDetail(db,grouped.order_id)).order.supplier_order_id).toBeNull();
    expect(await processPendingOrders(db)).toEqual({processed:1,errors:0});
    await performAction(db,{action:'settings',dispatch_mode:'immediate'},'https://demo.test');
    const immediate = await createDemoOrder(db,checkout(1),'MIRAVIA');
    expect((await getOrderDetail(db,immediate.order_id)).order.supplier_order_id).toMatch(/^PED-ERP-/);
    await performAction(db,{action:'simulate-stock',slug:'champu-demo',stock:7},'https://demo.test');
    expect((await getProducts(db))[0]?.stock).toBe(16);
    await performAction(db,{action:'sync'},'https://demo.test');
    expect((await getProducts(db))[0]?.stock).toBe(7);
    const state = await getState(db,'https://demo.test');
    expect(state.marketplaces).toHaveLength(4);
    expect(state.integrations.lighthouse.published).toBe(1);
    expect(state.settings.dispatch_mode).toBe('immediate');
  });
});
