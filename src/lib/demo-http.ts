import type { APIContext } from 'astro';
import { z } from 'zod';
import { assertDemo, assertSameOrigin, DemoError } from './demo';
export async function demoApi(context: APIContext, handler: () => Promise<unknown>, mutation = false): Promise<Response> {
  try {
    assertDemo(context.locals.runtime.env);
    if (mutation) {
      assertSameOrigin(context.request);
    }
    return Response.json(await handler(),{headers:{'cache-control':'no-store','x-robots-tag':'noindex, nofollow'}});
  } catch (error) {
    const status = error instanceof DemoError ? error.status : error instanceof z.ZodError ? 400 : 500;
    const message = error instanceof DemoError ? error.message : error instanceof z.ZodError ? 'Datos no válidos. Revisa el formulario.' : 'No se pudo completar la operación demo.';
    if (status === 500) console.error('demo-api',error);
    return Response.json({error:message},{status,headers:{'cache-control':'no-store'}});
  }
}
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new DemoError('Envía datos JSON.',415);
  const text = await request.text();
  if (text.length > 64_000) throw new DemoError('La petición es demasiado grande.',413);
  try { return JSON.parse(text) as unknown; } catch { throw new DemoError('JSON no válido.'); }
}
