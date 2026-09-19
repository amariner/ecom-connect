import type { APIRoute } from 'astro';
import { getOrderList } from '../../../../lib/demo';
import { demoApi } from '../../../../lib/demo-http';

export const prerender = false;
export const GET: APIRoute = (context) => demoApi(context,() =>
  getOrderList(context.locals.runtime.env.DB,context.url.searchParams));
