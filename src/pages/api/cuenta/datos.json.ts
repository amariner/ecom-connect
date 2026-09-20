import type { APIRoute } from 'astro';
import { exportAccountData, readAccountSession } from '../../../lib/account';
import { assertDemo } from '../../../lib/demo';

export const prerender = false;
/** Descarga de la copia de datos. Es una lectura del propio dueño, sin efectos. */
export const GET: APIRoute = async (context) => {
  try {
    assertDemo(context.locals.runtime.env);
    const db = context.locals.runtime.env.DB;
    const session = await readAccountSession(db,context.cookies);
    if (!session) return Response.json({ error:'Entra en tu cuenta para descargar tus datos.' },{ status:401 });
    const data = await exportAccountData(db,session);
    return new Response(JSON.stringify(data,null,2),{ headers:{
      'content-type':'application/json; charset=utf-8',
      'content-disposition':'attachment; filename="mis-datos-farmahouse-demo.json"',
      'cache-control':'no-store','x-robots-tag':'noindex, nofollow',
    } });
  } catch {
    return Response.json({ error:'No se pudo preparar la copia de tus datos.' },{ status:500 });
  }
};
