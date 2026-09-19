export const orderChannels = ['WEB', 'AMAZON', 'MIRAVIA', 'CARREFOUR', 'EBAY'] as const;
export const orderStatuses = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] as const;
export const orderSupplierSituations = ['pending_dispatch', 'accepted', 'processing', 'partial', 'shipped', 'error'] as const;
export type OrderFilters = { q: string; channel: string; status: string; supplier: string; page: number };

export function readOrderFilters(search: string): OrderFilters {
  const params = new URLSearchParams(search);
  const channel = params.get('channel')?.trim() || '';
  const status = params.get('status')?.trim() || '';
  const supplier = params.get('supplier')?.trim() || '';
  const rawPage = params.get('page') || '';
  const page = /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
  return {
    q: (params.get('q') || '').trim().slice(0, 120),
    channel: orderChannels.some(value => value === channel) ? channel : '',
    status: orderStatuses.some(value => value === status) ? status : '',
    supplier: orderSupplierSituations.some(value => value === supplier) ? supplier : '',
    page: Number.isSafeInteger(page) && page >= 1 ? Math.min(page, 100000) : 1,
  };
}

export function orderListPath(filters: OrderFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim().slice(0, 120));
  if (orderChannels.some(value => value === filters.channel)) params.set('channel', filters.channel);
  if (orderStatuses.some(value => value === filters.status)) params.set('status', filters.status);
  if (orderSupplierSituations.some(value => value === filters.supplier)) params.set('supplier', filters.supplier);
  if (filters.page > 1 && Number.isSafeInteger(filters.page)) params.set('page', String(Math.min(filters.page, 100000)));
  const query = params.toString();
  return `/admin/pedidos${query ? `?${query}` : ''}`;
}

export function safeOrderReturnPath(value: string | null, origin: string): string {
  if (!value) return '/admin/pedidos';
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname !== '/admin/pedidos' || url.username || url.password) return '/admin/pedidos';
    return orderListPath(readOrderFilters(url.search));
  } catch { return '/admin/pedidos'; }
}

/** Invalidates results immediately, including while the next search is debouncing. */
export class LatestOrderRequest {
  private revision = 0;
  private controller: AbortController | undefined;

  cancel() {
    this.controller?.abort();
    this.revision++;
  }

  start() {
    this.cancel();
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    return { signal: controller.signal, isCurrent: () => revision === this.revision && !controller.signal.aborted };
  }
}
