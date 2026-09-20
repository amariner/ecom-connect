import { z } from 'zod';
import { shopConfig } from '../../shop.config';
import { quoteCart, quoteRequestSchema } from './quote';
import { generateOrderNumber } from './orders';
import { ORDER_STATUSES, decideTransition, type OrderStatus } from './order-transitions';
import { escapeLikePattern } from './db';
import { createOrderOperations } from '../composition/order-operations';
import { createD1OrderReader } from '../modules/orders/infrastructure/d1-order-reader';
import { createD1OrderReturns, type OrderReturn } from '../modules/orders/infrastructure/d1-order-returns';
import { RETURN_ACTIONS, decideReturnTransition, type ReturnAction } from '../modules/orders/domain/customer-return';
import { MockSupplierAdapter } from '../integrations/mock-supplier-adapter';
import { SupplierOrderError } from '../integrations/supplier-adapter';
import { MockLighthouseAdapter } from '../integrations/mock-lighthouse-adapter';
import { emailIdentitySubject, normalizeEmail } from '../modules/customers/domain/customer-identity';
import { createD1CustomerAuth } from '../modules/customers/infrastructure/d1-customer-auth';
import { CANCELLATION_REASONS, CANCELLATION_SOURCES, CHANNELS, SUPPLIER_ORDER_UPDATE_STATUSES, type Channel, type DemoOrder, type DispatchMode, type FeedProduct, type MarketplaceOrderUpdate, type OrderCancellation, type OrderFulfillment, type Product, type SupplierOrderUpdateStatus } from './demo-types';

export class DemoError extends Error {
  constructor(message: string, public readonly status = 400,
    public readonly details?: {code:'quote_changed';quote:ExpectedQuote}
      | {code:'supplier_price_changed';price:SupplierPricePair}
      | {code:'idempotency_conflict'}) { super(message); }
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
    supplier_status, supplier_order_id, supplier_dispatch_mode, last_supplier_sync, tracking_number, tracking_carrier, created_at } = order;
  return { id, order_number, channel, customer_name, total_cents, subtotal_cents, shipping_cents, status,
    supplier_status, supplier_order_id, supplier_dispatch_mode, last_supplier_sync, tracking_number, tracking_carrier, created_at };
}
export type PublicDemoOrder = ReturnType<typeof publicOrder>;
export const ORDER_SUPPLIER_FILTERS = ['pending_dispatch','accepted','processing','partial','shipped','error'] as const;
export type SupplierOrderFilter = typeof ORDER_SUPPLIER_FILTERS[number];
const supplierStatusFilters = {
  accepted:'SUPPLIER_ACCEPTED',processing:'SUPPLIER_PROCESSING',partial:'SUPPLIER_PARTIAL',
  shipped:'SUPPLIER_SHIPPED',error:'ERROR',
} as const;
export type OrderListResult = {
  orders: PublicDemoOrder[];
  pagination: { page: number; limit: number; total: number; pages: number };
  filters: { q: string; channel: Channel | ''; status: OrderStatus | ''; supplier: SupplierOrderFilter | '' };
};

const queryInteger = (fallback: number,maximum: number) => z.string().trim().regex(/^\d+$/)
  .transform(Number).pipe(z.number().int().min(1).max(maximum)).default(String(fallback));
const orderListQuerySchema = z.object({
  q:z.string().trim().max(120).default(''),
  channel:z.union([z.enum(CHANNELS),z.literal('')]).default(''),
  status:z.union([z.enum(ORDER_STATUSES),z.literal('')]).default(''),
  supplier:z.union([z.enum(ORDER_SUPPLIER_FILTERS),z.literal('')]).default(''),
  page:queryInteger(1,100000),
  limit:queryInteger(25,50),
});

/** SQLite LOWER no pliega letras acentuadas: normalizamos los caracteres del español. */
function orderSearchExpression(column: string): string {
  let expression = `COALESCE(${column},'')`;
  const folds: readonly (readonly [string,string])[] = [
    ['áÁàÀ','a'],['éÉèÈ','e'],['íÍ','i'],['óÓòÒ','o'],['úÚüÜ','u'],['ñÑ','n'],['çÇ','c'],
    ['\u0300\u0301\u0302\u0303\u0308\u0327',''],
  ];
  for (const [letters,replacement] of folds) {
    for (const letter of letters) expression = `REPLACE(${expression},'${letter}','${replacement}')`;
  }
  return `LOWER(${expression})`;
}

