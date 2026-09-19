import { createOrderJourney, hasCurrentMarketplaceAcknowledgement } from './order-journey';
import { LatestOrderRequest, orderListPath, orderStatuses, readOrderFilters, safeOrderReturnPath } from './order-pagination';
import { SupplierStockSelection, type SupplierStockSnapshot } from './supplier-stock';
import { SupplierPriceEditor, SupplierPriceSubmissionError, submitSupplierPrice, type SupplierPriceAttempt } from './supplier-price';
import { categoryName } from '../shop/catalog';
import { matchesProductFilters, productListPath, readProductFilters } from './product-filters';

type Product = { id: number; slug: string; name: string; description: string; price_cents: number; compare_at_price_cents?: number | null; stock: number; image: string; category: string; active: boolean | number; sku: string; supplier_sku: string; ean: string; brand: string; vat: number; last_synced_at?: string };
type Order = { id: number; order_number: string; channel: string; customer_name: string; total_cents: number; status: string; supplier_status: string; supplier_order_id?: string; last_supplier_sync?: string; tracking_number?: string; tracking_carrier?: string | null; created_at: string; [key: string]: unknown };
type DemoEvent = { id?: number; type?: string; kind?: string; title?: string; detail?: string; message?: string; note?: string; description?: string; created_at: string; from_status?: string; to_status?: string };
type State = { products: Product[]; orders: Order[]; order_summary: { total: number; total_cents: number; pending_supplier: number }; integrations: { supplier: { last_sync?: string; processed: number; updated: number; errors: number }; lighthouse: { last_sync?: string; published: number; feed_url?: string; json_url?: string; orders_synced: number } }; settings: { dispatch_mode: 'immediate' | 'grouped'; scheduled_dispatch: boolean }; marketplaces: { channel: string; published: number; orders_count: number; total_cents: number; pending_supplier: number; last_order?: string | null; stock_synced?: string | null; orders_synced: number; last_order_sync: string | null }[]; events: DemoEvent[] };
type Detail = { order: Order; items: { name_snapshot: string; unit_price_cents: number; qty: number; sku?: string; image?: string; product_id?: number }[]; events: DemoEvent[]; marketplace_warning?: string; marketplace_sync: { supplier_status: string; tracking_number: string | null; tracking_carrier: string | null; synced_at: string; reference: string } | null };
const panel = document.querySelector<HTMLDivElement>('#admin-panel');
const view = panel?.dataset.view || 'dashboard';
let state: State;
let detail: Detail | undefined;
const initialProductFilters = readProductFilters(location.search);
let productQuery = view === 'products' ? initialProductFilters.q : '';
let productCategory = view === 'products' ? initialProductFilters.category : '';
let productState = view === 'products' ? initialProductFilters.state : '';
let productStock = view === 'products' ? initialProductFilters.stock : '';
const productFilters = () => ({ q: productQuery, category: productCategory, state: productState, stock: productStock });
const initialOrderFilters = readOrderFilters(location.search);
let orderQuery = view === 'orders' ? initialOrderFilters.q : '';
let orderChannel = view === 'orders' ? initialOrderFilters.channel : '';
let orderStatus = view === 'orders' ? initialOrderFilters.status : '';
let orderPage = view === 'orders' ? initialOrderFilters.page : 1;
type OrderListResponse = { orders: Order[]; pagination: { page: number; limit: number; total: number; pages: number }; filters: { q: string; channel: string; status: string } };
let orderList: OrderListResponse | undefined;
let orderListLoading = false;
let orderListError = '';
let orderSearchTimer: ReturnType<typeof setTimeout>;
const orderRequests = new LatestOrderRequest();
const orderFilters = () => ({ q: orderQuery, channel: orderChannel, status: orderStatus, page: orderPage });
const orderBackPath = safeOrderReturnPath(new URLSearchParams(location.search).get('return'), location.origin);
const orderDetailPath = (id: number) => `/admin/pedidos/${encodeURIComponent(id)}${view === 'orders' ? `?return=${encodeURIComponent(orderListPath(orderFilters()))}` : ''}`;
const supplierStock = new SupplierStockSelection();
const supplierPrices = new SupplierPriceEditor(() => sessionStorage);
const supplierPriceMessages = new Map<string, { message: string; error: boolean }>();
let noticeTimeout: ReturnType<typeof setTimeout>;
let noticeListeners: AbortController | undefined;
let mutationPending = false;
let createdOrder: { id: number; number: string; warning?: string } | undefined;
const marketplaceDrafts = new Map<string, { slug: string; qty: number }>();
const orderAttempts = new Map<string, string>();
const attemptStorageKey = 'ecom-connect:marketplace-attempts';
try {
  const attempts: unknown = JSON.parse(sessionStorage.getItem(attemptStorageKey) || '[]');
  if (Array.isArray(attempts)) attempts.slice(-20).forEach(entry => {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && /^[0-9a-f-]{36}$/i.test(entry[1])) orderAttempts.set(entry[0], entry[1]);
  });
} catch { /* The demo remains usable when browser storage is unavailable. */ }
function persistOrderAttempts() {
  try { sessionStorage.setItem(attemptStorageKey, JSON.stringify([...orderAttempts].slice(-20))); } catch { /* Keep the current attempt in memory. */ }
}
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const money = (value: unknown) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number(value || 0) / 100);
const number = (value: unknown) => new Intl.NumberFormat('es-ES').format(Number(value || 0));
const date = (value?: string, time = true) => value ? new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`).toLocaleString('es-ES', { day: '2-digit', month: 'short', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) }) : 'Pendiente de sincronizar';
const channels: Record<string, { name: string; letter: string; color: string }> = { WEB: { name: 'FarmaHouse', letter: 'e', color: 'web' }, AMAZON: { name: 'Amazon', letter: 'a', color: 'amazon' }, MIRAVIA: { name: 'Miravia', letter: 'M', color: 'miravia' }, CARREFOUR: { name: 'Carrefour', letter: 'C', color: 'carrefour' }, EBAY: { name: 'eBay', letter: 'e', color: 'ebay' } };
const channelInfo = (key: string) => channels[key?.toUpperCase()] || { name: key || 'Web', letter: 'e', color: 'web' };
const readyForSupplier = (order: Order) => order.status === 'paid' && !order.supplier_order_id;
const statusNames: Record<string, string> = { pending: 'Pendiente', paid: 'Pagado', accepted: 'Aceptado', processing: 'En preparación', partial: 'Envío parcial', shipped: 'Enviado', delivered: 'Entregado', cancelled: 'Cancelado', error: 'Error', PENDING_SUPPLIER: 'Pendiente de envío', SUPPLIER_ACCEPTED: 'Aceptado', SUPPLIER_PROCESSING: 'En preparación', SUPPLIER_PARTIAL: 'Envío parcial', SUPPLIER_SHIPPED: 'Enviado', ERROR: 'Error de proveedor' };
const label = (status: string) => statusNames[status] || statusNames[status?.toLowerCase()] || status || 'Pendiente';
function presentEventText(value: string) {
  const supplier = /^Proveedor demo:\s*(pending|processing|partial|shipped|error)$/i.exec(value);
  const supplierStates: Record<string, string> = { pending: 'SUPPLIER_ACCEPTED', processing: 'SUPPLIER_PROCESSING', partial: 'SUPPLIER_PARTIAL', shipped: 'SUPPLIER_SHIPPED', error: 'ERROR' };
  const supplierStatus = supplier?.[1]?.toLowerCase();
  if (supplierStatus) return `Proveedor simulado: ${label(supplierStates[supplierStatus] || supplierStatus)}`;
  if (/^(PENDING_SUPPLIER|SUPPLIER_ACCEPTED|SUPPLIER_PROCESSING|SUPPLIER_PARTIAL|SUPPLIER_SHIPPED|ERROR)$/.test(value)) return `Proveedor simulado: ${label(value)}`;
  return value.replace(/\bLogic2B(?: Ecommerce)?\b/g, 'Ecom Connect').replace(/^(WEB|AMAZON|MIRAVIA|CARREFOUR|EBAY)(?=\s*→)/, channel => channelInfo(channel).name);
}
const badge = (status: string) => `<span class="status-badge ${/error|cancel/i.test(status) ? 'danger' : /pending|partial/i.test(status) ? 'warning' : /paid|accepted|shipped|delivered/i.test(status) ? 'success' : 'neutral'}"><span></span>${html(label(status))}</span>`;
const channelBadge = (key: string) => { const c = channelInfo(key); return `<span class="channel-label"><span class="channel-mini ${c.color}">${c.letter}</span>${html(c.name)}</span>`; };
const empty = (text: string, action = '') => `<div class="empty-state"><span aria-hidden="true">◇</span><p>${html(text)}</p>${action}</div>`;
const icon = (name: string) => { const paths: Record<string, string> = { arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>', box: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/>', orders: '<rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 3h6v4H9zM9 12h6M9 16h4"/>', nodes: '<rect x="8" y="3" width="8" height="5" rx="1"/><path d="M12 8v4M5 15v-3h14v3"/><rect x="2" y="15" width="6" height="5" rx="1"/><rect x="16" y="15" width="6" height="5" rx="1"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', check: '<path d="m5 12 4 4L19 6"/>', external: '<path d="M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c6 6 6 12 0 18-6-6-6-12 0-18Z"/>', feed: '<path d="M5 4c8 0 15 7 15 15M5 10c5 0 9 4 9 9"/><circle cx="6" cy="18" r="1.5"/>', settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>' }; return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`; };
const button = (text: string, action: string, secondary = false, attrs = '', symbol = 'refresh') => `<button class="button ${secondary ? 'button-secondary' : 'button-primary'}" data-action="${action}" ${attrs}>${icon(symbol)}<span>${text}</span></button>`;
const heading = (eyebrow: string, title: string, subtitle: string, actions = '') => `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-description">${subtitle}</p></div>${actions ? `<div class="heading-actions">${actions}</div>` : ''}</div>`;
const metric = (title: string, value: string, caption: string, symbol: string, variant = '') => `<div class="metric-card ${variant}"><div class="metric-top"><span>${title}</span><span class="metric-icon">${icon(symbol)}</span></div><strong class="metric-value">${value}</strong><p class="metric-caption">${caption}</p></div>`;
function orderRows(orders: Order[], compact = false) {
  return orders.map(order => `<tr><td><a class="order-number" href="${html(orderDetailPath(order.id))}">${html(order.order_number)}</a><small class="table-secondary">${date(order.created_at)}</small></td>${compact ? '' : `<td>${html(order.customer_name)}</td>`}<td>${channelBadge(order.channel)}</td><td>${badge(order.status)}</td>${compact ? '' : `<td>${badge(order.supplier_status)}</td>`}<td class="align-right table-amount">${money(order.total_cents)}</td><td class="table-chevron"><a href="${html(orderDetailPath(order.id))}" aria-label="Ver pedido ${html(order.order_number)}">↗</a></td></tr>`).join('');
}
function ordersTable(orders: Order[], compact = false) {
  return orders.length ? `<div class="table-scroll" role="region" aria-label="Pedidos" tabindex="0"><table><thead><tr><th scope="col">Pedido / fecha</th>${compact ? '' : '<th>Cliente</th>'}<th>Canal</th><th>Estado</th>${compact ? '' : '<th>Proveedor</th>'}<th class="align-right">Total</th><th></th></tr></thead><tbody>${orderRows(orders, compact)}</tbody></table></div>` : empty(state.orders.length ? 'No hay pedidos que coincidan con tu búsqueda.' : 'Tu próximo pedido empieza aquí.', state.orders.length ? '<button class="button button-secondary" data-action="reset-orders">Limpiar filtros</button>' : '<a class="button button-primary" href="/admin/marketplaces">Simular mi primer pedido</a>');
}
function eventsList(events: DemoEvent[], limit = 5) {
  return events.length ? `<div class="activity-list">${events.slice(0, limit).map((event, i) => `<div class="activity-item"><span class="activity-icon ${i === 0 ? 'recent' : ''}">${icon(event.to_status || (event.type || event.kind)?.includes('order') ? 'orders' : 'refresh')}</span><div><p>${html(presentEventText(event.title || event.message || event.note || event.description || (event.to_status ? `Pedido: ${label(event.to_status)}` : 'Sincronización completada')))}</p>${event.detail ? `<small class="activity-detail">${html(presentEventText(event.detail))}</small>` : ''}<time>${date(event.created_at)}</time></div></div>`).join('')}</div>` : empty('La actividad de tus integraciones aparecerá aquí.');
}
function dashboard() {
  const pending = state.order_summary.pending_supplier;
  const active = state.products.filter(p => p.active).length;
  const supplier = state.integrations.supplier;
  return `${heading('TU CENTRO DE OPERACIONES', 'Todo conectado. Todo bajo control.', 'Tu catálogo, tus pedidos y todos tus canales. En un mismo lugar.', `<a class="button button-secondary" href="/admin/documentacion/guia-demo">${icon('orders')}Guía de la demo</a>${button('Sincronizar ahora', 'sync')}`)}
    <div class="dashboard-demo-note"><span class="live-dot"></span><strong>Demo conectada · datos ficticios</strong><span>Datos de demostración · Sin conexiones ni pagos reales</span><a href="/admin/integraciones/proveedor">Ver integración ↗</a></div>
    <div class="metrics-grid">${metric('Productos en catálogo', number(state.products.length), `<span class="text-green">${number(active)} activos</span> en tu tienda`, 'box')}${metric('Pedidos centralizados', number(state.order_summary.total), 'Total de la demo · Todos los canales', 'orders')}${metric('Canales de venta', number(state.marketplaces.length + 1), '<span class="text-green">●</span> Tienda web + marketplaces', 'nodes')}${metric('Pendientes de proveedor', number(pending), pending ? 'Pagados y aún sin enviar al proveedor' : 'Sin pedidos pendientes de enviar', 'clock', pending ? 'metric-tinted' : '')}</div>
    <section class="admin-card ecosystem-card"><div class="card-heading"><div><span class="section-kicker">CONECTADO DE PRINCIPIO A FIN</span><h2>Un catálogo. Todos tus canales.</h2></div><span class="status-badge success"><span></span>Ecosistema demo</span></div><div class="ecosystem-flow"><a class="flow-node supplier-node" href="/admin/integraciones/proveedor"><span class="flow-icon">${icon('box')}</span><strong>Proveedor demo</strong><small>Catálogo · Stock · Pedidos</small><span class="flow-status">Sincronización simulada</span></a><div class="flow-connector"><small>Catálogo y stock</small><span>⟶</span><small>⟵ Pedidos</small></div><div class="flow-center"><a class="flow-node logic-node" href="/admin/productos"><span class="logic-wordmark">Ecom<br /><span>Connect</span></span><strong>Catálogo y pedidos unificados</strong><small>Motor Logic2B · Demo</small><span class="flow-status">${number(state.products.length)} productos centralizados</span></a><div class="web-branch"><span>↕</span><a href="/">${icon('globe')} FarmaHouse <span>↗</span></a></div></div><div class="flow-connector"><small>Productos</small><span>⟷</span><small>Pedidos</small></div><a class="flow-node lighthouse-node" href="/admin/integraciones/lighthouse"><span class="flow-icon lighthouse-mark">⌁</span><strong>Lighthouse demo</strong><small>Distribución omnicanal</small><span class="flow-status">Hub simulado</span></a><div class="flow-connector flow-connector-small"><span>⟷</span></div><div class="flow-marketplaces">${state.marketplaces.map(m => `<a href="/admin/marketplaces">${channelBadge(m.channel)}<span class="tiny-connected-dot"></span></a>`).join('')}</div></div><div class="ecosystem-footer"><span>${icon('refresh')} Última sincronización: <strong>${date(supplier.last_sync)}</strong></span><a href="/admin/integraciones/proveedor">Gestionar integraciones <span>↗</span></a></div></section>
    <div class="dashboard-columns"><section class="admin-card recent-orders"><div class="card-heading"><h2>Últimos pedidos <span class="count-chip">${Math.min(state.orders.length, 5)}</span></h2><a class="text-link" href="/admin/pedidos">Ver pedidos ↗</a></div>${ordersTable(state.orders.slice(0, 5), true)}</section><section class="admin-card activity-card"><div class="card-heading"><h2>Actividad reciente</h2><span class="live-indicator"><span></span>Actividad demo</span></div>${eventsList(state.events, 4)}<div class="activity-footnote">Cada acción queda registrada en tu demo.</div></section></div>
    <section class="bottom-callout"><span class="callout-icon">${icon('nodes')}</span><div><strong>Prueba la conexión de principio a fin.</strong><p>Simula un pedido de marketplace y sigue su recorrido hasta el proveedor.</p></div><a class="text-link" href="/admin/marketplaces">Crear un pedido demo ${icon('arrow')}</a></section>`;
}
function products() {
  const cats = [...new Set(state.products.map(p => p.category))];
  if (!cats.includes(productCategory)) productCategory = '';
  syncProductUrl();
  return `${heading('CATÁLOGO UNIFICADO', 'Tus productos, en todas partes.', 'Un único catálogo conectado con tu proveedor y tus canales de venta.', button('Sincronizar catálogo', 'sync'))}
    <div class="inline-stats"><span><strong>${state.products.length}</strong> productos</span><span><strong>${state.products.filter(p => p.active).length}</strong> activos</span><span><strong>${state.products.filter(p => p.stock >= 1 && p.stock <= 5).length}</strong> con stock bajo (1–5)</span><span><strong>${state.products.filter(p => p.stock <= 0).length}</strong> sin stock</span><span>Última sincronización <strong>${date(state.integrations.supplier.last_sync)}</strong></span></div>
    <section class="admin-card"><div class="table-toolbar product-filter-toolbar"><label class="search-field">${icon('search')}<input id="product-search" type="search" maxlength="120" value="${html(productQuery)}" placeholder="Buscar producto, SKU, EAN o marca" aria-label="Buscar productos" aria-controls="product-results" /></label>
    <select id="product-category" aria-label="Filtrar categoría" aria-controls="product-results"><option value="">Todas las categorías</option>${cats.map(c => `<option ${productCategory === c ? 'selected' : ''} value="${html(c)}">${html(categoryName(c))}</option>`).join('')}</select>
    <select id="product-status" aria-label="Filtrar estado del producto" aria-controls="product-results"><option value="">Todos los estados</option><option value="activo" ${productState === 'activo' ? 'selected' : ''}>Activos</option><option value="inactivo" ${productState === 'inactivo' ? 'selected' : ''}>Inactivos</option></select>
    <select id="product-stock" aria-label="Filtrar stock en tienda" aria-controls="product-results"><option value="">Cualquier stock</option><option value="con-stock" ${productStock === 'con-stock' ? 'selected' : ''}>Con stock</option><option value="bajo" ${productStock === 'bajo' ? 'selected' : ''}>Stock bajo (1–5)</option><option value="sin-stock" ${productStock === 'sin-stock' ? 'selected' : ''}>Sin stock</option></select></div>
    <div class="filter-summary"><span id="product-result-count" role="status" aria-live="polite" aria-atomic="true"></span><button class="filter-reset" data-action="reset-products" hidden>Limpiar filtros</button></div><div class="table-help">El stock indica unidades en tienda; el estado determina si el producto está visible. Abre un producto activo para consultar su ficha. Desplaza la tabla para ver todas las columnas.</div><div id="product-results"></div></section><p class="page-footnote">El stock y los precios proceden del proveedor simulado. Sincroniza para actualizar el catálogo y el feed de Lighthouse.</p>`;
}
function syncProductUrl(mode: 'push' | 'replace' = 'replace') {
  const path = productListPath(productFilters());
  if (`${location.pathname}${location.search}` !== path) history[mode === 'push' ? 'pushState' : 'replaceState'](history.state, '', path);
}
function updateProductControls() {
  const values = { 'product-search': productQuery, 'product-category': productCategory, 'product-status': productState, 'product-stock': productStock };
  for (const [id, value] of Object.entries(values)) {
    const control = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (control) control.value = value;
  }
}
function renderProducts() {
  const filters = productFilters();
  const filtered = state.products.filter(product => matchesProductFilters(product, filters));
  const target = document.querySelector('#product-results');
  if (!target) return;
  document.querySelector('#product-result-count')!.textContent = `${filtered.length} de ${state.products.length} productos`;
  const reset = document.querySelector<HTMLButtonElement>('[data-action="reset-products"]');
  if (reset) reset.hidden = !Object.values(filters).some(value => value.trim());
  target.innerHTML = filtered.length ? `<div class="table-scroll" role="region" aria-label="Catálogo de productos" tabindex="0"><table class="products-table"><thead><tr><th scope="col">Producto</th><th scope="col">SKU / EAN</th><th scope="col">Marca</th><th scope="col">Precio / PVP</th><th scope="col">Stock</th><th scope="col">Última sync</th><th scope="col">Estado</th></tr></thead><tbody>${filtered.map(p => {
    const product = `<img src="${html(p.image)}" alt="" loading="lazy" /><span><strong>${html(p.name)}</strong><small>${html(categoryName(p.category))}</small>${!p.active ? '<small class="product-visibility-note">No visible en tienda</small>' : ''}</span>`;
    return `<tr><td>${p.active ? `<a class="product-cell" href="/tienda/${encodeURIComponent(p.slug)}">${product}</a>` : `<div class="product-cell">${product}</div>`}</td><td><span class="mono">${html(p.sku)}</span><small class="table-secondary mono">${html(p.ean)}</small><small class="table-secondary">Prov. ${html(p.supplier_sku)}</small></td><td>${html(p.brand)}</td><td><strong>${money(p.price_cents)}</strong><small class="table-secondary">${p.compare_at_price_cents == null ? 'Sin PVP de referencia' : `PVP ${money(p.compare_at_price_cents)}`} · IVA ${html(p.vat)}%</small></td><td><span class="stock-number ${p.stock <= 5 ? 'stock-low' : ''}"><span></span>${number(p.stock)} uds.</span></td><td class="small-date">${date(p.last_synced_at)}</td><td><span class="status-badge ${p.active ? 'success' : 'neutral'}"><span></span>${p.active ? 'Activo' : 'Inactivo'}</span></td></tr>`;
  }).join('')}</tbody></table></div>` : empty('No hay productos que coincidan con estos filtros. Prueba otra combinación o limpia la selección.');
}

