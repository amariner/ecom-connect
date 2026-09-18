import type { QuantityOffer, QuantityOfferTier } from '../domain/quantity-offer';

type OfferRow = Readonly<{
  id: string;
  version: number;
  label: string;
  public_reason: string;
  state: QuantityOffer['state'];
  priority: number;
  currency: string;
  kind: QuantityOffer['kind'];
  tier_basis: 'quantity' | 'subtotal' | null;
  buy_quantity: number | null;
  reward_quantity: number | null;
  reward_effect_type: 'percentage_off' | 'amount_off' | null;
  reward_basis_points: number | null;
  reward_amount_cents: number | null;
  max_applications: number | null;
  active_from: string | null;
  active_until: string | null;
  markets_json: string;
  channels_json: string;
}>;

type TierRow = Readonly<{
  offer_id: string;
  threshold: number;
  effect_type: 'percentage_off' | 'amount_off';
  basis_points: number | null;
  amount_cents: number | null;
}>;

type ScopeRow = Readonly<{
  offer_id: string;
  role: 'eligible' | 'buy' | 'reward';
  product_id: number;
}>;

export type QuantityOfferApplication = Readonly<{
  offerId: string;
  offerVersion: number;
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

function effectOf(row: Readonly<{
  effect_type: 'percentage_off' | 'amount_off';
  basis_points: number | null;
  amount_cents: number | null;
}>): QuantityOfferTier['effect'] {
  return Object.freeze(row.effect_type === 'percentage_off'
    ? { type: 'percentage_off' as const, basisPoints: row.basis_points! }
    : { type: 'amount_off' as const, amountCents: row.amount_cents! });
}

function toOffer(row: OfferRow, tiers: readonly TierRow[], scopes: readonly ScopeRow[]): QuantityOffer {
  const common = {
    id: row.id,
    version: row.version,
    label: row.label,
    publicReason: row.public_reason,
    state: row.state,
    priority: row.priority,
    currency: row.currency,
    activeFrom: row.active_from,
    activeUntil: row.active_until,
    markets: parseTokens(row.markets_json, 'markets_json'),
    channels: parseTokens(row.channels_json, 'channels_json'),
  } as const;
  if (row.kind === 'quantity_tier') {
    return Object.freeze({
      ...common,
      kind: 'quantity_tier',
      tierBasis: row.tier_basis!,
      tiers: Object.freeze(tiers.map((tier) => Object.freeze({
        threshold: tier.threshold,
        effect: effectOf(tier),
      }))),
      productIds: Object.freeze(scopes.filter((scope) => scope.role === 'eligible')
        .map((scope) => scope.product_id)),
    });
  }
  return Object.freeze({
    ...common,
    kind: 'buy_x_get_y',
    buyQuantity: row.buy_quantity!,
    rewardQuantity: row.reward_quantity!,
    rewardEffect: effectOf({
      effect_type: row.reward_effect_type!,
      basis_points: row.reward_basis_points,
      amount_cents: row.reward_amount_cents,
    }),
    maxApplications: row.max_applications,
    buyProductIds: Object.freeze(scopes.filter((scope) => scope.role === 'buy')
      .map((scope) => scope.product_id)),
    rewardProductIds: Object.freeze(scopes.filter((scope) => scope.role === 'reward')
      .map((scope) => scope.product_id)),
  });
}

export function createD1QuantityOffers(db: D1Database) {
  return Object.freeze({
    async listActive(): Promise<readonly QuantityOffer[]> {
      const { results: rows } = await db.prepare(`
        SELECT id, version, label, public_reason, state, priority, currency,
          kind, tier_basis, buy_quantity, reward_quantity, reward_effect_type,
          reward_basis_points, reward_amount_cents, max_applications,
          active_from, active_until, markets_json, channels_json
        FROM quantity_offers WHERE state='active' ORDER BY priority, id
      `).all<OfferRow>();
      if (rows.length === 0) return [];
      const [tierResult, scopeResult] = await Promise.all([
        db.prepare(`SELECT offer_id, threshold, effect_type, basis_points, amount_cents
          FROM quantity_offer_tiers ORDER BY offer_id, threshold`).all<TierRow>(),
        db.prepare(`SELECT offer_id, role, product_id FROM quantity_offer_products
          ORDER BY offer_id, role, product_id`).all<ScopeRow>(),
      ]);
      return Object.freeze(rows.map((row) => toOffer(
        row,
        tierResult.results.filter((tier) => tier.offer_id === row.id),
        scopeResult.results.filter((scope) => scope.offer_id === row.id),
      )));
    },

    applicationStatement(
      orderNumber: string,
      application: QuantityOfferApplication,
      appliedAt: string,
    ): D1PreparedStatement {
      return db.prepare(`
        INSERT INTO quantity_offer_applications (
          id, offer_id, offer_version, order_id, discount_cents,
          snapshot_json, idempotency_key, applied_at
        )
        SELECT ?, ?, ?, o.id, ?, ?, ?, ?
        FROM orders o WHERE o.order_number=?
      `).bind(
        `quantity_app_${crypto.randomUUID()}`,
        application.offerId,
        application.offerVersion,
        application.discountCents,
        JSON.stringify(application.snapshot),
        `quantity:order:${orderNumber}`,
        appliedAt,
        orderNumber,
      );
    },
  });
}
