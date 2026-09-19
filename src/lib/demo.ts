import { z } from 'zod';
import { shopConfig } from '../../shop.config';
import { quoteCart, quoteRequestSchema } from './quote';
import { generateOrderNumber } from './orders';
import { createOrderOperations } from '../composition/order-operations';
import { createD1OrderReader } from '../modules/orders/infrastructure/d1-order-reader';
import { MockSupplierAdapter } from '../integrations/mock-supplier-adapter';
import { SupplierOrderError } from '../integrations/supplier-adapter';
import { MockLighthouseAdapter } from '../integrations/mock-lighthouse-adapter';
import { CHANNELS, type Channel, type DemoOrder, type DispatchMode, type FeedProduct, type MarketplaceOrderUpdate, type Product, type SupplierOrderStatus, type SupplierStatus } from './demo-types';

export class DemoError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export function assertDemo(env: { DEMO_MODE?: string; OMNICHANNEL_DEMO?: string }): void {
  if (env.DEMO_MODE !== 'true' || env.OMNICHANNEL_DEMO !== 'true') throw new DemoError('La demo omnicanal no está habilitada.', 403);
}
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new DemoError('La operación debe iniciarse desde esta demo.', 403);
  }
}

export async function getProducts(db: D1Database): Promise<Product[]> {
  return (await db.prepare('SELECT * FROM products WHERE active=1 ORDER BY id').all<Product>()).results;
}
export function getProduct(db: D1Database, slug: string): Promise<Product | null> {
  return db.prepare('SELECT * FROM products WHERE slug=? AND active=1').bind(slug).first<Product>();
}
function publicOrder(order: DemoOrder) {
  const { id, order_number, channel, customer_name, total_cents, subtotal_cents, shipping_cents, status,
    supplier_status, supplier_order_id, last_supplier_sync, tracking_number, created_at } = order;
  return { id, order_number, channel, customer_name, total_cents, subtotal_cents, shipping_cents, status,
    supplier_status, supplier_order_id, last_supplier_sync, tracking_number, created_at };
}
async function recordEvent(db: D1Database, kind: string, title: string, detail: string) {
  await db.prepare('INSERT INTO integration_events(kind,title,detail) VALUES (?,?,?)').bind(kind,title,detail).run();
}
const MARKETPLACE_ACK_WARNING = 'El pedido está guardado, pero no se pudo confirmar el acuse del hub demo. Puedes conciliarlo desde el panel.';
type MarketplaceOrderIdentity = Pick<DemoOrder, 'channel' | 'order_number'>;

/** A failed acknowledgement must not invalidate a persisted purchase or shipment. */
async function syncMarketplaceOrderBestEffort(db: D1Database, order: MarketplaceOrderIdentity): Promise<string | undefined> {
  if (order.channel === 'WEB') return undefined;
  try {
    if (await new MockLighthouseAdapter(db).syncOrder(order.order_number)) return undefined;
  } catch {
    // The canonical order remains the durable source for syncMarketplaceOrders.
  }
  console.warn('marketplace-ack-pending', order.order_number);
  return MARKETPLACE_ACK_WARNING;
}

