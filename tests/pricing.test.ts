import { describe, expect, it } from 'vitest';
import { computeShippingCents, computeSubtotalCents, quoteTotals } from '../src/lib/pricing';

const rate = { price_cents: 490, free_over_cents: 5000 };
const rateNeverFree = { price_cents: 1490, free_over_cents: null };

describe('computeSubtotalCents', () => {
  it('suma qty × precio unitario en céntimos enteros', () => {
    expect(
      computeSubtotalCents([
        { unit_price_cents: 1250, qty: 2 },
        { unit_price_cents: 890, qty: 1 },
      ]),
    ).toBe(3390);
  });

  it('carrito vacío = 0', () => {
    expect(computeSubtotalCents([])).toBe(0);
  });

  it('rechaza cantidades y precios inválidos', () => {
    expect(() => computeSubtotalCents([{ unit_price_cents: 100, qty: 0 }])).toThrow();
    expect(() => computeSubtotalCents([{ unit_price_cents: 100, qty: -1 }])).toThrow();
    expect(() => computeSubtotalCents([{ unit_price_cents: 100, qty: 1.5 }])).toThrow();
    expect(() => computeSubtotalCents([{ unit_price_cents: 10.5, qty: 1 }])).toThrow();
    expect(() => computeSubtotalCents([{ unit_price_cents: -100, qty: 1 }])).toThrow();
  });
});

describe('computeShippingCents', () => {
  it('cobra la tarifa por debajo del umbral', () => {
    expect(computeShippingCents(4999, rate)).toBe(490);
  });

  it('gratis al alcanzar exactamente el umbral', () => {
    expect(computeShippingCents(5000, rate)).toBe(0);
    expect(computeShippingCents(9000, rate)).toBe(0);
  });

  it('sin umbral (null) nunca es gratis', () => {
    expect(computeShippingCents(999999, rateNeverFree)).toBe(1490);
  });

  it('carrito vacío no genera portes', () => {
    expect(computeShippingCents(0, rate)).toBe(0);
  });
});

describe('quoteTotals', () => {
  it('total = subtotal + portes', () => {
    const lines = [
      { unit_price_cents: 1250, qty: 2 }, // 2500
      { unit_price_cents: 890, qty: 2 }, // 1780
    ];
    const q = quoteTotals(lines, rate); // subtotal 4280 < 5000
    expect(q).toEqual({ subtotal_cents: 4280, shipping_cents: 490, total_cents: 4770 });
  });

  it('aplica envío gratis en el total', () => {
    const q = quoteTotals([{ unit_price_cents: 2500, qty: 2 }], rate);
    expect(q).toEqual({ subtotal_cents: 5000, shipping_cents: 0, total_cents: 5000 });
  });
});
