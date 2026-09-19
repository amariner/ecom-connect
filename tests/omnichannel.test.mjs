import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertDemo, assertSameOrigin, createDemoOrder, dispatchOrder, advanceOrder,
  feedProducts, getConfirmation, getOrderDetail, getOrderList, getProducts, getState, getSupplierStockSnapshot,
  performAction, processPendingOrders, renderFeedXml, simulateSupplierPrice, syncSupplier,syncMarketplaceOrders,upsertSupplierProduct,
} from '../src/lib/demo';
import { MockSupplierAdapter } from '../src/integrations/mock-supplier-adapter';
import { MockLighthouseAdapter } from '../src/integrations/mock-lighthouse-adapter';
import { quoteCart } from '../src/lib/quote';
import { POST as checkoutSession } from '../src/pages/api/checkout/session';
import { GET as listOrders } from '../src/pages/api/demo/orders/index';
import { GET as readStockSnapshot } from '../src/pages/api/demo/stock';
import { POST as demoAction } from '../src/pages/api/demo/action';
import { GET as supplierRead, POST as supplierAction } from '../src/pages/api/supplier/[...path]';

/** Ejecuta el SQL real en SQLite; batch tiene la misma atomicidad que D1. */
function d1Adapter(sqlite) {
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql,values); }
    runSync() {
      const statement = sqlite.prepare(this.sql);
      if (statement.columns().length > 0) return {success:true,meta:{},results:statement.all(...this.values)};
      const result = statement.run(...this.values);
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
  it('recovers the same marketplace action after the last unit is sold and the product becomes inactive',async () => {
    sqlite.exec('UPDATE supplier_products SET stock=1');
    await syncSupplier(db);
    const input = {action:'simulate-order',channel:'AMAZON',slug:'champu-demo',qty:1,idempotency_key:crypto.randomUUID()};
    const submit = async () => {
      const request = new Request('https://demo.test/api/demo/action',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://demo.test'},body:JSON.stringify(input)});
      const response = await demoAction({request,url:new URL(request.url),locals:{runtime:{env:{DB:db,DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'}}}});
      expect(response.status).toBe(200);
      return response.json();
    };
    const first = await submit();
    expect((await getProducts(db))[0].stock).toBe(0);
    await upsertSupplierProduct(db,{code:'SUP-001',active:0});
    await syncSupplier(db);
    expect(await getProducts(db)).toEqual([]);
    const replay = await submit();
    expect(replay).toMatchObject({order_id:first.order_id,order_number:first.order_number,url:first.url});
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({store_stock:0,reserved_units:1,reserved_orders_count:1});
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(1);
    expect(sqlite.prepare('SELECT on_hand FROM inventory_balances').get().on_hand).toBe(0);
  });
  it('recovers the original paid checkout after its stock is exhausted and its catalog data changes',async () => {
    const input = checkout(18);
    const placed = await createDemoOrder(db,input);
    expect((await getProducts(db))[0].stock).toBe(0);
    await upsertSupplierProduct(db,{code:'SUP-001',active:0,price_cents:1490,pvp_cents:1990});
    await syncSupplier(db);
    const request = new Request('https://demo.test/api/checkout/session',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://demo.test'},body:JSON.stringify(input)});
    const response = await checkoutSession({request,url:new URL(request.url),locals:{runtime:{env:{DB:db,DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'}}}});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({order_id:placed.order_id,url:placed.url});
    expect((await getOrderDetail(db,placed.order_id)).order).toMatchObject({status:'paid',total_cents:23220});
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(1);
    expect(sqlite.prepare('SELECT stock FROM products').get().stock).toBe(0);
  });
  it.each([NaN,Infinity,0,-1,1.5,Number.MAX_SAFE_INTEGER+1])('returns not found for an invalid order identifier (%s)',async (id) => {
    await expect(getOrderDetail(db,id)).rejects.toMatchObject({status:404});
  });
  it.each(['WEB','AMAZON'])('keeps the %s purchase confirmed when feed publication fails and safely retries it',async (channel) => {
    const input = checkout();
    const warning = vi.spyOn(console,'warn').mockImplementation(() => {});
    const unavailableFeed = vi.spyOn(MockLighthouseAdapter.prototype,'publish').mockRejectedValue(new Error('Feed unavailable'));
    const submit = async () => {
      if (channel !== 'WEB') return performAction(db,{action:'simulate-order',channel,slug:'champu-demo',qty:2,idempotency_key:input.idempotency_key},'https://demo.test');
      const request = new Request('https://demo.test/api/checkout/session',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://demo.test'},body:JSON.stringify(input)});
      const response = await checkoutSession({request,url:new URL(request.url),locals:{runtime:{env:{DB:db,DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'}}}});
      expect(response.status).toBe(200);
      return response.json();
    };
    let placed;
    try {
      placed = await submit();
      expect(placed.feed_warning).toContain('pedido está confirmado');
      expect((await getOrderDetail(db,placed.order_id)).order.status).toBe('paid');
      expect((await getProducts(db))[0].stock).toBe(16);
    } finally { unavailableFeed.mockRestore(); warning.mockRestore(); }
    const replay = await submit();
    expect(replay.order_id).toBe(placed.order_id);
    expect(replay.feed_warning).toBeUndefined();
    expect((await getProducts(db))[0].stock).toBe(16);
    expect(sqlite.prepare("SELECT count(*) n FROM orders WHERE status='paid'").get().n).toBe(1);
    expect((await getState(db,'https://demo.test')).integrations.lighthouse.published).toBe(1);
  });
  it('does not turn an activity log failure into a failed purchase',async () => {
    const prepare = db.prepare.bind(db);
    const warning = vi.spyOn(console,'warn').mockImplementation(() => {});
    const unavailableActivity = vi.spyOn(db,'prepare').mockImplementation((sql) => {
      if (sql.startsWith('INSERT INTO integration_events')) throw new Error('Activity log unavailable');
      return prepare(sql);
    });
    try {
      const placed = await createDemoOrder(db,checkout());
      expect((await getOrderDetail(db,placed.order_id)).order.status).toBe('paid');
      expect((await getProducts(db))[0].stock).toBe(16);
    } finally { unavailableActivity.mockRestore(); warning.mockRestore(); }
  });
  it('does not return a success confirmation for a cancelled replay',async () => {
    const input = checkout();
    const placed = await createDemoOrder(db,input);
    sqlite.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(placed.order_id);
    await expect(createDemoOrder(db,input)).rejects.toMatchObject({status:409});
  });
  it('preserves order names and prices after the supplier catalog changes',async () => {
    const placed = await createDemoOrder(db,checkout());
    const before = await getOrderDetail(db,placed.order_id);
    await upsertSupplierProduct(db,{code:'SUP-001',name:'Champú actualizado',price_cents:1390,pvp_cents:1790});
    await syncSupplier(db);
    const after = await getOrderDetail(db,placed.order_id);
    expect((await getProducts(db))[0]).toMatchObject({name:'Champú actualizado',price_cents:1390,stock:16});
    expect(after.items).toEqual(before.items);
    expect(after.order.total_cents).toBe(3070);
  });
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
  it('lets the panel change supplier stock for an inactive imported item without publishing or reactivating it',async () => {
    await upsertSupplierProduct(db,{code:'SUP-001',active:0});
    await syncSupplier(db);
    expect((await getState(db,'https://demo.test')).products).toEqual([
      expect.objectContaining({slug:'champu-demo',active:0,stock:18}),
    ]);
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({supplier_active:false,store_active:false});
    const before = sqlite.prepare("SELECT * FROM supplier_products WHERE code='SUP-001'").get();
    expect(await performAction(db,{action:'simulate-stock',slug:'champu-demo',stock:9},'https://demo.test'))
      .toMatchObject({slug:'champu-demo',supplier_stock:9,store_stock:18});
    const after = sqlite.prepare("SELECT * FROM supplier_products WHERE code='SUP-001'").get();
    expect(after).toEqual({...before,stock:9,updated_at:expect.any(String)});
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({
      supplier_stock:9,store_stock:18,supplier_active:false,store_active:false,
    });
    expect(await getProducts(db)).toEqual([]);
    expect(await feedProducts(db,'https://demo.test')).toEqual([]);
    const quote = await quoteCart(db,{lines:checkout().lines,postal_code:customer.postal_code},{catalogReadMode:'legacy'});
    expect(quote.purchasable).toBe(false);
    expect(quote.lines[0].status).toBe('not-found');
    await expect(createDemoOrder(db,checkout())).rejects.toMatchObject({status:409});
    await performAction(db,{action:'sync'},'https://demo.test');
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({
      supplier_stock:9,store_stock:9,supplier_active:false,store_active:false,
    });
    expect((await getState(db,'https://demo.test')).products[0]).toMatchObject({active:0,stock:9});
    expect(await getProducts(db)).toEqual([]);
    expect(await feedProducts(db,'https://demo.test')).toEqual([]);
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(0);
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
    sqlite.prepare("UPDATE orders SET status='pending' WHERE id=?").run(placed.order_id);
    await expect(getConfirmation(db,session)).rejects.toThrow('Confirmación no encontrada');
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
  });
  it('keeps local commitments through sync and sends each order to the supplier once',async () => {
    const order = await createDemoOrder(db,checkout());
    await syncSupplier(db);
    expect((await getProducts(db))[0]?.stock).toBe(16);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get()?.stock).toBe(18);
    await Promise.all([dispatchOrder(db,order.order_id),dispatchOrder(db,order.order_id)]);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get()?.stock).toBe(16);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get()?.n).toBe(1);
    expect(sqlite.prepare("SELECT count(*) n FROM integration_events WHERE kind='supplier' AND title LIKE 'Pedido %'").get()?.n).toBe(1);
    await syncSupplier(db);
    expect((await getProducts(db))[0]?.stock).toBe(16);
    await advanceOrder(db,order.order_id,'partial');
    expect((await getOrderDetail(db,order.order_id)).order.supplier_status).toBe('SUPPLIER_PARTIAL');
    await Promise.all([advanceOrder(db,order.order_id,'processing'),advanceOrder(db,order.order_id,'shipped')]);
    const shipped = (await getOrderDetail(db,order.order_id)).order;
    expect(shipped.status).toBe('shipped');
    expect(shipped.tracking_number).toMatch(/^DEMO-/);
    const trackingEvents = sqlite.prepare("SELECT count(*) n FROM integration_events WHERE kind='tracking'").get().n;
    await advanceOrder(db,order.order_id,'shipped');
    expect(sqlite.prepare("SELECT count(*) n FROM integration_events WHERE kind='tracking'").get().n).toBe(trackingEvents);
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

describe('persisted supplier dispatch policy',() => {
  const setting = mode => performAction(db,{action:'settings',dispatch_mode:mode},'https://demo.test');
  const stored = id => sqlite.prepare('SELECT supplier_dispatch_mode,supplier_stock_committed,supplier_status FROM orders WHERE id=?').get(id);

  it('keeps grouped orders awaiting explicit dispatch after the global setting becomes immediate',async () => {
    const input = checkout();
    const placed = await createDemoOrder(db,input,'AMAZON');
    const hash = sqlite.prepare('SELECT request_hash FROM orders WHERE id=?').get(placed.order_id).request_hash;
    expect(stored(placed.order_id)).toMatchObject({supplier_dispatch_mode:'grouped',supplier_stock_committed:0});
    await setting('immediate');
    expect((await createDemoOrder(db,input,'AMAZON')).order_id).toBe(placed.order_id);
    expect(stored(placed.order_id)).toMatchObject({supplier_dispatch_mode:'grouped',supplier_stock_committed:0,supplier_status:'PENDING_SUPPLIER'});
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(18);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(0);
    expect(sqlite.prepare('SELECT request_hash FROM orders WHERE id=?').get(placed.order_id).request_hash).toBe(hash);
    await dispatchOrder(db,placed.order_id);
    expect(stored(placed.order_id)).toMatchObject({supplier_dispatch_mode:'grouped',supplier_stock_committed:1});
  });

  it('repairs an immediate order after replenishment even when new orders now use grouped dispatch',async () => {
    await setting('immediate');
    sqlite.exec('UPDATE supplier_products SET stock=0');
    const input = checkout();
    const placed = await createDemoOrder(db,input,'MIRAVIA');
    expect(placed.supplier_warning).toContain('stock suficiente');
    expect(stored(placed.order_id)).toMatchObject({supplier_dispatch_mode:'immediate',supplier_stock_committed:0,supplier_status:'ERROR'});
    await setting('grouped');
    sqlite.exec('UPDATE supplier_products SET stock=18');
    const replay = await createDemoOrder(db,input,'MIRAVIA');
    expect(replay).toMatchObject({order_id:placed.order_id});
    expect(replay.supplier_warning).toBeUndefined();
    expect(stored(placed.order_id)).toMatchObject({supplier_dispatch_mode:'immediate',supplier_stock_committed:1,supplier_status:'SUPPLIER_ACCEPTED'});
    await createDemoOrder(db,input,'MIRAVIA');
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(16);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(1);
    const next = await createDemoOrder(db,checkout(1));
    expect(stored(next.order_id)).toMatchObject({supplier_dispatch_mode:'grouped',supplier_stock_committed:0});
  });

  it('recovers an immediate order after a failure between payment and supplier dispatch',async () => {
    await setting('immediate');
    const input = checkout();
    const prepare = db.prepare.bind(db);
    const failBeforeDispatch = vi.spyOn(db,'prepare').mockImplementation(sql => {
      if (sql === 'SELECT * FROM orders WHERE id=?') throw new Error('Dispatch unavailable before transmission');
      return prepare(sql);
    });
    try { await expect(createDemoOrder(db,input)).rejects.toThrow('Dispatch unavailable'); }
    finally { failBeforeDispatch.mockRestore(); }
    const paid = sqlite.prepare('SELECT id,status,supplier_dispatch_mode FROM orders').get();
    expect(paid).toMatchObject({status:'paid',supplier_dispatch_mode:'immediate'});
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(0);
    await setting('grouped');
    const replay = await createDemoOrder(db,input);
    expect(replay.order_id).toBe(paid.id);
    expect(stored(paid.id)).toMatchObject({supplier_dispatch_mode:'immediate',supplier_stock_committed:1});
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(16);
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(1);
  });

  it('captures the setting at the winning insert while concurrent replays retain that policy',async () => {
    const batch = db.batch.bind(db);
    let inserts = 0;
    let releaseInserts;
    const bothInsertsReady = new Promise(resolve => { releaseInserts = resolve; });
    const changeAroundInsert = vi.spyOn(db,'batch').mockImplementation(async statements => {
      if (!statements[0]?.sql.startsWith('INSERT INTO orders (')) return batch(statements);
      const insert = ++inserts;
      if (inserts === 2) releaseInserts();
      await bothInsertsReady;
      sqlite.prepare("INSERT INTO integration_settings(key,value) VALUES ('dispatch_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(insert === 1 ? 'immediate' : 'grouped');
      try { return await batch(statements); }
      finally { sqlite.exec("UPDATE integration_settings SET value='grouped' WHERE key='dispatch_mode'"); }
    });
    const input = checkout();
    let results;
    try { results = await Promise.all([createDemoOrder(db,input),createDemoOrder(db,input)]); }
    finally { changeAroundInsert.mockRestore(); }
    expect(inserts).toBe(2);
    expect(results[0].order_id).toBe(results[1].order_id);
    expect(stored(results[0].order_id)).toMatchObject({supplier_dispatch_mode:'immediate',supplier_stock_committed:1});
    expect(sqlite.prepare("SELECT value FROM integration_settings WHERE key='dispatch_mode'").get().value).toBe('grouped');
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(1);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(1);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(16);
  });

  it('leaves an unknown legacy policy manual and exposes null without leaking internal commitment fields',async () => {
    const input = checkout();
    const placed = await createDemoOrder(db,input);
    sqlite.prepare('UPDATE orders SET supplier_dispatch_mode=NULL WHERE id=?').run(placed.order_id);
    await setting('immediate');
    await createDemoOrder(db,input);
    expect(stored(placed.order_id)).toMatchObject({supplier_dispatch_mode:null,supplier_stock_committed:0});
    const publicDetail = (await getOrderDetail(db,placed.order_id)).order;
    expect(publicDetail.supplier_dispatch_mode).toBeNull();
    expect(publicDetail).not.toHaveProperty('supplier_stock_committed');
    expect((await getState(db,'https://demo.test')).orders[0].supplier_dispatch_mode).toBeNull();
    expect((await getOrderList(db,new URLSearchParams())).orders[0].supplier_dispatch_mode).toBeNull();
    expect((await getConfirmation(db,new URL(placed.url,'https://demo.test').searchParams.get('session'))).supplier_dispatch_mode).toBeNull();
    await dispatchOrder(db,placed.order_id);
    expect(stored(placed.order_id)).toMatchObject({supplier_dispatch_mode:null,supplier_stock_committed:1});
  });

  it('does not reinterpret existing orders when the migration runs under an immediate setting',() => {
    const legacy = new DatabaseSync(':memory:');
    try {
      for (const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(name => name.endsWith('.sql') && name < '0049').sort()) {
        legacy.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
      }
      legacy.exec(`INSERT INTO integration_settings(key,value) VALUES ('dispatch_mode','immediate');
        INSERT INTO orders(order_number,email,customer_name,address_json,subtotal_cents,shipping_cents,total_cents,status,stripe_session_id,request_hash)
        VALUES ('LEGACY','demo@example.test','Cliente Demo','{}',1000,0,1000,'paid','demo_legacy','legacy_hash');`);
      const before = legacy.prepare('SELECT * FROM orders').get();
      legacy.exec(readFileSync(new URL('../migrations/0049_supplier_dispatch_mode.sql',import.meta.url),'utf8'));
      expect(legacy.prepare('SELECT * FROM orders').get()).toEqual({...before,supplier_dispatch_mode:null});
      expect(legacy.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(0);
    } finally { legacy.close(); }
  });

  it.each([['cs_mock','hash'],['demo_import',null]])('does not assign a policy outside a demo checkout (%s)',async (session,hash) => {
    await setting('immediate');
    sqlite.prepare(`INSERT INTO orders(order_number,email,customer_name,address_json,subtotal_cents,shipping_cents,total_cents,status,stripe_session_id,request_hash)
      VALUES ('IMPORT','demo@example.test','Cliente Demo','{}',1000,0,1000,'pending',?,?)`).run(session,hash);
    expect(sqlite.prepare("SELECT supplier_dispatch_mode FROM orders WHERE order_number='IMPORT'").get().supplier_dispatch_mode).toBeNull();
  });

  it('rolls the policy back with a failed order creation and captures the setting of the successful retry',async () => {
    await setting('immediate');
    sqlite.exec("CREATE TRIGGER reject_demo_line BEFORE INSERT ON order_items BEGIN SELECT RAISE(ABORT,'line unavailable'); END;");
    const input = checkout();
    await expect(createDemoOrder(db,input)).rejects.toThrow('line unavailable');
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(0);
    expect(sqlite.prepare('SELECT count(*) n FROM order_events').get().n).toBe(0);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(18);
    sqlite.exec('DROP TRIGGER reject_demo_line');
    await setting('grouped');
    const placed = await createDemoOrder(db,input);
    expect(stored(placed.order_id)).toMatchObject({supplier_dispatch_mode:'grouped',supplier_stock_committed:0});
  });
});

describe('expected checkout quotes',() => {
  async function withQuote(input = checkout()) {
    const quote = await quoteCart(db,{lines:input.lines,postal_code:input.customer.postal_code},{catalogReadMode:'legacy'});
    return {...input,expected_quote:{
      lines:quote.lines.map(({slug,qty,unit_price_cents}) => ({slug,qty,unit_price_cents})),
      subtotal_cents:quote.subtotal_cents,shipping_cents:quote.shipping_cents,total_cents:quote.total_cents,
    }};
  }
  async function submit(input) {
    const request = new Request('https://demo.test/api/checkout/session',{method:'POST',
      headers:{'Content-Type':'application/json',Origin:'https://demo.test'},body:JSON.stringify(input)});
    const response = await checkoutSession({request,url:new URL(request.url),locals:{runtime:{env:{DB:db,DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'}}}});
    return {status:response.status,body:await response.json()};
  }
  async function addSecondProduct() {
    const source = (await new MockSupplierAdapter(db).catalog())[0];
    await upsertSupplierProduct(db,{...source,code:'SUP-002',sku:'FH-002',slug:'acondicionador-demo',name:'Acondicionador demo'});
    await syncSupplier(db);
  }

  it.each(['price','shipping','compensated'])('rejects changed %s with the current breakdown and no database writes',async (change) => {
    const input = await withQuote();
    if (change !== 'shipping') {
      await upsertSupplierProduct(db,{code:'SUP-001',price_cents:1490,pvp_cents:1990});
      await syncSupplier(db);
    }
    if (change === 'shipping') sqlite.exec('UPDATE shipping_rates SET price_cents=990');
    if (change === 'compensated') sqlite.exec('UPDATE shipping_rates SET price_cents=90');
    const writesBefore = sqlite.prepare('SELECT total_changes() n').get().n;
    const result = await submit(input);
    expect(result.status).toBe(409);
    expect(result.body).toEqual({error:expect.stringContaining('han cambiado'),code:'quote_changed',quote:{
      lines:[{slug:'champu-demo',qty:2,unit_price_cents:change === 'shipping' ? 1290 : 1490}],
      subtotal_cents:change === 'shipping' ? 2580 : 2980,
      shipping_cents:change === 'shipping' ? 990 : change === 'compensated' ? 90 : 490,
      total_cents:change === 'shipping' ? 3570 : change === 'compensated' ? 3070 : 3470,
    }});
    if (change === 'compensated') expect(result.body.quote.total_cents).toBe(input.expected_quote.total_cents);
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(0);
    expect(sqlite.prepare('SELECT total_changes() n').get().n).toBe(writesBefore);
    expect((await getProducts(db))[0].stock).toBe(18);
  });

  it('requires review when product prices offset each other without changing any totals',async () => {
    await addSecondProduct();
    const input = await withQuote({...checkout(),lines:[{slug:'champu-demo',qty:1},{slug:'acondicionador-demo',qty:1}]});
    await upsertSupplierProduct(db,{code:'SUP-001',price_cents:1390});
    await upsertSupplierProduct(db,{code:'SUP-002',price_cents:1190});
    await syncSupplier(db);
    const result = await submit(input);
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({code:'quote_changed',quote:{subtotal_cents:2580,shipping_cents:490,total_cents:3070}});
    expect(result.body.quote.lines).toEqual([
      {slug:'acondicionador-demo',qty:1,unit_price_cents:1190},
      {slug:'champu-demo',qty:1,unit_price_cents:1390},
    ]);
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(0);
  });

  it('creates the order only after the changed amount is explicitly resubmitted',async () => {
    const original = await withQuote();
    await upsertSupplierProduct(db,{code:'SUP-001',price_cents:1490,pvp_cents:1990});
    await syncSupplier(db);
    expect((await submit(original)).body.code).toBe('quote_changed');
    const reviewed = await withQuote({...original,idempotency_key:crypto.randomUUID()});
    const result = await submit(reviewed);
    expect(result.status).toBe(200);
    expect(sqlite.prepare('SELECT status,total_cents FROM orders').get()).toMatchObject({status:'paid',total_cents:3470});
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(1);
  });

  it('keeps a timeout retry without a prior order bound to its original visible quote',async () => {
    const frozen = await withQuote();
    // No initial request reached D1; the retry still carries the original expectation.
    await upsertSupplierProduct(db,{code:'SUP-001',price_cents:1990,pvp_cents:2490});
    await syncSupplier(db);
    expect(await submit(frozen)).toMatchObject({status:409,body:{code:'quote_changed',quote:{total_cents:4470}}});
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(0);
  });

  it('recovers a paid order with its original expectation after stock, activity and shipping change',async () => {
    const input = await withQuote(checkout(18));
    const first = await submit(input);
    expect(first.status).toBe(200);
    await upsertSupplierProduct(db,{code:'SUP-001',active:0,price_cents:1990,pvp_cents:2490});
    await syncSupplier(db);
    sqlite.exec('UPDATE shipping_rates SET active=0');
    const replay = await submit(input);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({order_id:first.body.order_id,url:first.body.url});
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(1);
    expect(sqlite.prepare('SELECT total_cents FROM orders').get().total_cents).toBe(23220);
    expect(sqlite.prepare('SELECT stock FROM products').get().stock).toBe(0);
  });

  it('normalizes expected line ordering for comparison and replay identity',async () => {
    await addSecondProduct();
    const input = await withQuote({...checkout(),lines:[{slug:'champu-demo',qty:1},{slug:'acondicionador-demo',qty:1}]});
    const first = await submit(input);
    expect(first.status).toBe(200);
    const replay = await submit({...input,expected_quote:{...input.expected_quote,lines:[...input.expected_quote.lines].reverse()}});
    expect(replay.status).toBe(200);
    expect(replay.body.order_id).toBe(first.body.order_id);
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(1);
  });

  it('treats an altered or removed expectation as a different intent for an existing key',async () => {
    const input = await withQuote();
    expect((await submit(input)).status).toBe(200);
    const changed = await submit({...input,expected_quote:{...input.expected_quote,total_cents:input.expected_quote.total_cents+1}});
    expect(changed).toMatchObject({status:409,body:{error:expect.stringContaining('otro pedido')}});
    expect(changed.body.code).toBeUndefined();
    const {expected_quote,...withoutExpectation} = input;
    expect((await submit(withoutExpectation)).status).toBe(409);
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(1);
  });

  it('does not use fabricated client prices to place an order',async () => {
    const input = await withQuote();
    input.expected_quote={lines:[{slug:'champu-demo',qty:2,unit_price_cents:1}],subtotal_cents:2,shipping_cents:0,total_cents:2};
    expect(await submit(input)).toMatchObject({status:409,body:{code:'quote_changed',quote:{total_cents:3070}}});
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(0);
    expect((await getProducts(db))[0].stock).toBe(18);
  });

  it.each(['negative','fractional','unsafe','missing','duplicate','quantity','empty'])('rejects a malformed %s expectation before writing',async (kind) => {
    const input = await withQuote();
    if (kind === 'negative') input.expected_quote.shipping_cents=-1;
    if (kind === 'fractional') input.expected_quote.total_cents=1.5;
    if (kind === 'unsafe') input.expected_quote.total_cents=Number.MAX_SAFE_INTEGER+1;
    if (kind === 'missing') delete input.expected_quote.subtotal_cents;
    if (kind === 'duplicate') input.expected_quote.lines.push({...input.expected_quote.lines[0]});
    if (kind === 'quantity') input.expected_quote.lines[0].qty=100;
    if (kind === 'empty') input.expected_quote.lines=[];
    const writesBefore = sqlite.prepare('SELECT total_changes() n').get().n;
    expect((await submit(input)).status).toBe(400);
    expect(sqlite.prepare('SELECT total_changes() n').get().n).toBe(writesBefore);
  });

  it.each([{stock:0},{active:0}])('rejects availability changed after the visible quote (%o)',async (patch) => {
    const input = await withQuote();
    await upsertSupplierProduct(db,{code:'SUP-001',...patch});
    await syncSupplier(db);
    const response = await submit(input);
    expect(response.status).toBe(409);
    expect(response.body.code).toBeUndefined();
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(0);
  });

  it('returns a definitive availability conflict if a product disappears between internal reads',async () => {
    const input = await withQuote();
    const original = db.prepare.bind(db);
    const spy = vi.spyOn(db,'prepare').mockImplementation(sql => {
      const statement = original(sql);
      if (!sql.startsWith('SELECT * FROM shipping_rates')) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind=(...values) => {
        const bound = bind(...values),first = bound.first.bind(bound);
        bound.first=async (...columns) => {
          const result = await first(...columns);
          sqlite.exec('UPDATE products SET active=0');
          return result;
        };
        return bound;
      };
      return statement;
    });
    try {
      expect(await submit(input)).toMatchObject({status:409,body:{error:expect.stringContaining('disponibilidad acaba de cambiar')}});
      expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('recovers a concurrently persisted matching attempt even if the subsequent quote differs',async () => {
    const input = await withQuote();
    const paid = await submit(input);
    await upsertSupplierProduct(db,{code:'SUP-001',price_cents:1990,pvp_cents:2490});
    await syncSupplier(db);
    const original = db.prepare.bind(db);
    let initialRead = true;
    const spy = vi.spyOn(db,'prepare').mockImplementation(sql => {
      const statement = original(sql);
      if (!initialRead || sql !== 'SELECT * FROM orders WHERE stripe_session_id=?') return statement;
      initialRead=false;
      // Emulate the first read occurring before another same-key request committed.
      const bind = statement.bind.bind(statement);
      statement.bind=(...values) => {const bound=bind(...values);bound.first=async () => null;return bound;};
      return statement;
    });
    try {
      const replay = await submit(input);
      expect(replay.status).toBe(200);
      expect(replay.body.order_id).toBe(paid.body.order_id);
      expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(1);
      expect(sqlite.prepare('SELECT total_cents FROM orders').get().total_cents).toBe(3070);
    } finally { spy.mockRestore(); }
  });
});

describe('supplier price changes',() => {
  function change(overrides = {}) {
    return {code:'SUP-001',price_cents:1490,pvp_cents:1990,expected_price:{price_cents:1290,pvp_cents:1590},
      idempotency_key:crypto.randomUUID(),...overrides};
  }
  async function submit(input,env = {DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'},origin = 'https://demo.test') {
    const request = new Request('https://demo.test/api/demo/action',{method:'POST',
      headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({action:'simulate-price',...input})});
    const response = await demoAction({request,url:new URL(request.url),locals:{runtime:{env:{DB:db,...env}}}});
    return {status:response.status,body:await response.json()};
  }
  const supplier = () => sqlite.prepare("SELECT * FROM supplier_products WHERE code='SUP-001'").get();
  const priceEvents = () => sqlite.prepare("SELECT count(*) n FROM integration_events WHERE title='Cambio de precio simulado'").get().n;

  it('changes only supplier prices until synchronization while preserving stock and paid snapshots',async () => {
    const placed = await createDemoOrder(db,checkout());
    const balance = sqlite.prepare('SELECT * FROM inventory_balances').get();
    const result = await submit(change());
    expect(result).toEqual({status:200,body:{demo:true,replayed:false,change:{
      code:'SUP-001',before:{price_cents:1290,pvp_cents:1590},after:{price_cents:1490,pvp_cents:1990},
      changed:true,created_at:expect.any(String),
    }}});
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({
      supplier_price_cents:1490,supplier_pvp_cents:1990,store_price_cents:1290,store_pvp_cents:1590,
      supplier_stock:18,store_stock:16,reserved_units:2,
    });
    expect(sqlite.prepare('SELECT * FROM inventory_balances').get()).toEqual(balance);
    expect(sqlite.prepare('SELECT price_cents,compare_at_price_cents FROM product_variants').get())
      .toMatchObject({price_cents:1290,compare_at_price_cents:1590});
    expect((await feedProducts(db,'https://demo.test'))[0].price).toBe('12.90 EUR');
    await performAction(db,{action:'regenerate-feed'},'https://demo.test');
    expect((await feedProducts(db,'https://demo.test'))[0].price).toBe('12.90 EUR');
    await performAction(db,{action:'sync'},'https://demo.test');
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({
      supplier_price_cents:1490,supplier_pvp_cents:1990,store_price_cents:1490,store_pvp_cents:1990,
      supplier_stock:18,store_stock:16,reserved_units:2,
    });
    expect((await feedProducts(db,'https://demo.test'))[0].price).toBe('14.90 EUR');
    expect((await getOrderDetail(db,placed.order_id)).items[0].unit_price_cents).toBe(1290);
    expect(priceEvents()).toBe(1);
  });

  it('deduplicates concurrent identical operations with one receipt and one activity event',async () => {
    const input = change();
    const results = await Promise.all([simulateSupplierPrice(db,input),simulateSupplierPrice(db,input)]);
    expect(results.map(result => result.replayed).sort()).toEqual([false,true]);
    expect(results[0].change).toEqual(results[1].change);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_price_changes').get().n).toBe(1);
    expect(priceEvents()).toBe(1);
    expect(supplier()).toMatchObject({price_cents:1490,pvp_cents:1990,stock:18});
  });

  it('replays the immutable receipt without reverting a newer supplier price or writing again',async () => {
    const original = change();
    const first = await simulateSupplierPrice(db,original);
    await simulateSupplierPrice(db,change({price_cents:1690,pvp_cents:2290,expected_price:{price_cents:1490,pvp_cents:1990}}));
    const current = supplier();
    const writes = sqlite.prepare('SELECT total_changes() n').get().n;
    expect(await simulateSupplierPrice(db,original)).toEqual({...first,replayed:true});
    expect(supplier()).toEqual(current);
    expect(sqlite.prepare('SELECT total_changes() n').get().n).toBe(writes);
    expect(priceEvents()).toBe(2);
  });

  it('rejects a changed payload under an existing key without altering the original receipt',async () => {
    const original = change();
    await simulateSupplierPrice(db,original);
    const writes = sqlite.prepare('SELECT total_changes() n').get().n;
    expect(await submit({...original,price_cents:1590})).toMatchObject({status:409,body:{code:'idempotency_conflict'}});
    expect(sqlite.prepare('SELECT total_changes() n').get().n).toBe(writes);
    expect(supplier().price_cents).toBe(1490);
  });

  it('allows only one competing change based on the same observed price',async () => {
    const results = await Promise.all([submit(change()),submit(change({price_cents:1590}))]);
    expect(results.map(result => result.status).sort()).toEqual([200,409]);
    const rejected = results.find(result => result.status === 409);
    expect(rejected.body).toMatchObject({code:'supplier_price_changed',price:{price_cents:supplier().price_cents,pvp_cents:1990}});
    expect(priceEvents()).toBe(1);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_price_changes').get().n).toBe(1);
  });

  it('stores a no-op receipt without changing the supplier timestamp or recording false activity',async () => {
    const original = supplier();
    const input = change({price_cents:1290,pvp_cents:1590});
    const result = await simulateSupplierPrice(db,input);
    expect(result.change.changed).toBe(false);
    expect(result.replayed).toBe(false);
    expect(supplier()).toEqual(original);
    expect(priceEvents()).toBe(0);
    expect((await simulateSupplierPrice(db,input)).replayed).toBe(true);
  });

  it('supports a null comparative price and the allowed cent boundaries',async () => {
    await simulateSupplierPrice(db,change({price_cents:0,pvp_cents:null}));
    expect(supplier()).toMatchObject({price_cents:0,pvp_cents:null});
    await simulateSupplierPrice(db,change({price_cents:1000000,pvp_cents:null,expected_price:{price_cents:0,pvp_cents:null}}));
    expect(supplier()).toMatchObject({price_cents:1000000,pvp_cents:null});
  });

  it('rolls back the price and receipt if recording activity fails',async () => {
    const original = supplier();
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db,'prepare').mockImplementation(sql => sql.includes("SELECT 'supplier','Cambio de precio simulado'")
      ? prepare('INSERT INTO unavailable_activity_table VALUES (1)') : prepare(sql));
    try { await expect(simulateSupplierPrice(db,change())).rejects.toThrow(); }
    finally { spy.mockRestore(); }
    expect(supplier()).toEqual(original);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_price_changes').get().n).toBe(0);
    expect(priceEvents()).toBe(0);
  });

  it('recovers an operation whose committed batch response was lost',async () => {
    const input = change();
    const original = db.batch.bind(db);
    const spy = vi.spyOn(db,'batch').mockImplementationOnce(async statements => {
      await original(statements);
      throw new Error('Committed response lost');
    });
    try { await expect(simulateSupplierPrice(db,input)).rejects.toThrow('Committed response lost'); }
    finally { spy.mockRestore(); }
    expect((await simulateSupplierPrice(db,input)).replayed).toBe(true);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_price_changes').get().n).toBe(1);
    expect(priceEvents()).toBe(1);
  });

  it.each([
    {price_cents:-1},{price_cents:1.5},{price_cents:1000001},{pvp_cents:1490},{pvp_cents:1000001},
    {pvp_cents:undefined},{expected_price:{price_cents:1290,pvp_cents:1200}},
    {expected_price:undefined},{idempotency_key:'invalid'},{code:' '},
  ])('rejects invalid price input (%o) without writes',async patch => {
    const writes = sqlite.prepare('SELECT total_changes() n').get().n;
    expect((await submit(change(patch))).status).toBe(400);
    expect(sqlite.prepare('SELECT total_changes() n').get().n).toBe(writes);
  });

  it('returns 404 for a missing supplier product and requires both demo flags and same origin',async () => {
    expect((await submit(change({code:'MISSING'}))).status).toBe(404);
    expect((await submit(change(),{DEMO_MODE:'true'})).status).toBe(403);
    expect((await submit(change(),{OMNICHANNEL_DEMO:'true'})).status).toBe(403);
    expect((await submit(change(),{DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'},'https://elsewhere.test')).status).toBe(403);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_price_changes').get().n).toBe(0);
  });
});

describe('supplier catalog patch concurrency',() => {
  function afterCatalogRead(callback) {
    const original = db.prepare.bind(db);
    let called = false;
    return vi.spyOn(db,'prepare').mockImplementation(sql => {
      const statement = original(sql);
      if (sql !== 'SELECT * FROM supplier_products WHERE code=?') return statement;
      const bind = statement.bind.bind(statement);
      statement.bind=(...values) => {
        const bound=bind(...values),first=bound.first.bind(bound);
        bound.first=async (...columns) => {
          const row=await first(...columns);
          if (!called) {called=true;await callback();}
          return row;
        };
        return bound;
      };
      return statement;
    });
  }

  it('does not restore supplier stock deducted between reading a price patch and applying it',async () => {
    const placed = await createDemoOrder(db,checkout());
    const spy = afterCatalogRead(() => dispatchOrder(db,placed.order_id));
    try { await upsertSupplierProduct(db,{code:'SUP-001',price_cents:1490,pvp_cents:1990}); }
    finally { spy.mockRestore(); }
    expect(sqlite.prepare('SELECT stock,price_cents,pvp_cents FROM supplier_products').get())
      .toMatchObject({stock:16,price_cents:1490,pvp_cents:1990});
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(1);
    await syncSupplier(db);
    expect((await getProducts(db))[0].stock).toBe(16);
  });

  it.each(['price','pvp'])('keeps a coherent price pair when the other %s field changes concurrently',async kind => {
    const patch = kind === 'price' ? {price_cents:1490} : {pvp_cents:1390};
    const concurrent = kind === 'price' ? {pvp_cents:1390} : {price_cents:1490};
    const spy = afterCatalogRead(() => upsertSupplierProduct(db,{code:'SUP-001',...concurrent}));
    try { await expect(upsertSupplierProduct(db,{code:'SUP-001',...patch})).rejects.toMatchObject({status:409}); }
    finally { spy.mockRestore(); }
    expect(sqlite.prepare('SELECT price_cents,pvp_cents FROM supplier_products').get()).toMatchObject(
      kind === 'price' ? {price_cents:1290,pvp_cents:1390} : {price_cents:1490,pvp_cents:1590});
  });

  it('preserves unrelated concurrent fields and allows explicitly clearing the comparative price',async () => {
    const spy = afterCatalogRead(() => upsertSupplierProduct(db,{code:'SUP-001',name:'Nombre modificado',backup_stock:25}));
    try { await upsertSupplierProduct(db,{code:'SUP-001',price_cents:1790,pvp_cents:null}); }
    finally { spy.mockRestore(); }
    expect(sqlite.prepare('SELECT name,backup_stock,price_cents,pvp_cents FROM supplier_products').get())
      .toMatchObject({name:'Nombre modificado',backup_stock:25,price_cents:1790,pvp_cents:null});
  });
});

describe('supplier stock snapshots',() => {
  function endpoint(search = '?code=SUP-001',flags = {DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'}) {
    const request = new Request(`https://demo.test/api/demo/stock${search}`);
    return readStockSnapshot({request,url:new URL(request.url),locals:{runtime:{env:{DB:db,...flags}}}});
  }
  function addOrder(reference,status,qty = 1,currentQty = null,committed = 0) {
    const order = sqlite.prepare(`INSERT INTO orders(order_number,email,customer_name,address_json,
      subtotal_cents,shipping_cents,total_cents,status,supplier_stock_committed)
      VALUES (?,'stock@example.test','Cliente ficticio de stock','{}',1290,0,1290,?,?)`)
      .run(reference,status,committed);
    sqlite.prepare(`INSERT INTO order_items(order_id,product_id,name_snapshot,unit_price_cents,qty,current_qty)
      SELECT ?,id,name,price_cents,?,? FROM products WHERE supplier_sku='SUP-001'`)
      .run(order.lastInsertRowid,qty,currentQty);
    return Number(order.lastInsertRowid);
  }

  it('shows the supplier change before synchronization and preserves commitments after dispatch',async () => {
    const order = await createDemoOrder(db,checkout(2));
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({
      supplier_stock:18,reserved_units:2,reserved_orders_count:1,theoretical_available:16,
      store_stock:16,stock_difference:0,
    });
    await upsertSupplierProduct(db,{code:'SUP-001',stock:8});
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({
      supplier_stock:8,reserved_units:2,theoretical_available:6,store_stock:16,stock_difference:10,
    });
    await syncSupplier(db);
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({
      supplier_stock:8,reserved_units:2,theoretical_available:6,store_stock:6,stock_difference:0,
    });
    await dispatchOrder(db,order.order_id);
    const dispatched = await getSupplierStockSnapshot(db,'SUP-001');
    expect(dispatched).toMatchObject({
      supplier_stock:6,reserved_units:0,reserved_orders_count:0,theoretical_available:6,
      store_stock:6,stock_difference:0,
    });
    await syncSupplier(db);
    expect((await getProducts(db))[0].stock).toBe(dispatched.theoretical_available);
  });

  it('does not reserve supplier-accepted units again when the local acknowledgement is missing',async () => {
    const placed = await createDemoOrder(db,checkout(2));
    await new MockSupplierAdapter(db).createOrder({reference:placed.order_number,items:[{code:'SUP-001',qty:2}]});
    expect(sqlite.prepare('SELECT supplier_stock_committed FROM orders WHERE id=?').get(placed.order_id).supplier_stock_committed).toBe(0);
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({
      supplier_stock:16,reserved_units:0,reserved_orders_count:0,theoretical_available:16,store_stock:16,
    });
    await syncSupplier(db);
    expect((await getProducts(db))[0].stock).toBe(16);
    await dispatchOrder(db,placed.order_id);
    expect((await getSupplierStockSnapshot(db,'SUP-001')).supplier_stock).toBe(16);
  });

  it('uses current quantities and the same paid-state criteria as supplier synchronization',async () => {
    addOrder('STOCK-PAID','paid',3,1);
    addOrder('STOCK-SHIPPED','shipped',2,null,1);
    addOrder('STOCK-DELIVERED','delivered',2);
    addOrder('STOCK-REMOVED','paid',3,0);
    addOrder('STOCK-UNPAID','pending',4);
    addOrder('STOCK-CANCELLED','cancelled',4);
    const snapshot = await getSupplierStockSnapshot(db,'SUP-001');
    expect(snapshot).toMatchObject({reserved_units:5,reserved_orders_count:3,theoretical_available:13});
    await syncSupplier(db);
    expect((await getProducts(db))[0].stock).toBe(snapshot.theoretical_available);
  });

  it('counts each reserved order once even when the product appears in more than one line',async () => {
    const id = addOrder('STOCK-TWO-LINES','paid',2);
    sqlite.prepare(`INSERT INTO order_items(order_id,product_id,name_snapshot,unit_price_cents,qty)
      SELECT ?,id,name,price_cents,1 FROM products WHERE supplier_sku='SUP-001'`).run(id);
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({reserved_units:3,reserved_orders_count:1});
  });

  it('includes old reservations beyond the recent 100 orders and floors availability without adding backup stock',async () => {
    for (let index = 0; index < 107; index++) addOrder(`STOCK-HISTORY-${index}`,'paid');
    await upsertSupplierProduct(db,{code:'SUP-001',stock:0,backup_stock:500});
    const snapshot = await getSupplierStockSnapshot(db,'SUP-001');
    expect(snapshot).toMatchObject({
      supplier_stock:0,reserved_units:107,reserved_orders_count:107,theoretical_available:0,
      store_stock:18,stock_difference:18,
    });
    expect(snapshot).not.toHaveProperty('backup_stock');
    await syncSupplier(db);
    expect((await getProducts(db))[0].stock).toBe(0);
  });

  it('shows activation separately from quantities and returns a negative difference when the supplier has more stock',async () => {
    await upsertSupplierProduct(db,{code:'SUP-001',stock:25,active:0});
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({
      supplier_active:false,store_active:true,theoretical_available:25,store_stock:18,stock_difference:-7,
    });
    await syncSupplier(db);
    expect(await getSupplierStockSnapshot(db,'SUP-001')).toMatchObject({
      supplier_active:false,store_active:false,theoretical_available:25,store_stock:25,stock_difference:0,
    });
  });

  it('returns null store fields for a supplier product that has not been imported',async () => {
    const source = (await new MockSupplierAdapter(db).catalog())[0];
    await upsertSupplierProduct(db,{...source,code:'SUP-NEW',slug:'nuevo-demo',name:'Nuevo artículo demo'});
    const response = await endpoint('?code=SUP-NEW');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({demo:true,snapshot:{
      code:'SUP-NEW',name:'Nuevo artículo demo',slug:'nuevo-demo',store_product_id:null,
      supplier_active:true,store_active:null,supplier_stock:18,reserved_units:0,reserved_orders_count:0,
      theoretical_available:18,store_stock:null,stock_difference:null,store_synced_at:null,
      supplier_price_cents:1290,supplier_pvp_cents:1590,store_price_cents:null,store_pvp_cents:null,
    }});
  });

  it('uses one read-only SQL snapshot and returns the exact public fields with no-store headers',async () => {
    await createDemoOrder(db,checkout(2));
    const writesBefore = sqlite.prepare('SELECT total_changes() AS total').get().total;
    const prepare = vi.spyOn(db,'prepare');
    const response = await endpoint('?code=%20SUP-001%20');
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockRestore();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const payload = await response.json();
    expect(payload.demo).toBe(true);
    expect(payload.snapshot).toEqual({
      code:'SUP-001',name:'Champú & cuidado',slug:'champu-demo',store_product_id:expect.any(Number),
      supplier_active:true,store_active:true,supplier_stock:18,reserved_units:2,reserved_orders_count:1,
      theoretical_available:16,store_stock:16,stock_difference:0,
      supplier_price_cents:1290,supplier_pvp_cents:1590,store_price_cents:1290,store_pvp_cents:1590,
      supplier_updated_at:expect.any(String),store_synced_at:expect.any(String),
    });
    expect(sqlite.prepare('SELECT total_changes() AS total').get().total).toBe(writesBefore);
  });

  it.each(['','?code=','?code=%20%20','?code='+ 'X'.repeat(121)])('rejects an invalid supplier code (%s)',async (search) => {
    expect((await endpoint(search)).status).toBe(400);
  });

  it.each(['MISSING',"SUP-001' OR 1=1 --"] )('returns 404 for an unknown literal supplier code (%s)',async (code) => {
    const response = await endpoint(`?code=${encodeURIComponent(code)}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({error:'Artículo no encontrado en el proveedor demo.'});
  });

  it('keeps the new read endpoint behind both demo flags',async () => {
    expect((await endpoint('?code=SUP-001',{DEMO_MODE:'true'})).status).toBe(403);
    expect((await endpoint('?code=SUP-001',{OMNICHANNEL_DEMO:'true'})).status).toBe(403);
  });
});

describe('complete order summaries',() => {
  function insertSummaryOrder(reference,channel,total,status = 'paid',supplierStatus = 'PENDING_SUPPLIER',committed = 0) {
    sqlite.prepare(`INSERT INTO orders(order_number,email,customer_name,address_json,subtotal_cents,
      shipping_cents,total_cents,status,channel,supplier_status,supplier_stock_committed,supplier_order_id)
      VALUES (?,'summary@example.test','Cliente ficticio de resumen','{}',?,0,?,?,?,?,?,?)`)
      .run(reference,total,total,status,channel,supplierStatus,committed,committed ? `PED-ERP-${reference}` : null);
  }

  it('returns explicit zero summaries and empty last orders before the first purchase',async () => {
    const state = await getState(db,'https://demo.test');
    expect(state.orders).toEqual([]);
    expect(state.order_summary).toEqual({total:0,total_cents:0,pending_supplier:0});
    expect(state.marketplaces).toHaveLength(4);
    for (const marketplace of state.marketplaces) {
      expect(marketplace).toMatchObject({orders_count:0,total_cents:0,pending_supplier:0,last_order:null});
    }
  });

  it('counts all orders and preserves old channel activity beyond the most recent 100',async () => {
    insertSummaryOrder('OLD-AMAZON-1','AMAZON',3100);
    insertSummaryOrder('OLD-AMAZON-2','AMAZON',4900,'paid','ERROR');
    insertSummaryOrder('OLD-MIRAVIA','MIRAVIA',7200,'paid','ERROR',1);
    insertSummaryOrder('OLD-CANCELLED','CARREFOUR',1500,'cancelled');
    for (let index = 0; index < 105; index++) {
      insertSummaryOrder(`RECENT-WEB-${index}`,'WEB',1000+index,'shipped','SUPPLIER_SHIPPED',1);
    }
    const state = await getState(db,'https://demo.test');
    expect(state.orders).toHaveLength(100);
    expect(state.orders.every(order => order.channel === 'WEB')).toBe(true);
    expect(state.orders[0].order_number).toBe('RECENT-WEB-104');
    expect(state.orders.at(-1).order_number).toBe('RECENT-WEB-5');
    expect(state.order_summary).toEqual({total:109,total_cents:127160,pending_supplier:2});
    expect(state.marketplaces.find(channel => channel.channel === 'AMAZON'))
      .toMatchObject({orders_count:2,total_cents:8000,pending_supplier:2,last_order:'OLD-AMAZON-2'});
    expect(state.marketplaces.find(channel => channel.channel === 'MIRAVIA'))
      .toMatchObject({orders_count:1,total_cents:7200,pending_supplier:0,last_order:'OLD-MIRAVIA'});
    expect(state.marketplaces.find(channel => channel.channel === 'CARREFOUR'))
      .toMatchObject({orders_count:1,total_cents:1500,pending_supplier:0,last_order:'OLD-CANCELLED'});
    expect(state.marketplaces.find(channel => channel.channel === 'EBAY'))
      .toMatchObject({orders_count:0,total_cents:0,pending_supplier:0,last_order:null});
  });

  it('counts the actual dispatch queue without retrying a supplier incident after acceptance',async () => {
    const pending = await createDemoOrder(db,checkout(1),'AMAZON');
    const accepted = await createDemoOrder(db,checkout(1),'MIRAVIA');
    await dispatchOrder(db,accepted.order_id);
    await advanceOrder(db,accepted.order_id,'error');
    insertSummaryOrder('UNPAID','EBAY',1000,'pending');
    const before = await getState(db,'https://demo.test');
    expect(before.order_summary.pending_supplier).toBe(1);
    expect(before.marketplaces.find(channel => channel.channel === 'AMAZON').pending_supplier).toBe(1);
    expect(before.marketplaces.find(channel => channel.channel === 'MIRAVIA').pending_supplier).toBe(0);
    expect(before.marketplaces.find(channel => channel.channel === 'EBAY').pending_supplier).toBe(0);
    expect(await processPendingOrders(db)).toEqual({processed:1,errors:0});
    expect((await getState(db,'https://demo.test')).order_summary.pending_supplier).toBe(0);
    expect((await getOrderDetail(db,pending.order_id)).order.supplier_status).toBe('SUPPLIER_ACCEPTED');
    expect((await getOrderDetail(db,accepted.order_id)).order.supplier_status).toBe('ERROR');
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(2);
  });
});

describe('paginated order history',() => {
  function insertListOrder(reference,options = {}) {
    sqlite.prepare(`INSERT INTO orders(order_number,email,customer_name,address_json,subtotal_cents,
      shipping_cents,total_cents,status,channel,supplier_order_id,tracking_number,stripe_session_id,request_hash,
      supplier_status,supplier_stock_committed)
      VALUES (?,'history@example.test',?,'{}',1000,0,1000,?,?,?,?,?,?,?,?)`)
      .run(reference,options.customer ?? 'Cliente ficticio',options.status ?? 'paid',options.channel ?? 'WEB',
        options.supplier ?? null,options.tracking ?? null,`demo-private-${reference}`,`request-private-${reference}`,
        options.supplierStatus ?? 'PENDING_SUPPLIER',options.committed ?? 0);
  }
  const query = (values = {}) => getOrderList(db,new URLSearchParams(values));

  it('paginates the entire history beyond 100 rows without duplicate orders and clamps high pages',async () => {
    insertListOrder('OLD-AMAZON',{channel:'AMAZON'});
    insertListOrder('OLD-MIRAVIA',{channel:'MIRAVIA'});
    for (let index = 0; index < 105; index++) insertListOrder(`WEB-${index}`);
    const first = await query();
    expect(first.pagination).toEqual({page:1,limit:25,total:107,pages:5});
    expect(first.filters).toEqual({q:'',channel:'',status:'',supplier:''});
    expect(first.orders[0].order_number).toBe('WEB-104');
    const pages = await Promise.all([1,2,3,4,5].map(page => query({page:String(page)})));
    const ids = pages.flatMap(page => page.orders.map(order => order.id));
    expect(ids).toHaveLength(107);
    expect(new Set(ids).size).toBe(107);
    expect(ids).toEqual([...ids].sort((a,b) => b-a));
    const last = await query({page:'100000'});
    expect(last.pagination).toEqual({page:5,limit:25,total:107,pages:5});
    expect(last.orders).toEqual(pages[4].orders);
    expect(last.orders.at(-1).order_number).toBe('OLD-AMAZON');
    expect((await getState(db,'https://demo.test')).orders).toHaveLength(100);
  });

  it('combines text, channel and status filters across the full history',async () => {
    insertListOrder('MATCH-OLD',{customer:'Álvaro Álvarez Demo',channel:'AMAZON'});
    insertListOrder('WRONG-CHANNEL',{customer:'Álvaro Álvarez Demo',channel:'MIRAVIA'});
    insertListOrder('WRONG-STATUS',{customer:'Álvaro Álvarez Demo',channel:'AMAZON',status:'cancelled'});
    insertListOrder('WRONG-NAME',{customer:'Cliente ficticio',channel:'AMAZON'});
    for (let index = 0; index < 105; index++) insertListOrder(`RECENT-${index}`);
    const result = await query({q:'  ÁLVAREZ  ',channel:'AMAZON',status:'paid',limit:'10',page:'4'});
    expect(result.filters).toEqual({q:'ÁLVAREZ',channel:'AMAZON',status:'paid',supplier:''});
    expect(result.pagination).toEqual({page:1,limit:10,total:1,pages:1});
    expect(result.orders.map(order => order.order_number)).toEqual(['MATCH-OLD']);
  });

  it('searches all existing fields without case or common Spanish accent distinctions',async () => {
    insertListOrder('FH-ÚNICO',{customer:'ÁLVARO MUÑOZ Demo',supplier:'PED-ERP-Único',tracking:'DEMO-Ñandú'});
    insertListOrder('DECOMPOSED',{customer:'U\u0301RSULA PINGÜINO Demo'});
    for (const q of ['fh-unico','álvaro muñoz','ALVARO MUNOZ','ped-erp-unico','demo-nandu']) {
      expect((await query({q})).orders.map(order => order.order_number)).toEqual(['FH-ÚNICO']);
    }
    expect((await query({q:'ursula pinguino'})).orders.map(order => order.order_number)).toEqual(['DECOMPOSED']);
  });

  it('treats LIKE wildcards and SQL-looking search text as literal user input',async () => {
    insertListOrder('LITERAL',{customer:"Demo 50%_test\\ ' OR 1=1 --"});
    insertListOrder('NORMAL',{customer:'Cliente normal de demostración'});
    for (const q of ['%','_','\\',"' OR 1=1 --"]) {
      const result = await query({q});
      expect(result.pagination.total).toBe(1);
      expect(result.orders.map(order => order.order_number)).toEqual(['LITERAL']);
    }
    expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(2);
  });

  it('returns a stable empty-page contract and never exposes internal checkout tokens',async () => {
    const empty = await query({page:'15'});
    expect(empty).toEqual({orders:[],pagination:{page:1,limit:25,total:0,pages:1},filters:{q:'',channel:'',status:'',supplier:''}});
    insertListOrder('PRIVATE');
    const result = await query({limit:'1'});
    expect(result.orders[0]).toHaveProperty('tracking_carrier',null);
    expect(result.orders[0]).not.toHaveProperty('stripe_session_id');
    expect(result.orders[0]).not.toHaveProperty('request_hash');
    expect((await query({q:'no-match',page:'100'})).pagination).toEqual({page:1,limit:25,total:0,pages:1});
  });

  it('accepts all existing channel and order status filters',async () => {
    for (const channel of ['WEB','AMAZON','MIRAVIA','CARREFOUR','EBAY']) {
      for (const status of ['pending','paid','shipped','delivered','cancelled']) {
        insertListOrder(`${channel}-${status}`,{channel,status});
        const result = await query({channel,status});
        expect(result.orders.map(order => order.order_number)).toEqual([`${channel}-${status}`]);
      }
    }
  });

  it.each([
    ['pending_dispatch','PENDING_SUPPLIER',0],['accepted','SUPPLIER_ACCEPTED',1],
    ['processing','SUPPLIER_PROCESSING',1],['partial','SUPPLIER_PARTIAL',1],
    ['shipped','SUPPLIER_SHIPPED',1],['error','ERROR',1],
  ])('accepts the %s supplier filter and returns its normalized contract',async (supplier,supplierStatus,committed) => {
    insertListOrder('MATCH',{supplierStatus,committed});
    insertListOrder('OTHER',{status:'cancelled'});
    const result = await query({supplier});
    expect(result.filters).toEqual({q:'',channel:'',status:'',supplier});
    expect(result.pagination).toEqual({page:1,limit:25,total:1,pages:1});
    expect(result.orders.map(order => order.order_number)).toEqual(['MATCH']);
    expect(result.orders[0]).not.toHaveProperty('supplier_stock_committed');
  });

  it('combines supplier, text, channel and commercial state across paginated older matches',async () => {
    for (let index = 0; index < 57; index++) {
      insertListOrder(`OLD-ERROR-${index}`,{customer:'Álvaro Demo',channel:'AMAZON',supplierStatus:'ERROR',committed:index%2});
    }
    insertListOrder('OTHER-CHANNEL',{customer:'Álvaro Demo',channel:'MIRAVIA',supplierStatus:'ERROR'});
    insertListOrder('OTHER-STATUS',{customer:'Álvaro Demo',channel:'AMAZON',supplierStatus:'ERROR',status:'cancelled'});
    insertListOrder('OTHER-NAME',{customer:'Cliente ficticio',channel:'AMAZON',supplierStatus:'ERROR'});
    for (let index = 0; index < 105; index++) insertListOrder(`NEW-ACCEPTED-${index}`,{supplierStatus:'SUPPLIER_ACCEPTED',committed:1});
    const filters = {q:'  ALVARO  ',channel:'AMAZON',status:'paid',supplier:'error',limit:'25'};
    const pages = await Promise.all([1,2,3].map(page => query({...filters,page:String(page)})));
    expect(pages[0].pagination).toEqual({page:1,limit:25,total:57,pages:3});
    expect(pages[0].filters).toEqual({q:'ALVARO',channel:'AMAZON',status:'paid',supplier:'error'});
    const ids = pages.flatMap(page => page.orders.map(order => order.id));
    expect(ids).toHaveLength(57);
    expect(new Set(ids).size).toBe(57);
    expect(ids).toEqual([...ids].sort((a,b) => b-a));
    expect(pages[0].orders[0].order_number).toBe('OLD-ERROR-56');
    expect(pages[2].orders.at(-1).order_number).toBe('OLD-ERROR-0');
    const clamped = await query({...filters,page:'100000'});
    expect(clamped.pagination).toEqual({page:3,limit:25,total:57,pages:3});
    expect(clamped.orders).toEqual(pages[2].orders);
    expect((await getState(db,'https://demo.test')).orders.every(order => order.supplier_status === 'SUPPLIER_ACCEPTED')).toBe(true);
  });

  it('distinguishes an error before dispatch from an incident after supplier acceptance',async () => {
    const untouched = await createDemoOrder(db,checkout(1));
    const failed = await createDemoOrder(db,checkout(1),'AMAZON');
    const accepted = await createDemoOrder(db,checkout(1),'MIRAVIA');
    const partial = await createDemoOrder(db,checkout(1),'EBAY');
    await dispatchOrder(db,accepted.order_id);
    await advanceOrder(db,accepted.order_id,'error');
    await dispatchOrder(db,partial.order_id);
    await advanceOrder(db,partial.order_id,'partial');
    sqlite.exec('UPDATE supplier_products SET stock=0');
    await expect(dispatchOrder(db,failed.order_id)).rejects.toMatchObject({status:409});
    const pending = await query({supplier:'pending_dispatch'});
    expect(pending.orders.map(order => order.id)).toEqual([failed.order_id,untouched.order_id]);
    expect(pending.pagination.total).toBe((await getState(db,'https://demo.test')).order_summary.pending_supplier);
    expect((await query({supplier:'error'})).orders.map(order => order.id)).toEqual([accepted.order_id,failed.order_id]);
    expect((await query({supplier:'partial'})).orders.map(order => order.id)).toEqual([partial.order_id]);
  });

  it.each(['PENDING_SUPPLIER','ERROR'])('keeps remote acceptance with missing local acknowledgement in the dispatch queue (%s)',async supplierStatus => {
    const placed = await createDemoOrder(db,checkout(2));
    await new MockSupplierAdapter(db).createOrder({reference:placed.order_number,items:[{code:'SUP-001',qty:2}]});
    sqlite.prepare('UPDATE orders SET supplier_status=? WHERE id=?').run(supplierStatus,placed.order_id);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(16);
    expect((await query({supplier:'pending_dispatch'})).orders.map(order => order.id)).toEqual([placed.order_id]);
    expect((await query({supplier:'accepted'})).pagination.total).toBe(0);
    await dispatchOrder(db,placed.order_id);
    expect((await query({supplier:'pending_dispatch'})).pagination.total).toBe(0);
    expect((await query({supplier:'accepted'})).orders.map(order => order.id)).toEqual([placed.order_id]);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(16);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(1);
  });

  it('returns an empty stable page for commercial states incompatible with the dispatch queue',async () => {
    for (const status of ['pending','shipped','delivered','cancelled']) insertListOrder(`NOT-PAID-${status}`,{status});
    insertListOrder('TO-DISPATCH');
    for (const status of ['pending','shipped','delivered','cancelled']) {
      expect(await query({status,supplier:'pending_dispatch',page:'100'})).toEqual({
        orders:[],pagination:{page:1,limit:25,total:0,pages:1},filters:{q:'',channel:'',status,supplier:'pending_dispatch'},
      });
    }
    expect((await query({supplier:'pending_dispatch'})).orders.map(order => order.order_number)).toEqual(['TO-DISPATCH']);
    expect((await query({supplier:''})).pagination.total).toBe(5);
  });

  it('rejects invalid query parameters with HTTP 400 before querying the database',async () => {
    const invalid = [
      {page:'0'},{page:'-1'},{page:'1.5'},{page:'NaN'},{page:'100001'},{page:''},
      {limit:'0'},{limit:'51'},{limit:'1.5'},{limit:'Infinity'},{limit:''},
      {channel:'OTHER'},{channel:'amazon'},{status:'refunded'},{q:'a'.repeat(121)},
      {supplier:'pending'},{supplier:'ERROR'},{supplier:'unknown'},{supplier:"error' OR 1=1 --"},
    ];
    const batch = vi.spyOn(db,'batch');
    for (const values of invalid) {
      const url = new URL(`https://demo.test/api/demo/orders?${new URLSearchParams(values)}`);
      const response = await listOrders({url,request:new Request(url),locals:{runtime:{env:{DB:db,DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'}}}});
      expect(response.status,JSON.stringify(values)).toBe(400);
      expect(await response.json()).toEqual({error:'Datos no válidos. Revisa el formulario.'});
    }
    expect(batch).not.toHaveBeenCalled();
    batch.mockRestore();
  });

  it('requires both demo flags for the read endpoint and returns no-store on success',async () => {
    const url = new URL('https://demo.test/api/demo/orders');
    for (const env of [{DB:db},{DB:db,DEMO_MODE:'true'},{DB:db,OMNICHANNEL_DEMO:'true'}]) {
      expect((await listOrders({url,request:new Request(url),locals:{runtime:{env}}})).status).toBe(403);
    }
    const response = await listOrders({url,request:new Request(url),locals:{runtime:{env:{DB:db,DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'}}}});
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect((await response.json()).pagination).toEqual({page:1,limit:25,total:0,pages:1});
  });
});

describe('supplier dispatch integrity',() => {
  it('records one stock incident across failed retries and preserves it after recovery',async () => {
    const placed = await createDemoOrder(db,checkout(),'AMAZON');
    sqlite.exec('UPDATE supplier_products SET stock=0');
    for (let retry = 0; retry < 2; retry++) {
      await expect(dispatchOrder(db,placed.order_id)).rejects.toMatchObject({status:409});
    }
    const incidents = () => sqlite.prepare("SELECT from_status,to_status,note FROM order_events WHERE order_id=? AND to_status='ERROR'").all(placed.order_id);
    expect(incidents()).toEqual([{from_status:'PENDING_SUPPLIER',to_status:'ERROR',note:'El proveedor demo no dispone de stock suficiente. Sincroniza y reintenta.'}]);
    const integrationIncidents = () => sqlite.prepare("SELECT title,detail FROM integration_events WHERE kind='supplier' AND title LIKE 'Incidencia al enviar %'").all();
    expect(integrationIncidents()).toEqual([{title:`Incidencia al enviar ${placed.order_number} al proveedor`,detail:incidents()[0].note}]);
    expect((await getOrderDetail(db,placed.order_id)).marketplace_sync.supplier_status).toBe('ERROR');
    sqlite.exec('UPDATE supplier_products SET stock=18');
    await dispatchOrder(db,placed.order_id);
    expect((await getOrderDetail(db,placed.order_id)).order.supplier_status).toBe('SUPPLIER_ACCEPTED');
    expect(sqlite.prepare("SELECT from_status FROM order_events WHERE order_id=? AND to_status='SUPPLIER_ACCEPTED'").get(placed.order_id).from_status).toBe('ERROR');
    expect(incidents()).toHaveLength(1);
    expect(integrationIncidents()).toHaveLength(1);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(16);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(1);
  });
  it('records an unconfirmed dispatch safely once across concurrent failed attempts',async () => {
    const placed = await createDemoOrder(db,checkout());
    const unavailable = vi.spyOn(MockSupplierAdapter.prototype,'createOrder').mockRejectedValue(new Error('private implementation diagnostic'));
    try {
      const results = await Promise.allSettled([dispatchOrder(db,placed.order_id),dispatchOrder(db,placed.order_id)]);
      expect(results.every(result => result.status === 'rejected' && result.reason.status === 503)).toBe(true);
      const incidents = sqlite.prepare("SELECT note FROM order_events WHERE order_id=? AND to_status='ERROR'").all(placed.order_id);
      expect(incidents).toEqual([{note:'No se pudo confirmar el envío al proveedor demo. Reintenta con la misma referencia.'}]);
      expect(sqlite.prepare("SELECT detail FROM integration_events WHERE kind='supplier' AND title LIKE 'Incidencia al enviar %'").all()).toEqual([{detail:incidents[0].note}]);
      expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(18);
    } finally { unavailable.mockRestore(); }
  });
  it('does not record or apply a late error after another dispatch confirms acceptance',async () => {
    const placed = await createDemoOrder(db,checkout());
    let started;
    const firstStarted = new Promise(resolve => { started = resolve; });
    let release;
    const releaseFirst = new Promise(resolve => { release = resolve; });
    const delayedFailure = vi.spyOn(MockSupplierAdapter.prototype,'createOrder').mockImplementationOnce(async () => {
      started();
      await releaseFirst;
      throw new Error('Late dispatch timeout');
    });
    try {
      const first = dispatchOrder(db,placed.order_id);
      await firstStarted;
      await dispatchOrder(db,placed.order_id);
      release();
      await expect(first).rejects.toMatchObject({status:503});
      expect(sqlite.prepare('SELECT supplier_status,supplier_stock_committed FROM orders WHERE id=?').get(placed.order_id))
        .toEqual({supplier_status:'SUPPLIER_ACCEPTED',supplier_stock_committed:1});
      expect(sqlite.prepare("SELECT count(*) n FROM order_events WHERE order_id=? AND to_status='ERROR'").get(placed.order_id).n).toBe(0);
      expect(sqlite.prepare("SELECT count(*) n FROM integration_events WHERE title LIKE 'Incidencia al enviar %'").get().n).toBe(0);
      expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(16);
      expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(1);
    } finally { release(); delayedFailure.mockRestore(); }
  });
  it.each([[],[{code:'SUP-001',qty:0}],[{code:'SUP-001',qty:-2}],[{code:'SUP-001',qty:1.5}],[{code:'',qty:1}]].map((items) => ({items})))
    ('rejects malformed quantities before writing ($items)',async ({items}) => {
      await expect(new MockSupplierAdapter(db).createOrder({reference:'INVALID',items})).rejects.toMatchObject({code:'invalid_input'});
      expect(sqlite.prepare('SELECT stock FROM supplier_products').get()?.stock).toBe(18);
      expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get()?.n).toBe(0);
    });
  it('rejects the complete order when any SKU is absent or inactive',async () => {
    const supplier = new MockSupplierAdapter(db);
    await expect(supplier.createOrder({reference:'MISSING',items:[{code:'SUP-001',qty:2},{code:'MISSING',qty:1}]}))
      .rejects.toMatchObject({code:'stock_unavailable'});
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get()?.stock).toBe(18);
    sqlite.exec('UPDATE supplier_products SET active=0');
    await expect(supplier.createOrder({reference:'INACTIVE',items:[{code:'SUP-001',qty:2}]}))
      .rejects.toMatchObject({code:'stock_unavailable'});
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get()?.n).toBe(0);
  });
  it('does not treat supplier backup stock as confirmed availability',async () => {
    sqlite.exec('UPDATE supplier_products SET stock=0,backup_stock=50');
    await expect(new MockSupplierAdapter(db).createOrder({reference:'BACKUP',items:[{code:'SUP-001',qty:1}]}))
      .rejects.toMatchObject({code:'stock_unavailable'});
    expect(sqlite.prepare('SELECT stock,backup_stock FROM supplier_products').get()).toMatchObject({stock:0,backup_stock:50});
  });
  it('serializes competing supplier reservations without overselling',async () => {
    const supplier = new MockSupplierAdapter(db);
    const results = await Promise.allSettled(['RACE-A','RACE-B'].map((reference) =>
      supplier.createOrder({reference,items:[{code:'SUP-001',qty:12}]})));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')[0].reason).toMatchObject({code:'stock_unavailable'});
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get()?.stock).toBe(6);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get()?.n).toBe(1);
  });
  it('accepts an equivalent replay but rejects a changed payload for the same reference',async () => {
    const supplier = new MockSupplierAdapter(db);
    const first = await supplier.createOrder({reference:'REPLAY',items:[{code:'SUP-001',qty:1},{code:'SUP-001',qty:2}]});
    expect(await supplier.createOrder({reference:'REPLAY',items:[{code:'SUP-001',qty:3}]})).toEqual(first);
    await expect(supplier.createOrder({reference:'REPLAY',items:[{code:'SUP-001',qty:4}]}))
      .rejects.toMatchObject({code:'idempotency_conflict'});
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get()?.stock).toBe(15);
  });
  it('rejects a conflicting payload even when two calls race for the reference',async () => {
    const supplier = new MockSupplierAdapter(db);
    const results = await Promise.allSettled([2,3].map((qty) =>
      supplier.createOrder({reference:'SAME-REFERENCE',items:[{code:'SUP-001',qty}]})));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')[0].reason).toMatchObject({code:'idempotency_conflict'});
    const stored = sqlite.prepare('SELECT items_json FROM supplier_orders').get();
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get()?.stock).toBe(18-JSON.parse(stored.items_json)[0].qty);
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get()?.n).toBe(1);
  });
});

describe('explicit supplier status commands',() => {
  const snapshot = () => Object.fromEntries(['orders','supplier_orders','supplier_products','inventory_balances','order_events','integration_events','marketplace_order_updates']
    .map(table => [table,sqlite.prepare(`SELECT * FROM ${table}`).all()]));
  async function submit(endpoint,id,status) {
    const request = new Request(`https://demo.test${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://demo.test'},
      body:JSON.stringify({...(endpoint === '/api/demo/action' ? {action:'advance'} : {}),order_id:id,...(status === undefined ? {} : {status})})});
    const handler = endpoint === '/api/demo/action' ? demoAction : supplierAction;
    const response = await handler({request,url:new URL(request.url),params:{path:'status'},locals:{runtime:{env:{DB:db,DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'}}}});
    return {status:response.status,body:await response.json()};
  }

  it.each([
    ['/api/demo/action','accepted'],['/api/demo/action','shipped'],
    ['/api/supplier/status','accepted'],['/api/supplier/status','shipped'],
  ])('rejects omitted or invalid states before database access through %s (%s)',async (endpoint,phase) => {
    const placed = await createDemoOrder(db,checkout(),'AMAZON');
    await dispatchOrder(db,placed.order_id);
    if (phase === 'shipped') await advanceOrder(db,placed.order_id,'shipped');
    const before = snapshot();
    const prepare = vi.spyOn(db,'prepare');
    try {
      for (const invalid of [undefined,null,'','pending','unknown','SHIPPED',42,{}]) {
        expect(await submit(endpoint,placed.order_id,invalid)).toEqual({status:400,body:{error:'Datos no válidos. Revisa el formulario.'}});
      }
      expect(prepare).not.toHaveBeenCalled();
    } finally { prepare.mockRestore(); }
    expect(snapshot()).toEqual(before);
  });

  it.each(['/api/demo/action','/api/supplier/status'])('repeats explicit destinations without advancing twice or duplicating effects through %s',async endpoint => {
    const placed = await createDemoOrder(db,checkout(),'MIRAVIA');
    await dispatchOrder(db,placed.order_id);
    const expected = {processing:'SUPPLIER_PROCESSING',partial:'SUPPLIER_PARTIAL',error:'ERROR',shipped:'SUPPLIER_SHIPPED'};
    for (const status of ['processing','partial','error','processing','shipped']) {
      const first = await submit(endpoint,placed.order_id,status);
      expect(first.status).toBe(200);
      expect(first.body.order.supplier_status).toBe(expected[status]);
      const before = snapshot();
      const replay = await submit(endpoint,placed.order_id,status);
      expect(replay.status).toBe(200);
      expect(replay.body.order).toMatchObject({id:placed.order_id,status:first.body.order.status,
        supplier_status:first.body.order.supplier_status,tracking_number:first.body.order.tracking_number,tracking_carrier:first.body.order.tracking_carrier});
      expect(replay.body.marketplace_sync).toEqual(first.body.marketplace_sync);
      const after = snapshot();
      for (const table of ['supplier_orders','supplier_products','inventory_balances','order_events','integration_events','marketplace_order_updates']) {
        expect(after[table],table).toEqual(before[table]);
      }
      expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(16);
    }
    const shipped = snapshot();
    const lateReplay = await submit(endpoint,placed.order_id,'processing');
    expect(lateReplay.body.order).toMatchObject({supplier_status:'SUPPLIER_SHIPPED',tracking_number:expect.stringMatching(/^DEMO-/)});
    for (const table of ['supplier_orders','supplier_products','inventory_balances','order_events','integration_events','marketplace_order_updates']) {
      expect(snapshot()[table],table).toEqual(shipped[table]);
    }
  });

  it('never invents a next state for direct adapter or orchestration callers',async () => {
    const prepare = vi.spyOn(db,'prepare');
    try {
      for (const status of [undefined,null,'pending','unknown']) {
        await expect(new MockSupplierAdapter(db).advanceOrder('ANY',status)).rejects.toMatchObject({code:'invalid_input'});
        await expect(advanceOrder(db,1,status)).rejects.toMatchObject({name:'ZodError'});
      }
      expect(prepare).not.toHaveBeenCalled();
    } finally { prepare.mockRestore(); }
  });

  it('keeps repeated GET status reads free of state transitions and writes after shipment',async () => {
    const placed = await createDemoOrder(db,checkout(),'EBAY');
    await dispatchOrder(db,placed.order_id);
    const shipped = await advanceOrder(db,placed.order_id,'shipped');
    const before = snapshot();
    for (const reference of [placed.order_number,shipped.order.supplier_order_id]) {
      const url = new URL('https://demo.test/api/supplier/orders');
      url.searchParams.set('reference',reference);
      const response = await supplierRead({request:new Request(url),url,params:{path:'orders'},locals:{runtime:{env:{DB:db,DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'}}}});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({demo:true,order:{status:'shipped',tracking:shipped.order.tracking_number}});
    }
    expect(snapshot()).toEqual(before);
  });
});

describe('marketplace status and tracking return',() => {
  it.each(['grouped','immediate'])('confirms a paid purchase when the hub acknowledgement fails in %s mode and reconciles it later',async (mode) => {
    await performAction(db,{action:'settings',dispatch_mode:mode},'https://demo.test');
    const input = checkout();
    const warning = vi.spyOn(console,'warn').mockImplementation(() => {});
    const unavailableHub = vi.spyOn(MockLighthouseAdapter.prototype,'syncOrder').mockRejectedValue(new Error('Hub unavailable'));
    let placed;
    try {
      placed = await createDemoOrder(db,input,'AMAZON');
      expect(placed).toMatchObject({marketplace_warning:expect.stringContaining('pedido está guardado'),url:expect.stringContaining('/gracias?session=')});
      const detail = await getOrderDetail(db,placed.order_id);
      expect(detail.order.status).toBe('paid');
      expect(detail.marketplace_sync).toBeNull();
      expect((await getProducts(db))[0].stock).toBe(16);
      expect(sqlite.prepare("SELECT count(*) n FROM orders WHERE status='paid'").get().n).toBe(1);
    } finally { unavailableHub.mockRestore(); warning.mockRestore(); }
    expect(await syncMarketplaceOrders(db)).toEqual({processed:1,errors:0});
    expect((await getOrderDetail(db,placed.order_id)).marketplace_sync.supplier_status)
      .toBe(mode === 'immediate' ? 'SUPPLIER_ACCEPTED' : 'PENDING_SUPPLIER');
    expect((await createDemoOrder(db,input,'AMAZON')).order_id).toBe(placed.order_id);
    expect((await getProducts(db))[0].stock).toBe(16);
  });
  it('keeps a completed shipment successful when notification fails and repairs only the acknowledgement',async () => {
    const placed = await createDemoOrder(db,checkout(),'MIRAVIA');
    await dispatchOrder(db,placed.order_id);
    const warning = vi.spyOn(console,'warn').mockImplementation(() => {});
    const unavailableHub = vi.spyOn(MockLighthouseAdapter.prototype,'syncOrder').mockRejectedValue(new Error('Hub unavailable'));
    let shipped;
    try {
      shipped = await advanceOrder(db,placed.order_id,'shipped');
      expect(shipped.order).toMatchObject({status:'shipped',supplier_status:'SUPPLIER_SHIPPED',tracking_number:expect.stringMatching(/^DEMO-/)});
      expect(shipped.marketplace_warning).toContain('pedido está guardado');
      expect(shipped.marketplace_sync.supplier_status).toBe('SUPPLIER_ACCEPTED');
    } finally { unavailableHub.mockRestore(); warning.mockRestore(); }
    expect(await syncMarketplaceOrders(db)).toEqual({processed:1,errors:0});
    expect((await getOrderDetail(db,placed.order_id)).marketplace_sync).toMatchObject({supplier_status:'SUPPLIER_SHIPPED',tracking_number:shipped.order.tracking_number});
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(1);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get().stock).toBe(16);
  });
  it('returns the persisted shipment even when reading the hub acknowledgement also fails',async () => {
    const placed = await createDemoOrder(db,checkout(),'EBAY');
    await dispatchOrder(db,placed.order_id);
    const prepare = db.prepare.bind(db);
    const warning = vi.spyOn(console,'warn').mockImplementation(() => {});
    const unavailableReads = vi.spyOn(db,'prepare').mockImplementation((sql) => {
      if (!sql.startsWith('SELECT * FROM marketplace_order_updates')) return prepare(sql);
      return { bind() { return this; }, async first() { throw new Error('Acknowledgement read unavailable'); } };
    });
    try {
      const result = await advanceOrder(db,placed.order_id,'shipped');
      expect(result.order).toMatchObject({status:'shipped',supplier_status:'SUPPLIER_SHIPPED'});
      expect(result.marketplace_sync).toBeNull();
      expect(result.marketplace_warning).toContain('acuse del hub');
    } finally { unavailableReads.mockRestore(); warning.mockRestore(); }
    // The acknowledgement write had succeeded; restoring reads is enough.
    expect(await syncMarketplaceOrders(db)).toEqual({processed:0,errors:0});
    expect((await getOrderDetail(db,placed.order_id)).marketplace_sync.supplier_status).toBe('SUPPLIER_SHIPPED');
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n).toBe(1);
  });
  it('does not access the hub table for web purchase, dispatch, shipment or order detail',async () => {
    const prepare = db.prepare.bind(db);
    let hubQueries = 0;
    const unavailableHub = vi.spyOn(db,'prepare').mockImplementation((sql) => {
      if (sql.includes('marketplace_order_updates')) { hubQueries++; throw new Error('Unexpected web hub access'); }
      return prepare(sql);
    });
    try {
      const placed = await createDemoOrder(db,checkout());
      expect(placed.marketplace_warning).toBeUndefined();
      await dispatchOrder(db,placed.order_id);
      await advanceOrder(db,placed.order_id,'shipped');
      const detail = await getOrderDetail(db,placed.order_id);
      expect(detail.order.status).toBe('shipped');
      expect(detail.marketplace_sync).toBeNull();
      expect(detail.marketplace_warning).toBeUndefined();
      expect(hubQueries).toBe(0);
    } finally { unavailableHub.mockRestore(); }
  });
  it('returns canonical supplier tracking to its originating marketplace exactly once',async () => {
    const placed = await createDemoOrder(db,checkout(),'AMAZON');
    expect((await getOrderDetail(db,placed.order_id)).marketplace_sync).toMatchObject({channel:'AMAZON',supplier_status:'PENDING_SUPPLIER',tracking_number:null});
    await dispatchOrder(db,placed.order_id);
    expect((await getOrderDetail(db,placed.order_id)).marketplace_sync.supplier_status).toBe('SUPPLIER_ACCEPTED');
    await Promise.all([advanceOrder(db,placed.order_id,'processing'),advanceOrder(db,placed.order_id,'shipped')]);
    const detail = await getOrderDetail(db,placed.order_id);
    expect(detail.order.tracking_carrier).toBe('Proveedor Demo');
    expect(detail.marketplace_sync).toMatchObject({channel:'AMAZON',reference:placed.order_number,
      supplier_status:'SUPPLIER_SHIPPED',tracking_number:detail.order.tracking_number,tracking_carrier:'Proveedor Demo'});
    const hub = new MockLighthouseAdapter(db);
    await Promise.all([hub.syncOrder(placed.order_number),hub.syncOrder(placed.order_number)]);
    expect((await getOrderDetail(db,placed.order_id)).marketplace_sync).toEqual(detail.marketplace_sync);
    expect(sqlite.prepare('SELECT count(*) n FROM marketplace_order_updates').get()?.n).toBe(1);
    const state = await getState(db,'https://demo.test');
    expect(state.integrations.lighthouse.orders_synced).toBe(1);
    expect(state.marketplaces.find((channel) => channel.channel === 'AMAZON')).toMatchObject({orders_synced:1,last_order_sync:detail.marketplace_sync.synced_at});
  });
  it('repairs a missing hub acknowledgement without creating another supplier order',async () => {
    const placed = await createDemoOrder(db,checkout(),'MIRAVIA');
    await dispatchOrder(db,placed.order_id);
    await advanceOrder(db,placed.order_id,'shipped');
    sqlite.exec('DELETE FROM marketplace_order_updates');
    expect(await syncMarketplaceOrders(db)).toEqual({processed:1,errors:0});
    expect(await syncMarketplaceOrders(db)).toEqual({processed:0,errors:0});
    expect((await getOrderDetail(db,placed.order_id)).marketplace_sync.supplier_status).toBe('SUPPLIER_SHIPPED');
    expect(sqlite.prepare('SELECT count(*) n FROM supplier_orders').get()?.n).toBe(1);
    expect(sqlite.prepare('SELECT stock FROM supplier_products').get()?.stock).toBe(16);
  });
  it('keeps web orders out of the hub and never regresses a delivered local order',async () => {
    const placed = await createDemoOrder(db,checkout());
    await dispatchOrder(db,placed.order_id);
    await advanceOrder(db,placed.order_id,'shipped');
    sqlite.prepare("UPDATE orders SET status='delivered' WHERE id=?").run(placed.order_id);
    await advanceOrder(db,placed.order_id,'shipped');
    const detail = await getOrderDetail(db,placed.order_id);
    expect(detail.order.status).toBe('delivered');
    expect(detail.marketplace_sync).toBeNull();
    expect(sqlite.prepare('SELECT count(*) n FROM marketplace_order_updates').get()?.n).toBe(0);
  });
});
