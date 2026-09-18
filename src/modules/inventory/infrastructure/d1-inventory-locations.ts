import type { InventoryLocationKind, InventoryLocationStatus } from '../domain/inventory-location';

export type InventoryLocationRecord = Readonly<{
  id: number;
  code: string;
  name: string;
  kind: InventoryLocationKind;
  status: InventoryLocationStatus;
  is_primary: number;
  timezone: string;
  version: number;
  variant_count: number;
  on_hand: number;
  reserved: number;
  created_at: string;
  updated_at: string;
}>;

export function createD1InventoryLocations(db: D1Database) {
  return Object.freeze({
    async list(): Promise<readonly InventoryLocationRecord[]> {
      return Object.freeze((await db.prepare(`SELECT l.*,
        count(b.variant_id) AS variant_count,
        COALESCE(sum(b.on_hand), 0) AS on_hand,
        COALESCE(sum(b.reserved), 0) AS reserved
        FROM inventory_locations l
        LEFT JOIN inventory_location_balances b ON b.location_id = l.id
        GROUP BY l.id ORDER BY l.is_primary DESC, l.status, l.name, l.id`)
        .all<InventoryLocationRecord>()).results);
    },

    find(id: number): Promise<InventoryLocationRecord | null> {
      return db.prepare(`SELECT l.*,
        count(b.variant_id) AS variant_count,
        COALESCE(sum(b.on_hand), 0) AS on_hand,
        COALESCE(sum(b.reserved), 0) AS reserved
        FROM inventory_locations l
        LEFT JOIN inventory_location_balances b ON b.location_id = l.id
        WHERE l.id = ? GROUP BY l.id`).bind(id).first<InventoryLocationRecord>();
    },
  });
}
