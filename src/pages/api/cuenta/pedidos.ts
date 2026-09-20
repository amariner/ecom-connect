import type { APIRoute } from 'astro';
import { cancelAccountOrder, requireAccountSession } from '../../../lib/account';
import { demoApi, readJson } from '../../../lib/demo-http';
import { DemoError } from '../../../lib/demo';
export const prerender = false;
export const POST: APIRoute = (context) => demoApi(context,async () => {
  const db = context.locals.runtime.env.DB;
  const session = await requireAccountSession(db,context.cookies);
  const body = await readJson(context.request) as { action?: unknown };
  if (body?.action === 'cancelar') return cancelAccountOrder(db,session,body);
  throw new DemoError('Indica qué quieres hacer con el pedido.',400);
},true);
