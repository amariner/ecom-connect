import type { APIRoute } from 'astro';
import { getProducts } from '../../lib/demo';
import { demoApi } from '../../lib/demo-http';
export const prerender = false;
export const GET: APIRoute = (context) => demoApi(context,async () => ({products:await getProducts(context.locals.runtime.env.DB)}));