export async function getOrderList(db: D1Database, params: URLSearchParams): Promise<OrderListResult> {
  const query = orderListQuerySchema.parse(Object.fromEntries(params));
  const clauses: string[] = [];
  const values: string[] = [];
  if (query.q) {
    const folded = query.q.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es');
    const pattern = `%${escapeLikePattern(folded)}%`;
    // Un pedido parcial aún no tiene seguimiento propio: se busca también en sus expediciones.
    clauses.push(`(${['order_number','customer_name','supplier_order_id','tracking_number']
      .map(column => `${orderSearchExpression(column)} LIKE ? ESCAPE '\\'`).join(' OR ')}
      OR EXISTS (SELECT 1 FROM order_shipments c WHERE c.order_id=orders.id AND LOWER(c.tracking_number) LIKE ? ESCAPE '\\'))`);
    values.push(pattern,pattern,pattern,pattern,pattern);
  }
  if (query.channel) { clauses.push('channel=?'); values.push(query.channel); }
  if (query.status) { clauses.push('status=?'); values.push(query.status); }
  if (query.supplier === 'pending_dispatch') clauses.push(PENDING_SUPPLIER_SQL);
  // Un pedido cancelado ya no tiene una situación vigente en el proveedor.
  else if (query.supplier) { clauses.push("supplier_status=? AND status<>'cancelled'"); values.push(supplierStatusFilters[query.supplier]); }
  const where = clauses.join(' AND ') || '1=1';
  // Ambas lecturas comparten una transacción D1. El OFFSET se ajusta usando el
  // mismo conjunto filtrado; una página fuera de rango no produce falsos vacíos.
  const results = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total FROM orders WHERE ${where}`).bind(...values),
    db.prepare(`WITH filtered AS (SELECT * FROM orders WHERE ${where}),
      bounds AS (SELECT MAX(1,CAST((COUNT(*)+?-1)/? AS INTEGER)) AS pages FROM filtered)
      SELECT * FROM filtered ORDER BY id DESC LIMIT ?
      OFFSET (SELECT (MIN(?,pages)-1)*? FROM bounds)`)
      .bind(...values,query.limit,query.limit,query.limit,query.page,query.limit),
  ]);
  const count = results[0]?.results[0] as { total: number } | undefined;
  const rows = results[1]?.results as DemoOrder[] | undefined;
  if (!count || !rows) throw new DemoError('No se pudo consultar el historial de pedidos.',503);
  const pages = Math.max(1,Math.ceil(count.total/query.limit));
  return {
    orders:rows.map(publicOrder),
    pagination:{page:Math.min(query.page,pages),limit:query.limit,total:count.total,pages},
    filters:{q:query.q,channel:query.channel,status:query.status,supplier:query.supplier},
  };
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
// El resumen, el filtro del historial y el lote de despacho comparten este criterio.
const PENDING_SUPPLIER_SQL = "status='paid' AND supplier_stock_committed=0";
/** Pedidos de marketplace cuyo estado, expediciones o cancelación aún no constan comunicados. */
const MARKETPLACE_ACK_PENDING_SQL = `FROM orders o LEFT JOIN marketplace_order_updates m ON m.order_id=o.id
  WHERE o.channel<>'WEB' AND (o.status IN ('paid','shipped','delivered')
  AND (m.order_id IS NULL OR m.supplier_status<>o.supplier_status
    OR m.tracking_number IS NOT o.tracking_number OR m.tracking_carrier IS NOT o.tracking_carrier
    OR EXISTS (SELECT 1 FROM order_shipments c LEFT JOIN marketplace_shipment_updates u ON u.shipment_id=c.id
      WHERE c.order_id=o.id AND u.shipment_id IS NULL))
  OR EXISTS (SELECT 1 FROM order_cancellations x LEFT JOIN marketplace_cancellation_updates y ON y.order_id=x.order_id
    WHERE x.order_id=o.id AND o.status='cancelled' AND y.order_id IS NULL))`;
/** Excepciones operativas que alguien debe resolver. El orden es el de la portada del panel. */
const ATTENTION_SOURCES = [
  ['supplier_error',"FROM orders o WHERE o.status='paid' AND o.supplier_status='ERROR'"],
  ['partial_shipment',"FROM orders o WHERE o.status='paid' AND o.supplier_status='SUPPLIER_PARTIAL'"],
  ['marketplace_ack',MARKETPLACE_ACK_PENDING_SQL],
  ['cancellation',`FROM orders o WHERE o.status='cancelled' AND EXISTS (SELECT 1 FROM order_cancellations c
    WHERE c.order_id=o.id AND (c.supplier_outcome='rejected' OR c.cancelled_at IS NULL))`],
  // Una devolución aceptada espera al comprador; estas dos esperan al comercio.
  ['customer_return',`FROM orders o WHERE EXISTS (SELECT 1 FROM order_returns r
    WHERE r.order_id=o.id AND r.status IN ('requested','received'))`],
] as const;
export type AttentionKind = typeof ATTENTION_SOURCES[number][0];
type AttentionOrder = Pick<DemoOrder,'id'|'order_number'|'channel'>;
async function readAttention(db: D1Database) {
  // Una lectura por tipo: el total cuenta todo el historial y se listan los cinco más recientes.
  const results = await db.batch<AttentionOrder & { total: number }>(ATTENTION_SOURCES.map(([,source]) =>
    db.prepare(`SELECT o.id,o.order_number,o.channel,COUNT(*) OVER () AS total ${source} ORDER BY o.id DESC LIMIT 5`)));
  const items = ATTENTION_SOURCES.map(([kind],index) => {
    const rows = results[index]?.results ?? [];
    return { kind, count: rows[0]?.total ?? 0, orders: rows.map(({id,order_number,channel}) => ({id,order_number,channel})) };
  });
  return { total: items.reduce((sum,entry) => sum + entry.count,0), items };
}
type OrderSummary = { total: number; total_cents: number; pending_supplier: number };
type ChannelOrderSummary = OrderSummary & { channel: Channel; last_order: string };
export async function getState(db: D1Database, origin: string, scheduledDispatch = false) {
  const [products, ordersResult, runs, publications, events, mode, marketplaceUpdates, channelOrders, attention, dispatchRuns, paused] = await Promise.all([
    db.prepare('SELECT * FROM products ORDER BY id').all<Product>().then((result) => result.results),
    db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 100').all<DemoOrder>(),
    db.prepare('SELECT * FROM integration_runs WHERE id IN (SELECT MAX(id) FROM integration_runs GROUP BY integration)').all<{
      integration: string; processed: number; updated: number; errors: number; created_at: string;
    }>(),
    db.prepare('SELECT * FROM marketplace_publications').all<{ channel: Channel; published: number; synced_at: string }>(),
    db.prepare('SELECT * FROM integration_events ORDER BY id DESC LIMIT 30').all(), getDispatchMode(db),
    db.prepare(`SELECT channel,COUNT(*) AS orders_synced,MAX(synced_at) AS last_order_sync
      FROM marketplace_order_updates GROUP BY channel`).all<{ channel: Channel; orders_synced: number; last_order_sync: string }>(),
    db.prepare(`SELECT summary.channel,summary.total,summary.total_cents,summary.pending_supplier,
      latest.order_number AS last_order FROM (
        SELECT channel,COUNT(*) AS total,COALESCE(SUM(total_cents),0) AS total_cents,
          SUM(CASE WHEN ${PENDING_SUPPLIER_SQL} THEN 1 ELSE 0 END) AS pending_supplier,MAX(id) AS last_order_id
        FROM orders GROUP BY channel
      ) summary JOIN orders latest ON latest.id=summary.last_order_id`).all<ChannelOrderSummary>(),
    readAttention(db),
    db.prepare('SELECT * FROM dispatch_runs ORDER BY id DESC LIMIT 5').all<DispatchRun>(),
    db.prepare("SELECT value FROM integration_settings WHERE key='dispatch_paused'").first<string>('value'),
  ]);
  const orderSummary = channelOrders.results.reduce<OrderSummary>((summary,channel) => ({
    total:summary.total+channel.total,
    total_cents:summary.total_cents+channel.total_cents,
    pending_supplier:summary.pending_supplier+channel.pending_supplier,
  }),{total:0,total_cents:0,pending_supplier:0});
  const supplier = runs.results.find((run) => run.integration === 'supplier');
  const lighthouse = runs.results.find((run) => run.integration === 'lighthouse');
  return {
    products, orders: ordersResult.results.map(publicOrder), order_summary: orderSummary, attention,
    integrations: {
      supplier: { connected: true, status: 'simulated', last_sync: supplier?.created_at ?? null, processed: supplier?.processed ?? 0, updated: supplier?.updated ?? 0, errors: supplier?.errors ?? 0 },
      lighthouse: { connected: true, status: 'simulated', last_sync: lighthouse?.created_at ?? null,
        published: lighthouse?.processed ?? 0, feed_url: `${origin}/feeds/products.xml`, json_url: `${origin}/api/feeds/products.json`,
        orders_synced: marketplaceUpdates.results.reduce((total, row) => total + row.orders_synced, 0) },
    },
    settings: { dispatch_mode: mode, scheduled_dispatch: scheduledDispatch, dispatch_paused: paused === 'true' },
    dispatch_runs: dispatchRuns.results,
    marketplaces: CHANNELS.filter((channel) => channel !== 'WEB').map((channel) => {
      const publication = publications.results.find((row) => row.channel === channel);
      const order = channelOrders.results.find((row) => row.channel === channel);
      const updates = marketplaceUpdates.results.find((row) => row.channel === channel);
      return { channel, connected: true, published: publication?.published ?? 0,
        orders_count: order?.total ?? 0, total_cents: order?.total_cents ?? 0,
        pending_supplier: order?.pending_supplier ?? 0,
        last_order: order?.last_order ?? null, stock_synced: publication?.synced_at ?? null,
        orders_synced: updates?.orders_synced ?? 0, last_order_sync: updates?.last_order_sync ?? null };
    }), events: events.results,
  };
}
export async function getOrderDetail(db: D1Database, id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new DemoError('Pedido no encontrado.', 404);
  const order = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first<DemoOrder>();
  if (!order) throw new DemoError('Pedido no encontrado.', 404);
  const reader = createD1OrderReader(db);
  const [items, events, marketplaceAcknowledgement, fulfillment, cancellation, returns] = await Promise.all([
    reader.items(id), reader.events(id), readMarketplaceAcknowledgement(db,order), readFulfillment(db,id),
    // Una solicitud sin terminar no es una cancelación: solo se expone si el pedido ya lo está.
    db.prepare(`SELECT c.source,c.reason,c.supplier_outcome,c.requested_at,c.cancelled_at,u.synced_at AS marketplace_synced_at
      FROM order_cancellations c JOIN orders o ON o.id=c.order_id AND o.status='cancelled'
      LEFT JOIN marketplace_cancellation_updates u ON u.order_id=c.order_id
      WHERE c.order_id=?`).bind(id).first<OrderCancellation>(),
    createD1OrderReturns(db).listForOrder(id),
  ]);
  return { order: publicOrder(order), items, events, fulfillment, cancellation, returns, ...marketplaceAcknowledgement };
}
async function readFulfillment(db: D1Database, id: number): Promise<OrderFulfillment> {
  const [items, accepted, shipments, shipped] = await Promise.all([
    db.prepare(`SELECT p.supplier_sku,MIN(oi.name_snapshot) AS name,SUM(COALESCE(oi.current_qty,oi.qty)) AS ordered
      FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? GROUP BY p.supplier_sku ORDER BY p.supplier_sku`)
      .bind(id).all<{supplier_sku:string;name:string;ordered:number}>(),
    // Lo aceptado por el proveedor manda: una modificación posterior no cambia lo que expide.
    db.prepare(`SELECT json_extract(line.value,'$.code') AS supplier_sku,json_extract(line.value,'$.qty') AS ordered
      FROM orders o JOIN supplier_orders so ON so.reference=o.order_number,json_each(so.items_json) line
      WHERE o.id=? ORDER BY 1`).bind(id).all<{supplier_sku:string;ordered:number}>(),
    db.prepare(`SELECT c.id,c.sequence,c.expedition_number,c.tracking_number,c.tracking_carrier,c.shipped_at,
      u.synced_at AS marketplace_synced_at FROM order_shipments c
      LEFT JOIN marketplace_shipment_updates u ON u.shipment_id=c.id WHERE c.order_id=? ORDER BY c.sequence`)
      .bind(id).all<Omit<OrderFulfillment['shipments'][number],'units'|'lines'>>(),
    db.prepare(`SELECT l.shipment_id,l.supplier_sku,l.qty FROM order_shipment_lines l
      JOIN order_shipments c ON c.id=l.shipment_id WHERE c.order_id=? ORDER BY l.supplier_sku`)
      .bind(id).all<{shipment_id:number;supplier_sku:string;qty:number}>(),
  ]);
  const names = new Map(items.results.map(line => [line.supplier_sku,line.name]));
  const ordered = accepted.results.length
    ? accepted.results.map(line => ({...line,name:names.get(line.supplier_sku) ?? line.supplier_sku}))
    : items.results;
  const shippedBySku = new Map<string,number>();
  for (const line of shipped.results) shippedBySku.set(line.supplier_sku,(shippedBySku.get(line.supplier_sku) ?? 0) + line.qty);
  return {
    lines: ordered.map(line => {
      const units = shippedBySku.get(line.supplier_sku) ?? 0;
      return { ...line, shipped: units, pending: Math.max(0,line.ordered - units) };
    }),
    shipments: shipments.results.map(shipment => {
      const lines = shipped.results.filter(line => line.shipment_id === shipment.id)
        .map(line => ({supplier_sku:line.supplier_sku,name:names.get(line.supplier_sku) ?? line.supplier_sku,qty:line.qty}));
      return { ...shipment, units: lines.reduce((sum,line) => sum + line.qty,0), lines };
    }),
  };
}
export async function getConfirmation(db: D1Database, session: string) {
  if (!/^demo_[a-f0-9]{64}$/.test(session)) throw new DemoError('Confirmación no encontrada.', 404);
  const order = await db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').bind(session).first<DemoOrder>();
  if (!order || !['paid','shipped','delivered'].includes(order.status)) throw new DemoError('Confirmación no encontrada.', 404);
  const items = await createD1OrderReader(db).items(order.id);
  // El comprador acaba de escribir su correo: verlo aquí le dice con cuál entrar en su cuenta.
  return { ...publicOrder(order), email: order.email, lines: items, items };
}

/**
 * La reserva local resta solo lo que el proveedor aún no ha descontado. Un pedido
 * anulado allí ya devolvió sus unidades: siguen comprometidas hasta cancelarlo aquí.
 */
const RESERVED_ORDER_SQL = `o.status IN ('paid','shipped','delivered')
  AND NOT EXISTS (SELECT 1 FROM supplier_orders so WHERE so.reference=o.order_number
    AND NOT EXISTS (SELECT 1 FROM supplier_order_cancellations x WHERE x.supplier_order_id=so.supplier_order_id))`;
const RESERVED_QUANTITY_SQL = 'COALESCE(oi.current_qty,oi.qty)';
const AVAILABLE_STOCK_SQL = `MAX(0, s.stock - COALESCE((
  SELECT SUM(${RESERVED_QUANTITY_SQL}) FROM order_items oi
  JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=products.id
  AND ${RESERVED_ORDER_SQL}
),0))`;

export type SupplierStockSnapshot = {
  code: string; name: string; slug: string; store_product_id: number | null;
  supplier_active: boolean; store_active: boolean | null;
  supplier_stock: number; reserved_units: number; reserved_orders_count: number;
  theoretical_available: number; store_stock: number | null; stock_difference: number | null;
  supplier_price_cents: number; supplier_pvp_cents: number | null;
  store_price_cents: number | null; store_pvp_cents: number | null;
  supplier_updated_at: string; store_synced_at: string | null;
};
type SupplierStockSnapshotRow = Omit<SupplierStockSnapshot,'supplier_active' | 'store_active'> & {
  supplier_active: number; store_active: number | null;
};
const supplierStockCodeSchema = z.string().trim().min(1).max(120);

export async function getSupplierStockSnapshot(db: D1Database, rawCode: unknown): Promise<SupplierStockSnapshot> {
  const code = supplierStockCodeSchema.parse(rawCode);
  // Una sola lectura mantiene coherentes proveedor, reservas y proyección local.
  // La existencia del pedido remoto evita descontar dos veces si falta su acuse local.
  const row = await db.prepare(`WITH selected AS (
      SELECT s.code,COALESCE(p.name,s.name) AS name,COALESCE(p.slug,s.slug) AS slug,
        p.id AS store_product_id,s.active AS supplier_active,p.active AS store_active,
        s.stock AS supplier_stock,p.stock AS store_stock,s.updated_at AS supplier_updated_at,
        s.price_cents AS supplier_price_cents,s.pvp_cents AS supplier_pvp_cents,
        p.price_cents AS store_price_cents,p.compare_at_price_cents AS store_pvp_cents,
        p.last_synced_at AS store_synced_at
      FROM supplier_products s LEFT JOIN products p ON p.supplier_sku=s.code WHERE s.code=?
    ), reservations AS (
      SELECT COALESCE(SUM(${RESERVED_QUANTITY_SQL}),0) AS reserved_units,
        COUNT(DISTINCT CASE WHEN ${RESERVED_QUANTITY_SQL}>0 THEN oi.order_id END) AS reserved_orders_count
      FROM order_items oi JOIN orders o ON o.id=oi.order_id
      JOIN selected p ON p.store_product_id=oi.product_id WHERE ${RESERVED_ORDER_SQL}
    )
    SELECT selected.*,reservations.*,
      MAX(0,supplier_stock-reserved_units) AS theoretical_available,
      store_stock-MAX(0,supplier_stock-reserved_units) AS stock_difference
    FROM selected CROSS JOIN reservations`).bind(code).first<SupplierStockSnapshotRow>();
  if (!row) throw new DemoError('Artículo no encontrado en el proveedor demo.',404);
  return { ...row, supplier_active:row.supplier_active === 1,
    store_active:row.store_active === null ? null : row.store_active === 1 };
}

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
  if (current === null) {
    const inserted = await db.prepare(`INSERT INTO supplier_products(code,slug,name,description,price_cents,pvp_cents,discount,brand,vat,category,image,ean,sku,active,stock,backup_stock)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO NOTHING`)
      .bind(complete.code,complete.slug,complete.name,complete.description,complete.price_cents,complete.pvp_cents,complete.discount,
        complete.brand,complete.vat,complete.category,complete.image,complete.ean,complete.sku,complete.active,complete.stock,complete.backup_stock).run();
    if (inserted.meta.changes === 1) return {demo:true,created:true,updated:true,code:complete.code};
  }
  // Los nombres proceden del schema cerrado. Nunca reescribimos campos omitidos:
  // un parche de precio no puede restaurar stock descontado por otra petición.
  const entries = Object.entries(patch).filter(([key,value]) => key !== 'code' && value !== undefined);
  if (!entries.length) return {demo:true,created:false,updated:false,code:patch.code};
  const pvpExpression = patch.pvp_cents === undefined ? 'pvp_cents' : '?';
  const priceExpression = patch.price_cents === undefined ? 'price_cents' : '?';
  const result = await db.prepare(`UPDATE supplier_products SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=datetime('now')
    WHERE code=? AND (${pvpExpression} IS NULL OR ${pvpExpression}>${priceExpression})`)
    .bind(...entries.map(([,value]) => value),patch.code,
      ...(patch.pvp_cents === undefined ? [] : [patch.pvp_cents,patch.pvp_cents]),
      ...(patch.price_cents === undefined ? [] : [patch.price_cents])).run();
  if (result.meta.changes !== 1) {
    const latest = await db.prepare('SELECT code FROM supplier_products WHERE code=?').bind(patch.code).first();
    if (!latest) throw new DemoError('Artículo no encontrado.',404);
    throw new DemoError('El precio o el PVP del proveedor ha cambiado. Consulta los valores actuales antes de reintentar.',409);
  }
  return {demo:true,created:false,updated:true,code:complete.code};
}

const supplierCentsSchema = z.number().int().min(0).max(1000000);
const supplierPricePairSchema = z.object({price_cents:supplierCentsSchema,pvp_cents:supplierCentsSchema.nullable()})
  .refine(price => price.pvp_cents === null || price.pvp_cents > price.price_cents,
    {message:'El PVP de referencia debe superar el precio o ser null.',path:['pvp_cents']});
export type SupplierPricePair = z.infer<typeof supplierPricePairSchema>;
const supplierPriceChangeSchema = z.object({
  code:z.string().trim().min(1).max(120),price_cents:supplierCentsSchema,pvp_cents:supplierCentsSchema.nullable(),
  expected_price:supplierPricePairSchema,idempotency_key:z.string().uuid(),
});
type SupplierPriceChangeRow = {
  idempotency_key: string; request_hash: string; code: string;
  before_price_cents: number; before_pvp_cents: number | null;
  after_price_cents: number; after_pvp_cents: number | null;
  creation_token: string; created_at: string;
};
export type SupplierPriceChangeResult = {
  demo: true; replayed: boolean;
  change: {code:string;before:SupplierPricePair;after:SupplierPricePair;changed:boolean;created_at:string};
};
function priceChangeResult(row: SupplierPriceChangeRow, requestHash: string, token?: string): SupplierPriceChangeResult {
  if (row.request_hash !== requestHash) {
    throw new DemoError('Esta referencia ya se usó para otro cambio de precio.',409,{code:'idempotency_conflict'});
  }
  return {demo:true,replayed:row.creation_token !== token,change:{code:row.code,
    before:{price_cents:row.before_price_cents,pvp_cents:row.before_pvp_cents},
    after:{price_cents:row.after_price_cents,pvp_cents:row.after_pvp_cents},
    changed:row.before_price_cents !== row.after_price_cents || row.before_pvp_cents !== row.after_pvp_cents,
    created_at:row.created_at}};
}

export async function simulateSupplierPrice(db: D1Database, raw: unknown): Promise<SupplierPriceChangeResult> {
  const input = supplierPriceChangeSchema.parse(raw);
  supplierPricePairSchema.parse(input);
  const requestHash = await hashText(JSON.stringify({code:input.code,price_cents:input.price_cents,
    pvp_cents:input.pvp_cents,expected_price:input.expected_price}));
  const receiptQuery = () => db.prepare('SELECT * FROM supplier_price_changes WHERE idempotency_key=?')
    .bind(input.idempotency_key).first<SupplierPriceChangeRow>();
  const existing = await receiptQuery();
  if (existing) return priceChangeResult(existing,requestHash);
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const money = (cents: number | null) => cents === null ? 'sin PVP comparativo' : `${(cents/100).toFixed(2).replace('.',',')} €`;
  const detail = `${input.code}: precio ${money(input.expected_price.price_cents)} → ${money(input.price_cents)}; PVP ${money(input.expected_price.pvp_cents)} → ${money(input.pvp_cents)}. Pendiente de sincronizar.`;
  // El recibo, el par de precios y la actividad se confirman juntos. Solo la
  // petición que creó el recibo puede escribir; replays antiguos no revierten cambios posteriores.
  await db.batch([
    db.prepare(`INSERT INTO supplier_price_changes(idempotency_key,request_hash,code,before_price_cents,before_pvp_cents,
      after_price_cents,after_pvp_cents,creation_token,created_at)
      SELECT ?,?,code,price_cents,pvp_cents,?,?,?,? FROM supplier_products
      WHERE code=? AND price_cents=? AND pvp_cents IS ? ON CONFLICT(idempotency_key) DO NOTHING`)
      .bind(input.idempotency_key,requestHash,input.price_cents,input.pvp_cents,token,now,
        input.code,input.expected_price.price_cents,input.expected_price.pvp_cents),
    db.prepare(`UPDATE supplier_products SET price_cents=?,pvp_cents=?,updated_at=?
      WHERE code=? AND EXISTS (SELECT 1 FROM supplier_price_changes WHERE idempotency_key=? AND creation_token=?
        AND (before_price_cents<>after_price_cents OR before_pvp_cents IS NOT after_pvp_cents))`)
      .bind(input.price_cents,input.pvp_cents,now,input.code,input.idempotency_key,token),
    db.prepare(`INSERT INTO integration_events(kind,title,detail)
      SELECT 'supplier','Cambio de precio simulado',? FROM supplier_price_changes
      WHERE idempotency_key=? AND creation_token=?
        AND (before_price_cents<>after_price_cents OR before_pvp_cents IS NOT after_pvp_cents)`)
      .bind(detail,input.idempotency_key,token),
  ]);
  const receipt = await receiptQuery();
  if (receipt) return priceChangeResult(receipt,requestHash,token);
  const price = await db.prepare('SELECT price_cents,pvp_cents FROM supplier_products WHERE code=?')
    .bind(input.code).first<SupplierPricePair>();
  if (!price) throw new DemoError('Artículo no encontrado en el proveedor demo.',404);
  throw new DemoError('El precio del proveedor ha cambiado. Revisa los valores actuales antes de confirmar de nuevo.',409,
    {code:'supplier_price_changed',price});
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
const expectedCentsSchema = z.number().int().nonnegative().safe();
const expectedQuoteSchema = z.object({
  lines:z.array(z.object({slug:z.string().min(1).max(120),qty:z.number().int().min(1).max(99),unit_price_cents:expectedCentsSchema})).min(1).max(50),
  subtotal_cents:expectedCentsSchema,shipping_cents:expectedCentsSchema,total_cents:expectedCentsSchema,
}).superRefine((quote,context) => {
  if (new Set(quote.lines.map(line => line.slug)).size !== quote.lines.length) {
    context.addIssue({code:z.ZodIssueCode.custom,path:['lines'],message:'Cada producto debe aparecer una sola vez en el desglose esperado.'});
  }
}).transform(quote => ({...quote,lines:[...quote.lines].sort((left,right) => left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0)}));
export type ExpectedQuote = z.infer<typeof expectedQuoteSchema>;
export const checkoutSchema = z.object({ lines: quoteRequestSchema.shape.lines, customer: customerSchema,
  idempotency_key: z.string().uuid(),expected_quote:expectedQuoteSchema.optional() });
type CheckoutInput = z.infer<typeof checkoutSchema>;
export async function hashText(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2,'0')).join('');
}
/**
 * Deja el pedido a nombre del perfil de ese correo, creándolo si hace falta.
 * La compra sigue siendo de invitado: el comprador no necesita cuenta, pero
 * encontrará el pedido en «Mi cuenta» cuando entre con el mismo correo.
 */
async function linkOrderToCustomerProfile(db: D1Database, orderId: number, email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  const profile = await createD1CustomerAuth(db)
    .ensureProfile(normalized,await hashText(emailIdentitySubject(normalized)),new Date().toISOString());
  await db.prepare('UPDATE orders SET customer_profile_id=? WHERE id=? AND customer_profile_id IS NULL')
    .bind(profile.id,orderId).run();
}

export async function createDemoOrder(db: D1Database, input: CheckoutInput, channel: Channel = 'WEB') {
  const session = `demo_${await hashText(input.idempotency_key)}`;
  const expectedQuote = input.expected_quote === undefined ? undefined : expectedQuoteSchema.parse(input.expected_quote);
  const requestHash = await hashText(JSON.stringify({ channel, lines: input.lines, customer: input.customer,
    ...(expectedQuote ? {expected_quote:expectedQuote} : {}) }));
  let order = await db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').bind(session).first<DemoOrder>();
  if (order && order.request_hash !== requestHash) throw new DemoError('Esta referencia ya se usó para otro pedido.',409);
  const operations = createOrderOperations(db,undefined,undefined,{ reservationsEnabled: false });
  if (!order) {
    try {
      const quote = await quoteCart(db,{ lines:input.lines,postal_code:input.customer.postal_code },{ catalogReadMode:'legacy' });
      if (!quote.purchasable || quote.total_cents === null || quote.shipping_cents === null) throw new DemoError('Revisa la disponibilidad de los productos y el código postal.',409);
      if (expectedQuote) {
        const actualQuote = expectedQuoteSchema.parse({
          lines:quote.lines.map(({slug,qty,unit_price_cents}) => ({slug,qty,unit_price_cents})),
          subtotal_cents:quote.subtotal_cents,shipping_cents:quote.shipping_cents,total_cents:quote.total_cents,
        });
        if (JSON.stringify(expectedQuote) !== JSON.stringify(actualQuote)) {
          throw new DemoError('El precio o los gastos de envío han cambiado. Revisa el nuevo desglose antes de confirmar.',409,
            {code:'quote_changed',quote:actualQuote});
        }
      }
      const productRows = await getProducts(db);
      const bySlug = new Map(productRows.map((product) => [product.slug,product]));
      if (quote.lines.some(line => !bySlug.has(line.slug))) {
        throw new DemoError('La disponibilidad acaba de cambiar. Revisa tu cesta antes de confirmar.',409);
      }
      await operations.placeOrder({ order_number:generateOrderNumber(),email:input.customer.email,customer_name:input.customer.name,
        address_json:JSON.stringify(input.customer),subtotal_cents:quote.subtotal_cents,shipping_cents:quote.shipping_cents,total_cents:quote.total_cents,
        stripe_session_id:session,currency:shopConfig.currency.toUpperCase(),channel,request_hash:requestHash },
        quote.lines.map((line) => ({ product_id:bySlug.get(line.slug)!.id,name_snapshot:line.name,
          unit_price_cents:line.unit_price_cents,qty:line.qty,pricing_snapshot_json:JSON.stringify(line.pricing) })), 'simulated');
    } catch (error) {
      // Otra petición pudo guardar el mismo intento mientras cotizábamos. Su
      // resultado prevalece incluso si el catálogo cambió entre ambas lecturas.
      const replay = await db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').bind(session).first<DemoOrder>();
      if (!replay) throw error;
      if (replay.request_hash !== requestHash) throw new DemoError('Esta referencia ya se usó para otro pedido.',409);
    }
    order = await db.prepare('SELECT * FROM orders WHERE stripe_session_id=?').bind(session).first<DemoOrder>();
  }
  if (!order) throw new DemoError('No se pudo crear el pedido.',503);
  if (!['pending','paid','shipped','delivered'].includes(order.status)) {
    throw new DemoError('Este pedido ya no se puede confirmar. Revisa su estado en el panel.',409);
  }
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
  if (confirmed) {
    try { await recordEvent(db,'order',`Pedido ${order.order_number} recibido`,`${channel} → Logic2B Ecommerce · pago simulado confirmado.`); }
    catch { console.warn('order-activity-pending',order.order_number); }
  }
  let supplierWarning: string | undefined;
  // El reintento respeta la política capturada al insertar el pedido. NULL es
  // histórico sin política conocida y requiere gestión explícita en el panel.
  if (order.supplier_dispatch_mode === 'immediate') {
    try { await dispatchOrder(db,order.id); }
    catch (error) {
      if (!(error instanceof DemoError)) throw error;
      // El pedido ya está pagado: una incidencia del proveedor no invalida
      // la compra ni debe inducir al comprador a duplicarla. El panel conserva ERROR.
      supplierWarning = error.message;
    }
  }
  if (channel === 'WEB') {
    // El área de cliente es una superficie de la tienda web. Un fallo aquí no
    // invalida una compra pagada: el próximo acceso vuelve a reclamar el pedido.
    try { await linkOrderToCustomerProfile(db,order.id,input.customer.email); }
    catch { console.warn('order-customer-link-pending',order.order_number); }
  }
  const marketplaceWarning = await syncMarketplaceOrderBestEffort(db,order);
  return { order_number:order.order_number,order_id:order.id,url:`/gracias?session=${session}`,
    ...(supplierWarning ? {supplier_warning:supplierWarning} : {}),
    ...(marketplaceWarning ? {marketplace_warning:marketplaceWarning} : {}) };
}

/** La publicación del catálogo puede recuperarse sin repetir una compra pagada. */
export async function completeDemoCheckout(db: D1Database, input: CheckoutInput, origin: string, channel: Channel = 'WEB') {
  const order = await createDemoOrder(db,input,channel);
  try {
    await regenerateFeed(db,origin);
    return order;
  } catch {
    console.warn('checkout-feed-pending',order.order_number);
    return { ...order, feed_warning:'El pedido está confirmado. La publicación del catálogo en el hub demo queda pendiente; puedes reintentar desde Integraciones.' };
  }
}

export async function dispatchOrder(db: D1Database, id: number) {
  const order = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first<DemoOrder>();
  if (!order) throw new DemoError('Pedido no encontrado.',404);
  if (order.status === 'cancelled') throw new DemoError(CANCELLED_ORDER_MESSAGE,409);
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
      db.prepare(`INSERT INTO integration_events(kind,title,detail)
        SELECT 'supplier','Pedido ' || order_number || ' enviado al proveedor',? FROM orders
        WHERE id=? AND supplier_stock_committed=0 AND status<>'cancelled'`).bind(result.supplier_order_id,id),
      db.prepare(`INSERT INTO order_events(order_id,from_status,to_status,note)
        SELECT id,supplier_status,'SUPPLIER_ACCEPTED','Proveedor demo aceptó el pedido' FROM orders
        WHERE id=? AND supplier_stock_committed=0 AND status<>'cancelled'`).bind(id),
      db.prepare(`UPDATE orders SET supplier_status='SUPPLIER_ACCEPTED',supplier_order_id=?,supplier_stock_committed=1,last_supplier_sync=?,updated_at=datetime('now')
        WHERE id=? AND supplier_stock_committed=0 AND status<>'cancelled'`).bind(result.supplier_order_id,new Date().toISOString(),id),
    ]);
  } catch (error) {
    // El pedido pudo cancelarse mientras el proveedor lo aceptaba: no es una incidencia del proveedor.
    if (await settleCancelledOrder(db,order)) throw new DemoError(CANCELLED_ORDER_MESSAGE,409);
    const note = error instanceof SupplierOrderError && error.code === 'stock_unavailable'
      ? 'El proveedor demo no dispone de stock suficiente. Sincroniza y reintenta.'
      : 'No se pudo confirmar el envío al proveedor demo. Reintenta con la misma referencia.';
    // Estado e historial se escriben juntos. Un reintento fallido no duplica la
    // incidencia y una aceptación concurrente ya confirmada no se puede revertir.
    await db.batch([
      db.prepare(`INSERT INTO integration_events(kind,title,detail)
        SELECT 'supplier','Incidencia al enviar ' || order_number || ' al proveedor',? FROM orders
        WHERE id=? AND supplier_stock_committed=0 AND supplier_status<>'ERROR'`).bind(note,id),
      db.prepare(`INSERT INTO order_events(order_id,from_status,to_status,note)
        SELECT id,supplier_status,'ERROR',? FROM orders
        WHERE id=? AND supplier_stock_committed=0 AND supplier_status<>'ERROR'`).bind(note,id),
      db.prepare(`UPDATE orders SET supplier_status='ERROR',last_supplier_sync=?,updated_at=datetime('now')
        WHERE id=? AND supplier_stock_committed=0 AND supplier_status<>'ERROR'`).bind(new Date().toISOString(),id),
    ]);
    await syncMarketplaceOrderBestEffort(db,order);
    if (error instanceof SupplierOrderError) {
      throw new DemoError(error.code === 'stock_unavailable'
        ? 'El proveedor demo no dispone de stock suficiente. Sincroniza y reintenta.' : error.message,409);
    }
    throw new DemoError('No se pudo confirmar el envío al proveedor demo. Reintenta con la misma referencia.',503);
  }
  if (await settleCancelledOrder(db,order)) throw new DemoError(CANCELLED_ORDER_MESSAGE,409);
  const marketplaceWarning = await syncMarketplaceOrderBestEffort(db,order);
  return { ...await getOrderDetail(db,id), ...(marketplaceWarning ? {marketplace_warning:marketplaceWarning} : {}) };
}
export const DISPATCH_BATCH_LIMIT = 30;
const STALE_RUN_MINUTES = 10;
export type DispatchRun = {
  id: number; source: 'manual' | 'scheduled'; status: 'running' | 'completed' | 'skipped' | 'failed';
  reason: 'paused' | 'overlap' | 'interrupted' | 'unexpected_error' | null;
  processed: number; errors: number; remaining: number; started_at: string; finished_at: string | null;
};
async function recordSkippedRun(db: D1Database, source: DispatchRun['source'], reason: 'paused' | 'overlap') {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO dispatch_runs(source,status,reason,started_at,finished_at) VALUES (?,'skipped',?,?,?)`)
    .bind(source,reason,now,now).run();
  return { processed: 0, errors: 0, remaining: 0, status: 'skipped' as const, reason };
}
/**
 * Envía al proveedor los pedidos pendientes, de uno en uno y hasta el límite.
 * Cada ejecución queda registrada y solo puede haber una en curso: una segunda
 * se anota como omitida. Una ejecución interrumpida libera su turno a los diez minutos.
 */
