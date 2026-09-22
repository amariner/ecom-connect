import type { APIRoute } from 'astro';
import { z } from 'zod';
import { demoApi,readJson } from '../../../lib/demo-http';
import { saveSyncPolicy } from '../../../lib/sync-policy';
import { hubSyncState,runHubSync } from '../../../lib/hub-sync';
import { processPendingOrders } from '../../../lib/demo';
export const prerender=false;
export const GET:APIRoute=context=>demoApi(context,()=>hubSyncState(context.locals.runtime.env.DB));
export const POST:APIRoute=context=>demoApi(context,async()=>{
 const raw=await readJson(context.request);const action=z.object({action:z.enum(['save','supplier','marketplaces'])}).parse(raw).action;
 const db=context.locals.runtime.env.DB;
 if(action==='save')return saveSyncPolicy(db,raw);
 if(action==='marketplaces')return runHubSync(db,context.url.origin);
 const input=z.object({limit:z.number().int().min(1).max(500),all:z.boolean()}).parse(raw);
 return processPendingOrders(db,input);
},true);
