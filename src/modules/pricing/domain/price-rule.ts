export const PRICE_RULE_EFFECTS = ['percentage_off', 'amount_off'] as const;
export type PriceRuleEffectType = (typeof PRICE_RULE_EFFECTS)[number];

export type PriceRuleContext = Readonly<{
  at: string;
  currency: string;
  market: string;
  channel: string;
}>;

export type PriceOrigin =
  | Readonly<{
    type: 'catalog'; catalog_unit_price_cents: number; unit_price_cents: number;
    fallback_depth: number;
  }>
  | Readonly<{
    type: 'price_list'; price_list_id: string; version: number; label: string;
    priority: number; catalog_unit_price_cents: number; unit_price_cents: number;
    company_scoped: boolean; fallback_depth: number;
  }>;

export type PriceRuleCandidate = Readonly<{
  id: string;
  version: number;
  label: string;
  priority: number;
  activeFrom: string | null;
  activeUntil: string | null;
  markets: readonly string[];
  channels: readonly string[];
  currency: string;
  effect:
    | Readonly<{ type: 'percentage_off'; basisPoints: number }>
    | Readonly<{ type: 'amount_off'; amountCents: number }>;
}>;

export type PriceRuleEvaluationStatus =
  | 'applied'
  | 'excluded_currency'
  | 'excluded_market'
  | 'excluded_channel'
  | 'excluded_not_started'
  | 'excluded_expired'
  | 'superseded_priority'
  | 'capped';

export type PriceRuleEvaluation = Readonly<{
  ruleId: string;
  version: number;
  priority: number;
  status: PriceRuleEvaluationStatus;
}>;

