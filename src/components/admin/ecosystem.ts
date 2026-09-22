type NetworkState = {
  products: {active: boolean | number}[];
  order_summary: {total: number; pending_supplier: number};
  integrations: {supplier: {last_sync?: string | null}; lighthouse: {orders_synced: number; published?: number}};
  marketplaces: {channel: string; orders_count: number; published: number}[];
};
const number = (n: number) => new Intl.NumberFormat('es-ES').format(n);
const symbols: Record<string, string> = {AMAZON:'a',MIRAVIA:'M',CARREFOUR:'C',EBAY:'e'};
const names: Record<string, string> = {AMAZON:'Amazon',MIRAVIA:'Miravia',CARREFOUR:'Carrefour',EBAY:'eBay'};
const time = (date: Date) => date.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
const link = (forward: string, reverse: string) => `<div class="network-link" aria-label="${forward}; retorno: ${reverse}"><span>${forward}</span><i class="network-track"><b></b></i><i class="network-track network-return"><b></b></i><span>${reverse}</span></div>`;
export function ecosystem(state: NetworkState) {
  const active = state.products.filter(p=>p.active).length;
  return `<section class="admin-card network-diagram" aria-labelledby="network-title">
    <div class="network-heading"><div><span class="section-kicker">TU COMERCIO, EN CONEXIÓN</span><h2 id="network-title">Todo fluye desde FarmaHouse.</h2><p>Del catálogo al pedido. Del proveedor a la entrega.</p></div><div class="network-controls"><span class="network-live" role="status"><i></i><span data-network-status>Esquema actualizado · ${time(new Date())}</span></span><button id="network-motion" type="button" aria-pressed="false">Pausar animación</button></div></div>
    <div class="network-board">
      <a class="network-node network-supplier" href="/admin/integraciones/proveedor"><span class="network-step">01 · ORIGEN</span><span class="network-node-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m12 2 9 5v10l-9 5-9-5V7l9-5ZM3 7l9 5 9-5M12 12v10M7.5 4.5l9 5v5"/></svg></span><h3>Proveedor</h3><p>Catálogo, precios<br>y disponibilidad</p><span class="network-node-tag">Proveedor simulado</span><div class="network-node-foot"><strong data-network-products>${number(active)}</strong><span>referencias en tienda</span></div></a>
      ${link('Catálogo y stock →','← Pedidos de compra')}
      <div class="network-center"><a class="network-core" href="/admin/productos"><span class="network-step">02 · TU CENTRO DE OPERACIONES</span><img src="/images/brand/farmahouse-logo-light.svg" width="311" height="60" alt="FarmaHouse"/><h3>Una sola operación.</h3><p>Catálogo · Reservas · Pedidos</p><div class="network-core-stats"><span><strong data-network-products>${number(active)}</strong>productos</span><span><strong data-network-orders>${number(state.order_summary.total)}</strong>pedidos demo</span></div><span class="network-core-link">Explorar catálogo <b aria-hidden="true">↗</b></span></a><a class="network-store" href="/"><span aria-hidden="true">↕</span><strong>Tienda online</strong><small>Canal directo</small><b aria-hidden="true">↗</b></a></div>
      ${link('Stock y ofertas →','← Pedidos de venta')}
      <a class="network-node network-lighthouse" href="/admin/integraciones/lighthouse"><span class="network-step">03 · DISTRIBUCIÓN</span><span class="network-node-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 21h8l-1-13H9L8 21ZM7 8h10M9 4h6v4H9V4ZM12 1v3M3 5l3 1M18 6l3-1M4 11l2-1M18 10l2 1M10 15h4"/></svg></span><h3>Lighthouse</h3><p>Tu enlace con<br>los marketplaces</p><span class="network-node-tag">Hub simulado</span><div class="network-node-foot"><strong data-network-acks>${number(state.integrations.lighthouse.orders_synced)}</strong><span>pedidos con acuse demo</span></div></a>
      ${link('Publicación →','← Ventas')}
      <div class="network-channels"><span class="network-step">04 · TUS CANALES</span>${state.marketplaces.map(m=>`<a href="/admin/marketplaces" class="network-channel"><span class="network-channel-icon ${m.channel.toLowerCase()}">${symbols[m.channel]||'•'}</span><span><strong>${names[m.channel]||'Canal'}</strong><small><b data-channel-orders="${m.channel}">${number(m.orders_count)}</b> pedidos demo</small></span><i aria-hidden="true"></i></a>`).join('')}</div>
    </div>
    <div class="network-footer"><div class="network-legend"><span><i></i>Catálogo y disponibilidad</span><span><i></i>Pedidos y seguimiento</span></div><p>Flujo animado de demostración · El panel consulta datos de la demo cada 15 s.</p><a href="/admin/integraciones/lighthouse">Ver integraciones ↗</a></div>
  </section>`;
}
let stop: (()=>void) | undefined;
export function connectNetwork(load: (signal: AbortSignal)=>Promise<NetworkState>, canRefresh: ()=>boolean) {
  stop?.();
  const root=document.querySelector<HTMLElement>('.network-diagram');
  if(!root)return;
  const controller=new AbortController();
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const button=root.querySelector<HTMLButtonElement>('#network-motion')!;
  let paused=reduced.matches, timer:ReturnType<typeof setTimeout>;
  const setMotion=()=>{root.classList.toggle('network-paused',paused||document.hidden||root.classList.contains('network-offline'));button.setAttribute('aria-pressed',String(paused));button.textContent=paused?'Activar animación':'Pausar animación';};
  button.addEventListener('click',()=>{paused=!paused;setMotion();},{signal:controller.signal});
  reduced.addEventListener('change',()=>{paused=reduced.matches;setMotion();},{signal:controller.signal});
  document.addEventListener('visibilitychange',setMotion,{signal:controller.signal});
  setMotion();
  const update=async()=>{
    try{
      if(!document.hidden&&canRefresh()){
        const state=await load(controller.signal);
        if(!root.isConnected||controller.signal.aborted)return;
        const values:Record<string,number>={'data-network-products':state.products.filter(p=>p.active).length,'data-network-orders':state.order_summary.total,'data-network-acks':state.integrations.lighthouse.orders_synced};
        for(const [attribute,value] of Object.entries(values))root.querySelectorAll(`[${attribute}]`).forEach(el=>{el.textContent=number(value);});
        for(const m of state.marketplaces){const el=root.querySelector(`[data-channel-orders="${m.channel}"]`);if(el)el.textContent=number(m.orders_count);}
        root.classList.remove('network-offline');
        root.querySelector('[data-network-status]')!.textContent=`Esquema actualizado · ${time(new Date())}`;
      }
    }catch{
      if(controller.signal.aborted)return;
      root.classList.add('network-offline');root.querySelector('[data-network-status]')!.textContent='Sin conexión · Datos de la última consulta';
    }finally{
      if(!controller.signal.aborted&&root.isConnected){setMotion();timer=setTimeout(update,15000);}
    }
  };
  timer=setTimeout(update,15000);
  stop=()=>{clearTimeout(timer);controller.abort();};
  window.addEventListener('pagehide',()=>stop?.(),{once:true,signal:controller.signal});
}
