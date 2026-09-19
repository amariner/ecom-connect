import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceOrder, createDemoOrder, dispatchOrder, getOrderDetail, getOrderList, performAction,
  shipOrderLines, syncMarketplaceOrders, syncSupplier,
} from '../src/lib/demo';
import { POST as supplierAction } from '../src/pages/api/supplier/[...path]';
import { d1Adapter, migratedDatabase, readMigration } from './helpers/d1.mjs';

let sqlite;
let db;
const customer = {name:'Laura Demo',email:'laura@example.test',street:'Calle Ficticia 10',city:'Castellón',postal_code:'12001'};
const count = (table, where = '1=1') => sqlite.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).get().n;
const key = () => crypto.randomUUID();

/** Pedido con dos referencias: 2 champús y 1 crema, ya aceptado por el proveedor. */
async function acceptedOrder(channel = 'WEB') {
  const order = await createDemoOrder(db,{lines:[{slug:'champu-demo',qty:2},{slug:'crema-demo',qty:1}],customer,idempotency_key:key()},channel);
  await dispatchOrder(db,order.order_id);
  return order.order_id;
}
const ship = (id, lines, idempotency_key = key()) => shipOrderLines(db,id,{lines,idempotency_key});

beforeEach(async () => {
  sqlite = migratedDatabase();
  sqlite.exec(`INSERT INTO supplier_products(code,slug,name,description,price_cents,pvp_cents,brand,category,image,ean,sku,stock) VALUES
    ('SUP-001','champu-demo','Champú demo','Producto ficticio',1290,1590,'Dermocare','capilar','/images/demo.svg','2000000000008','FH-001',18),
    ('SUP-002','crema-demo','Crema demo','Producto ficticio',2190,2590,'Dermocare','facial','/images/demo.svg','2000000000015','FH-002',9);
    INSERT INTO shipping_rates(zone,label,price_cents,free_over_cents) VALUES ('peninsula','Envío demo',490,4900);`);
  db = d1Adapter(sqlite);
  await syncSupplier(db);
});
afterEach(() => { sqlite.close(); });

