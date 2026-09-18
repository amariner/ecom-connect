import type { AutomaticDiscount } from '../domain/automatic-discount';

type AutomaticDiscountRow = Readonly<{
  id: string;
  version: number;
  label: string;
  public_reason: string;
  state: AutomaticDiscount['state'];
  priority: number;
  currency: string;
  effect_type: 'percentage_off' | 'amount_off';
  basis_points: number | null;
  amount_cents: number | null;
  active_from: string | null;
  active_until: string | null;
  markets_json: string;
  channels_json: string;
  minimum_subtotal_cents: number;
}>;

export type AutomaticDiscountApplication = Readonly<{
  discountId: string;
  discountVersion: number;
  discountCents: number;
  snapshot: Readonly<Record<string, unknown>>;
}>;

function parseTokens(value: string, label: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} persistido inválido.`);
  }
  return Object.freeze(parsed as string[]);
}

function toDiscount(row: AutomaticDiscountRow, productIds: readonly number[]): AutomaticDiscount {
  const effect = row.effect_type === 'percentage_off'
    ? { type: 'percentage_off' as const, basisPoints: row.basis_points! }
    : { type: 'amount_off' as const, amountCents: row.amount_cents! };
  return Object.freeze({
    id: row.id,
    version: row.version,
    label: row.label,
    publicReason: row.public_reason,
    state: row.state,
    priority: row.priority,
    currency: row.currency,
    effect: Object.freeze(effect),
    activeFrom: row.active_from,
    activeUntil: row.active_until,
    markets: parseTokens(row.markets_json, 'markets_json'),
    channels: parseTokens(row.channels_json, 'channels_json'),
    minimumSubtotalCents: row.minimum_subtotal_cents,
    productIds: Object.freeze([...productIds]),
  });
}

export function createD1AutomaticDiscounts(db: D1Database) {
  return Object.freeze({
    async listActive(): Promise<readonly AutomaticDiscount[]> {
      const { results: rows } = await db.prepare(`
        SELECT id, version, label, public_reason, state, priority, currency,
          effect_type, basis_points, amount_cents, active_from, active_until,
          markets_json, channels_json, minimum_subtotal_cents
        FROM automatic_discounts WHERE state='active' ORDER BY priority, id
      `).all<AutomaticDiscountRow>();
      if (rows.length === 0) return [];
      const { results: scopes } = await db.prepare(`
        SELECT discount_id, product_id FROM automatic_discount_products
        ORDER BY discount_id, product_id
      `).all<{ discount_id: string; product_id: number }>();
      return Object.freeze(rows.map((row) => toDiscount(
        row,
        scopes.filter((scope) => scope.discount_id === row.id).map((scope) => scope.product_id),
      )));
    },

    applicationStatement(
      orderNumber: string,
      application: AutomaticDiscountApplication,
      appliedAt: string,
    ): D1PreparedStatement {
      return db.prepare(`
        INSERT INTO automatic_discount_applications (
          id, discount_id, discount_version, order_id, discount_cents,
          snapshot_json, idempotency_key, applied_at
        )
        SELECT ?, ?, ?, o.id, ?, ?, ?, ?
        FROM orders o WHERE o.order_number=?
      `).bind(
        `auto_app_${crypto.randomUUID()}`,
        application.discountId,
        application.discountVersion,
        application.discountCents,
        JSON.stringify(application.snapshot),
        `automatic:order:${orderNumber}`,
        appliedAt,
        orderNumber,
      );
    },
  });
}
