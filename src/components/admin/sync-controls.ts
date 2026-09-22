import type { SyncConfiguration,SyncPolicy } from '../../lib/sync-policy';
import type { HubSyncState } from '../../lib/hub-sync';
import '../../styles/sync-controls.css';
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const date=(value?:string|null)=>value?new Date(value.includes('T')?value:value.replace(' ','T')+'Z').toLocaleString('es-ES',{timeZone:'Europe/Madrid',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'Sin sincronizar';
const titles:Record<string,string>={'Products/ExtraInfo':'Catálogo, stock y precios',Sales:'Consulta de pedidos de marketplaces',Carriers:'Transportistas',CmsSales:'Ventas de la web',UpdateCmsSales:'Estados, cancelaciones y seguimiento'};
const scheduleRow=(slot:SyncPolicy['supplier']['schedules'][number])=>`<div class="sync-time-row" data-slot="${esc(slot.id)}"><label>Hora (Madrid)<input type="time" data-slot-field="time" value="${slot.time}" required/></label><label>N.º de pedidos<input type="number" data-slot-field="limit" min="1" max="500" step="1" value="${slot.limit}" required/></label><label class="sync-check"><input type="checkbox" data-slot-field="all" ${slot.all?'checked':''}/>Todos los pendientes</label><button type="button" class="sync-remove" data-sync-command="remove-slot" aria-label="Eliminar horario de las ${slot.time}">×</button></div>`;
export function supplierSyncControls(configuration:SyncConfiguration) {
 const p=configuration.policy.supplier;
 return `<section class="admin-card sync-card" id="supplier-sync" data-sync-control="supplier"><div class="card-heading"><div><span class="section-kicker">OPERATIVA DE PEDIDOS</span><h2>Sincronización con el proveedor</h2></div><span class="sync-mode-badge">${p.enabled?'Automática':'Manual'}</span></div><form class="sync-config-form" data-sync-form="supplier"><div class="sync-master"><span><strong>Sincronización automática de pedidos</strong><small>Activa el envío inmediato o configura tus horarios.</small></span><label class="sync-switch"><input name="enabled" type="checkbox" role="switch" aria-label="Sincronización automática de pedidos al proveedor" ${p.enabled?'checked':''}/><span></span></label></div>
 <label class="sync-check sync-immediate"><input name="immediate" type="checkbox" ${p.immediate?'checked':''}/><span><strong>Enviar inmediatamente cada vez que entre un pedido</strong><small>Al confirmar el pago simulado, sin esperar al siguiente horario.</small></span></label>
 <div class="sync-config-grid"><label>Pedidos por envío manual<input name="limit" type="number" min="1" max="500" step="1" value="${p.limit}" required/></label><label class="sync-check"><input name="all" type="checkbox" ${p.all?'checked':''}/>Todos los pedidos pendientes</label><label>Cómo enviar los productos<select name="packing"><option value="order" ${p.packing==='order'?'selected':''}>Por pedido / cliente · un lote completo</option><option value="product" ${p.packing==='product'?'selected':''}>Producto a producto · un mensaje por referencia</option></select></label><label>Datos del cliente<select name="include_customer"><option value="false" ${!p.include_customer?'selected':''}>Sin datos del cliente</option><option value="true" ${p.include_customer?'selected':''}>Con datos de entrega del cliente</option></select></label></div>
 <p class="sync-help">Se conserva la referencia de cada pedido. «Sin datos del cliente» prepara un pedido de aprovisionamiento; «Con datos» incluye nombre y dirección de entrega en el mensaje al proveedor simulado. No se envían emails.</p>
 <fieldset class="sync-schedules"><legend>Horarios de sincronización</legend><p class="sync-help">Cada horario tiene su propia cantidad. «Todos» envía los pendientes al comenzar esa ejecución. Hora de Madrid, con cambio de horario estacional.</p><div data-slots>${(p.schedules.length?p.schedules:[{id:'morning',time:'09:00',limit:p.limit,all:p.all}]).map(scheduleRow).join('')}</div><button type="button" class="button button-secondary" data-sync-command="add-slot">＋ Añadir otra hora</button><p class="sync-schedule-mode"></p></fieldset>
 <div class="sync-form-actions"><button class="button button-primary" type="submit">Guardar configuración</button><button class="button button-secondary" type="button" data-sync-command="supplier-now">Sincronizar pendientes ahora</button><span class="sync-dirty" role="status"></span></div><p class="sync-feedback" role="status" aria-live="polite"></p></form><div class="sync-engine" data-engine>Comprobando ejecutor…</div></section>`;
}
export function marketplaceSyncControls(configuration:SyncConfiguration) {
 const p=configuration.policy.marketplaces;
 return `<section class="admin-card sync-card" id="hub-sync" data-sync-control="marketplaces"><div class="card-heading"><div><span class="section-kicker">CATÁLOGO + PEDIDOS + SEGUIMIENTO</span><h2>Sincronización de marketplaces</h2></div><a class="text-link" href="/admin/documentacion/lighthouse">Contrato de Lighthouse ↗</a></div><form class="sync-config-form" data-sync-form="marketplaces"><div class="sync-master"><span><strong>Sincronización automática</strong><small>Actualiza stock al recibir compras y concilia periódicamente pedidos y seguimiento.</small></span><label class="sync-switch"><input type="checkbox" name="automatic" role="switch" aria-label="Sincronización automática de marketplaces" ${p.automatic?'checked':''}/><span></span></label></div><div class="sync-market-toolbar"><label>Conciliar cada<select name="interval_minutes">${[1,5,15,30,60,120,1440].map(n=>`<option value="${n}" ${n===p.interval_minutes?'selected':''}>${n===1440?'24 horas':`${n} minutos`}</option>`).join('')}</select></label><button class="button button-primary" type="submit">Guardar modo ${p.automatic?'automático':'manual'}</button><button type="button" class="button button-secondary" data-sync-command="marketplaces-now">Sincronizar marketplaces ahora</button></div><p class="sync-help">En modo manual, los cambios quedan pendientes hasta ejecutar una sincronización. El feed público refleja el catálogo actual; estas fechas corresponden a la última copia recibida por el hub simulado.</p><span class="sync-dirty" role="status"></span><p class="sync-feedback" role="status" aria-live="polite"></p></form><div class="sync-engine" data-engine>Comprobando ejecutor…</div><div data-hub-status class="sync-hub-status">Cargando historial de sincronización…</div></section>`;
}
async function request<T>(body?:unknown):Promise<T>{
 const response=await fetch('/api/demo/sync-control',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180000)}:{signal:AbortSignal.timeout(25000)});
 const value=await response.json();if(!response.ok)throw new Error(value.error||'No se pudo completar la sincronización.');return value;
}
let stopStatus:(()=>void)|undefined;
export async function mountSyncControls(root:HTMLElement,configuration:SyncConfiguration,onChange:()=>Promise<void>) {
 stopStatus?.();
 const controls=[...root.querySelectorAll<HTMLElement>('[data-sync-control]')];if(!controls.length)return;
 let stopped=false,loading=false;
 const timer=setInterval(()=>{if(!stopped&&!loading&&!document.hidden)void loadStatus();},15000);
 const stop=()=>{stopped=true;clearInterval(timer);};stopStatus=stop;
 let current=configuration;
 for(const control of controls){
  const form=control.querySelector<HTMLFormElement>('form')!;const kind=control.dataset.syncControl!;let busy=false;
  const field=(name:string)=>form.elements.namedItem(name) as HTMLInputElement|HTMLSelectElement;
  const checked=(name:string)=>(field(name) as HTMLInputElement).checked;
  const feedback=()=>form.querySelector<HTMLElement>('.sync-feedback')!;
  function modes(){
   if(kind==='supplier'){
    field('limit').disabled=checked('all');
    form.querySelectorAll<HTMLElement>('[data-slot]').forEach(row=>{row.querySelector<HTMLInputElement>('[data-slot-field="limit"]')!.disabled=row.querySelector<HTMLInputElement>('[data-slot-field="all"]')!.checked;});
    form.querySelector('.sync-schedule-mode')!.textContent=!checked('enabled')?'Automatización desactivada: puedes enviar a mano cuando quieras.':checked('immediate')?'Modo inmediato: los horarios quedan en pausa.':'Los pedidos se enviarán a las horas configuradas.';
    control.querySelector('.sync-mode-badge')!.textContent=checked('enabled')?'Automática':'Manual';
   }else form.querySelector<HTMLButtonElement>('[type="submit"]')!.textContent=`Guardar modo ${checked('automatic')?'automático':'manual'}`;
  }
  function policy(){
   const result=structuredClone(current.policy);
   if(kind==='supplier')result.supplier={enabled:checked('enabled'),immediate:checked('immediate'),limit:Number(field('limit').value),all:checked('all'),packing:field('packing').value as 'order'|'product',include_customer:field('include_customer').value==='true',schedules:[...form.querySelectorAll<HTMLElement>('[data-slot]')].map(row=>({id:row.dataset.slot!,time:row.querySelector<HTMLInputElement>('[data-slot-field="time"]')!.value,limit:Number(row.querySelector<HTMLInputElement>('[data-slot-field="limit"]')!.value),all:row.querySelector<HTMLInputElement>('[data-slot-field="all"]')!.checked}))};
   else result.marketplaces={automatic:checked('automatic'),interval_minutes:Number(field('interval_minutes').value)};
   return result;
  }
  const dirty=()=>{form.querySelector('.sync-dirty')!.textContent='Cambios sin guardar';};
  form.addEventListener('input',dirty);form.addEventListener('change',()=>{dirty();modes();});
  form.addEventListener('submit',event=>{event.preventDefault();event.stopPropagation();void perform('save');});
  form.addEventListener('click',event=>{
   const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-sync-command]');if(!button||busy)return;
   const command=button.dataset.syncCommand;
   if(command==='add-slot'){
    if(form.querySelectorAll('[data-slot]').length>=12){feedback().textContent='Puedes configurar hasta 12 horarios.';return;}
    const slots=form.querySelector('[data-slots]')!;slots.insertAdjacentHTML('beforeend',scheduleRow({id:crypto.randomUUID(),time:'09:00',limit:30,all:false}));slots.lastElementChild?.querySelector('input')?.focus();dirty();modes();
   }else if(command==='remove-slot'){button.closest('[data-slot]')?.remove();dirty();}
   else if(command==='supplier-now')void perform('supplier');else if(command==='marketplaces-now')void perform('marketplaces');
  });
  async function perform(action:'save'|'supplier'|'marketplaces'){
   if(busy||!form.reportValidity())return;
   const draft=policy();
   if(action==='save'&&kind==='supplier'){
    if(draft.supplier.enabled&&!draft.supplier.immediate&&!draft.supplier.schedules.length){feedback().textContent='Añade al menos un horario o activa el envío inmediato.';return;}
    if(new Set(draft.supplier.schedules.map(s=>s.time)).size!==draft.supplier.schedules.length){feedback().textContent='Cada horario debe tener una hora distinta.';return;}
   }
   busy=true;form.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(el=>el.disabled=true);
   feedback().textContent=action==='save'?'Guardando configuración…':'Sincronización en curso…';
   try{
    if(action==='save'){current=await request<SyncConfiguration>({action,policy:draft,revision:current.revision});form.querySelector('.sync-dirty')!.textContent='Configuración guardada';feedback().textContent='Configuración guardada. Se aplicará a los próximos envíos. Los ya iniciados conservan sus opciones.';}
    else {
     // Manual dispatch uses the saved delivery/privacy policy, never an unconfirmed form draft.
     if(form.querySelector('.sync-dirty')!.textContent==='Cambios sin guardar')throw new Error('Guarda la configuración antes de sincronizar para aplicar estas opciones.');
     const result=await request<{status?:string;processed?:number;errors?:number;remaining?:number}>({action,...(action==='supplier'?{limit:draft.supplier.limit,all:draft.supplier.all}:{})});
     if(result.status==='skipped')throw new Error('Ya hay una sincronización en curso. Consulta el historial al terminar.');
     await onChange();
     const target=root.querySelector(`[data-sync-control="${kind}"] .sync-feedback`);
     if(target)target.textContent=action==='supplier'?`${result.processed} pedidos enviados · ${result.errors} errores · ${result.remaining} pendientes.`:'Marketplaces sincronizados. Stock, precios, pedidos y seguimiento actualizados en el hub demo.';
     return;
    }
    await loadStatus();
   }catch(error){feedback().textContent=error instanceof Error?error.message:'No se pudo completar la operación.';}
   finally{busy=false;if(form.isConnected){form.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(el=>el.disabled=false);modes();}}
  }
  modes();
 }
 async function loadStatus(){
  if(stopped||!controls[0]?.isConnected){stop();return;}
  loading=true;
  try{
   const data=await request<HubSyncState>();
   if(stopped||!controls[0]?.isConnected)return;
   const active=data.heartbeat&&Date.now()-Date.parse(data.heartbeat.at)<90000;
   controls.forEach(control=>{const engine=control.querySelector('[data-engine]')!;engine.textContent=active?`● Ejecutor ${data.heartbeat!.engine==='dev'?'local':'programado'} activo · última comprobación ${date(data.heartbeat!.at)} · Europe/Madrid`:'Ejecutor programado sin señal reciente. El envío manual está disponible. En producción requiere activar el cron del Worker.';});
   root.querySelectorAll<HTMLElement>('[data-stock-channel]').forEach(el=>{const state=data.catalog.find(c=>c.channel===el.dataset.stockChannel);el.textContent=state?`${state.pending} cambios pendientes · Stock actualizado ${date(state.last_sync)}`:'Pendiente de la primera sincronización del catálogo';});
   for(const host of root.querySelectorAll<HTMLElement>('[data-hub-status]')){
    const last=data.runs[0];host.innerHTML=`<div class="sync-status-heading"><strong>${last?`Última conciliación: ${date(last.finished_at??last.started_at)}`:'Primera conciliación pendiente'}</strong><span>${last?last.status==='completed'?'Completada':last.status==='running'?'En curso':'Con incidencias':''}</span></div><div class="sync-operations">${Object.entries(titles).map(([resource,title])=>{const step=data.steps.find(s=>s.resource===resource);return `<div><span class="sync-operation-dot ${step?.status==='completed'?'complete':''}"></span><span><strong>${title}</strong><small>${resource==='Sales'?'Consulta del registro simulado de pedidos entrantes':resource==='Products/ExtraInfo'?'Incluye el stock disponible y el precio actual':'Acuse y copia local de demostración'}</small></span><b>${step?`${step.processed} · ${step.status==='completed'?'OK':'Error'}`:'Pendiente'}</b></div>`;}).join('')}</div>${last?.error?`<p class="sync-feedback">${esc(last.error)}</p>`:''}<p class="sync-help">Operaciones basadas en la API de Lighthouse. Todos los acuses y copias son locales; no se conecta con cuentas externas.</p>`;
   }
  }catch{if(!stopped)controls.forEach(control=>control.querySelector('[data-engine]')!.textContent='No se pudo consultar el estado del ejecutor. Recarga para comprobarlo.');}
  finally{loading=false;}
 }
 await loadStatus();
}
