import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceOrder, cancelOrder, createDemoOrder, dispatchOrder, getOrderDetail, getOrderList, getProducts,
  performAction, shipOrderLines, syncMarketplaceOrders, syncSupplier,
} from '../src/lib/demo';
import { MockSupplierAdapter } from '../src/integrations/mock-supplier-adapter';
import { d1Adapter, hookedD1, migratedDatabase } from './helpers/d1.mjs';

let sqlite;
let db;
const origin = 'https://demo.test';
const customer = {name:'Laura Demo',email:'laura@example.test',street:'Calle Ficticia 10',city:'Castellón',postal_code:'12001'};
const count = (table, where = '1=1') => sqlite.prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`).get().n;
const supplierStock = () => sqlite.prepare("SELECT stock FROM supplier_products WHERE code='SUP-001'").get().stock;
const storeStock = async () => (await getProducts(db)).find(product => product.slug === 'champu-demo').stock;
const key = () => crypto.randomUUID();
async function paidOrder(channel = 'WEB', qty = 2) {
  return (await createDemoOrder(db,{lines:[{slug:'champu-demo',qty}],customer,idempotency_key:key()},channel)).order_id;
}
const cancel = (id, input = {}) => cancelOrder(db,id,{reason:'customer_request',source:'panel',...input});

beforeEach(async () => {
  sqlite = migratedDatabase();
  sqlite.exec(`INSERT INTO supplier_products(code,slug,name,description,price_cents,pvp_cents,brand,category,image,ean,sku,stock) VALUES
    ('SUP-001','champu-demo','Champú demo','Producto ficticio',1290,1590,'Dermocare','capilar','/images/demo.svg','2000000000008','FH-001',18);
    INSERT INTO shipping_rates(zone,label,price_cents,free_over_cents) VALUES ('peninsula','Envío demo',490,4900);`);
  db = d1Adapter(sqlite);
  await syncSupplier(db);
});
afterEach(() => { sqlite.close(); });

describe('cancelling before the supplier receives the order',() => {
  it('cancels the order, returns the store stock and frees the local commitment',async () => {
    const id = await paidOrder();
    expect(await storeStock()).toBe(16);
    const detail = await cancel(id);
    expect(detail.order.status).toBe('cancelled');
    expect(detail.cancellation).toMatchObject({source:'panel',reason:'customer_request',supplier_outcome:'not_required',marketplace_synced_at:null});
    expect(detail.cancellation.cancelled_at).toEqual(expect.any(String));
    expect(await storeStock()).toBe(18);
    expect(supplierStock()).toBe(18);
    await syncSupplier(db);
    expect(await storeStock()).toBe(18);
    expect(count('supplier_orders')).toBe(0);
  });

  it('is idempotent: repeating or racing the request keeps one cancellation and one restock',async () => {
    const id = await paidOrder();
    const results = await Promise.all([cancel(id),cancel(id),cancel(id,{reason:'duplicate'})]);
    expect(results.every(detail => detail.order.status === 'cancelled')).toBe(true);
    const events = count('order_events');
    const again = await cancel(id,{reason:'other'});
    expect(again.cancellation.reason).toBe(results[0].cancellation.reason);
    expect(again.events.filter(event => event.to_status === 'cancelled').map(event => event.note))
      .toEqual([`Cancelado desde el panel · ${results[0].cancellation.reason === 'duplicate' ? 'pedido duplicado' : 'lo solicita el cliente'}`]);
    expect(count('order_cancellations')).toBe(1);
    expect(count('order_events')).toBe(events);
    expect(await storeStock()).toBe(18);
  });

  it('blocks supplier actions once the order is cancelled',async () => {
    const id = await paidOrder();
    await cancel(id);
    await expect(dispatchOrder(db,id)).rejects.toMatchObject({status:409});
    await expect(advanceOrder(db,id,'processing')).rejects.toMatchObject({status:409});
    expect(count('supplier_orders')).toBe(0);
    expect((await getOrderList(db,new URLSearchParams({supplier:'pending_dispatch'}))).orders).toEqual([]);
  });
});

describe('cancelling an order the supplier already accepted',() => {
  it('asks the supplier first, which returns the units to its stock',async () => {
    const id = await paidOrder();
    await dispatchOrder(db,id);
    await advanceOrder(db,id,'processing');
    expect(supplierStock()).toBe(16);
    const detail = await cancel(id,{reason:'out_of_stock'});
    expect(detail.order.status).toBe('cancelled');
    expect(detail.cancellation).toMatchObject({reason:'out_of_stock',supplier_outcome:'accepted'});
    expect(supplierStock()).toBe(18);
    expect(await storeStock()).toBe(18);
    await syncSupplier(db);
    expect(await storeStock()).toBe(18);
  });

  it('returns the supplier units once under repeated and concurrent requests',async () => {
    const id = await paidOrder();
    await dispatchOrder(db,id);
    await Promise.all([cancel(id),cancel(id)]);
    await cancel(id);
    expect(supplierStock()).toBe(18);
    expect(count('supplier_order_cancellations')).toBe(1);
    expect(count('order_cancellations')).toBe(1);
  });

  it('leaves the supplier situation filters once cancelled',async () => {
    const id = await paidOrder();
    await dispatchOrder(db,id);
    const accepted = () => getOrderList(db,new URLSearchParams({supplier:'accepted'}));
    expect((await accepted()).orders.map(order => order.id)).toEqual([id]);
    await cancel(id);
    expect((await accepted()).orders).toEqual([]);
    expect((await getOrderList(db,new URLSearchParams({status:'cancelled'}))).orders.map(order => order.id)).toEqual([id]);
  });

  it('refuses further supplier updates and shipments after the cancellation',async () => {
    const id = await paidOrder();
    await dispatchOrder(db,id);
    await cancel(id);
    await expect(advanceOrder(db,id,'shipped')).rejects.toMatchObject({status:409});
    await expect(shipOrderLines(db,id,{lines:[{supplier_sku:'SUP-001',qty:1}],idempotency_key:key()})).rejects.toMatchObject({status:409});
    expect(count('supplier_shipments')).toBe(0);
    expect(supplierStock()).toBe(18);
  });

  it.each(['partial shipment','complete shipment'])('is rejected after a %s and changes nothing',async (kind) => {
    const id = await paidOrder();
    await dispatchOrder(db,id);
    await shipOrderLines(db,id,{lines:[{supplier_sku:'SUP-001',qty:kind === 'partial shipment' ? 1 : 2}],idempotency_key:key()});
    await expect(cancel(id)).rejects.toMatchObject({status:409});
    await expect(cancel(id)).rejects.toMatchObject({status:409});
    const detail = await getOrderDetail(db,id);
    expect(detail.order.status).toBe(kind === 'partial shipment' ? 'paid' : 'shipped');
    expect(detail.cancellation).toBeNull();
    expect(supplierStock()).toBe(16);
    expect(count('order_cancellations')).toBe(0);
    // Un rechazo repetido no llena el historial de avisos idénticos.
    expect(detail.events.filter(event => /Cancelación rechazada/.test(event.note ?? ''))).toHaveLength(1);
  });

  it('never lets a shipment and a cancellation both succeed',async () => {
    const id = await paidOrder();
    await dispatchOrder(db,id);
    const [shipment, cancellation] = await Promise.allSettled([
      shipOrderLines(db,id,{lines:[{supplier_sku:'SUP-001',qty:2}],idempotency_key:key()}), cancel(id),
    ]);
    expect([shipment.status,cancellation.status].filter(status => status === 'fulfilled')).toHaveLength(1);
    const detail = await getOrderDetail(db,id);
    expect(detail.order.status).toBe(shipment.status === 'fulfilled' ? 'shipped' : 'cancelled');
    expect(supplierStock()).toBe(shipment.status === 'fulfilled' ? 16 : 18);
  });

  it('cancels at the supplier an order that was dispatched while it was being cancelled',async () => {
    const id = await paidOrder();
    const results = await Promise.allSettled([dispatchOrder(db,id),cancel(id)]);
    expect(results[1].status).toBe('fulfilled');
    const detail = await getOrderDetail(db,id);
    expect(detail.order.status).toBe('cancelled');
    expect(supplierStock()).toBe(18);
    expect(await storeStock()).toBe(18);
  });
});

describe('cancellations under interleaved requests and interruptions',() => {
  it('keeps the units committed while the supplier has cancelled but the store has not',async () => {
    const id = await paidOrder();
    await dispatchOrder(db,id);
    const order = await getOrderDetail(db,id);
    // Estado intermedio de una cancelación: el proveedor ya repuso, la tienda aún no.
    await new MockSupplierAdapter(db).cancelOrder(order.order.order_number);
    await syncSupplier(db);
    expect(await storeStock()).toBe(16);
    await cancel(id);
    expect(await storeStock()).toBe(18);
    await syncSupplier(db);
    expect(await storeStock()).toBe(18);
  });

  it('completes the cancellation when the store restock collides with another stock write',async () => {
    const id = await paidOrder();
    await dispatchOrder(db,id);
    const hooked = hookedD1(sqlite);
    hooked.on(/INSERT INTO inventory_movements/,() => { throw new Error('UNIQUE constraint failed: inventory_movements.variant_id, version_after'); });
    const detail = await cancelOrder(hooked.db,id,{reason:'customer_request',source:'panel'});
    expect(detail.order.status).toBe('cancelled');
    expect(await storeStock()).toBe(18);
    expect(supplierStock()).toBe(18);
  });

  it('asks to retry, without losing anything, when the store restock keeps failing',async () => {
    const id = await paidOrder();
    await dispatchOrder(db,id);
    const failing = hookedD1(sqlite);
    const original = failing.db.batch;
    failing.db.batch = async (statements) => {
      if (statements.some(statement => /INSERT INTO inventory_movements/.test(statement.sql))) throw new Error('D1 no disponible');
      return original(statements);
    };
    await expect(cancelOrder(failing.db,id,{reason:'duplicate',source:'panel'})).rejects.toMatchObject({status:409});
    expect((await getOrderDetail(db,id)).order.status).toBe('paid');
    expect((await getOrderDetail(db,id)).cancellation).toBeNull();
    const detail = await cancel(id,{reason:'other'});
    expect(detail.order.status).toBe('cancelled');
    expect(detail.cancellation).toMatchObject({reason:'duplicate',supplier_outcome:'accepted'});
    expect(await storeStock()).toBe(18);
    expect(supplierStock()).toBe(18);
  });

  it('does not tell the marketplace about a cancellation that has not happened yet',async () => {
    const id = await paidOrder('AMAZON');
    const failing = hookedD1(sqlite);
    const original = failing.db.batch;
    failing.db.batch = async (statements) => {
      if (statements.some(statement => /INSERT INTO inventory_movements/.test(statement.sql))) throw new Error('D1 no disponible');
      return original(statements);
    };
    await expect(cancelOrder(failing.db,id,{reason:'duplicate',source:'marketplace'})).rejects.toMatchObject({status:409});
    await syncMarketplaceOrders(db);
    // Cualquier otro acuse del pedido, como su envío al proveedor, tampoco la adelanta.
    await dispatchOrder(db,id);
    expect(count('marketplace_cancellation_updates')).toBe(0);
    expect((await getOrderDetail(db,id)).order.status).toBe('paid');
    await cancel(id);
    expect(count('marketplace_cancellation_updates')).toBe(1);
  });

  it('answers the slower of two simultaneous cancellations without an error',async () => {
    const id = await paidOrder();
    const hooked = hookedD1(sqlite);
    hooked.on(/FROM payment_intents|FROM payments/,async () => { await cancel(id,{reason:'duplicate'}); });
    const detail = await cancelOrder(hooked.db,id,{reason:'customer_request',source:'panel'});
    expect(detail.order.status).toBe('cancelled');
    expect(count('order_cancellations')).toBe(1);
    expect(await storeStock()).toBe(18);
  });

  it('keeps the requested origin when a dispatch overlaps the cancellation',async () => {
    const id = await paidOrder('AMAZON');
    const hooked = hookedD1(sqlite);
    let dispatch;
    // El envío al proveedor se cuela justo antes de que el núcleo cancele.
    hooked.on(/SELECT id, order_number, email, customer_name, status/,async () => { dispatch = await dispatchOrder(db,id).catch(error => error); });
    const detail = await cancelOrder(hooked.db,id,{reason:'customer_request',source:'marketplace'});
    expect(detail.order.status).toBe('cancelled');
    expect(detail.cancellation).toMatchObject({source:'marketplace',reason:'customer_request',supplier_outcome:'accepted'});
    expect(detail.events.filter(event => event.to_status === 'cancelled').map(event => event.note))
      .toEqual(['Cancelado a petición del marketplace · lo solicita el cliente']);
    expect(dispatch.order?.supplier_status ?? dispatch.status).toBeDefined();
    expect(supplierStock()).toBe(18);
    expect(await storeStock()).toBe(18);
  });

  it('answers 409, not a supplier error, to a dispatch that loses against the cancellation',async () => {
    const id = await paidOrder();
    const hooked = hookedD1(sqlite);
    // La cancelación termina mientras el proveedor está aceptando el pedido.
    hooked.on(/INSERT INTO supplier_orders/,async () => { await cancel(id); },'after');
    await expect(dispatchOrder(hooked.db,id)).rejects.toMatchObject({status:409});
    const detail = await getOrderDetail(db,id);
    expect(detail.order).toMatchObject({status:'cancelled'});
    expect(detail.cancellation).toMatchObject({source:'panel',reason:'customer_request',supplier_outcome:'accepted'});
    expect(detail.events.some(event => /aceptó el pedido/.test(event.note ?? ''))).toBe(false);
    expect(supplierStock()).toBe(18);
  });

  it('records durably that the supplier shipped units of an order cancelled at the same time',async () => {
    const id = await paidOrder();
    const hooked = hookedD1(sqlite);
    hooked.on(/SELECT id, order_number, email, customer_name, status/,async () => {
      await dispatchOrder(db,id);
      await shipOrderLines(db,id,{lines:[{supplier_sku:'SUP-001',qty:1}],idempotency_key:key()});
    });
    const detail = await cancelOrder(hooked.db,id,{reason:'customer_request',source:'panel'});
    expect(detail.order.status).toBe('cancelled');
    expect(detail.cancellation.supplier_outcome).toBe('rejected');
    expect(count('integration_events',"title LIKE 'Incidencia de cancelación%'")).toBe(1);
    await cancel(id);
    expect(count('integration_events',"title LIKE 'Incidencia de cancelación%'")).toBe(1);
  });

  it('completes from the reconciliation a cancellation interrupted before it was recorded',async () => {
    const id = await paidOrder('EBAY');
    await dispatchOrder(db,id);
    const hooked = hookedD1(sqlite);
    hooked.on(/UPDATE order_cancellations SET/,() => { throw new Error('conexión interrumpida'); });
    await expect(cancelOrder(hooked.db,id,{reason:'out_of_stock',source:'marketplace'})).rejects.toThrow();
    const interrupted = await getOrderDetail(db,id);
    expect(interrupted.order.status).toBe('cancelled');
    expect(interrupted.cancellation).toMatchObject({source:'marketplace',reason:'out_of_stock',cancelled_at:null});
    expect(count('marketplace_cancellation_updates')).toBe(0);
    expect(await syncMarketplaceOrders(db)).toEqual({processed:1,errors:0});
    const repaired = await getOrderDetail(db,id);
    expect(repaired.cancellation).toMatchObject({supplier_outcome:'accepted'});
    expect(repaired.cancellation.cancelled_at).toEqual(expect.any(String));
    expect(repaired.cancellation.marketplace_synced_at).toEqual(expect.any(String));
    expect(await syncMarketplaceOrders(db)).toEqual({processed:0,errors:0});
  });

  it('cancels at the supplier, from the reconciliation, an order left active by an interrupted dispatch',async () => {
    const id = await paidOrder();
    await cancel(id);
    const order = (await getOrderDetail(db,id)).order;
    // Un envío interrumpido dejó el pedido creado en el proveedor después de la cancelación.
    await new MockSupplierAdapter(db).createOrder({reference:order.order_number,items:[{code:'SUP-001',qty:2}]});
    expect(supplierStock()).toBe(16);
    await syncMarketplaceOrders(db);
    expect(supplierStock()).toBe(18);
    expect((await getOrderDetail(db,id)).cancellation.supplier_outcome).toBe('accepted');
  });

  it('does not accept again an order the supplier already cancelled',async () => {
    const id = await paidOrder();
    await dispatchOrder(db,id);
    const order = (await getOrderDetail(db,id)).order;
    const adapter = new MockSupplierAdapter(db);
    await adapter.cancelOrder(order.order_number);
    await expect(adapter.createOrder({reference:order.order_number,items:[{code:'SUP-001',qty:2}]})).rejects.toMatchObject({code:'order_cancelled'});
  });
});

describe('cancellations and the marketplace',() => {
  it('acknowledges a cancelled marketplace order to the hub, once',async () => {
    const id = await paidOrder('AMAZON');
    await dispatchOrder(db,id);
    const detail = await cancel(id,{source:'marketplace'});
    expect(detail.cancellation).toMatchObject({source:'marketplace',supplier_outcome:'accepted'});
    expect(detail.cancellation.marketplace_synced_at).toEqual(expect.any(String));
    expect(detail.events.filter(event => event.to_status === 'cancelled').map(event => event.note))
      .toEqual(['Cancelado a petición del marketplace · lo solicita el cliente']);
    expect(sqlite.prepare('SELECT channel,reference FROM marketplace_cancellation_updates').all())
      .toEqual([{channel:'AMAZON',reference:detail.order.order_number}]);
    expect(await syncMarketplaceOrders(db)).toEqual({processed:0,errors:0});
  });

  it('reconciles a lost cancellation acknowledgement',async () => {
    const id = await paidOrder('EBAY');
    await cancel(id);
    sqlite.exec('DELETE FROM marketplace_cancellation_updates');
    expect((await getOrderDetail(db,id)).cancellation.marketplace_synced_at).toBeNull();
    expect(await syncMarketplaceOrders(db)).toEqual({processed:1,errors:0});
    expect((await getOrderDetail(db,id)).cancellation.marketplace_synced_at).toEqual(expect.any(String));
  });

  it('only accepts a marketplace origin for marketplace orders',async () => {
    const id = await paidOrder('WEB');
    await expect(cancel(id,{source:'marketplace'})).rejects.toMatchObject({status:409});
    expect((await getOrderDetail(db,id)).order.status).toBe('paid');
  });
});

describe('cancellation input and actions',() => {
  it('validates reason, source and order',async () => {
    const id = await paidOrder();
    await expect(cancelOrder(db,id,{reason:'because',source:'panel'})).rejects.toThrow();
    await expect(cancelOrder(db,id,{reason:'other',source:'email'})).rejects.toThrow();
    await expect(cancelOrder(db,id,{source:'panel'})).rejects.toThrow();
    await expect(cancel(424242)).rejects.toMatchObject({status:404});
    expect((await getOrderDetail(db,id)).order.status).toBe('paid');
  });

  it('cancels through the panel action',async () => {
    const id = await paidOrder('MIRAVIA');
    const detail = await performAction(db,{action:'cancel-order',order_id:id,reason:'duplicate',source:'marketplace'},origin);
    expect(detail.order.status).toBe('cancelled');
    expect(detail.cancellation).toMatchObject({reason:'duplicate',source:'marketplace'});
    await expect(performAction(db,{action:'cancel-order',order_id:id},origin)).rejects.toThrow();
  });

  it('reports no cancellation for active orders',async () => {
    const id = await paidOrder();
    expect((await getOrderDetail(db,id)).cancellation).toBeNull();
  });
});
