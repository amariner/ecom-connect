import type { APIRoute } from 'astro';
import { requestAccessLink } from '../../../lib/account';
import { demoApi, readJson } from '../../../lib/demo-http';
export const prerender = false;
export const POST: APIRoute = (context) => demoApi(context,async () =>
  requestAccessLink(context.locals.runtime.env.DB,await readJson(context.request),context.url.origin),true);
