import type { APIRoute } from 'astro';
import { getConfirmation } from '../../../lib/demo';
import { demoApi } from '../../../lib/demo-http';
export const prerender = false;
export const GET: APIRoute = (context) => demoApi(context,() => getConfirmation(context.locals.runtime.env.DB,context.url.searchParams.get('session') ?? ''));
