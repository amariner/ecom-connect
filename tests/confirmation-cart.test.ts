import { describe, expect, it, vi } from 'vitest';
import { reconcileConfirmationCart } from '../src/components/shop/confirmation-cart';

const url = '/gracias?session=demo_fake';
const receipt = 'order:42';
const lines = [{ slug: 'champu-demo', qty: 2 }];
const lineage = { 'champu-demo': '11111111-1111-4111-8111-111111111111' };
function storage(value: string | null) {
  const values = new Map<string, string>();
  if (value !== null) values.set('farmahouse:pending-confirmation', value);
  values.set('farmahouse:checkout-attempt', 'pending attempt');
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('confirmation page basket recovery', () => {
  it('only reconciles the exact confirmed order and removes the pending handoff', () => {
    const session = storage(JSON.stringify({ url, receipt, lines, lineage }));
    const complete = vi.fn();
    expect(reconcileConfirmationCart(url, receipt, () => session, complete)).toBe('updated');
    expect(complete).toHaveBeenCalledWith(lines, receipt, lineage);
    expect(session.getItem('farmahouse:pending-confirmation')).toBeNull();
    expect(session.getItem('farmahouse:checkout-attempt')).toBeNull();
    expect(reconcileConfirmationCart(url, receipt, () => session, complete)).toBe('unrelated');
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each([
    null, '{broken', 'null', JSON.stringify(url),
    JSON.stringify({ url: '/gracias?session=older', receipt, lines }),
    JSON.stringify({ url, receipt: 'order:41', lines }),
    JSON.stringify({ url, receipt, lines: [{ slug: 'champu-demo', qty: -1 }] }),
  ])('preserves the basket for old, unrelated or invalid confirmations: %s', value => {
    const complete = vi.fn();
    expect(reconcileConfirmationCart(url, receipt, () => storage(value), complete)).toBe('unrelated');
    expect(complete).not.toHaveBeenCalled();
  });

  it('keeps the handoff for a retry when updating the basket fails', () => {
    const session = storage(JSON.stringify({ url, receipt, lines }));
    expect(reconcileConfirmationCart(url, receipt, () => session, () => { throw new Error('Quota'); })).toBe('pending');
    expect(session.getItem('farmahouse:pending-confirmation')).not.toBeNull();
    expect(reconcileConfirmationCart(url, receipt, () => session, vi.fn())).toBe('updated');
  });

  it('does not block the confirmed order when session storage is unavailable', () => {
    const complete = vi.fn();
    expect(reconcileConfirmationCart(url, receipt, () => { throw new Error('Denied'); }, complete)).toBe('unrelated');
    expect(complete).not.toHaveBeenCalled();
  });
});
