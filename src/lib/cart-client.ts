/**
 * Carrito del lado cliente: SOLO slugs y cantidades en localStorage.
 * En los escaparates públicos, los precios salen del catálogo inmutable
 * embebido y nunca se envían al servidor.
 * Vanilla TS — se importa desde <script> de Astro (islas sin framework).
 */

export type CartLine = { slug: string; qty: number };

const MAX_QTY = 99;

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

export function readCart(): CartLine[] {
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (line): line is CartLine =>
        typeof line === 'object' &&
        line !== null &&
        typeof (line as CartLine).slug === 'string' &&
        Number.isInteger((line as CartLine).qty) &&
        (line as CartLine).qty > 0,
    );
  } catch {
    return [];
  }
}

function writeCart(lines: CartLine[]): void {
  localStorage.setItem(storageKey(), JSON.stringify(lines));
  document.dispatchEvent(new CustomEvent('cart:changed', { detail: { count: cartCount() } }));
}

export function cartCount(): number {
  return readCart().reduce((sum, line) => sum + line.qty, 0);
}

export function addToCart(slug: string, qty = 1): void {
  const lines = readCart();
  const existing = lines.find((line) => line.slug === slug);
  if (existing) {
    existing.qty = Math.min(existing.qty + qty, MAX_QTY);
  } else {
    lines.push({ slug, qty: Math.min(qty, MAX_QTY) });
  }
  writeCart(lines);
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
}
