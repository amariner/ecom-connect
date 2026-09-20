import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceOrder, cancelOrder, createDemoOrder, dispatchOrder, getState, shipOrderLines, syncMarketplaceOrders, syncSupplier,
} from '../src/lib/demo';
import { d1Adapter, hookedD1, migratedDatabase } from './helpers/d1.mjs';

let sqlite;
let db;
const customer = {name:'Laura Demo',email:'laura@example.test',street:'Calle Ficticia 10',city:'Castellón',postal_code:'12001'};
const key = () => crypto.randomUUID();
async function order(channel = 'WEB', qty = 2) {
  return (await createDemoOrder(db,{lines:[{slug:'champu-demo',qty}],customer,idempotency_key:key()},channel)).order_id;
}
const attention = async () => (await getState(db,'https://demo.test')).attention;
const item = async (kind) => (await attention()).items.find(entry => entry.kind === kind);

beforeEach(async () => {
  sqlite = migratedDatabase();
  sqlite.exec(`INSERT INTO supplier_products(code,slug,name,description,price_cents,pvp_cents,brand,category,image,ean,sku,stock) VALUES
    ('SUP-001','champu-demo','Champú demo','Producto ficticio',1290,1590,'Dermocare','capilar','/images/demo.svg','2000000000008','FH-001',40);
    INSERT INTO shipping_rates(zone,label,price_cents,free_over_cents) VALUES ('peninsula','Envío demo',490,4900);`);
  db = d1Adapter(sqlite);
  await syncSupplier(db);
});
afterEach(() => { sqlite.close(); });

describe('orders that need attention',() => {
  it('is empty while every order follows its normal course',async () => {
    const id = await order('AMAZON');
    await dispatchOrder(db,id);
    await advanceOrder(db,id,'shipped');
    await order('WEB');
    expect(await attention()).toEqual({total:0,items:[
      {kind:'supplier_error',count:0,orders:[]},{kind:'partial_shipment',count:0,orders:[]},
      {kind:'marketplace_ack',count:0,orders:[]},{kind:'cancellation',count:0,orders:[]},
      {kind:'customer_return',count:0,orders:[]},
    ]});
  });

  it('lists supplier errors until the order recovers',async () => {
    const id = await order();
    await dispatchOrder(db,id);
    await advanceOrder(db,id,'error');
    const entry = await item('supplier_error');
    expect(entry.count).toBe(1);
    expect(entry.orders).toEqual([{id,order_number:expect.stringMatching(/^FH-/),channel:'WEB'}]);
    await advanceOrder(db,id,'processing');
    expect((await item('supplier_error')).count).toBe(0);
  });

  it('lists an order that could not be dispatched for lack of supplier stock',async () => {
    const id = await order('WEB',3);
    sqlite.exec("UPDATE supplier_products SET stock=1 WHERE code='SUP-001'");
    await expect(dispatchOrder(db,id)).rejects.toMatchObject({status:409});
    expect((await item('supplier_error')).orders.map(entry => entry.id)).toEqual([id]);
  });

  it('lists partial shipments until every unit has left',async () => {
    const id = await order('EBAY',3);
    await dispatchOrder(db,id);
    await shipOrderLines(db,id,{lines:[{supplier_sku:'SUP-001',qty:1}],idempotency_key:key()});
    expect((await item('partial_shipment')).orders.map(entry => [entry.id,entry.channel])).toEqual([[id,'EBAY']]);
    await advanceOrder(db,id,'shipped');
    expect((await attention()).total).toBe(0);
  });

  it('lists marketplace orders whose acknowledgement is pending, and clears them on reconciliation',async () => {
    const shipped = await order('MIRAVIA');
    await dispatchOrder(db,shipped);
    await advanceOrder(db,shipped,'shipped');
    const cancelled = await order('AMAZON');
    await cancelOrder(db,cancelled,{reason:'duplicate',source:'marketplace'});
    sqlite.exec('DELETE FROM marketplace_shipment_updates; DELETE FROM marketplace_cancellation_updates;');
    const entry = await item('marketplace_ack');
    expect(entry.count).toBe(2);
    expect(entry.orders.map(row => row.id)).toEqual([cancelled,shipped]);
    await syncMarketplaceOrders(db);
    expect((await attention()).total).toBe(0);
  });

  it('never counts web orders as pending acknowledgement',async () => {
    const id = await order('WEB');
    await dispatchOrder(db,id);
    await advanceOrder(db,id,'shipped');
    expect((await item('marketplace_ack')).count).toBe(0);
  });

  it('lists a cancellation the supplier could not honour',async () => {
    const id = await order();
    const hooked = hookedD1(sqlite);
    hooked.on(/SELECT id, order_number, email, customer_name, status/,async () => {
      await dispatchOrder(db,id);
      await shipOrderLines(db,id,{lines:[{supplier_sku:'SUP-001',qty:1}],idempotency_key:key()});
    });
    await cancelOrder(hooked.db,id,{reason:'customer_request',source:'panel'});
    expect((await item('cancellation')).orders.map(entry => entry.id)).toEqual([id]);
    // Un pedido cancelado deja de contar como envío parcial por completar.
    expect((await item('partial_shipment')).count).toBe(0);
  });

  it('lists an interrupted cancellation until it is completed',async () => {
    const id = await order('CARREFOUR');
    const hooked = hookedD1(sqlite);
    hooked.on(/UPDATE order_cancellations SET/,() => { throw new Error('conexión interrumpida'); });
    await expect(cancelOrder(hooked.db,id,{reason:'other',source:'panel'})).rejects.toThrow();
    expect((await item('cancellation')).count).toBe(1);
    await syncMarketplaceOrders(db);
    expect((await attention()).total).toBe(0);
  });

  it('counts every order but lists only the five most recent of each kind',async () => {
    const ids = [];
    for (let index = 0; index < 7; index++) {
      const id = await order();
      await dispatchOrder(db,id);
      await advanceOrder(db,id,'error');
      ids.push(id);
    }
    const state = await attention();
    const entry = state.items.find(row => row.kind === 'supplier_error');
    expect(entry.count).toBe(7);
    expect(entry.orders.map(row => row.id)).toEqual(ids.slice(-5).reverse());
    expect(state.total).toBe(7);
    expect(entry.orders.every(row => Object.keys(row).sort().join() === 'channel,id,order_number')).toBe(true);
  });
});
