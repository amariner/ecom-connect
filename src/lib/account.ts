import { z } from 'zod';
import type { AstroCookies } from 'astro';
import { DemoError, applyReturnAction, cancelOrder, hashText } from './demo';
import { RETURN_REASONS, decideReturnSelection, decideReturnWindow, returnableQuantity } from '../modules/orders/domain/customer-return';
import { createD1OrderReturns } from '../modules/orders/infrastructure/d1-order-returns';
import { generateReturnNumber } from './orders';
import { randomHex } from '../modules/customers/domain/customer-identity';
import { ACCESS_LINK_TTL_MS, accessSecret, decideAccountOrderActions, emailIdentitySubject, normalizeEmail } from '../modules/customers/domain/customer-identity';
import { createD1CustomerAuth, type CustomerSessionRow } from '../modules/customers/infrastructure/d1-customer-auth';
import { createD1CustomerAccount, type AccountAddress } from '../modules/customers/infrastructure/d1-customer-account';

export const ACCOUNT_COOKIE = 'farmahouse_cuenta';
export const ACCOUNT_ORDERS_PAGE_SIZE = 10;
const SESSION_COOKIE_MAX_AGE = 6 * 24 * 60 * 60;
export type AccountSession = CustomerSessionRow;

const emailSchema = z.string().trim().max(200).email().transform(normalizeEmail);
const secretSchema = z.string().trim().regex(/^[a-f0-9]{64}$/);
const publicRefSchema = (prefix: string) => z.string().trim().regex(new RegExp(`^${prefix}_[a-f0-9]{32}$`));
export const accessRequestSchema = z.object({ email: emailSchema });
const optionalText = (min: number, max: number) => z.union([z.literal(''),z.string().trim().min(min).max(max)])
  .transform((value) => value === '' ? null : value);
export const accountAddressSchema = z.object({
  recipient_name: z.string().trim().min(2).max(160),
  phone: optionalText(3,30),
  street: z.string().trim().min(3).max(200),
  city: z.string().trim().min(2).max(100),
  region: optionalText(1,100),
  postal_code: z.string().trim().regex(/^\d{5}$/,'Introduce un código postal de 5 cifras.'),
});
const saveAddressSchema = accountAddressSchema.extend({
  public_ref: publicRefSchema('addr').optional(),
  idempotency_key: z.string().uuid(),
  set_default: z.boolean().default(false),
});
const addressRefSchema = z.object({ public_ref: publicRefSchema('addr') });
const orderRefSchema = z.object({ public_ref: publicRefSchema('ord') });
const profileSchema = z.object({ display_name: optionalText(2,120), phone: optionalText(3,30) });
const consentSchema = z.object({ granted: z.boolean() });
const returnRequestSchema = z.object({
  public_ref: publicRefSchema('ord'),
  reason: z.enum(RETURN_REASONS),
  comment: z.union([z.literal(''),z.string().trim().max(500)]).transform((value) => value === '' ? null : value),
  idempotency_key: z.string().uuid(),
  lines: z.array(z.object({ order_item_id:z.number().int().positive(), qty:z.number().int().min(1).max(99) })).min(1).max(50),
});
const returnRefSchema = z.object({ public_ref: publicRefSchema('ret') });

const now = (): string => new Date().toISOString();
/** El país de envío de la demo es fijo: solo hay tarifas simuladas para España. */
const COUNTRY_CODE = 'ES';

function accessEmail(link: string): { subject: string; body_html: string } {
  const minutes = Math.round(ACCESS_LINK_TTL_MS / 60_000);
  return {
    subject: 'Tu acceso a FarmaHouse Demo',
    body_html: `<p>Hola,</p><p>Entra en tu cuenta de demostración con este enlace. Caduca en ${minutes} minutos y solo puede usarse una vez.</p><p><a href="${link}">Entrar en mi cuenta</a></p><p>Si no lo has pedido tú, ignora este correo ficticio.</p>`,
  };
}

/**
 * Pide un enlace de acceso. La demo no envía correos: guarda el mensaje en la
 * bandeja simulada y devuelve el enlace para mostrarlo en pantalla, que es la
 * única diferencia con un acceso sin contraseña real.
 */
