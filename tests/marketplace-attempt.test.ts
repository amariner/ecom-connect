import { describe, expect, it, vi } from 'vitest';
import { MarketplaceOrderEditor, submitMarketplaceOrder, type MarketplaceOrderAttempt, type MarketplaceOrderDraft } from '../src/components/admin/marketplace-attempt';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const third = '33333333-3333-4333-8333-333333333333';
const key = 'ecom-connect:marketplace-attempts';
const draft: MarketplaceOrderDraft = {channel:'AMAZON',slug:'ultima-unidad',qty:1,product_name:'Champú demo'};
const attempt: MarketplaceOrderAttempt = {...draft,idempotency_key:first};
const receipt = {order_id:12,order_number:'FH-DEMO-12'};
function storage(initial?: unknown) {
  const values = new Map<string,string>(initial === undefined ? [] : [[key,JSON.stringify(initial)]]);
  return {getItem:(name:string) => values.get(name) ?? null,setItem:(name:string,value:string) => {values.set(name,value);}};
}

describe('marketplace attempt recovery',() => {
  it('restores the original command after reload and ignores later selection changes',() => {
    const store = storage();
    const editor = new MarketplaceOrderEditor(() => store,() => first);
    const mutable = {...draft};
    const pending = editor.begin(mutable);
    mutable.slug = 'otro-producto';
    mutable.qty = 9;
    expect(editor.begin(mutable)).toBe(pending);
    expect(pending).toEqual(attempt);
    expect(Object.isFrozen(pending)).toBe(true);
    const restored = new MarketplaceOrderEditor(() => store,() => second);
    expect(restored.pendingChannels()).toEqual(['AMAZON']);
    expect(restored.pending('AMAZON')).toEqual(attempt);
    expect(restored.begin(mutable)).toEqual(attempt);
    expect(restored.storageAvailable).toBe(true);
    restored.resolve('AMAZON');
    expect(new MarketplaceOrderEditor(() => store).pendingChannels()).toEqual([]);
    expect(restored.begin(mutable)).toMatchObject({slug:'otro-producto',qty:9,idempotency_key:second});
  });
  it('isolates channels and never clears a different channel when resolving',() => {
    const store = storage();
    const id = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const editor = new MarketplaceOrderEditor(() => store,id);
    editor.begin(draft);
    const miravia = editor.begin({...draft,channel:'MIRAVIA',qty:2});
    editor.resolve('AMAZON');
    expect(editor.pendingChannels()).toEqual(['MIRAVIA']);
    expect(new MarketplaceOrderEditor(() => store).pending('MIRAVIA')).toEqual(miravia);
  });
  it('retains exact retries in memory and reports unavailable storage',() => {
    const editor = new MarketplaceOrderEditor(() => {throw new Error('Unavailable');},() => first);
    expect(editor.storageAvailable).toBe(false);
    const original = editor.begin(draft);
    expect(editor.begin({...draft,qty:9})).toBe(original);
    expect(editor.pending('AMAZON')).toEqual(attempt);
    expect(editor.storageAvailable).toBe(false);
  });
  it('reports write failures and recovers persistence on a later successful write',() => {
    const store = storage();
    const write = vi.spyOn(store,'setItem').mockImplementationOnce(() => {throw new Error('Quota exceeded');});
    const editor = new MarketplaceOrderEditor(() => store,vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second));
    editor.begin(draft);
    expect(editor.storageAvailable).toBe(false);
    expect(editor.pending('AMAZON')).toEqual(attempt);
    editor.begin({...draft,channel:'MIRAVIA'});
    expect(editor.storageAvailable).toBe(true);
    expect(new MarketplaceOrderEditor(() => store).pendingChannels()).toEqual(['AMAZON','MIRAVIA']);
    write.mockRestore();
  });
  it('restores legacy tuples without replacing UUIDs and retains every pending command for a channel',() => {
    const store = storage([
      [JSON.stringify(['AMAZON','agotado',1]),first],
      [JSON.stringify(['AMAZON','inactivo',2]),second],
      [JSON.stringify(['MIRAVIA','otro',3]),third],
    ]);
    const editor = new MarketplaceOrderEditor(() => store);
    expect(editor.pending('AMAZON')).toEqual({channel:'AMAZON',slug:'agotado',qty:1,idempotency_key:first});
    editor.resolve('AMAZON');
    expect(editor.pending('AMAZON')).toEqual({channel:'AMAZON',slug:'inactivo',qty:2,idempotency_key:second});
    const restored = new MarketplaceOrderEditor(() => store);
    expect(restored.pending('AMAZON')).toEqual(editor.pending('AMAZON'));
    expect(restored.pending('MIRAVIA')?.idempotency_key).toBe(third);
    expect(restored.restoreWarning).toBe('');
  });
  it.each([
    [first],
    [[first,second]],
    [['["AMAZON"]',first]],
    [['["AMAZON","producto",0]',first]],
    [[JSON.stringify(['AMAZON','producto',1]),'------------------------------------']],
    {version:2,attempts:[attempt]},
  ])('does not invent a payload from incomplete or invalid saved identity (%j)',saved => {
    const editor = new MarketplaceOrderEditor(() => storage(saved));
    expect(editor.pendingChannels()).toEqual([]);
    expect(editor.restoreWarning).toContain('Revisa el historial');
  });
  it('rejects malformed storage while preserving valid entries',() => {
    const editor = new MarketplaceOrderEditor(() => storage({version:1,attempts:[attempt,{...attempt,channel:'WEB'},{...attempt,idempotency_key:second,qty:1.5}]}));
    expect(editor.pending('AMAZON')).toEqual(attempt);
    expect(editor.pendingChannels()).toEqual(['AMAZON']);
    expect(editor.restoreWarning).not.toBe('');
  });
  it('warns on unreadable JSON without pretending there are recoverable commands',() => {
    const editor = new MarketplaceOrderEditor(() => ({getItem:() => '{bad',setItem:() => {}}));
    expect(editor.pendingChannels()).toEqual([]);
    expect(editor.restoreWarning).not.toBe('');
    expect(editor.storageAvailable).toBe(true);
  });
  it('deduplicates identical stored commands but does not choose between conflicting payloads for one UUID',() => {
    const duplicates = new MarketplaceOrderEditor(() => storage({version:1,attempts:[attempt,attempt]}));
    duplicates.resolve('AMAZON');
    expect(duplicates.pendingChannels()).toEqual([]);
    const conflicts = new MarketplaceOrderEditor(() => storage({version:1,attempts:[attempt,{...attempt,qty:2}]}));
    expect(conflicts.pendingChannels()).toEqual([]);
    expect(conflicts.restoreWarning).not.toBe('');
  });
  it.each([{channel:'WEB'},{slug:''},{qty:0},{qty:100},{qty:1.5}])('rejects an invalid new command (%j)',change => {
    const editor = new MarketplaceOrderEditor(storage,() => first);
    expect(() => editor.begin({...draft,...change} as MarketplaceOrderDraft)).toThrow();
    expect(editor.pendingChannels()).toEqual([]);
  });
});