export async function processPendingOrders(db: D1Database, options: { source?: DispatchRun['source']; limit?: number } = {}) {
  const source = options.source ?? 'manual';
  const limit = Math.min(Math.max(1,options.limit ?? DISPATCH_BATCH_LIMIT),DISPATCH_BATCH_LIMIT);
  const now = new Date();
  const [,started] = await db.batch([
    db.prepare(`UPDATE dispatch_runs SET status='failed',reason='interrupted',finished_at=?1 WHERE status='running' AND started_at<?2`)
      .bind(now.toISOString(),new Date(now.getTime() - STALE_RUN_MINUTES * 60_000).toISOString()),
    db.prepare(`INSERT INTO dispatch_runs(source,status,started_at) VALUES (?,'running',?)
      ON CONFLICT DO NOTHING RETURNING id`).bind(source,now.toISOString()),
  ]);
  const runId = (started?.results[0] as { id: number } | undefined)?.id;
  if (!runId) return recordSkippedRun(db,source,'overlap');
  let processed = 0; let errors = 0;
  try {
    const rows = await db.prepare(`SELECT id FROM orders WHERE ${PENDING_SUPPLIER_SQL} ORDER BY id LIMIT ?`).bind(limit).all<{id:number}>();
    for (const row of rows.results) { try { await dispatchOrder(db,row.id); processed++; } catch { errors++; } }
    const remaining = await db.prepare(`SELECT COUNT(*) AS total FROM orders WHERE ${PENDING_SUPPLIER_SQL}`).first<number>('total') ?? 0;
    await db.prepare(`UPDATE dispatch_runs SET status='completed',processed=?,errors=?,remaining=?,finished_at=? WHERE id=?`)
      .bind(processed,errors,remaining,new Date().toISOString(),runId).run();
    return { processed, errors, remaining, status: 'completed' as const, reason: null };
  } catch (error) {
    // El turno se libera siempre: un fallo inesperado no debe bloquear las siguientes ejecuciones.
    await db.prepare(`UPDATE dispatch_runs SET status='failed',reason='unexpected_error',processed=?,errors=?,finished_at=? WHERE id=?`)
      .bind(processed,errors,new Date().toISOString(),runId).run().catch(() => undefined);
    throw error;
  }
}
/** Ejecución programada. La pausa solo detiene este origen: una persona siempre puede enviar a mano. */
export async function runScheduledDispatch(db: D1Database) {
  const paused = await db.prepare("SELECT value FROM integration_settings WHERE key='dispatch_paused'").first<string>('value');
  return paused === 'true' ? recordSkippedRun(db,'scheduled','paused') : processPendingOrders(db,{source:'scheduled'});
}
const SUPPLIER_STATUS_SQL = `CASE so.status WHEN 'pending' THEN 'SUPPLIER_ACCEPTED'
  WHEN 'processing' THEN 'SUPPLIER_PROCESSING' WHEN 'partial' THEN 'SUPPLIER_PARTIAL'
  WHEN 'shipped' THEN 'SUPPLIER_SHIPPED' ELSE 'ERROR' END`;