describe('shipments by order line',() => {
  it('reports every ordered line as pending once the supplier accepts the order',async () => {
    const id = await acceptedOrder();
    const { fulfillment } = await getOrderDetail(db,id);
    expect(fulfillment.shipments).toEqual([]);
    expect(fulfillment.lines).toEqual([
      {supplier_sku:'SUP-001',name:'Champú demo',ordered:2,shipped:0,pending:2},
      {supplier_sku:'SUP-002',name:'Crema demo',ordered:1,shipped:0,pending:1},
    ]);
  });

  it('registers a partial shipment without declaring the order shipped',async () => {
    const id = await acceptedOrder();
    const detail = await ship(id,[{supplier_sku:'SUP-001',qty:1}]);
    expect(detail.order).toMatchObject({status:'paid',supplier_status:'SUPPLIER_PARTIAL',tracking_number:null});
    expect(detail.fulfillment.lines.map(line => [line.shipped,line.pending])).toEqual([[1,1],[0,1]]);
    expect(detail.fulfillment.shipments).toHaveLength(1);
    expect(detail.fulfillment.shipments[0]).toMatchObject({sequence:1,units:1,tracking_carrier:'Proveedor Demo',
      lines:[{supplier_sku:'SUP-001',name:'Champú demo',qty:1}],marketplace_synced_at:null});
    expect(detail.fulfillment.shipments[0].tracking_number).toMatch(/^DEMO-[0-9A-F]{8}$/);
    expect(detail.events.filter(event => /Expedición/.test(event.note ?? '')).map(event => event.note))
      .toEqual([`Expedición ficticia 1: ${detail.fulfillment.shipments[0].tracking_number} · 1 ud.`]);
  });

  it('completes the order when the last pending units leave in a second shipment',async () => {
    const id = await acceptedOrder();
    await ship(id,[{supplier_sku:'SUP-001',qty:2}]);
    const detail = await ship(id,[{supplier_sku:'SUP-002',qty:1}]);
    const [first, second] = detail.fulfillment.shipments;
    expect(second.tracking_number).toBe(`${first.tracking_number}-2`);
    expect(detail.order).toMatchObject({status:'shipped',supplier_status:'SUPPLIER_SHIPPED',tracking_number:second.tracking_number});
    expect(detail.fulfillment.lines.every(line => line.pending === 0)).toBe(true);
    expect(sqlite.prepare("SELECT status FROM supplier_orders").get().status).toBe('shipped');
  });

  it('replays the same request without creating a second shipment or event',async () => {
    const id = await acceptedOrder();
    const requestKey = key();
    const first = await ship(id,[{supplier_sku:'SUP-002',qty:1}],requestKey);
    const events = count('order_events');
    const [again, concurrent] = await Promise.all([
      ship(id,[{supplier_sku:'SUP-002',qty:1}],requestKey), ship(id,[{supplier_sku:'SUP-002',qty:1}],requestKey),
    ]);
    expect(again.fulfillment).toEqual(first.fulfillment);
    expect(concurrent.fulfillment).toEqual(first.fulfillment);
    expect(count('supplier_shipments')).toBe(1);
    expect(count('order_shipments')).toBe(1);
    expect(count('order_events')).toBe(events);
  });

  it('rejects a reused request key with different lines',async () => {
    const id = await acceptedOrder();
    const requestKey = key();
    await ship(id,[{supplier_sku:'SUP-001',qty:1}],requestKey);
    await expect(ship(id,[{supplier_sku:'SUP-001',qty:2}],requestKey)).rejects.toMatchObject({status:409});
    expect(count('supplier_shipments')).toBe(1);
  });

  it.each([
    ['more units than pending',[{supplier_sku:'SUP-001',qty:3}],409],
    ['a reference outside the order',[{supplier_sku:'SUP-999',qty:1}],409],
    ['a repeated reference that exceeds the pending units',[{supplier_sku:'SUP-002',qty:1},{supplier_sku:'SUP-002',qty:1}],409],
  ])('rejects %s without writing anything',async (_name,lines,status) => {
    const id = await acceptedOrder();
    const events = count('order_events');
    await expect(ship(id,lines)).rejects.toMatchObject({status});
    expect(count('supplier_shipments')).toBe(0);
    expect(count('order_events')).toBe(events);
    expect((await getOrderDetail(db,id)).order.supplier_status).toBe('SUPPLIER_ACCEPTED');
  });

  it.each([
    ['no lines',[]],['a zero quantity',[{supplier_sku:'SUP-001',qty:0}]],['a fractional quantity',[{supplier_sku:'SUP-001',qty:1.5}]],
    ['a blank reference',[{supplier_sku:' ',qty:1}]],
  ])('rejects %s as invalid input before reading the order',async (_name,lines) => {
    await expect(shipOrderLines(db,999,{lines,idempotency_key:key()})).rejects.toThrow();
    await expect(shipOrderLines(db,999,{lines:[{supplier_sku:'SUP-001',qty:1}],idempotency_key:'not-a-uuid'})).rejects.toThrow();
    expect(count('supplier_shipments')).toBe(0);
  });

  it('requires the supplier to accept the order first',async () => {
    const order = await createDemoOrder(db,{lines:[{slug:'champu-demo',qty:1}],customer,idempotency_key:key()});
    await expect(ship(order.order_id,[{supplier_sku:'SUP-001',qty:1}])).rejects.toMatchObject({status:409});
    await expect(ship(424242,[{supplier_sku:'SUP-001',qty:1}])).rejects.toMatchObject({status:404});
  });

  it('never ships more than the ordered units under concurrent requests',async () => {
    const id = await acceptedOrder();
    const results = await Promise.allSettled([1,2,3].map(() => ship(id,[{supplier_sku:'SUP-001',qty:2}])));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(sqlite.prepare("SELECT SUM(qty) n FROM supplier_shipment_lines WHERE code='SUP-001'").get().n).toBe(2);
    expect(count('order_shipments')).toBe(1);
  });

  it('refuses new shipments once every unit has left',async () => {
    const id = await acceptedOrder();
    await ship(id,[{supplier_sku:'SUP-001',qty:2},{supplier_sku:'SUP-002',qty:1}]);
    await expect(ship(id,[{supplier_sku:'SUP-002',qty:1}])).rejects.toMatchObject({status:409});
    expect(count('supplier_shipments')).toBe(1);
  });
});

