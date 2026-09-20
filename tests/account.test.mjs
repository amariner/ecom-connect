import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDemoOrder, getOrderDetail, syncSupplier } from '../src/lib/demo';
import {
  archiveAccountAddress, cancelAccountOrder, chooseAccountAddress, exportAccountData, forgetAccountData,
  listAccountAddresses, listAccountOrders, openAccountSession, readAccountOrder, readAccountSession,
  requestAccessLink, saveAccountAddress, updateAccountConsent, updateAccountProfile, closeAccountSession,
  closeEveryAccountSession,
} from '../src/lib/account';
import { d1Adapter, hookedD1, migratedDatabase } from './helpers/d1.mjs';

let sqlite;
let db;
const origin = 'https://demo.test';
const buyer = {name:'Laura Demo',email:'Laura@Example.test',street:'Calle Ficticia 10',city:'Castellón',postal_code:'12001'};
const key = () => crypto.randomUUID();
const row = (sql, ...values) => sqlite.prepare(sql).get(...values);
const count = (table, where = '1=1') => row(`SELECT count(*) n FROM ${table} WHERE ${where}`).n;
const cookiesFor = (token) => ({ get: () => token ? {value:token} : undefined });
const address = {recipient_name:'Laura Demo',street:'Calle de la Demo, 12',postal_code:'28001',city:'Madrid',region:'',phone:''};

async function order(email = buyer.email, qty = 2) {
  return createDemoOrder(db,{lines:[{slug:'champu-demo',qty}],customer:{...buyer,email},idempotency_key:key()});
}
/** Recorrido real del comprador: pide el enlace, lo abre y queda con su sesión. */
async function signIn(email = buyer.email) {
  const {link} = await requestAccessLink(db,{email},origin);
  const {session,token} = await openAccountSession(db,new URL(link).searchParams.get('codigo'));
  return {session,token};
}

beforeEach(async () => {
  sqlite = migratedDatabase();
  sqlite.exec(`INSERT INTO supplier_products(code,slug,name,description,price_cents,pvp_cents,brand,category,image,ean,sku,stock) VALUES
    ('SUP-001','champu-demo','Champú demo','Producto ficticio',1290,1590,'Dermocare','capilar','/images/demo.svg','2000000000008','FH-001',18);
    INSERT INTO shipping_rates(zone,label,price_cents,free_over_cents) VALUES ('peninsula','Envío demo',490,4900);`);
  db = d1Adapter(sqlite);
  await syncSupplier(db);
});
afterEach(() => { sqlite.close(); });

