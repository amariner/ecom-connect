import type { InventoryCountReason, InventoryCountStatus } from '../domain/inventory-count';

export type InventoryCountRecord = Readonly<{
  id: string;
  count_number: string;
  location_id: number;
  location_name: string;
  location_code: string;
  location_is_primary: number;
  status: InventoryCountStatus;
  reason: InventoryCountReason;
  requires_approval: number;
  counted_by: string;
  reviewed_by: string | null;
  version: number;
  note: string | null;
  line_count: number;
  absolute_delta: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  applied_at: string | null;
}>;

export type InventoryCountLineRecord = Readonly<{
  id: string;
  count_id: string;
  variant_id: number;
  product_id: number;
  is_default: number;
  product_name: string;
  sku: string;
  variant_title: string;
  expected_quantity: number;
  counted_quantity: number;
  delta: number;
  expected_movement_version: number;
}>;

export type InventoryCountDetail = Readonly<{
  count: InventoryCountRecord;
  lines: readonly InventoryCountLineRecord[];
}>;

export type InventoryCountStockOption = Readonly<{
  location_id: number;
  location_name: string;
  variant_id: number;
  product_name: string;
  sku: string;
  variant_title: string;
  on_hand: number;
}>;

const COUNT_SELECT = `SELECT c.*, l.name AS location_name, l.code AS location_code,
  l.is_primary AS location_is_primary, count(lines.id) AS line_count,
  COALESCE(sum(abs(lines.delta)), 0) AS absolute_delta
  FROM inventory_counts c
  JOIN inventory_locations l ON l.id = c.location_id
  LEFT JOIN inventory_count_lines lines ON lines.count_id = c.id`;

export function createD1InventoryCounts(db: D1Database) {
  async function find(id: string): Promise<InventoryCountDetail | null> {
    const count = await db.prepare(`${COUNT_SELECT} WHERE c.id = ? GROUP BY c.id`)
      .bind(id).first<InventoryCountRecord>();
    if (!count) return null;
    const { results } = await db.prepare(`SELECT lines.*, pv.product_id, pv.is_default,
      p.name AS product_name, pv.sku, pv.title AS variant_title
      FROM inventory_count_lines lines
      JOIN product_variants pv ON pv.id = lines.variant_id
      JOIN products p ON p.id = pv.product_id
      WHERE lines.count_id = ? ORDER BY lines.created_at, lines.id`)
      .bind(id).all<InventoryCountLineRecord>();
    return Object.freeze({ count: Object.freeze(count), lines: Object.freeze(results.map((row) => Object.freeze(row))) });
  }

  return Object.freeze({
    async list(): Promise<readonly InventoryCountRecord[]> {
      const { results } = await db.prepare(`${COUNT_SELECT}
        GROUP BY c.id ORDER BY c.updated_at DESC, c.id DESC LIMIT 100`)
        .all<InventoryCountRecord>();
      return Object.freeze(results.map((row) => Object.freeze(row)));
    },
    find,
    async findByCreateKey(key: string): Promise<InventoryCountDetail | null> {
      const id = await db.prepare('SELECT id FROM inventory_counts WHERE create_idempotency_key = ?')
        .bind(key).first<{ id: string }>('id');
      return typeof id === 'string' ? find(id) : null;
    },
    async stockOptions(): Promise<readonly InventoryCountStockOption[]> {
      const { results } = await db.prepare(`SELECT l.id AS location_id, l.name AS location_name,
        b.variant_id, p.name AS product_name, pv.sku, pv.title AS variant_title, b.on_hand
        FROM inventory_location_balances b
        JOIN inventory_locations l ON l.id = b.location_id AND l.status = 'active'
        JOIN product_variants pv ON pv.id = b.variant_id AND pv.status = 'active'
        JOIN products p ON p.id = pv.product_id
        ORDER BY l.is_primary DESC, l.name, p.name, pv.sku LIMIT 1000`)
        .all<InventoryCountStockOption>();
      return Object.freeze(results.map((row) => Object.freeze(row)));
    },
  });
}

export type D1InventoryCounts = ReturnType<typeof createD1InventoryCounts>;