describe('explicit supplier statuses with line shipments',() => {
  it('ships every ordered unit in one shipment when the supplier reports shipped',async () => {
    const id = await acceptedOrder();
    const detail = await advanceOrder(db,id,'shipped');
    expect(detail.fulfillment.shipments).toHaveLength(1);
    expect(detail.fulfillment.shipments[0]).toMatchObject({sequence:1,units:3,tracking_number:detail.order.tracking_number});
    expect(detail.order.tracking_number).toMatch(/^DEMO-[0-9A-F]{8}$/);
    expect(detail.fulfillment.lines.every(line => line.pending === 0)).toBe(true);
  });

  it('ships only the remaining units after a partial shipment, once',async () => {
    const id = await acceptedOrder();
    await ship(id,[{supplier_sku:'SUP-001',qty:1}]);
    await Promise.all([advanceOrder(db,id,'shipped'),advanceOrder(db,id,'shipped')]);
    const detail = await advanceOrder(db,id,'shipped');
    expect(detail.fulfillment.shipments.map(shipment => shipment.lines.map(line => [line.supplier_sku,line.qty])))
      .toEqual([[['SUP-001',1]],[['SUP-001',1],['SUP-002',1]]]);
    expect(detail.order.supplier_status).toBe('SUPPLIER_SHIPPED');
    expect(detail.fulfillment.lines.every(line => line.pending === 0 && line.shipped === line.ordered)).toBe(true);
  });

  it('treats shipped as already done when a concurrent shipment completed the order first',async () => {
    const id = await acceptedOrder();
    // La expedición completa se cuela justo después de que «Enviado» lea el estado.
    const interleaved = {...db,prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.startsWith('SELECT * FROM supplier_orders WHERE reference = ?')) return statement;
      return {bind:(...values) => ({first:async () => {
        const row = await statement.bind(...values).first();
        if (row.status !== 'shipped') await ship(id,[{supplier_sku:'SUP-001',qty:2},{supplier_sku:'SUP-002',qty:1}]);
        return row;
      }})};
    }};
    const detail = await advanceOrder(interleaved,id,'shipped');
    expect(detail.order.supplier_status).toBe('SUPPLIER_SHIPPED');
    expect(detail.fulfillment.shipments).toHaveLength(1);
    expect(count('supplier_shipments')).toBe(1);
  });

  it('keeps the quantities sent to the supplier when the order is amended afterwards',async () => {
    const id = await acceptedOrder();
    await ship(id,[{supplier_sku:'SUP-001',qty:2}]);
    sqlite.exec(`UPDATE order_items SET current_qty=1 WHERE order_id=${id} AND qty=2`);
    const { fulfillment } = await getOrderDetail(db,id);
    expect(fulfillment.lines).toEqual([
      {supplier_sku:'SUP-001',name:'Champú demo',ordered:2,shipped:2,pending:0},
      {supplier_sku:'SUP-002',name:'Crema demo',ordered:1,shipped:0,pending:1},
    ]);
  });

  it('finds a partial order by the tracking of any of its shipments',async () => {
    const id = await acceptedOrder();
    const other = await acceptedOrder();
    const detail = await ship(id,[{supplier_sku:'SUP-001',qty:1}]);
    const tracking = detail.fulfillment.shipments[0].tracking_number;
    expect(detail.order.tracking_number).toBeNull();
    const found = await getOrderList(db,new URLSearchParams({q:tracking.toLowerCase()}));
    expect(found.orders.map(order => order.id)).toEqual([id]);
    expect(found.pagination.total).toBe(1);
    expect(other).not.toBe(id);
  });

  it('keeps registered shipments when a partial order goes back to preparation or error',async () => {
    const id = await acceptedOrder();
    await ship(id,[{supplier_sku:'SUP-001',qty:1}]);
    for (const [status,expected] of [['processing','SUPPLIER_PROCESSING'],['error','ERROR'],['partial','SUPPLIER_PARTIAL']]) {
      const detail = await advanceOrder(db,id,status);
      expect(detail.order.supplier_status).toBe(expected);
      expect(detail.fulfillment.shipments).toHaveLength(1);
    }
    const recovered = await ship(id,[{supplier_sku:'SUP-001',qty:1}]);
    expect(recovered.order.supplier_status).toBe('SUPPLIER_PARTIAL');
  });

  it('lists the order under partial shipments until it is complete',async () => {
    const id = await acceptedOrder();
    await ship(id,[{supplier_sku:'SUP-002',qty:1}]);
    const partial = await getOrderList(db,new URLSearchParams({supplier:'partial'}));
    expect(partial.orders.map(order => order.id)).toEqual([id]);
    await advanceOrder(db,id,'shipped');
    expect((await getOrderList(db,new URLSearchParams({supplier:'partial'}))).orders).toEqual([]);
  });
});

describe('marketplace acknowledgement per shipment',() => {
  it('acknowledges each shipment with its own tracking and lines',async () => {
    const id = await acceptedOrder('AMAZON');
    await ship(id,[{supplier_sku:'SUP-001',qty:2}]);
    const detail = await ship(id,[{supplier_sku:'SUP-002',qty:1}]);
    expect(detail.fulfillment.shipments.every(shipment => typeof shipment.marketplace_synced_at === 'string')).toBe(true);
    const acknowledgements = sqlite.prepare('SELECT tracking_number,lines_json,channel FROM marketplace_shipment_updates ORDER BY shipment_id').all();
    expect(acknowledgements.map(row => [row.channel,row.tracking_number,JSON.parse(row.lines_json)])).toEqual([
      ['AMAZON',detail.fulfillment.shipments[0].tracking_number,[{sku:'SUP-001',qty:2}]],
      ['AMAZON',detail.fulfillment.shipments[1].tracking_number,[{sku:'SUP-002',qty:1}]],
    ]);
    expect(detail.marketplace_sync).toMatchObject({supplier_status:'SUPPLIER_SHIPPED',tracking_number:detail.order.tracking_number});
  });

  it('does not acknowledge shipments of web orders',async () => {
    const id = await acceptedOrder('WEB');
    await ship(id,[{supplier_sku:'SUP-001',qty:1}]);
    expect(count('marketplace_shipment_updates')).toBe(0);
  });

  it('reconciles a shipment whose acknowledgement was lost, exactly once',async () => {
    const id = await acceptedOrder('MIRAVIA');
    await ship(id,[{supplier_sku:'SUP-001',qty:1}]);
    sqlite.exec('DELETE FROM marketplace_shipment_updates');
    expect((await getOrderDetail(db,id)).fulfillment.shipments[0].marketplace_synced_at).toBeNull();
    expect(await syncMarketplaceOrders(db)).toEqual({processed:1,errors:0});
    expect((await getOrderDetail(db,id)).fulfillment.shipments[0].marketplace_synced_at).toEqual(expect.any(String));
    expect(await syncMarketplaceOrders(db)).toEqual({processed:0,errors:0});
    expect(count('supplier_shipments')).toBe(1);
  });
});