/** Expediciones del proveedor que el pedido ?1 todavía no ha registrado. */
const NEW_SHIPMENTS_SQL = `supplier_shipments s JOIN supplier_orders so ON so.supplier_order_id=s.supplier_order_id
  JOIN orders o ON o.order_number=so.reference
  WHERE o.id=?1 AND NOT EXISTS (SELECT 1 FROM order_shipments c WHERE c.order_id=o.id AND c.sequence=s.sequence)`;

/**
 * Proyecta estado, seguimiento y expediciones DENTRO de una transacción: una
 * respuesta remota más lenta no puede revertir el tracking de otra llamada
 * concurrente, y cada expedición deja un único movimiento aunque se repita.
 */
async function projectSupplierOrder(db: D1Database, id: number) {
  // Una expedición nueva ya explica el cambio de estado: no se duplica el movimiento.
  const statusChanged = `o.id=?1 AND o.supplier_status<>${SUPPLIER_STATUS_SQL} AND NOT EXISTS (SELECT 1 FROM ${NEW_SHIPMENTS_SQL})`;
  await db.batch([
    db.prepare(`INSERT INTO integration_events(kind,title,detail)
      SELECT 'tracking','Proveedor · ' || o.order_number,COALESCE(so.tracking,${SUPPLIER_STATUS_SQL})
      FROM orders o JOIN supplier_orders so ON so.reference=o.order_number WHERE ${statusChanged}`).bind(id),
    db.prepare(`INSERT INTO order_events(order_id,from_status,to_status,note)
      SELECT o.id,o.supplier_status,${SUPPLIER_STATUS_SQL},COALESCE('Expedición ficticia: ' || so.tracking,'Proveedor demo: ' || so.status)
      FROM orders o JOIN supplier_orders so ON so.reference=o.order_number WHERE ${statusChanged}`).bind(id),
    db.prepare(`INSERT INTO integration_events(kind,title,detail)
      SELECT 'tracking','Proveedor · ' || o.order_number,s.tracking FROM ${NEW_SHIPMENTS_SQL} ORDER BY s.sequence`).bind(id),
    db.prepare(`INSERT INTO order_events(order_id,from_status,to_status,note)
      SELECT o.id,o.supplier_status,${SUPPLIER_STATUS_SQL},'Expedición ficticia ' || s.sequence || ': ' || s.tracking || ' · '
        || (SELECT SUM(l.qty) || CASE SUM(l.qty) WHEN 1 THEN ' ud.' ELSE ' uds.' END FROM supplier_shipment_lines l WHERE l.shipment_id=s.id)
      FROM ${NEW_SHIPMENTS_SQL} ORDER BY s.sequence`).bind(id),
    db.prepare(`INSERT INTO order_shipments(order_id,sequence,expedition_number,tracking_number,tracking_carrier,shipped_at)
      SELECT o.id,s.sequence,s.expedition_number,s.tracking,'Proveedor Demo',?2 FROM ${NEW_SHIPMENTS_SQL} ORDER BY s.sequence`)
      .bind(id,new Date().toISOString()),
    db.prepare(`INSERT INTO order_shipment_lines(shipment_id,supplier_sku,qty)
      SELECT c.id,l.code,l.qty FROM order_shipments c JOIN orders o ON o.id=c.order_id
      JOIN supplier_orders so ON so.reference=o.order_number
      JOIN supplier_shipments s ON s.supplier_order_id=so.supplier_order_id AND s.sequence=c.sequence
      JOIN supplier_shipment_lines l ON l.shipment_id=s.id WHERE c.order_id=?1 ON CONFLICT DO NOTHING`).bind(id),
    db.prepare(`UPDATE orders SET
      (supplier_status,tracking_number,tracking_carrier)=(SELECT ${SUPPLIER_STATUS_SQL},so.tracking,
        CASE WHEN so.tracking IS NOT NULL THEN 'Proveedor Demo' ELSE NULL END
        FROM supplier_orders so WHERE so.reference=orders.order_number),
      last_supplier_sync=?,status=CASE WHEN status='paid' AND EXISTS(SELECT 1 FROM supplier_orders so
        WHERE so.reference=orders.order_number AND so.status='shipped') THEN 'shipped' ELSE status END,
      updated_at=datetime('now') WHERE id=?`).bind(new Date().toISOString(),id),
  ]);
}
const shipmentLinesSchema = z.object({
  lines: z.array(z.object({supplier_sku:z.string().trim().min(1).max(120),qty:z.number().int().min(1).max(10000)})).min(1).max(50),
  idempotency_key: z.string().uuid(),
});
/** Registra una expedición del proveedor demo con las unidades indicadas de cada referencia. */
export async function shipOrderLines(db: D1Database, id: number, raw: unknown) {
  const input = shipmentLinesSchema.parse(raw);
  const order = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first<DemoOrder>();
  if (!order) throw new DemoError('Pedido no encontrado.',404);
  if (order.status === 'cancelled') throw new DemoError(CANCELLED_ORDER_MESSAGE,409);
  if (!order.supplier_order_id) throw new DemoError('Envía primero el pedido al proveedor.',409);
  try {
    await new MockSupplierAdapter(db).shipOrder(order.order_number,{requestKey:input.idempotency_key,
      lines:input.lines.map(line => ({code:line.supplier_sku,qty:line.qty}))});
  } catch (error) {
    if (error instanceof SupplierOrderError) throw new DemoError(error.message,error.code === 'invalid_input' ? 400 : 409);
    throw error;
  }
  await projectSupplierOrder(db,id);
  const marketplaceWarning = await syncMarketplaceOrderBestEffort(db,order);
  return { ...await getOrderDetail(db,id), ...(marketplaceWarning ? {marketplace_warning:marketplaceWarning} : {}) };
}
const CANCELLED_ORDER_MESSAGE = 'Este pedido está cancelado y no admite más acciones del proveedor.';
const cancellationSchema = z.object({ reason: z.enum(CANCELLATION_REASONS), source: z.enum(CANCELLATION_SOURCES) });
/** Deja constancia de un rechazo sin repetir el mismo aviso en reintentos consecutivos. */
async function recordCancellationRejection(db: D1Database, order: DemoOrder, note: string) {
  const repeated = `(SELECT note FROM order_events WHERE order_id=?1 ORDER BY id DESC LIMIT 1) IS ?2`;
  await db.batch([
    db.prepare(`INSERT INTO integration_events(kind,title,detail)
      SELECT 'supplier','Cancelación rechazada · ' || ?3,?2 WHERE NOT ${repeated}`).bind(order.id,note,order.order_number),
    db.prepare(`INSERT INTO order_events(order_id,from_status,to_status,note)
      SELECT ?1,?3,?3,?2 WHERE NOT ${repeated}`).bind(order.id,note,order.status),
  ]);
}
/**
 * Cierra una cancelación ya decidida: anula en el proveedor un pedido que siga
 * activo, fija su respuesta y anota el movimiento una sola vez. Devuelve false si
 * el pedido no está cancelado. La usan la cancelación, el envío y la conciliación.
 */
