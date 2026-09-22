import { defineMiddleware } from 'astro:middleware';
import { RateLimiter } from './lib/rate-limit';
import { MAX_DEMO_BODY_BYTES } from './lib/demo-http';
import { d1QuotaCircuit, d1PausedResponse, needsDatabase, outdatedPanelResponse, PANEL_READ_PATHS } from './lib/d1-availability';
import { invalidatePublicCatalog } from './lib/catalog-cache';

const limiter = new RateLimiter();

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  const env = context.locals.runtime.env;
  const pause = d1QuotaCircuit.until(import.meta.env.DEV ? undefined : env.D1_READ_PAUSED_UNTIL);
  if (pause && needsDatabase(path)) return d1PausedResponse(context.request, pause);
  const outdated = outdatedPanelResponse(context.request);
  if (outdated) return outdated;
  const db = d1QuotaCircuit.protect(env.DB);
  context.locals.runtime.env = { ...env, DB: db };
  if (context.request.method === 'GET' && PANEL_READ_PATHS.has(path)) {
    const key = `read:${path}:${context.request.headers.get('cf-connecting-ip') ?? 'local'}`;
    const rule = { limit: 30, windowMs: 60_000 };
    if (!limiter.check(key, rule)) return Response.json({ error: 'Espera un minuto antes de actualizar de nuevo.' }, { status: 429, headers: { 'Retry-After': String(limiter.retryAfterSeconds(key, rule)) } });
  }
  if (context.request.method === 'POST' && path.startsWith('/api/')) {
    const rule = { limit: path.includes('/checkout/') ? 15 : 90, windowMs: 60_000 };
    const key = `${path}:${context.request.headers.get('cf-connecting-ip') ?? 'local'}`;
    if (!limiter.check(key, rule)) {
      return Response.json({ error: 'Has realizado muchas operaciones. Espera un minuto y vuelve a intentarlo.' }, {
        status: 429, headers: { 'retry-after': String(limiter.retryAfterSeconds(key, rule)) },
      });
    }
    if (Number(context.request.headers.get('content-length') ?? 0) > MAX_DEMO_BODY_BYTES) {
      return Response.json({ error: 'La solicitud es demasiado grande.' }, { status: 413 });
    }
  }
  let response: Response;
  try { response = await next(); }
  catch (error) {
    d1QuotaCircuit.observe(error);
    const until = d1QuotaCircuit.until();
    if (until && needsDatabase(path)) return d1PausedResponse(context.request, until);
    throw error;
  } finally {
    // A failed mutation may have committed part of its recovery workflow.
    if (context.request.method !== 'GET' && context.request.method !== 'HEAD' && path.startsWith('/api/')) invalidatePublicCatalog(db);
  }
  const until = d1QuotaCircuit.until();
  if (until && response.status >= 400 && needsDatabase(path)) return d1PausedResponse(context.request, until);
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
