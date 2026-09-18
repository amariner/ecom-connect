import {
  evaluatePriceRules,
  type PriceRuleCandidate,
  type PriceRuleContext,
  type PriceRuleEvaluation,
} from './price-rule';

export const QUANTITY_OFFER_STATES = ['active', 'disabled', 'archived'] as const;
export type QuantityOfferState = (typeof QUANTITY_OFFER_STATES)[number];
export type QuantityOfferKind = 'quantity_tier' | 'buy_x_get_y';
export type QuantityTierBasis = 'quantity' | 'subtotal';

export type QuantityOfferTier = Readonly<{
  threshold: number;
  effect: PriceRuleCandidate['effect'];
}>;

type QuantityOfferCommon = Readonly<{
  id: string;
  version: number;
  label: string;
  publicReason: string;
  state: QuantityOfferState;
  priority: number;
  currency: string;
  activeFrom: string | null;
  activeUntil: string | null;
  markets: readonly string[];
  channels: readonly string[];
}>;

export type QuantityOffer = QuantityOfferCommon & Readonly<
  | {
    kind: 'quantity_tier';
    tierBasis: QuantityTierBasis;
    tiers: readonly QuantityOfferTier[];
    productIds: readonly number[];
  }
  | {
    kind: 'buy_x_get_y';
    buyQuantity: number;
    rewardQuantity: number;
    rewardEffect: PriceRuleCandidate['effect'];
    maxApplications: number | null;
    buyProductIds: readonly number[];
    rewardProductIds: readonly number[];
  }
>;

export type QuantityOfferCartLine = Readonly<{
  productId: number;
  unitPriceCents: number;
  quantity: number;
}>;

export type QuantityOfferEvidence = Readonly<
  | {
    kind: 'quantity_tier';
    tier_basis: QuantityTierBasis;
    measured_value: number;
    threshold: number;
  }
  | {
    kind: 'buy_x_get_y';
    applications: number;
    selected_reward_units: readonly Readonly<{ product_id: number; quantity: number }>[];
    theoretical_discount_cents: number;
    proportional_basis_points: number;
  }
>;

export type QuantityOfferResolution = Readonly<
  | { status: 'not_eligible'; reason: 'no_eligible_offer'; evaluations: readonly PriceRuleEvaluation[] }
  | {
    status: 'eligible';
    offer: QuantityOffer;
    candidate: PriceRuleCandidate;
    eligibleProductIds: readonly number[];
    evidence: QuantityOfferEvidence;
    evaluations: readonly PriceRuleEvaluation[];
  }
>;

type EligibleOffer = Readonly<{
  offer: QuantityOffer;
  candidate: PriceRuleCandidate;
  productIds: readonly number[];
  evidence: QuantityOfferEvidence;
}>;

