import assert from 'node:assert/strict';

// Aceptación pública sin crear pedidos ni modificar ajustes, catálogo o stock.
// Uso: DEMO_URL=http://localhost:4327 node scripts/verify-public.mjs
const base = new URL(process.env.DEMO_URL ?? 'https://ecom-connect.marinerandreu.workers.dev');
assert.ok(['http:','https:'].includes(base.protocol),'DEMO_URL debe usar HTTP o HTTPS.');
assert.ok(!base.username && !base.password && base.pathname === '/' && !base.search && !base.hash,
  'DEMO_URL debe ser solo el origen, sin credenciales, ruta, consulta ni fragmento.');
const origin = base.origin;
const EXPECTED_PRODUCTS = 45;
const htmlCache = new Map();
let checks = 0;
let requests = 0;

function check(condition, message) {
  assert.ok(condition,message);
  checks++;
  console.log(`✓ ${message}`);
}

async function request(path, {quote, expected = 200} = {}) {
  let url = new URL(path,origin);
  assert.equal(url.origin,origin,'La verificación no puede consultar otro origen.');
  // El único POST permitido es una cotización: no persiste cambios en la demo.
  if (quote !== undefined) assert.equal(url.pathname,'/api/cart/quote','POST no autorizado por esta prueba.');
  for (let redirects = 0; redirects <= 5; redirects++) {
    requests++;
    const response = await fetch(url,{
      method:quote === undefined ? 'GET' : 'POST',
      ...(quote === undefined ? {} : {headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(quote)}),
      signal:AbortSignal.timeout(20_000),redirect:'manual',
    });
    if ([301,302,303,307,308].includes(response.status)) {
      assert.equal(quote,undefined,'La cotización no debe redirigir.');
      const location = response.headers.get('location');
      assert.ok(location,`Redirección sin destino: ${url.pathname}`);
      await response.body?.cancel();
      url = new URL(location,url);
      assert.equal(url.origin,origin,`Enlace redirigido fuera de la demo: ${path}`);
      continue;
    }
    assert.equal(response.status,expected,`${path}: se esperaba HTTP ${expected}; recibido ${response.status}.`);
    return response;
  }
  throw new Error(`Demasiadas redirecciones: ${path}`);
}

function assertRobots(response, path) {
  const robots = response.headers.get('x-robots-tag') ?? '';
  assert.match(robots,/\bnoindex\b/i,`Falta noindex: ${path}`);
  assert.match(robots,/\bnofollow\b/i,`Falta nofollow: ${path}`);
}

async function json(path, options) {
  const response = await request(path,options);
  assertRobots(response,path);
  assert.match(response.headers.get('content-type') ?? '',/application\/json/i,`JSON esperado: ${path}`);
  return response.json();
}

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi,(entity,code) => {
    if (code[0] === '#') {
      const numeric = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2),16) : Number(code.slice(1));
      return numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
    }
    return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[code.toLowerCase()] ?? entity;
  });
}

