import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advanceOrder, createDemoOrder, deliverOrder, dispatchOrder, getOrderDetail, getState, performAction, syncSupplier,
} from '../src/lib/demo';
import {
  cancelAccountReturn, listAccountReturns, openAccountSession, readAccountOrder, readAccountReturn,
  requestAccessLink, requestAccountReturn,
} from '../src/lib/account';
import { d1Adapter, hookedD1, migratedDatabase } from './helpers/d1.mjs';

let sqlite;
let db;
const origin = 'https://demo.test';
const buyer = {name:'Laura Demo',email:'laura@example.test',street:'Calle Ficticia 10',city:'Castellón',postal_code:'12001'};
const key = () => crypto.randomUUID();
const row = (sql, ...values) => sqlite.prepare(sql).get(...values);
const count = (table, where = '1=1') => row(`SELECT count(*) n FROM ${table} WHERE ${where}`).n;
const stock = () => row("SELECT stock s FROM products WHERE slug='champu-demo'").s;

async function signIn(email = buyer.email) {
  const {link} = await requestAccessLink(db,{email},origin);
  return openAccountSession(db,new URL(link).searchParams.get('codigo'));
}
/** Un pedido que ha recorrido todo el circuito: pagado, enviado y entregado. */
async function deliveredOrder(qty = 2) {
  const created = await createDemoOrder(db,{lines:[{slug:'champu-demo',qty}],customer:buyer,idempotency_key:key()});
  await dispatchOrder(db,created.order_id);
  await advanceOrder(db,created.order_id,'shipped');
  await deliverOrder(db,created.order_id);
  return created;
}
async function ownOrder(session) {
  const detail = await readAccountOrder(db,session,
    row('SELECT public_ref p FROM customer_order_access_refs ORDER BY order_id DESC').p);
  return detail;
}
const itemId = () => row("SELECT id FROM order_items ORDER BY id DESC").id;

beforeEach(async () => {
  sqlite = migratedDatabase();
  sqlite.exec(`INSERT INTO supplier_products(code,slug,name,description,price_cents,pvp_cents,brand,category,image,ean,sku,stock) VALUES
    ('SUP-001','champu-demo','Champú demo','Producto ficticio',1290,1590,'Dermocare','capilar','/images/demo.svg','2000000000008','FH-001',18);
    INSERT INTO shipping_rates(zone,label,price_cents,free_over_cents) VALUES ('peninsula','Envío demo',490,4900);`);
  db = d1Adapter(sqlite);
  await syncSupplier(db);
});
afterEach(() => { sqlite.close(); });

describe('confirmar la entrega', () => {
  it('cierra el recorrido del pedido y deja constancia una sola vez', async () => {
    const created = await deliveredOrder();
    const detail = await getOrderDetail(db,created.order_id);
    expect(detail.order.status).toBe('delivered');
    expect(detail.events.at(-1)).toMatchObject({to_status:'delivered'});
    const again = await deliverOrder(db,created.order_id);
    expect(again.order.status).toBe('delivered');
    expect(count('order_events',"to_status='delivered'")).toBe(1);
  });

  it('no confirma la entrega de un pedido que no ha salido', async () => {
    const created = await createDemoOrder(db,{lines:[{slug:'champu-demo',qty:1}],customer:buyer,idempotency_key:key()});
    await expect(deliverOrder(db,created.order_id)).rejects.toThrow(/ya enviado/);
    expect(row('SELECT status s FROM orders').s).toBe('paid');
  });
});

