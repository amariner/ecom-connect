import type { APIRoute } from 'astro';
import { assertDemo,feedProducts,renderFeedXml } from '../../lib/demo';
export const prerender=false;
export const GET:APIRoute=async({locals,url,params})=>{
  const scope=params.feed;
  if(scope!=='lighthouse' && scope!=='google' && scope!=='meta')return new Response('Feed no encontrado.',{status:404});
  try {
    assertDemo(locals.runtime.env);
    const title={lighthouse:'Lighthouse',google:'Google Merchant Center',meta:'Meta'}[scope];
    const xml=renderFeedXml(await feedProducts(locals.runtime.env.DB,url.origin,scope),url.origin).replace('FarmaHouse Demo — catálogo ficticio',`FarmaHouse Demo — ${title}`);
    return new Response(xml,{headers:{'content-type':'application/xml; charset=utf-8','cache-control':'no-store','x-robots-tag':'noindex, nofollow'}});
  }catch{return new Response('Feed no disponible.',{status:403});}
};
