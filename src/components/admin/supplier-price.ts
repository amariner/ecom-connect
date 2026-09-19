export type SupplierPrice = Readonly<{ price_cents: number; pvp_cents: number | null }>;
export type SupplierPriceDraft = { price: string; pvp: string };
export type SupplierPriceAttempt = Readonly<SupplierPrice & { code: string; expected_price: SupplierPrice; idempotency_key: string }>;
export type SupplierPriceResult = { demo: true; replayed: boolean; change: { code: string; before: SupplierPrice; after: SupplierPrice; changed: boolean; created_at: string } };
type AttemptStorage = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'ecom-connect:supplier-price-attempts';
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function parsePriceEuros(value: string): number {
  const text = value.trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) throw new Error('Introduce el precio en euros con un máximo de dos decimales, por ejemplo 8,90.');
  const [whole = '', decimals = ''] = text.replace(',', '.').split('.');
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 1_000_000) throw new Error('El precio debe estar entre 0 y 10.000 euros.');
  return cents;
}
export const formatPriceInput = (cents: number): string => `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;

function price(value: unknown): SupplierPrice | null {
  if (!value || typeof value !== 'object' || !('price_cents' in value) || !('pvp_cents' in value)) return null;
  const valid = (amount: unknown): amount is number => typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 && amount <= 1_000_000;
  if (!valid(value.price_cents) || (value.pvp_cents !== null && (!valid(value.pvp_cents) || value.pvp_cents <= value.price_cents))) return null;
  return Object.freeze({ price_cents: value.price_cents, pvp_cents: value.pvp_cents });
}
function attempt(value: unknown): SupplierPriceAttempt | null {
  if (!value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'string' || !value.code.trim() || value.code.trim().length > 120
    || !('idempotency_key' in value) || typeof value.idempotency_key !== 'string' || !UUID.test(value.idempotency_key) || !('expected_price' in value)) return null;
  const desired = price(value), expected = price(value.expected_price);
  return desired && expected ? Object.freeze({ code: value.code.trim(), ...desired, expected_price: expected, idempotency_key: value.idempotency_key }) : null;
}

/** Unresolved writes keep their exact price, comparison guard and identity, per product. */
export class SupplierPriceEditor {
  private drafts = new Map<string, SupplierPriceDraft>();
  private attempts = new Map<string, SupplierPriceAttempt>();
  constructor(private storage: () => AttemptStorage, private randomId: () => string = () => crypto.randomUUID()) {
    try {
      const saved: unknown = JSON.parse(storage().getItem(KEY) || '[]');
      if (Array.isArray(saved)) for (const entry of saved) { const parsed = attempt(entry); if (parsed) this.attempts.set(parsed.code, parsed); }
    } catch { /* The in-memory attempt works when storage is unavailable. */ }
  }
  private persist() {
    try { this.storage().setItem(KEY, JSON.stringify([...this.attempts.values()])); } catch { /* Preserve exact retries in this page. */ }
  }
  pending(code: string) { return this.attempts.get(code); }
  pendingCodes() { return [...this.attempts.keys()]; }
  edit(code: string, value: SupplierPriceDraft) { if (!this.pending(code)) this.drafts.set(code, { ...value }); }
  draft(code: string, current?: SupplierPrice): SupplierPriceDraft {
    const pending = this.pending(code);
    if (pending) return { price: formatPriceInput(pending.price_cents), pvp: pending.pvp_cents === null ? '' : formatPriceInput(pending.pvp_cents) };
    const draft = this.drafts.get(code);
    return draft ? { ...draft } : { price: current ? formatPriceInput(current.price_cents) : '', pvp: current?.pvp_cents == null ? '' : formatPriceInput(current.pvp_cents) };
  }
  begin(code: string, current: SupplierPrice): SupplierPriceAttempt {
    const pending = this.pending(code);
    if (pending) return pending;
    const draft = this.draft(code, current);
    const price_cents = parsePriceEuros(draft.price);
    const pvp_cents = draft.pvp.trim() ? parsePriceEuros(draft.pvp) : null;
    if (pvp_cents !== null && pvp_cents <= price_cents) throw new Error('El PVP de referencia debe superar el precio de venta. Déjalo vacío si no quieres indicarlo.');
    const frozen = attempt({ code, price_cents, pvp_cents, expected_price: current, idempotency_key: this.randomId() });
    if (!frozen) throw new Error('Consulta de nuevo los precios del proveedor antes de guardar.');
    this.attempts.set(code, frozen);
    this.persist();
    return frozen;
  }
  resolve(code: string) { this.attempts.delete(code); this.persist(); }
}

export class SupplierPriceSubmissionError extends Error {
  constructor(message: string, public readonly definitive: boolean, public readonly code?: string) { super(message); }
}
export async function submitSupplierPrice(attempt: SupplierPriceAttempt, fetcher: typeof fetch = fetch): Promise<SupplierPriceResult> {
  let response: Response;
  try {
    response = await fetcher('/api/demo/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'simulate-price', ...attempt }), signal: AbortSignal.timeout(25_000) });
  } catch { throw new SupplierPriceSubmissionError('No hemos podido comprobar el cambio. Conservamos los importes: reintenta para confirmar el mismo cambio de precio.', false); }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : undefined;
    const code = data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' ? data.code : undefined;
    throw new SupplierPriceSubmissionError(message || 'No hemos podido comprobar el resultado. Reintenta el mismo cambio de precio.', [400, 409, 413, 415].includes(response.status) && message !== undefined, code);
  }
  if (data && typeof data === 'object' && 'demo' in data && data.demo === true && 'replayed' in data && typeof data.replayed === 'boolean'
    && 'change' in data && data.change && typeof data.change === 'object') {
    const change = data.change;
    const before = 'before' in change ? price(change.before) : null;
    const after = 'after' in change ? price(change.after) : null;
    if ('code' in change && change.code === attempt.code && before && after && after.price_cents === attempt.price_cents && after.pvp_cents === attempt.pvp_cents
      && 'changed' in change && typeof change.changed === 'boolean' && 'created_at' in change && typeof change.created_at === 'string' && change.created_at) {
      return { demo: true, replayed: data.replayed, change: { code: change.code, before, after, changed: change.changed, created_at: change.created_at } };
    }
  }
  throw new SupplierPriceSubmissionError('La respuesta no permite confirmar el cambio. Conservamos los importes para reintentar la misma operación.', false);
}
