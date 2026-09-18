import { promotionCodeHash } from '../application/promotion-security';
import type { PromotionCode } from '../domain/promotion-code';

type PromotionRow = Readonly<{
  id: string;
  version: number;
  label: string;
  state: PromotionCode['state'];
  priority: number;
  currency: string;
  effect_type: 'percentage_off' | 'amount_off';
  basis_points: number | null;
  amount_cents: number | null;
  active_from: string | null;
  active_until: string | null;
  markets_json: string;
  channels_json: string;
  global_usage_limit: number | null;
  per_customer_usage_limit: number | null;
  minimum_subtotal_cents: number;
  global_usage_count: number;
  customer_usage_count: number;
}>;

export type PromotionLookup = Readonly<{
  promotion: PromotionCode;
  globalUsageCount: number;
  customerUsageCount: number | null;
}>;

export type PromotionReservation = Readonly<{
  promotionId: string;
  promotionVersion: number;
  customerKeyHash: string;
  discountCents: number;
  snapshot: Readonly<Record<string, unknown>>;
}>;

function parseTokens(value: string, label: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 ||
      parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} persistido inválido.`);
  }
  return Object.freeze(parsed as string[]);
}

function toPromotion(row: PromotionRow, productIds: readonly number[]): PromotionCode {
  const effect = row.effect_type === 'percentage_off'
    ? { type: 'percentage_off' as const, basisPoints: row.basis_points! }
    : { type: 'amount_off' as const, amountCents: row.amount_cents! };
  return Object.freeze({
    id: row.id,
    version: row.version,
    label: row.label,
    state: row.state,
    priority: row.priority,
    currency: row.currency,
    effect: Object.freeze(effect),
    activeFrom: row.active_from,
    activeUntil: row.active_until,
    markets: parseTokens(row.markets_json, 'markets_json'),
    channels: parseTokens(row.channels_json, 'channels_json'),
    globalUsageLimit: row.global_usage_limit,
    perCustomerUsageLimit: row.per_customer_usage_limit,
    minimumSubtotalCents: row.minimum_subtotal_cents,
    productIds: Object.freeze([...productIds]),
  });
}

export function createD1PromotionCodes(db: D1Database) {
  return Object.freeze({
    async lookup(code: string, customerKeyHash: string | null): Promise<PromotionLookup | null> {
      const hash = await promotionCodeHash(code);
      const row = await db.prepare(`
        SELECT pc.*,
          (SELECT count(*) FROM promotion_code_usages u
           WHERE u.promotion_id=pc.id AND u.status IN ('reserved','consumed')) AS global_usage_count,
          (SELECT count(*) FROM promotion_code_usages u
           WHERE u.promotion_id=pc.id AND u.status IN ('reserved','consumed')
             AND u.customer_key_hash=?) AS customer_usage_count
        FROM promotion_codes pc WHERE pc.code_hash=?
      `).bind(customerKeyHash ?? '', hash).first<PromotionRow>();
      if (!row) return null;
      const { results } = await db.prepare(`
        SELECT product_id FROM promotion_code_products
        WHERE promotion_id=? ORDER BY product_id
      `).bind(row.id).all<{ product_id: number }>();
      return Object.freeze({
        promotion: toPromotion(row, results.map((item) => item.product_id)),
        globalUsageCount: row.global_usage_count,
        customerUsageCount: customerKeyHash === null ? null : row.customer_usage_count,
      });
    },

    reservationStatement(
      orderNumber: string,
      reservation: PromotionReservation,
      reservedAt: string,
    ): D1PreparedStatement {
      const id = `promo_use_${crypto.randomUUID()}`;
      return db.prepare(`
        INSERT INTO promotion_code_usages (
          id, promotion_id, promotion_version, order_id, customer_key_hash,
          status, discount_cents, snapshot_json, idempotency_key,
          reserved_at, updated_at
        )
        SELECT ?, ?, ?, o.id, ?, 'reserved', ?, ?, ?, ?, ?
        FROM orders o WHERE o.order_number=?
      `).bind(
        id,
        reservation.promotionId,
        reservation.promotionVersion,
        reservation.customerKeyHash,
        reservation.discountCents,
        JSON.stringify(reservation.snapshot),
        `promotion:order:${orderNumber}`,
        reservedAt,
        reservedAt,
        orderNumber,
      );
    },

    transitionStatement(
      orderId: number,
      to: 'consumed' | 'released',
      occurredAt: string,
      eventId: string,
    ): D1PreparedStatement {
      const timestampColumn = to === 'consumed' ? 'consumed_at' : 'released_at';
      return db.prepare(`
        UPDATE promotion_code_usages
        SET status=?, ${timestampColumn}=?, updated_at=?
        WHERE order_id=? AND status='reserved'
          AND EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id=?)
      `).bind(to, occurredAt, occurredAt, orderId, eventId);
    },
  });
}
