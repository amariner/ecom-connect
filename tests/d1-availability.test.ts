import { describe, expect, it, vi } from 'vitest';
import { D1QuotaCircuit, D1ReadLimitError, d1PausedResponse, isD1QuotaError, needsDatabase, outdatedPanelResponse } from '../src/lib/d1-availability';
import { POST as disabledScheduler } from '../src/pages/api/demo/scheduler';

describe('D1 quota recovery without background work', () => {
  it('rejects retired polling clients while allowing current manual reads and user actions', async () => {
    for (const path of ['state', 'catalog-selection', 'sync-control']) {
      const url = `https://demo.test/api/demo/${path}`;
      const oldClient = outdatedPanelResponse(new Request(url));
      expect(oldClient?.status).toBe(409);
      expect(await oldClient?.json()).toMatchObject({code:'CLIENT_REFRESH_REQUIRED'});
      expect(outdatedPanelResponse(new Request(url, {headers:{'X-Demo-Read':'manual-v1'}}))).toBeUndefined();
      expect(outdatedPanelResponse(new Request(url, {method:'POST'}))).toBeUndefined();
    }
    expect(outdatedPanelResponse(new Request('https://demo.test/api/products'))).toBeUndefined();
  });

  it('recognizes a quota cause without treating ordinary database failures as daily limits', () => {
    expect(isD1QuotaError(new Error('D1_ERROR', { cause: new Error("Your account has exceeded D1's maximum query row read limit") }))).toBe(true);
    expect(isD1QuotaError(new Error('D1_ERROR: too many SQL variables'))).toBe(false);
    expect(isD1QuotaError(new Error('D1_ERROR: UNIQUE constraint failed'))).toBe(false);
  });

  it('does not repeat database calls after a quota failure and resumes at midnight UTC', async () => {
    let now = Date.parse('2026-09-22T15:00:00Z');
    const query = vi.fn().mockRejectedValueOnce(new Error('D1_ERROR: daily read limit exceeded')).mockResolvedValue({results:[]});
    const raw = {prepare: () => ({all: query})};
    const circuit = new D1QuotaCircuit(() => now);
    const db = circuit.protect(raw);
    expect(circuit.protect(raw)).toBe(db);
    await expect(db.prepare().all()).rejects.toThrow('daily read limit');
    expect(circuit.until()).toBe(Date.parse('2026-09-23T00:00:00Z'));
    expect(() => db.prepare()).toThrow(D1ReadLimitError);
    expect(query).toHaveBeenCalledTimes(1);
    now = Date.parse('2026-09-23T00:00:00Z');
    expect(circuit.until()).toBe(0);
    expect(await db.prepare().all()).toEqual({results:[]});
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('binds native methods correctly and unwraps statements for atomic batches', async () => {
    class Statement {
      #value: string;
      constructor(value='') { this.#value = value; }
      bind(value: string) { return new Statement(value); }
      async first() { return this.#value; }
    }
    const batch = vi.fn(async (statements: Statement[]) => {
      expect(statements[0]).toBeInstanceOf(Statement);
      // Native clients can require real internal slots, not a Proxy receiver.
      return Promise.all(statements.map(statement => Statement.prototype.first.call(statement)));
    });
    const circuit = new D1QuotaCircuit();
    const db = circuit.protect({prepare: () => new Statement(), batch});
    const statement = db.prepare().bind('same value');
    expect(await statement.first()).toBe('same value');
    expect(await db.batch([statement])).toEqual(['same value']);
  });

  it('returns a recoverable 503 with a bounded retry date and keeps docs accessible', async () => {
    const now = Date.parse('2026-09-22T15:00:00Z'), until = Date.parse('2026-09-23T00:00:00Z');
    const response = d1PausedResponse(new Request('https://demo.test/api/demo/state'), until, now);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('32400');
    expect(await response.json()).toMatchObject({code:'D1_READ_LIMIT', resume_at:'2026-09-23T00:00:00.000Z'});
    const page = await d1PausedResponse(new Request('https://demo.test/tienda'), until, now).text();
    expect(page).toContain('02:00');
    expect(page).not.toContain('<script');
    expect(needsDatabase('/admin/documentacion/uso-d1')).toBe(false);
    expect(needsDatabase('/admin/documentacion-otra')).toBe(true);
    expect(needsDatabase('/api/demo/state')).toBe(true);
  });

  it('ignores an expired emergency flag without silently extending the pause', () => {
    const circuit = new D1QuotaCircuit(() => Date.parse('2026-09-23T00:00:01Z'));
    expect(circuit.until('2026-09-23T00:00:00Z')).toBe(0);
    expect(circuit.until('not a date')).toBe(0);
  });

  it('rejects the scheduler without touching its request context or database', async () => {
    const context = new Proxy({}, {get() {throw new Error('The scheduler must not access any context');}});
    const response = await disabledScheduler(context as Parameters<typeof disabledScheduler>[0]);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({code:'SCHEDULER_DISABLED'});
  });
});