async function readMarketplaceAcknowledgement(db: D1Database, order: DemoOrder): Promise<{
  marketplace_sync: MarketplaceOrderUpdate | null;
  marketplace_warning?: string;
}> {
  if (order.channel === 'WEB') return { marketplace_sync: null };
  try {
    const sync = await db.prepare('SELECT * FROM marketplace_order_updates WHERE order_id=?')
      .bind(order.id).first<MarketplaceOrderUpdate>();
    return { marketplace_sync: sync };
  } catch {
    console.warn('marketplace-ack-read-pending', order.order_number);
    return { marketplace_sync: null, marketplace_warning: MARKETPLACE_ACK_WARNING };
  }
}
export async function getDispatchMode(db: D1Database): Promise<DispatchMode> {
  const row = await db.prepare("SELECT value FROM integration_settings WHERE key='dispatch_mode'").first<{ value: string }>();
  return row?.value === 'immediate' ? 'immediate' : 'grouped';
}
export async function getState(db: D1Database, origin: string, scheduledDispatch = false) {
  const [products, ordersResult, runs, publications, events, mode, marketplaceUpdates] = await Promise.all([
    db.prepare('SELECT * FROM products ORDER BY id').all<Product>().then((result) => result.results),
    db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 100').all<DemoOrder>(),
    db.prepare('SELECT * FROM integration_runs WHERE id IN (SELECT MAX(id) FROM integration_runs GROUP BY integration)').all<{
      integration: string; processed: number; updated: number; errors: number; created_at: string;
    }>(),
    db.prepare('SELECT * FROM marketplace_publications').all<{ channel: Channel; published: number; synced_at: string }>(),
    db.prepare('SELECT * FROM integration_events ORDER BY id DESC LIMIT 30').all(), getDispatchMode(db),
    db.prepare(`SELECT channel,COUNT(*) AS orders_synced,MAX(synced_at) AS last_order_sync
      FROM marketplace_order_updates GROUP BY channel`).all<{ channel: Channel; orders_synced: number; last_order_sync: string }>(),
  ]);
  const supplier = runs.results.find((run) => run.integration === 'supplier');
  const lighthouse = runs.results.find((run) => run.integration === 'lighthouse');
  return {
    products, orders: ordersResult.results.map(publicOrder),
    integrations: {
      supplier: { connected: true, status: 'simulated', last_sync: supplier?.created_at ?? null, processed: supplier?.processed ?? 0, updated: supplier?.updated ?? 0, errors: supplier?.errors ?? 0 },
      lighthouse: { connected: true, status: 'simulated', last_sync: lighthouse?.created_at ?? null,
        published: lighthouse?.processed ?? 0, feed_url: `${origin}/feeds/products.xml`, json_url: `${origin}/api/feeds/products.json`,
        orders_synced: marketplaceUpdates.results.reduce((total, row) => total + row.orders_synced, 0) },
    },
    settings: { dispatch_mode: mode, scheduled_dispatch: scheduledDispatch },
    marketplaces: CHANNELS.filter((channel) => channel !== 'WEB').map((channel) => {
      const publication = publications.results.find((row) => row.channel === channel);
      const order = ordersResult.results.find((row) => row.channel === channel);
      const updates = marketplaceUpdates.results.find((row) => row.channel === channel);
      return { channel, connected: true, published: publication?.published ?? 0,
        last_order: order?.order_number ?? null, stock_synced: publication?.synced_at ?? null,
        orders_synced: updates?.orders_synced ?? 0, last_order_sync: updates?.last_order_sync ?? null };
    }), events: events.results,
  };
}
export async function getOrderDetail(db: D1Database, id: number) {
  const order = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first<DemoOrder>();
  if (!order) throw new DemoError('Pedido no encontrado.', 404);
  const reader = createD1OrderReader(db);
  const [items, events, marketplaceAcknowledgement] = await Promise.all([
    reader.items(id), reader.events(id), readMarketplaceAcknowledgement(db,order),
  ]);
  return { order: publicOrder(order), items, events, ...marketplaceAcknowledgement };
}
export async function getConfirmation(db: D1Database, session: string) {
  if (!/^demo_[a-f0-9]{64}$/.test(session)) throw new DemoError('Confirmación no encontrada.', 404);
  const order = await db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').bind(session).first<DemoOrder>();
  if (!order || !['paid','shipped','delivered'].includes(order.status)) throw new DemoError('Confirmación no encontrada.', 404);
  const items = await createD1OrderReader(db).items(order.id);
  return { ...publicOrder(order), lines: items, items };
}