export async function requestAccessLink(db: D1Database, raw: unknown, origin: string) {
  const { email } = accessRequestSchema.parse(raw);
  const instant = now();
  const auth = createD1CustomerAuth(db);
  const contactHash = await hashText(emailIdentitySubject(email));
  const throttle = await auth.throttle(contactHash,instant);
  if (throttle.decision === 'limited') {
    throw new DemoError('Has pedido varios enlaces seguidos. Usa el último que recibiste o espera unos minutos.',429);
  }
  const { identity_id } = await auth.ensureIdentity(email,contactHash,instant);
  await auth.expireStaleChallenges(identity_id,instant);
  const secret = accessSecret();
  const link = `${origin}/cuenta/acceso?codigo=${secret}`;
  const issued = await auth.issueAccessLink({
    identity_id,secret_digest:await hashText(secret),email,now:instant,...accessEmail(link),
  });
  return { email, link, expires_at:issued.expires_at };
}

/**
 * Canjea el enlace por una sesión y reclama las compras que ese correo hizo
 * como invitado. El enlace solo vale una vez: el segundo intento no abre nada.
 */
export async function openAccountSession(db: D1Database, rawSecret: unknown) {
  const parsed = secretSchema.safeParse(rawSecret);
  if (!parsed.success) throw new DemoError('El enlace no es válido. Pide uno nuevo desde tu cuenta.',401);
  const instant = now();
  const token = accessSecret();
  const session = await createD1CustomerAuth(db)
    .consumeAccessLink(await hashText(parsed.data),await hashText(token),instant);
  if (!session) throw new DemoError('Este enlace ya se ha usado o ha caducado. Pide uno nuevo desde tu cuenta.',401);
  try {
    await createD1CustomerAccount(db).claimGuestOrders(session.id,session.primary_email,instant);
  } catch {
    // La sesión es válida aunque la asociación de pedidos quede para el próximo acceso.
    console.warn('account-claim-pending',session.id);
  }
  return { session, token };
}

export function writeSessionCookie(cookies: AstroCookies, token: string, secure: boolean): void {
  cookies.set(ACCOUNT_COOKIE,token,{ httpOnly:true, sameSite:'lax', path:'/', secure, maxAge:SESSION_COOKIE_MAX_AGE });
}
export function clearSessionCookie(cookies: AstroCookies, secure: boolean): void {
  cookies.delete(ACCOUNT_COOKIE,{ path:'/', secure, sameSite:'lax', httpOnly:true });
}

export async function readAccountSession(db: D1Database, cookies: AstroCookies): Promise<AccountSession | null> {
  const raw = cookies.get(ACCOUNT_COOKIE)?.value;
  const parsed = secretSchema.safeParse(raw);
  if (!parsed.success) return null;
  return createD1CustomerAuth(db).readSession(await hashText(parsed.data),now());
}
export async function requireAccountSession(db: D1Database, cookies: AstroCookies): Promise<AccountSession> {
  const session = await readAccountSession(db,cookies);
  if (!session) throw new DemoError('Entra en tu cuenta para continuar.',401);
  return session;
}

export async function closeAccountSession(db: D1Database, session: AccountSession): Promise<void> {
  await createD1CustomerAuth(db).closeSession(session,'customer.sign_out',now());
}
export async function closeEveryAccountSession(db: D1Database, session: AccountSession): Promise<number> {
  return createD1CustomerAuth(db).closeAllSessions(session.id,'customer.revoke_all',now());
}

export async function readAccountOverview(db: D1Database, session: AccountSession) {
  const account = createD1CustomerAccount(db);
  const [orders, addresses, consent] = await Promise.all([
    account.listOrders(session.id,1,3), account.listAddresses(session.id), account.readConsent(session.id),
  ]);
  return { orders:orders.orders, total_orders:orders.total, addresses, consent };
}

export async function listAccountOrders(db: D1Database, session: AccountSession, rawPage: string | null) {
  const page = Math.max(1,Math.min(1000,Number.parseInt(rawPage ?? '1',10) || 1));
  const result = await createD1CustomerAccount(db).listOrders(session.id,page,ACCOUNT_ORDERS_PAGE_SIZE);
  const pages = Math.max(1,Math.ceil(result.total / ACCOUNT_ORDERS_PAGE_SIZE));
  return { ...result, page:Math.min(page,pages), pages };
}

export async function readAccountOrder(db: D1Database, session: AccountSession, publicRef: string) {
  const parsed = publicRefSchema('ord').safeParse(publicRef);
  if (!parsed.success) return null;
  const account = createD1CustomerAccount(db);
  const order = await account.readOrder(session.id,parsed.data);
  if (!order) return null;
  const orderId = await account.findOwnedOrderId(session.id,parsed.data);
  const returns = createD1OrderReturns(db);
  const [history, deliveredAt, returnable] = orderId === null
    ? [[],null,[]]
    : await Promise.all([returns.listForOrder(orderId),returns.deliveredAt(orderId),returns.returnableLines(orderId)]);
  const pending = history.some((entry) => ['requested','accepted','received'].includes(entry.status));
  const window = decideReturnWindow({ status:order.status, delivered_at:deliveredAt, now:now(), open_return:pending });
  return {
    ...order, actions:decideAccountOrderActions(order), returns:history, return_window:window,
    // Ofrecer una línea ya devuelta sería invitar a un rechazo seguro.
    returnable_lines:window.open ? returnable.filter((line) => returnableQuantity(line) > 0) : [],
  };
}

