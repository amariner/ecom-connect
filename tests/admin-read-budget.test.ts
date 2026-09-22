import {afterEach, describe, expect, it, vi} from 'vitest';
import {createReadRefresh, ReadRequestError} from '../src/components/admin/read-refresh';
import {createRequestBudget, sampleEvenly} from '../scripts/verification-budget.mjs';

afterEach(() => vi.useRealTimers());

describe('manual admin reads', () => {
  it('never queries periodically or when visibility changes', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => {});
    const refresh = createReadRefresh(load,{onError:vi.fn()});
    await vi.advanceTimersByTimeAsync(86_400_000);
    refresh.setVisible(false);
    await refresh.refresh();
    refresh.setVisible(true);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(load).not.toHaveBeenCalled();
    await refresh.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deduplicates simultaneous clicks and avoids reads while a mutation is pending', async () => {
    let resolve!: () => void;
    const load = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    let canRefresh = false;
    const refresh = createReadRefresh(load,{onError:vi.fn(),canRefresh:() => canRefresh});
    await refresh.refresh();
    expect(load).not.toHaveBeenCalled();
    canRefresh = true;
    const pending = refresh.refresh();
    await refresh.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    resolve();
    await pending;
  });

  it('respects quota Retry-After without scheduling a retry', async () => {
    vi.useFakeTimers();
    const error = new ReadRequestError('Cuota agotada',new Response(null,{status:503,headers:{'Retry-After':'3600'}}),'D1_READ_LIMIT');
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onError = vi.fn();
    const refresh = createReadRefresh(load,{onError});
    await refresh.refresh();
    await refresh.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenLastCalledWith(error);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await refresh.refresh();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('accepts a HTTP-date Retry-After and aborts an in-flight read on exit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T20:00:00Z'));
    const error = new ReadRequestError('Límite temporal',new Response(null,{status:429,headers:{'Retry-After':'Wed, 23 Sep 2026 00:00:00 GMT'}}));
    expect(error.retryAt).toBe(Date.parse('2026-09-23T00:00:00Z'));
    let signal!: AbortSignal;
    const refresh = createReadRefresh(async passed => { signal = passed; },{onError:vi.fn()});
    await refresh.refresh();
    refresh.stop();
    expect(signal.aborted).toBe(true);
  });

  it('does not retry generic failures in the background', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue(new TypeError('Offline'));
    const refresh = createReadRefresh(load,{onError:vi.fn()});
    await refresh.refresh();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('public verification budget', () => {
  it('caps default requests, including redirects, at 150', () => {
    const budget = createRequestBudget();
    for (let index = 0; index < 150; index++) budget.take();
    expect(() => budget.take()).toThrow(/150 solicitudes/);
    expect(budget.requests).toBe(150);
    expect(createRequestBudget(true).limit).toBe(2500);
  });

  it('samples both ends of a growing catalog without repeated items', () => {
    const catalog = Array.from({length:695},(_,index) => index);
    const sample = sampleEvenly(catalog,12);
    expect(sample).toHaveLength(12);
    expect(new Set(sample).size).toBe(12);
    expect(sample[0]).toBe(0);
    expect(sample.at(-1)).toBe(694);
    expect(sampleEvenly([1,2,3],12)).toEqual([1,2,3]);
  });
});
