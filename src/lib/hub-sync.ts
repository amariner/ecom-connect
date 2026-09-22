import { feedProducts,regenerateFeed,syncMarketplaceOrders } from './demo';
import { getSyncPolicy } from './sync-policy';
import { readSelections,selectionAllows } from './catalog-selection';
export async function runHubSync(db:D1Database,origin:string,source:'manual'|'automatic'|'scheduled'='manual') {
 const now=new Date().toISOString();
 const [,claim]=await db.batch([
  db.prepare("UPDATE hub_sync_runs SET status='failed',finished_at=?,error='Ejecución interrumpida' WHERE status='running' AND started_at<?").bind(now,new Date(Date.now()-600000).toISOString()),
  db.prepare("INSERT INTO hub_sync_runs(source,status,started_at) VALUES (?,'running',?) ON CONFLICT DO NOTHING RETURNING id").bind(source,now),
 ]);
 const id=(claim?.results[0] as {id:number}|undefined)?.id;
 if(!id)return {status:'skipped',reason:'overlap'};
 async function step(resource:string,direction:string,payload:unknown[],execute?:()=>Promise<unknown>) {
  try {if(execute)await execute();await db.prepare("INSERT INTO hub_sync_steps(run_id,resource,direction,processed,status,payload_json) VALUES (?,?,?,?,'completed',?)").bind(id,resource,direction,payload.length,JSON.stringify(payload)).run();}
  catch(error){await db.prepare("INSERT INTO hub_sync_steps(run_id,resource,direction,processed,status,payload_json) VALUES (?,?,?,0,'failed','[]')").bind(id,resource,direction).run();throw error;}
 }
 try {
  const products=await feedProducts(db,origin);
  await step('Products/ExtraInfo','out',products.map(p=>({id:p.sku,stock:p.stock,price:Number(p.price.split(' ')[0])})),()=>regenerateFeed(db,origin));
  const sales=(await db.prepare("SELECT id,order_number,channel,status,supplier_status,tracking_number,tracking_carrier,total_cents FROM orders WHERE channel<>'WEB' ORDER BY id").all<{id:number;order_number:string;channel:string;status:string;supplier_status:string;tracking_number:string|null;tracking_carrier:string|null;total_cents:number}>()).results;
  await step('Sales','in',sales.map(s=>({reference:s.order_number,channel:s.channel,status:s.status})));
  const carriers=(await db.prepare("SELECT DISTINCT tracking_carrier AS name FROM orders WHERE tracking_carrier IS NOT NULL").all<{name:string}>()).results;
  await step('Carriers','out',carriers.map(c=>({cmsCarrierId:c.name,name:c.name})));
  const web=(await db.prepare("SELECT id,order_number,status,supplier_status,total_cents,shipping_cents,created_at,customer_name,email,address_json,tracking_number,tracking_carrier FROM orders WHERE channel='WEB' AND status IN ('paid','shipped','delivered','cancelled')").all<{id:number;order_number:string;status:string;supplier_status:string;total_cents:number;shipping_cents:number;created_at:string;customer_name:string;email:string;address_json:string;tracking_number:string|null;tracking_carrier:string|null}>()).results;
  const lines=(await db.prepare("SELECT oi.order_id,p.sku,oi.name_snapshot,COALESCE(oi.current_qty,oi.qty) AS qty,oi.unit_price_cents FROM order_items oi JOIN products p ON p.id=oi.product_id JOIN orders o ON o.id=oi.order_id WHERE o.channel='WEB'").all<{order_id:number;sku:string;name_snapshot:string;qty:number;unit_price_cents:number}>()).results;
  const status=(s:string,supplier:string)=>s==='cancelled'?'Cancelled':s==='delivered'?'Delivered':s==='shipped'?'Sent':supplier==='PENDING_SUPPLIER'?'WaitingAcceptance':'Handling';
  const webPayload=web.map(order=>{
    const address=JSON.parse(order.address_json) as {street?:string;city?:string;postal_code?:string};
    return {cmsOrderID:order.order_number,dateTime:new Date(order.created_at.includes('T')?order.created_at:order.created_at.replace(' ','T')+'Z').toISOString(),
      status:status(order.status,order.supplier_status),total:(order.total_cents-order.shipping_cents)/100,deliveryExpenses:order.shipping_cents/100,
      customerName:order.customer_name,customerEmail:order.email,customerAddress:address.street??'',customerCity:address.city??'',customerZip:address.postal_code??'',customerCountryCode:'ES',
      shippingNumber:order.tracking_number,cmsCarrierID:order.tracking_carrier,
      productSales:lines.filter(l=>l.order_id===order.id).map(l=>({productSKU:l.sku,title:l.name_snapshot,amount:l.qty,price:l.unit_price_cents/100}))};
  });
  await step('CmsSales','out',webPayload,async()=>{if(web.length)await db.batch(web.map((order,index)=>db.prepare(`INSERT INTO hub_web_sales(order_id,payload_json,synced_at) VALUES (?,?,?) ON CONFLICT(order_id) DO UPDATE SET payload_json=excluded.payload_json,synced_at=excluded.synced_at`).bind(order.id,JSON.stringify(webPayload[index]),now)));});
  // IDs belong only to the local mock; they are never claimed to be real Lighthouse IDs.
  await step('UpdateCmsSales','out',sales.map(s=>({lighthouseId:s.id,cmsOrderID:s.order_number,status:status(s.status,s.supplier_status),shippingNumber:s.tracking_number,cmsCarrierID:s.tracking_carrier})),async()=>{
   const result=await syncMarketplaceOrders(db);if(result.errors)throw new Error(`${result.errors} acuses pendientes`);
  });
  await db.prepare("UPDATE hub_sync_runs SET status='completed',finished_at=? WHERE id=?").bind(new Date().toISOString(),id).run();
  return {status:'completed',id};
 }catch(error){await db.prepare("UPDATE hub_sync_runs SET status='failed',finished_at=?,error=? WHERE id=?").bind(new Date().toISOString(),error instanceof Error?error.message:'Error de sincronización',id).run();throw error;}
}
export async function hubSyncState(db:D1Database) {
 const [runs,steps,heartbeat,snapshots,products,selections]=await Promise.all([
  db.prepare('SELECT * FROM hub_sync_runs ORDER BY id DESC LIMIT 5').all<{id:number;source:string;status:string;started_at:string;finished_at:string|null;error:string|null}>(),
  db.prepare('SELECT run_id,resource,direction,processed,status FROM hub_sync_steps WHERE run_id=(SELECT MAX(id) FROM hub_sync_runs)').all<{run_id:number;resource:string;direction:string;processed:number;status:string}>(),
  db.prepare("SELECT value FROM integration_settings WHERE key='scheduler_heartbeat'").first<string>('value'),
  db.prepare('SELECT * FROM marketplace_catalog_snapshots').all<{channel:string;products_json:string;synced_at:string}>(),
  db.prepare('SELECT supplier_sku,sku,stock,price_cents FROM products WHERE active=1').all<{supplier_sku:string;sku:string;stock:number;price_cents:number}>(),readSelections(db),
 ]);
 const pending=snapshots.results.map(snapshot=>{
  const old=new Map<string,{sku:string;stock:number;price:string}>(JSON.parse(snapshot.products_json).map((p:{sku:string;stock:number;price:string})=>[p.sku,p]));
  const current=products.results.filter(p=>selectionAllows(selections,'lighthouse',p.supplier_sku)&&selectionAllows(selections,snapshot.channel,p.supplier_sku));
  const currentSkus=new Set(current.map(p=>p.sku));
  const changed=current.filter(p=>{const previous=old.get(p.sku);return !previous||previous.stock!==p.stock||previous.price!==`${(p.price_cents/100).toFixed(2)} EUR`;}).length+[...old.keys()].filter(sku=>!currentSkus.has(sku)).length;
  return {channel:snapshot.channel,pending:changed,last_sync:snapshot.synced_at};
 });
 return {runs:runs.results,steps:steps.results,heartbeat:heartbeat?JSON.parse(heartbeat) as {at:string;engine:string}:null,catalog:pending,configuration:await getSyncPolicy(db)};
}
export type HubSyncState=Awaited<ReturnType<typeof hubSyncState>>;
