import type { InventoryTransferStatus } from '../domain/inventory-transfer';

export type InventoryTransferRecord = Readonly<{
  id: string;
  transfer_number: string;
  source_location_id: number;
  source_name: string;
  source_code: string;
  source_is_primary: number;
  destination_location_id: number;
  destination_name: string;
  destination_code: string;
  destination_is_primary: number;
  status: InventoryTransferStatus;
  version: number;
  note: string | null;
  line_count: number;
  requested_quantity: number;
  sent_quantity: number;
  received_quantity: number;
  discrepancy_quantity: number;
  created_at: string;
  updated_at: string;
  shipped_at: string | null;
  completed_at: string | null;
}>;

export type InventoryTransferLineRecord = Readonly<{
  id: string;
  transfer_id: string;
  variant_id: number;
  product_id: number;
  is_default: number;
  product_name: string;
  sku: string;
  variant_title: string;
  requested_quantity: number;
  sent_quantity: number;
  received_quantity: number;
  discrepancy_quantity: number;
  created_at: string;
  updated_at: string;
}>;

export type InventoryTransferDetail = Readonly<{
  transfer: InventoryTransferRecord;
  lines: readonly InventoryTransferLineRecord[];
}>;

export type InventoryTransferStockOption = Readonly<{
  location_id: number;
  location_name: string;
  location_code: string;
  variant_id: number;
  product_name: string;
  sku: string;
  variant_title: string;
  available: number;
}>;

const TRANSFER_SELECT = `SELECT t.*,
  source.name AS source_name, source.code AS source_code, source.is_primary AS source_is_primary,
  destination.name AS destination_name, destination.code AS destination_code,
  destination.is_primary AS destination_is_primary,
  count(lines.id) AS line_count,
  COALESCE(sum(lines.requested_quantity), 0) AS requested_quantity,
  COALESCE(sum(lines.sent_quantity), 0) AS sent_quantity,
  COALESCE(sum(lines.received_quantity), 0) AS received_quantity,
  COALESCE(sum(lines.discrepancy_quantity), 0) AS discrepancy_quantity
  FROM inventory_transfers t
  JOIN inventory_locations source ON source.id = t.source_location_id
  JOIN inventory_locations destination ON destination.id = t.destination_location_id
  LEFT JOIN inventory_transfer_lines lines ON lines.transfer_id = t.id`;

export function createD1InventoryTransfers(db: D1Database) {
  return Object.freeze({
    async list(): Promise<readonly InventoryTransferRecord[]> {
      const { results } = await db.prepare(`${TRANSFER_SELECT}
        GROUP BY t.id ORDER BY t.updated_at DESC, t.id DESC LIMIT 100`)
        .all<InventoryTransferRecord>();
      return Object.freeze(results.map((row) => Object.freeze(row)));
    },

    async find(id: string): Promise<InventoryTransferDetail | null> {
      const transfer = await db.prepare(`${TRANSFER_SELECT} WHERE t.id = ? GROUP BY t.id`)
        .bind(id).first<InventoryTransferRecord>();
      if (!transfer) return null;
      const { results } = await db.prepare(`SELECT lines.*, pv.product_id, pv.is_default,
        p.name AS product_name, pv.sku, pv.title AS variant_title
        FROM inventory_transfer_lines lines
        JOIN product_variants pv ON pv.id = lines.variant_id
        JOIN products p ON p.id = pv.product_id
        WHERE lines.transfer_id = ? ORDER BY lines.created_at, lines.id`)
        .bind(id).all<InventoryTransferLineRecord>();
      return Object.freeze({ transfer: Object.freeze(transfer), lines: Object.freeze(results.map((row) => Object.freeze(row))) });
    },

    async findByCreateKey(key: string): Promise<InventoryTransferDetail | null> {
      const id = await db.prepare('SELECT id FROM inventory_transfers WHERE create_idempotency_key = ?')
        .bind(key).first<{ id: string }>('id');
      return typeof id === 'string' ? this.find(id) : null;
    },

    async stockOptions(): Promise<readonly InventoryTransferStockOption[]> {
      const { results } = await db.prepare(`SELECT l.id AS location_id, l.name AS location_name,
        l.code AS location_code, b.variant_id, p.name AS product_name, pv.sku,
        pv.title AS variant_title, b.on_hand - b.reserved AS available
        FROM inventory_location_balances b
        JOIN inventory_locations l ON l.id = b.location_id AND l.status = 'active'
        JOIN product_variants pv ON pv.id = b.variant_id AND pv.status = 'active'
        JOIN products p ON p.id = pv.product_id
        WHERE b.on_hand > b.reserved
        ORDER BY l.is_primary DESC, l.name, p.name, pv.sku LIMIT 500`)
        .all<InventoryTransferStockOption>();
      return Object.freeze(results.map((row) => Object.freeze(row)));
    },
  });
}

export type D1InventoryTransfers = ReturnType<typeof createD1InventoryTransfers>;
