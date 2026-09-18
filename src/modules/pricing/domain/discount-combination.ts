import {
  evaluatePriceRules,
  type PriceBreakdown,
  type PriceRuleCandidate,
  type PriceRuleContext,
  type PriceRuleEvaluation,
} from './price-rule';

export const DISCOUNT_SOURCES = ['promotion_code', 'automatic_discount', 'quantity_offer'] as const;
export type DiscountSource = (typeof DISCOUNT_SOURCES)[number];
export const DISCOUNT_CLASSES = ['product', 'order', 'shipping'] as const;
export type DiscountClass = (typeof DISCOUNT_CLASSES)[number];
export const DISCOUNT_COMBINATION_POLICY_STATES = ['active', 'disabled', 'archived'] as const;
export type DiscountCombinationPolicyState = (typeof DISCOUNT_COMBINATION_POLICY_STATES)[number];

export type DiscountCombinationPolicy = Readonly<{
  id: string;
  version: number;
  label: string;
  state: DiscountCombinationPolicyState;
  priority: number;
  currency: string;
  activeFrom: string | null;
  activeUntil: string | null;
  markets: readonly string[];
  channels: readonly string[];
  maximumDiscountBasisPoints: number;
  sourcePairs: readonly Readonly<{ left: DiscountSource; right: DiscountSource }>[];
  classPairs: readonly Readonly<{ left: DiscountClass; right: DiscountClass }>[];
}>;

export type DiscountCombinationCandidate = Readonly<{
  source: DiscountSource;
  discountClass: DiscountClass;
  candidate: PriceRuleCandidate;
  eligibleProductIds: readonly number[];
}>;

export type DiscountCombinationExclusionReason =
  | 'source_pair_denied'
  | 'class_pair_denied'
  | 'superseded_priority';