describe('pedir una devolución', () => {
  it('solo se ofrece cuando el pedido consta entregado', async () => {
    const created = await createDemoOrder(db,{lines:[{slug:'champu-demo',qty:2}],customer:buyer,idempotency_key:key()});
    const {session} = await signIn();
    expect((await ownOrder(session)).return_window).toMatchObject({open:false,reason:expect.stringContaining('entregado')});
    await dispatchOrder(db,created.order_id);
    await advanceOrder(db,created.order_id,'shipped');
    await deliverOrder(db,created.order_id);
    const delivered = await ownOrder(session);
    expect(delivered.return_window).toMatchObject({open:true,days_left:30});
    expect(delivered.returnable_lines).toEqual([expect.objectContaining({purchased:2,claimed:0,name:'Champú demo'})]);
  });

  it('registra la solicitud con sus líneas, su motivo y su primer movimiento', async () => {
    await deliveredOrder();
    const {session} = await signIn();
    const order = await ownOrder(session);
    const created = await requestAccountReturn(db,session,{action:'devolver',public_ref:order.public_ref,
      idempotency_key:key(),reason:'damaged',comment:'Llegó con el tapón roto',lines:[{order_item_id:itemId(),qty:1}]});
    expect(created).toMatchObject({status:'requested',reason:'damaged',refund_cents:0,comment:'Llegó con el tapón roto'});
    expect(created.return_number).toMatch(/^DEV-\d{6}-[A-Z0-9]{4}$/);
    expect(created.public_ref).toMatch(/^ret_[a-f0-9]{32}$/);
    expect(created.lines).toEqual([expect.objectContaining({qty:1,unit_price_cents:1290,name:'Champú demo'})]);
    expect(created.events).toEqual([expect.objectContaining({to_status:'requested',actor:'customer'})]);
    const detail = await ownOrder(session);
    expect(detail.returns).toHaveLength(1);
    expect(detail.return_window).toMatchObject({open:false,reason:expect.stringContaining('en curso')});
    expect(await listAccountReturns(db,session)).toHaveLength(1);
  });

  it('no deja devolver más unidades de las compradas', async () => {
    await deliveredOrder(2);
    const {session} = await signIn();
    const order = await ownOrder(session);
    await expect(requestAccountReturn(db,session,{action:'devolver',public_ref:order.public_ref,
      idempotency_key:key(),reason:'other',comment:'',lines:[{order_item_id:itemId(),qty:3}]}))
      .rejects.toThrow(/solo puedes devolver 2/);
    expect(count('order_returns')).toBe(0);
  });

  it('repetir el mismo envío no abre una segunda devolución', async () => {
    await deliveredOrder();
    const {session} = await signIn();
    const order = await ownOrder(session);
    const payload = {action:'devolver',public_ref:order.public_ref,idempotency_key:key(),
      reason:'other',comment:'',lines:[{order_item_id:itemId(),qty:1}]};
    const first = await requestAccountReturn(db,session,payload);
    const replay = await requestAccountReturn(db,session,payload);
    expect(replay.public_ref).toBe(first.public_ref);
    expect(count('order_returns')).toBe(1);
  });

  it('no acepta la devolución del pedido de otra persona', async () => {
    await deliveredOrder();
    const laura = await signIn('laura@example.test');
    const order = await ownOrder(laura.session);
    const intruder = await signIn('otra@example.test');
    await expect(requestAccountReturn(db,intruder.session,{action:'devolver',public_ref:order.public_ref,
      idempotency_key:key(),reason:'other',comment:'',lines:[{order_item_id:itemId(),qty:1}]}))
      .rejects.toThrow(/No encontramos este pedido/);
    expect(count('order_returns')).toBe(0);
  });

  it('cierra el plazo a los treinta días de la entrega', async () => {
    await deliveredOrder();
    const {session} = await signIn();
    const order = await ownOrder(session);
    sqlite.prepare("UPDATE order_events SET created_at=? WHERE to_status='delivered'")
      .run(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString());
    expect((await ownOrder(session)).return_window).toMatchObject({open:false,reason:expect.stringContaining('30 días')});
    await expect(requestAccountReturn(db,session,{action:'devolver',public_ref:order.public_ref,
      idempotency_key:key(),reason:'other',comment:'',lines:[{order_item_id:itemId(),qty:1}]}))
      .rejects.toThrow(/plazo/);
  });
});

