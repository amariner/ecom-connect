import {
  planInventoryMovement,
  type InventoryBalance,
  type InventoryMovementDraft,
} from '../domain/inventory-ledger';

export type InventoryWriteGuard = Readonly<{
  kind: 'event' | 'audit';
  id: string;
}>;

export type InventoryStockChange = Readonly<{
  variant_id: number;
  product_id: number;
  is_default: boolean;
  delta: number;
}>;

function guardSql(guard: InventoryWriteGuard): string {
  return guard.kind === 'event'
    ? 'EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)'
    : 'EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)';
}

export function createD1InventoryLedger(db: D1Database) {
  return Object.freeze({
    async balances(variantIds: readonly number[]): Promise<ReadonlyMap<number, InventoryBalance>> {
      const ids = [...new Set(variantIds)];
      if (ids.length === 0) return new Map();
      const placeholders = ids.map(() => '?').join(',');
      const { results } = await db.prepare(`
        SELECT variant_id, on_hand, reserved, version
        FROM inventory_balances
        WHERE variant_id IN (${placeholders})
      `).bind(...ids).all<InventoryBalance>();
      return new Map(results.map((balance) => [balance.variant_id, Object.freeze(balance)]));
    },

    movementStatements(
      balance: InventoryBalance,
      change: InventoryStockChange,
      draft: InventoryMovementDraft,
      occurredAt: string,
      guard: InventoryWriteGuard,
    ): readonly D1PreparedStatement[] {
      if (change.variant_id !== balance.variant_id) {
        throw new RangeError('El cambio de inventario no corresponde al balance leído.');
      }
      if (!Number.isSafeInteger(change.product_id) || change.product_id < 1) {
        throw new RangeError('product_id debe ser un entero seguro >= 1.');
      }
      const planned = planInventoryMovement(balance, { ...draft, delta: change.delta });
      const guarded = guardSql(guard);
      const statements: D1PreparedStatement[] = [
        db.prepare(`
          UPDATE inventory_balances
          SET on_hand = ?, version = ?, updated_at = ?
          WHERE variant_id = ? AND version = ?
            AND on_hand + ? >= reserved
            AND NOT EXISTS (
              SELECT 1 FROM inventory_movements WHERE idempotency_key = ?
            )
            AND ${guarded}
        `).bind(
          planned.on_hand,
          planned.version_after,
          occurredAt,
          balance.variant_id,
          balance.version,
          change.delta,
          draft.idempotency_key,
          guard.id,
        ),
        // Si la guarda existe pero el UPDATE anterior perdió una carrera, esta
        // inserción colisiona con variante+versión (o con idempotencia) y D1
        // revierte la batch completa. Si la guarda no existe, el perdedor no
        // escribe nada.
        db.prepare(`
          INSERT INTO inventory_movements (
            variant_id, delta, reason, balance_after, version_after,
            actor_kind, actor_id, reference_type, reference_id,
            idempotency_key, correlation_id, occurred_at, created_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ${guarded}
        `).bind(
          balance.variant_id,
          change.delta,
          draft.reason,
          planned.balance_after,
          planned.version_after,
          draft.actor_kind,
          draft.actor_id,
          draft.reference_type,
          draft.reference_id,
          draft.idempotency_key,
          draft.correlation_id,
          occurredAt,
          occurredAt,
          guard.id,
        ),
      ];
      if (change.is_default) {
        statements.push(db.prepare(`
          UPDATE products
          SET stock = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM product_variants pv
              WHERE pv.id = ? AND pv.product_id = products.id AND pv.is_default = 1
            )
            AND EXISTS (
              SELECT 1 FROM inventory_balances b
              WHERE b.variant_id = ? AND b.version = ? AND b.on_hand = ?
            )
            AND EXISTS (
              SELECT 1 FROM inventory_movements m
              WHERE m.idempotency_key = ?
            )
            AND ${guarded}
        `).bind(
          planned.on_hand,
          change.product_id,
          change.variant_id,
          change.variant_id,
          planned.version_after,
          planned.on_hand,
          draft.idempotency_key,
          guard.id,
        ));
      }
      return statements;
    },
  });
}

export type D1InventoryLedger = ReturnType<typeof createD1InventoryLedger>;