async function settleCancelledOrder(db: D1Database, order: Pick<DemoOrder,'id'|'order_number'>): Promise<boolean> {
  if (await db.prepare('SELECT status FROM orders WHERE id=?').bind(order.id).first<string>('status') !== 'cancelled') return false;
  const adapter = new MockSupplierAdapter(db);
  let shippedAnyway = false;
  try { if (await adapter.orderStatus(order.order_number)) await adapter.cancelOrder(order.order_number); }
  catch (error) {
    if (!(error instanceof SupplierOrderError)) throw error;
    // Un envío y una expedición simultáneos ganaron al aviso: queda constancia para revisarlo.
    shippedAnyway = true;
  }
  const supplierOutcome = shippedAnyway ? "'rejected'" : `CASE WHEN EXISTS (SELECT 1 FROM supplier_order_cancellations x
    JOIN supplier_orders so ON so.supplier_order_id=x.supplier_order_id WHERE so.reference=o.order_number)
    THEN 'accepted' ELSE 'not_required' END`;
  const reasons = `CASE c.reason WHEN 'customer_request' THEN 'lo solicita el cliente' WHEN 'out_of_stock' THEN 'sin existencias para servirlo'
    WHEN 'duplicate' THEN 'pedido duplicado' ELSE 'otro motivo' END`;
  // Quién la pidió se lee en el propio movimiento: una cancelación del comprador
  // no es una decisión del comercio, y su motivo ya lo dice el origen.
  const note = `CASE c.source WHEN 'marketplace' THEN 'Cancelado a petición del marketplace · ' || ${reasons}
    WHEN 'account' THEN 'Cancelado por el cliente desde su cuenta'
    ELSE 'Cancelado desde el panel · ' || ${reasons} END`;
  const unsettled = 'FROM order_cancellations c JOIN orders o ON o.id=c.order_id WHERE c.order_id=?1 AND c.cancelled_at IS NULL';
  await db.batch([
    // El núcleo anota una cancelación genérica: aquí se completa con su origen y motivo.
    db.prepare(`UPDATE order_events SET note=(SELECT ${note} ${unsettled})
      WHERE id=(SELECT MAX(e.id) FROM order_events e WHERE e.order_id=?1 AND e.to_status='cancelled' AND e.note='Cancelado desde el panel')
        AND EXISTS (SELECT 1 ${unsettled})`).bind(order.id),
    db.prepare(`INSERT INTO integration_events(kind,title,detail)
      SELECT 'orders','Pedido ' || o.order_number || ' cancelado',${note} ${unsettled}`).bind(order.id),
    db.prepare(`INSERT INTO integration_events(kind,title,detail)
      SELECT 'supplier','Incidencia de cancelación · ' || o.order_number,
        'El proveedor demo expidió unidades mientras se cancelaba. Revisa el pedido y gestiona su devolución.'
      FROM order_cancellations c JOIN orders o ON o.id=c.order_id
      WHERE c.order_id=?1 AND c.supplier_outcome<>'rejected' AND ?2=1`).bind(order.id,shippedAnyway ? 1 : 0),
    db.prepare(`UPDATE order_cancellations SET cancelled_at=COALESCE(cancelled_at,?2),
        supplier_outcome=(SELECT ${supplierOutcome} FROM orders o WHERE o.id=order_cancellations.order_id)
      WHERE order_id=?1 AND supplier_outcome<>'rejected'`).bind(order.id,new Date().toISOString()),
  ]);
  return true;
}
/**
 * Cancela un pedido del circuito omnicanal. La solicitud se guarda primero y el
 * proveedor responde antes que la tienda: si ya expidió unidades, nada cambia.
 * Después el núcleo cancela y repone el stock de tienda. Repetir la solicitud, o
 * perder la conexión a mitad, completa la cancelación sin reponer dos veces.
 */
