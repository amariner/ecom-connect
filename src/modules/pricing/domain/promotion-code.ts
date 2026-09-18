import { evaluatePriceRules, type PriceRuleCandidate, type PriceRuleContext } from './price-rule';

export const PROMOTION_CODE_STATES = ['active', 'disabled', 'archived'] as const;
export type PromotionCodeState = (typeof PROMOTION_CODE_STATES)[number];

export type PromotionCode = Readonly<{
  id: string;
  version: number;
  label: string;
  state: PromotionCodeState;
  priority: number;
  currency: string;
  effect: PriceRuleCandidate['effect'];
  activeFrom: string | null;
  activeUntil: string | null;
  markets: readonly string[];
  channels: readonly string[];
  globalUsageLimit: number | null;
  perCustomerUsageLimit: number | null;
  minimumSubtotalCents: number;
  productIds: readonly number[];
}>;

export type PromotionCodeExclusion =
  | 'excluded_inactive'
  | 'excluded_global_limit'
  | 'excluded_customer_limit'
  | 'excluded_minimum_subtotal'
  | 'excluded_product_scope'
  | 'excluded_context';

export type PromotionCodeResolution = Readonly<
  | { status: PromotionCodeExclusion; candidate: null; eligibleProductIds: readonly number[] }
  | { status: 'eligible'; candidate: PriceRuleCandidate; eligibleProductIds: readonly number[] }
>;

function candidateOf(promotion: PromotionCode): PriceRuleCandidate {
  return Object.freeze({
    id: `promotion:${promotion.id}`,
    version: promotion.version,
    label: promotion.label,
    priority: promotion.priority,
    activeFrom: promotion.activeFrom,
    activeUntil: promotion.activeUntil,
    markets: Object.freeze([...promotion.markets]),
    channels: Object.freeze([...promotion.channels]),
    currency: promotion.currency,
    effect: Object.freeze({ ...promotion.effect }),
  });
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} inválido.`);
}

export function assertPromotionCode(promotion: PromotionCode): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/.test(promotion.id)) {
    throw new RangeError('promotion.id inválido.');
  }
  if (!PROMOTION_CODE_STATES.includes(promotion.state)) throw new RangeError('promotion.state inválido.');
  if (promotion.markets.length === 0 || promotion.channels.length === 0) {
    throw new RangeError('promotion debe declarar mercado y canal.');
  }
  assertCount(promotion.minimumSubtotalCents, 'promotion.minimumSubtotalCents');
  if (promotion.minimumSubtotalCents > 1_000_000_000) throw new RangeError('promotion.minimumSubtotalCents inválido.');
  for (const [label, limit] of [
    ['promotion.globalUsageLimit', promotion.globalUsageLimit],
    ['promotion.perCustomerUsageLimit', promotion.perCustomerUsageLimit],
  ] as const) {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000_000)) {
      throw new RangeError(`${label} inválido.`);
    }
  }
  const products = new Set<number>();
  for (const productId of promotion.productIds) {
    if (!Number.isSafeInteger(productId) || productId < 1 || products.has(productId)) {
      throw new RangeError('promotion.productIds inválido.');
    }
    products.add(productId);
  }
  evaluatePriceRules({
    baseUnitPriceCents: 1000,
    quantity: 1,
    context: {
      at: '2000-01-01T00:00:00.000Z',
      currency: promotion.currency,
      market: promotion.markets[0] === '*' ? 'ES' : promotion.markets[0]!,
      channel: promotion.channels[0] === '*' ? 'storefront' : promotion.channels[0]!,
    },
    candidates: [candidateOf(promotion)],
  });
}

/**
 * Resuelve únicamente los scopes propios del código. Moneda, mercado, canal y
 * vigencia los explica después el motor R4.1 con el mismo contrato que el resto
 * de fuentes de precio.
 */
export function resolvePromotionCode(input: Readonly<{
  promotion: PromotionCode;
  context: PriceRuleContext;
  baseSubtotalCents: number;
  cartProductIds: readonly number[];
  globalUsageCount: number;
  customerUsageCount: number | null;
}>): PromotionCodeResolution {
  assertCount(input.baseSubtotalCents, 'baseSubtotalCents');
  assertCount(input.globalUsageCount, 'globalUsageCount');
  if (input.customerUsageCount !== null) assertCount(input.customerUsageCount, 'customerUsageCount');
  const promotion = input.promotion;
  assertPromotionCode(promotion);
  if (promotion.state !== 'active') {
    return Object.freeze({ status: 'excluded_inactive', candidate: null, eligibleProductIds: Object.freeze([]) });
  }
  const candidate = candidateOf(promotion);
  if (evaluatePriceRules({
    baseUnitPriceCents: 1000,
    quantity: 1,
    context: input.context,
    candidates: [candidate],
  }).applied_rule === null) {
    return Object.freeze({ status: 'excluded_context', candidate: null, eligibleProductIds: Object.freeze([]) });
  }
  if (promotion.globalUsageLimit !== null && input.globalUsageCount >= promotion.globalUsageLimit) {
    return Object.freeze({ status: 'excluded_global_limit', candidate: null, eligibleProductIds: Object.freeze([]) });
  }
  if (promotion.perCustomerUsageLimit !== null && input.customerUsageCount !== null &&
      input.customerUsageCount >= promotion.perCustomerUsageLimit) {
    return Object.freeze({ status: 'excluded_customer_limit', candidate: null, eligibleProductIds: Object.freeze([]) });
  }
  if (input.baseSubtotalCents < promotion.minimumSubtotalCents) {
    return Object.freeze({ status: 'excluded_minimum_subtotal', candidate: null, eligibleProductIds: Object.freeze([]) });
  }
  const scope = new Set(promotion.productIds);
  const eligibleProductIds = [...new Set(input.cartProductIds)]
    .filter((id) => scope.size === 0 || scope.has(id))
    .sort((left, right) => left - right);
  if (eligibleProductIds.length === 0) {
    return Object.freeze({ status: 'excluded_product_scope', candidate: null, eligibleProductIds: Object.freeze([]) });
  }
  return Object.freeze({
    status: 'eligible',
    candidate,
    eligibleProductIds: Object.freeze(eligibleProductIds),
  });
}
