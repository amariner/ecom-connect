import { describe, expect, it } from 'vitest';
import { buildLighthouseProductsExtraInfo } from '../src/integrations/lighthouse-api-contract';

describe('Lighthouse Products/ExtraInfo offline contract', () => {
  it('uses the feed gID, numeric CMS IDs, explicit stock, decimal prices and proportional VAT', () => {
    expect(buildLighthouseProductsExtraInfo([{ gId: '000-FH-DEMO-1', stock: 7, cmsId: 12, cmsVariantId: 25, priceCents: 1590, salePriceCents: 1290, costPriceCents: 829, vatPercent: 21 }])).toEqual([
      { id: '000-FH-DEMO-1', stock: 7, cmsID: 12, cmsSubID: 25, price: 15.9, salePrice: 12.9, costPrice: 8.29, taxRate: 0.21 },
    ]);
  });

  it('omits unprovided fields and preserves explicit zeroes without changing remote prices', () => {
    expect(buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 0 }])).toEqual([{ id: 'DEMO-1', stock: 0 }]);
    expect(buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 0, priceCents: 0, salePriceCents: 0, costPriceCents: 0, vatPercent: 0 }])).toEqual([
      { id: 'DEMO-1', stock: 0, price: 0, salePrice: 0, costPrice: 0, taxRate: 0 },
    ]);
  });

  it('rejects omitted stock and invalid int32 quantities instead of triggering Lighthouse default-to-zero', () => {
    for (const stock of [undefined, null, '', '7', -1, 1.5, Number.NaN, 2147483648]) {
      expect(() => buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock }])).toThrow();
    }
    expect(() => buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1' }])).toThrow();
    expect(buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 2147483647 }])[0]?.stock).toBe(2147483647);
  });

  it('requires an exact textual gID and does not coerce supplier or database identifiers', () => {
    for (const gId of ['', ' ', 123, null, ' DEMO-1', 'DEMO-1 ']) {
      expect(() => buildLighthouseProductsExtraInfo([{ gId, stock: 1 }])).toThrow();
    }
    expect(() => buildLighthouseProductsExtraInfo([{ id: 123, supplierSku: 'SUP-DEMO-1', stock: 1 }])).toThrow();
    expect(() => buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 1 }, { gId: 'DEMO-1', stock: 2 }])).toThrow('repetido');
  });

  it('rejects int64 CMS identifiers that cannot be represented safely in JavaScript', () => {
    for (const cmsId of ['12', 1.5, -1, null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 1, cmsId }])).toThrow();
    }
    expect(buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 1, cmsId: Number.MAX_SAFE_INTEGER }])[0]?.cmsID).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects monetary ambiguity, unsafe wire decimals, nulls and sale prices without their base price', () => {
    for (const priceCents of [12.5, '1290', null, -1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
      expect(() => buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 1, priceCents }])).toThrow();
    }
    expect(() => buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 1, salePriceCents: 100 }])).toThrow();
    const body = buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 1, priceCents: 29, costPriceCents: 7 }]);
    expect(JSON.stringify(body)).toBe('[{"id":"DEMO-1","stock":1,"price":0.29,"costPrice":0.07}]');
  });

  it('rejects fractional input VAT that confuses a percentage with a ratio', () => {
    for (const vatPercent of [0.21, -1, 101, null, '21']) {
      expect(() => buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 1, vatPercent }])).toThrow();
    }
    expect(buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 1, vatPercent: 4 }])[0]?.taxRate).toBe(0.04);
  });

  it('enforces the documented batch maximum and rejects empty batches and misspelled fields', () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({ gId: `DEMO-${index}`, stock: 0 }));
    expect(buildLighthouseProductsExtraInfo(items)).toHaveLength(1000);
    expect(() => buildLighthouseProductsExtraInfo([...items, { gId: 'DEMO-extra', stock: 1 }])).toThrow();
    expect(() => buildLighthouseProductsExtraInfo([])).toThrow();
    expect(() => buildLighthouseProductsExtraInfo([{ gId: 'DEMO-1', stock: 1, costpriceCents: 250 }])).toThrow();
  });
});
