import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import {migratedDatabase,d1Adapter,hookedD1} from './helpers/d1.mjs';
import {saveSyncPolicy,getSyncPolicy,madridClock} from '../src/lib/sync-policy';
import {runSyncScheduler} from '../src/lib/sync-scheduler';
import {runHubSync,hubSyncState} from '../src/lib/hub-sync';
import {channelAnalytics} from '../src/lib/channel-analytics';
import {createDemoOrder,completeDemoCheckout,dispatchOrder,syncSupplier,regenerateFeed,processPendingOrders} from '../src/lib/demo';
import {POST} from '../src/pages/api/demo/sync-control';
let sqlite,db;
const origin='https://demo.test';
const customer={name:'Cliente Ficticio',email:'demo@example.test',street:'Calle de Prueba 1',city:'Castellón',postal_code:'12001'};
const policy=()=>({supplier:{enabled:false,immediate:false,limit:2,all:false,packing:'order',include_customer:false,schedules:[]},marketplaces:{automatic:false,interval_minutes:15}});
const input=(both=false)=>({lines:both?[{slug:'alpha',qty:1},{slug:'beta',qty:2}]:[{slug:'alpha',qty:1}],customer,idempotency_key:crypto.randomUUID()});
const save=async p=>saveSyncPolicy(db,{policy:p,revision:(await getSyncPolicy(db)).revision});
const pending=()=>sqlite.prepare("SELECT count(*) n FROM orders WHERE status='paid' AND supplier_stock_committed=0").get().n;
beforeEach(async()=>{
 sqlite=migratedDatabase();db=d1Adapter(sqlite);
 sqlite.exec(`INSERT INTO supplier_products(code,slug,name,description,price_cents,brand,category,image,ean,sku,stock) VALUES
 ('S-A','alpha','Alfa','Demo',1000,'Demo','facial','/demo.png','2000000000008','SKU-A',500),
 ('S-B','beta','Beta','Demo',1500,'Demo','facial','/demo.png','2000000000009','SKU-B',500);
 INSERT INTO shipping_rates(zone,label,price_cents,free_over_cents) VALUES ('peninsula','Demo',490,4900);`);
 await syncSupplier(db);
});
afterEach(()=>sqlite.close());
describe('sync configuration and delivery contracts',()=>{
 it('validates schedules, saves atomically and rejects stale edits without changing legacy controls',async()=>{
  const p=policy();p.supplier.enabled=true;
  await expect(save(p)).rejects.toThrow();
  p.supplier.schedules=[{id:'morning',time:'09:00',limit:1,all:false}];
  const first=await save(p);expect(first.revision).toBe(1);
  expect((await saveSyncPolicy(db,{policy:p,revision:0})).revision).toBe(1);
  const changed=policy();changed.supplier.enabled=true;changed.supplier.immediate=true;
  await save(changed);
  await expect(saveSyncPolicy(db,{policy:p,revision:1})).rejects.toThrow(/otra ventana/);
  expect(sqlite.prepare("SELECT value FROM integration_settings WHERE key='dispatch_mode'").get().value).toBe('immediate');
  p.supplier.schedules.push({id:'duplicate',time:'09:00',limit:2,all:true});await expect(save(p)).rejects.toThrow();
  p.supplier.schedules=[{id:'bad',time:'25:00',limit:1,all:false}];await expect(save(p)).rejects.toThrow();
 });
 it('sends immediately only with automation enabled and emits one message per product without customer fields',async()=>{
  const p=policy();p.supplier.enabled=true;p.supplier.immediate=true;p.supplier.packing='product';await save(p);
  const order=await createDemoOrder(db,input(true));expect(pending()).toBe(0);
  const messages=sqlite.prepare('SELECT * FROM supplier_order_messages ORDER BY sequence').all();expect(messages).toHaveLength(2);
  expect(messages.every(m=>JSON.parse(m.payload_json).items.length===1&&!Object.hasOwn(JSON.parse(m.payload_json),'customer'))).toBe(true);
  const stocks=sqlite.prepare('SELECT stock FROM supplier_products ORDER BY code').all();expect(stocks.map(s=>s.stock)).toEqual([499,498]);
  await dispatchOrder(db,order.order_id);expect(sqlite.prepare('SELECT count(*) n FROM supplier_order_messages').get().n).toBe(2);
  p.supplier.enabled=false;await save(p);await createDemoOrder(db,input());expect(pending()).toBe(1);
 });
 it('freezes packaging and data consent on the first attempt even when acceptance is retried',async()=>{
  const p=policy();p.supplier.packing='product';p.supplier.include_customer=true;await save(p);
  const order=await createDemoOrder(db,input(true));sqlite.exec("UPDATE supplier_products SET stock=0 WHERE code='S-A'");
  await expect(dispatchOrder(db,order.order_id)).rejects.toThrow();
  await save(policy());sqlite.exec("UPDATE supplier_products SET stock=500 WHERE code='S-A'");
  await dispatchOrder(db,order.order_id);
  const messages=sqlite.prepare('SELECT packing,payload_json FROM supplier_order_messages').all();expect(messages).toHaveLength(2);
  expect(messages.every(m=>m.packing==='product'&&JSON.parse(m.payload_json).customer.name===customer.name)).toBe(true);
  expect(JSON.parse(messages[0].payload_json).customer).not.toHaveProperty('email');
 });
 it('manual quantities and all operate on the pending set, with no duplicate dispatch',async()=>{
  await save(policy());for(let n=0;n<34;n++)await createDemoOrder(db,input());
  expect(await processPendingOrders(db,{limit:2})).toMatchObject({processed:2,remaining:32});
  expect(await processPendingOrders(db,{limit:1,all:true})).toMatchObject({processed:32,remaining:0});
  expect(await processPendingOrders(db,{all:true})).toMatchObject({processed:0,remaining:0});
 });
});
describe('clock scheduler and marketplace synchronization',()=>{
 it('uses Madrid local time, executes each slot once under concurrency and respects different quantities',async()=>{
  const p=policy();p.supplier.enabled=true;p.supplier.schedules=[{id:'one',time:'10:00',limit:1,all:false},{id:'all',time:'12:00',limit:1,all:true}];await save(p);
  for(let n=0;n<3;n++)await createDemoOrder(db,input());
  expect(madridClock(new Date('2026-09-22T08:00:00Z')).time).toBe('10:00');
  expect(madridClock(new Date('2026-12-22T08:00:00Z')).time).toBe('09:00');
  await runSyncScheduler(db,origin,new Date('2026-09-22T07:59:00Z'));expect(pending()).toBe(3);
  await Promise.all([runSyncScheduler(db,origin,new Date('2026-09-22T08:00:00Z')),runSyncScheduler(db,origin,new Date('2026-09-22T08:00:30Z'))]);expect(pending()).toBe(2);
  await runSyncScheduler(db,origin,new Date('2026-09-22T10:00:00Z'));expect(pending()).toBe(0);
  expect(sqlite.prepare('SELECT count(*) n FROM automation_slots').get().n).toBe(2);
  p.supplier.enabled=false;await save(p);await createDemoOrder(db,input());
  await runSyncScheduler(db,origin,new Date('2026-09-23T08:00:00Z'));expect(pending()).toBe(1);
 });
 it('manual mode leaves stock and order acknowledgements pending until a hub sync; all contract steps are visible',async()=>{
  await save(policy());await regenerateFeed(db,origin);
  const order=await completeDemoCheckout(db,input(),origin,'AMAZON');
  expect(sqlite.prepare('SELECT count(*) n FROM marketplace_order_updates').get().n).toBe(0);
  const before=await hubSyncState(db);expect(before.catalog.find(c=>c.channel==='AMAZON').pending).toBe(1);
  await runHubSync(db,origin);
  expect(sqlite.prepare('SELECT order_id FROM marketplace_order_updates').get().order_id).toBe(order.order_id);
  const after=await hubSyncState(db);expect(after.catalog.every(c=>c.pending===0)).toBe(true);
  expect(after.steps.map(s=>s.resource).sort()).toEqual(['Carriers','CmsSales','Products/ExtraInfo','Sales','UpdateCmsSales'].sort());
  expect(after.runs[0].status).toBe('completed');
 });
 it('periodic marketplace sync is deduplicated and stops when manual mode is selected',async()=>{
  const p=policy();p.marketplaces.automatic=true;await save(p);
  await Promise.all([runSyncScheduler(db,origin,new Date('2026-09-22T08:00:00Z')),runSyncScheduler(db,origin,new Date('2026-09-22T08:00:00Z'))]);
  expect(sqlite.prepare('SELECT count(*) n FROM hub_sync_runs').get().n).toBe(1);
  await runSyncScheduler(db,origin,new Date('2026-09-22T08:15:00Z'));expect(sqlite.prepare('SELECT count(*) n FROM hub_sync_runs').get().n).toBe(2);
  p.marketplaces.automatic=false;await save(p);await runSyncScheduler(db,origin,new Date('2026-09-22T08:30:00Z'));expect(sqlite.prepare('SELECT count(*) n FROM hub_sync_runs').get().n).toBe(2);
 });
 it('records a failed step and safely retries without purchasing or changing stock twice',async()=>{
  await save(policy());await createDemoOrder(db,input(),'AMAZON');
  const hooked=hookedD1(sqlite);hooked.on(/INSERT INTO marketplace_order_updates/,()=>{throw new Error('Hub unavailable');});
  await expect(runHubSync(hooked.db,origin)).rejects.toThrow();
  expect((await hubSyncState(db)).runs[0].status).toBe('failed');
  expect((await hubSyncState(db)).steps.find(s=>s.resource==='UpdateCmsSales').status).toBe('failed');
  await runHubSync(db,origin);expect((await hubSyncState(db)).runs[0].status).toBe('completed');
  expect(sqlite.prepare('SELECT count(*) n FROM orders').get().n).toBe(1);
  expect(sqlite.prepare("SELECT stock FROM products WHERE slug='alpha'").get().stock).toBe(499);
 });
 it('separates source totals and recent lists independently',async()=>{
  await save(policy());await createDemoOrder(db,input(),'WEB');await createDemoOrder(db,input(),'AMAZON');await createDemoOrder(db,input(),'MIRAVIA');
  const stats=await channelAnalytics(db);expect(stats.totals.find(s=>s.channel==='WEB').orders).toBe(1);expect(stats.totals.filter(s=>s.channel!=='WEB').reduce((n,s)=>n+s.orders,0)).toBe(2);
  expect(stats.recent.filter(s=>s.channel==='WEB')).toHaveLength(1);expect(stats.days.reduce((n,d)=>n+d.web+d.marketplaces,0)).toBe(3);
 });
 it('keeps seven distinct local calendar days across the spring DST change',async()=>{
  const stats=await channelAnalytics(db,new Date('2026-03-29T22:30:00Z'));
  expect(stats.days.map(d=>d.date)).toEqual(['2026-03-24','2026-03-25','2026-03-26','2026-03-27','2026-03-28','2026-03-29','2026-03-30']);
 });
 it('does not dispatch twice in the repeated autumn hour',async()=>{
  const p=policy();p.supplier.enabled=true;p.supplier.schedules=[{id:'autumn',time:'02:30',limit:1,all:false}];await save(p);
  await createDemoOrder(db,input());await createDemoOrder(db,input());
  await runSyncScheduler(db,origin,new Date('2026-10-25T00:30:00Z'));expect(pending()).toBe(1);
  await runSyncScheduler(db,origin,new Date('2026-10-25T01:30:00Z'));expect(pending()).toBe(1);
 });
 it('requires demo flags, same origin and valid run quantities at the HTTP boundary',async()=>{
  const context=(body,originHeader=origin,enabled=true)=>({url:new URL(origin+'/api/demo/sync-control'),request:new Request(origin+'/api/demo/sync-control',{method:'POST',headers:{origin:originHeader,'content-type':'application/json'},body:JSON.stringify(body)}),locals:{runtime:{env:{DB:db,DEMO_MODE:String(enabled),OMNICHANNEL_DEMO:'true'}}}});
  expect((await POST(context({action:'supplier',limit:0,all:false}))).status).toBe(400);
  expect((await POST(context({action:'marketplaces'},'https://other.test'))).status).toBe(403);
  expect((await POST(context({action:'marketplaces'},origin,false))).status).toBe(403);
 });
});
