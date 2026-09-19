import type { APIRoute } from 'astro';
import { z } from 'zod';
import { MockSupplierAdapter } from '../../../integrations/mock-supplier-adapter';
import { DemoError,advanceOrder,dispatchOrder,upsertSupplierProduct } from '../../../lib/demo';
import { demoApi,readJson } from '../../../lib/demo-http';
import { SUPPLIER_ORDER_UPDATE_STATUSES } from '../../../lib/demo-types';
export const prerender = false;
export const GET: APIRoute = (context) => demoApi(context,async () => {
  const adapter = new MockSupplierAdapter(context.locals.runtime.env.DB);
  if (context.params.path === 'catalog') return {demo:true,products:await adapter.catalog()};
  if (context.params.path === 'stock') return {demo:true,stock:await adapter.stock()};
  if (context.params.path === 'orders') return {demo:true,order:await adapter.orderStatus(context.url.searchParams.get('reference') ?? '')};
  throw new DemoError('Endpoint no encontrado.',404);
});
export const POST: APIRoute = (context) => demoApi(context,async () => {
  const db = context.locals.runtime.env.DB;
  const raw = await readJson(context.request);
  if (context.params.path === 'stock') {
    const input = z.object({code:z.string().min(1).max(120),stock:z.number().int().min(0).max(10000),backup_stock:z.number().int().min(0).max(10000).optional()}).parse(raw);
    const update = await db.prepare("UPDATE supplier_products SET stock=?,backup_stock=COALESCE(?,backup_stock),updated_at=datetime('now') WHERE code=?")
      .bind(input.stock,input.backup_stock ?? null,input.code).run();
    if (update.meta.changes !== 1) throw new DemoError('Artículo no encontrado.',404);
    return {demo:true,updated:true};
  }
  if (context.params.path === 'catalog') {
    return upsertSupplierProduct(db,raw);
  }
  if (context.params.path === 'orders') {
    const input = z.object({order_id:z.number().int().positive()}).parse(raw);
    return dispatchOrder(db,input.order_id);
  }
  if (context.params.path === 'status') {
    const input = z.object({order_id:z.number().int().positive(),status:z.enum(SUPPLIER_ORDER_UPDATE_STATUSES)}).parse(raw);
    return advanceOrder(db,input.order_id,input.status);
  }
  throw new DemoError('Endpoint no encontrado.',404);
},true);
