import type { APIRoute } from 'astro';
export const prerender=false;
// Deliberately inert in every environment. A stale dev process must not touch D1.
export const POST:APIRoute=()=>Response.json({error:'El programador está desactivado en esta demo. Usa las acciones manuales.',code:'SCHEDULER_DISABLED'},{status:403,headers:{'Cache-Control':'no-store'}});
