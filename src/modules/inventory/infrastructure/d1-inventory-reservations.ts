import {
  assertReservationCreation,
  assertReservationTransition,
  reservationExpiry,
  type InventoryReservation,
  type InventoryReservationLine,
} from '../domain/inventory-reservation';
import type { InventoryReservationState } from '../domain/inventory-ledger';

export type ReservationSourceLine = Readonly<{ product_id: number; qty: number }>;
export type VariantReservationSourceLine = Readonly<{ variant_id: number; qty: number }>;
export type ReservationGuard = Readonly<{ kind: 'event'; id: string }>;

type ReservationRow = Omit<InventoryReservation, 'lines'>;
type ReservationLineRow = Readonly<{
  variant_id: number;
  product_id: number;
  is_default: number;
  quantity: number;
  on_hand: number;
  reserved: number;
  version: number;
  reservation_version: number;
}>;

function aggregateProducts(lines: readonly ReservationSourceLine[]): Map<number, number> {
  const quantities = new Map<number, number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.product_id) || line.product_id < 1 ||
        !Number.isSafeInteger(line.qty) || line.qty < 1) {
      throw new RangeError('Las líneas de reserva exigen product_id y qty enteros positivos.');
    }
    quantities.set(line.product_id, (quantities.get(line.product_id) ?? 0) + line.qty);
  }
  return quantities;
}

function aggregateVariants(lines: readonly VariantReservationSourceLine[]): Map<number, number> {
  const quantities = new Map<number, number>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.variant_id) || line.variant_id < 1 ||
        !Number.isSafeInteger(line.qty) || line.qty < 1) {
      throw new RangeError('Las líneas de reserva exigen variant_id y qty enteros positivos.');
    }
    quantities.set(line.variant_id, (quantities.get(line.variant_id) ?? 0) + line.qty);
  }
  return quantities;
}

