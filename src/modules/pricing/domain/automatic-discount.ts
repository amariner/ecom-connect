import { evaluatePriceRules, type PriceRuleCandidate, type PriceRuleContext, type PriceRuleEvaluation } from './price-rule';

export const AUTOMATIC_DISCOUNT_STATES = ['active', 'disabled', 'archived'] as const;
export type AutomaticDiscountState = (typeof AUTOMATIC_DISCOUNT_STATES)[number];

export type AutomaticDiscount = Readonly<{
  id: string;
  version: number;
  label: string;
  publicReason: string;
  state: AutomaticDiscountState;
  priority: number;
  currency: string;
  effect: PriceRuleCandidate['effect'];
  activeFrom: string | null;
  activeUntil: string | null;
  markets: readonly string[];
  channels: readonly string[];
  minimumSubtotalCents: number;
  productIds: readonly number[];
}>;

export type AutomaticDiscountResolution = Readonly<
  | { status: 'not_eligible'; reason: 'no_eligible_discount'; evaluations: readonly PriceRuleEvaluation[] }
  | {
    status: 'eligible';
    discount: AutomaticDiscount;
    candidate: PriceRuleCandidate;
    eligibleProductIds: readonly number[];
    evaluations: readonly PriceRuleEvaluation[];
  }
>;

export type PricingSource = 'promotion_code' | 'automatic_discount' | 'quantity_offer' | 'none';

function candidateOf(discount: AutomaticDiscount): PriceRuleCandidate {
  return Object.freeze({
    id: `automatic:${discount.id}`,
    version: discount.version,
    label: discount.publicReason,
    priority: discount.priority,
    activeFrom: discount.activeFrom,
    activeUntil: discount.activeUntil,
    markets: Object.freeze([...discount.markets]),
    channels: Object.freeze([...discount.channels]),
    currency: discount.currency,
    effect: Object.freeze({ ...discount.effect }),
  });
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new RangeError(`${label} inválido.`);
  }
}

export function assertAutomaticDiscount(discount: AutomaticDiscount): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/.test(discount.id)) {
    throw new RangeError('automaticDiscount.id inválido.');
  }
  if (!AUTOMATIC_DISCOUNT_STATES.includes(discount.state)) {
    throw new RangeError('automaticDiscount.state inválido.');
  }
  if (discount.label.trim().length < 2 || discount.label.trim().length > 120) {
    throw new RangeError('automaticDiscount.label inválido.');
  }
  if (discount.publicReason.trim().length < 2 || discount.publicReason.trim().length > 160) {
    throw new RangeError('automaticDiscount.publicReason inválido.');
  }
  if (discount.markets.length === 0 || discount.channels.length === 0) {
    throw new RangeError('automaticDiscount debe declarar mercado y canal.');
  }
  assertCount(discount.minimumSubtotalCents, 'automaticDiscount.minimumSubtotalCents');
  const products = new Set<number>();
  for (const productId of discount.productIds) {
    if (!Number.isSafeInteger(productId) || productId < 1 || products.has(productId)) {
      throw new RangeError('automaticDiscount.productIds inválido.');
    }
    products.add(productId);
  }
  evaluatePriceRules({
    baseUnitPriceCents: 1000,
    quantity: 1,
    context: {
      at: '2000-01-01T00:00:00.000Z',
      currency: discount.currency,
      market: discount.markets[0] === '*' ? 'ES' : discount.markets[0]!,
      channel: discount.channels[0] === '*' ? 'storefront' : discount.channels[0]!,
    },
    candidates: [candidateOf(discount)],
  });
}

/**
 * Elige una única campaña para todo el carrito. Sus productos fuera de scope
 * conservan precio base; otra campaña no rellena esos huecos hasta PRC-008.
 */
export function resolveAutomaticDiscounts(input: Readonly<{
  discounts: readonly AutomaticDiscount[];
  context: PriceRuleContext;
  baseSubtotalCents: number;
  cartProductIds: readonly number[];
}>): AutomaticDiscountResolution {
  assertCount(input.baseSubtotalCents, 'baseSubtotalCents');
  const cartProducts = new Set(input.cartProductIds);
  const eligibleByCandidate = new Map<string, Readonly<{
    discount: AutomaticDiscount;
    productIds: readonly number[];
  }>>();
  for (const discount of input.discounts) {
    assertAutomaticDiscount(discount);
    if (discount.state !== 'active' || input.baseSubtotalCents < discount.minimumSubtotalCents) continue;
    const scope = new Set(discount.productIds);
    const productIds = [...cartProducts]
      .filter((productId) => scope.size === 0 || scope.has(productId))
      .sort((left, right) => left - right);
    if (productIds.length === 0) continue;
    eligibleByCandidate.set(`automatic:${discount.id}`, Object.freeze({
      discount,
      productIds: Object.freeze(productIds),
    }));
  }
  const candidates = [...eligibleByCandidate.values()].map(({ discount }) => candidateOf(discount));
  const selection = evaluatePriceRules({
    baseUnitPriceCents: 1000,
    quantity: 1,
    context: input.context,
    candidates,
  });
  const winner = selection.applied_rule === null
    ? undefined
    : eligibleByCandidate.get(selection.applied_rule.id);
  if (winner === undefined) {
    return Object.freeze({
      status: 'not_eligible',
      reason: 'no_eligible_discount',
      evaluations: selection.evaluations,
    });
  }
  return Object.freeze({
    status: 'eligible',
    discount: winner.discount,
    candidate: candidateOf(winner.discount),
    eligibleProductIds: winner.productIds,
    evaluations: selection.evaluations,
  });
}

/**
 * Matriz R4.4: un código elegible gana globalmente. Sin código, campañas
 * automáticas y ofertas por cantidad compiten por prioridad e id estable; no
 * se apilan fuentes antes de PRC-008.
 */
export function resolvePricingSourceConflict(input: Readonly<{
  promotionEligible: boolean;
  automaticEligible: boolean;
  quantityOfferEligible?: boolean;
  automaticCandidate?: PriceRuleCandidate;
  quantityOfferCandidate?: PriceRuleCandidate;
}>): PricingSource {
  if (input.promotionEligible) return 'promotion_code';
  if (input.automaticEligible && input.quantityOfferEligible === true &&
      input.automaticCandidate !== undefined && input.quantityOfferCandidate !== undefined) {
    const automatic = input.automaticCandidate;
    const quantity = input.quantityOfferCandidate;
    return automatic.priority < quantity.priority ||
      (automatic.priority === quantity.priority && automatic.id < quantity.id)
      ? 'automatic_discount'
      : 'quantity_offer';
  }
  if (input.automaticEligible) return 'automatic_discount';
  if (input.quantityOfferEligible === true) return 'quantity_offer';
  return 'none';
}