describe('marketplace command outcomes',() => {
  it('retries the original payload and UUID after a lost response and restores all operation warnings',async () => {
    const expected = {...receipt,supplier_warning:'Proveedor pendiente.',marketplace_warning:'Acuse pendiente.',feed_warning:'Feed pendiente.'};
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Response lost')).mockResolvedValueOnce(Response.json(expected));
    await expect(submitMarketplaceOrder(attempt,fetcher)).rejects.toMatchObject({definitive:false});
    expect(await submitMarketplaceOrder(attempt,fetcher)).toEqual(expected);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[1]![1]?.body);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/demo/action');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({action:'simulate-order',channel:'AMAZON',slug:'ultima-unidad',qty:1,idempotency_key:first});
  });
  it.each([400,409,413,415])('allows correction only after an explicit rejection (%s)',async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({error:'Revisa los datos.'},{status}));
    await expect(submitMarketplaceOrder(attempt,fetcher)).rejects.toMatchObject({definitive:true,message:'Revisa los datos.'});
  });
  it.each([403,404,408,429,500,502,503])('preserves the unresolved command on HTTP %s',async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({error:'Servicio no disponible.'},{status}));
    await expect(submitMarketplaceOrder(attempt,fetcher)).rejects.toMatchObject({definitive:false});
  });
  it.each([{},null,{...receipt,ok:false},{...receipt,error:'Respuesta inconsistente.'},{...receipt,order_id:0},{...receipt,order_id:-1},{...receipt,order_id:1.5},{...receipt,order_id:'12'},{order_id:12},{...receipt,order_number:' '},{...receipt,order_number:12}])('keeps uncertainty for an invalid success receipt (%j)',async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
    await expect(submitMarketplaceOrder(attempt,fetcher)).rejects.toMatchObject({definitive:false});
  });
  it.each([200,400,409,502])('does not clear an attempt after a non-JSON response (%s)',async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>Proxy response</html>',{status}));
    await expect(submitMarketplaceOrder(attempt,fetcher)).rejects.toMatchObject({definitive:false});
  });
  it.each([{},{error:''},{error:' '},{error:42}])('requires a meaningful rejection body before releasing an attempt (%j)',async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body,{status:409}));
    await expect(submitMarketplaceOrder(attempt,fetcher)).rejects.toMatchObject({definitive:false});
  });
  it('restores and recovers an exhausted or inactive product without consulting the catalog',async () => {
    const store = storage();
    new MarketplaceOrderEditor(() => store,() => first).begin(draft);
    const restored = new MarketplaceOrderEditor(() => store);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(receipt));
    expect(await submitMarketplaceOrder(restored.pending('AMAZON')!,fetcher)).toEqual(receipt);
    expect(fetcher).toHaveBeenCalledTimes(1);
    restored.resolve('AMAZON');
    expect(new MarketplaceOrderEditor(() => store).pendingChannels()).toEqual([]);
  });
});