function orders() {
  const volume = state.order_summary.total_cents;
  return `${heading('VENTAS CENTRALIZADAS', 'Cada pedido. Un mismo lugar.', 'Gestiona los pedidos de tu tienda y tus marketplaces, de principio a fin.', `<a class="button button-primary" href="/admin/marketplaces">${icon('orders')}Simular pedido</a>`)}
    <div class="metrics-grid three-columns">${metric('Pedidos centralizados', number(state.order_summary.total), 'Total de la demo · Todos los canales', 'orders')}${metric('Importe total simulado', money(volume), 'IVA incluido · Sin cobros reales', 'nodes')}${metric('Por enviar al proveedor', number(state.order_summary.pending_supplier), `Total de la demo · Envío ${state.settings.dispatch_mode === 'immediate' ? 'inmediato' : 'agrupado'}`, 'clock')}</div>
    <section class="admin-card"><div class="card-heading"><h2>Historial de pedidos</h2><span class="section-kicker">TODOS LOS PEDIDOS DE LA DEMO</span></div><p class="table-help">25 por página · Más recientes primero. Busca por pedido, cliente demo, referencia del proveedor o seguimiento.</p>
    <div class="table-toolbar"><label class="search-field">${icon('search')}<input id="order-search" type="search" maxlength="120" value="${html(orderQuery)}" placeholder="Buscar pedido, cliente o seguimiento" aria-label="Buscar pedidos" aria-controls="order-results" /></label><select id="order-channel" aria-label="Filtrar canal" aria-controls="order-results"><option value="">Todos los canales</option>${Object.entries(channels).map(([key, c]) => `<option value="${key}" ${key === orderChannel ? 'selected' : ''}>${c.name}</option>`).join('')}</select><select id="order-status" aria-label="Filtrar estado" aria-controls="order-results"><option value="">Todos los estados</option>${orderStatuses.map(status => `<option value="${status}" ${orderStatus === status ? 'selected' : ''}>${html(label(status))}</option>`).join('')}</select></div>
    <div class="filter-summary"><span id="order-result-count" role="status" aria-live="polite" aria-atomic="true">Cargando pedidos…</span><button class="filter-reset" data-action="reset-orders" hidden>Limpiar filtros</button></div><div id="order-results" role="region" aria-label="Resultados del historial" tabindex="-1" aria-busy="true"></div>
    <nav class="order-pagination" aria-label="Páginas del historial"><button class="button button-secondary" data-action="previous-orders" aria-disabled="true" aria-controls="order-results">← Anterior</button><span id="order-page-label">Cargando…</span><button class="button button-secondary" data-action="next-orders" aria-disabled="true" aria-controls="order-results">Siguiente →</button></nav></section>`;
}
function updateOrderUrl(mode: 'push' | 'replace' = 'replace') {
  const path = orderListPath(orderFilters());
  if (`${location.pathname}${location.search}` !== path) history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', path);
}
function renderOrders() {
  const target = document.querySelector<HTMLElement>('#order-results');
  if (!target) return;
  const hadResultFocus = target.contains(document.activeElement);
  const count = document.querySelector<HTMLElement>('#order-result-count')!;
  const pageLabel = document.querySelector<HTMLElement>('#order-page-label')!;
  const reset = document.querySelector<HTMLButtonElement>('.filter-reset')!;
  reset.hidden = !orderQuery && !orderChannel && !orderStatus;
  target.setAttribute('aria-busy', String(orderListLoading));
  const pagination = orderList?.pagination;
  document.querySelector('[data-action="previous-orders"]')!.setAttribute('aria-disabled', String(orderListLoading || Boolean(orderListError) || !pagination || pagination.page <= 1));
  document.querySelector('[data-action="next-orders"]')!.setAttribute('aria-disabled', String(orderListLoading || Boolean(orderListError) || !pagination || pagination.page >= pagination.pages));
  if (orderListLoading) {
    count.textContent = 'Actualizando historial…';
    pageLabel.textContent = 'Cargando…';
    target.innerHTML = '<div class="orders-loading"><span class="loading-ring" aria-hidden="true"></span><p>Buscando en todo el historial…</p></div>';
  } else if (orderListError) {
    count.textContent = 'No se han podido cargar los pedidos.';
    pageLabel.textContent = 'Consulta pendiente';
    target.innerHTML = `<div class="order-list-error" role="alert"><h3>No pudimos actualizar el historial</h3><p>${html(orderListError)}</p><button class="button button-secondary" data-action="retry-orders">Volver a intentar</button></div>`;
  } else if (orderList && pagination) {
    const start = pagination.total ? (pagination.page - 1) * pagination.limit + 1 : 0;
    const end = Math.min(pagination.page * pagination.limit, pagination.total);
    count.textContent = `${number(start)}–${number(end)} de ${number(pagination.total)} pedidos`;
    pageLabel.textContent = `Página ${number(pagination.page)} de ${number(pagination.pages)}`;
    target.innerHTML = orderList.orders.length ? ordersTable(orderList.orders) : empty(orderQuery || orderChannel || orderStatus ? 'No hay pedidos que coincidan con estos filtros.' : 'Todavía no hay pedidos en la demo.', orderQuery || orderChannel || orderStatus ? '<button class="button button-secondary" data-action="reset-orders">Limpiar filtros</button>' : '<a class="button button-primary" href="/admin/marketplaces">Simular mi primer pedido</a>');
  }
  if (hadResultFocus) target.focus({ preventScroll: true });
}
async function loadOrders() {
  clearTimeout(orderSearchTimer);
  const currentRequest = orderRequests.start();
  orderListLoading = true;
  orderListError = '';
  renderOrders();
  const params = new URLSearchParams({ q: orderQuery.trim(), channel: orderChannel, status: orderStatus, page: String(orderPage), limit: '25' });
  try {
    const response = await request<OrderListResponse>(`/api/demo/orders?${params}`, { signal: currentRequest.signal });
    if (!currentRequest.isCurrent()) return;
    orderList = response;
    orderPage = response.pagination.page;
    orderQuery = response.filters.q;
    orderChannel = response.filters.channel;
    orderStatus = response.filters.status;
    updateOrderUrl();
  } catch (error) {
    if (!currentRequest.isCurrent()) return;
    orderListError = error instanceof Error ? error.message : 'Comprueba tu conexión y vuelve a intentarlo.';
  } finally {
    if (currentRequest.isCurrent()) {
      orderListLoading = false;
      renderOrders();
    }
  }
}
function scheduleOrders(delay = 0, historyMode: 'push' | 'replace' = 'replace') {
  clearTimeout(orderSearchTimer);
  orderRequests.cancel();
  updateOrderUrl(historyMode);
  orderListLoading = true;
  orderListError = '';
  renderOrders();
  if (delay) orderSearchTimer = setTimeout(() => { void loadOrders(); }, delay);
  else void loadOrders();
}

