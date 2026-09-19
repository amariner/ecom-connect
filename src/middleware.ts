import { defineMiddleware } from 'astro:middleware';
import { RateLimiter } from './lib/rate-limit';
import { MAX_DEMO_BODY_BYTES } from './lib/demo-http';

const limiter = new RateLimiter();

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
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
  const response = await next();
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
