import { describe, expect, it } from 'vitest';
import {
  normalizeSupplierCatalogResponse,
  normalizeSupplierOrderCreation,
  normalizeSupplierOrderStatus,
  normalizeSupplierStockResponse,
  splitSupplierBarcodes,
  supplierAmountToCents,
} from '../src/integrations/supplier-api-contract';

function ok(fields: Record<string, unknown>) { return { status: 'OK', message: '', ...fields }; }
const line = { codigo: 'SUP-DEMO-001', descripcion: 'Producto ficticio', estado: 'P', canped: 5, canser: 2, albaran: 'ALB-DEMO-1', numexp: 'EXP-DEMO-1' };
const order = { pedidocliente: 'DEMO-ORDER-1', pedidoerp: 'ERP-DEMO-1', estado: 'P', lineas: [line] };

describe('supplier decimal and barcode normalization', () => {
  it('converts decimals without binary multiplication or implicit rounding', () => {
    expect(supplierAmountToCents('0.29')).toBe(29);
    expect(supplierAmountToCents('19.9')).toBe(1990);
    expect(supplierAmountToCents(12.34)).toBe(1234);
    expect(supplierAmountToCents('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    expect(supplierAmountToCents('0')).toBe(0);
    for (const invalid of ['1.005', '1,25', '1e2', '-1', 'NaN', '', null, true, Number.NaN, Number.POSITIVE_INFINITY, '90071992547409.92', 0.1 + 0.2]) {
      expect(() => supplierAmountToCents(invalid)).toThrow();
    }
  });

  it('preserves codes and leading zeroes without inventing or selecting a GTIN', () => {
    expect(splitSupplierBarcodes('0012345678905, 0012345678905, CODE-DEMO , , 0001')).toEqual(['0012345678905', 'CODE-DEMO', '0001']);
    expect(splitSupplierBarcodes('')).toEqual([]);
    expect(() => splitSupplierBarcodes(123)).toThrow();
  });
});

describe('supplier catalog responses', () => {
  const article = { codigo: '0007', descripcion: 'Producto ficticio', precio: '10.29', pvp: '15.90', descuento: -10, iva: 21, codigobarra: '000123, DEMO-CODE' };

  it('preserves supplier price data and unknown optional metadata without applying commercial rules', () => {
    const result = normalizeSupplierCatalogResponse(ok({ articulos: [article], numtotalarticulos: 200 }));
    expect(result.totalArticles).toBe(200);
    expect(result.records[0]).toMatchObject({ code: '0007', supplierPriceCents: 1029, supplierPvpCents: 1590, discount: '-10', vat: '21', brand: null, categories: [null, null, null], barcodes: ['000123', 'DEMO-CODE'] });
    expect(result.records[0]).not.toHaveProperty('currency');
    expect(result.records[0]).not.toHaveProperty('price_cents');
  });

  it('rejects business errors, malformed totals, duplicate codes and unconfirmed rounding', () => {
    for (const payload of [
      { status: 'ERROR', message: 'Provider-private-error', articulos: [] },
      ok({ articulos: [article], numtotalarticulos: 0 }),
      ok({ articulos: [article, article], numtotalarticulos: 2 }),
      ok({ articulos: [{ ...article, precio: '10.299' }], numtotalarticulos: 1 }),
    ]) expect(() => normalizeSupplierCatalogResponse(payload)).toThrow();
    expect(() => normalizeSupplierCatalogResponse({ status: 'ERROR', message: 'Provider-private-error' })).not.toThrow('Provider-private-error');
  });
});

describe('supplier stock responses', () => {
  it('distinguishes explicit zero, missing backup and omitted articles', () => {
    const result = normalizeSupplierStockResponse(ok({ articulos: [{ codigo: 'A', stocknum: '0', diaslaboentest: '0' }, { codigo: 'B', stocknum: '7', stockbackupnum: '0' }] }), {
      scope: 'requested', expectedCodes: ['A', 'B', 'C'],
    });
    expect(result.records[0]).toMatchObject({ code: 'A', stock: 0, backupStock: null, estimatedWorkingDays: 0 });
    expect(result.records[1]).toMatchObject({ code: 'B', stock: 7, backupStock: 0, estimatedWorkingDays: null });
    expect(result.missingCodes).toEqual(['C']);
    expect(result.records).toHaveLength(2);
  });

  it('keeps available-only omissions separate and never fills them with invented stock', () => {
    const result = normalizeSupplierStockResponse(ok({ articulos: [] }), { scope: 'available-only', expectedCodes: ['A'] });
    expect(result).toEqual({ records: [], missingCodes: ['A'], scope: 'available-only' });
    expect(() => normalizeSupplierStockResponse({ status: 'ERROR', message: '', articulos: [] }, { scope: 'available-only', expectedCodes: ['A'] })).toThrow();
  });

  it('accepts the documented typo only when it does not conflict with stocknum', () => {
    const parse = (item: Record<string, unknown>) => normalizeSupplierStockResponse(ok({ articulos: [{ codigo: 'A', ...item }] }), { scope: 'requested' });
    expect(parse({ stockum: '3' }).records[0]?.stock).toBe(3);
    expect(parse({ stocknum: 3, stockum: '03' }).records[0]?.stock).toBe(3);
    expect(() => parse({ stocknum: 3, stockum: '4' })).toThrow('contradice');
    expect(() => parse({ stocknum: '3', stockum: 'unknown' })).toThrow();
  });

  it('fails on absent/malformed quantities, duplicate codes and references outside a request', () => {
    for (const item of [{ stock: 'Disponible' }, { stocknum: '' }, { stocknum: null }, { stocknum: '2.5' }, { stocknum: -1 }, { stocknum: '1e2' }, { stocknum: '9007199254740992' }, { stocknum: 1, stockbackupnum: '' }]) {
      expect(() => normalizeSupplierStockResponse(ok({ articulos: [{ codigo: 'A', ...item }] }), { scope: 'requested' })).toThrow();
    }
    expect(() => normalizeSupplierStockResponse(ok({ articulos: [{ codigo: 'A', stocknum: '1' }, { codigo: 'A', stocknum: '2' }] }), { scope: 'requested' })).toThrow('duplicados');
    expect(() => normalizeSupplierStockResponse(ok({ articulos: [{ codigo: 'OTHER', stocknum: '1' }] }), { scope: 'requested', expectedCodes: ['A'] })).toThrow('fuera');
  });
});

describe('supplier split ERP orders and production states', () => {
  it('retains each ERP identifier and line count from an accepted split order', () => {
    expect(normalizeSupplierOrderCreation(ok({ pedidoerp: 'ERP-DEMO-1', numlineas: 1, pedidoerp2: 'ERP-DEMO-2', numlineas2: 2, pedidoerp3: 'ERP-DEMO-3', numlineas3: '1' }))).toEqual({
      orders: [{ erpOrderId: 'ERP-DEMO-1', lineCount: 1 }, { erpOrderId: 'ERP-DEMO-2', lineCount: 2 }, { erpOrderId: 'ERP-DEMO-3', lineCount: 1 }],
    });
  });

  it('rejects ambiguous, incomplete and unsupported groups instead of losing an ERP order', () => {
    for (const fields of [
      {},
      { pedidoerp2: 'ERP-DEMO-2', numlineas2: 1 },
      { pedidoerp: 'ERP-DEMO-1' },
      { pedidoerp: 'ERP-DEMO-1', numlineas: 1, pedidoerp2: '', numlineas2: 0 },
      { pedidoerp: 'ERP-DEMO-1', numlineas: 1, pedidoerp2: 'ERP-DEMO-1', numlineas2: 1 },
      { pedidoerp: 'ERP-DEMO-1', numlineas: 1, pedidoerp4: 'ERP-DEMO-4', numlineas4: 1 },
    ]) expect(() => normalizeSupplierOrderCreation(ok(fields))).toThrow();
  });

  it('retains per-line partial quantities and multiple expeditions without collapsing product codes', () => {
    const result = normalizeSupplierOrderStatus(ok({ ...order, pedidocliente2: order.pedidocliente, pedidoerp2: 'ERP-DEMO-2', estado2: 'S', lineas2: [{ ...line, estado: 'S', canped: 3, canser: 3, albaran: 'ALB-DEMO-2', numexp: 'EXP-DEMO-2' }] }), order.pedidocliente);
    expect(result.orders).toHaveLength(2);
    expect(result.orders[0]?.lines[0]).toMatchObject({ code: line.codigo, requestedQuantity: 5, producedQuantity: 2, productionStatus: 'partial', expeditionNumber: 'EXP-DEMO-1' });
    expect(result.orders[1]?.lines[0]).toMatchObject({ code: line.codigo, requestedQuantity: 3, producedQuantity: 3, productionStatus: 'complete', expeditionNumber: 'EXP-DEMO-2' });
  });

  it('never treats S (produced) as shipped and never invents carrier, dates or tracking URLs', () => {
    const result = normalizeSupplierOrderStatus(ok({ ...order, estado: 'S', lineas: [{ ...line, estado: 'S', canser: 5, albaran: '', numexp: '' }] }));
    expect(result.orders[0]).toMatchObject({ state: 'S', productionStatus: 'complete' });
    expect(result.orders[0]?.lines[0]).toMatchObject({ deliveryNote: null, expeditionNumber: null });
    expect(result.orders[0]).not.toHaveProperty('shipped');
    expect(JSON.stringify(result)).not.toMatch(/shipped|delivered|trackingUrl|carrier|createdAt/);
  });

  it('preserves pending/error states and zero produced quantity', () => {
    const result = normalizeSupplierOrderStatus(ok({ ...order, estado: 'E', lineas: [{ ...line, estado: 'V', canser: 0 }] }));
    expect(result.orders[0]?.productionStatus).toBe('error');
    expect(result.orders[0]?.lines[0]).toMatchObject({ productionStatus: 'pending', producedQuantity: 0 });
  });

  it('rejects unknown states, impossible quantities and mixed customer references', () => {
    expect(() => normalizeSupplierOrderStatus(ok({ ...order, estado: 'SHIPPED' }))).toThrow();
    expect(() => normalizeSupplierOrderStatus(ok({ ...order, lineas: [{ ...line, canser: 6 }] }))).toThrow();
    expect(() => normalizeSupplierOrderStatus(ok(order), 'ANOTHER-DEMO-REFERENCE')).toThrow();
    expect(() => normalizeSupplierOrderStatus(ok({ ...order, pedidocliente2: 'ANOTHER-DEMO-REFERENCE', pedidoerp2: 'ERP-DEMO-2', estado2: 'V', lineas2: [line] }))).toThrow();
  });
});