export type DiscountCombinationResolution = Readonly<{
  policy: DiscountCombinationPolicy;
  selected: readonly DiscountCombinationCandidate[];
  excluded: readonly Readonly<{
    source: DiscountSource;
    ruleId: string;
    reason: DiscountCombinationExclusionReason;
  }>[];
}>;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function assertInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label} inválido.`);
}

function assertInstant(value: string, label: string): void {
  if (!ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) throw new RangeError(`${label} inválido.`);
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function assertTokens(values: readonly string[], label: string): void {
  if (values.length === 0) throw new RangeError(`${label} no puede estar vacío.`);
  const seen = new Set<string>();
  for (const value of values) {
    if (value !== value.trim() || value.length < 1 || value.length > 40 || seen.has(value)) {
      throw new RangeError(`${label} inválido.`);
    }
    seen.add(value);
  }
}

export function assertDiscountCombinationPolicy(policy: DiscountCombinationPolicy): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/.test(policy.id)) {
    throw new RangeError('combinationPolicy.id inválido.');
  }
  if (policy.label.trim().length < 2 || policy.label.trim().length > 120) {
    throw new RangeError('combinationPolicy.label inválido.');
  }
  if (!DISCOUNT_COMBINATION_POLICY_STATES.includes(policy.state)) {
    throw new RangeError('combinationPolicy.state inválido.');
  }
  assertInteger(policy.version, 'combinationPolicy.version', 1, 1_000_000);
  assertInteger(policy.priority, 'combinationPolicy.priority', 0, 100_000);
  assertInteger(policy.maximumDiscountBasisPoints, 'combinationPolicy.maximumDiscountBasisPoints', 1, 10_000);
  if (!/^[A-Z]{3}$/.test(policy.currency)) throw new RangeError('combinationPolicy.currency inválido.');
  if (policy.activeFrom !== null) assertInstant(policy.activeFrom, 'combinationPolicy.activeFrom');
  if (policy.activeUntil !== null) assertInstant(policy.activeUntil, 'combinationPolicy.activeUntil');
  if (policy.activeFrom !== null && policy.activeUntil !== null &&
      Date.parse(policy.activeUntil) <= Date.parse(policy.activeFrom)) {
    throw new RangeError('La vigencia de combinationPolicy es inválida.');
  }
  assertTokens(policy.markets, 'combinationPolicy.markets');
  assertTokens(policy.channels, 'combinationPolicy.channels');
  const sources = new Set<string>();
  for (const pair of policy.sourcePairs) {
    if (!DISCOUNT_SOURCES.includes(pair.left) || !DISCOUNT_SOURCES.includes(pair.right) || pair.left === pair.right) {
      throw new RangeError('combinationPolicy.sourcePairs inválido.');
    }
    const key = pairKey(pair.left, pair.right);
    if (sources.has(key)) throw new RangeError('combinationPolicy.sourcePairs contiene duplicados.');
    sources.add(key);
  }
  const classes = new Set<string>();
  for (const pair of policy.classPairs) {
    if (!DISCOUNT_CLASSES.includes(pair.left) || !DISCOUNT_CLASSES.includes(pair.right)) {
      throw new RangeError('combinationPolicy.classPairs inválido.');
    }
    const key = pairKey(pair.left, pair.right);
    if (classes.has(key)) throw new RangeError('combinationPolicy.classPairs contiene duplicados.');
    classes.add(key);
  }
}

function contextIncludes(values: readonly string[], value: string): boolean {
  return values.includes('*') || values.includes(value);
}

function policyEligible(policy: DiscountCombinationPolicy, context: PriceRuleContext): boolean {
  return policy.state === 'active' && policy.currency === context.currency.toUpperCase() &&
    contextIncludes(policy.markets, context.market) && contextIncludes(policy.channels, context.channel) &&
    (policy.activeFrom === null || Date.parse(policy.activeFrom) <= Date.parse(context.at)) &&
    (policy.activeUntil === null || Date.parse(policy.activeUntil) > Date.parse(context.at));
}

export function resolveDiscountCombinationPolicy(input: Readonly<{
  policies: readonly DiscountCombinationPolicy[];
  context: PriceRuleContext;
}>): DiscountCombinationPolicy | null {
  assertInstant(input.context.at, 'context.at');
  for (const policy of input.policies) assertDiscountCombinationPolicy(policy);
  return [...input.policies].filter((policy) => policyEligible(policy, input.context))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0] ?? null;
}

/**
 * Selecciona fuentes globales. Un código solicitado y elegible siempre entra
 * primero; el resto compite por prioridad y solo se añade si ambas matrices lo
 * permiten contra todas las fuentes ya seleccionadas.
 */
export function resolveDiscountCombination(input: Readonly<{
  policy: DiscountCombinationPolicy;
  candidates: readonly DiscountCombinationCandidate[];
}>): DiscountCombinationResolution {
  assertDiscountCombinationPolicy(input.policy);
  const ids = new Set<string>();
  const sources = new Set<DiscountSource>();
  for (const item of input.candidates) {
    if (!DISCOUNT_SOURCES.includes(item.source) || !DISCOUNT_CLASSES.includes(item.discountClass)) {
      throw new RangeError('combinationCandidate inválido.');
    }
    if (ids.has(item.candidate.id) || sources.has(item.source)) {
      throw new RangeError('combinationCandidate duplicado.');
    }
    ids.add(item.candidate.id);
    sources.add(item.source);
    evaluatePriceRules({
      baseUnitPriceCents: 1000,
      quantity: 1,
      context: {
        at: item.candidate.activeFrom ?? '2000-01-01T00:00:00.000Z',
        currency: item.candidate.currency,
        market: item.candidate.markets[0] === '*' ? 'ES' : item.candidate.markets[0]!,
        channel: item.candidate.channels[0] === '*' ? 'storefront' : item.candidate.channels[0]!,
      },
      candidates: [item.candidate],
    });
  }
  const sourcePairs = new Set(input.policy.sourcePairs.map((pair) => pairKey(pair.left, pair.right)));
  const classPairs = new Set(input.policy.classPairs.map((pair) => pairKey(pair.left, pair.right)));
  const ordered = [...input.candidates].sort((left, right) => {
    if (left.source === 'promotion_code' && right.source !== 'promotion_code') return -1;
    if (right.source === 'promotion_code' && left.source !== 'promotion_code') return 1;
    return left.candidate.priority - right.candidate.priority || left.candidate.id.localeCompare(right.candidate.id);
  });
  const selected: DiscountCombinationCandidate[] = [];
  const excluded: DiscountCombinationResolution['excluded'][number][] = [];
  for (const candidate of ordered) {
    if (selected.length === 0) {
      selected.push(candidate);
      continue;
    }
    const sourceDenied = selected.some((current) =>
      !sourcePairs.has(pairKey(current.source, candidate.source)));
    if (sourceDenied) {
      excluded.push({ source: candidate.source, ruleId: candidate.candidate.id, reason: 'source_pair_denied' });
      continue;
    }
    const classDenied = selected.some((current) =>
      !classPairs.has(pairKey(current.discountClass, candidate.discountClass)));
    if (classDenied) {
      excluded.push({ source: candidate.source, ruleId: candidate.candidate.id, reason: 'class_pair_denied' });
      continue;
    }
    selected.push(candidate);
  }
  return Object.freeze({
    policy: input.policy,
    selected: Object.freeze(selected),
    excluded: Object.freeze(excluded.map((item) => Object.freeze(item))),
  });
}

/** Suma efectos sobre precio base y reserva el tope a reglas de mayor prioridad. */
export function evaluateCombinedPriceRules(input: Readonly<{
  baseUnitPriceCents: number;
  quantity: number;
  context: PriceRuleContext;
  candidates: readonly PriceRuleCandidate[];
  maximumDiscountBasisPoints: number;
}>): PriceBreakdown {
  assertInteger(input.maximumDiscountBasisPoints, 'maximumDiscountBasisPoints', 1, 10_000);
  if (input.candidates.length < 1) {
    const empty = evaluatePriceRules({
      baseUnitPriceCents: input.baseUnitPriceCents,
      quantity: input.quantity,
      context: input.context,
    });
    return Object.freeze({ ...empty, schema: 2, applied_rules: Object.freeze([]) });
  }
  const raw = input.candidates.map((candidate) => {
    const breakdown = evaluatePriceRules({
      baseUnitPriceCents: input.baseUnitPriceCents,
      quantity: input.quantity,
      context: input.context,
      candidates: [candidate],
    });
    return { candidate, discount: breakdown.applied_rule?.discount_per_unit_cents ?? 0 };
  }).sort((left, right) => left.candidate.priority - right.candidate.priority ||
    left.candidate.id.localeCompare(right.candidate.id));
  const capPerUnit = Math.floor(input.baseUnitPriceCents * input.maximumDiscountBasisPoints / 10_000);
  let allocated = 0;
  const rules = raw.map(({ candidate, discount }) => {
    const applied = Math.min(discount, Math.max(0, capPerUnit - allocated));
    allocated += applied;
    return Object.freeze({
      id: candidate.id, version: candidate.version, label: candidate.label.trim(),
      priority: candidate.priority, effect: Object.freeze({ ...candidate.effect }),
      raw_discount_per_unit_cents: discount,
      discount_per_unit_cents: applied,
      capped: applied < discount,
    });
  });
  const applied = rules.filter((rule) => rule.discount_per_unit_cents > 0);
  const evaluations: PriceRuleEvaluation[] = rules.map((rule) => Object.freeze({
    ruleId: rule.id,
    version: rule.version,
    priority: rule.priority,
    status: rule.capped ? 'capped' : 'applied',
  }));
  const baseSubtotal = input.baseUnitPriceCents * input.quantity;
  const discount = allocated * input.quantity;
  const first = applied[0] ?? null;
  return Object.freeze({
    schema: 2,
    context: Object.freeze({ ...input.context, currency: input.context.currency.toUpperCase() }),
    currency: input.context.currency.toUpperCase(),
    base_unit_price_cents: input.baseUnitPriceCents,
    unit_price_cents: input.baseUnitPriceCents - allocated,
    quantity: input.quantity,
    base_subtotal_cents: baseSubtotal,
    discount_cents: discount,
    subtotal_cents: baseSubtotal - discount,
    applied_rule: first === null ? null : Object.freeze({
      id: first.id, version: first.version, label: first.label, priority: first.priority,
      effect: first.effect, discount_per_unit_cents: first.discount_per_unit_cents,
    }),
    applied_rules: Object.freeze(rules),
    evaluations: Object.freeze(evaluations),
  });
}
