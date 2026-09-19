/**
 * Browser cart: product slugs and quantities, with local line identities and
 * applied order receipts to reconcile confirmed purchases safely. Prices are
 * never trusted or persisted here; the server recalculates them from its catalog.
 * Vanilla TypeScript, imported from Astro scripts without a UI framework.
 */

export type CartLine = { slug: string; qty: number };

const MAX_QTY = 99;
const RECEIPT = /^order:[1-9]\d*$/;
type CartDocument = { lines: CartLine[]; completed: string[]; lineage: Record<string, string> };

/**
 * Carrito NAMESPACEADO POR COLECCIÓN (9B.4): cada tienda del escaparate tiene
 * el suyo — un prospecto no debe ver zapatillas en el carrito del café. El
 * layout (Shop.astro) marca la colección activa con `data-store-collection` en
 * su wrapper; la genérica conserva su clave histórica para no vaciar carritos.
 */
function storageKey(): string {
  const id =
    document.querySelector('[data-store-collection]')?.getAttribute('data-store-collection') ?? 'demo';
  return id === 'demo' ? 'ecom-demo-cart' : `ecom-cart:${id}`;
}

function readCartDocument(): CartDocument {
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw === null) return { lines: [], completed: [], lineage: {} };
    const parsed: unknown = JSON.parse(raw);
    const document = parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version === 1
      && 'lines' in parsed && Array.isArray(parsed.lines) ? parsed : null;
    const items: unknown[] = Array.isArray(parsed) ? parsed : document && Array.isArray(document.lines) ? document.lines : [];
    const lines = items.filter(
      (line): line is CartLine =>
        typeof line === 'object' &&
        line !== null &&
        typeof (line as CartLine).slug === 'string' &&
        Number.isInteger((line as CartLine).qty) &&
        (line as CartLine).qty > 0,
    ).map(({ slug, qty }) => ({ slug, qty }));
    const completed = document && 'completed' in document && Array.isArray(document.completed)
      ? document.completed.filter((receipt): receipt is string => typeof receipt === 'string' && RECEIPT.test(receipt))
      : [];
    const lineage: Record<string, string> = {};
    if (document && 'lineage' in document && document.lineage && typeof document.lineage === 'object') {
      for (const line of lines) {
        const key = Object.getOwnPropertyDescriptor(document.lineage, line.slug)?.value;
        if (typeof key === 'string' && /^[\da-f-]{36}$/i.test(key)) Object.defineProperty(lineage, line.slug, { value: key, enumerable: true, writable: true });
      }
    }
    return { lines, completed, lineage };
  } catch {
    return { lines: [], completed: [], lineage: {} };
  }
}

export function readCart(): CartLine[] {
  return readCartDocument().lines;
}

function writeCartDocument({ lines, completed, lineage }: CartDocument, announce = true): void {
  // Quantities and applied receipts are committed together in one storage write.
  localStorage.setItem(storageKey(), JSON.stringify(completed.length || Object.keys(lineage).length ? { version: 1, lines, completed, lineage } : lines));
  if (announce) document.dispatchEvent(new CustomEvent('cart:changed', { detail: { count: cartCount() } }));
}

function writeCart(lines: CartLine[]): void {
  const current = readCartDocument();
  const lineage = Object.fromEntries(lines.flatMap(line => Object.hasOwn(current.lineage, line.slug) ? [[line.slug, current.lineage[line.slug]!]] : []));
  writeCartDocument({ lines, completed: current.completed, lineage });
}

/** A removed and later re-added product belongs to a new purchase selection. */
export function captureCartLineage(): Record<string, string> {
  const cart = readCartDocument();
  const lineage = Object.fromEntries(cart.lines.map(line => [line.slug, Object.hasOwn(cart.lineage, line.slug) ? cart.lineage[line.slug]! : crypto.randomUUID()]));
  writeCartDocument({ ...cart, lineage }, false);
  return { ...lineage };
}

/** Remove only the submitted quantities, once per confirmed order. */
export function completeCartPurchase(purchased: readonly CartLine[], receipt: string, lineage?: Record<string, string>): void {
  if (!RECEIPT.test(receipt) || !purchased.length || purchased.some(line =>
    !line.slug || !Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > MAX_QTY)) {
    throw new Error('No se pudo identificar la selección confirmada.');
  }
  const cart = readCartDocument();
  if (cart.completed.includes(receipt)) return;
  if (!lineage || purchased.some(line => !Object.hasOwn(lineage, line.slug) || typeof lineage[line.slug] !== 'string')) {
    throw new Error('Tu pedido está confirmado. Revisa la cesta antes de iniciar otra compra de prueba.');
  }
  const quantities = new Map<string, number>();
  for (const line of purchased) {
    if (Object.hasOwn(cart.lineage, line.slug) && cart.lineage[line.slug] === lineage[line.slug]) {
      quantities.set(line.slug, (quantities.get(line.slug) ?? 0) + line.qty);
    }
  }
  const remaining = cart.lines.flatMap(line => {
    const removed = Math.min(line.qty, quantities.get(line.slug) ?? 0);
    quantities.set(line.slug, (quantities.get(line.slug) ?? 0) - removed);
    return line.qty > removed ? [{ slug: line.slug, qty: line.qty - removed }] : [];
  });
  const remainingLineage = Object.fromEntries(remaining.flatMap(line => Object.hasOwn(cart.lineage, line.slug) ? [[line.slug, cart.lineage[line.slug]!]] : []));
  writeCartDocument({ lines: remaining, completed: [...cart.completed, receipt], lineage: remainingLineage });
}

export function cartCount(): number {
  return readCart().reduce((sum, line) => sum + line.qty, 0);
}

export function addToCart(slug: string, qty = 1, available = MAX_QTY): number {
  if (!Number.isFinite(qty) || !Number.isFinite(available)) return 0;
  const limit = Math.max(0, Math.min(MAX_QTY, Math.floor(available)));
  const requested = Math.max(0, Math.floor(qty));
  const lines = readCart();
  const existing = lines.find((line) => line.slug === slug);
  const added = Math.min(requested, Math.max(0, limit - (existing?.qty ?? 0)));
  if (!added) return 0;
  if (existing) {
    existing.qty += added;
  } else {
    lines.push({ slug, qty: added });
  }
  writeCart(lines);
  return added;
}

export function setQty(slug: string, qty: number): void {
  let lines = readCart();
  if (qty <= 0) {
    lines = lines.filter((line) => line.slug !== slug);
  } else {
    const existing = lines.find((line) => line.slug === slug);
    if (existing) existing.qty = Math.min(qty, MAX_QTY);
  }
  writeCart(lines);
}

export function removeFromCart(slug: string): void {
  setQty(slug, 0);
}

export function clearCart(): void {
  writeCart([]);
}

/** Pinta el contador del header y lo mantiene al día. */
export function bindCartBadge(el: HTMLElement): void {
  const render = () => {
    const count = cartCount();
    el.textContent = String(count);
    el.classList.toggle('hidden', count === 0);
  };
  render();
  document.addEventListener('cart:changed', render);
  window.addEventListener('storage', render);
}
