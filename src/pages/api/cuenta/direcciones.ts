import type { APIRoute } from 'astro';
import { archiveAccountAddress, chooseAccountAddress, requireAccountSession, saveAccountAddress } from '../../../lib/account';
import { demoApi, readJson } from '../../../lib/demo-http';
import { DemoError } from '../../../lib/demo';
export const prerender = false;
export const POST: APIRoute = (context) => demoApi(context,async () => {
  const db = context.locals.runtime.env.DB;
  const session = await requireAccountSession(db,context.cookies);
  const body = await readJson(context.request) as { action?: unknown };
  if (body?.action === 'guardar') return saveAccountAddress(db,session,body);
  if (body?.action === 'archivar') return archiveAccountAddress(db,session,body);
  if (body?.action === 'preferida') return chooseAccountAddress(db,session,body);
  throw new DemoError('Indica qué quieres hacer con la dirección.',400);
},true);