describe('entrar en la cuenta sin contraseña',() => {
  it('guarda el correo simulado, abre la sesión y no permite reutilizar el enlace',async () => {
    const {link,email,expires_at} = await requestAccessLink(db,{email:'Laura@Example.test'},origin);
    expect(email).toBe('laura@example.test');
    expect(count('emails_outbox',"to_addr='laura@example.test'")).toBe(1);
    expect(row('SELECT body_html h FROM emails_outbox').h).toContain(link);
    expect(count('customer_passwordless_challenge_deliveries')).toBe(1);
    expect(Date.parse(expires_at)).toBeGreaterThan(Date.now());
    // El secreto viaja en el enlace: la base solo conserva su huella.
    expect(row('SELECT secret_digest d FROM customer_passwordless_challenges').d)
      .not.toContain(new URL(link).searchParams.get('codigo'));

    const code = new URL(link).searchParams.get('codigo');
    const {session,token} = await openAccountSession(db,code);
    expect(session.primary_email).toBe('laura@example.test');
    expect(row('SELECT status s FROM customer_passwordless_challenges').s).toBe('consumed');
    expect(await readAccountSession(db,cookiesFor(token))).toMatchObject({id:session.id});

    await expect(openAccountSession(db,code)).rejects.toThrow(/ya se ha usado o ha caducado/);
    expect(count('customer_sessions')).toBe(1);
  });

  it('un enlace caducado no abre ninguna sesión',async () => {
    await requestAccessLink(db,{email:buyer.email},origin);
    // Un enlace emitido hace media hora: sus fechas son inmutables, así que la
    // prueba escribe el hecho ya caducado en lugar de reescribir el vigente.
    const secret = 'ab'.repeat(32);
    const stale = new Date(Date.now() - 30 * 60_000).toISOString();
    sqlite.prepare(`INSERT INTO customer_passwordless_challenges(
      id,identity_id,method,purpose,provider_reference,secret_digest,status,requested_at,expires_at,version
    ) VALUES ('chl_caducado',?,'email_magic_link','sign_in','mail_caducado',?,'pending',?,?,1)`)
      .run(row('SELECT id FROM customer_auth_identities').id,
        createHash('sha256').update(secret).digest('hex'),stale,
        new Date(Date.parse(stale) + 600_000).toISOString());
    await expect(openAccountSession(db,secret)).rejects.toThrow(/ya se ha usado o ha caducado/);
    expect(count('customer_sessions')).toBe(0);
  });

  it('pedir un enlace nuevo invalida el anterior',async () => {
    const first = await requestAccessLink(db,{email:buyer.email},origin);
    await requestAccessLink(db,{email:buyer.email},origin);
    expect(count('customer_passwordless_challenges',"status='revoked'")).toBe(1);
    await expect(openAccountSession(db,new URL(first.link).searchParams.get('codigo'))).rejects.toThrow();
  });

  it('limita los enlaces seguidos del mismo correo sin bloquear a otro comprador',async () => {
    await requestAccessLink(db,{email:buyer.email},origin);
    await requestAccessLink(db,{email:buyer.email},origin);
    await requestAccessLink(db,{email:buyer.email},origin);
    await expect(requestAccessLink(db,{email:buyer.email},origin)).rejects.toThrow(/varios enlaces seguidos/);
    await expect(requestAccessLink(db,{email:'otra@example.test'},origin)).resolves.toBeTruthy();
    expect(count('customer_auth_throttle_events',"decision='limited'")).toBe(1);
  });

  it('cerrar la sesión la revoca en esta base y en el resto de navegadores',async () => {
    await order();
    const first = await signIn();
    const second = await openAccountSession(db,
      new URL((await requestAccessLink(db,{email:buyer.email},origin)).link).searchParams.get('codigo'));
    await closeAccountSession(db,first.session);
    expect(await readAccountSession(db,cookiesFor(first.token))).toBeNull();
    expect(await readAccountSession(db,cookiesFor(second.token))).not.toBeNull();
    await closeEveryAccountSession(db,second.session);
    expect(await readAccountSession(db,cookiesFor(second.token))).toBeNull();
  });
});

