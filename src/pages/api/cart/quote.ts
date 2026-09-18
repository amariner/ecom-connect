import type { APIRoute } from 'astro';
import { quoteCart,quoteRequestSchema } from '../../../lib/quote';
import { demoApi,readJson } from '../../../lib/demo-http';
export const prerender = false;
export const POST: APIRoute = (context) => demoApi(context,async () => quoteCart(context.locals.runtime.env.DB,
  quoteRequestSchema.parse(await readJson(context.request)),{catalogReadMode:'legacy'}),true);
