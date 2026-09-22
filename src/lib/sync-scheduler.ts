import { processPendingOrders } from './demo';
import { getSyncPolicy,madridClock } from './sync-policy';
import { runHubSync } from './hub-sync';
export async function runSyncScheduler(db:D1Database,origin:string,now=new Date(),engine='cron') {
 await db.prepare("INSERT INTO integration_settings(key,value) VALUES ('scheduler_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({at:now.toISOString(),engine})).run();
 const {policy}=await getSyncPolicy(db);
 const clock=madridClock(now);let executed=0;
 async function once(key:string,action:()=>Promise<{status?:string;[key:string]:unknown}>) {
  const claim=await db.prepare("INSERT INTO automation_slots(slot_key,started_at,status) VALUES (?,?,'running') ON CONFLICT DO NOTHING").bind(key,now.toISOString()).run();
  if(!claim.meta.changes)return;
  try{
   const result=await action();
   if(result.status==='skipped'){await db.prepare('DELETE FROM automation_slots WHERE slot_key=?').bind(key).run();return;}
   await db.prepare("UPDATE automation_slots SET status='completed',finished_at=?,result_json=? WHERE slot_key=?").bind(new Date().toISOString(),JSON.stringify(result),key).run();executed++;
  }catch(error){await db.prepare("UPDATE automation_slots SET status='failed',finished_at=?,error=? WHERE slot_key=?").bind(new Date().toISOString(),error instanceof Error?error.message:'Error de sincronización',key).run();}
 }
 const paused=await db.prepare("SELECT value FROM integration_settings WHERE key='dispatch_paused'").first<string>('value');
 if(policy.supplier.enabled&&!policy.supplier.immediate&&paused!=='true')for(const slot of policy.supplier.schedules)if(slot.time===clock.time){
  await once(`supplier:${clock.date}:${slot.id}:${slot.time}`,()=>processPendingOrders(db,{source:'scheduled',limit:slot.limit,all:slot.all}));
 }
 if(policy.marketplaces.automatic) {
  const bucket=Math.floor(now.getTime()/(policy.marketplaces.interval_minutes*60000));
  await once(`marketplaces:${policy.marketplaces.interval_minutes}:${bucket}`,()=>runHubSync(db,origin,'scheduled'));
 }
 await db.prepare("DELETE FROM automation_slots WHERE status<>'running' AND started_at<?").bind(new Date(now.getTime()-35*86400000).toISOString()).run();
 return {executed};
}