function orderJourney(data: Detail) {
  const { steps, current, complete, requiresAttention, cancelled, next, href, actionLabel } = createOrderJourney(data, { dispatchMode: state.settings.dispatch_mode, channelName: channelInfo(data.order.channel).name });
  return `<section class="admin-card order-journey" aria-labelledby="journey-title"><div class="card-heading"><div><span class="section-kicker">DE LA VENTA AL SEGUIMIENTO</span><h2 id="journey-title">Recorrido del pedido</h2></div><span class="status-badge ${complete ? 'success' : requiresAttention ? 'danger' : 'neutral'}">${cancelled ? 'Recorrido detenido' : complete ? 'Recorrido completo' : requiresAttention ? 'Requiere atención' : 'En curso'}</span></div><ol class="journey-steps" aria-label="Etapas del pedido">${steps.map((step, index) => `<li class="journey-step${step.complete ? ' is-complete' : ''}${index === current ? ' is-current' : ''}" ${index === current ? 'aria-current="step"' : ''}><span class="journey-step-marker" aria-hidden="true">${step.complete ? icon('check') : index + 1}</span><div><strong>${step.title}</strong><span class="journey-step-state">${step.complete ? 'Completada' : index === current ? 'Etapa actual' : 'Pendiente'}</span><p>${html(step.detail)}</p></div></li>`).join('')}</ol><div class="journey-next"><div><strong>${complete ? 'Todo registrado' : 'Siguiente paso'}</strong><p>${html(next)}</p></div><a class="text-link" href="${href}">${actionLabel} ${icon('arrow')}</a></div><p class="journey-demo-note">Recorrido de demostración: pago, proveedor, transporte y comunicaciones de canal simulados. No se realizan operaciones reales.</p></section>`;
}
function marketplaceSyncCard(data: Detail) {
  if (data.order.channel === 'WEB') return '';
  const sync = data.marketplace_sync;
  const current = hasCurrentMarketplaceAcknowledgement(data);
  return `<section id="marketplace-return" class="admin-card spaced-card" tabindex="-1"><div class="card-heading"><h2>Retorno al marketplace</h2>${icon('nodes')}</div><div class="card-body"><span class="status-badge ${current ? 'success' : 'warning'}">${current ? 'Acuse demo actualizado' : 'Pendiente de conciliar'}</span><dl class="detail-facts"><div><dt>Canal</dt><dd>${html(channelInfo(data.order.channel).name)}</dd></div><div><dt>Estado comunicado</dt><dd>${sync ? html(label(sync.supplier_status)) : 'Sin notificar'}</dd></div><div><dt>Seguimiento comunicado</dt><dd>${html(sync?.tracking_number || 'Aún no disponible')}</dd></div><div><dt>Último acuse local</dt><dd>${date(sync?.synced_at)}</dd></div></dl>${!current ? button('Conciliar sincronización', 'sync', true, '', 'refresh') : ''}<p class="form-help">Proveedor → Ecom Connect → Lighthouse → ${html(channelInfo(data.order.channel).name)}. Confirmación simulada guardada en Ecom Connect.</p><a class="text-link" href="/admin/documentacion/lighthouse">Contrato de la integración ↗</a></div></section>`;
}
function orderDetail() {
  if (!detail) return empty('No se ha encontrado este pedido.');
  const { order, items, events } = detail;
  const pending = readyForSupplier(order);
  const paymentConfirmed = ['paid', 'shipped', 'delivered'].includes(order.status);
  const shipped = order.supplier_status === 'SUPPLIER_SHIPPED';
  return `<a class="back-link" href="${html(orderBackPath)}">← Volver a pedidos</a>${heading('DETALLE DEL PEDIDO', html(order.order_number), `${html(order.customer_name)} <span class="footer-dot">·</span> ${date(order.created_at)}`, badge(order.status))}${orderJourney(detail)}<div class="detail-layout"><div><section class="admin-card"><div class="card-heading"><h2>Productos <span class="count-chip">${items.length}</span></h2>${channelBadge(order.channel)}</div><div class="table-scroll"><table><thead><tr><th>Producto</th><th class="align-right">Precio</th><th class="align-right">Cantidad</th><th class="align-right">Total</th></tr></thead><tbody>${items.map(item => { const p = state.products.find(p => p.id === item.product_id); return `<tr><td><div class="product-cell">${p?.image ? `<img src="${html(p.image)}" alt="" />` : ''}<span><strong>${html(item.name_snapshot)}</strong><small>${html(item.sku || p?.sku || '')}</small></span></div></td><td class="align-right">${money(item.unit_price_cents)}</td><td class="align-right">${item.qty}</td><td class="align-right table-amount">${money(item.unit_price_cents * item.qty)}</td></tr>`; }).join('')}</tbody></table></div><dl class="order-breakdown"><div><dt>Subtotal de productos</dt><dd>${money(order.subtotal_cents ?? items.reduce((sum, item) => sum + item.unit_price_cents * item.qty, 0))}</dd></div><div><dt>Envío simulado</dt><dd>${Number(order.shipping_cents) === 0 ? 'Gratis' : money(order.shipping_cents)}</dd></div></dl><div class="order-total"><span>Total del pedido <small>IVA incluido</small></span><strong>${money(order.total_cents)}</strong></div></section><section id="order-history" class="admin-card spaced-card" tabindex="-1"><div class="card-heading"><h2>Historial del pedido</h2><span class="section-kicker">TRAZABILIDAD</span></div>${eventsList(events, 30)}</section></div><aside><section id="supplier-management" class="admin-card" tabindex="-1"><div class="card-heading"><h2>Gestión del proveedor</h2>${icon('box')}</div><div class="card-body"><div class="supplier-order-status">${badge(order.supplier_status)}</div><dl class="detail-facts"><div><dt>Referencia del proveedor</dt><dd>${html(order.supplier_order_id || 'Sin enviar')}</dd></div><div><dt>Última actualización</dt><dd>${date(order.last_supplier_sync)}</dd></div><div><dt>Seguimiento</dt><dd>${html(order.tracking_number || 'Aún no disponible')}</dd></div></dl>${!paymentConfirmed ? '<div class="info-box">Pago simulado no confirmado. El pedido no se puede enviar ni actualizar en el proveedor.</div>' : pending ? button(order.supplier_status === 'ERROR' ? 'Reintentar envío' : 'Enviar al proveedor', 'dispatch', false, `data-order-id="${order.id}"`, 'arrow') : shipped ? '<div class="info-box success-info">✓ Pedido enviado. El número de seguimiento ya está disponible.</div>' : `<label class="field-label" for="next-status">Simular estado del proveedor</label><select id="next-status"><option value="processing">En preparación</option><option value="partial">Envío parcial</option><option value="shipped">Enviado + tracking</option><option value="error">Error de proveedor</option></select>${button('Actualizar estado', 'advance', false, `data-order-id="${order.id}"`)}`}<p class="form-help">Las acciones simulan la respuesta del proveedor y quedan registradas en el historial.</p></div></section>${marketplaceSyncCard(detail)}<section class="admin-card spaced-card"><div class="card-body"><span class="section-kicker">CLIENTE</span><h3>${html(order.customer_name)}</h3><p class="muted">${html(order.customer_email || 'Cliente de demostración')}</p><p class="muted">Canal de origen: ${html(channelInfo(order.channel).name)}</p></div></section></aside></div>`;
}
const productOptions = (availableOnly = false, selected = '') => state.products.filter(p => p.active && (!availableOnly || p.stock > 0)).map(p => `<option value="${html(p.slug)}" ${selected === p.slug ? 'selected' : ''}>${html(p.name)} — ${number(p.stock)} uds.</option>`).join('');
function supplier() {
  const s = state.integrations.supplier;
  if (!state.products.some(product => product.supplier_sku === supplierStock.code)) {
    const pendingCode = supplierPrices.pendingCodes().find(code => state.products.some(product => product.supplier_sku === code));
    supplierStock.select(pendingCode || state.products[0]?.supplier_sku || '');
  }
  const selected = state.products.find(product => product.supplier_sku === supplierStock.code);
  const options = state.products.map(product => `<option value="${html(product.slug)}" ${selected?.slug === product.slug ? 'selected' : ''}>${html(product.name)}${product.active ? '' : ' · Inactivo en tienda'}</option>`).join('');
  return `${heading('INTEGRACIONES / PROVEEDOR', 'El origen de tu catálogo.', 'Productos, precios y disponibilidad sincronizados desde un único proveedor.', button('Sincronizar ahora', 'sync'))}
    <div class="integration-banner"><span class="integration-avatar">${icon('box')}</span><div><h2>Proveedor de demostración</h2><p>Catálogo → Ecom Connect <span>·</span> Ecom Connect → Proveedor demo</p></div><span class="status-badge success"><span></span>Conectado · Demo</span></div>
    <div class="metrics-grid">${metric('Última sincronización', s.last_sync ? date(s.last_sync) : 'Pendiente', 'Catálogo y disponibilidad', 'refresh', 'metric-date')}${metric('Productos procesados', number(s.processed), 'En la última sincronización', 'box')}${metric('Productos actualizados', number(s.updated), 'Cambios aplicados al catálogo', 'check')}${metric('Errores', number(s.errors), s.errors ? 'Revisa la actividad de sincronización' : 'Sin incidencias en la última ejecución', 'clock')}</div>
    <div class="two-panel-grid supplier-panels"><section class="admin-card"><div class="card-heading"><div><span class="section-kicker">PRUEBA EL FLUJO</span><h2>Simula cambios en el proveedor</h2></div>${icon('refresh')}</div>
    <form id="stock-form" class="card-body"><p class="muted">Consulta cómo se protege el stock vendido. Cambia la disponibilidad del proveedor demo y sincroniza para trasladarla a la tienda y Lighthouse.</p>
    <label class="field-label" for="stock-product">Producto</label><select id="stock-product" name="slug" required ${selected ? '' : 'disabled'}>${options || '<option value="">No hay productos importados</option>'}</select>
    <section class="supplier-stock" aria-labelledby="supplier-stock-title"><h3 id="supplier-stock-title">Disponibilidad de este producto</h3><div id="supplier-stock-result" tabindex="-1" aria-live="polite" aria-atomic="true"></div></section>
    <label class="field-label" for="stock-value">Nuevo stock en el proveedor</label><input id="stock-value" name="stock" type="number" min="0" max="10000" step="1" value="${html(supplierStock.draft)}" aria-describedby="stock-change-help" required ${selected ? '' : 'disabled'} />
    <p id="stock-change-help" class="form-help">Este cambio se guarda en el proveedor simulado. Después, pulsa «Sincronizar ahora» para aplicarlo al catálogo.</p><button class="button button-primary" type="submit" ${selected ? '' : 'disabled'}>${icon('box')}Simular cambio de stock</button></form>${supplierPriceForm()}</section>
    <section class="admin-card"><div class="card-heading"><h2>Actividad de sincronización</h2><span class="live-indicator"><span></span>Actividad demo</span></div>${eventsList(state.events, 7)}</section></div>`;
}
function supplierPriceForm() {
  return `<form id="supplier-price-form" class="card-body supplier-price-editor" aria-labelledby="supplier-price-title"><h3 id="supplier-price-title">Precio de venta por unidad</h3><div id="supplier-price-values" aria-live="polite"></div>
    <div class="supplier-price-inputs"><div><label class="field-label" for="supplier-price-value">Precio de venta (€)</label><input id="supplier-price-value" name="price" type="text" inputmode="decimal" maxlength="15" autocomplete="off" aria-describedby="supplier-price-help" required disabled /></div><div><label class="field-label" for="supplier-pvp-value">PVP de referencia (€) · Opcional</label><input id="supplier-pvp-value" name="pvp" type="text" inputmode="decimal" maxlength="15" autocomplete="off" aria-describedby="supplier-price-help" disabled /></div></div>
    <p id="supplier-price-help" class="form-help">Usa hasta dos decimales, por ejemplo 8,90. El PVP debe superar el precio de venta; déjalo vacío si no hay precio de referencia.</p>
    <div id="supplier-price-result" class="supplier-price-notice" role="status" aria-live="polite" hidden></div>
    <button class="button button-primary" type="submit" disabled>${icon('refresh')}<span>Simular cambio de precio</span></button><p class="form-help">Guarda el cambio en el proveedor demo. Pulsa «Sincronizar ahora» para aplicarlo al catálogo, la tienda y el feed.</p></form>`;
}
function renderSupplierPrice() {
  const form = document.querySelector<HTMLFormElement>('#supplier-price-form');
  if (!form) return;
  const snapshot = supplierStock.snapshot;
  const current = snapshot && typeof snapshot.supplier_price_cents === 'number'
    ? { price_cents: snapshot.supplier_price_cents, pvp_cents: snapshot.supplier_pvp_cents } : undefined;
  const pending = supplierPrices.pending(supplierStock.code);
  const draft = supplierPrices.draft(supplierStock.code, current);
  const values = document.getElementById('supplier-price-values')!;
  values.setAttribute('aria-busy', String(supplierStock.loading));
  if (snapshot && current) {
    const imported = snapshot.store_product_id !== null && snapshot.store_price_cents !== null;
    const matches = imported && snapshot.store_price_cents === current.price_cents && snapshot.store_pvp_cents === current.pvp_cents;
    values.innerHTML = `<p class="stock-product-caption">${html(snapshot.name)}</p><div class="supplier-price-comparison"><dl><dt>Precio en el proveedor</dt><dd>${money(current.price_cents)}</dd><dd class="price-reference">${current.pvp_cents === null ? 'Sin PVP de referencia' : `PVP: ${money(current.pvp_cents)}`}</dd></dl><dl><dt>Precio actual en tienda</dt><dd>${imported ? money(snapshot.store_price_cents) : 'Sin importar'}</dd><dd class="price-reference">${!imported ? 'Pendiente de importación' : snapshot.store_pvp_cents === null ? 'Sin PVP de referencia' : `PVP: ${money(snapshot.store_pvp_cents)}`}</dd></dl></div><span class="status-badge ${matches ? 'success' : 'warning'}"><span></span>${!imported ? 'Sin importar' : matches ? 'Precios coinciden' : 'Pendiente de sincronizar'}</span>`;
  } else values.innerHTML = `<p class="stock-explanation">${supplierStock.loading ? 'Consultando los precios de este producto…' : 'Consulta los datos del producto para comparar y editar sus precios.'}</p>`;
  const input = document.querySelector<HTMLInputElement>('#supplier-price-value')!;
  const pvp = document.querySelector<HTMLInputElement>('#supplier-pvp-value')!;
  if (input.value !== draft.price) input.value = draft.price;
  if (pvp.value !== draft.pvp) pvp.value = draft.pvp;
  input.disabled = pvp.disabled = mutationPending || Boolean(pending) || !current;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  submit.disabled = mutationPending || (!pending && !current);
  if (!submit.classList.contains('is-busy')) submit.querySelector('span')!.textContent = pending ? 'Reintentar cambio de precio' : 'Simular cambio de precio';
  const notice = document.getElementById('supplier-price-result')!;
  const message = supplierPriceMessages.get(supplierStock.code);
  notice.textContent = pending ? 'Este cambio está pendiente de confirmación. Conservamos los importes mostrados: reintenta el mismo cambio antes de editarlos.' : message?.message || '';
  notice.hidden = !notice.textContent;
  notice.classList.toggle('is-error', Boolean(message?.error) && !pending);
  notice.setAttribute('role', message?.error && !pending ? 'alert' : 'status');
}
function renderSupplierStock() {
  renderSupplierPrice();
  const target = document.querySelector<HTMLElement>('#supplier-stock-result');
  if (!target) return;
  const focusInside = target.contains(document.activeElement);
  if (focusInside) target.focus({ preventScroll: true });
  target.setAttribute('aria-busy', String(supplierStock.loading));
  const input = document.querySelector<HTMLInputElement>('#stock-value');
  if (input && input.value !== supplierStock.draft) input.value = supplierStock.draft;
  if (!supplierStock.code) {
    target.innerHTML = '<p class="stock-explanation">Sincroniza el catálogo para importar los productos del proveedor.</p>';
    return;
  }
  if (supplierStock.loading) {
    target.innerHTML = '<p class="stock-loading"><span class="loading-ring" aria-hidden="true"></span>Consultando proveedor, reservas y tienda…</p>';
    return;
  }
  if (supplierStock.error) {
    target.innerHTML = `<div class="stock-error"><strong>No pudimos consultar este producto</strong><p>${html(supplierStock.error)}</p>${button('Reintentar consulta', 'retry-stock', true, 'type="button"')}</div>`;
    return;
  }
  const snapshot = supplierStock.snapshot;
  if (!snapshot) return;
  const imported = snapshot.store_product_id !== null && snapshot.store_stock !== null;
  const matches = imported && snapshot.stock_difference === 0;
  const status = !imported ? 'Sin importar' : matches ? 'Stock coincide' : 'Pendiente de sincronizar';
  const reservationNote = snapshot.reserved_orders_count
    ? `${number(snapshot.reserved_orders_count)} ${snapshot.reserved_orders_count === 1 ? 'pedido' : 'pedidos'} con unidades reservadas`
    : 'Sin pedidos con reserva pendiente';
  const storeNote = !imported ? 'Sincroniza para incorporar este producto al catálogo.' : matches
    ? 'El stock de la tienda coincide con el disponible calculado. Este estado compara las unidades, no el resto del catálogo.'
    : `La tienda muestra ${number(Math.abs(snapshot.stock_difference || 0))} ${snapshot.stock_difference! > 0 ? 'unidades más' : 'unidades menos'} que el disponible calculado. Sincroniza para conciliarlo.`;
  target.innerHTML = `<div class="stock-product-caption">${html(snapshot.name)}</div>
    <div class="stock-equation"><dl class="stock-term"><dt>Stock del proveedor</dt><dd>${number(snapshot.supplier_stock)}<small>unidades</small></dd></dl><span class="stock-operator" aria-hidden="true">−</span><dl class="stock-term"><dt>Reservas de pedidos</dt><dd>${number(snapshot.reserved_units)}<small>unidades</small></dd></dl><span class="stock-operator" aria-hidden="true">=</span><dl class="stock-term stock-term-result"><dt>Disponible al sincronizar</dt><dd>${number(snapshot.theoretical_available)}<small>unidades</small></dd></dl></div>
    <p class="stock-reservations">${reservationNote}</p>${snapshot.reserved_units > snapshot.supplier_stock ? '<p class="stock-explanation stock-warning">Las reservas superan el stock actual del proveedor. El disponible se limita a 0 unidades.</p>' : ''}
    <div class="stock-store"><div><span>Stock actual en tienda</span><strong>${imported ? `${number(snapshot.store_stock)} <small>uds.</small>` : 'Sin importar'}</strong></div><span class="status-badge ${matches ? 'success' : 'warning'}"><span></span>${status}</span></div>
    <p class="stock-explanation">${storeNote}</p>
    ${!snapshot.supplier_active || snapshot.store_active === false ? `<p class="stock-explanation stock-warning">${!snapshot.supplier_active ? 'Producto inactivo en el proveedor. ' : ''}${snapshot.store_active === false ? 'Producto inactivo en la tienda; no está disponible para comprar.' : ''}</p>` : ''}
    <div class="stock-benefit"><strong>Reservas que se respetan al sincronizar</strong><p>Las reservas son unidades de pedidos que el proveedor aún no ha descontado. Al sincronizar, se restan antes de publicar el disponible. Cuando el proveedor acepta esos pedidos, se evita descontarlas dos veces.</p></div>
    <dl class="stock-dates"><div><dt>Actualización en proveedor</dt><dd>${date(snapshot.supplier_updated_at)}</dd></div><div><dt>Última importación a tienda</dt><dd>${snapshot.store_synced_at ? date(snapshot.store_synced_at) : 'Sin importar'}</dd></div></dl>
    <div class="stock-links">${imported && snapshot.store_active ? `<a class="text-link" href="/tienda/${encodeURIComponent(snapshot.slug)}">Ver producto en FarmaHouse ${icon('external')}</a>` : ''}<a class="text-link" href="/admin/pedidos">Ver historial de pedidos ${icon('arrow')}</a></div>`;
}
async function loadSupplierStock() {
  if (!supplierStock.code) { renderSupplierStock(); return; }
  const loading = supplierStock.load(async (code, signal) => {
    const result = await request<{ snapshot: SupplierStockSnapshot }>(`/api/demo/stock?code=${encodeURIComponent(code)}`, { signal });
    return result.snapshot;
  });
  renderSupplierStock();
  if (await loading) renderSupplierStock();
}