/** La reserva local resta solo lo que el proveedor aún no ha descontado. */
const AVAILABLE_STOCK_SQL = `MAX(0, s.stock - COALESCE((
  SELECT SUM(COALESCE(oi.current_qty,oi.qty)) FROM order_items oi
  JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=products.id
  AND o.status IN ('paid','shipped','delivered')
  AND NOT EXISTS (SELECT 1 FROM supplier_orders so WHERE so.reference=o.order_number)
),0))`;

export async function syncSupplier(db: D1Database) {
  const adapter = new MockSupplierAdapter(db);
  const products = await adapter.catalog();
  let updated = 0;
  let errors = 0;
  const now = new Date().toISOString();
  for (const product of products) {
    try {
    const before = await db.prepare('SELECT * FROM products WHERE supplier_sku=?').bind(product.code).first<Product>();
    const operation = crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO products (slug,name,description,price_cents,stock,image,category,active,collection,
        compare_at_price_cents,sku,supplier_sku,ean,brand,vat,last_synced_at)
        VALUES (?,?,?,?,0,?,?,?,'farmahouse',?,?,?,?,?,?,?) ON CONFLICT(slug) DO NOTHING`)
        .bind(product.slug,product.name,product.description,product.price_cents,product.image,product.category,product.active,
          product.pvp_cents,product.sku,product.code,product.ean,product.brand,product.vat,now),
      db.prepare(`UPDATE products SET name=?,description=?,price_cents=?,compare_at_price_cents=?,image=?,category=?,active=?,sku=?,ean=?,brand=?,vat=?,last_synced_at=?
        WHERE supplier_sku=?`).bind(product.name,product.description,product.price_cents,product.pvp_cents,
          product.image,product.category,product.active,product.sku,product.ean,product.brand,product.vat,now,product.code),
      db.prepare(`UPDATE products SET stock=(SELECT ${AVAILABLE_STOCK_SQL} FROM supplier_products s WHERE s.code=products.supplier_sku) WHERE supplier_sku=?`).bind(product.code),
      db.prepare(`INSERT INTO product_variants(product_id,sku,title,price_cents,status,is_default)
        SELECT id,sku,'',price_cents,CASE active WHEN 1 THEN 'active' ELSE 'archived' END,1 FROM products
        WHERE supplier_sku=? AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=products.id AND v.is_default=1)`).bind(product.code),
      db.prepare(`UPDATE product_variants SET price_cents=?,compare_at_price_cents=?,status=?,updated_at=?,sku=?,gtin=?
        WHERE product_id=(SELECT id FROM products WHERE supplier_sku=?) AND is_default=1`)
        .bind(product.price_cents,product.pvp_cents,product.active === 1 ? 'active' : 'archived',now,product.sku,product.ean,product.code),
      db.prepare(`INSERT INTO inventory_balances(variant_id,on_hand,reserved,version)
        SELECT v.id,0,0,1 FROM product_variants v JOIN products p ON p.id=v.product_id
        WHERE p.supplier_sku=? AND v.is_default=1 ON CONFLICT(variant_id) DO NOTHING`).bind(product.code),
      db.prepare(`INSERT INTO inventory_movements(variant_id,delta,reason,balance_after,version_after,
        actor_kind,actor_id,reference_type,reference_id,idempotency_key,correlation_id,occurred_at)
        SELECT b.variant_id,p.stock-b.on_hand,'reconciliation_correction',p.stock,b.version+1,
        'provider','supplier-demo','supplier-sync',?,?,?,?
        FROM inventory_balances b JOIN product_variants v ON v.id=b.variant_id JOIN products p ON p.id=v.product_id
        WHERE p.supplier_sku=? AND v.is_default=1 AND b.on_hand<>p.stock`)
        .bind(product.code,`sync:${operation}`,operation,now,product.code),
      db.prepare(`UPDATE inventory_balances SET on_hand=(SELECT p.stock FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=inventory_balances.variant_id),version=version+1,updated_at=?
        WHERE variant_id IN (SELECT v.id FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.supplier_sku=? AND v.is_default=1 AND p.stock<>inventory_balances.on_hand)`)
        .bind(now,product.code),
    ]);
    const after = await db.prepare('SELECT * FROM products WHERE supplier_sku=?').bind(product.code).first<Product>();
    if (!after) throw new Error('El slug del proveedor colisiona con una referencia local distinta.');
    if (!before || ['price_cents','compare_at_price_cents','stock','active','ean','brand','name'].some((key) => before[key as keyof Product] !== after[key as keyof Product])) updated++;
    } catch (error) {
      errors++;
      console.error('supplier-sync-product',product.code,error);
    }
  }
  await db.prepare("INSERT INTO integration_runs(integration,processed,updated,errors) VALUES ('supplier',?,?,?)").bind(products.length,updated,errors).run();
  await recordEvent(db,'supplier','Catálogo sincronizado',`${products.length} productos procesados · ${updated} actualizados · ${errors} errores.`);
  return { processed: products.length, updated, errors, last_sync: now };
}

const supplierProductPatchSchema = z.object({
  code:z.string().trim().min(1).max(120), slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).optional(),
  name:z.string().trim().min(2).max(180).optional(), description:z.string().trim().min(3).max(1500).optional(),
  price_cents:z.number().int().min(0).max(1000000).optional(), pvp_cents:z.number().int().min(0).max(1000000).nullable().optional(),
  discount:z.number().int().min(0).max(100).optional(), brand:z.string().trim().min(1).max(100).optional(),
  vat:z.union([z.literal(0),z.literal(4),z.literal(10),z.literal(21)]).optional(),
  category:z.string().regex(/^[a-z0-9-]+$/).max(80).optional(),
  image:z.string().regex(/^\/images\/[a-zA-Z0-9/_.,-]+$/).max(300).optional(),
  ean:z.string().regex(/^\d{8,14}$/).optional(), sku:z.string().trim().min(1).max(100).optional(),
  active:z.number().int().min(0).max(1).optional(), stock:z.number().int().min(0).max(10000).optional(),
  backup_stock:z.number().int().min(0).max(10000).optional(),
});
export async function upsertSupplierProduct(db: D1Database, raw: unknown) {
  const patch = supplierProductPatchSchema.parse(raw);
  const current = await db.prepare('SELECT * FROM supplier_products WHERE code=?').bind(patch.code).first<Record<string,unknown>>();
  const merged = {discount:0,vat:21,active:1,backup_stock:0,pvp_cents:null,...current,...patch};
  const complete = supplierProductPatchSchema.required().parse(merged);
  if (complete.pvp_cents !== null && complete.pvp_cents <= complete.price_cents) {
    throw new DemoError('El PVP de referencia debe superar el precio o ser null.');
  }
  await db.prepare(`INSERT INTO supplier_products(code,slug,name,description,price_cents,pvp_cents,discount,brand,vat,category,image,ean,sku,active,stock,backup_stock)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET
    slug=excluded.slug,name=excluded.name,description=excluded.description,price_cents=excluded.price_cents,pvp_cents=excluded.pvp_cents,
    discount=excluded.discount,brand=excluded.brand,vat=excluded.vat,category=excluded.category,image=excluded.image,
    ean=excluded.ean,sku=excluded.sku,active=excluded.active,stock=excluded.stock,backup_stock=excluded.backup_stock,updated_at=datetime('now')`)
    .bind(complete.code,complete.slug,complete.name,complete.description,complete.price_cents,complete.pvp_cents,complete.discount,
      complete.brand,complete.vat,complete.category,complete.image,complete.ean,complete.sku,complete.active,complete.stock,complete.backup_stock).run();
  return {demo:true,created:current === null,updated:true,code:complete.code};
}

export async function feedProducts(db: D1Database, origin: string): Promise<FeedProduct[]> {
  return (await getProducts(db)).map((product) => ({
    id: product.sku, sku: product.sku, title: product.name, description: product.description,
    link: `${origin}/tienda/${encodeURIComponent(product.slug)}`, image_link: new URL(product.image,origin).href,
    price: `${(product.price_cents / 100).toFixed(2)} EUR`, availability: product.stock > 0 ? 'in_stock' : 'out_of_stock',
    brand: product.brand, gtin: product.ean, stock: product.stock,
  }));
}
export function escapeXml(value: string): string {
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
}
export function renderFeedXml(products: readonly FeedProduct[], origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>FarmaHouse Demo — catálogo ficticio</title><link>${escapeXml(origin)}</link><description>Feed simulado, no conectar a cuentas comerciales.</description>${products.map((p) => `<item>${Object.entries({id:p.id,title:p.title,description:p.description,link:p.link,image_link:p.image_link,price:p.price,availability:p.availability,brand:p.brand,gtin:p.gtin,condition:'new'}).map(([key,value]) => `<g:${key}>${escapeXml(value)}</g:${key}>`).join('')}</item>`).join('')}</channel></rss>`;
}
export async function regenerateFeed(db: D1Database, origin: string) {
  const published = await new MockLighthouseAdapter(db).publish(await feedProducts(db,origin));
  await db.prepare("INSERT INTO integration_runs(integration,processed,updated,errors) VALUES ('lighthouse',?,?,0)").bind(published.published,published.published).run();
  await recordEvent(db,'lighthouse','Feed publicado en el hub demo',`${published.published} referencias en Amazon, Miravia, Carrefour y eBay simulados.`);
  return published;
}

const customerSchema = z.object({ name: z.string().trim().min(2).max(120), email: z.string().email().max(200),
  street: z.string().trim().min(3).max(200), city: z.string().trim().min(2).max(100), postal_code: z.string().regex(/^\d{5}$/) });
export const checkoutSchema = z.object({ lines: quoteRequestSchema.shape.lines, customer: customerSchema, idempotency_key: z.string().uuid() });
type CheckoutInput = z.infer<typeof checkoutSchema>;
export async function hashText(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2,'0')).join('');
}
export async function createDemoOrder(db: D1Database, input: CheckoutInput, channel: Channel = 'WEB') {
  const session = `demo_${await hashText(input.idempotency_key)}`;
  const requestHash = await hashText(JSON.stringify({ channel, lines: input.lines, customer: input.customer }));
  let order = await db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').bind(session).first<DemoOrder>();
  if (order && order.request_hash !== requestHash) throw new DemoError('Esta referencia ya se usó para otro pedido.',409);
  const operations = createOrderOperations(db,undefined,undefined,{ reservationsEnabled: false });
  if (!order) {
    const quote = await quoteCart(db,{ lines:input.lines,postal_code:input.customer.postal_code },{ catalogReadMode:'legacy' });
    if (!quote.purchasable || quote.total_cents === null || quote.shipping_cents === null) throw new DemoError('Revisa la disponibilidad de los productos y el código postal.',409);
    const productRows = await getProducts(db);
    const bySlug = new Map(productRows.map((product) => [product.slug,product]));
    try {
      await operations.placeOrder({ order_number:generateOrderNumber(),email:input.customer.email,customer_name:input.customer.name,
        address_json:JSON.stringify(input.customer),subtotal_cents:quote.subtotal_cents,shipping_cents:quote.shipping_cents,total_cents:quote.total_cents,
        stripe_session_id:session,currency:shopConfig.currency.toUpperCase(),channel,request_hash:requestHash },
        quote.lines.map((line) => ({ product_id:bySlug.get(line.slug)!.id,name_snapshot:line.name,
          unit_price_cents:line.unit_price_cents,qty:line.qty,pricing_snapshot_json:JSON.stringify(line.pricing) })), 'simulated');
    } catch (error) {
      // La restricción UNIQUE del núcleo arbitra altas simultáneas con la misma clave.
      const replay = await db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').bind(session).first<DemoOrder>();
      if (!replay) throw error;
      if (replay.request_hash !== requestHash) throw new DemoError('Esta referencia ya se usó para otro pedido.',409);
    }
    order = await db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').bind(session).first<DemoOrder>();
  }
  if (!order) throw new DemoError('No se pudo crear el pedido.',503);
  let confirmed = false;
  if (order.status === 'pending') {
    try {
      confirmed = await operations.confirmPayment({ lookup:{by:'id',orderId:order.id},paymentIntent:`sim_${session}`,source:'simulated' });
    } catch {
      const current = await db.prepare('SELECT status FROM orders WHERE id=?').bind(order.id).first<{status:string}>();
      if (current?.status !== 'paid') throw new DemoError('El stock acaba de cambiar. Revisa el carrito antes de continuar.',409);
    }
    const current = await db.prepare('SELECT status FROM orders WHERE id=?').bind(order.id).first<{status:string}>();
    if (!current || !['paid','shipped','delivered'].includes(current.status)) throw new DemoError('No se pudo confirmar el pedido.',409);
  }
  if (confirmed) await recordEvent(db,'order',`Pedido ${order.order_number} recibido`,`${channel} → Logic2B Ecommerce · pago simulado confirmado.`);
  let supplierWarning: string | undefined;
  if (await getDispatchMode(db) === 'immediate') {
    try { await dispatchOrder(db,order.id); }
    catch (error) {
      if (!(error instanceof DemoError)) throw error;
      // El pedido ya está pagado: una incidencia del proveedor no invalida
      // la compra ni debe inducir al comprador a duplicarla. El panel conserva ERROR.
      supplierWarning = error.message;
    }
  }
  const marketplaceWarning = await syncMarketplaceOrderBestEffort(db,order);
  return { order_number:order.order_number,order_id:order.id,url:`/gracias?session=${session}`,
    ...(supplierWarning ? {supplier_warning:supplierWarning} : {}),
    ...(marketplaceWarning ? {marketplace_warning:marketplaceWarning} : {}) };
}

