import { categories, subcategories, categoryName, categoryMatches } from '../shop/catalog';
import type { CatalogSelection, SelectionProduct } from '../../lib/catalog-selection';
import '../../styles/catalog-selector.css';
const names:Record<string,string>={supplier:'Catálogo del proveedor',lighthouse:'Lighthouse',google:'Google Merchant Center',meta:'Meta',AMAZON:'Amazon',MIRAVIA:'Miravia',CARREFOUR:'Carrefour',EBAY:'eBay'};
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const money=(value:number)=>new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR'}).format(value/100);
const fold=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
type Catalog={products:SelectionProduct[];selections:CatalogSelection[]};
type SelectorDraft={revision:number;selected:string[];automatic:boolean;dirty:boolean;page:number;fields:Record<string,string>;open:boolean};
const drafts=new Map<string,SelectorDraft>();
export function selectorShell(scope:string,expanded=false) {
 const feed=['lighthouse','google','meta'].includes(scope);
 return `<details class="catalog-selector" data-selector="${scope}" ${expanded?'open':''}><summary><span>${scope==='supplier'?'<small>IMPORTACIÓN A LA TIENDA</small>':''}<strong>${names[scope]}</strong></span><span class="selector-summary-wrap"><span class="selector-summary">Cargando selección…</span><span class="selector-chevron" aria-hidden="true">⌄</span></span></summary>${feed?`<div class="selector-feed-info"><label class="feed-address">URL del feed<input readonly aria-label="URL del feed ${names[scope]}" value="${esc(location.origin)}/feeds/${scope}.xml" /></label><a class="button button-secondary" href="/feeds/${scope}.xml" target="_blank" rel="noopener">Abrir XML ↗</a></div>`:''}<div class="selector-content">Cargando catálogo…</div></details>`;
}
export function feedSelectors() {
 return `<section class="admin-card spaced-card feed-selectors" id="product-feeds"><div class="card-heading"><h2>Feeds de productos</h2><span class="status-badge neutral">3 destinos</span></div><div class="card-body"><p class="muted">Elige qué productos compartir en cada feed. Solo se publican los visibles en la tienda.</p>${['lighthouse','google','meta'].map(scope=>selectorShell(scope)).join('')}</div></section>`;
}
export function marketplaceSelectors() {
 return `<section class="admin-card spaced-card feed-selectors"><div class="card-heading"><h2>Productos por marketplace</h2><span class="status-badge neutral">4 canales</span></div><div class="card-body"><p class="muted">Cada canal tiene su selección. Los productos deben estar visibles en la tienda e incluidos en el feed Lighthouse.</p>${['AMAZON','MIRAVIA','CARREFOUR','EBAY'].map(scope=>selectorShell(scope)).join('')}</div></section>`;
}
async function api<T>(url:string,body?:unknown):Promise<T> {
 const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const result=await response.json();
 if(!response.ok)throw new Error(result.error || 'No se pudo guardar la selección.');
 return result;
}
export async function mountSelectors(root:HTMLElement,onChanged:()=>Promise<void>) {
 const containers=[...root.querySelectorAll<HTMLElement>('[data-selector]')];
 if(!containers.length)return;
 try {
  const data=await api<Catalog>('/api/demo/catalog-selection');
  for(const container of containers)if(container.isConnected)mount(container,data,onChanged);
 }catch(error){for(const container of containers)container.querySelector('.selector-content')!.textContent=`No se pudo cargar el catálogo. Recarga la página. ${error instanceof Error?error.message:''}`;}
}
function mount(container:HTMLElement,data:Catalog,onChanged:()=>Promise<void>) {
 const scope=container.dataset.selector!;const supplier=scope==='supplier';const marketplace=scope===scope.toUpperCase();
 const stored=data.selections.find(s=>s.scope===scope);
 const lighthouse=data.selections.find(s=>s.scope==='lighthouse');
 const eligible=(p:SelectionProduct)=>supplier?!p.linked:!!p.loaded && (!marketplace || !lighthouse?.codes || lighthouse.codes.includes(p.code));
 const draft=drafts.get(scope);
 const restored=draft && draft.revision===(stored?.revision??0)?draft:undefined;
 if(restored)container.toggleAttribute('open',restored.open);
 let automatic=restored?.automatic??(!supplier && stored?.codes===null);
 const selected=new Set<string>(restored?.selected??(supplier?[]:stored?.codes??data.products.filter(eligible).map(p=>p.code)));
 let page=restored?.page??1,busy=false,dirty=restored?.dirty??false;
 const content=container.querySelector<HTMLElement>('.selector-content')!;
 const actual=data.products.filter(p=>p.source_url);const loaded=actual.filter(p=>p.loaded).length;
 content.innerHTML=`${supplier?`<div class="selector-metrics"><div><strong>${actual.length}</strong><span>Referencias reales del proveedor</span></div><div><strong>${loaded}</strong><span>Visibles en la web</span></div><div><strong>${actual.length-loaded}</strong><span>Pendientes de publicar</span></div><div><strong>${actual.filter(p=>p.linked&&!p.loaded).length}</strong><span>Vinculadas · falta sincronizar</span></div></div><p class="selector-help">1. Selecciona referencias sin vincular. 2. Vincúlalas. 3. Sincroniza para que aparezcan en la web. Las ${data.products.length-actual.length} referencias ficticias originales también están disponibles en el listado.</p>`:`<label class="selector-mode">Cómo mantener este surtido<select data-field="mode"><option value="all" ${automatic?'selected':''}>Todos los elegibles, incluidos futuros productos</option><option value="manual" ${!automatic?'selected':''}>Solo mi selección de productos</option></select></label>`}
 <div class="selector-filters"><label>Buscar producto<input data-field="search" type="search" placeholder="Nombre, marca, SKU o EAN…" /></label><label>Categoría<select data-field="category"><option value="">Todas las categorías</option>${categories.map(c=>`<optgroup label="${esc(c.name)}"><option value="${c.id}">${esc(c.name)} · toda la familia</option>${subcategories.filter(s=>s.parent===c.id).map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</optgroup>`).join('')}</select></label><label>Estado<select data-field="status"><option value="">Todos los estados</option>${supplier?'<option value="unlinked">Sin vincular</option><option value="pending">Vinculados · pendientes de sincronizar</option><option value="loaded">Visibles en la web</option>':'<option value="selected">Seleccionados</option><option value="excluded">No seleccionados</option><option value="eligible">Elegibles para publicar</option><option value="unavailable">No elegibles todavía</option>'}</select></label><label>Marca<select data-field="brand"><option value="">Todas las marcas</option>${[...new Set(data.products.map(p=>p.brand))].sort().map(brand=>`<option>${esc(brand)}</option>`).join('')}</select></label><label>Disponibilidad<select data-field="stock"><option value="">Todo el stock</option><option value="yes">Con stock</option><option value="no">Sin stock</option></select></label><label>Ordenar<select data-field="sort"><option value="name">Nombre A–Z</option><option value="low">Precio: menor primero</option><option value="high">Precio: mayor primero</option></select></label></div>
 <div class="selector-toolbar"><span data-count role="status"></span><div><button type="button" data-command="filtered">Seleccionar todos los resultados</button><button type="button" data-command="clear">Vaciar selección</button><button type="button" data-command="reset">Limpiar filtros</button></div></div>
 <div class="table-scroll selector-table" tabindex="0" role="region" aria-label="Productos para ${esc(names[scope])}"><table><thead><tr><th><input type="checkbox" data-page-check aria-label="Seleccionar esta página" /></th><th>Producto / referencia</th><th>Categoría</th><th>Precio</th><th>Stock demo</th><th>Estado</th></tr></thead><tbody></tbody></table></div>
 <div class="selector-pagination"><button class="button button-secondary" type="button" data-command="prev">← Anterior</button><span data-page></span><button class="button button-secondary" type="button" data-command="next">Siguiente →</button></div>
 <div class="selector-save"><div><strong data-selected></strong><small>${supplier?'Vincular conserva la selección del resto del catálogo.':'La selección se guarda solo para este destino. Un surtido vacío produce un feed vacío.'}</small></div><button type="button" class="button button-primary" data-command="save">${supplier?'Vincular seleccionados':'Guardar selección'}</button>${supplier?'<button type="button" class="button button-secondary" data-command="sync">Sincronizar vinculados →</button>':''}</div><p class="selector-feedback" role="status" aria-live="polite"></p>`;
 const field=(name:string)=>content.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-field="${name}"]`)!;
 const checked=(p:SelectionProduct)=>automatic?eligible(p):selected.has(p.code);
 const canToggle=(p:SelectionProduct)=>eligible(p)||(!supplier&&checked(p));
 if(restored)Object.entries(restored.fields).forEach(([name,value])=>field(name).value=value);
 if(!supplier)field('mode').value=automatic?'all':'manual';
 container.addEventListener('toggle',()=>{const draft=drafts.get(scope);if(draft)draft.open=container.hasAttribute('open');});
 function filtered(){
  const query=fold(field('search').value),category=field('category').value,status=field('status').value,brand=field('brand').value,stock=field('stock').value;
  return data.products.filter(p=>(!query || fold(`${p.name} ${p.brand} ${p.sku} ${p.ean} ${p.code}`).includes(query)) && (!category || categoryMatches(p,category)) && (!brand||p.brand===brand) && (!stock||(stock==='yes'?p.stock>0:p.stock===0)) && (!status || (status==='unlinked'?!p.linked:status==='pending'?p.linked&&!p.loaded:status==='loaded'?p.loaded:status==='selected'?checked(p):status==='excluded'?!checked(p):status==='eligible'?eligible(p):!eligible(p))))
  .sort((a,b)=>field('sort').value==='low'?a.price_cents-b.price_cents:field('sort').value==='high'?b.price_cents-a.price_cents:a.name.localeCompare(b.name,'es'));
 }
 function manual(){if(automatic){selected.clear();data.products.filter(eligible).forEach(p=>selected.add(p.code));automatic=false;field('mode').value='manual';}dirty=true;}
 function render(){
  const rows=filtered(),pages=Math.max(1,Math.ceil(rows.length/20));page=Math.min(page,pages);const visible=rows.slice((page-1)*20,page*20);
  content.querySelector('[data-count]')!.textContent=`${rows.length} resultados · ${data.products.length} referencias`;
  content.querySelector('[data-page]')!.textContent=`Página ${page} de ${pages}`;
  content.querySelector<HTMLButtonElement>('[data-command="prev"]')!.disabled=busy||page===1;
  content.querySelector<HTMLButtonElement>('[data-command="next"]')!.disabled=busy||page===pages;
  content.querySelector('tbody')!.innerHTML=visible.map(p=>{
   const status=p.loaded?'Visible en la web':p.linked?'Pendiente de sincronizar':'Sin vincular';
   const destination=!supplier?(eligible(p)?checked(p)?'Incluido en este destino':'Fuera de este destino':p.loaded?'Fuera del feed Lighthouse':'No visible en la tienda'):status;
   return `<tr class="${checked(p)?'is-selected':''}"><td><input type="checkbox" data-code="${esc(p.code)}" aria-label="Seleccionar ${esc(p.name)}" ${checked(p)?'checked':''} ${!canToggle(p)||busy?'disabled':''}/></td><td><div class="selector-product"><img src="${esc(p.image)}" alt="" width="44" height="44" loading="lazy"/><span><strong>${esc(p.name)}</strong><small>${esc(p.brand)} · ${esc(p.sku)}</small>${p.loaded?`<a href="/tienda/${esc(p.slug)}" target="_blank" rel="noopener">Ver en la tienda ↗</a>`:''}</span></div></td><td>${esc(categoryName(p.category))}</td><td class="selector-price">${money(p.price_cents)}</td><td>${p.stock}</td><td><span class="selector-state ${(supplier?p.loaded:eligible(p)&&checked(p))?'ready':''}">${esc(destination)}</span></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="selector-empty">No hay productos con estos filtros. Prueba otra búsqueda.</td></tr>';
  const selectable=visible.filter(canToggle),pageCheck=content.querySelector<HTMLInputElement>('[data-page-check]')!;
  pageCheck.checked=selectable.length>0&&selectable.every(checked);pageCheck.indeterminate=selectable.some(checked)&&!pageCheck.checked;pageCheck.disabled=busy||!selectable.length;
  const selectedCount=automatic?data.products.filter(eligible).length:selected.size;
  const eligibleCount=data.products.filter(p=>eligible(p)&&checked(p)).length;
  content.querySelector('[data-selected]')!.textContent=`${selectedCount} seleccionados${supplier?'':` · ${eligibleCount} publicables`}${dirty?' · Sin guardar':''}`;
  content.querySelector<HTMLButtonElement>('[data-command="save"]')!.disabled=busy||(supplier?!selectedCount:!dirty);
  const summary=container.querySelector('.selector-summary')!;drafts.set(scope,{revision:stored?.revision??0,selected:[...selected],automatic,dirty,page,fields:Object.fromEntries(['search','category','status','brand','stock','sort'].map(name=>[name,field(name).value])),open:container.hasAttribute('open')});summary.textContent=supplier?`${loaded} en la web · ${actual.length-loaded} pendientes`:`${eligibleCount} productos${dirty?' · Sin guardar':automatic?' · Automático':' · Selección manual'}`;
 }
 content.addEventListener('input',event=>{if((event.target as HTMLElement).matches('[data-field="search"]')){page=1;render();}});
 content.addEventListener('change',event=>{
  const target=event.target as HTMLInputElement;
  if(target.dataset.field==='mode'){automatic=target.value==='all';dirty=true;}
  else if(target.dataset.code){manual();target.checked?selected.add(target.dataset.code):selected.delete(target.dataset.code);}
  else if(target.hasAttribute('data-page-check')){manual();filtered().slice((page-1)*20,page*20).filter(canToggle).forEach(p=>target.checked?selected.add(p.code):selected.delete(p.code));}
  if(target.dataset.field)page=1;render();
 });
 content.addEventListener('click',async event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-command]');if(!button||busy)return;
  const command=button.dataset.command;
  if(command==='prev')page--;if(command==='next')page++;
  if(command==='filtered'){manual();filtered().filter(eligible).forEach(p=>selected.add(p.code));}
  if(command==='clear'){manual();selected.clear();}
  if(command==='reset'){['search','category','status','brand','stock'].forEach(name=>field(name).value='');field('sort').value='name';page=1;}
  if(command==='save'||command==='sync'){
   busy=true;render();content.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(el=>el.disabled=true);
   const feedback=content.querySelector<HTMLElement>('.selector-feedback')!;feedback.textContent=command==='sync'?'Sincronizando las referencias vinculadas…':'Guardando selección…';
   try {
    if(command==='sync'){
     const result=await api<{errors:number}>('/api/demo/action',{action:'sync'});
     if(result.errors)throw new Error(`Sincronización terminada con ${result.errors} errores. Revisa la actividad.`);
    }else{
     const saved=await api<CatalogSelection>('/api/demo/catalog-selection',{scope,codes:automatic?null:[...selected],...(!supplier?{revision:stored?.revision??0}:{})});
     if(stored){stored.codes=saved.codes;stored.revision=saved.revision;}
     if(!supplier)await api('/api/demo/action',{action:'regenerate-feed'});
    }
    drafts.delete(scope);
    await onChanged();
    const next=rootContainer(scope);if(next){next.setAttribute('open','');const message=next.querySelector('.selector-feedback');if(message)message.textContent=command==='sync'?'Sincronización completada. Los productos vinculados ya están disponibles en la web.':supplier?'Referencias vinculadas. Pulsa «Sincronizar vinculados» para publicarlas.':'Selección guardada y distribución simulada actualizada.';}
    return;
   }catch(error){feedback.textContent=error instanceof Error?error.message:'No se pudo completar la operación.';}
   finally {busy=false;if(content.isConnected){content.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(el=>el.disabled=false);render();}}
  }
  render();
 });
 render();
}
function rootContainer(scope:string){return document.querySelector<HTMLElement>(`[data-selector="${scope}"]`);}
