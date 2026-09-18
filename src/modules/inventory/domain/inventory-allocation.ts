export type InventoryRoutingDemand = Readonly<{
  orderItemId: number;
  variantId: number;
  quantity: number;
}>;

export type InventoryRoutingCandidate = Readonly<{
  locationId: number;
  code: string;
  isPrimary: boolean;
  priority: number;
  handlingCostCents: number;
  policyVersion: number;
  markets: readonly string[];
  channels: readonly string[];
  availableByVariant: Readonly<Record<number, number>>;
}>;

export type InventoryRoutingCandidateExplanation = Readonly<{
  locationId: number;
  code: string;
  eligible: boolean;
  reason: 'eligible' | 'market' | 'channel' | 'stock';
  priority: number;
  handlingCostCents: number;
}>;

export type InventoryRoutingPlan = Readonly<{
  selected: InventoryRoutingCandidate;
  candidates: readonly InventoryRoutingCandidateExplanation[];
}>;

function includesRule(rules: readonly string[], value: string): boolean {
  return rules.includes('*') || rules.includes(value);
}

export function planInventoryRouting(input: Readonly<{
  market: string;
  channel: string;
  demands: readonly InventoryRoutingDemand[];
  candidates: readonly InventoryRoutingCandidate[];
}>): InventoryRoutingPlan {
  const market = input.market.trim().toUpperCase();
  const channel = input.channel.trim().toLowerCase();
  if (!/^[A-Z0-9-]{2,20}$/.test(market)) throw new RangeError('Mercado de asignación inválido.');
  if (!/^[a-z0-9-]{2,40}$/.test(channel)) throw new RangeError('Canal de asignación inválido.');
  if (input.demands.length < 1 || input.demands.length > 100) throw new RangeError('La asignación exige entre 1 y 100 líneas.');
  const variants = new Set<number>();
  for (const demand of input.demands) {
    if (!Number.isSafeInteger(demand.orderItemId) || demand.orderItemId < 1 ||
        !Number.isSafeInteger(demand.variantId) || demand.variantId < 1 ||
        !Number.isSafeInteger(demand.quantity) || demand.quantity < 1) {
      throw new RangeError('Demanda de asignación inválida.');
    }
    if (variants.has(demand.variantId)) throw new RangeError('Una variante no puede repetirse en la misma asignación.');
    variants.add(demand.variantId);
  }
  const explanations = input.candidates.map((candidate): InventoryRoutingCandidateExplanation => {
    let reason: InventoryRoutingCandidateExplanation['reason'] = 'eligible';
    if (!includesRule(candidate.markets, market)) reason = 'market';
    else if (!includesRule(candidate.channels, channel)) reason = 'channel';
    else if (input.demands.some((demand) => (candidate.availableByVariant[demand.variantId] ?? 0) < demand.quantity)) reason = 'stock';
    return Object.freeze({
      locationId: candidate.locationId, code: candidate.code,
      eligible: reason === 'eligible', reason,
      priority: candidate.priority, handlingCostCents: candidate.handlingCostCents,
    });
  });
  const eligible = input.candidates.filter((_, index) => explanations[index]!.eligible)
    .sort((left, right) => left.priority - right.priority ||
      left.handlingCostCents - right.handlingCostCents || left.locationId - right.locationId);
  if (!eligible[0]) throw new RangeError('Ninguna ubicación puede cubrir íntegramente el envío.');
  return Object.freeze({ selected: eligible[0], candidates: Object.freeze(explanations) });
}