describe('los pedidos del comprador',() => {
  it('reclama la compra hecha como invitado con el mismo correo, sin importar mayúsculas',async () => {
    const created = await order('LAURA@example.test');
    expect(row('SELECT customer_profile_id p FROM orders WHERE id=?',created.order_id).p).toEqual(expect.any(String));
    const {session} = await signIn('laura@example.TEST');
    const {orders,total} = await listAccountOrders(db,session,null);
    expect(total).toBe(1);
    expect(orders[0]).toMatchObject({order_number:created.order_number,status:'paid',units:2});
    expect(orders[0].public_ref).toMatch(/^ord_[a-f0-9]{32}$/);
    // El nombre del pedido rellena el perfil vacío sin pedírselo otra vez.
    expect(row('SELECT display_name n FROM customer_profiles WHERE id=?',session.id).n).toBe('Laura Demo');
  });

  it('muestra el detalle con sus importes, su dirección y su historial',async () => {
    await order();
    const {session} = await signIn();
    const {orders} = await listAccountOrders(db,session,null);
    const detail = await readAccountOrder(db,session,orders[0].public_ref);
    expect(detail).toMatchObject({status:'paid',units:2,subtotal_cents:2580,shipping_cents:490,total_cents:3070});
    expect(detail.address).toMatchObject({street:'Calle Ficticia 10',city:'Castellón',postal_code:'12001'});
    expect(detail.items).toEqual([{name_snapshot:'Champú demo',unit_price_cents:1290,qty:2}]);
    expect(detail.events.map(event => event.to_status)).toContain('paid');
    expect(detail.actions).toEqual({can_cancel:true,cancel_note:null});
  });

  it('no deja ver ni cancelar el pedido de otra persona',async () => {
    await order('laura@example.test');
    const laura = await signIn('laura@example.test');
    const {orders} = await listAccountOrders(db,laura.session,null);
    const intruder = await signIn('otra@example.test');
    expect(await readAccountOrder(db,intruder.session,orders[0].public_ref)).toBeNull();
    await expect(cancelAccountOrder(db,intruder.session,{public_ref:orders[0].public_ref}))
      .rejects.toThrow(/No encontramos este pedido/);
    expect((await listAccountOrders(db,intruder.session,null)).total).toBe(0);
    expect(row('SELECT status s FROM orders').s).toBe('paid');
  });

  it('cancela desde la cuenta, repone el stock y deja constancia del origen',async () => {
    const created = await order();
    const {session} = await signIn();
    const {orders} = await listAccountOrders(db,session,null);
    const detail = await cancelAccountOrder(db,session,{public_ref:orders[0].public_ref});
    expect(detail.status).toBe('cancelled');
    expect(detail.cancellation).toMatchObject({source:'account',reason:'customer_request'});
    expect(detail.actions.can_cancel).toBe(false);
    expect(detail.events.at(-1)).toMatchObject({to_status:'cancelled',note:'Cancelado por el cliente desde su cuenta'});
    expect(row('SELECT stock s FROM products WHERE slug=?','champu-demo').s).toBe(18);
    expect((await getOrderDetail(db,created.order_id)).order.status).toBe('cancelled');
    await expect(cancelAccountOrder(db,session,{public_ref:orders[0].public_ref}))
      .rejects.toThrow(/no se puede cancelar|ya está cerrado|ha salido/);
  });

  it('un pedido ya enviado no se cancela desde la cuenta',async () => {
    const created = await order();
    sqlite.prepare("UPDATE orders SET status='shipped' WHERE id=?").run(created.order_id);
    const {session} = await signIn();
    const {orders} = await listAccountOrders(db,session,null);
    await expect(cancelAccountOrder(db,session,{public_ref:orders[0].public_ref})).rejects.toThrow(/devolución/);
    expect(row('SELECT status s FROM orders').s).toBe('shipped');
  });

  it('pagina el historial sin salirse del rango',async () => {
    for (let index = 0; index < 12; index++) await order(buyer.email,1);
    const {session} = await signIn();
    const first = await listAccountOrders(db,session,'1');
    const last = await listAccountOrders(db,session,'99');
    expect(first.total).toBe(12);
    expect(first.orders).toHaveLength(10);
    expect(first.pages).toBe(2);
    expect(last.page).toBe(2);
    expect(last.orders).toHaveLength(2);
  });
});

