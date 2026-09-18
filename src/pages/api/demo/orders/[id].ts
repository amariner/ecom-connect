import type { APIRoute } from 'astro';
import { getOrderDetail } from '../../../../lib/demo';
import { demoApi } from '../../../../lib/demo-http';
export const prerender = false;
export const GET: APIRoute = (context) => demoApi(context,() => getOrderDetail(context.locals.runtime.env.DB,Number(context.params.id)));
