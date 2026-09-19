import { SUPPLIER_ORDER_UPDATE_STATUSES, type SupplierOrderResult, type SupplierOrderStatus, type SupplierOrderUpdateStatus, type SupplierProduct, type SupplierShipment } from '../lib/demo-types';
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

type ShipmentRow = { id: number; sequence: number; expedition_number: string; tracking: string; created_at: string };
/** Unidades ya expedidas de una referencia. ?1 es el pedido del proveedor. */
const servedSql = (code: string) => `COALESCE((SELECT SUM(l.qty) FROM supplier_shipment_lines l
  JOIN supplier_shipments s ON s.id=l.shipment_id WHERE s.supplier_order_id=?1 AND l.code=${code}),0)`;
const lineCode = (alias: string) => `json_extract(${alias}.value,'$.code')`;
const lineQty = (alias: string) => `json_extract(${alias}.value,'$.qty')`;

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
    // «Enviado» significa que no queda ninguna unidad pendiente: expide el resto.
    if (status === 'shipped') {
      try { await this.shipOrder(reference, { requestKey: 'complete', lines: 'remaining' }); }
      catch (error) {
        // Otra expedición pudo completar el pedido entre la lectura y este envío: ya está hecho.
        const completed = error instanceof SupplierOrderError && error.code === 'shipment_rejected'
          && (await this.orderStatus(reference))?.status === 'shipped';
        if (!completed) throw error;
      }
    } else await this.db.prepare(`UPDATE supplier_orders SET status=?,updated_at=datetime('now')
      WHERE supplier_order_id=? AND status=?`).bind(status, existing.supplier_order_id, existing.status).run();
    return (await this.orderStatus(reference))!;
  }
  async shipments(reference: string): Promise<SupplierShipment[]> {
    const rows = await this.db.prepare(`SELECT s.id,s.sequence,s.expedition_number,s.tracking,s.created_at,l.code,l.qty
      FROM supplier_shipments s JOIN supplier_orders so ON so.supplier_order_id=s.supplier_order_id
      LEFT JOIN supplier_shipment_lines l ON l.shipment_id=s.id
      WHERE so.reference=?1 OR so.supplier_order_id=?1 ORDER BY s.sequence,l.code`)
      .bind(reference).all<ShipmentRow & { code: string | null; qty: number | null }>();
    const shipments = new Map<number, SupplierShipment>();
    for (const row of rows.results) {
      const shipment = shipments.get(row.id) ?? { sequence: row.sequence, expedition_number: row.expedition_number,
        tracking: row.tracking, date: row.created_at, lines: [] };
      if (row.code !== null && row.qty !== null) shipment.lines.push({ code: row.code, qty: row.qty });
      shipments.set(row.id, shipment);
    }
    return [...shipments.values()];
  }
  async shipOrder(reference: string, input: { requestKey: string; lines: { code: string; qty: number }[] | 'remaining' }) {
    if (typeof input.requestKey !== 'string' || !input.requestKey.trim() || input.requestKey.length > 160) {
      throw new SupplierOrderError('invalid_input', 'La clave de la expedición no es válida.');
    }
    const requested = input.lines === 'remaining' ? null : JSON.stringify(canonicalItems(input.lines));
    const order = await this.db.prepare('SELECT * FROM supplier_orders WHERE reference=?1 OR supplier_order_id=?1')
      .bind(reference).first<OrderRow>();
    if (!order) throw new Error('Pedido no encontrado en el proveedor demo.');
    const id = order.supplier_order_id;
    const replay = async () => {
      const row = await this.db.prepare('SELECT sequence FROM supplier_shipments WHERE supplier_order_id=? AND request_key=?')
        .bind(id, input.requestKey).first<{ sequence: number }>();
      if (!row) return null;
      const shipment = (await this.shipments(id)).find(candidate => candidate.sequence === row.sequence)!;
      // Completar lo pendiente es la misma intención aunque cambie lo que quedaba.
      if (requested && JSON.stringify(shipment.lines) !== requested) {
        throw new SupplierOrderError('idempotency_conflict', 'Esta clave ya corresponde a otra expedición.');
      }
      return shipment;
    };
    const existing = await replay();
    if (existing) return existing;
    const token = crypto.randomUUID();
    const suffix = id.replace('PED-ERP-', '');
    const number = "?2 || CASE WHEN n.sequence=1 THEN '' ELSE '-' || n.sequence END";
    // Validación, expedición, líneas y cabecera comparten la transacción D1: dos
    // solicitudes simultáneas nunca expiden más unidades que las pedidas.
    const valid = requested
      ? `NOT EXISTS (SELECT 1 FROM json_each(?6) r LEFT JOIN json_each(?5) i ON ${lineCode('i')}=${lineCode('r')}
          WHERE i.value IS NULL OR ${lineQty('r')}+${servedSql(lineCode('r'))}>${lineQty('i')})`
      : `EXISTS (SELECT 1 FROM json_each(?5) i WHERE ${lineQty('i')}>${servedSql(lineCode('i'))})`;
    const complete = `NOT EXISTS (SELECT 1 FROM json_each(?2) i WHERE ${lineQty('i')}>${servedSql(lineCode('i'))})`;
    const created = '(SELECT 1 FROM supplier_shipments WHERE creation_token=?3)';
    await this.db.batch([
      this.db.prepare(`INSERT INTO supplier_shipments(supplier_order_id,sequence,expedition_number,tracking,request_key,creation_token)
        SELECT so.supplier_order_id,n.sequence,'EXP-DEMO-' || ${number},'DEMO-' || ${number},?3,?4
        FROM supplier_orders so,(SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM supplier_shipments WHERE supplier_order_id=?1) n
        WHERE so.supplier_order_id=?1 AND so.status<>'shipped' AND ${valid}
        ON CONFLICT(supplier_order_id,request_key) DO NOTHING`).bind(id, suffix, input.requestKey, token, order.items_json, ...(requested ? [requested] : [])),
      requested
        ? this.db.prepare(`INSERT INTO supplier_shipment_lines(shipment_id,code,qty)
            SELECT s.id,${lineCode('r')},${lineQty('r')} FROM supplier_shipments s,json_each(?2) r WHERE s.creation_token=?1`)
            .bind(token, requested)
        : this.db.prepare(`INSERT INTO supplier_shipment_lines(shipment_id,code,qty)
            SELECT n.id,${lineCode('i')},${lineQty('i')}-${servedSql(lineCode('i'))}
            FROM supplier_shipments n,json_each(?2) i WHERE n.creation_token=?3 AND ${lineQty('i')}>${servedSql(lineCode('i'))}`)
            .bind(id, order.items_json, token),
      this.db.prepare(`UPDATE supplier_orders SET status=CASE WHEN ${complete} THEN 'shipped' ELSE 'partial' END,
          expedition_number=CASE WHEN ${complete} THEN (SELECT expedition_number FROM supplier_shipments WHERE creation_token=?3) ELSE expedition_number END,
          tracking=CASE WHEN ${complete} THEN (SELECT tracking FROM supplier_shipments WHERE creation_token=?3) ELSE tracking END,
          updated_at=datetime('now')
        WHERE supplier_order_id=?1 AND EXISTS ${created}`).bind(id, order.items_json, token),
    ]);
    const shipment = await replay();
    if (shipment) return shipment;
    const current = await this.orderStatus(id);
    throw new SupplierOrderError('shipment_rejected', current?.status === 'shipped'
      ? 'El proveedor demo ya ha expedido todas las unidades de este pedido.'
      : 'La expedición supera las unidades pendientes o incluye referencias ajenas al pedido.');
  }
}
