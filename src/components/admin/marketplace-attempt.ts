export const MARKETPLACE_CHANNELS = ['AMAZON','MIRAVIA','CARREFOUR','EBAY'] as const;
export type MarketplaceChannel = typeof MARKETPLACE_CHANNELS[number];
export type MarketplaceOrderDraft = Readonly<{ channel: MarketplaceChannel; slug: string; qty: number; product_name?: string }>;
export type MarketplaceOrderAttempt = Readonly<MarketplaceOrderDraft & { idempotency_key: string }>;
export type MarketplaceOrderResult = { order_id: number; order_number: string; supplier_warning?: string; marketplace_warning?: string; feed_warning?: string };
type AttemptStorage = Pick<Storage, 'getItem' | 'setItem'>;
const STORAGE_KEY = 'ecom-connect:marketplace-attempts';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const RESTORE_WARNING = 'No hemos podido recuperar todos los intentos guardados. Revisa el historial de pedidos antes de simular otra compra.';

function parseAttempt(value: unknown): MarketplaceOrderAttempt | null {
  if (!value || typeof value !== 'object' || !('channel' in value) || !MARKETPLACE_CHANNELS.includes(value.channel as MarketplaceChannel)
    || !('slug' in value) || typeof value.slug !== 'string' || !value.slug.trim() || value.slug.length > 120
    || !('qty' in value) || typeof value.qty !== 'number' || !Number.isInteger(value.qty) || value.qty < 1 || value.qty > 99
    || !('idempotency_key' in value) || typeof value.idempotency_key !== 'string' || !UUID.test(value.idempotency_key)) return null;
  const name = 'product_name' in value && typeof value.product_name === 'string' && value.product_name.trim() && value.product_name.length <= 200
    ? value.product_name : undefined;
  return Object.freeze({channel:value.channel as MarketplaceChannel,slug:value.slug,qty:value.qty,idempotency_key:value.idempotency_key,
    ...(name ? {product_name:name} : {})});
}

function parseLegacyEntry(entry: unknown): MarketplaceOrderAttempt | null {
  if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return null;
  try {
    const tuple: unknown = JSON.parse(entry[0]);
    return Array.isArray(tuple) && tuple.length === 3
      ? parseAttempt({channel:tuple[0],slug:tuple[1],qty:tuple[2],idempotency_key:entry[1]}) : null;
  } catch { return null; }
}

/** A pending channel owns its command; catalog changes never replace its identity. */
export class MarketplaceOrderEditor {
  private attempts = new Map<MarketplaceChannel, MarketplaceOrderAttempt[]>();
  private available = true;
  private warning = '';
  constructor(private storage: () => AttemptStorage, private randomId: () => string = () => crypto.randomUUID()) {
    let raw: string | null;
    try { raw = storage().getItem(STORAGE_KEY); }
    catch { this.available = false; this.warning = RESTORE_WARNING; return; }
    if (!raw) return;
    try {
      const saved: unknown = JSON.parse(raw);
      const legacy = Array.isArray(saved);
      const entries = legacy ? saved : saved && typeof saved === 'object' && 'version' in saved && saved.version === 1
        && 'attempts' in saved && Array.isArray(saved.attempts) ? saved.attempts : null;
      if (!entries) { this.warning = RESTORE_WARNING; return; }
      const parsed: MarketplaceOrderAttempt[] = [];
      for (const entry of entries) {
        const attempt = legacy ? parseLegacyEntry(entry) : parseAttempt(entry);
        if (attempt) parsed.push(attempt);
        else this.warning = RESTORE_WARNING;
      }
      const seen = new Map<string,string>();
      const conflicts = new Set<string>();
      for (const attempt of parsed) {
        const payload = JSON.stringify([attempt.channel,attempt.slug,attempt.qty]);
        if (seen.has(attempt.idempotency_key) && seen.get(attempt.idempotency_key) !== payload) conflicts.add(attempt.idempotency_key);
        seen.set(attempt.idempotency_key,payload);
      }
      if (conflicts.size) this.warning = RESTORE_WARNING;
      const restored = new Set<string>();
      for (const attempt of parsed) {
        if (conflicts.has(attempt.idempotency_key) || restored.has(attempt.idempotency_key)) continue;
        restored.add(attempt.idempotency_key);
        const queue = this.attempts.get(attempt.channel) ?? [];
        queue.push(attempt);
        this.attempts.set(attempt.channel,queue);
      }
    } catch { this.warning = RESTORE_WARNING; }
  }
  private persist() {
    try {
      this.storage().setItem(STORAGE_KEY,JSON.stringify({version:1,attempts:[...this.attempts.values()].flat()}));
      this.available = true;
    } catch { this.available = false; }
  }
  get storageAvailable() { return this.available; }
  get restoreWarning() { return this.warning; }
  pending(channel: string) { return this.attempts.get(channel as MarketplaceChannel)?.[0]; }
  pendingChannels() { return [...this.attempts.keys()]; }
  begin(draft: MarketplaceOrderDraft): MarketplaceOrderAttempt {
    const pending = this.pending(draft.channel);
    if (pending) return pending;
    const attempt = parseAttempt({...draft,idempotency_key:this.randomId()});
    if (!attempt) throw new Error('Revisa el canal, el producto y la cantidad antes de simular el pedido.');
    this.attempts.set(attempt.channel,[attempt]);
    this.persist();
    return attempt;
  }
  resolve(channel: string) {
    const queue = this.attempts.get(channel as MarketplaceChannel);
    if (!queue) return;
    queue.shift();
    if (!queue.length) this.attempts.delete(channel as MarketplaceChannel);
    this.persist();
  }
}

export class MarketplaceOrderSubmissionError extends Error {
  constructor(message: string, public readonly definitive: boolean) { super(message); }
}

/** Recover the same order without requesting availability or inventing a new UUID. */
export async function submitMarketplaceOrder(attempt: MarketplaceOrderAttempt, fetcher: typeof fetch = fetch): Promise<MarketplaceOrderResult> {
  let response: Response;
  try {
    response = await fetcher('/api/demo/action',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'simulate-order',channel:attempt.channel,slug:attempt.slug,qty:attempt.qty,idempotency_key:attempt.idempotency_key}),
      signal:AbortSignal.timeout(25_000)});
  } catch {
    throw new MarketplaceOrderSubmissionError('No hemos podido comprobar el pedido. Conservamos su referencia: reintenta la confirmación para recuperar el mismo pedido.',false);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' && data.error.trim() ? data.error : undefined;
    throw new MarketplaceOrderSubmissionError(message || 'No hemos podido comprobar el resultado. Reintenta la confirmación del mismo pedido.',
      [400,409,413,415].includes(response.status) && message !== undefined);
  }
  if (!data || typeof data !== 'object' || ('ok' in data && data.ok === false) || 'error' in data
    || !('order_id' in data) || typeof data.order_id !== 'number' || !Number.isSafeInteger(data.order_id) || data.order_id < 1
    || !('order_number' in data) || typeof data.order_number !== 'string' || !data.order_number.trim() || data.order_number.length > 160) {
    throw new MarketplaceOrderSubmissionError('La respuesta no confirma el pedido. Conservamos el intento para poder recuperarlo sin duplicarlo.',false);
  }
  const result: MarketplaceOrderResult = {order_id:data.order_id,order_number:data.order_number};
  const fields = data as Record<string,unknown>;
  for (const field of ['supplier_warning','marketplace_warning','feed_warning'] as const) {
    const warning = fields[field];
    if (typeof warning === 'string' && warning.trim()) result[field] = warning;
  }
  return result;
}
