import type { APIRoute } from 'astro';
import { z } from 'zod';
import { clearSessionCookie, closeAccountSession, closeEveryAccountSession, requireAccountSession } from '../../../lib/account';
import { demoApi, readJson } from '../../../lib/demo-http';
export const prerender = false;
const schema = z.object({ everywhere: z.boolean().default(false) });
export const POST: APIRoute = (context) => demoApi(context,async () => {
  const db = context.locals.runtime.env.DB;
  const session = await requireAccountSession(db,context.cookies);
  const { everywhere } = schema.parse(await readJson(context.request));
  const closed = everywhere ? await closeEveryAccountSession(db,session) : (await closeAccountSession(db,session),1);
  clearSessionCookie(context.cookies,context.url.protocol === 'https:');
  return { closed };
},true);