/**
 * Abre una devolución del propio comprador. La ventana, la propiedad y las
 * unidades disponibles se comprueban aquí y otra vez en la base: una entrega
 * deshecha o dos solicitudes a la vez no dejan una devolución imposible.
 */
export async function requestAccountReturn(db: D1Database, session: AccountSession, raw: unknown) {
  const input = returnRequestSchema.parse(raw);
  const account = createD1CustomerAccount(db);
  const returns = createD1OrderReturns(db);
  const replay = await returns.findByIdempotencyKey(`ret:${input.idempotency_key}`);
  if (replay) return readAccountReturn(db,session,{ public_ref:replay });
  const order = await account.readOrder(session.id,input.public_ref);
  const orderId = order && await account.findOwnedOrderId(session.id,input.public_ref);
  if (!order || orderId === null) throw new DemoError('No encontramos este pedido en tu cuenta.',404);
  const [history, deliveredAt, returnable] = await Promise.all([
    returns.listForOrder(orderId), returns.deliveredAt(orderId), returns.returnableLines(orderId),
  ]);
  const window = decideReturnWindow({ status:order.status, delivered_at:deliveredAt, now:now(),
    open_return:history.some((entry) => ['requested','accepted','received'].includes(entry.status)) });
  if (!window.open) throw new DemoError(window.reason,409);
  const selection = decideReturnSelection(input.lines,returnable);
  if (!selection.ok) throw new DemoError(selection.error,409);
  const created = { id:`rma_${randomHex()}`, public_ref:`ret_${randomHex()}` };
  try {
    await returns.create({
      ...created, return_number:generateReturnNumber(), order_id:orderId, customer_profile_id:session.id,
      reason:input.reason, comment:input.comment, idempotency_key:`ret:${input.idempotency_key}`,
      now:now(), lines:selection.lines,
    });
  } catch {
    // Las guardas de la base rechazan lo que ya no es posible; se relee su verdad.
    const saved = await returns.findByIdempotencyKey(`ret:${input.idempotency_key}`);
    if (!saved) throw new DemoError('La devolución ya no se puede pedir con estos artículos. Revisa el pedido.',409);
    return readAccountReturn(db,session,{ public_ref:saved });
  }
  return readAccountReturn(db,session,{ public_ref:created.public_ref });
}

export async function readAccountReturn(db: D1Database, session: AccountSession, raw: unknown) {
  const { public_ref } = returnRefSchema.parse(raw);
  const found = await createD1OrderReturns(db).readOwned(session.id,public_ref);
  if (!found) throw new DemoError('No encontramos esta devolución en tu cuenta.',404);
  return found;
}

export async function listAccountReturns(db: D1Database, session: AccountSession) {
  return createD1OrderReturns(db).listForProfile(session.id);
}

/** El comprador anula su solicitud mientras nadie la haya empezado a tramitar. */
export async function cancelAccountReturn(db: D1Database, session: AccountSession, raw: unknown) {
  const current = await readAccountReturn(db,session,raw);
  return applyReturnAction(db,current,'cancel','customer');
}

/**
 * Cancelación pedida por el comprador. Reutiliza el circuito del panel: el
 * proveedor demo decide, el stock se repone y el canal recibe su acuse.
 */
export async function cancelAccountOrder(db: D1Database, session: AccountSession, raw: unknown) {
  const { public_ref } = orderRefSchema.parse(raw);
  const account = createD1CustomerAccount(db);
  const order = await account.readOrder(session.id,public_ref);
  if (!order) throw new DemoError('No encontramos este pedido en tu cuenta.',404);
  if (order.channel !== 'WEB') throw new DemoError('Este pedido llegó desde otro canal y se cancela allí.',409);
  const actions = decideAccountOrderActions(order);
  if (!actions.can_cancel) throw new DemoError(actions.cancel_note ?? 'Este pedido ya no se puede cancelar.',409);
  const orderId = await account.findOwnedOrderId(session.id,public_ref);
  if (!orderId) throw new DemoError('No encontramos este pedido en tu cuenta.',404);
  await cancelOrder(db,orderId,{ reason:'customer_request', source:'account' });
  return readAccountOrder(db,session,public_ref);
}

