import type { APIRoute } from 'astro';
import { getSupplierStockSnapshot } from '../../../lib/demo';
import { demoApi } from '../../../lib/demo-http';

export const prerender = false;
export const GET: APIRoute = (context) => demoApi(context,async () => ({
  demo:true,
  snapshot:await getSupplierStockSnapshot(context.locals.runtime.env.DB,context.url.searchParams.get('code')),
}));
