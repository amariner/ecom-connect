import type { APIRoute } from 'astro';
import { performAction } from '../../../lib/demo';
import { demoApi,readJson } from '../../../lib/demo-http';
export const prerender = false;
export const POST: APIRoute = (context) => demoApi(context,async () => performAction(context.locals.runtime.env.DB,await readJson(context.request),context.url.origin),true);
