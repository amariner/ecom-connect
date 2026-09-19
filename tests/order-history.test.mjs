import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ORDER_HISTORY_PAGE_SIZE, orderHistoryDate, orderHistoryWindow } from '../src/components/admin/order-history';

const events = (count) => Array.from({ length: count }, (_, index) => ({ note: `Movimiento ${index + 1}`, created_at: '2026-09-19 18:00:00' }));

describe('complete order history in reverse insertion order', () => {
  it('starts with the latest ten of a long history and reveals every older event without gaps or duplicates', () => {
    const all = Object.freeze(events(35));
    const original = [...all];
    const initial = orderHistoryWindow(all);
    expect(initial.items.map(event => event.note)).toEqual(Array.from({ length: 10 }, (_, index) => `Movimiento ${35 - index}`));
    let previous = [];
    for (const visible of [10, 20, 30, 40]) {
      const window = orderHistoryWindow(all, visible);
      expect(window.items.slice(0, previous.length)).toEqual(previous);
      expect(new Set(window.items).size).toBe(window.shown);
      expect(window.shown + window.remaining).toBe(35);
      previous = window.items;
    }
    expect(previous).toEqual([...original].reverse());
    expect(all).toEqual(original);
  });

  it('preserves the API insertion order across identical or backdated timestamps', () => {
    const all = [
      { note: 'Pedido recibido', created_at: '2026-09-19 18:00:00' },
      { note: 'Error', created_at: '2026-09-19 18:00:00' },
      { note: 'Recuperado', created_at: '2026-09-18 18:00:00' },
    ];
    expect(orderHistoryWindow(all).items.map(event => event.note)).toEqual(['Recuperado', 'Error', 'Pedido recibido']);
  });

  it.each([0, 1, 10, 11])('shows an accurate remaining count for %s events', count => {
    const window = orderHistoryWindow(events(count));
    expect(window.shown).toBe(Math.min(10, count));
    expect(window.nextCount).toBe(Math.max(0, count - 10));
    expect(orderHistoryWindow(events(count), 20).remaining).toBe(0);
  });

  it('normalizes UTC timestamps for accessible dates while retaining the year and clock in the visible label', () => {
    const timestamp = orderHistoryDate('2026-09-19 18:12:34');
    expect(timestamp.datetime).toBe('2026-09-19T18:12:34.000Z');
    expect(timestamp.label).toContain('2026');
    expect(timestamp.label).toMatch(/\d{2}:12:34/);
    expect(orderHistoryDate('not-a-date')).toEqual({ label: 'Fecha no disponible', datetime: '' });
  });
});

// Use the page's actual list renderer and click handler to protect keyboard focus.
const source = readFileSync(new URL('../src/components/admin/client.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('client.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const nodes = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && ['orderHistoryItems', 'orderHistory', 'renderOrderHistory'].includes(node.name?.text)
  || ts.isExpressionStatement(node) && node.getText(parsed).startsWith("panel?.addEventListener('click'"));
const script = ts.transpileModule(nodes.map(node => ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, parsed)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

describe('order history page controls', () => {
  it('keeps the same focused control through expansion and retains the expanded size after a new event', () => {
    let handler;
    const attrs = new Map([['aria-disabled', 'false']]);
    const button = { disabled: false, dataset: { action: 'older-order-events' }, closest() { return this; }, getAttribute: name => attrs.get(name), setAttribute: (name, value) => attrs.set(name, value) };
    const list = { innerHTML: '' }, counter = { textContent: '' };
    const document = { activeElement: button, getElementById: id => id === 'order-history-list' ? list : counter, querySelector: () => button };
    const detail = { events: events(35) };
    const context = vm.createContext({
      detail, orderHistoryVisible: ORDER_HISTORY_PAGE_SIZE, ORDER_HISTORY_PAGE_SIZE, orderHistoryDate, orderHistoryWindow, document,
      panel: { addEventListener: (_event, callback) => { handler = callback; } },
      html: String, number: String, icon: () => '', label: String, presentEventText: String, empty: text => text,
    });
    vm.runInContext(script, context);
    context.renderOrderHistory();
    expect(list.innerHTML).toContain('Movimiento 35');
    expect(list.innerHTML).not.toContain('<p>Movimiento 1</p>');
    handler({ target: button });
    expect(counter.textContent).toBe('Mostrando 20 de 35 movimientos');
    expect(document.activeElement).toBe(button);
    detail.events.push({ note: 'Tracking recién recibido', created_at: '2026-09-19 19:00:00' });
    const refreshed = context.orderHistory();
    expect(refreshed).toContain('Mostrando 20 de 36 movimientos');
    expect(refreshed).toContain('Tracking recién recibido');
    handler({ target: button });
    handler({ target: button });
    expect(counter.textContent).toBe('Mostrando 36 de 36 movimientos');
    expect(list.innerHTML).toContain('<p>Movimiento 1</p>');
    expect(button.textContent).toBe('Historial completo');
    expect(attrs.get('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button);
    handler({ target: button });
    expect(context.orderHistoryVisible).toBe(40);
  });
});
