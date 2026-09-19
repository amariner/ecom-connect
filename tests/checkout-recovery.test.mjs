import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createCheckoutAttemptManager, snapshotCheckoutQuote } from '../src/components/shop/checkout-attempt';
import { CheckoutSubmissionError, submitCheckoutAttempt } from '../src/components/shop/checkout-controller';

const source = readFileSync(new URL('../src/pages/checkout.astro',import.meta.url),'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm,'');
const script = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const customer = {name:'Cliente Demo',email:'demo@example.test',street:'Calle Demo 1',city:'Madrid',postal_code:'28001'};
const confirmation = {url:`/gracias?session=demo_${'a'.repeat(64)}`,order_id:12};

function checkoutPage(fetcher, savedAttempt, initialQuoteFailure) {
  let cart = [{slug:'ultima-unidad',qty:1}];
  const storage = new Map(savedAttempt ? [['farmahouse:checkout-attempt',JSON.stringify(savedAttempt)]] : []);
  const elements = new Map();
  const windowEvents = new Map();
  const document = {activeElement:null,body:{},getElementById:element,addEventListener() {}};
  document.activeElement = document.body;
  function element(id) {
    if (!elements.has(id)) elements.set(id,{
      hidden:false,disabled:true,textContent:'',innerHTML:'',value:id === 'checkout-postal' ? '28001' : '',events:new Map(),
      addEventListener(name,handler) { this.events.set(name,handler); },
      querySelector(selector) { return selector === 'span' ? element(`${id}-span`) : element(selector); },
      querySelectorAll() { return Object.keys(customer).map(key => element(`[name="${key}"]`)); },
      reportValidity() { return true; },
      focus() { document.activeElement = this; },
    });
    return elements.get(id);
  }
  const quote = {purchasable:true,subtotal_cents:1000,shipping_cents:490,total_cents:1490,shipping:{label:'Península'},
    lines:[{slug:'ultima-unidad',qty:1,name:'Última unidad demo',unit_price_cents:1000,line_total_cents:1000,available_stock:1,status:'ok'}]};
  const requestQuote = vi.fn().mockResolvedValue(quote);
  if(initialQuoteFailure)requestQuote.mockRejectedValueOnce(initialQuoteFailure);
  const captureCartLineage = vi.fn(() => ({'ultima-unidad':'original-line'}));
  const completeCartPurchase = vi.fn();
  const navigate = vi.fn();
  const sessionStorage = {getItem:key => storage.get(key) ?? null,setItem:(key,value) => storage.set(key,value),removeItem:key => storage.delete(key)};
  vm.runInContext(script,vm.createContext({
    Error,CheckoutSubmissionError,createCheckoutAttemptManager,snapshotCheckoutQuote,
    submitCheckoutAttempt:attempt => submitCheckoutAttempt(attempt,fetcher),
    sessionStorage,
    document,
    window:{addEventListener:(name,handler) => windowEvents.set(name,handler),location:{assign:navigate}},
    readCart:() => cart,captureCartLineage,completeCartPurchase,requestQuote,euros:value => String(value),escapeHtml:value => value,
    FormData:class { get(key) { return customer[key]; } },
    setTimeout,clearTimeout,
  }));
  return {element,document,storage,sessionStorage,quote,requestQuote,captureCartLineage,completeCartPurchase,navigate,
    setCart:lines => {cart=lines;},storageChanged:() => windowEvents.get('storage')(),
    submit:() => element('checkout-form').events.get('submit')({preventDefault() {}})};
}

describe('checkout page recovery wiring',() => {
  it('shows old and current amounts after a price rejection and waits for an explicit second confirmation',async () => {
    const fetcher = vi.fn();
    const page = checkoutPage(fetcher);
    await new Promise(setImmediate);
    const updated = {...page.quote,lines:[{...page.quote.lines[0],unit_price_cents:1500,line_total_cents:1500}],subtotal_cents:1500,total_cents:1990};
    fetcher.mockResolvedValueOnce(Response.json({error:'Los precios han cambiado.',code:'quote_changed',quote:snapshotCheckoutQuote(updated)},{status:409}))
      .mockResolvedValueOnce(Response.json(confirmation));
    page.requestQuote.mockResolvedValue(updated);
    await page.submit();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(page.navigate).not.toHaveBeenCalled();
    expect(page.completeCartPurchase).not.toHaveBeenCalled();
    expect(page.element('checkout-price-review').hidden).toBe(false);
    expect(page.element('checkout-price-review').innerHTML).toContain('Total anterior: 1490. Total actualizado: 1990.');
    expect(page.element('checkout-price-review').innerHTML).toContain('Última unidad demo: de 1000 a 1500 por unidad.');
    expect(page.element('checkout-submit-span').textContent).toBe('Confirmar importe · 1990');
    expect(page.element('checkout-submit').disabled).toBe(false);
    expect(page.document.activeElement).toBe(page.element('checkout-submit'));
    expect(page.storage.has('farmahouse:checkout-attempt')).toBe(false);
    await page.submit();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const before = JSON.parse(fetcher.mock.calls[0][1].body);
    const after = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(before.expected_quote).toEqual(snapshotCheckoutQuote(page.quote));
    expect(after.expected_quote).toEqual(snapshotCheckoutQuote(updated));
    expect(after.idempotency_key).not.toBe(before.idempotency_key);
    expect(page.navigate).toHaveBeenCalledWith(confirmation.url);
  });

  it('still requires review when a price and shipping change compensate each other',async () => {
    const fetcher = vi.fn();
    const page = checkoutPage(fetcher);
    await new Promise(setImmediate);
    const updated = {...page.quote,lines:[{...page.quote.lines[0],unit_price_cents:1200,line_total_cents:1200}],subtotal_cents:1200,shipping_cents:290};
    fetcher.mockResolvedValue(Response.json({error:'El desglose ha cambiado.',code:'quote_changed',quote:snapshotCheckoutQuote(updated)},{status:409}));
    page.requestQuote.mockResolvedValue(updated);
    await page.submit();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(page.element('checkout-price-review').innerHTML).toContain('El total se mantiene en 1490, pero ha cambiado el desglose.');
    expect(page.element('checkout-price-review').innerHTML).toContain('de 1000 a 1200 por unidad');
    expect(page.element('checkout-price-review').innerHTML).toContain('Envío: de 490 a 290');
    expect(page.element('checkout-submit-span').textContent).toBe('Confirmar importe · 1490');
  });

  it('offers a local retry after a quote failure without submitting a purchase',async () => {
    const fetcher = vi.fn();
    const page = checkoutPage(fetcher,undefined,new Error('Consulta agotada'));
    await new Promise(setImmediate);
    expect(page.element('checkout-quote-retry').hidden).toBe(false);
    expect(page.element('checkout-submit').disabled).toBe(true);
    page.element('checkout-quote-retry').events.get('click')();
    await new Promise(setImmediate);
    expect(page.element('checkout-quote-retry').hidden).toBe(true);
    expect(page.element('checkout-submit').disabled).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps product-specific availability after a definitive stock rejection',async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({error:'Revisa la disponibilidad y el código postal.'},{status:409}));
    const page = checkoutPage(fetcher);
    await new Promise(setImmediate);
    page.requestQuote.mockResolvedValue({...page.quote,purchasable:false,lines:[{...page.quote.lines[0],available_stock:0,status:'out-of-stock'}]});
    await page.submit();
    expect(page.element('checkout-error').textContent).toContain('Última unidad demo: sin disponibilidad');
    expect(page.element('checkout-error').textContent).not.toContain('código postal');
    expect(page.element('checkout-cart-review').hidden).toBe(false);
    expect(page.element('checkout-submit').disabled).toBe(true);
    expect(page.document.activeElement).toBe(page.element('checkout-cart-review'));
  });

  it('restores focus to quote retry when recotizing a rejected purchase fails',async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({error:'Revisa la disponibilidad.'},{status:409}));
    const page = checkoutPage(fetcher);
    await new Promise(setImmediate);
    page.requestQuote.mockRejectedValue(new Error('Consulta agotada'));
    await page.submit();
    expect(page.element('checkout-quote-retry').hidden).toBe(false);
    expect(page.document.activeElement).toBe(page.element('checkout-quote-retry'));
  });

  it('does not move focus if the user selects another field while the rejected purchase is recotized',async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({error:'Revisa la disponibilidad.'},{status:409}));
    const page = checkoutPage(fetcher);
    await new Promise(setImmediate);
    let resolveQuote;
    page.requestQuote.mockImplementation(() => new Promise(resolve => {resolveQuote=resolve;}));
    const submitting = page.submit();
    await new Promise(setImmediate);
    page.element('checkout-postal').focus();
    resolveQuote(page.quote);
    await submitting;
    expect(page.element('checkout-submit').disabled).toBe(false);
    expect(page.document.activeElement).toBe(page.element('checkout-postal'));
  });

  it('retries a persisted purchase after a lost response without recotizing or replacing its cart snapshot',async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({},{status:502})).mockResolvedValueOnce(Response.json(confirmation));
    const page = checkoutPage(fetcher);
    await new Promise(setImmediate);
    expect(page.element('checkout-submit').disabled).toBe(false);
    await page.submit();
    expect(page.element('checkout-submit').disabled).toBe(false);
    expect(page.element('checkout-submit-span').textContent).toBe('Reintentar confirmación');
    expect(page.element('checkout-total').textContent).toBe('1490');
    expect(page.element('checkout-recovery').textContent).toContain('El importe revisado de este intento es 1490');
    expect(page.element('[name="name"]').disabled).toBe(true);
    page.setCart([{slug:'ultima-unidad',qty:1},{slug:'added-in-another-tab',qty:2}]);
    page.storageChanged();
    page.requestQuote.mockResolvedValue({purchasable:false,lines:[]});
    await page.submit();
    expect(page.requestQuote).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body);
    expect(page.completeCartPurchase).toHaveBeenCalledWith([{slug:'ultima-unidad',qty:1}],'order:12',{'ultima-unidad':'original-line'});
    expect(JSON.parse(page.storage.get('farmahouse:pending-confirmation')))
      .toEqual({url:confirmation.url,lines:[{slug:'ultima-unidad',qty:1}],receipt:'order:12',lineage:{'ultima-unidad':'original-line'}});
    expect(page.storage.has('farmahouse:checkout-attempt')).toBe(false);
    expect(page.navigate).toHaveBeenCalledWith(confirmation.url);
  });

  it('restores a frozen purchase independently of an empty cart or form validation',async () => {
    const attempt = {key:'11111111-1111-4111-8111-111111111111',payload:{lines:[{slug:'original',qty:2}],customer}};
    const fetcher = vi.fn().mockResolvedValue(Response.json(confirmation));
    const page = checkoutPage(fetcher,attempt);
    page.setCart([]);
    page.element('checkout-form').reportValidity = () => false;
    page.storageChanged();
    expect(page.element('checkout-form').hidden).toBe(false);
    expect(page.element('checkout-empty').hidden).toBe(true);
    expect(page.element('checkout-submit').disabled).toBe(false);
    await page.submit();
    expect(page.requestQuote).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({...attempt.payload,idempotency_key:attempt.key});
    expect(page.navigate).toHaveBeenCalledWith(confirmation.url);
  });

  it('allows correcting a definitive rejection and still confirms when cart persistence fails',async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({error:'Revisa el código postal.'},{status:400}))
      .mockResolvedValueOnce(Response.json(confirmation));
    const page = checkoutPage(fetcher);
    await new Promise(setImmediate);
    await page.submit();
    expect(page.element('[name="name"]').disabled).toBe(false);
    expect(page.element('checkout-recovery').hidden).toBe(true);
    expect(page.storage.has('farmahouse:checkout-attempt')).toBe(false);
    page.completeCartPurchase.mockImplementation(() => {throw new Error('Browser storage unavailable');});
    await page.submit();
    expect(page.navigate).toHaveBeenCalledWith(confirmation.url);
    expect(page.storage.has('farmahouse:pending-confirmation')).toBe(true);
  });

  it('keeps a legacy purchase recoverable without assigning newly added lines to it',async () => {
    const attempt = {key:'11111111-1111-4111-8111-111111111111',payload:{lines:[{slug:'original',qty:2}],customer}};
    const page = checkoutPage(vi.fn().mockResolvedValue(Response.json(confirmation)),attempt);
    page.completeCartPurchase.mockImplementation(() => {throw new Error('No original line identity');});
    await page.submit();
    expect(page.captureCartLineage).not.toHaveBeenCalled();
    expect(page.completeCartPurchase).toHaveBeenCalledWith(attempt.payload.lines,'order:12',undefined);
    expect(JSON.parse(page.storage.get('farmahouse:pending-confirmation'))).not.toHaveProperty('lineage');
    expect(page.navigate).toHaveBeenCalledWith(confirmation.url);
  });

  it('uses a confirmation warning fragment when neither the marker nor the cart can be persisted',async () => {
    const page = checkoutPage(vi.fn().mockResolvedValue(Response.json(confirmation)));
    await new Promise(setImmediate);
    page.sessionStorage.setItem = () => {throw new Error('Session storage denied');};
    page.captureCartLineage.mockImplementation(() => {throw new Error('Cart storage denied');});
    page.completeCartPurchase.mockImplementation(() => {throw new Error('Cart storage denied');});
    await page.submit();
    expect(page.completeCartPurchase).toHaveBeenCalledWith([{slug:'ultima-unidad',qty:1}],'order:12',undefined);
    expect(page.storage.has('farmahouse:pending-confirmation')).toBe(false);
    expect(page.navigate).toHaveBeenCalledWith(`${confirmation.url}#revisar-cesta`);
  });
});
