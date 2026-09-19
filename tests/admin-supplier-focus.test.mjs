import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Exercise the actual mutation -> refresh -> supplier consultation wiring.
const source = readFileSync(new URL('../src/components/admin/client.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('client.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const printer = ts.createPrinter();
const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && ['mutate', 'refresh', 'render'].includes(node.name?.text));
const script = ts.transpileModule(functions.map(node => printer.printNode(ts.EmitHint.Unspecified, node, parsed)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function pendingPriceRefresh() {
  const body = {};
  const document = { body, activeElement: body };
  let loaded = false;
  let resolveSnapshot;
  const snapshot = new Promise(resolve => { resolveSnapshot = () => { loaded = true; resolve(); }; });
  const button = { disabled: true, focus: vi.fn(() => { document.activeElement = button; }) };
  const trigger = { closest: () => ({ id: 'supplier-price-form' }), innerHTML: 'Reintentar cambio de precio',
    classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {}, isConnected: false };
  const panel = { innerHTML: '', dataset: {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => button };
  const context = vm.createContext({
    panel, document, view: 'supplier', mutationPending: false, state: null, detail: null,
    CSS: { escape: value => value }, icon: () => '',
    dashboard: () => '', products: () => '', orders: () => '', orderDetail: () => '', supplier: () => 'Supplier panel', lighthouse: () => '', marketplaces: () => '', settings: () => '',
    renderProducts() {}, loadOrders() {}, loadSupplierStock: () => snapshot,
    request: vi.fn().mockResolvedValue({ products: [] }), updateMarketplaceAvailability() {},
    renderSupplierPrice: () => { button.disabled = !loaded; },
    submitSupplierPrice: vi.fn().mockResolvedValue({ demo: true, replayed: true, change: { changed: true } }),
    supplierPrices: { resolve() {} }, supplierPriceMessages: new Map(), orderAttempts: new Map(),
    persistOrderAttempts() {}, notify: vi.fn(),
  });
  vm.runInContext(script, context);
  return { button, document, resolveSnapshot, pending: () => context.mutate('simulate-price', {}, trigger, { code: 'PRV-00016' }) };
}

describe('supplier price mutation focus recovery', () => {
  it('waits for the supplier consultation before enabling and focusing the replacement action', async () => {
    const page = pendingPriceRefresh();
    const mutation = page.pending();
    await new Promise(setImmediate);
    expect(page.button.disabled).toBe(true);
    expect(page.button.focus).not.toHaveBeenCalled();
    expect(page.document.activeElement).toBe(page.document.body);
    page.resolveSnapshot();
    await mutation;
    expect(page.button.disabled).toBe(false);
    expect(page.button.focus).toHaveBeenCalledOnce();
    expect(page.document.activeElement).toBe(page.button);
  });

  it('keeps focus on another control chosen while the consultation is pending', async () => {
    const page = pendingPriceRefresh();
    const mutation = page.pending();
    await new Promise(setImmediate);
    const otherControl = {};
    page.document.activeElement = otherControl;
    page.resolveSnapshot();
    await mutation;
    expect(page.button.disabled).toBe(false);
    expect(page.button.focus).not.toHaveBeenCalled();
    expect(page.document.activeElement).toBe(otherControl);
  });
});
