import assert from 'node:assert/strict';

const origin = process.env.DEMO_URL ?? 'http://localhost:4327';
if (!['localhost','127.0.0.1'].includes(new URL(origin).hostname) && process.env.ALLOW_DEMO_MUTATIONS !== 'true') {
  throw new Error('Las pruebas crean pedidos ficticios. Usa ALLOW_DEMO_MUTATIONS=true solo en esta demo.');
}
let checks = 0;
function check(condition, message) { assert.ok(condition,message); checks++; console.log(`✓ ${message}`); }
async function request(path, body, expected = 200) {
  const response = await fetch(origin+path,body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
  const data = await response.json();
  assert.equal(response.status,expected,`${path}: ${JSON.stringify(data)}`);
  return data;
}
const action = body => request('/api/demo/action',body);
const state = () => request('/api/demo/state');
const customer = {name:'Cliente de prueba (demo)',email:'qa@example.test',street:'Calle Ficticia 18',city:'Castellón',postal_code:'12001'};
const initial = await state();
check(initial.products.length === 45,'45 productos cargados desde D1');
const product = initial.products.find(p=>p.slug==='champu-dermocare');
await action({action:'settings',dispatch_mode:'grouped'});
const quote = await request('/api/cart/quote',{lines:[{slug:product.slug,qty:2}],postal_code:'12001',total_cents:1});
check(quote.subtotal_cents === product.price_cents*2 && quote.total_cents === product.price_cents*2+490,'Totales revalidados en servidor, ignorando precio enviado');
await request('/api/checkout/session',{lines:[{slug:product.slug,qty:-1}],customer,idempotency_key:crypto.randomUUID()},400);
checks++;
const forbidden = await fetch(origin+'/api/demo/action',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://invalid.example'},body:JSON.stringify({action:'sync'})});
check(forbidden.status===403,'Operación desde otro origen bloqueada');
const key=crypto.randomUUID();
const payload={lines:[{slug:product.slug,qty:2}],customer,idempotency_key:key};
const concurrent = await Promise.all([request('/api/checkout/session',payload),request('/api/checkout/session',payload)]);
check(concurrent[0].order_id === concurrent[1].order_id,'Checkout concurrente idempotente: un único pedido');
const web=concurrent[0];
let current=await state();
check(current.products.find(p=>p.slug===product.slug).stock===product.stock-2,'Stock decrementado exactamente una vez');
await request('/api/checkout/session',{...payload,lines:[{slug:product.slug,qty:1}]},409);
checks++;
await action({action:'sync'});
current=await state();
check(current.products.find(p=>p.slug===product.slug).stock===product.stock-2,'Sincronizar conserva cantidades pendientes de proveedor');
const sends=await Promise.all([action({action:'dispatch',order_id:web.order_id}),action({action:'dispatch',order_id:web.order_id})]);
check(sends[0].order.supplier_order_id===sends[1].order.supplier_order_id,'Envío concurrente devuelve un único ID proveedor');
await action({action:'sync'});
current=await state();
check(current.products.find(p=>p.slug===product.slug).stock===product.stock-2,'Stock consistente después de enviar al proveedor y sincronizar');
await action({action:'advance',order_id:web.order_id,status:'processing'});
await action({action:'advance',order_id:web.order_id,status:'partial'});
await action({action:'advance',order_id:web.order_id,status:'error'});
await action({action:'advance',order_id:web.order_id,status:'processing'});
const shipped=await action({action:'advance',order_id:web.order_id,status:'shipped'});
check(shipped.order.status==='shipped' && shipped.order.tracking_number.startsWith('DEMO-'),'Estados parcial/error/procesando y tracking ficticio completos');
const confirmation=await request('/api/demo/confirmation'+new URL(web.url,origin).search);
check(confirmation.order_number===web.order_number,'Confirmación protegida por token no enumerable');
for(const [i,channel] of ['AMAZON','MIRAVIA','CARREFOUR','EBAY'].entries()) {
  const p=initial.products[15+i];
  const order=await action({action:'simulate-order',channel,slug:p.slug,qty:1,idempotency_key:crypto.randomUUID()});
  const detail=await request(`/api/demo/orders/${order.order_id}`);
  check(detail.order.channel===channel && detail.order.status==='paid',`Pedido ${channel} centralizado y pagado en simulación`);
}
const grouped=await action({action:'dispatch-pending'});
check(grouped.processed>=4 && grouped.errors===0,'Envío agrupado procesa pedidos pendientes');
await action({action:'settings',dispatch_mode:'immediate'});
const immediate=await action({action:'simulate-order',channel:'AMAZON',slug:initial.products[20].slug,qty:1});
const detail=await request(`/api/demo/orders/${immediate.order_id}`);
check(Boolean(detail.order.supplier_order_id),'Modo inmediato envía al proveedor al pagar');
check(detail.marketplace_sync?.supplier_status===detail.order.supplier_status,'Aceptación del proveedor comunicada al marketplace demo');
const marketplaceShipped=await action({action:'advance',order_id:immediate.order_id,status:'shipped'});
check(marketplaceShipped.marketplace_sync?.tracking_number===marketplaceShipped.order.tracking_number && marketplaceShipped.marketplace_sync?.supplier_status==='SUPPLIER_SHIPPED','Tracking vuelve del proveedor al marketplace mediante el hub');
const marketplaceReplay=await action({action:'advance',order_id:immediate.order_id,status:'shipped'});
check(marketplaceReplay.marketplace_sync?.synced_at===marketplaceShipped.marketplace_sync?.synced_at,'Reintentar el mismo tracking conserva el acuse sin duplicarlo');
await action({action:'settings',dispatch_mode:'grouped'});
const probe=initial.products[35];
const targetStock=probe.stock===7?8:7;
await action({action:'simulate-stock',slug:probe.slug,stock:targetStock});
const sync=await action({action:'sync'});
current=await state();
check(sync.updated>=1 && current.products.find(p=>p.slug===probe.slug).stock===targetStock,`Cambio proveedor → tienda: stock ${targetStock}`);
const feed=await fetch(origin+'/feeds/products.xml');
const xml=await feed.text();
check(feed.status===200 && (xml.match(/<item>/g)||[]).length===45 && xml.includes('/tienda/'),'Feed XML: 45 referencias y enlaces de producto válidos');
const json=await request('/api/feeds/products.json');
check((json.products??json).length===45,'Feed JSON accesible');
// Área de cliente: enlace de acceso, sesión con cookie, pedidos y dirección.
const accountEmail=`qa-cuenta-${crypto.randomUUID().slice(0,8)}@example.test`;
const accountProduct=initial.products[40];
const guestOrder=await request('/api/checkout/session',{lines:[{slug:accountProduct.slug,qty:1}],customer:{...customer,email:accountEmail},idempotency_key:crypto.randomUUID()});
const anonymous=await fetch(origin+'/api/cuenta/pedidos',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({action:'cancelar',public_ref:'ord_'+'0'.repeat(32)})});
check(anonymous.status===401,'Las acciones de la cuenta exigen sesión');
const guarded=await fetch(origin+'/cuenta',{redirect:'manual'});
check([301,302,303,307,308].includes(guarded.status) && (guarded.headers.get('location')??'').includes('/cuenta/entrar'),'Mi cuenta sin sesión lleva al acceso');
const access=await request('/api/cuenta/acceso',{email:accountEmail});
check(new URL(access.link).origin===origin && access.email===accountEmail,'Enlace de acceso emitido en el buzón simulado');
const opened=await fetch(access.link,{redirect:'manual'});
const cookie=(opened.headers.get('set-cookie')??'').split(';')[0];
check([301,302,303,307,308].includes(opened.status) && cookie.startsWith('farmahouse_cuenta='),'El enlace abre la sesión y entrega su cookie');
const replay=await fetch(access.link,{redirect:'manual'});
check(replay.status===401,'El mismo enlace no abre una segunda sesión');
async function account(path,body){
  const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{'Content-Type':'application/json',Origin:origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  assert.equal(response.status,200,`${path}: ${JSON.stringify(data)}`);
  return data;
}
const mine=await fetch(origin+'/cuenta/pedidos',{headers:{Cookie:cookie}});
const mineHtml=await mine.text();
check(mine.status===200 && mineHtml.includes(guestOrder.order_number),'La compra hecha como invitado aparece en Mis pedidos');
const saved=await account('/api/cuenta/direcciones',{action:'guardar',idempotency_key:crypto.randomUUID(),recipient_name:'Cliente de prueba (demo)',street:'Calle Guardada 4',postal_code:'12001',city:'Castellón',region:'',phone:''});
check(saved.addresses.length===1 && saved.addresses[0].is_default===true,'Dirección guardada y marcada como preferida');
const prefilled=await (await fetch(origin+'/checkout',{headers:{Cookie:cookie}})).text();
check(prefilled.includes('Calle Guardada 4') && prefilled.includes(accountEmail),'El checkout llega relleno con los datos de la cuenta');
const myData=await account('/api/cuenta/datos.json');
check(myData.orders.some(order=>order.order_number===guestOrder.order_number) && myData.addresses.length===1,'La copia de datos incluye pedidos y direcciones');
const reference=myData.orders.find(order=>order.order_number===guestOrder.order_number).public_ref;
const cancelled=await account('/api/cuenta/pedidos',{action:'cancelar',public_ref:reference});
check(cancelled.status==='cancelled' && cancelled.cancellation.source==='account','El comprador cancela su pedido desde la cuenta');
const panelView=await request(`/api/demo/orders/${guestOrder.order_id}`);
check(panelView.order.status==='cancelled' && panelView.cancellation.source==='account','El panel ve la cancelación con su origen');
await account('/api/cuenta/salir',{everywhere:true});
const afterSignOut=await fetch(origin+'/cuenta/pedidos',{headers:{Cookie:cookie},redirect:'manual'});
check([301,302,303,307,308].includes(afterSignOut.status),'Cerrar sesión revoca la cookie en el servidor');

console.log(`\n${checks} comprobaciones completas. Pedido web: ${web.order_number}.`);
