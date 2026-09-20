import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDemoOrder, getState, performAction, processPendingOrders, runScheduledDispatch, syncSupplier,
} from '../src/lib/demo';
import { d1Adapter, hookedD1, migratedDatabase } from './helpers/d1.mjs';

let sqlite;
let db;
const origin = 'https://demo.test';
const customer = {name:'Laura Demo',email:'laura@example.test',street:'Calle Ficticia 10',city:'Castellón',postal_code:'12001'};
const order = (qty = 1) => createDemoOrder(db,{lines:[{slug:'champu-demo',qty}],customer,idempotency_key:crypto.randomUUID()});
const runs = () => sqlite.prepare('SELECT source,status,reason,processed,errors,remaining,finished_at FROM dispatch_runs ORDER BY id').all();
const accepted = () => sqlite.prepare('SELECT count(*) n FROM supplier_orders').get().n;

beforeEach(async () => {
  sqlite = migratedDatabase();
  sqlite.exec(`INSERT INTO supplier_products(code,slug,name,description,price_cents,pvp_cents,brand,category,image,ean,sku,stock) VALUES
    ('SUP-001','champu-demo','Champú demo','Producto ficticio',1290,1590,'Dermocare','capilar','/images/demo.svg','2000000000008','FH-001',40);
    INSERT INTO shipping_rates(zone,label,price_cents,free_over_cents) VALUES ('peninsula','Envío demo',490,4900);`);
  db = d1Adapter(sqlite);
  await syncSupplier(db);
});
afterEach(() => { sqlite.close(); });

describe('grouped dispatch runs',() => {
  it('records a manual run with what it sent and what is left',async () => {
    await order(); await order(); await order();
    const result = await processPendingOrders(db,{limit:2});
    expect(result).toMatchObject({processed:2,errors:0,remaining:1,status:'completed'});
    expect(runs()).toEqual([{source:'manual',status:'completed',reason:null,processed:2,errors:0,remaining:1,finished_at:expect.any(String)}]);
    expect(await processPendingOrders(db)).toMatchObject({processed:1,errors:0,remaining:0});
    expect(accepted()).toBe(3);
  });

  it('counts the orders the supplier could not accept and keeps them pending',async () => {
    await order(); await order(5);
    sqlite.exec("UPDATE supplier_products SET stock=3 WHERE code='SUP-001'");
    const result = await processPendingOrders(db);
    expect(result).toMatchObject({processed:1,errors:1,remaining:1,status:'completed'});
    expect(runs().at(-1)).toMatchObject({processed:1,errors:1,remaining:1});
  });

  it('records an empty run without touching anything',async () => {
    expect(await processPendingOrders(db)).toMatchObject({processed:0,errors:0,remaining:0,status:'completed'});
    expect(accepted()).toBe(0);
  });

  it('skips a run that starts while another one is still processing',async () => {
    await order(); await order();
    const hooked = hookedD1(sqlite);
    let overlapping;
    hooked.on(/INSERT INTO supplier_orders/,async () => { overlapping = await processPendingOrders(db); });
    const first = await processPendingOrders(hooked.db);
    expect(overlapping).toMatchObject({processed:0,errors:0,status:'skipped',reason:'overlap'});
    expect(first).toMatchObject({processed:2,errors:0,status:'completed'});
    expect(accepted()).toBe(2);
    expect(runs().map(run => [run.status,run.reason])).toEqual([['completed',null],['skipped','overlap']]);
  });

  it('releases the lock of a run interrupted more than ten minutes ago',async () => {
    await order();
    sqlite.prepare("INSERT INTO dispatch_runs(source,status,started_at) VALUES ('scheduled','running',?)")
      .run(new Date(Date.now() - 11 * 60_000).toISOString());
    expect(await processPendingOrders(db)).toMatchObject({processed:1,status:'completed'});
    expect(runs().map(run => [run.status,run.reason])).toEqual([['failed','interrupted'],['completed',null]]);
  });

  it('does not steal the lock of a recent run',async () => {
    await order();
    sqlite.prepare("INSERT INTO dispatch_runs(source,status,started_at) VALUES ('manual','running',?)")
      .run(new Date(Date.now() - 60_000).toISOString());
    expect(await processPendingOrders(db)).toMatchObject({processed:0,status:'skipped',reason:'overlap'});
    expect(accepted()).toBe(0);
  });

  it('closes the run as failed and frees the lock when it breaks unexpectedly',async () => {
    await order();
    const hooked = hookedD1(sqlite);
    hooked.on(/SELECT id FROM orders WHERE/,() => { throw new Error('D1 no disponible'); });
    await expect(processPendingOrders(hooked.db)).rejects.toThrow();
    expect(runs()).toEqual([expect.objectContaining({status:'failed',reason:'unexpected_error',finished_at:expect.any(String)})]);
    expect(await processPendingOrders(db)).toMatchObject({processed:1,status:'completed'});
  });
});

describe('scheduled dispatch supervision',() => {
  it('runs on schedule and records its origin',async () => {
    await order();
    expect(await runScheduledDispatch(db)).toMatchObject({processed:1,status:'completed'});
    expect(runs()).toEqual([expect.objectContaining({source:'scheduled',status:'completed',processed:1})]);
  });

  it('skips scheduled runs while paused, but never a manual one',async () => {
    await order();
    await performAction(db,{action:'settings',dispatch_paused:true},origin);
    expect(await runScheduledDispatch(db)).toMatchObject({processed:0,status:'skipped',reason:'paused'});
    expect(accepted()).toBe(0);
    expect((await getState(db,origin)).settings.dispatch_paused).toBe(true);
    expect(await processPendingOrders(db)).toMatchObject({processed:1,status:'completed'});
    await performAction(db,{action:'settings',dispatch_paused:false},origin);
    await order();
    expect(await runScheduledDispatch(db)).toMatchObject({processed:1,status:'completed'});
  });

  it('keeps the dispatch mode when only the pause changes, and the other way round',async () => {
    await performAction(db,{action:'settings',dispatch_mode:'immediate'},origin);
    await performAction(db,{action:'settings',dispatch_paused:true},origin);
    await performAction(db,{action:'settings',dispatch_mode:'grouped'},origin);
    expect((await getState(db,origin)).settings).toMatchObject({dispatch_mode:'grouped',dispatch_paused:true});
    await expect(performAction(db,{action:'settings'},origin)).rejects.toThrow();
    await expect(performAction(db,{action:'settings',dispatch_paused:'yes'},origin)).rejects.toThrow();
  });

  it('exposes the five most recent runs in the panel state',async () => {
    for (let index = 0; index < 6; index++) await processPendingOrders(db);
    await order();
    await processPendingOrders(db);
    const state = await getState(db,origin);
    expect(state.dispatch_runs).toHaveLength(5);
    expect(state.dispatch_runs[0]).toEqual({id:7,source:'manual',status:'completed',reason:null,processed:1,errors:0,remaining:0,
      started_at:expect.any(String),finished_at:expect.any(String)});
    expect(state.dispatch_runs.map(run => run.id)).toEqual([7,6,5,4,3]);
  });
});
