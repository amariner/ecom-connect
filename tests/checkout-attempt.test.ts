import { describe, expect, it, vi } from 'vitest';
import { createCheckoutAttemptManager, snapshotCheckoutQuote, type CheckoutPayload } from '../src/components/shop/checkout-attempt';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const payload = (): CheckoutPayload => ({lines:[{slug:'champu-demo',qty:1}],customer:{name:'Cliente Demo',email:'demo@example.test',street:'Calle Demo 1',city:'Madrid',postal_code:'28001'}});
const quote = () => ({lines:[{slug:'champu-demo',qty:1,unit_price_cents:1000}],subtotal_cents:1000,shipping_cents:490,total_cents:1490});
function storage() {
  const values = new Map<string,string>();
  return {values,getItem:(key:string) => values.get(key) ?? null,setItem:(key:string,value:string) => {values.set(key,value);},removeItem:(key:string) => {values.delete(key);}};
}

describe('unresolved checkout attempt',() => {
  it('freezes and restores every displayed price without changing the original attempt',() => {
    const store = storage();
    const expected = quote();
    const manager = createCheckoutAttemptManager(() => store,() => first);
    const original = manager.begin({...payload(),expected_quote:expected});
    expected.lines[0]!.unit_price_cents = 2000;
    expected.shipping_cents = 990;
    expect(original.payload.expected_quote).toEqual(quote());
    expect(Object.isFrozen(original.payload.expected_quote?.lines[0])).toBe(true);
    expect(Object.isFrozen(original.payload.expected_quote)).toBe(true);
    const restored = createCheckoutAttemptManager(() => store,() => second);
    expect(restored.pending()).toEqual(original);
    expect(restored.begin({...payload(),expected_quote:expected})).toEqual(original);
  });

  it('does not silently strip an invalid quote from a persisted attempt',() => {
    const store = storage();
    store.setItem('farmahouse:checkout-attempt',JSON.stringify({key:first,payload:{...payload(),expected_quote:{...quote(),total_cents:null}}}));
    expect(createCheckoutAttemptManager(() => store).pending()).toBeNull();
  });

  it('keeps the same immutable payload and key when fields or another tab change',() => {
    const store = storage();
    const random = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const manager = createCheckoutAttemptManager(() => store,random);
    const initial = payload();
    const lineage = {'champu-demo':'original-line'};
    const attempt = manager.begin(initial,lineage);
    initial.lines[0]!.qty = 5;
    lineage['champu-demo'] = 'replacement-line';
    const changed = {...payload(),lines:[{slug:'gel-demo',qty:2}]};
    expect(manager.begin(changed)).toBe(attempt);
    expect(manager.begin(payload())).toBe(attempt);
    expect(attempt.payload.lines).toEqual([{slug:'champu-demo',qty:1}]);
    expect(attempt.lineage).toEqual({'champu-demo':'original-line'});
    expect(Object.isFrozen(attempt.lineage)).toBe(true);
    expect(Object.isFrozen(attempt.payload.lines[0])).toBe(true);
    expect(random).toHaveBeenCalledOnce();
  });
  it('restores the complete unresolved purchase after reload even when the current cart is different',() => {
    const store = storage();
    const original = createCheckoutAttemptManager(() => store,() => first).begin(payload(),{'champu-demo':'original-line'});
    const restored = createCheckoutAttemptManager(() => store,() => second);
    expect(restored.pending()).toEqual(original);
    expect(restored.begin({...payload(),lines:[{slug:'another-product',qty:7}]})).toEqual(original);
  });
  it('restores valid legacy payload strings',() => {
    const store = storage();
    store.setItem('farmahouse:checkout-attempt',JSON.stringify({key:first,payload:JSON.stringify(payload())}));
    expect(createCheckoutAttemptManager(() => store).pending()).toEqual({key:first,payload:payload()});
  });
  it('does not invent line identity for a legacy attempt or malformed saved lineage',() => {
    const store = storage();
    store.setItem('farmahouse:checkout-attempt',JSON.stringify({key:first,payload:payload(),lineage:{'champu-demo':7}}));
    const manager = createCheckoutAttemptManager(() => store,() => second);
    expect(manager.pending()?.lineage).toBeUndefined();
    expect(manager.begin(payload(),{'champu-demo':'new-line'}).lineage).toBeUndefined();
    expect(manager.pending()?.key).toBe(first);
  });
  it('keeps the attempt in memory when browser storage access is denied',() => {
    const random = vi.fn(() => first);
    const manager = createCheckoutAttemptManager(() => {throw new Error('Storage denied');},random);
    const attempt = manager.begin(payload());
    expect(manager.begin({...payload(),lines:[{slug:'changed',qty:9}]})).toBe(attempt);
    expect(manager.pending()).toBe(attempt);
    expect(random).toHaveBeenCalledOnce();
  });
  it('keeps the attempt when persistence writes fail',() => {
    const store = storage();
    store.setItem = () => {throw new Error('Quota');};
    const manager = createCheckoutAttemptManager(() => store,() => first);
    const attempt = manager.begin(payload());
    expect(manager.pending()).toBe(attempt);
    expect(manager.begin(payload()).key).toBe(first);
  });
  it('allows a fresh purchase only after resolving the previous outcome',() => {
    const store = storage();
    const random = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const manager = createCheckoutAttemptManager(() => store,random);
    expect(manager.begin(payload()).key).toBe(first);
    manager.resolve();
    expect(manager.pending()).toBeNull();
    expect(createCheckoutAttemptManager(() => store).pending()).toBeNull();
    expect(manager.begin(payload()).key).toBe(second);
  });
  it.each(['{broken','null','{"key":"invalid","payload":{}}',JSON.stringify({key:first,payload:{lines:[],customer:{}}})])
    ('ignores invalid stored attempts: %s',saved => {
      const store = storage();
      store.setItem('farmahouse:checkout-attempt',saved);
      const manager = createCheckoutAttemptManager(() => store,() => first);
      expect(manager.pending()).toBeNull();
      expect(manager.begin(payload()).key).toBe(first);
    });
});

describe('displayed checkout quote snapshot',() => {
  it('keeps only the price guard fields, in the displayed line order',() => {
    expect(snapshotCheckoutQuote({...quote(),purchasable:true,lines:[{...quote().lines[0],name:'Champú demo',image:'/image.png'}]})).toEqual(quote());
  });
  it.each([
    {...quote(),lines:[]},
    {...quote(),lines:[quote().lines[0],quote().lines[0]]},
    {...quote(),lines:[{slug:'champu-demo',qty:1,unit_price_cents:-1}]},
    {...quote(),subtotal_cents:1.5},
    {...quote(),shipping_cents:null},
    {...quote(),total_cents:Number.MAX_SAFE_INTEGER+1},
  ])('rejects incomplete or ambiguous price guards',value => {
    expect(snapshotCheckoutQuote(value)).toBeNull();
  });
});
