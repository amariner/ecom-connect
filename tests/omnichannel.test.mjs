import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertDemo, assertSameOrigin, createDemoOrder, dispatchOrder, advanceOrder,
  feedProducts, getConfirmation, getOrderDetail, getOrderList, getProducts, getState, getSupplierStockSnapshot,
  performAction, processPendingOrders, renderFeedXml, syncSupplier,syncMarketplaceOrders,upsertSupplierProduct,
} from '../src/lib/demo';
import { MockSupplierAdapter } from '../src/integrations/mock-supplier-adapter';
import { MockLighthouseAdapter } from '../src/integrations/mock-lighthouse-adapter';
import { POST as checkoutSession } from '../src/pages/api/checkout/session';
import { GET as listOrders } from '../src/pages/api/demo/orders/index';
import { GET as readStockSnapshot } from '../src/pages/api/demo/stock';

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
      shipping_cents,total_cents,status,channel,supplier_order_id,tracking_number,stripe_session_id,request_hash)
      VALUES (?,'history@example.test',?,'{}',1000,0,1000,?,?,?,?,?,?)`)
      .run(reference,options.customer ?? 'Cliente ficticio',options.status ?? 'paid',options.channel ?? 'WEB',
        options.supplier ?? null,options.tracking ?? null,`demo-private-${reference}`,`request-private-${reference}`);
  }
  const query = (values = {}) => getOrderList(db,new URLSearchParams(values));

  it('paginates the entire history beyond 100 rows without duplicate orders and clamps high pages',async () => {
    insertListOrder('OLD-AMAZON',{channel:'AMAZON'});
    insertListOrder('OLD-MIRAVIA',{channel:'MIRAVIA'});
    for (let index = 0; index < 105; index++) insertListOrder(`WEB-${index}`);
    const first = await query();
    expect(first.pagination).toEqual({page:1,limit:25,total:107,pages:5});
    expect(first.filters).toEqual({q:'',channel:'',status:''});
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
    expect(result.filters).toEqual({q:'ÁLVAREZ',channel:'AMAZON',status:'paid'});
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
    expect(empty).toEqual({orders:[],pagination:{page:1,limit:25,total:0,pages:1},filters:{q:'',channel:'',status:''}});
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

  it('rejects invalid query parameters with HTTP 400 before querying the database',async () => {
    const invalid = [
      {page:'0'},{page:'-1'},{page:'1.5'},{page:'NaN'},{page:'100001'},{page:''},
      {limit:'0'},{limit:'51'},{limit:'1.5'},{limit:'Infinity'},{limit:''},
      {channel:'OTHER'},{channel:'amazon'},{status:'refunded'},{q:'a'.repeat(121)},
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