function lighthouse() {
  const light = state.integrations.lighthouse;
  const xmlUrl = light.feed_url || `${location.origin}/feeds/products.xml`;
  const jsonUrl = light.json_url || `${location.origin}/api/feeds/products.json`;
  return `${heading('INTEGRACIONES / LIGHTHOUSE', 'Tu catálogo, listo para despegar.', 'Publica un feed unificado y distribuye tus productos a todos tus marketplaces.', button('Regenerar feed', 'regenerate-feed'))}<div class="integration-banner"><span class="integration-avatar lighthouse-banner-icon">⌁</span><div><h2>Lighthouse</h2><p>La conexión simulada entre Ecom Connect y tus canales de venta</p></div><span class="status-badge success"><span></span>Integración simulada</span></div><div class="metrics-grid three-columns">${metric('Productos publicados', number(light.published), 'Productos activos incluidos en el feed', 'box')}${metric('Última generación', date(light.last_sync), 'Feed XML y JSON disponible', 'refresh', 'metric-date')}${metric('Marketplaces conectados', number(state.marketplaces.length), 'Distribución y pedidos simulados', 'nodes')}</div><section class="admin-card"><div class="card-heading"><h2>Tu feed de productos</h2><span class="status-badge success"><span></span>Disponible</span></div><div class="card-body"><p class="muted">El XML incluye identificador, EAN, marca, precio, disponibilidad, imagen y URL. El JSON añade SKU y stock numérico. El contenido refleja el catálogo actual.</p><div class="feed-row"><span class="file-type">XML</span><div><label for="xml-url">Feed de catálogo XML</label><input id="xml-url" class="feed-url" value="${html(xmlUrl)}" readonly /></div><div class="feed-actions"><button class="button button-secondary" data-action="copy-feed" data-input="xml-url">Copiar URL</button><a class="button button-secondary" href="${html(xmlUrl)}" target="_blank" rel="noopener" aria-label="Abrir feed XML en una nueva pestaña">Abrir ${icon('external')}</a></div></div><div class="feed-row"><span class="file-type">JSON</span><div><label for="json-url">Feed de catálogo JSON</label><input id="json-url" class="feed-url" value="${html(jsonUrl)}" readonly /></div><div class="feed-actions"><button class="button button-secondary" data-action="copy-feed" data-input="json-url">Copiar URL</button><a class="button button-secondary" href="${html(jsonUrl)}" target="_blank" rel="noopener" aria-label="Abrir feed JSON en una nueva pestaña">Abrir ${icon('external')}</a></div></div><div class="info-box">Demo funcional: los feeds se generan con el catálogo de esta aplicación. No se envían a una cuenta real de Lighthouse.</div></div></section><section class="admin-card spaced-card"><div class="card-heading"><h2>Estado y seguimiento de pedidos</h2><a class="text-link" href="/admin/documentacion/lighthouse">Documentación técnica ↗</a></div><div class="card-body"><p class="muted"><strong>${number(light.orders_synced)}</strong> pedidos con acuse de estado en el hub simulado. El seguimiento del proveedor simulado se registra para el canal de origen y puede consultarse en cada pedido.</p>${button("Conciliar sincronización", "sync", true)}<p class="form-help">La conciliación actualiza catálogo y feed y repara acuses de pedidos pendientes, sin repetir la compra al proveedor.</p></div></section><section class="admin-card spaced-card"><div class="card-heading"><h2>Canales de destino</h2><a class="text-link" href="/admin/marketplaces">Gestionar marketplaces ↗</a></div><div class="channel-destination-grid">${state.marketplaces.map(m => `<div>${channelBadge(m.channel)}<strong>${number(m.published)} <small>productos</small></strong><span class="status-badge success"><span></span>Demo conectada</span></div>`).join('')}</div></section>`;
}
function marketplaces() {
  const available = state.products.filter(p => p.active && p.stock > 0);
  return `${heading('CANALES DE VENTA', 'Más canales. La misma operativa.', 'Un catálogo compartido, stock sincronizado y todos tus pedidos centralizados.')}${createdOrder ? `<div class="order-created" role="status"><div><strong>Pedido ${html(createdOrder.number)} creado</strong><p>${html(createdOrder.warning || (state.settings.dispatch_mode === 'immediate' ? 'Sigue el envío al proveedor y simula su preparación desde el detalle.' : 'Listo para enviar al proveedor cuando decidas.'))}</p></div><a class="button button-primary" href="/admin/pedidos/${createdOrder.id}">Seguir pedido ${icon('arrow')}</a></div>` : ''}<div class="info-box marketplace-demo-note">${icon('nodes')}<span><strong>Todo listo para explorar.</strong> Simula un pedido y sigue su recorrido: Marketplace demo → Lighthouse demo → Ecom Connect → Proveedor demo. No se realizan ventas reales.</span></div><div class="marketplace-grid">${state.marketplaces.map(m => { const c = channelInfo(m.channel); const draft = marketplaceDrafts.get(m.channel); return `<section class="admin-card marketplace-card"><div class="marketplace-card-top"><span class="marketplace-logo ${c.color}">${c.letter}</span><span class="status-badge success"><span></span>Demo conectada</span></div><h2>${html(c.name)}</h2><p class="muted">Conexión simulada a través de Lighthouse</p><div class="marketplace-stats"><div><strong>${number(m.published)}</strong><span>productos publicados</span></div><div><strong>${number(m.orders_count)}</strong><span>pedidos recibidos</span></div></div><p class="marketplace-operation-summary"><span><strong>${money(m.total_cents)}</strong> de importe simulado</span><span><strong>${number(m.pending_supplier)}</strong> pendientes de enviar al proveedor</span></p><div class="marketplace-sync"><span><span class="tiny-connected-dot"></span>Stock ${!m.stock_synced ? 'pendiente' : 'sincronizado'}</span><small>Último pedido: ${m.last_order ? html(m.last_order) : 'Sin pedidos'}</small></div><form class="marketplace-order-form" data-channel="${html(m.channel)}"><label class="field-label" for="product-${c.color}">Simular un nuevo pedido</label><select id="product-${c.color}" name="slug" aria-label="Producto para ${html(c.name)}" required ${available.length ? '' : 'disabled'}>${available.length ? productOptions(true, draft?.slug) : '<option value="">No hay productos con stock</option>'}</select><p class="marketplace-form-help" id="availability-${c.color}"></p><div class="marketplace-form-bottom"><label>Cantidad<input name="qty" type="number" value="${draft?.qty || 1}" min="1" max="99" step="1" aria-label="Cantidad para ${html(c.name)}" aria-describedby="availability-${c.color}" required /></label><button class="button button-primary" type="submit" ${available.length ? '' : 'disabled'}>${icon('orders')}Simular pedido</button></div></form></section>`; }).join('')}</div><section class="bottom-callout"><span class="callout-icon">${icon('globe')}</span><div><strong>FarmaHouse también está conectada.</strong><p>Los pedidos de la tienda siguen el mismo flujo que tus marketplaces.</p></div><a class="text-link" href="/">Visitar la tienda ${icon('external')}</a></section>`;
}
function settings() {
  const pending = state.order_summary.pending_supplier;
  return `${heading('PREFERENCIAS DEL ESPACIO', 'Tú decides cómo funciona.', 'Configura el envío de pedidos al proveedor y adapta la operativa a tu negocio.')}<div class="two-panel-grid settings-grid"><section class="admin-card"><div class="card-heading"><div><span class="section-kicker">OPERATIVA DE PEDIDOS</span><h2>Envío al proveedor</h2></div>${icon('settings')}</div><form id="settings-form" class="card-body"><p class="muted">Elige cuándo se transmiten los nuevos pedidos de la tienda y de los marketplaces al proveedor simulado.</p><label class="radio-card"><input type="radio" name="dispatch_mode" value="immediate" ${state.settings.dispatch_mode === 'immediate' ? 'checked' : ''} /><span><strong>Envío inmediato</strong><small>Cada nuevo pedido se envía automáticamente al proveedor cuando se confirma el pago simulado.</small></span><span class="recommended-tag">ÁGIL</span></label><label class="radio-card"><input type="radio" name="dispatch_mode" value="grouped" ${state.settings.dispatch_mode === 'grouped' ? 'checked' : ''} /><span><strong>Envío agrupado</strong><small>${state.settings.scheduled_dispatch ? 'Los pedidos pagados se envían juntos automáticamente cada 15 minutos. También puedes enviarlos manualmente en cualquier momento.' : 'Los pedidos pagados quedan pendientes hasta que los envíes juntos con el botón Enviar pendientes ahora.'}</small></span></label><button type="submit" class="button button-primary">${icon('check')}Guardar configuración</button><p class="form-help">El cambio se aplica a los nuevos pedidos. Los pedidos existentes conservan su estado.</p></form></section><div><section class="admin-card"><div class="card-heading"><h2>Pedidos pendientes</h2>${icon('clock')}</div><div class="card-body"><strong class="pending-big-number">${pending}</strong><p class="muted">pedidos pagados pendientes de enviar, de todos los canales.</p>${button('Enviar pendientes ahora', 'dispatch-pending', false, pending ? '' : 'disabled', 'arrow')}<p class="form-help">Procesa hasta 30 pedidos pagados pendientes por ejecución, incluidos los envíos que fallaron. Si quedan más, vuelve a ejecutar el envío. ${state.settings.scheduled_dispatch ? 'El envío automático agrupado se ejecuta cada 15 minutos.' : 'Ejecución manual en esta demo. La programación automática está preparada, pendiente de activación.'}</p></div></section><div class="settings-demo-info"><span>◉</span><div><strong>Un entorno para probar</strong><p>Esta demo usa datos ficticios. Las acciones actualizan la base de datos de demostración, sin conectar con servicios de venta o proveedores reales.</p></div></div></div></div>`;
}
async function render() {
  if (!panel) return;
  const views: Record<string, () => string> = { dashboard, products, orders, order: orderDetail, supplier, lighthouse, marketplaces, settings };
  panel.innerHTML = (views[view] || dashboard)();
  panel.setAttribute('aria-busy', 'false');
  if (view === 'products') renderProducts();
  if (view === 'orders') void loadOrders();
  if (view === 'supplier') await loadSupplierStock();
  updateMarketplaceAvailability();
}
function updateMarketplaceAvailability() {
  panel?.querySelectorAll<HTMLFormElement>('.marketplace-order-form').forEach(form => {
    const select = form.querySelector<HTMLSelectElement>('select')!;
    const quantity = form.querySelector<HTMLInputElement>('[name="qty"]')!;
    const product = state.products.find(item => item.slug === select.value);
    const available = product?.stock ?? 0;
    quantity.max = String(Math.min(99, available));
    const help = form.querySelector<HTMLElement>('.marketplace-form-help')!;
    help.textContent = available ? `${number(available)} unidades disponibles · ${money(product?.price_cents)} por unidad. El servidor valida el stock al confirmar.` : 'Sin stock disponible. Simula una reposición en Proveedor y sincroniza el catálogo.';
    quantity.disabled = available === 0;
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled = available === 0 || mutationPending;
  });
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  try {
    const timeout = AbortSignal.timeout(25000);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await fetch(url, { ...options, signal });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok === false) throw new Error(typeof data?.error === 'string' ? data.error : data?.message || 'No se pudo completar la operación. Vuelve a intentarlo.');
    return data;
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error(options?.method === 'POST' ? 'La conexión está tardando demasiado. Vuelve a intentarlo; el mismo intento de pedido no se duplicará.' : 'La conexión está tardando demasiado. Vuelve a intentar la consulta.');
    if (error instanceof TypeError) throw new Error('No hay conexión con la demo. Comprueba tu conexión y vuelve a intentarlo.');
    throw error;
  }
}
async function refresh() {
  const [freshState, freshDetail] = await Promise.all([request<State>('/api/demo/state'), view === 'order' ? request<Detail>(`/api/demo/orders/${encodeURIComponent(panel?.dataset.orderId || '')}`) : Promise.resolve(undefined)]);
  state = freshState;
  detail = freshDetail;
  await render();
}
function notify(message: string, error = false, orderId?: number) {
  const notice = document.querySelector<HTMLDivElement>('#admin-notice')!;
  clearTimeout(noticeTimeout);
  noticeListeners?.abort();
  noticeListeners = new AbortController();
  notice.className = `admin-notice${error ? ' notice-error' : ''}`;
  notice.setAttribute('role', error ? 'alert' : 'status');
  notice.setAttribute('aria-live', error ? 'assertive' : 'polite');
  notice.innerHTML = `<span aria-hidden="true">${error ? '!' : '✓'}</span><div>${html(message)}${orderId ? `<br /><a class="notice-action" href="/admin/pedidos/${orderId}">Ver el pedido creado →</a>` : ''}</div><button aria-label="Cerrar aviso">×</button>`;
  notice.hidden = false;
  notice.querySelector('button')?.addEventListener('click', () => { notice.hidden = true; });
  const pause = () => clearTimeout(noticeTimeout);
  const resume = () => {
    pause();
    if (error || orderId || notice.hidden) return;
    noticeTimeout = setTimeout(() => {
      if (!notice.matches(':hover') && !notice.contains(document.activeElement)) notice.hidden = true;
    }, 14000);
  };
  for (const event of ['pointerenter', 'focusin']) notice.addEventListener(event, pause, { signal: noticeListeners.signal });
  for (const event of ['pointerleave', 'focusout']) notice.addEventListener(event, resume, { signal: noticeListeners.signal });
  resume();
}
async function mutate(action: string, fields: Record<string, unknown>, trigger?: HTMLElement, priceAttempt?: SupplierPriceAttempt) {
  if (mutationPending || !panel) return;
  mutationPending = true;
  const form = trigger?.closest<HTMLFormElement>('form');
  const focusSelector = form?.id ? `#${CSS.escape(form.id)} button[type="submit"]` : form?.dataset.channel ? `form[data-channel="${CSS.escape(form.dataset.channel)}"] button[type="submit"]` : `[data-action="${CSS.escape(action)}"]`;
  const fieldsToRestore = [...panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[id], select[id]')].filter(field => !['radio', 'search'].includes(field.type)).map(field => ({ id: field.id, value: field.value }));
  const controls = [...panel.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select')];
  controls.forEach(control => { control.dataset.wasDisabled = String(control.disabled); control.disabled = true; });
  const originalLabel = trigger?.innerHTML;
  if (trigger) { trigger.classList.add('is-busy'); trigger.setAttribute('aria-busy', 'true'); trigger.innerHTML = `${icon('refresh')}<span>Procesando…</span>`; }
  const attempt = action === 'simulate-order' ? JSON.stringify([fields.channel, fields.slug, fields.qty]) : '';
  if (attempt) {
    if (!orderAttempts.has(attempt)) orderAttempts.set(attempt, crypto.randomUUID());
    persistOrderAttempts();
    fields.idempotency_key = orderAttempts.get(attempt);
  }
  try {
    const priceResult = priceAttempt ? await submitSupplierPrice(priceAttempt) : undefined;
    const result: { message?: string; order?: Order; order_id?: number; order_number?: string; marketplace_orders?: { processed: number; errors: number }; marketplace_warning?: string; feed_warning?: string; [key: string]: unknown } = priceResult
      ?? await request('/api/demo/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) });
    if (priceAttempt) {
      supplierPrices.resolve(priceAttempt.code);
      supplierPriceMessages.set(priceAttempt.code, { message: priceResult?.change.changed === false
        ? 'El precio y el PVP ya tenían esos valores. No se ha aplicado ningún cambio.'
        : priceResult?.replayed ? 'Este cambio ya estaba registrado. Consulta los precios actuales antes de sincronizar.' : 'Cambio de precio guardado en el proveedor. Sincroniza para aplicarlo a la tienda y al feed.', error: false });
    }
    if (action === 'sync') {
      for (const [code, message] of supplierPriceMessages) if (!message.error) supplierPriceMessages.delete(code);
    }
    if (attempt) { orderAttempts.delete(attempt); persistOrderAttempts(); }
    const warning = [result.marketplace_warning, result.feed_warning].filter(Boolean).join(' ');
    if (action === 'simulate-order' && result.order_id) createdOrder = { id: result.order_id, number: result.order_number || String(result.order_id), warning };
    const messages: Record<string, string> = { sync: 'Catálogo sincronizado. Stock y precios actualizados.', 'simulate-stock': 'Cambio guardado en el proveedor. Sincroniza el catálogo para importarlo.', 'simulate-price': supplierPriceMessages.get(priceAttempt?.code || '')?.message || 'Cambio de precio guardado en el proveedor.', 'regenerate-feed': 'Feed regenerado y listo para consultar.', 'simulate-order': 'Pedido de demostración creado. Ya aparece en Pedidos.', dispatch: 'Pedido enviado al proveedor simulado.', advance: 'Estado del proveedor actualizado.', 'dispatch-pending': 'Pedidos pendientes enviados al proveedor.', settings: 'Configuración guardada.' };
    try { await refresh(); }
    catch { if (priceAttempt) await loadSupplierStock(); notify(`${messages[action] || 'Operación guardada.'} No hemos podido actualizar la vista. Recarga la página para consultar el resultado.`, true, result.order_id); return; }
    fieldsToRestore.forEach(saved => {
      const control = document.getElementById(saved.id) as HTMLInputElement | HTMLSelectElement | null;
      if (control && (control instanceof HTMLInputElement || [...control.options].some(option => option.value === saved.value))) control.value = saved.value;
    });
    if (action === 'sync' || action === 'dispatch-pending') {
      const errors = Number(result.errors || 0);
      const marketplaceErrors = result.marketplace_orders?.errors ?? 0;
      const processed = number(result.processed);
      const summary = action === 'sync'
        ? `Sincronización finalizada: ${processed} productos procesados, ${number(result.updated)} actualizados y ${number(errors)} errores de catálogo. ${number(result.marketplace_orders?.processed)} acuses conciliados y ${number(marketplaceErrors)} errores de retorno al marketplace.`
        : `Envío finalizado: ${processed} pedidos enviados y ${number(errors)} errores.`;
      notify(`${summary}${errors || marketplaceErrors ? (action === 'sync' ? ' Revisa la actividad y los acuses pendientes en cada pedido.' : ' Los pedidos con error siguen pendientes. Revisa su detalle.') : ''}`, errors + marketplaceErrors > 0);
    } else notify(warning || result.message || messages[action] || 'Operación completada.', Boolean(warning), result.order_id);
  } catch (error) {
    if (priceAttempt) {
      if (error instanceof SupplierPriceSubmissionError && error.definitive) supplierPrices.resolve(priceAttempt.code);
      supplierPriceMessages.set(priceAttempt.code, { message: error instanceof SupplierPriceSubmissionError && error.code === 'supplier_price_changed'
        ? 'El precio del proveedor cambió mientras editabas. Revisa los importes actuales y tu propuesta antes de volver a guardarla.'
        : error instanceof Error ? error.message : 'No hemos podido comprobar el cambio de precio.', error: true });
      if (error instanceof SupplierPriceSubmissionError && error.definitive) await loadSupplierStock();
    }
    notify(error instanceof Error ? error.message : 'Se ha producido un error.', true);
  }
  finally {
    mutationPending = false;
    controls.forEach(control => { control.disabled = control.dataset.wasDisabled === 'true'; });
    if (trigger?.isConnected) { trigger.classList.remove('is-busy'); trigger.removeAttribute('aria-busy'); if (originalLabel) trigger.innerHTML = originalLabel; }
    updateMarketplaceAvailability();
    renderSupplierPrice();
    const replacement = panel.querySelector<HTMLButtonElement>(focusSelector);
    if (replacement && !replacement.disabled && (document.activeElement === document.body || document.activeElement === trigger || document.activeElement === replacement)) replacement.focus({ preventScroll: true });
  }
}
panel?.addEventListener('input', event => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'product-search') { productQuery = target.value; syncProductUrl(); renderProducts(); }
  if (target.id === 'order-search') { orderQuery = target.value; orderPage = 1; scheduleOrders(250); }
  if (target.id === 'stock-value') supplierStock.edit(target.value);
  if (target.id === 'supplier-price-value' || target.id === 'supplier-pvp-value') {
    supplierPrices.edit(supplierStock.code, { price: document.querySelector<HTMLInputElement>('#supplier-price-value')!.value, pvp: document.querySelector<HTMLInputElement>('#supplier-pvp-value')!.value });
  }
  const form = target.closest<HTMLFormElement>('.marketplace-order-form');
  if (form?.dataset.channel) marketplaceDrafts.set(form.dataset.channel, { slug: form.querySelector<HTMLSelectElement>('select')!.value, qty: Number(form.querySelector<HTMLInputElement>('[name="qty"]')!.value) });
});
panel?.addEventListener('change', event => {
  const target = event.target as HTMLSelectElement;
  if (target.id === 'product-category') { productCategory = target.value; syncProductUrl('push'); renderProducts(); }
  if (target.id === 'product-status') { productState = target.value; syncProductUrl('push'); renderProducts(); }
  if (target.id === 'product-stock') { productStock = target.value; syncProductUrl('push'); renderProducts(); }
  if (target.id === 'order-channel') { orderChannel = target.value; orderPage = 1; scheduleOrders(0, 'push'); }
  if (target.id === 'order-status') { orderStatus = target.value; orderPage = 1; scheduleOrders(0, 'push'); }
  if (target.id === 'stock-product') {
    supplierStock.select(state.products.find(product => product.slug === target.value)?.supplier_sku || '');
    void loadSupplierStock();
  }
  if (target.closest('.marketplace-order-form')) updateMarketplaceAvailability();
});
panel?.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
  const action = target.dataset.action!;
  if (action === 'reset-products') {
    productQuery = ''; productCategory = ''; productState = ''; productStock = '';
    updateProductControls(); syncProductUrl('push'); renderProducts();
    document.querySelector<HTMLInputElement>('#product-search')!.focus({ preventScroll: true }); return;
  }
  if (action === 'reset-orders') {
    orderQuery = ''; orderChannel = ''; orderStatus = ''; orderPage = 1;
    document.querySelector<HTMLInputElement>('#order-search')!.value = '';
    document.querySelector<HTMLSelectElement>('#order-channel')!.value = '';
    document.querySelector<HTMLSelectElement>('#order-status')!.value = '';
    scheduleOrders(0, 'push'); document.querySelector<HTMLInputElement>('#order-search')!.focus(); return;
  }
  if (action === 'previous-orders' || action === 'next-orders') {
    orderPage += action === 'previous-orders' ? -1 : 1;
    scheduleOrders(0, 'push'); return;
  }
  if (action === 'retry-orders') { void loadOrders(); return; }
  if (action === 'retry-stock') { void loadSupplierStock(); return; }
  if (action === 'copy-feed') {
    const input = document.getElementById(target.dataset.input || '') as HTMLInputElement | null;
    if (input) void navigator.clipboard.writeText(input.value).then(() => notify('URL del feed copiada.')).catch(() => { input.focus(); input.select(); notify('La URL está seleccionada. Cópiala con el menú de tu dispositivo.'); });
    return;
  }
  const fields: Record<string, unknown> = {};
  if (target.dataset.orderId) fields.order_id = Number(target.dataset.orderId);
  if (action === 'advance') fields.status = document.querySelector<HTMLSelectElement>('#next-status')?.value;
  void mutate(action, fields, target);
});
panel?.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement;
  event.preventDefault();
  if (mutationPending || !form.reportValidity()) return;
  const data = new FormData(form);
  const trigger = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  if (form.id === 'stock-form') {
    void mutate('simulate-stock', { slug: data.get('slug'), stock: Number(data.get('stock')) }, trigger);
  } else if (form.id === 'supplier-price-form') {
    try {
      let pending = supplierPrices.pending(supplierStock.code);
      if (!pending) {
        const snapshot = supplierStock.snapshot;
        if (!snapshot) throw new Error('Consulta los datos del producto antes de guardar el precio.');
        supplierPrices.edit(supplierStock.code, { price: String(data.get('price') || ''), pvp: String(data.get('pvp') || '') });
        pending = supplierPrices.begin(supplierStock.code, { price_cents: snapshot.supplier_price_cents, pvp_cents: snapshot.supplier_pvp_cents });
      }
      void mutate('simulate-price', {}, trigger, pending);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Revisa los precios antes de continuar.';
      supplierPriceMessages.set(supplierStock.code, { message, error: true });
      renderSupplierPrice();
      document.querySelector<HTMLInputElement>(message.includes('PVP') ? '#supplier-pvp-value' : '#supplier-price-value')?.focus({ preventScroll: true });
    }
  } else if (form.id === 'settings-form') void mutate('settings', { dispatch_mode: data.get('dispatch_mode') }, trigger);
  else if (form.matches('.marketplace-order-form')) void mutate('simulate-order', { channel: form.dataset.channel, slug: data.get('slug'), qty: Number(data.get('qty')) }, trigger);
});
window.addEventListener('popstate', () => {
  if (view === 'products') {
    const filters = readProductFilters(location.search, state ? [...new Set(state.products.map(product => product.category))] : undefined);
    productQuery = filters.q; productCategory = filters.category; productState = filters.state; productStock = filters.stock;
    updateProductControls(); syncProductUrl(); if (state) renderProducts(); return;
  }
  if (view !== 'orders') return;
  const filters = readOrderFilters(location.search);
  orderQuery = filters.q; orderChannel = filters.channel; orderStatus = filters.status; orderPage = filters.page;
  const search = document.querySelector<HTMLInputElement>('#order-search');
  const channel = document.querySelector<HTMLSelectElement>('#order-channel');
  const status = document.querySelector<HTMLSelectElement>('#order-status');
  if (search) search.value = orderQuery;
  if (channel) channel.value = orderChannel;
  if (status) status.value = orderStatus;
  scheduleOrders();
});
if (panel) refresh().catch(error => {
  panel.setAttribute('aria-busy', 'false');
  panel.innerHTML = `<section class="admin-card load-error"><span>!</span><h1>No pudimos cargar este espacio</h1><p>${html(error.message)}</p><button class="button button-primary" id="retry-load">Volver a intentar</button><a class="text-link" href="/admin">Ir al resumen</a></section>`;
  document.querySelector('#retry-load')?.addEventListener('click', () => location.reload());
});
