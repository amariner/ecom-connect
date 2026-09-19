import { describe, expect, it } from 'vitest';
import { LatestOrderRequest, orderListPath, readOrderFilters, safeOrderReturnPath } from '../src/components/admin/order-pagination';

describe('order history URL state', () => {
  it('round-trips historical search, channel, status and page through the detail return link', () => {
    const filters = { q: 'FH-123 + envío & demo', channel: 'AMAZON', status: 'shipped', page: 4 };
    const path = orderListPath(filters);
    const detail = `/admin/pedidos/3?return=${encodeURIComponent(path)}`;
    const returnValue = new URL(detail, 'https://demo.test').searchParams.get('return');
    expect(safeOrderReturnPath(returnValue, 'https://demo.test')).toBe(path);
    expect(readOrderFilters(new URL(path, 'https://demo.test').search)).toEqual(filters);
  });

  it('sanitizes invalid filters and pagination before requesting the API', () => {
    expect(readOrderFilters('?page=-2&channel=UNKNOWN&status=processing&q=%20pedido%20')).toEqual({ q: 'pedido', channel: '', status: '', page: 1 });
    expect(readOrderFilters('?page=1.5').page).toBe(1);
    expect(readOrderFilters('?page=100001').page).toBe(100000);
    expect(readOrderFilters('?page=999999999999999999999').page).toBe(1);
    expect(readOrderFilters(`?q=${'a'.repeat(150)}`).q).toHaveLength(120);
  });

  it('omits default state and unrelated parameters from canonical history URLs', () => {
    expect(orderListPath({ q: '', channel: '', status: '', page: 1 })).toBe('/admin/pedidos');
    expect(safeOrderReturnPath('/admin/pedidos?page=2&return=https://outside.test&extra=secret#fragment', 'https://demo.test')).toBe('/admin/pedidos?page=2');
  });

  it.each(['https://outside.test/admin/pedidos', '//outside.test/admin/pedidos', 'javascript:alert(1)', '/admin/configuracion', '/admin/pedidos/3', 'https://user:password@demo.test/admin/pedidos'])('rejects unsafe return destination %s', value => {
    expect(safeOrderReturnPath(value, 'https://demo.test')).toBe('/admin/pedidos');
  });

  it('keeps all valid status filters available even when absent from the recent-order snapshot', () => {
    expect(readOrderFilters('?status=cancelled&channel=WEB&page=7')).toEqual({ q: '', channel: 'WEB', status: 'cancelled', page: 7 });
  });
});

describe('order history request ordering', () => {
  it('invalidates an in-flight response immediately while a later search is still debouncing', () => {
    const requests = new LatestOrderRequest();
    const first = requests.start();
    expect(first.isCurrent()).toBe(true);
    requests.cancel();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    const latest = requests.start();
    expect(latest.isCurrent()).toBe(true);
  });

  it('ignores a slower previous response even if its transport resolves after abort', async () => {
    const requests = new LatestOrderRequest();
    let resolveOld!: (value: string) => void;
    const oldResponse = new Promise<string>(resolve => { resolveOld = resolve; });
    const first = requests.start();
    let rendered = '';
    const previous = oldResponse.then(value => { if (first.isCurrent()) rendered = value; });
    const current = requests.start();
    if (current.isCurrent()) rendered = 'Latest page';
    resolveOld('Outdated page');
    await previous;
    expect(rendered).toBe('Latest page');
    expect(first.signal.aborted).toBe(true);
  });
});
