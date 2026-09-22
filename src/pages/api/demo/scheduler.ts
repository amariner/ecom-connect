import type { APIRoute } from 'astro';
import { demoApi } from '../../../lib/demo-http';
import { runSyncScheduler } from '../../../lib/sync-scheduler';
import { DemoError } from '../../../lib/demo';
export const prerender=false;
export const POST:APIRoute=context=>demoApi(context,async()=>{
 if(!import.meta.env.DEV)throw new DemoError('El ejecutor HTTP solo está disponible en desarrollo.',403);
 return runSyncScheduler(context.locals.runtime.env.DB,context.url.origin,new Date(),'dev');
},true);
