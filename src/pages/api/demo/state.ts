import type { APIRoute } from 'astro';
import { getState } from '../../../lib/demo';
import { demoApi } from '../../../lib/demo-http';
export const prerender = false;
export const GET: APIRoute = (context) => demoApi(context,() => getState(context.locals.runtime.env.DB,context.url.origin,context.locals.runtime.env.GROUPED_CRON_ENABLED === 'true'));