export async function listAccountAddresses(db: D1Database, session: AccountSession): Promise<AccountAddress[]> {
  return createD1CustomerAccount(db).listAddresses(session.id);
}

export async function saveAccountAddress(db: D1Database, session: AccountSession, raw: unknown) {
  const input = saveAddressSchema.parse(raw);
  const account = createD1CustomerAccount(db);
  const address = {
    recipient_name:input.recipient_name, phone:input.phone, street:input.street, city:input.city,
    region:input.region, postal_code:input.postal_code, country_code:COUNTRY_CODE,
  };
  const addressId = input.public_ref ? await account.findAddressId(session.id,input.public_ref) : null;
  if (input.public_ref && !addressId) throw new DemoError('Esta dirección ya no está en tu cuenta.',404);
  const saved = await account.saveAddress({
    profileId:session.id, addressId, idempotencyKey:`addr:${input.idempotency_key}`,
    fingerprint:await hashText(JSON.stringify({ addressId, ...address })), now:now(), address,
  });
  const addresses = await account.listAddresses(session.id);
  // La primera dirección guardada es la preferida sin tener que elegirla.
  if (input.set_default || addresses.length === 1) {
    await account.setDefaultAddress(session.id,saved,now());
    return { addresses:await account.listAddresses(session.id) };
  }
  return { addresses };
}

export async function archiveAccountAddress(db: D1Database, session: AccountSession, raw: unknown) {
  const { public_ref } = addressRefSchema.parse(raw);
  const account = createD1CustomerAccount(db);
  const addressId = await account.findAddressId(session.id,public_ref);
  if (!addressId || !await account.archiveAddress(session.id,addressId,now())) {
    throw new DemoError('Esta dirección ya no está en tu cuenta.',404);
  }
  return { addresses:await account.listAddresses(session.id) };
}

export async function chooseAccountAddress(db: D1Database, session: AccountSession, raw: unknown) {
  const { public_ref } = addressRefSchema.parse(raw);
  const account = createD1CustomerAccount(db);
  const addressId = await account.findAddressId(session.id,public_ref);
  if (!addressId) throw new DemoError('Esta dirección ya no está en tu cuenta.',404);
  await account.setDefaultAddress(session.id,addressId,now());
  return { addresses:await account.listAddresses(session.id) };
}

export async function updateAccountProfile(db: D1Database, session: AccountSession, raw: unknown) {
  const input = profileSchema.parse(raw);
  await createD1CustomerAccount(db).updateProfile(session.id,input,now());
  return { display_name:input.display_name, phone:input.phone };
}

export async function updateAccountConsent(db: D1Database, session: AccountSession, raw: unknown) {
  const { granted } = consentSchema.parse(raw);
  const account = createD1CustomerAccount(db);
  await account.recordConsent(session.id,granted ? 'granted' : 'withdrawn',now());
  return { consent:await account.readConsent(session.id) };
}

/**
 * Retira los datos personales que el cliente mantiene y cierra sus sesiones.
 * Los pedidos siguen existiendo: son la prueba de una compra y conservan el
 * nombre y la dirección con los que se hicieron.
 */
export async function forgetAccountData(db: D1Database, session: AccountSession) {
  const instant = now();
  const account = createD1CustomerAccount(db);
  await account.recordConsent(session.id,'withdrawn',instant);
  const result = await account.forgetPersonalData(session.id,instant);
  await createD1CustomerAuth(db).closeAllSessions(session.id,'customer.data_erasure',instant);
  return { ...result, orders_preserved:true };
}

/** Copia completa de lo que la demo guarda de este cliente, en un solo archivo. */
export async function exportAccountData(db: D1Database, session: AccountSession) {
  const account = createD1CustomerAccount(db);
  const [orders, addresses, consent] = await Promise.all([
    account.listOrders(session.id,1,200), account.listAddresses(session.id), account.readConsent(session.id),
  ]);
  const details = await Promise.all(orders.orders.map((order) => account.readOrder(session.id,order.public_ref)));
  return {
    generated_at:now(),
    notice:'Copia de los datos que la tienda de demostración guarda de esta cuenta. Todos los pedidos son ficticios.',
    profile:{ email:session.primary_email, display_name:session.display_name, phone:session.phone },
    consents:consent ? [{ channel:'email', purpose:'marketing.newsletter', ...consent }] : [],
    addresses, orders:details.filter((order) => order !== null),
  };
}
