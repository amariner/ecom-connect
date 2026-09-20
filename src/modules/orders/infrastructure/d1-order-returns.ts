import type { ReturnAction, ReturnReason, ReturnStatus, ReturnableLine } from '../domain/customer-return';

export type OrderReturnRow = {
  id: string; return_number: string; public_ref: string; order_id: number; order_number: string;
  status: ReturnStatus; reason: ReturnReason; comment: string | null; decision_note: string | null;
  refund_cents: number; requested_at: string; updated_at: string; version: number;
};
export type OrderReturnLineRow = { order_item_id: number; name: string; qty: number; unit_price_cents: number };
export type OrderReturnEventRow = { to_status: string; note: string | null; actor: string; created_at: string };
export type OrderReturn = OrderReturnRow & { lines: OrderReturnLineRow[]; events: OrderReturnEventRow[] };

const RETURN_COLUMNS = `r.id,r.return_number,r.public_ref,r.order_id,o.order_number,r.status,r.reason,
  r.comment,r.decision_note,r.refund_cents,r.requested_at,r.updated_at,r.version
  FROM order_returns r JOIN orders o ON o.id=r.order_id`;

export function createD1OrderReturns(db: D1Database) {
  async function hydrate(rows: OrderReturnRow[]): Promise<OrderReturn[]> {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    const [lines, events] = await Promise.all([
      db.prepare(`SELECT l.return_id,l.order_item_id,l.qty,l.unit_price_cents,i.name_snapshot AS name
        FROM order_return_lines l JOIN order_items i ON i.id=l.order_item_id
        WHERE l.return_id IN (${placeholders}) ORDER BY l.order_item_id`)
        .bind(...ids).all<OrderReturnLineRow & { return_id: string }>(),
      db.prepare(`SELECT return_id,to_status,note,actor,created_at FROM order_return_events
        WHERE return_id IN (${placeholders}) ORDER BY id`)
        .bind(...ids).all<OrderReturnEventRow & { return_id: string }>(),
    ]);
    return rows.map((row) => ({
      ...row,
      lines: lines.results.filter((line) => line.return_id === row.id)
        .map(({ order_item_id, name, qty, unit_price_cents }) => ({ order_item_id, name, qty, unit_price_cents })),
      events: events.results.filter((event) => event.return_id === row.id)
        .map(({ to_status, note, actor, created_at }) => ({ to_status, note, actor, created_at })),
    }));
  }

  return {
    /** Lo que queda por devolver de cada línea: lo comprado menos lo ya reclamado. */
    async returnableLines(orderId: number): Promise<ReturnableLine[]> {
      const rows = await db.prepare(`SELECT i.id AS order_item_id,i.name_snapshot AS name,i.unit_price_cents,
          COALESCE(i.current_qty,i.qty) AS purchased,
          COALESCE((SELECT SUM(l.qty) FROM order_return_lines l JOIN order_returns r ON r.id=l.return_id
            WHERE l.order_item_id=i.id AND r.status NOT IN ('rejected','cancelled')),0) AS claimed
        FROM order_items i WHERE i.order_id=? ORDER BY i.id`).bind(orderId).all<ReturnableLine>();
      return rows.results;
    },

    /** Fecha en la que el comercio dio el pedido por entregado. */
    async deliveredAt(orderId: number): Promise<string | null> {
      const row = await db.prepare(`SELECT MAX(created_at) AS delivered_at FROM order_events
        WHERE order_id=? AND to_status='delivered'`).bind(orderId).first<{ delivered_at: string | null }>();
      return row?.delivered_at ?? null;
    },

    async listForOrder(orderId: number): Promise<OrderReturn[]> {
      const rows = await db.prepare(`SELECT ${RETURN_COLUMNS} WHERE r.order_id=? ORDER BY r.requested_at DESC,r.id`)
        .bind(orderId).all<OrderReturnRow>();
      return hydrate(rows.results);
    },

    async listForProfile(profileId: string): Promise<OrderReturn[]> {
      const rows = await db.prepare(`SELECT ${RETURN_COLUMNS} WHERE r.customer_profile_id=?
        ORDER BY r.requested_at DESC,r.id LIMIT 50`).bind(profileId).all<OrderReturnRow>();
      return hydrate(rows.results);
    },

    async readOwned(profileId: string, publicRef: string): Promise<OrderReturn | null> {
      const rows = await db.prepare(`SELECT ${RETURN_COLUMNS} WHERE r.customer_profile_id=? AND r.public_ref=?`)
        .bind(profileId,publicRef).all<OrderReturnRow>();
      return (await hydrate(rows.results))[0] ?? null;
    },

    /**
     * Abre la devolución con sus líneas y su primer movimiento en una sola
     * transacción: las guardas deciden ventana, propiedad y unidades, de modo
     * que una entrega deshecha o una carrera no dejan media solicitud.
     */
    async create(input: {
      id: string; return_number: string; public_ref: string; order_id: number; customer_profile_id: string;
      reason: ReturnReason; comment: string | null; idempotency_key: string; now: string;
      lines: readonly { order_item_id: number; qty: number; unit_price_cents: number }[];
    }): Promise<void> {
      await db.batch([
        db.prepare(`INSERT INTO order_returns(
            id,return_number,public_ref,order_id,customer_profile_id,status,reason,comment,
            create_idempotency_key,requested_at,updated_at,version
          ) VALUES (?,?,?,?,?,'requested',?,?,?,?,?,1)`)
          .bind(input.id,input.return_number,input.public_ref,input.order_id,input.customer_profile_id,
            input.reason,input.comment,input.idempotency_key,input.now,input.now),
        ...input.lines.map((line) => db.prepare(
          'INSERT INTO order_return_lines(return_id,order_item_id,qty,unit_price_cents) VALUES (?,?,?,?)')
          .bind(input.id,line.order_item_id,line.qty,line.unit_price_cents)),
        db.prepare(`INSERT INTO order_return_events(return_id,to_status,note,actor,version_after,created_at)
          VALUES (?,'requested',NULL,'customer',1,?)`).bind(input.id,input.now),
      ]);
    },

    async findByIdempotencyKey(key: string): Promise<string | null> {
      const row = await db.prepare('SELECT public_ref FROM order_returns WHERE create_idempotency_key=?')
        .bind(key).first<{ public_ref: string }>();
      return row?.public_ref ?? null;
    },

    /**
     * Aplica una transición ya decidida. La actualización exige el estado y la
     * versión leídos, así que dos decisiones simultáneas dejan una sola. La
     * reposición del stock al recibir la cuelga un disparador de esa misma
     * transición: nunca se ejecuta dos veces ni depende de quien la escriba.
     */
    async transition(input: {
      id: string; from: ReturnStatus; to: ReturnStatus; version: number; action: ReturnAction;
      actor: 'customer' | 'panel'; note: string | null; refund_cents: number; now: string;
    }): Promise<boolean> {
      try {
        const results = await db.batch([
          db.prepare(`UPDATE order_returns SET status=?,decision_note=COALESCE(?,decision_note),
              refund_cents=?,updated_at=?,version=version+1
            WHERE id=? AND status=? AND version=?`)
            .bind(input.to,input.note,input.refund_cents,input.now,input.id,input.from,input.version),
          db.prepare(`INSERT INTO order_return_events(
              return_id,to_status,note,actor,version_after,created_at
            ) VALUES (?,?,?,?,?,?)`)
            .bind(input.id,input.to,input.note,input.actor,input.version + 1,input.now),
        ]);
        return Number(results[0]?.meta?.changes ?? 0) > 0;
      } catch {
        // Otra decisión ocupó esta versión: la suya es la vigente y esta no se anota.
        return false;
      }
    },
  };
}
export type D1OrderReturns = ReturnType<typeof createD1OrderReturns>;