function assertInteger(value: number, label: string, min: number, max = 1_000_000_000): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} inválido.`);
  }
}

function assertProductIds(values: readonly number[], label: string, allowEmpty: boolean): void {
  if (!allowEmpty && values.length === 0) throw new RangeError(`${label} no puede estar vacío.`);
  const seen = new Set<number>();
  for (const value of values) {
    assertInteger(value, label, 1);
    if (seen.has(value)) throw new RangeError(`${label} contiene duplicados.`);
    seen.add(value);
  }
}

function candidateOf(offer: QuantityOffer, effect: PriceRuleCandidate['effect']): PriceRuleCandidate {
  return Object.freeze({
    id: `quantity:${offer.id}`,
    version: offer.version,
    label: offer.publicReason,
    priority: offer.priority,
    activeFrom: offer.activeFrom,
    activeUntil: offer.activeUntil,
    markets: Object.freeze([...offer.markets]),
    channels: Object.freeze([...offer.channels]),
    currency: offer.currency,
    effect: Object.freeze({ ...effect }),
  });
}

function assertEffect(effect: PriceRuleCandidate['effect'], offer: QuantityOffer): void {
  evaluatePriceRules({
    baseUnitPriceCents: 1000,
    quantity: 1,
    context: {
      at: '2000-01-01T00:00:00.000Z',
      currency: offer.currency,
      market: offer.markets[0] === '*' ? 'ES' : offer.markets[0]!,
      channel: offer.channels[0] === '*' ? 'storefront' : offer.channels[0]!,
    },
    candidates: [candidateOf(offer, effect)],
  });
}

export function assertQuantityOffer(offer: QuantityOffer): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/.test(offer.id)) {
    throw new RangeError('quantityOffer.id inválido.');
  }
  if (!QUANTITY_OFFER_STATES.includes(offer.state)) throw new RangeError('quantityOffer.state inválido.');
  if (offer.label.trim().length < 2 || offer.label.trim().length > 120) {
    throw new RangeError('quantityOffer.label inválido.');
  }
  if (offer.publicReason.trim().length < 2 || offer.publicReason.trim().length > 160) {
    throw new RangeError('quantityOffer.publicReason inválido.');
  }
  if (offer.markets.length === 0 || offer.channels.length === 0) {
    throw new RangeError('quantityOffer debe declarar mercado y canal.');
  }
  assertInteger(offer.version, 'quantityOffer.version', 1, 1_000_000);
  assertInteger(offer.priority, 'quantityOffer.priority', 0, 100_000);
  if (offer.kind === 'quantity_tier') {
    assertProductIds(offer.productIds, 'quantityOffer.productIds', true);
    if (offer.tiers.length === 0 || offer.tiers.length > 50) {
      throw new RangeError('quantityOffer.tiers debe contener entre 1 y 50 tramos.');
    }
    const thresholds = new Set<number>();
    for (const tier of offer.tiers) {
      assertInteger(tier.threshold, 'quantityOffer.tier.threshold', 1);
      if (thresholds.has(tier.threshold)) throw new RangeError('quantityOffer.tiers contiene umbrales duplicados.');
      thresholds.add(tier.threshold);
      assertEffect(tier.effect, offer);
    }
    return;
  }
  assertInteger(offer.buyQuantity, 'quantityOffer.buyQuantity', 1, 99);
  assertInteger(offer.rewardQuantity, 'quantityOffer.rewardQuantity', 1, 99);
  if (offer.maxApplications !== null) {
    assertInteger(offer.maxApplications, 'quantityOffer.maxApplications', 1, 99);
  }
  assertProductIds(offer.buyProductIds, 'quantityOffer.buyProductIds', false);
  assertProductIds(offer.rewardProductIds, 'quantityOffer.rewardProductIds', false);
  const overlap = offer.buyProductIds.filter((id) => offer.rewardProductIds.includes(id));
  const sameScope = offer.buyProductIds.length === offer.rewardProductIds.length &&
    overlap.length === offer.buyProductIds.length;
  if (overlap.length > 0 && !sameScope) {
    throw new RangeError('Los scopes X/Y deben ser disjuntos o idénticos.');
  }
  assertEffect(offer.rewardEffect, offer);
}

function rewardDiscount(unitPriceCents: number, effect: PriceRuleCandidate['effect']): number {
  return effect.type === 'amount_off'
    ? Math.min(unitPriceCents, effect.amountCents)
    : Math.min(unitPriceCents, Math.floor(unitPriceCents * effect.basisPoints / 10_000));
}

function proportionalDiscount(
  lines: readonly QuantityOfferCartLine[],
  productIds: ReadonlySet<number>,
  basisPoints: number,
): number {
  return lines.filter((line) => productIds.has(line.productId)).reduce((sum, line) =>
    sum + Math.floor(line.unitPriceCents * basisPoints / 10_000) * line.quantity, 0);
}

/** Menor porcentaje entero cuyo redondeo por línea cumple el premio; el residuo favorece al comprador. */
function minimumFulfillingBasisPoints(
  lines: readonly QuantityOfferCartLine[],
  productIds: ReadonlySet<number>,
  targetDiscountCents: number,
): number {
  let lower = 1;
  let upper = 10_000;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (proportionalDiscount(lines, productIds, middle) >= targetDiscountCents) upper = middle;
    else lower = middle + 1;
  }
  return lower;
}

function tierEligibility(
  offer: Extract<QuantityOffer, { kind: 'quantity_tier' }>,
  lines: readonly QuantityOfferCartLine[],
): EligibleOffer | null {
  const scope = new Set(offer.productIds);
  const scoped = lines.filter((line) => scope.size === 0 || scope.has(line.productId));
  if (scoped.length === 0) return null;
  const measured = offer.tierBasis === 'quantity'
    ? scoped.reduce((sum, line) => sum + line.quantity, 0)
    : scoped.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
  const tier = [...offer.tiers]
    .filter((candidate) => candidate.threshold <= measured)
    .sort((left, right) => right.threshold - left.threshold)[0];
  if (!tier) return null;
  return Object.freeze({
    offer,
    candidate: candidateOf(offer, tier.effect),
    productIds: Object.freeze([...new Set(scoped.map((line) => line.productId))].sort((a, b) => a - b)),
    evidence: Object.freeze({
      kind: 'quantity_tier',
      tier_basis: offer.tierBasis,
      measured_value: measured,
      threshold: tier.threshold,
    }),
  });
}

function buyXGetYEligibility(
  offer: Extract<QuantityOffer, { kind: 'buy_x_get_y' }>,
  lines: readonly QuantityOfferCartLine[],
): EligibleOffer | null {
  const buyScope = new Set(offer.buyProductIds);
  const rewardScope = new Set(offer.rewardProductIds);
  const sameScope = offer.buyProductIds.length === offer.rewardProductIds.length &&
    offer.buyProductIds.every((id) => rewardScope.has(id));
  const buyUnits = lines.filter((line) => buyScope.has(line.productId))
    .reduce((sum, line) => sum + line.quantity, 0);
  const rewardUnits = lines.filter((line) => rewardScope.has(line.productId))
    .reduce((sum, line) => sum + line.quantity, 0);
  let applications = sameScope
    ? Math.floor(buyUnits / (offer.buyQuantity + offer.rewardQuantity))
    : Math.min(
      Math.floor(buyUnits / offer.buyQuantity),
      Math.floor(rewardUnits / offer.rewardQuantity),
    );
  if (offer.maxApplications !== null) applications = Math.min(applications, offer.maxApplications);
  if (applications < 1) return null;

  let pendingRewards = applications * offer.rewardQuantity;
  const selected: Array<{ product_id: number; quantity: number }> = [];
  let theoreticalDiscount = 0;
  const orderedRewards = lines.filter((line) => rewardScope.has(line.productId))
    .sort((left, right) => left.unitPriceCents - right.unitPriceCents || left.productId - right.productId);
  for (const line of orderedRewards) {
    const quantity = Math.min(line.quantity, pendingRewards);
    if (quantity === 0) continue;
    selected.push({ product_id: line.productId, quantity });
    theoreticalDiscount += rewardDiscount(line.unitPriceCents, offer.rewardEffect) * quantity;
    pendingRewards -= quantity;
    if (pendingRewards === 0) break;
  }
  if (pendingRewards !== 0 || theoreticalDiscount < 1) return null;
  const participantScope = new Set([...offer.buyProductIds, ...offer.rewardProductIds]);
  const participantSubtotal = lines.filter((line) => participantScope.has(line.productId))
    .reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
  if (participantSubtotal < 1 || theoreticalDiscount > participantSubtotal) return null;
  const basisPoints = minimumFulfillingBasisPoints(lines, participantScope, theoreticalDiscount);
  if (basisPoints < 1) return null;
  return Object.freeze({
    offer,
    candidate: candidateOf(offer, { type: 'percentage_off', basisPoints }),
    productIds: Object.freeze([...participantScope].sort((a, b) => a - b)),
    evidence: Object.freeze({
      kind: 'buy_x_get_y',
      applications,
      selected_reward_units: Object.freeze(selected.map((item) => Object.freeze(item))),
      theoretical_discount_cents: theoreticalDiscount,
      proportional_basis_points: basisPoints,
    }),
  });
}

/**
 * Resuelve una sola oferta global. En X/Y, el beneficio de las unidades premio
 * se prorratea sobre las líneas participantes para que ediciones y devoluciones
 * sigan usando un precio unitario entero, congelado y verificable.
 */
export function resolveQuantityOffers(input: Readonly<{
  offers: readonly QuantityOffer[];
  context: PriceRuleContext;
  lines: readonly QuantityOfferCartLine[];
}>): QuantityOfferResolution {
  const seenProducts = new Set<number>();
  for (const line of input.lines) {
    assertInteger(line.productId, 'line.productId', 1);
    assertInteger(line.unitPriceCents, 'line.unitPriceCents', 0, 10_000_000);
    assertInteger(line.quantity, 'line.quantity', 1, 99);
    if (seenProducts.has(line.productId)) throw new RangeError('line.productId no puede repetirse.');
    seenProducts.add(line.productId);
  }
  const eligible = new Map<string, EligibleOffer>();
  for (const offer of input.offers) {
    assertQuantityOffer(offer);
    if (offer.state !== 'active') continue;
    const resolved = offer.kind === 'quantity_tier'
      ? tierEligibility(offer, input.lines)
      : buyXGetYEligibility(offer, input.lines);
    if (resolved) eligible.set(resolved.candidate.id, resolved);
  }
  const selection = evaluatePriceRules({
    baseUnitPriceCents: 1000,
    quantity: 1,
    context: input.context,
    candidates: [...eligible.values()].map((item) => item.candidate),
  });
  const winner = selection.applied_rule === null ? undefined : eligible.get(selection.applied_rule.id);
  if (!winner) {
    return Object.freeze({
      status: 'not_eligible',
      reason: 'no_eligible_offer',
      evaluations: selection.evaluations,
    });
  }
  return Object.freeze({
    status: 'eligible',
    offer: winner.offer,
    candidate: winner.candidate,
    eligibleProductIds: winner.productIds,
    evidence: winner.evidence,
    evaluations: selection.evaluations,
  });
}
