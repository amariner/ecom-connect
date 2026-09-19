import { describe, expect, it, vi } from 'vitest';
import { formatPriceInput, parsePriceEuros, SupplierPriceEditor, submitSupplierPrice, type SupplierPriceAttempt } from '../src/components/admin/supplier-price';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const current = { price_cents: 890, pvp_cents: 1090 };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const payload: SupplierPriceAttempt = { code: 'PRV-00016', price_cents: 990, pvp_cents: 1290, expected_price: current, idempotency_key: first };
const result = { demo: true, replayed: false, change: { code: payload.code, before: current, after: { price_cents: 990, pvp_cents: 1290 }, changed: true, created_at: '2026-09-19 12:00:00' } };

describe('supplier price decimal input', () => {
  it.each([['8,90',890],['8.9',890],['0',0],['0,01',1],['10000,00',1000000],[' 12,05 ',1205]])('converts %s into exact cents', (input, expected) => {
    expect(parsePriceEuros(String(input))).toBe(expected);
  });
  it.each(['8,999','8.999','8,','1e2','-1','1.234,56','10000,01','','NaN','Infinity'])('rejects %s without silent rounding', input => {
    expect(() => parsePriceEuros(input)).toThrow();
  });
  it('formats decimal inputs without losing cent precision', () => {
    expect(formatPriceInput(1)).toBe('0,01');
    expect(formatPriceInput(890)).toBe('8,90');
    expect(formatPriceInput(1000000)).toBe('10000,00');
  });
});

describe('supplier price drafts and recovery', () => {
  it('preserves each product draft and allows an explicitly absent PVP', () => {
    const editor = new SupplierPriceEditor(storage, () => first);
    editor.edit('PRV-00016', { price: '9,90', pvp: '' });
    editor.edit('PRV-00017', { price: '12,', pvp: '15,00' });
    expect(editor.draft('PRV-00016', current)).toEqual({ price: '9,90', pvp: '' });
    expect(editor.draft('PRV-00017', current).price).toBe('12,');
    expect(editor.begin('PRV-00016', current).pvp_cents).toBeNull();
  });
  it.each(['8,90','8,00'])('requires a reference PVP above the selling price (%s)', pvp => {
    const editor = new SupplierPriceEditor(storage, () => first);
    editor.edit('PRV-00016', { price: '8,90', pvp });
    expect(() => editor.begin('PRV-00016', current)).toThrow('PVP');
    expect(editor.pending('PRV-00016')).toBeUndefined();
  });
  it('freezes the identity and full payload through edits, external changes and reload', () => {
    const store = storage();
    const editor = new SupplierPriceEditor(() => store, () => first);
    editor.edit(payload.code, { price: '9,90', pvp: '12,90' });
    const mutable = { ...current };
    const original = editor.begin(payload.code, mutable);
    mutable.price_cents = 800;
    editor.edit(payload.code, { price: '7,90', pvp: '' });
    expect(editor.begin(payload.code, mutable)).toBe(original);
    expect(original).toEqual(payload);
    expect(Object.isFrozen(original.expected_price)).toBe(true);
    expect(editor.draft(payload.code)).toEqual({ price: '9,90', pvp: '12,90' });
    const restored = new SupplierPriceEditor(() => store, () => second);
    expect(restored.pendingCodes()).toEqual([payload.code]);
    expect(restored.begin(payload.code, mutable)).toEqual(original);
    restored.resolve(payload.code);
    expect(new SupplierPriceEditor(() => store).pendingCodes()).toEqual([]);
    expect(restored.begin(payload.code, current).idempotency_key).toBe(second);
  });
  it('preserves an in-memory retry when storage is unavailable', () => {
    const editor = new SupplierPriceEditor(() => { throw new Error('Storage unavailable'); }, () => first);
    const pending = editor.begin(payload.code, current);
    expect(editor.begin(payload.code, { price_cents: 700, pvp_cents: null })).toBe(pending);
  });
});

describe('supplier price request outcome', () => {
  it('retries exactly the same command after a lost response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValueOnce(Response.json({ ...result, replayed: true }));
    await expect(submitSupplierPrice(payload, fetcher)).rejects.toMatchObject({ definitive: false });
    expect(await submitSupplierPrice(payload, fetcher)).toEqual({ ...result, replayed: true });
    expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[1]![1]?.body);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ action: 'simulate-price', ...payload });
  });
  it('classifies a concurrent provider edit for an explicit review', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'El precio ha cambiado.', code: 'supplier_price_changed', price: { price_cents: 800, pvp_cents: null } }, { status: 409 }));
    await expect(submitSupplierPrice(payload, fetcher)).rejects.toMatchObject({ definitive: true, code: 'supplier_price_changed' });
  });
  it.each([408,429,500,502,503])('keeps uncertainty on HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: 'Servicio no disponible.' }, { status }));
    await expect(submitSupplierPrice(payload, fetcher)).rejects.toMatchObject({ definitive: false });
  });
  it('does not retire a pending change on a mismatched or malformed success', async () => {
    for (const body of [{}, { ...result, change: { ...result.change, code: 'PRV-OTHER' } }, { ...result, change: { ...result.change, after: current } }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      await expect(submitSupplierPrice(payload, fetcher)).rejects.toMatchObject({ definitive: false });
    }
  });
});
