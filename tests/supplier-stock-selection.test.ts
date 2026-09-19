import { describe, expect, it } from 'vitest';
import { SupplierStockSelection, type SupplierStockSnapshot } from '../src/components/admin/supplier-stock';

const snapshot = (code = 'PRV-001', stock = 15): SupplierStockSnapshot => ({
  code, name: 'Producto demo', slug: 'producto-demo', store_product_id: 1,
  supplier_active: true, store_active: true, supplier_stock: stock,
  reserved_units: 3, reserved_orders_count: 2, theoretical_available: Math.max(0, stock - 3),
  store_stock: 12, stock_difference: 12 - Math.max(0, stock - 3),
  supplier_updated_at: '2026-09-19 10:00:00', store_synced_at: '2026-09-19 10:00:00',
});

describe('supplier stock selection and drafts', () => {
  it('uses the consulted supplier stock until the user edits the value', async () => {
    const selection = new SupplierStockSelection();
    selection.select('PRV-001');
    await selection.load(async () => snapshot());
    expect(selection.draft).toBe('15');
    await selection.load(async () => snapshot('PRV-001', 9));
    expect(selection.draft).toBe('9');
    selection.edit('24');
    await selection.load(async () => snapshot('PRV-001', 7));
    expect(selection.draft).toBe('24');
    expect(selection.snapshot?.supplier_stock).toBe(7);
  });

  it('retains a separate draft for each product including an intentionally empty field', async () => {
    const selection = new SupplierStockSelection();
    selection.select('PRV-001');
    selection.edit('');
    selection.select('PRV-002');
    selection.edit('0');
    await selection.load(async () => snapshot('PRV-002', 10));
    expect(selection.draft).toBe('0');
    selection.select('PRV-001');
    await selection.load(async () => snapshot());
    expect(selection.draft).toBe('');
  });

  it('does not let a slow previous product overwrite the selected product or draft', async () => {
    const selection = new SupplierStockSelection();
    selection.select('PRV-001');
    let resolveOld!: (value: SupplierStockSnapshot) => void;
    let oldSignal!: AbortSignal;
    const first = selection.load((_code, signal) => {
      oldSignal = signal;
      return new Promise(resolve => { resolveOld = resolve; });
    });
    selection.select('PRV-002');
    selection.edit('8');
    expect(oldSignal.aborted).toBe(true);
    await selection.load(async () => snapshot('PRV-002', 20));
    resolveOld(snapshot());
    expect(await first).toBe(false);
    expect(selection.snapshot?.code).toBe('PRV-002');
    expect(selection.draft).toBe('8');
    expect(selection.loading).toBe(false);
  });

  it('ignores a late error from a previous refresh of the same product', async () => {
    const selection = new SupplierStockSelection();
    selection.select('PRV-001');
    let rejectOld!: (error: Error) => void;
    const first = selection.load(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    await selection.load(async () => snapshot('PRV-001', 24));
    rejectOld(new Error('Previous request failed'));
    expect(await first).toBe(false);
    expect(selection.snapshot?.supplier_stock).toBe(24);
    expect(selection.error).toBe('');
  });

  it('keeps edits made during a consultation and clears the local error after retry', async () => {
    const selection = new SupplierStockSelection();
    selection.select('PRV-001');
    await selection.load(async () => { throw new Error('Consulta no disponible'); });
    expect(selection.error).toBe('Consulta no disponible');
    expect(selection.loading).toBe(false);
    let resolve!: (value: SupplierStockSnapshot) => void;
    const retry = selection.load(() => new Promise(done => { resolve = done; }));
    expect(selection.loading).toBe(true);
    expect(selection.error).toBe('');
    selection.edit('30');
    resolve(snapshot());
    expect(await retry).toBe(true);
    expect(selection.draft).toBe('30');
  });

  it('rejects a response for a different product', async () => {
    const selection = new SupplierStockSelection();
    selection.select('PRV-001');
    await selection.load(async () => snapshot('PRV-002'));
    expect(selection.snapshot).toBeUndefined();
    expect(selection.error).toContain('producto seleccionado');
  });

  it('does not mistake an unimported product for zero stock in the store', async () => {
    const selection = new SupplierStockSelection();
    selection.select('PRV-001');
    await selection.load(async () => ({ ...snapshot(), store_product_id: null, store_active: null, store_stock: null, stock_difference: null, store_synced_at: null }));
    expect(selection.snapshot?.store_stock).toBeNull();
    expect(selection.snapshot?.stock_difference).toBeNull();
    expect(selection.draft).toBe('15');
  });
});