export async function cancelOrder(db: D1Database, id: number, raw: unknown) {
  const input = cancellationSchema.parse(raw);
  const order = Number.isSafeInteger(id) && id > 0
    ? await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first<DemoOrder>() : null;
  if (!order) throw new DemoError('Pedido no encontrado.',404);
  if (input.source === 'marketplace' && order.channel === 'WEB') {
    throw new DemoError('Un pedido de la tienda web no puede cancelarse desde un marketplace.',409);
  }
  const reject = async (note: string): Promise<never> => {
    await db.prepare("DELETE FROM order_cancellations WHERE order_id=? AND cancelled_at IS NULL AND supplier_outcome='pending'").bind(id).run();
    await recordCancellationRejection(db,order,note);
    throw new DemoError(note,409);
  };
  if (order.status !== 'cancelled') {
    if (order.status !== 'pending' && order.status !== 'paid') {
      await reject('Cancelación rechazada: el pedido ya está enviado. Corresponde gestionar una devolución.');
    }
    // La primera solicitud fija origen y motivo: las simultáneas solo la completan.
    await db.prepare(`INSERT INTO order_cancellations(order_id,source,reason,requested_at) VALUES (?,?,?,?)
      ON CONFLICT(order_id) DO NOTHING`).bind(id,input.source,input.reason,new Date().toISOString()).run();
    const adapter = new MockSupplierAdapter(db);
    try { if (await adapter.orderStatus(order.order_number)) await adapter.cancelOrder(order.order_number); }
    catch (error) {
      if (!(error instanceof SupplierOrderError)) throw error;
      await reject('Cancelación rechazada: el proveedor demo ya ha expedido unidades. Corresponde gestionar una devolución.');
    }
    const operations = createOrderOperations(db,undefined,undefined,{ reservationsEnabled: false });
    const transition = decideTransition(order.status as OrderStatus,{to:'cancelled'});
    // Otra escritura de stock o una cancelación simultánea pueden invalidar lo leído: se relee y se reintenta.
    for (let attempt = 0; attempt < 2 && transition.ok && transition.to === 'cancelled'; attempt++) {
      const current = await operations.findOrderForTransition(id);
      if (!current || current.status !== order.status) break;
      try { await operations.applyPanelTransition({ order: current, from: order.status as OrderStatus, transition }); break; }
      catch (error) { console.warn('order-cancellation-retry',order.order_number,error instanceof Error ? error.message : error); }
    }
  }
  if (!await settleCancelledOrder(db,order)) {
    throw new DemoError('No se pudo completar la cancelación. Vuelve a intentarlo: el stock no se repondrá dos veces.',409);
  }
  const marketplaceWarning = await syncMarketplaceOrderBestEffort(db,order);
  return { ...await getOrderDetail(db,id), ...(marketplaceWarning ? {marketplace_warning:marketplaceWarning} : {}) };
}
/**
 * Confirma la entrega de un pedido ya enviado. Es el paso que faltaba para que
 * el comprador pueda pedir una devolución: la prueba de entrega la da el
 * comercio, no él. Repetirlo no vuelve a anotar el movimiento.
 */