function attributes(html, tag, attribute) {
  const tags = html.match(new RegExp(`<${tag}\\b[^>]*>`,'gi')) ?? [];
  const pattern = new RegExp(`\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,'i');
  return tags.flatMap(element => {
    const match = element.match(pattern);
    return match ? [decodeEntities(match[1] ?? match[2])] : [];
  });
}

async function html(path) {
  const url = new URL(path,origin);
  url.hash = '';
  if (htmlCache.has(url.href)) return htmlCache.get(url.href);
  const response = await request(url.href);
  assertRobots(response,path);
  assert.match(response.headers.get('content-type') ?? '',/text\/html/i,`HTML esperado: ${path}`);
  const text = await response.text();
  assert.match(text,/<html\b[^>]*\blang=["']es(?:-[a-z]+)?["']/i,`Idioma español ausente: ${path}`);
  assert.match(text,/<title>[^<]+<\/title>/i,`Título vacío: ${path}`);
  assert.match(text,/<main\b/i,`Contenido principal ausente: ${path}`);
  assert.match(text,/<h1\b/i,`Encabezado principal ausente: ${path}`);
  assert.doesNotMatch(text,/<title>\s*(?:Error|404|500)\b/i,`Página de error: ${path}`);
  htmlCache.set(url.href,text);
  return text;
}

async function mapLimited(items, callback) {
  const queue = [...items];
  await Promise.all(Array.from({length:Math.min(4,queue.length)},async () => {
    while (queue.length) await callback(queue.shift());
  }));
}

async function main() {
  console.log(`Verificación pública sin mutaciones: ${origin}`);
  const {products} = await json('/api/products');
  check(Array.isArray(products) && products.length === EXPECTED_PRODUCTS,'Catálogo público: 45 productos activos');
  const slugs = new Set(products.map(product => product.slug));
  const skus = new Set(products.map(product => product.sku));
  check(slugs.size === EXPECTED_PRODUCTS && skus.size === EXPECTED_PRODUCTS,'Slugs y referencias únicos');
  check(products.every(product => Number.isSafeInteger(product.price_cents) && product.price_cents >= 0 &&
    Number.isSafeInteger(product.stock) && product.stock >= 0),'Precios en céntimos y existencias válidos');
  check(products.every(product => /^\/images\/products\/generated\/[^/]+\.webp$/.test(product.image)),
    '45 productos con fotografía WebP del catálogo demo');

  const state = await json('/api/demo/state');
  const summary = state.order_summary;
  const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
  check(Array.isArray(state.orders) && state.orders.length <= 100 && summary &&
    [summary.total,summary.total_cents,summary.pending_supplier].every(nonnegativeInteger) &&
    summary.total >= state.orders.length && summary.pending_supplier <= summary.total,
    'Resumen global válido: incluye el historial completo y conserva una lista de hasta 100 pedidos');
  assert.ok(Array.isArray(state.marketplaces),'El estado debe incluir el resumen de marketplaces.');
  const channelTotals = {orders_count:0,total_cents:0,pending_supplier:0};
  for (const marketplace of state.marketplaces) {
    assert.ok([marketplace.orders_count,marketplace.total_cents,marketplace.pending_supplier].every(nonnegativeInteger),
      `Agregados inválidos del marketplace ${marketplace.channel}.`);
    assert.ok(marketplace.pending_supplier <= marketplace.orders_count,
      `Más pendientes que pedidos en ${marketplace.channel}.`);
    assert.ok(marketplace.orders_count === 0 ? marketplace.last_order === null :
      typeof marketplace.last_order === 'string' && marketplace.last_order.trim().length > 0,
      `Último pedido incoherente en ${marketplace.channel}.`);
    for (const key of Object.keys(channelTotals)) channelTotals[key] += marketplace[key];
  }
  check(state.marketplaces.length === 4 && new Set(state.marketplaces.map(channel => channel.channel)).size === 4 &&
    channelTotals.orders_count <= summary.total && channelTotals.total_cents <= summary.total_cents &&
    channelTotals.pending_supplier <= summary.pending_supplier,
    'Cuatro marketplaces con totales, pendientes y último pedido coherentes fuera de la lista reciente');
  check(state.orders.every(order => order && typeof order === 'object' &&
    !Object.hasOwn(order,'stripe_session_id') && !Object.hasOwn(order,'request_hash') &&
    !Object.hasOwn(order,'supplier_stock_committed')),
    'Pedidos públicos sin tokens de sesión ni hashes internos de idempotencia');

  const history = await json('/api/demo/orders');
  const pagination = history.pagination;
  assert.ok(pagination && [pagination.page,pagination.limit,pagination.pages].every(value =>
    Number.isSafeInteger(value) && value >= 1) && nonnegativeInteger(pagination.total),
    'Metadatos de paginación inválidos.');
  assert.deepEqual(history.filters,{q:'',channel:'',status:'',supplier:''});
  assert.equal(pagination.page,1);
  assert.equal(pagination.limit,25);
  assert.equal(pagination.pages,Math.max(1,Math.ceil(pagination.total/25)));
  check(Array.isArray(history.orders) && history.orders.length === Math.min(25,pagination.total) &&
    history.orders.every((order,index) => order && Number.isSafeInteger(order.id) &&
      (index === 0 || history.orders[index-1].id > order.id) &&
      !Object.hasOwn(order,'stripe_session_id') && !Object.hasOwn(order,'request_hash')),
    'Historial paginado: 25 pedidos por página, orden estable y datos públicos');
  const newest = history.orders[0];
  const validDispatchMode = order => Object.hasOwn(order,'supplier_dispatch_mode') &&
    [null,'grouped','immediate'].includes(order.supplier_dispatch_mode);
  assert.ok(state.orders.every(validDispatchMode) && history.orders.every(validDispatchMode),
    'El modo de envío debe estar fijado por pedido o ser null para el histórico.');
  if (newest) {
    const detail = await json(`/api/demo/orders/${newest.id}`);
    assert.equal(detail.order?.supplier_dispatch_mode,newest.supplier_dispatch_mode);
    assert.ok(validDispatchMode(detail.order) && !Object.hasOwn(detail.order,'supplier_stock_committed') &&
      !Object.hasOwn(detail.order,'stripe_session_id') && !Object.hasOwn(detail.order,'request_hash'),
      'El detalle debe exponer la modalidad sin datos internos del pedido.');
    const query = new URLSearchParams({q:newest.order_number,channel:newest.channel,status:newest.status});
    const found = await json(`/api/demo/orders?${query}`);
    check(found.pagination.total === 1 && found.orders[0]?.id === newest.id,
      'Búsqueda combinada por referencia, canal y estado encuentra el pedido esperado');
  }
  check(true,'Modalidad propia de envío coherente en resumen, historial y detalle; histórico sin modalidad inventada');
  // Expediciones por línea: se leen un pedido expedido y, si existe, uno parcial. No se crea ninguno.
  const coherentFulfillment = detail => {
    const {lines,shipments} = detail.fulfillment ?? {};
    if (!Array.isArray(lines) || !Array.isArray(shipments)) return false;
    const shippedBySku = new Map();
    for (const shipment of shipments) {
      if (!/^DEMO-/.test(shipment.tracking_number) || shipment.units !== shipment.lines.reduce((sum,line) => sum + line.qty,0)) return false;
      for (const line of shipment.lines) shippedBySku.set(line.supplier_sku,(shippedBySku.get(line.supplier_sku) ?? 0) + line.qty);
    }
    const complete = lines.every(line => line.pending === 0);
    return shipments.every((shipment,index) => shipment.sequence === index + 1) &&
      lines.every(line => line.shipped === (shippedBySku.get(line.supplier_sku) ?? 0) &&
        line.shipped <= line.ordered && line.pending === line.ordered - line.shipped) &&
      // Un acuse pendiente es un estado legítimo: lo concilia la sincronización.
      (detail.order.supplier_status === 'SUPPLIER_SHIPPED') === (complete && shipments.length > 0) &&
      shipments.every(shipment => detail.order.channel !== 'WEB' || shipment.marketplace_synced_at === null);
  };
  for (const supplier of ['shipped','partial']) {
    const sample = (await json(`/api/demo/orders?supplier=${supplier}&limit=1`)).orders[0];
    if (sample) assert.ok(coherentFulfillment(await json(`/api/demo/orders/${sample.id}`)),`Expediciones incoherentes en el pedido ${sample.order_number}.`);
  }
  check(true,'Expediciones por línea: unidades, secuencia, seguimiento y estado del pedido coherentes');
  // Cancelaciones: se lee un pedido cancelado si existe. No se cancela ninguno.
  const cancelledSample = (await json('/api/demo/orders?status=cancelled&limit=1')).orders[0];
  if (cancelledSample) {
    const detail = await json(`/api/demo/orders/${cancelledSample.id}`);
    const cancellation = detail.cancellation;
    assert.ok(detail.order.status === 'cancelled' &&
      (cancellation?.supplier_outcome === 'rejected' || detail.fulfillment.shipments.length === 0) &&
      (cancellation === null || (['panel','marketplace','account'].includes(cancellation.source) &&
        ['pending','not_required','accepted','rejected'].includes(cancellation.supplier_outcome) &&
        (cancellation.source !== 'marketplace' || detail.order.channel !== 'WEB') &&
        (cancellation.source !== 'account' || detail.order.channel === 'WEB') &&
        (detail.order.channel !== 'WEB' || cancellation.marketplace_synced_at === null))),
      `Cancelación incoherente en el pedido ${cancelledSample.order_number}.`);
    const accepted = await json('/api/demo/orders?supplier=accepted&limit=50');
    assert.ok(accepted.orders.every(order => order.status !== 'cancelled'),'Un pedido cancelado no debe figurar en la situación del proveedor.');
  }
  check(true,'Cancelaciones: origen, respuesta del proveedor y acuse coherentes; sin expediciones ni situación de proveedor');
  // Bandeja «Requiere atención»: coherente con los filtros del historial. Solo lectura.
  const attention = state.attention;
  const attentionKinds = ['supplier_error','partial_shipment','marketplace_ack','cancellation'];
  assert.deepEqual(attention?.items?.map(item => item.kind),attentionKinds,'La bandeja debe incluir sus cuatro tipos en orden.');
  assert.ok(attention.total === attention.items.reduce((sum,item) => sum + item.count,0) &&
    attention.items.every(item => Number.isSafeInteger(item.count) && item.count >= 0 &&
      item.orders.length === Math.min(5,item.count) &&
      item.orders.every((order,index) => Object.keys(order).sort().join() === 'channel,id,order_number' &&
        (index === 0 || item.orders[index-1].id > order.id))),
    'Totales, límite de cinco pedidos y datos públicos de la bandeja incoherentes.');
  const attentionCount = kind => attention.items.find(item => item.kind === kind).count;
  const errorOrders = await json('/api/demo/orders?supplier=error&status=paid&limit=1');
  const partialOrders = await json('/api/demo/orders?supplier=partial&status=paid&limit=1');
  assert.ok(errorOrders.pagination.total === attentionCount('supplier_error') &&
    partialOrders.pagination.total === attentionCount('partial_shipment'),
    'Los errores y parciales de la bandeja deben coincidir con los filtros del historial.');
  assert.ok(attention.items.find(item => item.kind === 'marketplace_ack').orders.every(order => order.channel !== 'WEB'),
    'Un pedido web no puede tener un acuse de marketplace pendiente.');
  check(true,'Bandeja «Requiere atención»: totales, pedidos recientes y coincidencia con los filtros del historial');
  // Supervisión del envío agrupado. Solo lectura: no se ejecuta ningún envío ni se cambia la pausa.
  const dispatchRuns = state.dispatch_runs;
  assert.ok(typeof state.settings.dispatch_paused === 'boolean' && Array.isArray(dispatchRuns) && dispatchRuns.length <= 5 &&
    dispatchRuns.filter(run => run.status === 'running').length <= 1 &&
    dispatchRuns.every((run,index) => ['manual','scheduled'].includes(run.source) &&
      ['running','completed','skipped','failed'].includes(run.status) &&
      [run.processed,run.errors,run.remaining].every(value => Number.isSafeInteger(value) && value >= 0) &&
      (run.status === 'running') === (run.finished_at === null) &&
      (run.status !== 'skipped' || (run.processed === 0 && ['paused','overlap'].includes(run.reason))) &&
      (index === 0 || dispatchRuns[index-1].id > run.id)),
    'El registro de ejecuciones del envío agrupado es incoherente.');
  check(true,'Envío agrupado: pausa, últimas ejecuciones y una sola en curso');
  const empty = await json('/api/demo/orders?q=__verify_public_missing_order_8de79b__&page=100000');
  check(empty.orders.length === 0 && empty.pagination.total === 0 &&
    empty.pagination.page === 1 && empty.pagination.pages === 1,
    'Búsqueda vacía y página fuera de rango responden de forma coherente');
  const pendingDispatch = await json('/api/demo/orders?supplier=pending_dispatch&limit=1');
  check(pendingDispatch.filters.supplier === 'pending_dispatch' &&
    pendingDispatch.pagination.total === summary.pending_supplier &&
    pendingDispatch.orders.every(order => order.status === 'paid'),
    'Filtro de pendientes coincide con la cola global de envío al proveedor');
  for (const [filter,status] of [['error','ERROR'],['partial','SUPPLIER_PARTIAL']]) {
    const filtered = await json(`/api/demo/orders?supplier=${filter}`);
    assert.equal(filtered.filters.supplier,filter);
    assert.ok(filtered.orders.every(order => order.supplier_status === status),`Estado de proveedor incoherente: ${filter}`);
  }
  check(true,'Filtros de error y parcial consultan la situación actual del proveedor');
  await Promise.all(['/api/demo/orders?limit=51','/api/demo/orders?page=0',
    '/api/demo/orders?supplier=unknown',
    '/api/demo/orders?channel=UNKNOWN','/api/demo/orders?status=unknown'].map(async path => {
    const result = await json(path,{expected:400});
    assert.equal(typeof result.error,'string','La validación debe explicar el error.');
  }));
  check(true,'Paginación y filtros inválidos rechazados antes de consultar el historial');

  const stockProduct = products.find(product => typeof product.supplier_sku === 'string' && product.supplier_sku);
  assert.ok(stockProduct,'Se necesita una referencia de proveedor para comprobar el desglose de stock.');
  const {demo:stockDemo,snapshot} = await json(`/api/demo/stock?${new URLSearchParams({code:stockProduct.supplier_sku})}`);
  check(stockDemo === true && snapshot?.code === stockProduct.supplier_sku &&
    [snapshot.supplier_stock,snapshot.reserved_units,snapshot.reserved_orders_count,snapshot.theoretical_available,snapshot.store_stock].every(nonnegativeInteger) &&
    snapshot.reserved_orders_count <= snapshot.reserved_units &&
    snapshot.theoretical_available === Math.max(0,snapshot.supplier_stock-snapshot.reserved_units) &&
    snapshot.stock_difference === snapshot.store_stock-snapshot.theoretical_available,
    'Desglose de stock coherente: proveedor menos reservas, disponible calculado y diferencia con tienda');
  const validPricePair = (price,pvp) => nonnegativeInteger(price) &&
    (pvp === null || nonnegativeInteger(pvp) && pvp > price);
  check(validPricePair(snapshot.supplier_price_cents,snapshot.supplier_pvp_cents) &&
    validPricePair(snapshot.store_price_cents,snapshot.store_pvp_cents),
    'Precios de proveedor y tienda en céntimos, con PVP opcional coherente');
  const missingStock = await json('/api/demo/stock?code=__verify_public_missing_supplier_8de79b__',{expected:404});
  const invalidStock = await json('/api/demo/stock?code=',{expected:400});
  check(typeof missingStock.error === 'string' && typeof invalidStock.error === 'string',
    'Consulta de stock inexistente o sin referencia rechazada sin modificar existencias');

  // El área de cliente sin sesión: acceso público y enlace caducado, sin escribir nada.
  const sessionless = await request('/cuenta/acceso?codigo=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',{expected:401});
  assertRobots(sessionless,'/cuenta/acceso');
  await sessionless.body?.cancel();
  const accountApi = await json('/api/cuenta/datos.json',{expected:401});
  check(typeof accountApi.error === 'string','Los datos de una cuenta exigen sesión y un enlace usado no abre otra');

  const pages = ['/', '/tienda', '/carrito', '/checkout', '/cuenta', '/cuenta/entrar', '/admin', '/admin/productos', '/admin/pedidos',
    '/admin/marketplaces', '/admin/integraciones/proveedor', '/admin/integraciones/lighthouse', '/admin/configuracion',
    '/admin/documentacion', '/admin/documentacion/guia-demo', '/admin/documentacion/conexion-servicios', '/admin/documentacion/operacion-demo',
    ...products.map(product => `/tienda/${encodeURIComponent(product.slug)}`)];
  await mapLimited(pages,html);
  check(true,'Tienda, panel, documentación nueva y 45 fichas: HTML español con noindex/nofollow');
  const docsIndex = await html('/admin/documentacion');
  check(docsIndex.includes('/admin/documentacion/guia-demo') && docsIndex.includes('/admin/documentacion/conexion-servicios') && docsIndex.includes('/admin/documentacion/operacion-demo'),
    'Guías de presentación, conexión y operación accesibles desde el centro documental');

  const links = new Map();
  const images = new Set(products.map(product => new URL(product.image,origin).href));
  for (const [page,content] of htmlCache) {
    for (const href of attributes(content,'a','href')) {
      const url = new URL(href,page);
      if (url.origin === origin && ['http:','https:'].includes(url.protocol)) links.set(url.href,page);
    }
    for (const src of attributes(content,'img','src')) {
      const url = new URL(src,page);
      assert.equal(url.origin,origin,`Imagen de otro origen en ${page}`);
      images.add(url.href);
    }
  }
  assert.ok(links.size <= 400,'Más de 400 enlaces internos; revisar antes de ampliar la comprobación.');
  await mapLimited(links,async ([href,source]) => {
    const url = new URL(href);
    let content;
    if (url.pathname.startsWith('/api/') || url.pathname === '/feeds/products.xml' || /\.[a-z0-9]+$/i.test(url.pathname)) {
      const response = await request(href);
      await response.body?.cancel();
    } else content = await html(href);
    if (url.hash && content !== undefined) {
      const fragment = decodeURIComponent(url.hash.slice(1));
      const ids = attributes(content,'[a-z][a-z0-9:-]*','id');
      assert.ok(ids.includes(fragment),`Ancla inexistente: ${href}, enlazada desde ${source}`);
    }
  });
  check(true,`${links.size} enlaces internos y sus anclas válidos`);

  await mapLimited(images,async (href) => {
    const response = await request(href);
    assert.match(response.headers.get('content-type') ?? '',/^image\//i,`Formato de imagen inválido: ${href}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(bytes.length > 0,`Imagen vacía: ${href}`);
    if (new URL(href).pathname.endsWith('.webp')) {
      const header = new TextDecoder().decode(bytes.subarray(0,12));
      assert.ok(header.startsWith('RIFF') && header.endsWith('WEBP'),`Fotografía WebP inválida: ${href}`);
    }
  });
  check(true,`${images.size} imágenes accesibles y con contenido válido`);

  const feed = await json('/api/feeds/products.json');
  check(feed.demo === true && feed.products?.length === EXPECTED_PRODUCTS,'Feed JSON: 45 referencias y marca de simulación');
  const bySku = new Map(products.map(product => [product.sku,product]));
  for (const item of feed.products) {
    const product = bySku.get(item.sku);
    assert.ok(product,`Referencia desconocida en feed: ${item.sku}`);
    assert.equal(item.link,`${origin}/tienda/${encodeURIComponent(product.slug)}`,'Enlace de producto incoherente en feed.');
    assert.equal(item.price,`${(product.price_cents/100).toFixed(2)} EUR`,'Precio incoherente en feed.');
    assert.equal(item.availability,item.stock > 0 ? 'in_stock' : 'out_of_stock','Disponibilidad incoherente en feed.');
    assert.equal(new URL(item.image_link).origin,origin,'Imagen del feed fuera de la demo.');
  }
  check(new Set(feed.products.map(item => item.sku)).size === EXPECTED_PRODUCTS,'Feed JSON sin duplicados, con precios y enlaces coherentes');
  const xmlResponse = await request('/feeds/products.xml');
  assertRobots(xmlResponse,'/feeds/products.xml');
  assert.match(xmlResponse.headers.get('content-type') ?? '',/(?:application|text)\/xml/i);
  const xml = await xmlResponse.text();
  const xmlIds = [...xml.matchAll(/<g:id>([\s\S]*?)<\/g:id>/g)].map(match => decodeEntities(match[1]));
  check((xml.match(/<item>/g) ?? []).length === EXPECTED_PRODUCTS && new Set(xmlIds).size === EXPECTED_PRODUCTS &&
    xmlIds.every(sku => skus.has(sku)) && xml.includes('xmlns:g="http://base.google.com/ns/1.0"'),'Feed XML: las mismas 45 referencias y namespace Merchant');

  const product = products.find(item => item.stock > 0);
  assert.ok(product,'La demo necesita al menos un producto disponible para cotizar.');
  const qty = Math.min(2,product.stock);
  const lines = [{slug:product.slug,qty,unit_price_cents:1}];
  const quote = await json('/api/cart/quote',{quote:{lines,postal_code:'12001',total_cents:1}});
  check(quote.purchasable === true && quote.lines[0]?.unit_price_cents === product.price_cents &&
    quote.subtotal_cents === product.price_cents*qty && Number.isSafeInteger(quote.shipping_cents) &&
    quote.total_cents === quote.subtotal_cents+quote.shipping_cents,'Cotización recalculada en servidor, sin aceptar importes del cliente');
  const invalid = await json('/api/cart/quote',{quote:{lines:[{slug:product.slug,qty:0}]},expected:400});
  check(typeof invalid.error === 'string','Cantidades inválidas rechazadas con mensaje de validación');
  const unavailable = await json('/api/cart/quote',{quote:{lines:[{slug:'__verify_public_missing_product__',qty:1}],postal_code:'12001'}});
  check(unavailable.purchasable === false && unavailable.lines[0]?.status === 'not-found','Producto inexistente rechazado sin crear pedido');
  const uncovered = await json('/api/cart/quote',{quote:{lines,postal_code:'99999'}});
  check(uncovered.shipping_cents === null && uncovered.total_cents === null,'Código postal sin cobertura: total pendiente');
  console.log(`\n${checks} comprobaciones completas · ${requests} solicitudes · solo GET y cotización POST.`);
}

main().catch(error => {
  console.error(`✗ Verificación incompleta: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
