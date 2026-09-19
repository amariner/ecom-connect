import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { MarketplaceOrderEditor, MarketplaceOrderSubmissionError, submitMarketplaceOrder } from '../src/components/admin/marketplace-attempt';

// Exercise the page's real recovery render and submission wiring with the real attempt helper.
const source = readFileSync(new URL('../src/components/admin/client.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('client.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['marketplaceOperation', 'renderMarketplaceOperation', 'confirmMarketplaceOrder'];
const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
const script = ts.transpileModule(functions.map(node => ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, parsed)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const identity = '11111111-1111-4111-8111-111111111111';
const receipt = { order_id: 42, order_number: 'FH-DEMO-42', supplier_warning: 'No hay stock en el proveedor demo.' };

function recoveryPage(fetcher) {
  const storage = new Map();
  const editor = new MarketplaceOrderEditor(() => ({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }), () => identity);
  editor.begin({ channel: 'AMAZON', slug: 'last-unit', qty: 1, product_name: 'Última unidad' });
  const body = {};
  const document = { body, activeElement: body, getElementById: id => elements.get(id) };
  const elements = new Map();
  class Element {
    constructor(id = '', retry = false) { this.id = id; this.retry = retry; this.dataset = {}; this.disabled = false; }
    matches(selector) { return this.retry && selector.includes('retry-marketplace'); }
    focus() { document.activeElement = this; }
  }
  let context;
  const area = {
    content: '', controls: [],
    set innerHTML(value) {
      if (this.controls.includes(document.activeElement)) document.activeElement = body;
      this.content = value;
      this.controls = [];
      if (value.includes('data-action="retry-marketplace"')) this.controls.push(new Element('', true));
      else if (value.includes('marketplace-receipt-amazon')) {
        const link = new Element('marketplace-receipt-amazon'); this.controls.push(link); elements.set(link.id, link);
      } else this.controls.push(new Element('new-order'));
      this.controls.forEach(control => { control.disabled = context.mutationPending; });
    },
    get innerHTML() { return this.content; },
    contains(element) { return this.controls.includes(element); },
    querySelector() { return this.controls[0]; },
  };
  const state = { products: [{ slug: 'last-unit', name: 'Última unidad', active: false, stock: 0 }], settings: { dispatch_mode: 'immediate' } };
  context = vm.createContext({
    state, marketplaceOrders: editor, marketplaceReceipts: new Map(), marketplaceMessages: new Map(), marketplaceDrafts: new Map(), marketplaceBusyChannel: '', mutationPending: false,
    panel: { querySelector: () => area, querySelectorAll: () => area.controls }, document, HTMLElement: Element, Error, CSS: { escape: String },
    html: String, number: String, icon: () => '', channelInfo: () => ({ name: 'Amazon', color: 'amazon' }), productOptions: () => '', orderListPath: () => '/admin/pedidos?channel=AMAZON',
    MarketplaceOrderSubmissionError, submitMarketplaceOrder: attempt => submitMarketplaceOrder(attempt, fetcher),
    request: vi.fn().mockResolvedValue(state), notify: vi.fn(),
    render: async () => { context.renderMarketplaceOperation('AMAZON'); },
    updateMarketplaceAvailability: () => { area.controls.forEach(control => { control.disabled = context.mutationPending; }); },
  });
  vm.runInContext(script, context);
  context.renderMarketplaceOperation('AMAZON');
  const confirm = () => { const trigger = area.controls[0]; trigger.focus(); return context.confirmMarketplaceOrder('AMAZON', trigger); };
  return { context, editor, area, document, Element, confirm };
}

describe('marketplace recovery page wiring', () => {
  it('offers a retry for an inactive, exhausted product without exposing a new order form', () => {
    const page = recoveryPage(vi.fn());
    expect(page.area.innerHTML).toContain('Última unidad');
    expect(page.area.innerHTML).toContain('Reintentar confirmación');
    expect(page.area.innerHTML).not.toContain('<form');
    expect(page.area.controls[0].disabled).toBe(false);
  });

  it('keeps a malformed success pending, then confirms the same command and presents supplier warnings', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json(receipt));
    const page = recoveryPage(fetcher);
    await page.confirm();
    expect(page.editor.pending('AMAZON').idempotency_key).toBe(identity);
    expect(page.area.innerHTML).toContain('Reintentar confirmación');
    expect(page.area.innerHTML).not.toContain('<form');
    expect(page.document.activeElement).toBe(page.area.controls[0]);
    expect(page.context.request).not.toHaveBeenCalled();
    await page.confirm();
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
    expect(page.editor.pending('AMAZON')).toBeUndefined();
    expect(page.area.innerHTML).toContain('FH-DEMO-42');
    expect(page.area.innerHTML).toContain('Aviso al confirmar: No hay stock en el proveedor demo.');
    expect(page.document.activeElement.id).toBe('marketplace-receipt-amazon');
    expect(page.context.notify).toHaveBeenCalledWith(expect.stringContaining(receipt.supplier_warning), true, 42);
  });

  it('keeps focus on another control chosen while a retry is in flight', async () => {
    let resolve;
    const response = new Promise(done => { resolve = done; });
    const page = recoveryPage(() => response);
    const retry = page.confirm();
    const external = new page.Element('other-control');
    external.focus();
    resolve(Response.json(receipt));
    await retry;
    expect(page.document.activeElement).toBe(external);
  });

  it('releases a definitive rejection and refreshes availability before another new order', async () => {
    const page = recoveryPage(vi.fn().mockResolvedValue(Response.json({ error: 'Stock insuficiente.' }, { status: 409 })));
    await page.confirm();
    expect(page.editor.pending('AMAZON')).toBeUndefined();
    expect(page.context.request).toHaveBeenCalledWith('/api/demo/state');
    expect(page.area.innerHTML).toContain('Stock insuficiente.');
    expect(page.area.innerHTML).toContain('<form');
    expect(page.area.innerHTML).not.toContain('Reintentar confirmación');
  });
});