export async function deliverOrder(db: D1Database, id: number) {
  const order = Number.isSafeInteger(id) && id > 0
    ? await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first<DemoOrder>() : null;
  if (!order) throw new DemoError('Pedido no encontrado.',404);
  if (order.status !== 'delivered') {
    const transition = decideTransition(order.status as OrderStatus,{to:'delivered'});
    if (!transition.ok || transition.to !== 'delivered') {
      throw new DemoError(order.status === 'cancelled' ? CANCELLED_ORDER_MESSAGE
        : 'Solo se puede confirmar la entrega de un pedido ya enviado.',409);
    }
    const operations = createOrderOperations(db,undefined,undefined,{ reservationsEnabled: false });
    const current = await operations.findOrderForTransition(id);
    // Otra pestaña pudo confirmarla mientras tanto: su resultado es el vigente.
    if (current && current.status === order.status) {
      try { await operations.applyPanelTransition({ order: current, from: order.status as OrderStatus, transition }); }
      catch { console.warn('order-delivery-retry',order.order_number); }
    }
    const settled = await db.prepare('SELECT status FROM orders WHERE id=?').bind(id).first<{status:string}>();
    if (settled?.status !== 'delivered') throw new DemoError('No se pudo confirmar la entrega. Vuelve a intentarlo.',409);
    try { await recordEvent(db,'orders',`Pedido ${order.order_number} entregado`,
      'Entrega confirmada en el panel. El comprador ya puede pedir su devolución.'); }
    catch { console.warn('order-activity-pending',order.order_number); }
  }
  const marketplaceWarning = await syncMarketplaceOrderBestEffort(db,order);
  return { ...await getOrderDetail(db,id), ...(marketplaceWarning ? {marketplace_warning:marketplaceWarning} : {}) };
}

export async function advanceOrder(db: D1Database, id: number, status: SupplierOrderUpdateStatus) {
  z.enum(SUPPLIER_ORDER_UPDATE_STATUSES).parse(status);
  const order = await db.prepare('SELECT * FROM orders WHERE id=?').bind(id).first<DemoOrder>();
  if (order?.status === 'cancelled') throw new DemoError(CANCELLED_ORDER_MESSAGE,409);
  if (!order?.supplier_order_id) throw new DemoError('Envía primero el pedido al proveedor.',409);
  try {
    await new MockSupplierAdapter(db).advanceOrder(order.order_number,status);
  } catch (error) {
    if (error instanceof SupplierOrderError) throw new DemoError(error.message,error.code === 'invalid_input' ? 400 : 409);
    throw error;
  }
  await projectSupplierOrder(db,id);
  const marketplaceWarning = await syncMarketplaceOrderBestEffort(db,order);
  return { ...await getOrderDetail(db,id), ...(marketplaceWarning ? {marketplace_warning:marketplaceWarning} : {}) };
}

