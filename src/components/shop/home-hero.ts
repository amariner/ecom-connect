export function initHomeHero(root: HTMLElement) {
 const slides=[...root.querySelectorAll<HTMLElement>('[data-hero-slide]')];
 const selectors=[...root.querySelectorAll<HTMLButtonElement>('[data-hero-go]')];
 const pause=root.querySelector<HTMLButtonElement>('[data-hero-pause]')!;
 const reduced=matchMedia('(prefers-reduced-motion: reduce)');
 let active=0,paused=reduced.matches,hovered=false,focused=false,timer:ReturnType<typeof setTimeout>;
 function schedule(){
  clearTimeout(timer);
  const playing=!paused&&!hovered&&!focused&&!document.hidden;
  root.classList.toggle('is-playing',playing);
  pause.setAttribute('aria-pressed',String(paused));
  pause.setAttribute('aria-label',paused?'Reanudar carrusel':'Pausar carrusel');
  pause.innerHTML=`<span aria-hidden="true">${paused?'▷':'Ⅱ'}</span>`;
  if(playing)timer=setTimeout(()=>show(active+1,false),7000);
 }
 function show(index:number,manual:boolean){
  active=(index+slides.length)%slides.length;
  if(manual)paused=true;
  slides.forEach((slide,i)=>slide.hidden=i!==active);
  selectors.forEach((button,i)=>button.setAttribute('aria-pressed',String(i===active)));
  root.querySelector('[data-hero-counter]')!.textContent=`0${active+1} / 0${slides.length}`;
  if(manual)root.querySelector('[data-hero-announcement]')!.textContent=slides[active]?.getAttribute('aria-label')||'';
  schedule();
 }
 selectors.forEach((button,i)=>button.addEventListener('click',()=>show(i,true)));
 root.querySelector('[data-hero-prev]')?.addEventListener('click',()=>show(active-1,true));
 root.querySelector('[data-hero-next]')?.addEventListener('click',()=>show(active+1,true));
 pause.addEventListener('click',()=>{paused=!paused;schedule();});
 root.addEventListener('mouseenter',()=>{hovered=true;schedule();});
 root.addEventListener('mouseleave',()=>{hovered=false;schedule();});
 root.addEventListener('focusin',()=>{focused=true;schedule();});
 root.addEventListener('focusout',event=>{if(!root.contains(event.relatedTarget as Node)){focused=false;schedule();}});
 document.addEventListener('visibilitychange',schedule);
 reduced.addEventListener('change',()=>{paused=reduced.matches;schedule();});
 window.addEventListener('pagehide',()=>clearTimeout(timer),{once:true});
 schedule();
}
