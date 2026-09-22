import type { APIRoute } from 'astro';
import { selectionCatalog,saveSelection } from '../../../lib/catalog-selection';
import { demoApi,readJson } from '../../../lib/demo-http';
export const prerender=false;
export const GET:APIRoute=context=>demoApi(context,()=>selectionCatalog(context.locals.runtime.env.DB));
export const POST:APIRoute=context=>demoApi(context,async()=>saveSelection(context.locals.runtime.env.DB,await readJson(context.request)),true);