export async function dispatchOrder(db: D1Database, id: number) {
  const order = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first<DemoOrder>();
  if (!order) throw new DemoError('Pedido no encontrado.',404);
  if (!['paid','shipped','delivered'].includes(order.status)) throw new DemoError('Solo se envían pedidos pagados.',409);
  if (order.supplier_stock_committed === 1) {
    const marketplaceWarning = await syncMarketplaceOrderBestEffort(db,order);
    return { ...await getOrderDetail(db,id), ...(marketplaceWarning ? {marketplace_warning:marketplaceWarning} : {}) };
  }
  const items = await db.prepare(`SELECT p.supplier_sku AS code,SUM(COALESCE(oi.current_qty,oi.qty)) AS qty
    FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? GROUP BY p.supplier_sku`).bind(id).all<{code:string;qty:number}>();
  try {
    const result = await new MockSupplierAdapter(db).createOrder({reference:order.order_number,items:items.results});
    await db.batch([
      db.prepare(`INSERT INTO order_events(order_id,from_status,to_status,note)
        SELECT id,supplier_status,'SUPPLIER_ACCEPTED','Proveedor demo aceptó el pedido' FROM orders WHERE id=? AND supplier_stock_committed=0`).bind(id),
      db.prepare(`UPDATE orders SET supplier_status='SUPPLIER_ACCEPTED',supplier_order_id=?,supplier_stock_committed=1,last_supplier_sync=?,updated_at=datetime('now')
        WHERE id=? AND supplier_stock_committed=0`).bind(result.supplier_order_id,new Date().toISOString(),id),
    ]);
    await recordEvent(db,'supplier',`Pedido ${order.order_number} enviado al proveedor`,result.supplier_order_id);
  } catch (error) {
    await db.prepare("UPDATE orders SET supplier_status='ERROR',last_supplier_sync=? WHERE id=? AND supplier_stock_committed=0").bind(new Date().toISOString(),id).run();
    await syncMarketplaceOrderBestEffort(db,order);
    if (error instanceof SupplierOrderError) {
      throw new DemoError(error.code === 'stock_unavailable'
        ? 'El proveedor demo no dispone de stock suficiente. Sincroniza y reintenta.' : error.message,409);
    }
    throw new DemoError('No se pudo confirmar el envío al proveedor demo. Reintenta con la misma referencia.',503);
  }
  const marketplaceWarning = await syncMarketplaceOrderBestEffort(db,order);
  return { ...await getOrderDetail(db,id), ...(marketplaceWarning ? {marketplace_warning:marketplaceWarning} : {}) };
}
export async function processPendingOrders(db: D1Database) {
  const rows = await db.prepare("SELECT id FROM orders WHERE status='paid' AND supplier_stock_committed=0 ORDER BY id LIMIT 30").all<{id:number}>();
  let processed = 0; let errors = 0;
  for (const row of rows.results) { try { await dispatchOrder(db,row.id); processed++; } catch { errors++; } }
  return { processed,errors };
}
const SUPPLIER_STATUSES: Record<SupplierOrderStatus,SupplierStatus> = {pending:'SUPPLIER_ACCEPTED',processing:'SUPPLIER_PROCESSING',partial:'SUPPLIER_PARTIAL',shipped:'SUPPLIER_SHIPPED',error:'ERROR'};
export async function advanceOrder(db: D1Database, id: number, status?: SupplierOrderStatus) {
  const order = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first<DemoOrder>();
  if (!order?.supplier_order_id) throw new DemoError('Envía primero el pedido al proveedor.',409);
  const result = await new MockSupplierAdapter(db).advanceOrder(order.order_number,status);
  const next = SUPPLIER_STATUSES[result.status];
  const statusSql = `CASE so.status WHEN 'pending' THEN 'SUPPLIER_ACCEPTED'
    WHEN 'processing' THEN 'SUPPLIER_PROCESSING' WHEN 'partial' THEN 'SUPPLIER_PARTIAL'
    WHEN 'shipped' THEN 'SUPPLIER_SHIPPED' ELSE 'ERROR' END`;
  // Se proyecta el estado canónico DENTRO de la transacción: una respuesta
  // remota más lenta no puede revertir el tracking de otra llamada concurrente.
  await db.batch([
    db.prepare(`INSERT INTO order_events(order_id,from_status,to_status,note)
      SELECT o.id,o.supplier_status,${statusSql},COALESCE('Expedición ficticia: ' || so.tracking,'Proveedor demo: ' || so.status)
      FROM orders o JOIN supplier_orders so ON so.reference=o.order_number
      WHERE o.id=? AND o.supplier_status<>${statusSql}`).bind(id),
    db.prepare(`UPDATE orders SET
      (supplier_status,tracking_number,tracking_carrier)=(SELECT ${statusSql},so.tracking,
        CASE WHEN so.tracking IS NOT NULL THEN 'Proveedor Demo' ELSE NULL END
        FROM supplier_orders so WHERE so.reference=orders.order_number),
      last_supplier_sync=?,status=CASE WHEN status='paid' AND EXISTS(SELECT 1 FROM supplier_orders so
        WHERE so.reference=orders.order_number AND so.status='shipped') THEN 'shipped' ELSE status END,
      updated_at=datetime('now') WHERE id=?`).bind(new Date().toISOString(),id),
  ]);
  const marketplaceWarning = await syncMarketplaceOrderBestEffort(db,order);
  await recordEvent(db,'tracking',`Proveedor · ${order.order_number}`,result.tracking ?? next);
  return { ...await getOrderDetail(db,id), ...(marketplaceWarning ? {marketplace_warning:marketplaceWarning} : {}) };
}

