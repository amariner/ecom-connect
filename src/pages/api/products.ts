import type { APIRoute } from 'astro';
import { getPublicProducts } from '../../lib/catalog-cache';
import { demoApi } from '../../lib/demo-http';
export const prerender = false;
export const GET: APIRoute = (context) => demoApi(context,async () => ({products:await getPublicProducts(context.locals.runtime.env.DB)}));