describe('shipment APIs',() => {
  const origin = 'https://demo.test';
  it('registers a shipment through the panel action and validates its input',async () => {
    const id = await acceptedOrder();
    const detail = await performAction(db,{action:'ship-lines',order_id:id,idempotency_key:key(),lines:[{supplier_sku:'SUP-002',qty:1}]},origin);
    expect(detail.fulfillment.shipments).toHaveLength(1);
    for (const invalid of [
      {action:'ship-lines',order_id:id,lines:[{supplier_sku:'SUP-001',qty:1}]},
      {action:'ship-lines',order_id:id,idempotency_key:key(),lines:[]},
      {action:'ship-lines',order_id:id,idempotency_key:key(),lines:[{supplier_sku:'SUP-001',qty:-1}]},
      {action:'ship-lines',idempotency_key:key(),lines:[{supplier_sku:'SUP-001',qty:1}]},
    ]) await expect(performAction(db,invalid,origin)).rejects.toThrow();
    expect(count('supplier_shipments')).toBe(1);
  });

  it('registers a shipment through the supplier API',async () => {
    const id = await acceptedOrder();
    const call = body => supplierAction({params:{path:'shipments'},url:new URL(`${origin}/api/supplier/shipments`),
      request:new Request(`${origin}/api/supplier/shipments`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}),
      locals:{runtime:{env:{DB:db,DEMO_MODE:'true',OMNICHANNEL_DEMO:'true'}}}});
    const requestKey = key();
    const accepted = await call({order_id:id,idempotency_key:requestKey,lines:[{supplier_sku:'SUP-001',qty:1}]});
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).fulfillment.shipments).toHaveLength(1);
    expect((await call({order_id:id,idempotency_key:requestKey,lines:[{supplier_sku:'SUP-001',qty:1}]})).status).toBe(200);
    expect((await call({order_id:id,idempotency_key:key(),lines:[{supplier_sku:'SUP-001',qty:5}]})).status).toBe(409);
    expect((await call({order_id:id,lines:[{supplier_sku:'SUP-001',qty:1}]})).status).toBe(400);
    expect(count('supplier_shipments')).toBe(1);
  });
});

describe('shipment history migration',() => {
  it('turns every already shipped order into one complete, acknowledged shipment',async () => {
    const shippedId = await acceptedOrder('EBAY');
    const openId = await acceptedOrder('EBAY');
    await advanceOrder(db,shippedId,'shipped');
    await advanceOrder(db,openId,'partial');
    const before = (await getOrderDetail(db,shippedId)).fulfillment;
    // Reproduce el estado anterior a la migración: mismas cabeceras, sin expediciones.
    sqlite.exec('DELETE FROM marketplace_shipment_updates; DELETE FROM order_shipments; DELETE FROM supplier_shipments;');
    const migration = readMigration('0050_order_shipments.sql');
    sqlite.exec(migration.slice(migration.indexOf('-- Histórico')));
    const after = (await getOrderDetail(db,shippedId)).fulfillment;
    expect(after.lines).toEqual(before.lines);
    expect(after.shipments.map(({id:_id,shipped_at:_at,marketplace_synced_at:_sync,...shipment}) => shipment))
      .toEqual(before.shipments.map(({id:_id,shipped_at:_at,marketplace_synced_at:_sync,...shipment}) => shipment));
    expect(after.shipments[0].marketplace_synced_at).toEqual(expect.any(String));
    expect((await getOrderDetail(db,openId)).fulfillment.shipments).toEqual([]);
    // La expedición restaurada sigue siendo idempotente para «Enviado + tracking».
    await advanceOrder(db,shippedId,'shipped');
    expect(count('supplier_shipments')).toBe(1);
  });
});