/** Repara acuses pendientes sin reenviar al proveedor ni descontar inventario. */
export async function syncMarketplaceOrders(db: D1Database) {
  const rows = await db.prepare(`SELECT o.order_number FROM orders o LEFT JOIN marketplace_order_updates m ON m.order_id=o.id
    WHERE o.channel<>'WEB' AND o.status IN ('paid','shipped','delivered')
    AND (m.order_id IS NULL OR m.supplier_status<>o.supplier_status
      OR m.tracking_number IS NOT o.tracking_number OR m.tracking_carrier IS NOT o.tracking_carrier)`)
    .all<{ order_number: string }>();
  const adapter = new MockLighthouseAdapter(db);
  let processed = 0; let errors = 0;
  for (const row of rows.results) {
    try { await adapter.syncOrder(row.order_number); processed++; } catch { errors++; }
  }
  return { processed, errors };
}

const actionSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('sync')}),z.object({action:z.literal('regenerate-feed')}),z.object({action:z.literal('dispatch-pending')}),
  z.object({action:z.literal('simulate-stock'),slug:z.string().min(1).max(120),stock:z.number().int().min(0).max(10000).optional()}),
  z.object({action:z.literal('simulate-order'),channel:z.enum(CHANNELS),slug:z.string().min(1).max(120),qty:z.number().int().min(1).max(99),idempotency_key:z.string().uuid().optional()}),
  z.object({action:z.literal('dispatch'),order_id:z.number().int().positive()}),
  z.object({action:z.literal('advance'),order_id:z.number().int().positive(),status:z.enum(['pending','processing','partial','shipped','error']).optional()}),
  z.object({action:z.literal('settings'),dispatch_mode:z.enum(['immediate','grouped'])}),
]);
export async function performAction(db: D1Database, raw: unknown, origin: string): Promise<unknown> {
  const action = actionSchema.parse(raw);
  switch (action.action) {
    case 'sync': {
      const result = await syncSupplier(db);
      await regenerateFeed(db,origin);
      return { ...result, marketplace_orders: await syncMarketplaceOrders(db) };
    }
    case 'regenerate-feed': return regenerateFeed(db,origin);
    case 'dispatch-pending': return processPendingOrders(db);
    case 'settings':
      await db.prepare("INSERT INTO integration_settings(key,value) VALUES ('dispatch_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(action.dispatch_mode).run();
      await recordEvent(db,'settings','Modo de envío actualizado',action.dispatch_mode === 'immediate' ? 'Inmediato' : 'Agrupado');
      return { dispatch_mode:action.dispatch_mode };
    case 'simulate-stock': {
      const product = await getProduct(db,action.slug);
      if (!product) throw new DemoError('Producto no encontrado.',404);
      const stock = action.stock ?? (product.stock === 7 ? 18 : 7);
      await db.prepare("UPDATE supplier_products SET stock=?,updated_at=datetime('now') WHERE code=?").bind(stock,product.supplier_sku).run();
      await recordEvent(db,'supplier','Cambio de stock simulado',`${product.name}: proveedor ${stock} unidades. Pendiente de sincronizar.`);
      return { slug:product.slug,previous_stock:product.stock,supplier_stock:stock,store_stock:product.stock };
    }
    case 'dispatch': return dispatchOrder(db,action.order_id);
    case 'advance': return advanceOrder(db,action.order_id,action.status);
    case 'simulate-order': {
      const key = action.idempotency_key ?? crypto.randomUUID();
      const input = action.channel === 'WEB'
        ? {lines:[{slug:action.slug,qty:action.qty}],customer:{name:'Laura Martínez (demo)',email:'laura@example.test',street:'Calle de la Demo, 18',city:'Castellón',postal_code:'12001'}}
        : await new MockLighthouseAdapter(db).incomingOrder({channel:action.channel,slug:action.slug,qty:action.qty,reference:key});
      const order = await createDemoOrder(db,{lines:input.lines,customer:input.customer,idempotency_key:key},action.channel);
      await regenerateFeed(db,origin);
      return order;
    }
  }
}
