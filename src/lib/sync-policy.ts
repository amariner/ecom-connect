import { z } from 'zod';
import { DemoError } from './demo';
export const scheduleSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9-]{1,60}$/),time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),limit:z.number().int().min(1).max(500),all:z.boolean()});
export const syncPolicySchema=z.object({
 supplier:z.object({enabled:z.boolean(),immediate:z.boolean(),limit:z.number().int().min(1).max(500),all:z.boolean(),packing:z.enum(['order','product']),include_customer:z.boolean(),schedules:z.array(scheduleSchema).max(12)}),
 marketplaces:z.object({automatic:z.boolean(),interval_minutes:z.number().int().min(1).max(1440)}),
}).superRefine((policy,ctx)=>{
 const slots=policy.supplier.schedules;
 if(new Set(slots.map(s=>s.id)).size!==slots.length || new Set(slots.map(s=>s.time)).size!==slots.length)ctx.addIssue({code:'custom',message:'Los horarios no pueden repetirse.',path:['supplier','schedules']});
 if(policy.supplier.enabled&&!policy.supplier.immediate&&!slots.length)ctx.addIssue({code:'custom',message:'Añade un horario o activa el envío inmediato.',path:['supplier','schedules']});
});
export type SyncPolicy=z.infer<typeof syncPolicySchema>;
export type SyncConfiguration={policy:SyncPolicy;revision:number;configured:boolean};
export async function getSyncPolicy(db:D1Database):Promise<SyncConfiguration> {
 const row=await db.prepare('SELECT value,revision FROM sync_policies WHERE id=1').first<{value:string;revision:number}>();
 if(row)return {policy:syncPolicySchema.parse(JSON.parse(row.value)),revision:row.revision,configured:true};
 const mode=await db.prepare("SELECT value FROM integration_settings WHERE key='dispatch_mode'").first<string>('value');
 return {policy:{supplier:{enabled:mode==='immediate',immediate:mode==='immediate',limit:30,all:false,packing:'order',include_customer:false,schedules:[]},marketplaces:{automatic:true,interval_minutes:15}},revision:0,configured:false};
}
export async function saveSyncPolicy(db:D1Database,raw:unknown) {
 const input=z.object({revision:z.number().int().nonnegative(),policy:syncPolicySchema}).parse(raw);
 const value=JSON.stringify(input.policy),previous=await getSyncPolicy(db);
 if(previous.configured&&JSON.stringify(previous.policy)===value)return previous;
 const token=crypto.randomUUID(),now=new Date().toISOString();
 const gate='EXISTS (SELECT 1 FROM sync_policies WHERE id=1 AND creation_token=?)';
 await db.batch([
  db.prepare(`INSERT INTO sync_policies(id,value,revision,creation_token,updated_at) SELECT 1,?,?,?,? WHERE ?=0
   ON CONFLICT(id) DO UPDATE SET value=excluded.value,revision=sync_policies.revision+1,creation_token=excluded.creation_token,updated_at=excluded.updated_at WHERE sync_policies.revision=?`)
   .bind(value,input.revision+1,token,now,input.revision,input.revision),
  // The UPDATE also handles existing policies whose expected revision is above zero.
  db.prepare('UPDATE sync_policies SET value=?,revision=revision+1,creation_token=?,updated_at=? WHERE id=1 AND revision=? AND creation_token<>?')
   .bind(value,token,now,input.revision,token),
  ...[['dispatch_mode',input.policy.supplier.enabled&&input.policy.supplier.immediate?'immediate':'grouped'],['dispatch_paused',String(!input.policy.supplier.enabled)]].map(([key,val])=>
   db.prepare(`INSERT INTO integration_settings(key,value) SELECT ?,? WHERE ${gate} ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(key,val,token)),
  db.prepare(`INSERT INTO integration_events(kind,title,detail) SELECT 'settings','Configuración de sincronización actualizada','Proveedor y marketplaces · solo demostración' WHERE ${gate}`).bind(token),
 ]);
 const saved=await getSyncPolicy(db);
 if(JSON.stringify(saved.policy)!==value)throw new DemoError('La configuración ha cambiado en otra ventana. Recarga antes de guardar.',409);
 return saved;
}
export async function marketplaceAutomatic(db:D1Database){return (await getSyncPolicy(db)).policy.marketplaces.automatic;}
export function madridClock(now:Date) {
 const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const get=(type:string)=>parts.find(p=>p.type===type)!.value;
 return {date:`${get('year')}-${get('month')}-${get('day')}`,time:`${get('hour')}:${get('minute')}`};
}
