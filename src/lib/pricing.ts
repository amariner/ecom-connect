/**
 * Lógica de precios. Pura, sin I/O: los precios entran ya leídos de D1.
 * Todo en céntimos enteros — jamás floats.
 */

export type PriceableLine = {
  unit_price_cents: number;
  qty: number;
};

export type ShippingRate = {
  price_cents: number;
  /** null = nunca hay envío gratis */
  free_over_cents: number | null;
};

export type QuoteTotals = {
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
};

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} debe ser un entero positivo, recibido: ${value}`);
  }
}

export function computeSubtotalCents(lines: readonly PriceableLine[]): number {
  return lines.reduce((sum, line) => {
    assertPositiveInt(line.qty, 'qty');
    if (!Number.isInteger(line.unit_price_cents) || line.unit_price_cents < 0) {
      throw new Error(`unit_price_cents inválido: ${line.unit_price_cents}`);
    }
    return sum + line.unit_price_cents * line.qty;
  }, 0);
}

export function computeShippingCents(subtotalCents: number, rate: ShippingRate): number {
  if (subtotalCents <= 0) return 0; // carrito vacío: nada que enviar
  if (rate.free_over_cents !== null && subtotalCents >= rate.free_over_cents) return 0;
  return rate.price_cents;
}

export function quoteTotals(lines: readonly PriceableLine[], rate: ShippingRate): QuoteTotals {
  const subtotal_cents = computeSubtotalCents(lines);
  const shipping_cents = computeShippingCents(subtotal_cents, rate);
  return { subtotal_cents, shipping_cents, total_cents: subtotal_cents + shipping_cents };
}