describe('tramitar la devolución', () => {
  async function openReturn(qty = 1) {
    await deliveredOrder(2);
    const {session} = await signIn();
    const order = await ownOrder(session);
    const created = await requestAccountReturn(db,session,{action:'devolver',public_ref:order.public_ref,
      idempotency_key:key(),reason:'defective',comment:'',lines:[{order_item_id:itemId(),qty}]});
    return {session,order,created};
  }
  const decide = (id, decision, note) => performAction(db,{action:'decide-return',return_id:id,decision,...(note ? {note} : {})},origin);

  it('acepta, recibe y reembolsa, reponiendo el stock una sola vez', async () => {
    const {created,session} = await openReturn();
    const id = row('SELECT id FROM order_returns').id;
    expect(stock()).toBe(16);

    await decide(id,'accept','Envíalo a nuestra dirección demo');
    expect(row('SELECT status s FROM order_returns').s).toBe('accepted');
    expect(stock()).toBe(16);

    await decide(id,'receive');
    expect(row('SELECT status s FROM order_returns').s).toBe('received');
    expect(stock()).toBe(17);

    const refunded = await decide(id,'refund');
    expect(refunded.returns[0]).toMatchObject({status:'refunded',refund_cents:1290});
    expect(stock()).toBe(17);
    const seen = await readAccountReturn(db,session,{public_ref:created.public_ref});
    expect(seen).toMatchObject({status:'refunded',refund_cents:1290,decision_note:'Envíalo a nuestra dirección demo'});
    expect(seen.events.map(event => event.to_status)).toEqual(['requested','accepted','received','refunded']);
  });

  it('no salta pasos ni repite una decisión', async () => {
    await openReturn();
    const id = row('SELECT id FROM order_returns').id;
    await expect(decide(id,'refund')).rejects.toThrow(/recepción/);
    await expect(decide(id,'receive')).rejects.toThrow(/Acepta la devolución/);
    await decide(id,'accept');
    await expect(decide(id,'accept')).rejects.toThrow(/pendiente de revisar/);
    expect(count('order_return_events')).toBe(2);
  });

  it('rechazar libera las unidades para una solicitud nueva', async () => {
    const {session,order} = await openReturn(2);
    const id = row('SELECT id FROM order_returns').id;
    await decide(id,'reject','Nos ha llegado fuera de plazo');
    expect(row('SELECT status s,decision_note d FROM order_returns')).toMatchObject({s:'rejected',d:'Nos ha llegado fuera de plazo'});
    expect(stock()).toBe(16);
    const retry = await requestAccountReturn(db,session,{action:'devolver',public_ref:order.public_ref,
      idempotency_key:key(),reason:'other',comment:'',lines:[{order_item_id:itemId(),qty:2}]});
    expect(retry.status).toBe('requested');
    expect(count('order_returns')).toBe(2);
  });

  it('el comprador anula su solicitud solo mientras nadie la tramita', async () => {
    const {session,created} = await openReturn();
    const cancelled = await cancelAccountReturn(db,session,{public_ref:created.public_ref});
    expect(cancelled.status).toBe('cancelled');
    const second = await requestAccountReturn(db,session,{action:'devolver',public_ref:(await ownOrder(session)).public_ref,
      idempotency_key:key(),reason:'other',comment:'',lines:[{order_item_id:itemId(),qty:1}]});
    await performAction(db,{action:'decide-return',return_id:row('SELECT id FROM order_returns WHERE status=?','requested').id,decision:'accept'},origin);
    await expect(cancelAccountReturn(db,session,{public_ref:second.public_ref})).rejects.toThrow(/tramitando/);
  });

  it('avisa en la bandeja mientras espera una decisión o el reembolso', async () => {
    const {session,created} = await openReturn();
    const pending = async () => (await getState(db,origin)).attention.items.find(entry => entry.kind === 'customer_return');
    expect(await pending()).toMatchObject({count:1,orders:[expect.objectContaining({order_number:expect.stringMatching(/^FH-/)})]});
    const id = row('SELECT id FROM order_returns').id;
    await decide(id,'accept');
    // Aceptada, la pelota está en el tejado del comprador: no es una excepción del comercio.
    expect(await pending()).toMatchObject({count:0,orders:[]});
    await decide(id,'receive');
    expect(await pending()).toMatchObject({count:1});
    await decide(id,'refund');
    expect(await pending()).toMatchObject({count:0});
    expect((await readAccountReturn(db,session,{public_ref:created.public_ref})).status).toBe('refunded');
  });

  it('el panel no puede anular la solicitud del comprador', async () => {
    await openReturn();
    const id = row('SELECT id FROM order_returns').id;
    await expect(decide(id,'cancel')).rejects.toThrow(/Solo el comprador/);
    expect(row('SELECT status s FROM order_returns').s).toBe('requested');
  });
});

describe('dos decisiones a la vez', () => {
  it('dos solicitudes simultáneas dejan una sola devolución abierta', async () => {
    await deliveredOrder(2);
    const {link} = await requestAccessLink(db,{email:buyer.email},origin);
    const {session} = await openAccountSession(db,new URL(link).searchParams.get('codigo'));
    const order = await readAccountOrder(db,session,row('SELECT public_ref p FROM customer_order_access_refs').p);
    const {db:raced,on} = hookedD1(sqlite);
    const payload = (idempotency_key) => ({action:'devolver',public_ref:order.public_ref,idempotency_key,
      reason:'other',comment:'',lines:[{order_item_id:itemId(),qty:1}]});
    let second;
    on(/INSERT INTO order_returns/,async () => {
      second = await requestAccountReturn(db,session,payload(key())).then(result => result,error => error);
    });
    const first = await requestAccountReturn(raced,session,payload(key())).then(result => result,error => error);
    expect([first,second].filter(outcome => outcome instanceof Error)).toHaveLength(1);
    expect(count('order_returns')).toBe(1);
    expect(count('order_return_lines')).toBe(1);
  });

  it('dos recepciones simultáneas reponen el stock una sola vez', async () => {
    await deliveredOrder(2);
    const {link} = await requestAccessLink(db,{email:buyer.email},origin);
    const {session} = await openAccountSession(db,new URL(link).searchParams.get('codigo'));
    const order = await readAccountOrder(db,session,row('SELECT public_ref p FROM customer_order_access_refs').p);
    await requestAccountReturn(db,session,{action:'devolver',public_ref:order.public_ref,idempotency_key:key(),
      reason:'other',comment:'',lines:[{order_item_id:itemId(),qty:2}]});
    const id = row('SELECT id FROM order_returns').id;
    await performAction(db,{action:'decide-return',return_id:id,decision:'accept'},origin);
    const results = await Promise.all([
      performAction(db,{action:'decide-return',return_id:id,decision:'receive'},origin).then(r => r,e => e),
      performAction(db,{action:'decide-return',return_id:id,decision:'receive'},origin).then(r => r,e => e),
    ]);
    expect(results.some(result => !(result instanceof Error))).toBe(true);
    expect(stock()).toBe(18);
    expect(count('order_return_events',"to_status='received'")).toBe(1);
  });
});
