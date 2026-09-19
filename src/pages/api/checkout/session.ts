import type { APIRoute } from 'astro';
import { checkoutSchema,completeDemoCheckout } from '../../../lib/demo';
import { demoApi,readJson } from '../../../lib/demo-http';
export const prerender = false;
export const POST: APIRoute = (context) => demoApi(context,async () => completeDemoCheckout(
  context.locals.runtime.env.DB,checkoutSchema.parse(await readJson(context.request)),context.url.origin,
),true);
