import type { APIRoute } from 'astro';
import { checkoutSchema,createDemoOrder,regenerateFeed } from '../../../lib/demo';
import { demoApi,readJson } from '../../../lib/demo-http';
export const prerender = false;
export const POST: APIRoute = (context) => demoApi(context,async () => {
  const order = await createDemoOrder(context.locals.runtime.env.DB,checkoutSchema.parse(await readJson(context.request)));
  await regenerateFeed(context.locals.runtime.env.DB,context.url.origin);
  return order;
},true);