export function createD1InventoryReservations(db: D1Database) {
  async function linesForProducts(source: readonly ReservationSourceLine[]): Promise<readonly InventoryReservationLine[]> {
    const quantities = aggregateProducts(source);
    const productIds = [...quantities.keys()];
    if (productIds.length === 0) return [];
    const { results } = await db.prepare(`
      SELECT pv.id AS variant_id, pv.product_id, pv.is_default,
             b.on_hand, b.reserved, b.version, b.reservation_version
      FROM product_variants pv
      JOIN inventory_balances b ON b.variant_id = pv.id
      WHERE pv.is_default = 1 AND pv.product_id IN (${productIds.map(() => '?').join(',')})
      ORDER BY pv.id
    `).bind(...productIds).all<Omit<ReservationLineRow, 'quantity'>>();
    if (results.length !== productIds.length) throw new Error('No todas las líneas tienen variante default y balance.');
    return results.map((row) => Object.freeze({
      variant_id: row.variant_id,
      product_id: row.product_id,
      is_default: Boolean(row.is_default),
      quantity: quantities.get(row.product_id)!,
      balance: Object.freeze({
        variant_id: row.variant_id,
        on_hand: row.on_hand,
        reserved: row.reserved,
        version: row.version,
        reservation_version: row.reservation_version,
      }),
    }));
  }

  async function linesForVariants(
    source: readonly VariantReservationSourceLine[],
  ): Promise<readonly InventoryReservationLine[]> {
    const quantities = aggregateVariants(source);
    const variantIds = [...quantities.keys()];
    if (variantIds.length === 0) return [];
    const { results } = await db.prepare(`
      SELECT pv.id AS variant_id, pv.product_id, pv.is_default,
             b.on_hand, b.reserved, b.version, b.reservation_version
      FROM product_variants pv
      JOIN inventory_balances b ON b.variant_id = pv.id
      WHERE pv.id IN (${variantIds.map(() => '?').join(',')})
      ORDER BY pv.id
    `).bind(...variantIds).all<Omit<ReservationLineRow, 'quantity'>>();
    if (results.length !== variantIds.length) throw new Error('No todas las variantes tienen balance.');
    return results.map((row) => Object.freeze({
      variant_id: row.variant_id,
      product_id: row.product_id,
      is_default: Boolean(row.is_default),
      quantity: quantities.get(row.variant_id)!,
      balance: Object.freeze({
        variant_id: row.variant_id,
        on_hand: row.on_hand,
        reserved: row.reserved,
        version: row.version,
        reservation_version: row.reservation_version,
      }),
    }));
  }

  async function findForOrder(ownerId: string): Promise<InventoryReservation | null> {
    const row = await db.prepare(`
      SELECT id, owner_type, owner_id, status, idempotency_key, expires_at, version
      FROM inventory_reservations WHERE owner_type = 'order' AND owner_id = ?
    `).bind(ownerId).first<ReservationRow>();
    if (!row) return null;
    const { results } = await db.prepare(`
      SELECT l.variant_id, pv.product_id, pv.is_default, l.quantity,
             b.on_hand, b.reserved, b.version, b.reservation_version
      FROM inventory_reservation_lines l
      JOIN product_variants pv ON pv.id = l.variant_id
      JOIN inventory_balances b ON b.variant_id = l.variant_id
      WHERE l.reservation_id = ? ORDER BY l.variant_id
    `).bind(row.id).all<ReservationLineRow>();
    return Object.freeze({
      ...row,
      lines: Object.freeze(results.map((line) => Object.freeze({
        variant_id: line.variant_id,
        product_id: line.product_id,
        is_default: Boolean(line.is_default),
        quantity: line.quantity,
        balance: Object.freeze({
          variant_id: line.variant_id,
          on_hand: line.on_hand,
          reserved: line.reserved,
          version: line.version,
          reservation_version: line.reservation_version,
        }),
      }))),
    });
  }

  return Object.freeze({
    findForOrder,

    /** Una edición usa owner_type=order y un owner_id namespaceado. */
    findForOwner: findForOrder,

    async createForOrderStatements(
      ownerId: string,
      sourceLines: readonly ReservationSourceLine[],
      createdAt: string,
      guard: ReservationGuard,
      options: Readonly<{ ttlSeconds?: number; expiresAt?: string; reservationId?: string }> = {},
    ): Promise<readonly D1PreparedStatement[]> {
      const lines = await linesForProducts(sourceLines);
      const reservationId = options.reservationId ?? `res_${crypto.randomUUID()}`;
      const idempotencyKey = `inventory:reservation:order:${ownerId}`;
      const expiresAt = options.expiresAt ?? reservationExpiry(createdAt, options.ttlSeconds);
      assertReservationCreation({
        owner_type: 'order', owner_id: ownerId, idempotency_key: idempotencyKey,
        created_at: createdAt, expires_at: expiresAt, lines,
      });
      const statements: D1PreparedStatement[] = [db.prepare(`
        INSERT INTO inventory_reservations (
          id, owner_type, owner_id, status, idempotency_key, expires_at,
          version, created_at, updated_at
        )
        SELECT ?, 'order', ?, 'active', ?, ?, 1, ?, ?
        WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
      `).bind(
        reservationId, ownerId, idempotencyKey, expiresAt, createdAt, createdAt, guard.id,
      )];
      for (const line of lines) {
        const balanceVersion = line.balance.reservation_version + 1;
        const reservedAfter = line.balance.reserved + line.quantity;
        const lineKey = `${idempotencyKey}:variant:${line.variant_id}`;
        statements.push(
          db.prepare(`
            INSERT INTO inventory_reservation_lines (reservation_id, variant_id, quantity)
            VALUES (?, ?, ?)
          `).bind(reservationId, line.variant_id, line.quantity),
          db.prepare(`
            INSERT INTO inventory_reservation_balance_events (
              reservation_id, variant_id, transition, quantity_delta,
              reserved_after, reservation_version_after, idempotency_key, occurred_at
            ) VALUES (?, ?, 'created', ?, ?, ?, ?, ?)
          `).bind(
            reservationId, line.variant_id, line.quantity, reservedAfter,
            balanceVersion, lineKey, createdAt,
          ),
          db.prepare(`
            UPDATE inventory_balances
            SET reserved = ?, reservation_version = ?, updated_at = ?
            WHERE variant_id = ? AND reservation_version = ?
              AND EXISTS (
                SELECT 1 FROM inventory_reservation_balance_events
                WHERE idempotency_key = ?
              )
          `).bind(
            reservedAfter, balanceVersion, createdAt, line.variant_id,
            line.balance.reservation_version, lineKey,
          ),
        );
      }
      return statements;
    },

    async createForVariantStatements(
      ownerId: string,
      sourceLines: readonly VariantReservationSourceLine[],
      createdAt: string,
      guard: ReservationGuard,
      options: Readonly<{ ttlSeconds?: number; expiresAt?: string; reservationId?: string }> = {},
    ): Promise<readonly D1PreparedStatement[]> {
      const lines = await linesForVariants(sourceLines);
      const reservationId = options.reservationId ?? `res_${crypto.randomUUID()}`;
      const idempotencyKey = `inventory:reservation:order:${ownerId}`;
      const expiresAt = options.expiresAt ?? reservationExpiry(createdAt, options.ttlSeconds);
      assertReservationCreation({
        owner_type: 'order', owner_id: ownerId, idempotency_key: idempotencyKey,
        created_at: createdAt, expires_at: expiresAt, lines,
      });
      const statements: D1PreparedStatement[] = [db.prepare(`
        INSERT INTO inventory_reservations (
          id, owner_type, owner_id, status, idempotency_key, expires_at,
          version, created_at, updated_at
        )
        SELECT ?, 'order', ?, 'active', ?, ?, 1, ?, ?
        WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id = ?)
      `).bind(
        reservationId, ownerId, idempotencyKey, expiresAt, createdAt, createdAt, guard.id,
      )];
      for (const line of lines) {
        const balanceVersion = line.balance.reservation_version + 1;
        const reservedAfter = line.balance.reserved + line.quantity;
        const lineKey = `${idempotencyKey}:variant:${line.variant_id}`;
        statements.push(
          db.prepare(`
            INSERT INTO inventory_reservation_lines (reservation_id, variant_id, quantity)
            VALUES (?, ?, ?)
          `).bind(reservationId, line.variant_id, line.quantity),
          db.prepare(`
            INSERT INTO inventory_reservation_balance_events (
              reservation_id, variant_id, transition, quantity_delta,
              reserved_after, reservation_version_after, idempotency_key, occurred_at
            ) VALUES (?, ?, 'created', ?, ?, ?, ?, ?)
          `).bind(
            reservationId, line.variant_id, line.quantity, reservedAfter,
            balanceVersion, lineKey, createdAt,
          ),
          db.prepare(`
            UPDATE inventory_balances
            SET reserved = ?, reservation_version = ?, updated_at = ?
            WHERE variant_id = ? AND reservation_version = ?
              AND EXISTS (
                SELECT 1 FROM inventory_reservation_balance_events
                WHERE idempotency_key = ?
              )
          `).bind(
            reservedAfter, balanceVersion, createdAt, line.variant_id,
            line.balance.reservation_version, lineKey,
          ),
        );
      }
      return statements;
    },

    transitionStatements(
      reservation: InventoryReservation,
      to: Exclude<InventoryReservationState, 'active'>,
      occurredAt: string,
      idempotencyKey: string,
    ): readonly D1PreparedStatement[] {
      assertReservationTransition(reservation, to, occurredAt, idempotencyKey);
      const nextHeaderVersion = reservation.version + 1;
      const terminalColumn = to === 'released' ? 'released_at' : to === 'consumed' ? 'consumed_at' : 'expired_at';
      const statements: D1PreparedStatement[] = [
        db.prepare(`
          INSERT INTO inventory_reservation_events (
            reservation_id, transition, from_status, to_status,
            version_after, idempotency_key, occurred_at
          ) VALUES (?, ?, 'active', ?, ?, ?, ?)
        `).bind(reservation.id, to, to, nextHeaderVersion, idempotencyKey, occurredAt),
        db.prepare(`
          UPDATE inventory_reservations
          SET status = ?, version = ?, ${terminalColumn} = ?, updated_at = ?
          WHERE id = ? AND status = 'active' AND version = ?
            AND EXISTS (
              SELECT 1 FROM inventory_reservation_events WHERE idempotency_key = ?
            )
        `).bind(
          to, nextHeaderVersion, occurredAt, occurredAt,
          reservation.id, reservation.version, idempotencyKey,
        ),
      ];
      for (const line of reservation.lines) {
        const reservedAfter = line.balance.reserved - line.quantity;
        const nextReservationVersion = line.balance.reservation_version + 1;
        const balanceKey = `${idempotencyKey}:variant:${line.variant_id}`;
        statements.push(
          db.prepare(`
            INSERT INTO inventory_reservation_balance_events (
              reservation_id, variant_id, transition, quantity_delta,
              reserved_after, reservation_version_after, idempotency_key, occurred_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            reservation.id, line.variant_id, to, -line.quantity, reservedAfter,
            nextReservationVersion, balanceKey, occurredAt,
          ),
        );
        if (to === 'consumed') {
          const onHandAfter = line.balance.on_hand - line.quantity;
          const nextMovementVersion = line.balance.version + 1;
          statements.push(
            db.prepare(`
              UPDATE inventory_balances
              SET on_hand = ?, reserved = ?, version = ?, reservation_version = ?, updated_at = ?
              WHERE variant_id = ? AND version = ? AND reservation_version = ?
                AND EXISTS (
                  SELECT 1 FROM inventory_reservation_balance_events WHERE idempotency_key = ?
                )
            `).bind(
              onHandAfter, reservedAfter, nextMovementVersion, nextReservationVersion, occurredAt,
              line.variant_id, line.balance.version, line.balance.reservation_version, balanceKey,
            ),
            db.prepare(`
              INSERT INTO inventory_movements (
                variant_id, delta, reason, balance_after, version_after,
                actor_kind, actor_id, reference_type, reference_id,
                idempotency_key, correlation_id, occurred_at, created_at
              ) VALUES (?, ?, 'sale', ?, ?, 'system', 'inventory-reservation',
                'reservation', ?, ?, ?, ?, ?)
            `).bind(
              line.variant_id, -line.quantity, onHandAfter, nextMovementVersion,
              reservation.id, `${idempotencyKey}:sale:variant:${line.variant_id}`,
              `inventory:reservation:${reservation.id}`, occurredAt, occurredAt,
            ),
          );
          if (line.is_default) {
            statements.push(db.prepare(`
              UPDATE products SET stock = ?
              WHERE id = ? AND EXISTS (
                SELECT 1 FROM inventory_movements WHERE idempotency_key = ?
              )
            `).bind(
              onHandAfter, line.product_id, `${idempotencyKey}:sale:variant:${line.variant_id}`,
            ));
          }
        } else {
          statements.push(db.prepare(`
            UPDATE inventory_balances
            SET reserved = ?, reservation_version = ?, updated_at = ?
            WHERE variant_id = ? AND reservation_version = ?
              AND EXISTS (
                SELECT 1 FROM inventory_reservation_balance_events WHERE idempotency_key = ?
              )
          `).bind(
            reservedAfter, nextReservationVersion, occurredAt, line.variant_id,
            line.balance.reservation_version, balanceKey,
          ));
        }
      }
      return statements;
    },

    async expireDue(now: string, limit = 100): Promise<number> {
      const { results } = await db.prepare(`
        SELECT owner_id FROM inventory_reservations
        WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at, id LIMIT ?
      `).bind(now, limit).all<{ owner_id: string }>();
      let expired = 0;
      for (const { owner_id: ownerId } of results) {
        const reservation = await findForOrder(ownerId);
        if (!reservation || reservation.status !== 'active') continue;
        try {
          const batch = await db.batch([...this.transitionStatements(
            reservation, 'expired', now, `inventory:reservation:expire:${reservation.id}`,
          )]);
          if (batch[0]?.meta.changes === 1) expired += 1;
        } catch (error) {
          const current = await findForOrder(ownerId);
          if (current?.status === 'active') throw error;
        }
      }
      return expired;
    },
  });
}

export type D1InventoryReservations = ReturnType<typeof createD1InventoryReservations>;
