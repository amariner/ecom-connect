import type { PriceOrigin, PriceRuleContext } from './price-rule';

export const PRICE_LIST_STATES = ['active', 'disabled', 'archived'] as const;
export type PriceListState = (typeof PRICE_LIST_STATES)[number];

export type PriceList = Readonly<{
  id: string;
  version: number;
  label: string;
  state: PriceListState;
  priority: number;
  currency: string;
  activeFrom: string | null;
  activeUntil: string | null;
  markets: readonly string[];
  channels: readonly string[];
  companyKeyHashes: readonly string[];
  prices: readonly Readonly<{ productId: number; priceCents: number }>[];
}>;

export type PriceListResolution = Readonly<{
  lines: readonly Readonly<{
    productId: number; catalogUnitPriceCents: number; baseUnitPriceCents: number;
    origin: PriceOrigin;
  }>[];
  evaluations: readonly Readonly<{
    productId: number; priceListId: string; version: number;
    status: 'selected' | 'fallback_lower_priority' | 'fallback_missing_product' |
      'excluded_context' | 'excluded_company';
  }>[];
}>;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const HASH = /^[a-f0-9]{64}$/;

function integer(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label} inválido.`);
}

function instant(value: string, label: string): void {
  if (!ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) throw new RangeError(`${label} inválido.`);
}

function tokens(values: readonly string[], label: string): void {
  if (values.length === 0) throw new RangeError(`${label} no puede estar vacío.`);
  const seen = new Set<string>();
  for (const value of values) {
    if (value !== value.trim() || value.length < 1 || value.length > 40 || seen.has(value)) {
      throw new RangeError(`${label} inválido.`);
    }
    seen.add(value);
  }
}

export function assertPriceList(list: PriceList): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,98}[a-z0-9])?$/.test(list.id)) throw new RangeError('priceList.id inválido.');
  if (list.label.trim().length < 2 || list.label.trim().length > 120) throw new RangeError('priceList.label inválido.');
  if (!PRICE_LIST_STATES.includes(list.state)) throw new RangeError('priceList.state inválido.');
  integer(list.version, 'priceList.version', 1, 1_000_000);
  integer(list.priority, 'priceList.priority', 0, 100_000);
  if (!/^[A-Z]{3}$/.test(list.currency)) throw new RangeError('priceList.currency inválido.');
  if (list.activeFrom !== null) instant(list.activeFrom, 'priceList.activeFrom');
  if (list.activeUntil !== null) instant(list.activeUntil, 'priceList.activeUntil');
  if (list.activeFrom !== null && list.activeUntil !== null && Date.parse(list.activeUntil) <= Date.parse(list.activeFrom)) {
    throw new RangeError('La vigencia de priceList es inválida.');
  }
  tokens(list.markets, 'priceList.markets');
  tokens(list.channels, 'priceList.channels');
  if (list.prices.length === 0) throw new RangeError('priceList.prices no puede estar vacío.');
  const products = new Set<number>();
  for (const price of list.prices) {
    integer(price.productId, 'priceList.productId', 1, 2_147_483_647);
    integer(price.priceCents, 'priceList.priceCents', 1, 10_000_000);
    if (products.has(price.productId)) throw new RangeError('priceList.prices contiene productos duplicados.');
    products.add(price.productId);
  }
  const companies = new Set<string>();
  for (const hash of list.companyKeyHashes) {
    if (!HASH.test(hash) || companies.has(hash)) throw new RangeError('priceList.companyKeyHashes inválido.');
    companies.add(hash);
  }
}

function includes(values: readonly string[], value: string): boolean {
  return values.includes('*') || values.includes(value);
}

function contextEligible(list: PriceList, context: PriceRuleContext): boolean {
  return list.state === 'active' && list.currency === context.currency.toUpperCase() &&
    includes(list.markets, context.market) && includes(list.channels, context.channel) &&
    (list.activeFrom === null || Date.parse(list.activeFrom) <= Date.parse(context.at)) &&
    (list.activeUntil === null || Date.parse(list.activeUntil) > Date.parse(context.at));
}

export function resolvePriceLists(input: Readonly<{
  lists: readonly PriceList[];
  context: PriceRuleContext;
  companyKeyHash: string | null;
  lines: readonly Readonly<{ productId: number; catalogUnitPriceCents: number }>[];
}>): PriceListResolution {
  instant(input.context.at, 'context.at');
  if (input.companyKeyHash !== null && !HASH.test(input.companyKeyHash)) {
    throw new RangeError('companyKeyHash inválido.');
  }
  const ids = new Set<string>();
  for (const list of input.lists) {
    assertPriceList(list);
    if (ids.has(list.id)) throw new RangeError('priceList duplicada.');
    ids.add(list.id);
  }
  const products = new Set<number>();
  for (const line of input.lines) {
    integer(line.productId, 'productId', 1, 2_147_483_647);
    integer(line.catalogUnitPriceCents, 'catalogUnitPriceCents', 0, 10_000_000);
    if (products.has(line.productId)) throw new RangeError('Línea de precio duplicada.');
    products.add(line.productId);
  }
  const ordered = [...input.lists].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  const evaluations: PriceListResolution['evaluations'][number][] = [];
  const lines = input.lines.map((line) => {
    const contextual = ordered.filter((list) => contextEligible(list, input.context));
    const company = input.companyKeyHash === null ? [] : contextual.filter((list) =>
      list.companyKeyHashes.includes(input.companyKeyHash!));
    const general = contextual.filter((list) => list.companyKeyHashes.length === 0);
    const tiers = input.companyKeyHash === null ? [general] : [company, general];
    let selected: PriceList | null = null;
    let selectedPrice = line.catalogUnitPriceCents;
    let fallbackDepth = tiers.length;
    for (let depth = 0; depth < tiers.length && selected === null; depth += 1) {
      for (const list of tiers[depth]!) {
        const price = list.prices.find((item) => item.productId === line.productId);
        if (price === undefined) {
          evaluations.push({ productId: line.productId, priceListId: list.id, version: list.version,
            status: 'fallback_missing_product' });
          continue;
        }
        selected = list;
        selectedPrice = price.priceCents;
        fallbackDepth = depth;
        evaluations.push({ productId: line.productId, priceListId: list.id, version: list.version, status: 'selected' });
        break;
      }
    }
    for (const list of ordered) {
      if (list === selected || evaluations.some((item) => item.productId === line.productId && item.priceListId === list.id)) continue;
      evaluations.push({
        productId: line.productId, priceListId: list.id, version: list.version,
        status: !contextEligible(list, input.context) ? 'excluded_context'
          : list.companyKeyHashes.length > 0 && (input.companyKeyHash === null ||
              !list.companyKeyHashes.includes(input.companyKeyHash))
            ? 'excluded_company'
            : 'fallback_lower_priority',
      });
    }
    const origin: PriceOrigin = selected === null
      ? Object.freeze({ type: 'catalog', catalog_unit_price_cents: line.catalogUnitPriceCents,
        unit_price_cents: line.catalogUnitPriceCents, fallback_depth: fallbackDepth })
      : Object.freeze({ type: 'price_list', price_list_id: selected.id, version: selected.version,
        label: selected.label.trim(), priority: selected.priority,
        catalog_unit_price_cents: line.catalogUnitPriceCents, unit_price_cents: selectedPrice,
        company_scoped: selected.companyKeyHashes.length > 0, fallback_depth: fallbackDepth });
    return Object.freeze({ productId: line.productId, catalogUnitPriceCents: line.catalogUnitPriceCents,
      baseUnitPriceCents: selectedPrice, origin });
  });
  return Object.freeze({
    lines: Object.freeze(lines),
    evaluations: Object.freeze(evaluations.map((evaluation) => Object.freeze(evaluation))),
  });
}
