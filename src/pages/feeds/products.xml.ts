import type { APIRoute } from 'astro';
import { assertDemo,feedProducts,renderFeedXml } from '../../lib/demo';
export const prerender = false;
export const GET: APIRoute = async ({locals,url}) => {
  try {
    assertDemo(locals.runtime.env);
    return new Response(renderFeedXml(await feedProducts(locals.runtime.env.DB,url.origin),url.origin),{
      headers:{'content-type':'application/xml; charset=utf-8','cache-control':'no-store','x-robots-tag':'noindex, nofollow'},
    });
  } catch { return new Response('Feed no disponible.',{status:403}); }
};
