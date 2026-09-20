import type { APIRoute } from 'astro';
import { clearSessionCookie, forgetAccountData, requireAccountSession, updateAccountConsent, updateAccountProfile } from '../../../lib/account';
import { demoApi, readJson } from '../../../lib/demo-http';
import { DemoError } from '../../../lib/demo';
export const prerender = false;
export const POST: APIRoute = (context) => demoApi(context,async () => {
  const db = context.locals.runtime.env.DB;
  const session = await requireAccountSession(db,context.cookies);
  const body = await readJson(context.request) as { action?: unknown };
  if (body?.action === 'consentimiento') return updateAccountConsent(db,session,body);
  if (body?.action === 'olvidar') {
    const result = await forgetAccountData(db,session);
    // La sesión ya está revocada: la cookie deja de valer en este navegador.
    clearSessionCookie(context.cookies,context.url.protocol === 'https:');
    return result;
  }
  if (body?.action === 'datos') return updateAccountProfile(db,session,body);
  throw new DemoError('Indica qué quieres actualizar de tu cuenta.',400);
},true);