/** Repara acuses pendientes sin reenviar al proveedor ni descontar inventario. */
export async function syncMarketplaceOrders(db: D1Database) {
  // Cancelaciones interrumpidas o con el pedido del proveedor todavía activo.
  const unsettled = await db.prepare(`SELECT o.id,o.order_number FROM orders o JOIN order_cancellations c ON c.order_id=o.id
    WHERE o.status='cancelled' AND c.supplier_outcome<>'rejected' AND (c.cancelled_at IS NULL OR EXISTS (
      SELECT 1 FROM supplier_orders so WHERE so.reference=o.order_number AND so.status<>'shipped'
        AND NOT EXISTS (SELECT 1 FROM supplier_order_cancellations x WHERE x.supplier_order_id=so.supplier_order_id)))
    ORDER BY o.id LIMIT 30`).all<Pick<DemoOrder,'id'|'order_number'>>();
  for (const order of unsettled.results) {
    try { await settleCancelledOrder(db,order); } catch { console.warn('order-cancellation-pending',order.order_number); }
  }
  const rows = await db.prepare(`SELECT o.order_number ${MARKETPLACE_ACK_PENDING_SQL}`)
    .all<{ order_number: string }>();
  const adapter = new MockLighthouseAdapter(db);
  let processed = 0; let errors = 0;
  for (const row of rows.results) {
    try { await adapter.syncOrder(row.order_number); processed++; } catch { errors++; }
  }
  return { processed, errors };
}

const returnNotes: Record<ReturnAction,string> = {
  accept:'Devolución aceptada. Faltan los artículos por llegar.',
  reject:'Devolución rechazada.', receive:'Artículos recibidos y repuestos en el stock de la tienda.',
  refund:'Reembolso simulado registrado.', cancel:'Solicitud anulada por el comprador.',
};

/**
 * Aplica una decisión sobre una devolución. La comparten el panel y la cuenta
 * del comprador: quien la pide cambia, la política no. La reposición de stock y
 * el importe del reembolso simulado los decide esta función, nunca quien llama.
 */
export async function applyReturnAction(db: D1Database, current: OrderReturn, action: ReturnAction,
  actor: 'customer' | 'panel', note?: string | null): Promise<OrderReturn> {
  const transition = decideReturnTransition(current.status,action);
  if (!transition.ok) throw new DemoError(transition.error,409);
  const returns = createD1OrderReturns(db);
  const refundCents = transition.to === 'refunded'
    ? current.lines.reduce((sum,line) => sum + line.qty * line.unit_price_cents,0) : 0;
  const applied = await returns.transition({
    id:current.id, from:current.status, to:transition.to, version:current.version, action, actor,
    note:note?.trim() || null, refund_cents:refundCents, now:new Date().toISOString(),
  });
  // Otra pestaña pudo decidir lo mismo antes: su resultado es el vigente.
  const updated = (await returns.listForOrder(current.order_id)).find((entry) => entry.id === current.id);
  if (!updated) throw new DemoError('No se pudo leer la devolución.',503);
  if (applied) {
    try {
      await recordEvent(db,'orders',`Devolución ${current.return_number} · ${updated.status}`,
        `${current.order_number}: ${returnNotes[action]}`);
    } catch { console.warn('return-activity-pending',current.return_number); }
  }
  return updated;
}

const returnActionSchema = z.object({ return_id:z.string().trim().min(8).max(80),
  action:z.enum(RETURN_ACTIONS), note:z.string().trim().max(300).optional() });

/** Decisión del comercio sobre una devolución. Anularla solo puede el comprador. */
export async function decideReturn(db: D1Database, raw: unknown): Promise<OrderReturn> {
  const input = returnActionSchema.parse(raw);
  if (input.action === 'cancel') throw new DemoError('Solo el comprador puede anular su solicitud.',409);
  const returns = createD1OrderReturns(db);
  const current = (await db.prepare('SELECT order_id FROM order_returns WHERE id=?').bind(input.return_id)
    .first<{ order_id: number }>());
  const found = current && (await returns.listForOrder(current.order_id)).find((entry) => entry.id === input.return_id);
  if (!found) throw new DemoError('Devolución no encontrada.',404);
  return applyReturnAction(db,found,input.action,'panel',input.note ?? null);
}

const actionSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('sync')}),z.object({action:z.literal('regenerate-feed')}),z.object({action:z.literal('dispatch-pending')}),
  z.object({action:z.literal('simulate-stock'),slug:z.string().min(1).max(120),stock:z.number().int().min(0).max(10000).optional()}),
  z.object({action:z.literal('simulate-price'),...supplierPriceChangeSchema.shape}),
  z.object({action:z.literal('simulate-order'),channel:z.enum(CHANNELS),slug:z.string().min(1).max(120),qty:z.number().int().min(1).max(99),idempotency_key:z.string().uuid().optional()}),
  z.object({action:z.literal('dispatch'),order_id:z.number().int().positive()}),
  z.object({action:z.literal('advance'),order_id:z.number().int().positive(),status:z.enum(SUPPLIER_ORDER_UPDATE_STATUSES)}),
  z.object({action:z.literal('ship-lines'),order_id:z.number().int().positive(),...shipmentLinesSchema.shape}),
  z.object({action:z.literal('cancel-order'),order_id:z.number().int().positive(),
    reason:z.enum(CANCELLATION_REASONS),source:z.enum(['panel','marketplace'])}),
  z.object({action:z.literal('deliver'),order_id:z.number().int().positive()}),
  z.object({action:z.literal('decide-return'),return_id:z.string().trim().min(8).max(80),
    decision:z.enum(RETURN_ACTIONS),note:z.string().trim().max(300).optional()}),
  z.object({action:z.literal('settings'),dispatch_mode:z.enum(['immediate','grouped']).optional(),dispatch_paused:z.boolean().optional()}),
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
    case 'simulate-price': return simulateSupplierPrice(db,action);
    case 'settings': {
      if (action.dispatch_mode === undefined && action.dispatch_paused === undefined) throw new DemoError('Indica el ajuste que quieres cambiar.',400);
      const upsert = "INSERT INTO integration_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
      if (action.dispatch_mode !== undefined) {
        await db.prepare(upsert).bind('dispatch_mode',action.dispatch_mode).run();
        await recordEvent(db,'settings','Modo de envío actualizado',action.dispatch_mode === 'immediate' ? 'Inmediato' : 'Agrupado');
      }
      if (action.dispatch_paused !== undefined) {
        await db.prepare(upsert).bind('dispatch_paused',String(action.dispatch_paused)).run();
        await recordEvent(db,'settings','Envío programado',action.dispatch_paused ? 'En pausa' : 'Reanudado');
      }
      return { dispatch_mode:await getDispatchMode(db),
        dispatch_paused:await db.prepare("SELECT value FROM integration_settings WHERE key='dispatch_paused'").first<string>('value') === 'true' };
    }
    case 'simulate-stock': {
      // La gestión del proveedor incluye referencias importadas inactivas;
      // consultar una referencia aquí no la publica ni cambia su estado.
      const product = await db.prepare('SELECT * FROM products WHERE slug=?').bind(action.slug).first<Product>();
      if (!product) throw new DemoError('Producto no encontrado.',404);
      const stock = action.stock ?? (product.stock === 7 ? 18 : 7);
      await db.prepare("UPDATE supplier_products SET stock=?,updated_at=datetime('now') WHERE code=?").bind(stock,product.supplier_sku).run();
      await recordEvent(db,'supplier','Cambio de stock simulado',`${product.name}: proveedor ${stock} unidades. Pendiente de sincronizar.`);
      return { slug:product.slug,previous_stock:product.stock,supplier_stock:stock,store_stock:product.stock };
    }
    case 'dispatch': return dispatchOrder(db,action.order_id);
    case 'advance': return advanceOrder(db,action.order_id,action.status);
    case 'deliver': return deliverOrder(db,action.order_id);
    case 'ship-lines': return shipOrderLines(db,action.order_id,action);
    case 'cancel-order': return cancelOrder(db,action.order_id,action);
    case 'decide-return': {
      const decided = await decideReturn(db,{return_id:action.return_id,action:action.decision,note:action.note});
      return getOrderDetail(db,decided.order_id);
    }
    case 'simulate-order': {
      const key = action.idempotency_key ?? crypto.randomUUID();
      const input = action.channel === 'WEB'
        ? {lines:[{slug:action.slug,qty:action.qty}],customer:{name:'Laura Martínez (demo)',email:'laura@example.test',street:'Calle de la Demo, 18',city:'Castellón',postal_code:'12001'}}
        : await new MockLighthouseAdapter(db).incomingOrder({channel:action.channel,slug:action.slug,qty:action.qty,reference:key});
      return completeDemoCheckout(db,{lines:input.lines,customer:input.customer,idempotency_key:key},origin,action.channel);
    }
  }
}
