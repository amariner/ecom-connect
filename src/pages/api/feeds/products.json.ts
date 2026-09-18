import type { APIRoute } from 'astro';
import { feedProducts } from '../../../lib/demo';
import { demoApi } from '../../../lib/demo-http';
export const prerender = false;
export const GET: APIRoute = (context) => demoApi(context,async () => ({demo:true,products:await feedProducts(context.locals.runtime.env.DB,context.url.origin)}));
