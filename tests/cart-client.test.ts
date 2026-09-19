import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addToCart, cartCount, clearCart, readCart, removeFromCart, setQty } from '../src/lib/cart-client';

let collection: string | null;
let storage: Map<string,string>;
let dispatchEvent: ReturnType<typeof vi.fn>;
let setItem: ReturnType<typeof vi.fn>;

beforeEach(() => {
  collection = 'farmahouse';
  storage = new Map();
  dispatchEvent = vi.fn();
  setItem = vi.fn((key: string,value: string) => storage.set(key,value));
  vi.stubGlobal('document',{
    querySelector:() => collection === null ? null : {getAttribute:() => collection},
    dispatchEvent,
  });
  vi.stubGlobal('localStorage',{
    getItem:(key: string) => storage.get(key) ?? null,
    setItem,
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('cart quantity and stock limits',() => {
  it('stores only slug and quantity and reports the quantity actually added',() => {
    expect(addToCart('champu-demo',2,8)).toBe(2);
    expect(readCart()).toEqual([{slug:'champu-demo',qty:2}]);
    expect(storage.get('ecom-cart:farmahouse')).toBe('[{"slug":"champu-demo","qty":2}]');
    expect(cartCount()).toBe(2);
    expect(dispatchEvent).toHaveBeenCalledOnce();
    const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<{count:number}>;
    expect(event.type).toBe('cart:changed');
    expect(event.detail).toEqual({count:2});
  });

  it('limits repeated additions to available stock and stops emitting changes at the limit',() => {
    expect(addToCart('champu-demo',3,5)).toBe(3);
    expect(addToCart('champu-demo',4,5)).toBe(2);
    expect(addToCart('champu-demo',1,5)).toBe(0);
    expect(readCart()).toEqual([{slug:'champu-demo',qty:5}]);
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it('caps a product at 99 units even when the supplier has more stock',() => {
    expect(addToCart('champu-demo',98,200)).toBe(98);
    expect(addToCart('champu-demo',50,200)).toBe(1);
    expect(addToCart('champu-demo',1,200)).toBe(0);
    expect(cartCount()).toBe(99);
  });

  it('does not silently remove an existing quantity when newer stock is lower',() => {
    addToCart('champu-demo',5,10);
    expect(addToCart('champu-demo',1,3)).toBe(0);
    expect(readCart()).toEqual([{slug:'champu-demo',qty:5}]);
    expect(setItem).toHaveBeenCalledOnce();
  });

  it.each([0,-1,0.8,NaN,Infinity,-Infinity])('does not add an invalid quantity (%s)',qty => {
    expect(addToCart('champu-demo',qty,10)).toBe(0);
    expect(readCart()).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each([0,-1,0.8,NaN,Infinity,-Infinity])('does not add a product without finite positive stock (%s)',stock => {
    expect(addToCart('champu-demo',1,stock)).toBe(0);
    expect(readCart()).toEqual([]);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('uses complete units for fractional quantity and availability',() => {
    expect(addToCart('champu-demo',4.9,3.8)).toBe(3);
    expect(readCart()).toEqual([{slug:'champu-demo',qty:3}]);
  });

  it('keeps each product quantity independent',() => {
    addToCart('champu-demo',3,3);
    expect(addToCart('gel-demo',2,5)).toBe(2);
    expect(cartCount()).toBe(5);
    expect(readCart()).toHaveLength(2);
  });

  it('updates, removes and clears lines while keeping the 99-unit cap',() => {
    addToCart('champu-demo',2);
    addToCart('gel-demo',1);
    setQty('champu-demo',200);
    expect(readCart()).toEqual([{slug:'champu-demo',qty:99},{slug:'gel-demo',qty:1}]);
    removeFromCart('champu-demo');
    expect(readCart()).toEqual([{slug:'gel-demo',qty:1}]);
    clearCart();
    expect(cartCount()).toBe(0);
  });

  it('isolates collections and preserves the original demo storage key',() => {
    addToCart('champu-demo',2);
    collection = 'otra-demo';
    expect(readCart()).toEqual([]);
    addToCart('otro-producto',1);
    collection = null;
    expect(readCart()).toEqual([]);
    addToCart('producto-generico',3);
    collection = 'demo';
    expect(readCart()).toEqual([{slug:'producto-generico',qty:3}]);
    collection = 'farmahouse';
    expect(readCart()).toEqual([{slug:'champu-demo',qty:2}]);
    expect(storage.get('ecom-demo-cart')).toBe('[{"slug":"producto-generico","qty":3}]');
  });

  it('recovers from corrupt browser storage without importing invalid lines',() => {
    storage.set('ecom-cart:farmahouse','{broken');
    expect(readCart()).toEqual([]);
    storage.set('ecom-cart:farmahouse',JSON.stringify([null,{slug:'zero',qty:0},{slug:'fraction',qty:1.5},{slug:4,qty:1},{slug:'champu-demo',qty:2}]));
    expect(readCart()).toEqual([{slug:'champu-demo',qty:2}]);
  });
});
