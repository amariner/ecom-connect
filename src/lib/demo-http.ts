import type { APIContext } from 'astro';
import { z } from 'zod';
import { assertDemo, assertSameOrigin, DemoError } from './demo';
export const MAX_DEMO_BODY_BYTES = 64_000;
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
    return Response.json({error:message,...(error instanceof DemoError ? error.details : {})},
      {status,headers:{'cache-control':'no-store'}});
  }
}
export async function readJson(request: Request): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new DemoError('Envía datos JSON.',415);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_DEMO_BODY_BYTES) {
    throw new DemoError('La petición es demasiado grande.',413);
  }
  if (!request.body) throw new DemoError('JSON no válido.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_DEMO_BODY_BYTES) {
        await reader.cancel();
        throw new DemoError('La petición es demasiado grande.',413);
      }
      text += decoder.decode(chunk.value,{stream:true});
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text) as unknown; } catch { throw new DemoError('JSON no válido.'); }
}
