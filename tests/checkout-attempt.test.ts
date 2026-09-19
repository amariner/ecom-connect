import { describe, expect, it } from 'vitest';
import { createCheckoutAttemptKey } from '../src/components/shop/checkout-attempt';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
describe('checkout retry identity', () => {
  it('reuses an attempt when browser storage access is denied', () => {
    let calls = 0;
    const key = createCheckoutAttemptKey(() => { throw new Error('Storage denied'); }, () => { calls++; return first; });
    expect(key('same purchase')).toBe(first);
    expect(key('same purchase')).toBe(first);
    expect(calls).toBe(1);
  });
  it('keeps the retry identity when storage writes fail', () => {
    let calls = 0;
    const key = createCheckoutAttemptKey(() => ({ getItem: () => null, setItem: () => { throw new Error('Quota'); } }), () => { calls++; return first; });
    expect(key('same purchase')).toBe(first);
    expect(key('same purchase')).toBe(first);
    expect(calls).toBe(1);
  });
  it('recovers the persisted identity after a page reload', () => {
    let value: string | null = null;
    const storage = () => ({ getItem: () => value, setItem: (_key: string, next: string) => { value = next; } });
    expect(createCheckoutAttemptKey(storage, () => first)('purchase')).toBe(first);
    expect(createCheckoutAttemptKey(storage, () => second)('purchase')).toBe(first);
  });
  it('starts a fresh identity when the purchase changes', () => {
    let calls = 0;
    const key = createCheckoutAttemptKey(() => ({ getItem: () => null, setItem: () => {} }), () => calls++ ? second : first);
    expect(key('one unit')).toBe(first);
    expect(key('two units')).toBe(second);
    expect(key('two units')).toBe(second);
  });
  it.each(['{broken', 'null', '{"key":"invalid","payload":"purchase"}'])('ignores corrupt or invalid persisted attempts: %s', saved => {
    const key = createCheckoutAttemptKey(() => ({ getItem: () => saved, setItem: () => {} }), () => first);
    expect(key('purchase')).toBe(first);
  });
});