export type PriceBreakdown = Readonly<{
  schema: 1 | 2;
  context: PriceRuleContext;
  currency: string;
  base_unit_price_cents: number;
  unit_price_cents: number;
  quantity: number;
  base_subtotal_cents: number;
  discount_cents: number;
  subtotal_cents: number;
  applied_rule: null | Readonly<{
    id: string;
    version: number;
    label: string;
    priority: number;
    effect: PriceRuleCandidate['effect'];
    discount_per_unit_cents: number;
  }>;
  /** R4.6: origen contextual del precio base antes de promociones. */
  price_origin?: PriceOrigin;
  /** R4.7: composición inventariable congelada de la línea comercial. */
  bundle?: import('./bundle').BundleResolution['snapshot'];
  /** Presente en schema 2; conserva `applied_rule` como primer efecto compatible. */
  applied_rules?: readonly Readonly<{
    id: string;
    version: number;
    label: string;
    priority: number;
    effect: PriceRuleCandidate['effect'];
    raw_discount_per_unit_cents: number;
    discount_per_unit_cents: number;
    capped: boolean;
  }>[];
  evaluations: readonly PriceRuleEvaluation[];
}>;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function assertInteger(value: number, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} debe ser un entero entre ${min} y ${max}.`);
  }
}

function assertInstant(value: string, label: string): void {
  const timestamp = Date.parse(value);
  const canonical = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
  if (!ISO_UTC.test(value) ||
      (value !== canonical && value !== canonical.replace('.000Z', 'Z'))) {
    throw new RangeError(`${label} debe ser un instante UTC ISO-8601.`);
  }
}

function normalizedToken(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === '*' && (label === 'rule.market' || label === 'rule.channel')) return normalized;
  if (normalized.length < 2 || normalized.length > 40) throw new RangeError(`${label} inválido.`);
  return normalized;
}

function includesContext(values: readonly string[], value: string): boolean {
  return values.includes('*') || values.includes(value);
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateStatus(rule: PriceRuleCandidate, context: PriceRuleContext): PriceRuleEvaluationStatus | null {
  if (rule.currency.toUpperCase() !== context.currency.toUpperCase()) return 'excluded_currency';
  if (!includesContext(rule.markets, context.market)) return 'excluded_market';
  if (!includesContext(rule.channels, context.channel)) return 'excluded_channel';
  if (rule.activeFrom !== null && Date.parse(context.at) < Date.parse(rule.activeFrom)) return 'excluded_not_started';
  if (rule.activeUntil !== null && Date.parse(context.at) >= Date.parse(rule.activeUntil)) return 'excluded_expired';
  return null;
}

function assertCandidate(rule: PriceRuleCandidate): void {
  const id = rule.id.trim();
  if (id !== rule.id || id.length < 3 || id.length > 100) throw new RangeError('rule.id inválido.');
  if (rule.label.trim().length < 2 || rule.label.trim().length > 120) throw new RangeError('rule.label inválido.');
  assertInteger(rule.version, 'rule.version', 1, 1_000_000);
  assertInteger(rule.priority, 'rule.priority', 0, 100_000);
  if (rule.activeFrom !== null) assertInstant(rule.activeFrom, 'rule.activeFrom');
  if (rule.activeUntil !== null) assertInstant(rule.activeUntil, 'rule.activeUntil');
  if (rule.activeFrom !== null && rule.activeUntil !== null &&
    Date.parse(rule.activeUntil) <= Date.parse(rule.activeFrom)) {
    throw new RangeError('La vigencia de la regla debe tener fin posterior al inicio.');
  }
  if (rule.markets.length === 0 || rule.channels.length === 0) {
    throw new RangeError('La regla debe declarar al menos un mercado y un canal.');
  }
  for (const market of rule.markets) {
    if (normalizedToken(market, 'rule.market') !== market) throw new RangeError('rule.market inválido.');
  }
  for (const channel of rule.channels) {
    if (normalizedToken(channel, 'rule.channel') !== channel) throw new RangeError('rule.channel inválido.');
  }
  if (normalizedToken(rule.currency, 'rule.currency').toUpperCase() !== rule.currency) {
    throw new RangeError('rule.currency inválido.');
  }
  if (rule.effect.type === 'percentage_off') {
    assertInteger(rule.effect.basisPoints, 'rule.effect.basisPoints', 1, 10_000);
  } else {
    assertInteger(rule.effect.amountCents, 'rule.effect.amountCents', 1, 10_000_000);
  }
}

function discountPerUnit(baseUnitPriceCents: number, effect: PriceRuleCandidate['effect']): number {
  if (effect.type === 'amount_off') return Math.min(baseUnitPriceCents, effect.amountCents);
  return Math.min(baseUnitPriceCents, Math.floor(baseUnitPriceCents * effect.basisPoints / 10_000));
}

/**
 * Sin una política de combinabilidad, prioridad menor e ID estable eligen un
 * único ganador. R4.5 compone varias evaluaciones con un contrato separado.
 */
export function evaluatePriceRules(input: Readonly<{
  baseUnitPriceCents: number;
  quantity: number;
  context: PriceRuleContext;
  candidates?: readonly PriceRuleCandidate[];
}>): PriceBreakdown {
  assertInteger(input.baseUnitPriceCents, 'baseUnitPriceCents', 0, 10_000_000);
  assertInteger(input.quantity, 'quantity', 1, 99);
  assertInstant(input.context.at, 'context.at');
  const context = Object.freeze({
    at: input.context.at,
    currency: normalizedToken(input.context.currency, 'context.currency').toUpperCase(),
    market: normalizedToken(input.context.market, 'context.market'),
    channel: normalizedToken(input.context.channel, 'context.channel'),
  });
  const candidates = [...(input.candidates ?? [])];
  const ids = new Set<string>();
  for (const rule of candidates) {
    assertCandidate(rule);
    if (ids.has(rule.id)) throw new RangeError(`Regla duplicada: ${rule.id}.`);
    ids.add(rule.id);
  }
  const preevaluated = candidates.map((rule) => ({ rule, status: candidateStatus(rule, context) }));
  const eligible = preevaluated.filter((item) => item.status === null)
    .map((item) => item.rule)
    .sort((a, b) => a.priority - b.priority || compareStableId(a.id, b.id));
  const winner = eligible[0] ?? null;
  const perUnit = winner === null ? 0 : discountPerUnit(input.baseUnitPriceCents, winner.effect);
  const unitPrice = input.baseUnitPriceCents - perUnit;
  const evaluations = preevaluated
    .map(({ rule, status }): PriceRuleEvaluation => Object.freeze({
      ruleId: rule.id,
      version: rule.version,
      priority: rule.priority,
      status: status ?? (rule.id === winner?.id ? 'applied' : 'superseded_priority'),
    }))
    .sort((a, b) => a.priority - b.priority || compareStableId(a.ruleId, b.ruleId));
  return Object.freeze({
    schema: 1,
    context,
    currency: context.currency,
    base_unit_price_cents: input.baseUnitPriceCents,
    unit_price_cents: unitPrice,
    quantity: input.quantity,
    base_subtotal_cents: input.baseUnitPriceCents * input.quantity,
    discount_cents: perUnit * input.quantity,
    subtotal_cents: unitPrice * input.quantity,
    applied_rule: winner === null ? null : Object.freeze({
      id: winner.id,
      version: winner.version,
      label: winner.label.trim(),
      priority: winner.priority,
      effect: Object.freeze({ ...winner.effect }),
      discount_per_unit_cents: perUnit,
    }),
    evaluations: Object.freeze(evaluations),
  });
}
