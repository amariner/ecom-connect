import type { SupplierOrderResult, SupplierOrderStatus, SupplierProduct } from '../lib/demo-types';
import type { SupplierAdapter } from './supplier-adapter';

type SupplierRow = Omit<SupplierProduct, 'available'>;
type OrderRow = { supplier_order_id: string; reference: string; status: SupplierOrderStatus; created_at: string; expedition_number: string | null; tracking: string | null };
function result(row: OrderRow): SupplierOrderResult {
  return { supplier_order_id: row.supplier_order_id, reference: row.reference, status: row.status,
    date: row.created_at, expedition_number: row.expedition_number, tracking: row.tracking };
}

/** Proveedor completamente local: nunca ejecuta fetch ni crea envíos reales. */
export class MockSupplierAdapter implements SupplierAdapter {
  constructor(private readonly db: D1Database) {}
  async catalog(): Promise<SupplierProduct[]> {
    const rows = await this.db.prepare('SELECT * FROM supplier_products ORDER BY code').all<SupplierRow>();
    return rows.results.map((row) => ({ ...row, available: row.active === 1 && row.stock > 0 }));
  }
  async stock() {
    return (await this.catalog()).map(({ code, stock, backup_stock, available }) => ({ code, stock, backup_stock, available }));
  }
  async orderStatus(reference: string) {
    const row = await this.db.prepare('SELECT * FROM supplier_orders WHERE reference = ? OR supplier_order_id = ?')
      .bind(reference, reference).first<OrderRow>();
    return row ? result(row) : null;
  }
  async createOrder(input: { reference: string; items: { code: string; qty: number }[] }) {
    const existing = await this.orderStatus(input.reference);
    if (existing) return existing;
    const id = `PED-ERP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const token = crypto.randomUUID();
    // Una referencia remota solo descuenta stock una vez, incluso con reintentos concurrentes.
    await this.db.batch([
      this.db.prepare(`INSERT INTO supplier_orders (supplier_order_id,reference,status,items_json,creation_token)
        VALUES (?,?,'pending',?,?) ON CONFLICT(reference) DO NOTHING`)
        .bind(id, input.reference, JSON.stringify(input.items), token),
      ...input.items.map((item) => this.db.prepare(`UPDATE supplier_products SET stock=stock-?,updated_at=datetime('now')
        WHERE code=? AND EXISTS (SELECT 1 FROM supplier_orders WHERE reference=? AND creation_token=?)`)
        .bind(item.qty, item.code, input.reference, token)),
    ]);
    const created = await this.orderStatus(input.reference);
    if (!created) throw new Error('No se pudo registrar el pedido en el proveedor demo.');
    return created;
  }
  async advanceOrder(reference: string, requested?: SupplierOrderStatus) {
    const existing = await this.orderStatus(reference);
    if (!existing) throw new Error('Pedido no encontrado en el proveedor demo.');
    if (existing.status === 'shipped') return existing;
    const status = requested ?? (existing.status === 'pending' || existing.status === 'error' ? 'processing' : 'shipped');
    const allowed: Record<SupplierOrderStatus, readonly SupplierOrderStatus[]> = {
      pending: ['processing','partial','shipped','error'], processing: ['partial','shipped','error'],
      partial: ['processing','shipped','error'], error: ['processing','partial','shipped'], shipped: [],
    };
    if (status !== existing.status && !allowed[existing.status].includes(status)) throw new Error('Transición del proveedor no válida.');
    const suffix = existing.supplier_order_id.replace('PED-ERP-', '');
    const expectedState = status === 'shipped' ? "status<>'shipped'" : 'status=?';
    await this.db.prepare(`UPDATE supplier_orders SET status=?,expedition_number=?,tracking=?,updated_at=datetime('now')
      WHERE supplier_order_id=? AND ${expectedState}`).bind(status,
      status === 'shipped' ? `EXP-DEMO-${suffix}` : existing.expedition_number,
      status === 'shipped' ? `DEMO-${suffix}` : existing.tracking,
      existing.supplier_order_id, ...(status === 'shipped' ? [] : [existing.status])).run();
    return (await this.orderStatus(reference))!;
  }
}
