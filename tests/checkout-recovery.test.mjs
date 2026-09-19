import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createCheckoutAttemptManager } from '../src/components/shop/checkout-attempt';
import { CheckoutSubmissionError, submitCheckoutAttempt } from '../src/components/shop/checkout-controller';

const source = readFileSync(new URL('../src/pages/checkout.astro',import.meta.url),'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\n/gm,'');
const script = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const customer = {name:'Cliente Demo',email:'demo@example.test',street:'Calle Demo 1',city:'Madrid',postal_code:'28001'};
const confirmation = {url:`/gracias?session=demo_${'a'.repeat(64)}`,order_id:12};

function checkoutPage(fetcher, savedAttempt) {
  let cart = [{slug:'ultima-unidad',qty:1}];
  const storage = new Map(savedAttempt ? [['farmahouse:checkout-attempt',JSON.stringify(savedAttempt)]] : []);
  const elements = new Map();
  const windowEvents = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id,{
      hidden:false,disabled:true,textContent:'',innerHTML:'',value:id === 'checkout-postal' ? '28001' : '',events:new Map(),
      addEventListener(name,handler) { this.events.set(name,handler); },
      querySelector(selector) { return selector === 'span' ? element(`${id}-span`) : element(selector); },
      querySelectorAll() { return Object.keys(customer).map(key => element(`[name="${key}"]`)); },
      reportValidity() { return true; },
    });
    return elements.get(id);
  }
  const quote = {purchasable:true,subtotal_cents:1000,shipping_cents:490,total_cents:1490,shipping:{label:'Península'},
    lines:[{slug:'ultima-unidad',qty:1,name:'Última unidad demo',unit_price_cents:1000,line_total_cents:1000,available_stock:1,status:'ok'}]};
  const requestQuote = vi.fn().mockResolvedValue(quote);
  const captureCartLineage = vi.fn(() => ({'ultima-unidad':'original-line'}));
  const completeCartPurchase = vi.fn();
  const navigate = vi.fn();
  const sessionStorage = {getItem:key => storage.get(key) ?? null,setItem:(key,value) => storage.set(key,value),removeItem:key => storage.delete(key)};
  vm.runInContext(script,vm.createContext({
    Error,CheckoutSubmissionError,createCheckoutAttemptManager,
    submitCheckoutAttempt:attempt => submitCheckoutAttempt(attempt,fetcher),
    sessionStorage,
    document:{getElementById:element,addEventListener() {}},
    window:{addEventListener:(name,handler) => windowEvents.set(name,handler),location:{assign:navigate}},
    readCart:() => cart,captureCartLineage,completeCartPurchase,requestQuote,euros:value => String(value),escapeHtml:value => value,
    FormData:class { get(key) { return customer[key]; } },
    setTimeout,clearTimeout,
  }));
  return {element,storage,sessionStorage,requestQuote,captureCartLineage,completeCartPurchase,navigate,
    setCart:lines => {cart=lines;},storageChanged:() => windowEvents.get('storage')(),
    submit:() => element('checkout-form').events.get('submit')({preventDefault() {}})};
}

describe('checkout page recovery wiring',() => {
  it('retries a persisted purchase after a lost response without recotizing or replacing its cart snapshot',async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({},{status:502})).mockResolvedValueOnce(Response.json(confirmation));
    const page = checkoutPage(fetcher);
    await new Promise(setImmediate);
    expect(page.element('checkout-submit').disabled).toBe(false);
    await page.submit();
    expect(page.element('checkout-submit').disabled).toBe(false);
    expect(page.element('checkout-submit-span').textContent).toBe('Reintentar confirmación');
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
