import { SUPPLIER_ORDER_UPDATE_STATUSES, type SupplierOrderResult, type SupplierOrderStatus, type SupplierOrderUpdateStatus, type SupplierProduct } from '../lib/demo-types';
import { SupplierOrderError, type SupplierAdapter } from './supplier-adapter';

type SupplierRow = Omit<SupplierProduct, 'available'>;
type OrderRow = { supplier_order_id: string; reference: string; status: SupplierOrderStatus; items_json: string; created_at: string; expedition_number: string | null; tracking: string | null };
function result(row: OrderRow): SupplierOrderResult {
  return { supplier_order_id: row.supplier_order_id, reference: row.reference, status: row.status,
    date: row.created_at, expedition_number: row.expedition_number, tracking: row.tracking };
}

function canonicalItems(items: { code: string; qty: number }[]) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
    throw new SupplierOrderError('invalid_input', 'El pedido debe contener entre 1 y 50 líneas.');
  }
  const quantities = new Map<string, number>();
  for (const item of items) {
    if (!item || typeof item.code !== 'string' || !item.code.trim() || item.code.length > 120 ||
        !Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 10000) {
      throw new SupplierOrderError('invalid_input', 'Las líneas del proveedor necesitan código y cantidad entera positiva.');
    }
    const code = item.code.trim();
    const qty = (quantities.get(code) ?? 0) + item.qty;
    if (qty > 10000) throw new SupplierOrderError('invalid_input', 'La cantidad agrupada excede el límite de la demo.');
    quantities.set(code, qty);
  }
  return [...quantities].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([code, qty]) => ({ code, qty }));
}

function assertMatchingItems(row: OrderRow, itemsJson: string) {
  if (JSON.stringify(canonicalItems(JSON.parse(row.items_json))) !== itemsJson) {
    throw new SupplierOrderError('idempotency_conflict', 'Esta referencia del proveedor ya corresponde a otro pedido.');
  }
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
    if (typeof input.reference !== 'string' || !input.reference.trim() || input.reference.length > 160) {
      throw new SupplierOrderError('invalid_input', 'La referencia del proveedor no es válida.');
    }
    const reference = input.reference.trim();
    const items = canonicalItems(input.items);
    const itemsJson = JSON.stringify(items);
    const existing = await this.db.prepare('SELECT * FROM supplier_orders WHERE reference=?').bind(reference).first<OrderRow>();
    if (existing) { assertMatchingItems(existing, itemsJson); return result(existing); }
    const id = `PED-ERP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const token = crypto.randomUUID();
    // Validación y descuento comparten la transacción D1. La disponibilidad se
    // comprueba sobre todas las líneas; backup_stock nunca se ofrece como stock firme.
    await this.db.batch([
      this.db.prepare(`INSERT INTO supplier_orders (supplier_order_id,reference,status,items_json,creation_token)
        SELECT ?,?,'pending',?,? WHERE NOT EXISTS (
          SELECT 1 FROM json_each(?) line LEFT JOIN supplier_products product
          ON product.code=json_extract(line.value,'$.code')
          WHERE product.code IS NULL OR product.active<>1 OR product.stock<json_extract(line.value,'$.qty')
        ) ON CONFLICT(reference) DO NOTHING`)
        .bind(id, reference, itemsJson, token, itemsJson),
      ...items.map((item) => this.db.prepare(`UPDATE supplier_products SET stock=stock-?,updated_at=datetime('now')
        WHERE code=? AND EXISTS (SELECT 1 FROM supplier_orders WHERE reference=? AND creation_token=?)`)
        .bind(item.qty, item.code, reference, token)),
    ]);
    const created = await this.db.prepare('SELECT * FROM supplier_orders WHERE reference=?').bind(reference).first<OrderRow>();
    if (!created) throw new SupplierOrderError('stock_unavailable', 'El proveedor demo no dispone de stock suficiente para todas las líneas activas.');
    // Otra llamada puede haber ganado la misma referencia con un payload diferente.
    assertMatchingItems(created, itemsJson);
    return result(created);
  }
  async advanceOrder(reference: string, status: SupplierOrderUpdateStatus) {
    if (!SUPPLIER_ORDER_UPDATE_STATUSES.includes(status)) {
      throw new SupplierOrderError('invalid_input','Selecciona un estado de destino válido para el proveedor.');
    }
    const existing = await this.orderStatus(reference);
    if (!existing) throw new Error('Pedido no encontrado en el proveedor demo.');
    if (existing.status === 'shipped' || existing.status === status) return existing;
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
