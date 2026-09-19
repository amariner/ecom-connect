import type { CartLine } from '../../lib/cart-client';

type ConfirmationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type PendingConfirmation = { url: string; receipt: string; lines: CartLine[]; lineage?: Record<string, string> };

function pendingConfirmation(value: string | null): PendingConfirmation | null {
  try {
    const parsed: unknown = JSON.parse(value || 'null');
    if (!parsed || typeof parsed !== 'object' || !('url' in parsed) || typeof parsed.url !== 'string'
      || !('receipt' in parsed) || typeof parsed.receipt !== 'string' || !('lines' in parsed)
      || !Array.isArray(parsed.lines) || !parsed.lines.length) return null;
    if (!parsed.lines.every(line => line && typeof line === 'object' && typeof line.slug === 'string'
      && line.slug.length > 0 && Number.isSafeInteger(line.qty) && line.qty >= 1 && line.qty <= 99)) return null;
    const lineage = 'lineage' in parsed && parsed.lineage && typeof parsed.lineage === 'object'
      && Object.values(parsed.lineage).every(value => typeof value === 'string')
      ? Object.fromEntries(Object.entries(parsed.lineage)) as Record<string, string> : undefined;
    return { url: parsed.url, receipt: parsed.receipt, lines: parsed.lines.map(({ slug, qty }) => ({ slug, qty })), ...(lineage ? { lineage } : {}) };
  } catch { return null; }
}

/** An old confirmation link must never clear a newer basket. */
export function reconcileConfirmationCart(
  url: string,
  receipt: string,
  storage: () => ConfirmationStorage,
  complete: (lines: readonly CartLine[], receipt: string, lineage?: Record<string, string>) => void,
): 'updated' | 'pending' | 'unrelated' {
  let pending: PendingConfirmation | null;
  try { pending = pendingConfirmation(storage().getItem('farmahouse:pending-confirmation')); }
  catch { return 'unrelated'; }
  if (!pending || pending.url !== url || pending.receipt !== receipt) return 'unrelated';
  try { complete(pending.lines, receipt, pending.lineage); }
  catch { return 'pending'; }
  // The cart receipt makes retries harmless even if session cleanup fails.
  try {
    storage().removeItem('farmahouse:pending-confirmation');
    storage().removeItem('farmahouse:checkout-attempt');
  } catch { /* The confirmed receipt is already committed with the basket. */ }
  return 'updated';
}