describe('las direcciones guardadas',() => {
  it('guarda, corrige y archiva conservando el historial de revisiones',async () => {
    const {session} = await signIn();
    await saveAccountAddress(db,session,{action:'guardar',idempotency_key:key(),...address});
    const [saved] = await listAccountAddresses(db,session);
    expect(saved).toMatchObject({recipient_name:'Laura Demo',city:'Madrid',revision:1,is_default:true});

    const updated = await saveAccountAddress(db,session,
      {action:'guardar',idempotency_key:key(),public_ref:saved.public_ref,...address,street:'Calle Nueva, 3'});
    expect(updated.addresses[0]).toMatchObject({street:'Calle Nueva, 3',revision:2,public_ref:saved.public_ref});
    expect(count('customer_address_revisions')).toBe(2);
    expect(count('customer_address_revisions','valid_to IS NULL')).toBe(1);

    await archiveAccountAddress(db,session,{public_ref:saved.public_ref});
    expect(await listAccountAddresses(db,session)).toEqual([]);
    expect(count('customer_default_addresses')).toBe(0);
    expect(count('customer_address_revisions')).toBe(2);
  });

  it('repetir el mismo envío no crea una segunda dirección',async () => {
    const {session} = await signIn();
    const idempotency_key = key();
    await saveAccountAddress(db,session,{action:'guardar',idempotency_key,...address});
    await saveAccountAddress(db,session,{action:'guardar',idempotency_key,...address});
    expect(await listAccountAddresses(db,session)).toHaveLength(1);
    expect(count('customer_address_revisions')).toBe(1);
  });

  it('solo una dirección queda como preferida',async () => {
    const {session} = await signIn();
    await saveAccountAddress(db,session,{action:'guardar',idempotency_key:key(),...address});
    const second = await saveAccountAddress(db,session,
      {action:'guardar',idempotency_key:key(),...address,street:'Calle Segunda, 8'});
    const other = second.addresses.find(entry => entry.street === 'Calle Segunda, 8');
    const {addresses} = await chooseAccountAddress(db,session,{public_ref:other.public_ref});
    expect(addresses.filter(entry => entry.is_default)).toHaveLength(1);
    expect(addresses.find(entry => entry.is_default).street).toBe('Calle Segunda, 8');
  });

  it('no acepta la dirección de otra cuenta',async () => {
    const laura = await signIn('laura@example.test');
    const {addresses} = await saveAccountAddress(db,laura.session,{action:'guardar',idempotency_key:key(),...address});
    const intruder = await signIn('otra@example.test');
    await expect(saveAccountAddress(db,intruder.session,
      {action:'guardar',idempotency_key:key(),public_ref:addresses[0].public_ref,...address}))
      .rejects.toThrow(/ya no está en tu cuenta/);
    await expect(archiveAccountAddress(db,intruder.session,{public_ref:addresses[0].public_ref}))
      .rejects.toThrow(/ya no está en tu cuenta/);
    expect(count('customer_address_revisions')).toBe(1);
  });
});

describe('los datos personales',() => {
  it('guarda el nombre y el teléfono que el cliente mantiene',async () => {
    const {session,token} = await signIn();
    await updateAccountProfile(db,session,{action:'datos',display_name:'Laura Martínez',phone:'600 000 000'});
    expect(await readAccountSession(db,cookiesFor(token)))
      .toMatchObject({display_name:'Laura Martínez',phone:'600 000 000'});
  });

  it('registra el consentimiento y su retirada como hechos verificables',async () => {
    const {session} = await signIn();
    await updateAccountConsent(db,session,{action:'consentimiento',granted:true});
    const granted = row('SELECT id,action,version,notice_version FROM customer_consent_evidence');
    expect(granted).toMatchObject({action:'granted',version:1,notice_version:'2026-09'});
    const {consent} = await updateAccountConsent(db,session,{action:'consentimiento',granted:false});
    expect(consent).toMatchObject({action:'withdrawn',version:2});
    expect(row("SELECT withdraws_evidence_id w FROM customer_consent_evidence WHERE action='withdrawn'").w)
      .toBe(granted.id);
    // Repetir la misma decisión no inventa un hecho nuevo.
    await updateAccountConsent(db,session,{action:'consentimiento',granted:false});
    expect(count('customer_consent_evidence')).toBe(2);
  });

  it('descarga una copia con el perfil, las direcciones y los pedidos',async () => {
    await order();
    const {session} = await signIn();
    await saveAccountAddress(db,session,{action:'guardar',idempotency_key:key(),...address});
    const current = await readAccountSession(db,cookiesFor((await signIn()).token));
    const data = await exportAccountData(db,current);
    expect(data.profile).toMatchObject({email:'laura@example.test',display_name:'Laura Demo'});
    expect(data.addresses).toHaveLength(1);
    expect(data.orders).toHaveLength(1);
    expect(data.orders[0].items[0]).toMatchObject({name_snapshot:'Champú demo'});
  });

  it('borra los datos de contacto, cierra la sesión y conserva los pedidos',async () => {
    const created = await order();
    const {session,token} = await signIn();
    await updateAccountProfile(db,session,{action:'datos',display_name:'Laura Martínez',phone:'600 000 000'});
    await saveAccountAddress(db,session,{action:'guardar',idempotency_key:key(),...address});
    await updateAccountConsent(db,session,{action:'consentimiento',granted:true});

    const result = await forgetAccountData(db,session);
    expect(result).toMatchObject({addresses:1,orders_preserved:true});
    expect(await readAccountSession(db,cookiesFor(token))).toBeNull();
    const profile = row('SELECT display_name n,phone p FROM customer_profiles WHERE id=?',session.id);
    expect(profile).toMatchObject({n:null,p:null});
    expect(count('customer_address_revisions','valid_to IS NULL')).toBe(0);
    expect(row("SELECT action a FROM customer_consent_evidence ORDER BY version DESC").a).toBe('withdrawn');
    // El pedido es la prueba de una compra: conserva su nombre y su dirección.
    expect((await getOrderDetail(db,created.order_id)).order.customer_name).toBe('Laura Demo');
  });
});

