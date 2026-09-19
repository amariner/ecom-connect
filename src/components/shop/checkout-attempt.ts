import type { CartLine } from '../../lib/cart-client';

export type CheckoutCustomer = { name: string; email: string; street: string; city: string; postal_code: string };
export type CheckoutExpectedQuote = Readonly<{
  lines: readonly Readonly<{ slug: string; qty: number; unit_price_cents: number }>[];
  subtotal_cents: number; shipping_cents: number; total_cents: number;
}>;
export type CheckoutPayload = Readonly<{ lines: readonly CartLine[]; customer: Readonly<CheckoutCustomer>; expected_quote?: CheckoutExpectedQuote }>;
export type CheckoutAttempt = { key: string; payload: CheckoutPayload; lineage?: Record<string,string> };
type AttemptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const STORAGE_KEY = 'farmahouse:checkout-attempt';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_FIELDS = ['name','email','street','city','postal_code'] as const;

/** The displayed quote is a comparison guard; the server still calculates every price. */
export function snapshotCheckoutQuote(value: unknown): CheckoutExpectedQuote | null {
  if (!value || typeof value !== 'object' || !('lines' in value) || !Array.isArray(value.lines)
    || !value.lines.length || value.lines.length > 50) return null;
  const cents = (amount: unknown): amount is number => typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0;
  if (!('subtotal_cents' in value) || !cents(value.subtotal_cents) || !('shipping_cents' in value) || !cents(value.shipping_cents)
    || !('total_cents' in value) || !cents(value.total_cents)) return null;
  const seen = new Set<string>();
  const lines: { slug: string; qty: number; unit_price_cents: number }[] = [];
  for (const line of value.lines) {
    if (!line || typeof line !== 'object' || typeof line.slug !== 'string' || !line.slug || line.slug.length > 120
      || seen.has(line.slug) || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 99 || !cents(line.unit_price_cents)) return null;
    seen.add(line.slug);
    lines.push(Object.freeze({ slug: line.slug, qty: line.qty, unit_price_cents: line.unit_price_cents }));
  }
  return Object.freeze({ lines: Object.freeze(lines), subtotal_cents: value.subtotal_cents,
    shipping_cents: value.shipping_cents, total_cents: value.total_cents });
}

function snapshotLineage(value: unknown): Record<string,string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([slug,id]) => !slug || typeof id !== 'string' || !id)) return undefined;
  return Object.freeze(Object.fromEntries(entries)) as Record<string,string>;
}

function parsePayload(raw: unknown): CheckoutPayload | null {
  if (!raw || typeof raw !== 'object' || !('lines' in raw) || !('customer' in raw)) return null;
  if (!Array.isArray(raw.lines) || !raw.lines.length || raw.lines.length > 50) return null;
  const lines: CartLine[] = [];
  for (const line of raw.lines) {
    if (!line || typeof line !== 'object' || typeof line.slug !== 'string' || !line.slug || line.slug.length > 120 ||
      !Number.isInteger(line.qty) || line.qty < 1 || line.qty > 99) return null;
    lines.push(Object.freeze({slug:line.slug,qty:line.qty}));
  }
  if (!raw.customer || typeof raw.customer !== 'object') return null;
  const customer = raw.customer as Record<string,unknown>;
  if (CUSTOMER_FIELDS.some(field => typeof customer[field] !== 'string' || (customer[field] as string).length > 200)) return null;
  const expected = 'expected_quote' in raw ? snapshotCheckoutQuote(raw.expected_quote) : undefined;
  if (expected === null) return null;
  return Object.freeze({
    lines:Object.freeze(lines),
    customer:Object.freeze(Object.fromEntries(CUSTOMER_FIELDS.map(field => [field,customer[field]]))) as CheckoutCustomer,
    ...(expected ? { expected_quote: expected } : {}),
  });
}

/** An unresolved purchase owns its payload and identity until the server answers. */
export function createCheckoutAttemptManager(storage: () => AttemptStorage, randomId: () => string = () => crypto.randomUUID()) {
  let current: CheckoutAttempt | null = null;
  try {
    const saved: unknown = JSON.parse(storage().getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object' && 'key' in saved && typeof saved.key === 'string' && UUID.test(saved.key) && 'payload' in saved) {
      // Compatibility with attempts written before full recovery was available.
      const payload = parsePayload(typeof saved.payload === 'string' ? JSON.parse(saved.payload) : saved.payload);
      const lineage = snapshotLineage('lineage' in saved ? saved.lineage : undefined);
      if (payload) current = Object.freeze({key:saved.key,payload,...(lineage ? {lineage} : {})});
    }
  } catch { /* The same-page attempt remains usable when browser storage is unavailable. */ }
  return {
    pending:() => current,
    begin(payload: CheckoutPayload,lineage?: Record<string,string>): CheckoutAttempt {
      if (current) return current;
      const snapshot = parsePayload(payload);
      if (!snapshot) throw new Error('Revisa los productos y los datos de tu pedido antes de continuar.');
      const lineageSnapshot = snapshotLineage(lineage);
      current = Object.freeze({key:randomId(),payload:snapshot,...(lineageSnapshot ? {lineage:lineageSnapshot} : {})});
      try { storage().setItem(STORAGE_KEY,JSON.stringify(current)); } catch { /* Keep the in-memory snapshot. */ }
      return current;
    },
    resolve(): void {
      current = null;
      try { storage().removeItem(STORAGE_KEY); } catch { /* A retained saved attempt can only replay the original purchase. */ }
    },
  };
}