describe('dos navegadores a la vez',() => {
  it('el mismo enlace abierto dos veces deja una única sesión',async () => {
    const {link} = await requestAccessLink(db,{email:buyer.email},origin);
    const code = new URL(link).searchParams.get('codigo');
    const {db:raced,on} = hookedD1(sqlite);
    let second;
    // La segunda pestaña termina mientras la primera está creando su sesión.
    on(/INSERT INTO customer_session_families/,async () => {
      second = await openAccountSession(db,code).then(result => result,error => error);
    });
    const first = await openAccountSession(raced,code).then(result => result,error => error);
    const outcomes = [first,second];
    expect(outcomes.filter(outcome => outcome instanceof Error)).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome?.token)).toHaveLength(1);
    expect(count('customer_sessions')).toBe(1);
    expect(count('customer_session_families')).toBe(1);
    expect(count('customer_passwordless_challenges',"status='consumed'")).toBe(1);
  });

  it('dos peticiones del primer acceso no duplican el perfil',async () => {
    const {db:raced,on} = hookedD1(sqlite);
    on(/INSERT INTO customer_profiles/,async () => {
      await requestAccessLink(db,{email:'nueva@example.test'},origin);
    });
    await requestAccessLink(raced,{email:'nueva@example.test'},origin);
    expect(count('customer_profiles')).toBe(1);
    expect(count('customer_auth_identities')).toBe(1);
    expect(count('customer_passwordless_challenges',"status='pending'")).toBe(1);
  });

  it('dos correcciones simultáneas de una dirección dejan una sola revisión vigente',async () => {
    const {session} = await signIn();
    const {addresses:[saved]} = await saveAccountAddress(db,session,{action:'guardar',idempotency_key:key(),...address});
    const {db:raced,on} = hookedD1(sqlite);
    let second;
    on(/INSERT INTO customer_address_revisions/,async () => {
      second = await saveAccountAddress(db,session,{action:'guardar',idempotency_key:key(),
        public_ref:saved.public_ref,...address,street:'Calle Segunda, 2'}).then(result => result,error => error);
    });
    const first = await saveAccountAddress(raced,session,{action:'guardar',idempotency_key:key(),
      public_ref:saved.public_ref,...address,street:'Calle Primera, 1'}).then(result => result,error => error);
    expect([first,second].filter(outcome => outcome instanceof Error)).toHaveLength(1);
    expect(count('customer_address_revisions')).toBe(2);
    expect(count('customer_address_revisions','valid_to IS NULL')).toBe(1);
    const [current] = await listAccountAddresses(db,session);
    expect(current).toMatchObject({revision:2,is_default:true});
  });

  it('dos cancelaciones simultáneas del comprador reponen el stock una sola vez',async () => {
    await order();
    const {session} = await signIn();
    const {orders} = await listAccountOrders(db,session,null);
    const results = await Promise.all([
      cancelAccountOrder(db,session,{public_ref:orders[0].public_ref}).then(result => result,error => error),
      cancelAccountOrder(db,session,{public_ref:orders[0].public_ref}).then(result => result,error => error),
    ]);
    expect(results.some(result => result?.status === 'cancelled')).toBe(true);
    expect(count('order_cancellations')).toBe(1);
    expect(row('SELECT stock s FROM products WHERE slug=?','champu-demo').s).toBe(18);
  });
});
