/**
 * Cálculo de presupuesto de carrito contra D1.
 * El cliente SOLO envía slugs y cantidades — los precios salen siempre de la base.
 */

import { z } from 'zod';
import { getProductsBySlugs, getRateForZone } from './db';
import type { CatalogReadMode } from '../modules/catalog';
import {
  evaluatePriceRules,
  evaluateCombinedPriceRules,
  createD1AutomaticDiscounts,
  createD1Bundles,
  createD1DiscountCombinations,
  createD1PromotionCodes,
  createD1PriceLists,
  createD1QuantityOffers,
  createD1Preorders,
  resolveAutomaticDiscounts,
  resolvePromotionCode,
  resolvePriceLists,
  resolveQuantityOffers,
  resolvePricingSourceConflict,
  resolveDiscountCombination,
  resolveDiscountCombinationPolicy,
  type DiscountCombinationResolution,
  type BundleResolution,
  type BundleSelection,
  type DiscountSource,
  type PriceBreakdown,
  type PriceRuleCandidate,
  type PriceRuleContext,
  type PreorderApplication,
  type QuantityOfferEvidence,
} from '../modules/pricing';
import { computeShippingCents, computeSubtotalCents } from './pricing';
import { resolveZone } from './shipping';

export const quoteRequestSchema = z.object({
  lines: z
    .array(
      z.object({
        slug: z.string().min(1).max(120),
        qty: z.number().int().min(1).max(99),
        bundle_selections: z.array(z.object({
          group_id: z.string().trim().min(1).max(100),
          product_slug: z.string().trim().min(1).max(120),
        }).strict()).max(100).optional(),
      }),
    )
    .min(1)
    .max(50),
  postal_code: z.string().trim().min(1).max(10).optional(),
  promotion_code: z.string().trim().min(3).max(32).optional(),
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

/** Tope por producto tras agrupar líneas duplicadas (ver `aggregateLineQuantities`). */
const MAX_QTY_PER_LINE = 99;

/**
 * Agrupa líneas duplicadas del mismo slug sumando qty, con el mismo tope de 99
 * uds que ya aplica el cliente en `cart-client.ts`. Sin este tope, una petición
 * fabricada a mano con el mismo slug repetido en varias líneas (cada una ≤ 99,
 * el máximo que valida el schema por línea) podría acumular una cantidad muy
 * superior a 99 para ese producto.
 */
export function aggregateLineQuantities(lines: readonly { slug: string; qty: number }[]): Map<string, number> {
  const qtyBySlug = new Map<string, number>();
  for (const line of lines) {
    const next = (qtyBySlug.get(line.slug) ?? 0) + line.qty;
    qtyBySlug.set(line.slug, Math.min(next, MAX_QTY_PER_LINE));
  }
  return qtyBySlug;
}

export type QuoteLine = {
  slug: string;
  name: string;
  image: string;
  unit_price_cents: number;
  qty: number;
  line_total_cents: number;
  available_stock: number;
  /** Desglose servidor; null únicamente cuando el producto no existe. */
  pricing: PriceBreakdown | null;
  availability:
    | Readonly<{ status: 'immediate'; immediate_quantity: number; deferred_quantity: 0 }>
    | Readonly<{
      status: 'deferred'; kind: 'preorder' | 'backorder'; immediate_quantity: number;
      deferred_quantity: number; message: string; availability_starts_at: string;
      availability_ends_at: string;
    }>
    | null;
  /** ok = servible; el resto son motivos por los que la línea no puede comprarse tal cual */
  status: 'ok' | 'not-found' | 'out-of-stock' | 'insufficient-stock';
};

export type QuoteResult = {
  lines: QuoteLine[];
  subtotal_cents: number;
  /** null cuando aún no hay CP válido con cobertura */
  shipping_cents: number | null;
  total_cents: number | null;
  shipping: { zone: string; label: string; free_over_cents: number | null } | null;
  /** true si todas las líneas son servibles */
  purchasable: boolean;
  promotion:
    | Readonly<{ status: 'not_provided' }>
    | Readonly<{ status: 'rejected'; reason: 'invalid_or_unavailable' }>
    | Readonly<{
      status: 'applied'; promotion_id: string; version: number; label: string; discount_cents: number;
    }>;
  automatic_discount:
    | Readonly<{
      status: 'not_applied'; reason: 'no_eligible_discount' | 'promotion_code_precedence' | 'higher_priority_campaign';
    }>
    | Readonly<{
      status: 'applied'; discount_id: string; version: number; reason: string; discount_cents: number;
    }>;
  quantity_offer:
    | Readonly<{
      status: 'not_applied'; reason: 'no_eligible_offer' | 'promotion_code_precedence' | 'higher_priority_campaign';
    }>
    | Readonly<{
      status: 'applied'; offer_id: string; version: number; kind: 'quantity_tier' | 'buy_x_get_y';
      reason: string; discount_cents: number; evidence: QuantityOfferEvidence;
    }>;
  discount_combination:
    | Readonly<{ status: 'not_applied'; reason: 'disabled' | 'no_active_policy' | 'not_enough_eligible_sources' }>
    | Readonly<{
      status: 'applied'; policy_id: string; version: number; label: string;
      maximum_discount_basis_points: number; discount_cents: number;
      selected_sources: readonly Readonly<{
        source: DiscountSource; discount_class: 'product' | 'order' | 'shipping';
        rule_id: string; rule_version: number; discount_cents: number;
      }>[];
      excluded_sources: DiscountCombinationResolution['excluded'];
    }>;
  price_lists:
    | Readonly<{ status: 'not_applied'; reason: 'disabled' | 'no_eligible_list' }>
    | Readonly<{
      status: 'applied';
      applications: readonly Readonly<{
        price_list_id: string; version: number; label: string; line_count: number;
        catalog_subtotal_cents: number; effective_subtotal_cents: number; delta_cents: number;
      }>[];
    }>;
  bundles:
    | Readonly<{ status: 'not_applied'; reason: 'disabled' | 'no_bundle_lines' }>
    | Readonly<{
      status: 'applied'; applications: readonly Readonly<{
        bundle_id: string; version: number; product_id: number; label: string;
        kind: 'fixed' | 'configurable'; unit_price_cents: number; quantity: number;
        snapshot: BundleResolution['snapshot'];
        components: readonly Readonly<{ productId: number; quantityPerBundle: number }>[];
      }>[];
    }>;
  preorders:
    | Readonly<{ status: 'not_applied'; reason: 'disabled' | 'no_deferred_lines' }>
    | Readonly<{ status: 'applied'; applications: readonly PreorderApplication[] }>;
};

export async function quoteCart(
  db: D1Database,
  request: QuoteRequest,
  options: Readonly<{
    catalogReadMode?: CatalogReadMode;
    pricingContext?: PriceRuleContext;
    priceRulesBySlug?: Readonly<Record<string, readonly PriceRuleCandidate[]>>;
    promotionCustomerKeyHash?: string;
    promotionCodesEnabled?: boolean;
    automaticDiscountsEnabled?: boolean;
    /** Compatibilidad de tests/embebidos; activa ambos contratos R4.4. */
    quantityOffersEnabled?: boolean;
    quantityTiersEnabled?: boolean;
    buyXGetYEnabled?: boolean;
    discountCombinationsEnabled?: boolean;
    priceListsEnabled?: boolean;
    /** Identidad empresarial resuelta por servidor; nunca procede del cuerpo libre del checkout. */
    priceListCompanyKeyHash?: string;
    bundlesEnabled?: boolean;
    preordersEnabled?: boolean;
  }> = {},
): Promise<QuoteResult> {
  // Colapsar duplicados del mismo slug antes de tocar la base
  const qtyBySlug = aggregateLineQuantities(request.lines);

  const products = await getProductsBySlugs(
    db,
    [...qtyBySlug.keys()],
    options.catalogReadMode ?? 'legacy',
  );
  const bySlug = new Map(products.map((prod) => [prod.slug, prod]));
  const pricingContext = options.pricingContext ?? {
    at: new Date().toISOString(),
    currency: 'EUR',
    market: 'ES',
    channel: 'storefront',
  };
  const bundleByProduct = new Map<number, BundleResolution>();
  if (options.bundlesEnabled === true) {
    const bundles = createD1Bundles(db);
    const selectionSlugs = request.lines.flatMap((line) =>
      line.bundle_selections?.map((selection) => selection.product_slug) ?? []);
    const productIdsBySlug = await bundles.productIdsBySlugs([...new Set(selectionSlugs)]);
    const selectionFingerprintBySlug = new Map<string, string>();
    for (const requestLine of request.lines) {
      const normalized = [...(requestLine.bundle_selections ?? [])]
        .map((selection) => `${selection.group_id}:${selection.product_slug}`).sort().join('|');
      const previous = selectionFingerprintBySlug.get(requestLine.slug);
      if (previous !== undefined && previous !== normalized) {
        throw new RangeError('Un mismo bundle no admite composiciones distintas en una cotización.');
      }
      selectionFingerprintBySlug.set(requestLine.slug, normalized);
    }
    for (const product of products) {
      const requestLine = request.lines.find((line) => line.slug === product.slug);
      const selections: BundleSelection[] = (requestLine?.bundle_selections ?? []).map((selection) => {
        const productId = productIdsBySlug.get(selection.product_slug);
        if (productId === undefined) throw new RangeError(`Componente ${selection.product_slug} no disponible.`);
        return Object.freeze({ groupId: selection.group_id, productId });
      });
      const resolution = await bundles.resolveForProduct(product.id, selections);
      if (resolution !== null) bundleByProduct.set(product.id, resolution);
    }
  }
  const contextualPriceByProduct = options.priceListsEnabled === true
    ? new Map(resolvePriceLists({
      lists: await createD1PriceLists(db).listActive(),
      context: pricingContext,
      companyKeyHash: options.priceListCompanyKeyHash ?? null,
      lines: products.map((product) => ({
        productId: product.id,
        catalogUnitPriceCents: product.price_cents,
      })),
    }).lines.map((line) => [line.productId, line]))
    : new Map<number, undefined>();
  const basePrice = (product: (typeof products)[number]) =>
    contextualPriceByProduct.get(product.id)?.baseUnitPriceCents ?? product.price_cents;
  let promotionResolution: ReturnType<typeof resolvePromotionCode> | null = null;
  if (request.promotion_code !== undefined && options.promotionCodesEnabled === true) {
    let lookup: Awaited<ReturnType<ReturnType<typeof createD1PromotionCodes>['lookup']>> = null;
    try {
      lookup = await createD1PromotionCodes(db).lookup(
        request.promotion_code,
        options.promotionCustomerKeyHash ?? null,
      );
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    if (lookup !== null) {
      const baseSubtotalCents = [...qtyBySlug.entries()].reduce((total, [slug, qty]) => {
        const product = bySlug.get(slug);
        return total + (product === undefined ? 0 : basePrice(product) * qty);
      }, 0);
      promotionResolution = resolvePromotionCode({
        promotion: lookup.promotion,
        context: pricingContext,
        baseSubtotalCents,
        cartProductIds: products.map((product) => product.id),
        globalUsageCount: lookup.globalUsageCount,
        customerUsageCount: lookup.customerUsageCount,
      });
    }
  }
  const automaticDiscounts = options.automaticDiscountsEnabled === true
    ? await createD1AutomaticDiscounts(db).listActive()
    : [];
  const automaticResolution = resolveAutomaticDiscounts({
    discounts: automaticDiscounts,
    context: pricingContext,
    baseSubtotalCents: [...qtyBySlug.entries()].reduce((total, [slug, qty]) => {
      const product = bySlug.get(slug);
      return total + (product === undefined ? 0 : basePrice(product) * qty);
    }, 0),
    cartProductIds: products.map((product) => product.id),
  });
  const quantityOffersEnabled = options.quantityOffersEnabled === true ||
    options.quantityTiersEnabled === true || options.buyXGetYEnabled === true;
  const quantityResolution: ReturnType<typeof resolveQuantityOffers> =
    quantityOffersEnabled
      ? resolveQuantityOffers({
        offers: (await createD1QuantityOffers(db).listActive()).filter((offer) =>
          options.quantityOffersEnabled === true ||
          (offer.kind === 'quantity_tier' && options.quantityTiersEnabled === true) ||
          (offer.kind === 'buy_x_get_y' && options.buyXGetYEnabled === true)),
        context: pricingContext,
        lines: products.map((product) => ({
          productId: product.id,
          unitPriceCents: basePrice(product),
          quantity: qtyBySlug.get(product.slug) ?? 1,
        })),
      })
      : Object.freeze({ status: 'not_eligible', reason: 'no_eligible_offer', evaluations: [] });
  const pricingSource = resolvePricingSourceConflict({
    promotionEligible: promotionResolution?.status === 'eligible',
    automaticEligible: automaticResolution.status === 'eligible',
    quantityOfferEligible: quantityResolution.status === 'eligible',
    ...(automaticResolution.status !== 'eligible'
      ? {}
      : { automaticCandidate: automaticResolution.candidate }),
    ...(quantityResolution.status !== 'eligible'
      ? {}
      : { quantityOfferCandidate: quantityResolution.candidate }),
  });
  const combinationCandidates = [
    ...(promotionResolution?.status === 'eligible' ? [{
      source: 'promotion_code' as const, discountClass: 'order' as const,
      candidate: promotionResolution.candidate, eligibleProductIds: promotionResolution.eligibleProductIds,
    }] : []),
    ...(automaticResolution.status === 'eligible' ? [{
      source: 'automatic_discount' as const, discountClass: 'product' as const,
      candidate: automaticResolution.candidate, eligibleProductIds: automaticResolution.eligibleProductIds,
    }] : []),
    ...(quantityResolution.status === 'eligible' ? [{
      source: 'quantity_offer' as const, discountClass: 'product' as const,
      candidate: quantityResolution.candidate, eligibleProductIds: quantityResolution.eligibleProductIds,
    }] : []),
  ];
  const combinationPolicy = options.discountCombinationsEnabled === true
    ? resolveDiscountCombinationPolicy({
      policies: await createD1DiscountCombinations(db).listActive(),
      context: pricingContext,
    })
    : null;
  const combinationResolution = combinationPolicy === null || combinationCandidates.length < 1
    ? null
    : resolveDiscountCombination({ policy: combinationPolicy, candidates: combinationCandidates });
  const combinationActive = (combinationResolution?.selected.length ?? 0) >= 2;
  const selectedSources = new Set<DiscountSource>(combinationActive
    ? combinationResolution!.selected.map((item) => item.source)
    : pricingSource === 'none' ? [] : [pricingSource]);
  const promotionProductIds = new Set(
    promotionResolution?.status === 'eligible' ? promotionResolution.eligibleProductIds : [],
  );
  const automaticProductIds = new Set(
    automaticResolution.status === 'eligible' ? automaticResolution.eligibleProductIds : [],
  );
  const quantityProductIds = new Set(
    quantityResolution.status === 'eligible' ? quantityResolution.eligibleProductIds : [],
  );
  const preorderResolutions = options.preordersEnabled === true
    ? await createD1Preorders(db).resolveForProducts(products
      .filter((product) => !bundleByProduct.has(product.id))
      .map((product) => ({
        productId: product.id,
        requestedQuantity: qtyBySlug.get(product.slug) ?? 1,
        availableQuantity: product.stock,
      })), pricingContext.at)
    : new Map<number, never>();
  const preorderApplications: PreorderApplication[] = [];

  const lines: QuoteLine[] = [...qtyBySlug.entries()].map(([slug, qty]) => {
    const prod = bySlug.get(slug);
    if (!prod) {
      return {
        slug, name: slug, image: '', unit_price_cents: 0, qty,
        line_total_cents: 0, available_stock: 0, pricing: null, availability: null,
        status: 'not-found',
      };
    }
    const bundle = bundleByProduct.get(prod.id);
    const availableStock = bundle?.availableStock ?? prod.stock;
    const physicalStatus = availableStock === 0
      ? 'out-of-stock'
      : availableStock < qty ? 'insufficient-stock' : 'ok';
    const preorder = preorderResolutions.get(prod.id);
    const capacityRejected = preorder?.policy?.state === 'active' &&
      preorder.resolution.status === 'rejected' &&
      preorder.resolution.reason === 'insufficient_deferred_capacity';
    const status = preorder?.resolution.status === 'deferred' ||
      preorder?.resolution.status === 'available'
      ? 'ok'
      : capacityRejected
        ? preorder.resolution.immediateQuantity === 0 ? 'out-of-stock' : 'insufficient-stock'
        : physicalStatus;
    const configuredCandidates = options.priceRulesBySlug?.[slug];
    const promotionCandidates = selectedSources.has('promotion_code') &&
      promotionResolution?.status === 'eligible' && promotionProductIds.has(prod.id)
      ? [promotionResolution.candidate]
      : undefined;
    const automaticCandidates = selectedSources.has('automatic_discount') &&
      automaticResolution.status === 'eligible' && automaticProductIds.has(prod.id)
      ? [automaticResolution.candidate]
      : undefined;
    const quantityCandidates = selectedSources.has('quantity_offer') &&
      quantityResolution.status === 'eligible' && quantityProductIds.has(prod.id)
      ? [quantityResolution.candidate]
      : undefined;
    const persistedCandidates = [
      ...(promotionCandidates ?? []), ...(automaticCandidates ?? []), ...(quantityCandidates ?? []),
    ];
    if (configuredCandidates !== undefined && persistedCandidates.length > 0) {
      throw new Error('La combinación de fuentes de descuento requiere PRC-008.');
    }
    const candidates = configuredCandidates ?? persistedCandidates;
    const contextualPrice = contextualPriceByProduct.get(prod.id);
    const evaluatedPricing = combinationActive && configuredCandidates === undefined
      ? evaluateCombinedPriceRules({
        baseUnitPriceCents: basePrice(prod), quantity: qty, context: pricingContext,
        candidates: persistedCandidates,
        maximumDiscountBasisPoints: combinationResolution!.policy.maximumDiscountBasisPoints,
      })
      : evaluatePriceRules({
        baseUnitPriceCents: basePrice(prod), quantity: qty, context: pricingContext,
        ...(candidates.length === 0 ? {} : { candidates }),
      });
    const pricing: PriceBreakdown = Object.freeze({
      ...evaluatedPricing,
      ...(contextualPrice === undefined ? {} : { price_origin: contextualPrice.origin }),
      ...(bundle === undefined ? {} : { bundle: bundle.snapshot }),
    });
    const availability: QuoteLine['availability'] = preorder?.resolution.status === 'deferred'
      ? Object.freeze({
        status: 'deferred' as const,
        kind: preorder.resolution.snapshot.kind,
        immediate_quantity: preorder.resolution.immediateQuantity,
        deferred_quantity: preorder.resolution.deferredQuantity,
        message: preorder.resolution.snapshot.public_message,
        availability_starts_at: preorder.resolution.snapshot.availability_starts_at,
        availability_ends_at: preorder.resolution.snapshot.availability_ends_at,
      })
      : status === 'ok'
        ? Object.freeze({ status: 'immediate' as const, immediate_quantity: qty,
          deferred_quantity: 0 as const })
        : null;
    if (preorder?.resolution.status === 'deferred' && preorder.policy !== null) {
      preorderApplications.push(Object.freeze({
        policyId: preorder.policy.id,
        policyVersion: preorder.policy.version,
        policyCapacityVersion: preorder.policy.capacityVersion,
        productId: prod.id,
        variantId: preorder.policy.variantId,
        kind: preorder.policy.kind,
        immediateQuantity: preorder.resolution.immediateQuantity,
        deferredQuantity: preorder.resolution.deferredQuantity,
        snapshot: preorder.resolution.snapshot,
      }));
    }
    return {
      slug,
      name: prod.name,
      image: prod.image,
      unit_price_cents: pricing.unit_price_cents,
      qty,
      line_total_cents: status === 'ok' ? pricing.subtotal_cents : 0,
      available_stock: availableStock,
      pricing,
      availability,
      status,
    };
  });

  const servable = lines.filter((line) => line.status === 'ok');
  const subtotal_cents = computeSubtotalCents(servable);
  const sourceDiscount = (prefix: string) => servable.reduce((total, line) => {
    const pricing = line.pricing;
    if (pricing === null) return total;
    if (pricing.schema === 2) {
      return total + (pricing.applied_rules ?? []).reduce((sum, rule) =>
        sum + (rule.id.startsWith(prefix) ? rule.discount_per_unit_cents * line.qty : 0), 0);
    }
    return total + (pricing.applied_rule?.id.startsWith(prefix) ? pricing.discount_cents : 0);
  }, 0);
  const promotionDiscountCents = sourceDiscount('promotion:');
  const automaticDiscountCents = sourceDiscount('automatic:');
  const quantityDiscountCents = sourceDiscount('quantity:');
  const promotion: QuoteResult['promotion'] = request.promotion_code === undefined
    ? { status: 'not_provided' }
    : promotionResolution?.status === 'eligible' && promotionDiscountCents > 0
      ? {
        status: 'applied',
        promotion_id: promotionResolution.candidate.id.slice('promotion:'.length),
        version: promotionResolution.candidate.version,
        label: promotionResolution.candidate.label,
        discount_cents: promotionDiscountCents,
      }
      : { status: 'rejected', reason: 'invalid_or_unavailable' };
  const automatic_discount: QuoteResult['automatic_discount'] = selectedSources.has('automatic_discount') &&
      automaticResolution.status === 'eligible' && automaticDiscountCents > 0
    ? {
      status: 'applied',
      discount_id: automaticResolution.discount.id,
      version: automaticResolution.discount.version,
      reason: automaticResolution.discount.publicReason,
      discount_cents: automaticDiscountCents,
    }
    : {
      status: 'not_applied',
      reason: automaticResolution.status !== 'eligible'
        ? 'no_eligible_discount'
        : pricingSource === 'promotion_code'
          ? 'promotion_code_precedence'
          : 'higher_priority_campaign',
    };
  const quantity_offer: QuoteResult['quantity_offer'] = selectedSources.has('quantity_offer') &&
      quantityResolution.status === 'eligible' && quantityDiscountCents > 0
    ? {
      status: 'applied',
      offer_id: quantityResolution.offer.id,
      version: quantityResolution.offer.version,
      kind: quantityResolution.offer.kind,
      reason: quantityResolution.offer.publicReason,
      discount_cents: quantityDiscountCents,
      evidence: quantityResolution.evidence,
    }
    : {
      status: 'not_applied',
      reason: quantityResolution.status !== 'eligible'
        ? 'no_eligible_offer'
        : pricingSource === 'promotion_code'
          ? 'promotion_code_precedence'
          : 'higher_priority_campaign',
    };
  const sourceDiscounts: Readonly<Record<DiscountSource, number>> = {
    promotion_code: promotionDiscountCents,
    automatic_discount: automaticDiscountCents,
    quantity_offer: quantityDiscountCents,
  };
  const discount_combination: QuoteResult['discount_combination'] = combinationActive
    ? {
      status: 'applied', policy_id: combinationResolution!.policy.id,
      version: combinationResolution!.policy.version, label: combinationResolution!.policy.label,
      maximum_discount_basis_points: combinationResolution!.policy.maximumDiscountBasisPoints,
      discount_cents: Object.values(sourceDiscounts).reduce((total, value) => total + value, 0),
      selected_sources: combinationResolution!.selected.map((item) => ({
        source: item.source, discount_class: item.discountClass,
        rule_id: item.candidate.id, rule_version: item.candidate.version,
        discount_cents: sourceDiscounts[item.source],
      })),
      excluded_sources: combinationResolution!.excluded,
    }
    : {
      status: 'not_applied',
      reason: options.discountCombinationsEnabled !== true
        ? 'disabled'
        : combinationPolicy === null ? 'no_active_policy' : 'not_enough_eligible_sources',
    };
  const applicationByList = new Map<string, {
    price_list_id: string; version: number; label: string; line_count: number;
    catalog_subtotal_cents: number; effective_subtotal_cents: number; delta_cents: number;
  }>();
  for (const line of servable) {
    const origin = line.pricing?.price_origin;
    if (origin?.type !== 'price_list') continue;
    const current = applicationByList.get(origin.price_list_id) ?? {
      price_list_id: origin.price_list_id, version: origin.version, label: origin.label,
      line_count: 0, catalog_subtotal_cents: 0, effective_subtotal_cents: 0, delta_cents: 0,
    };
    current.line_count += 1;
    current.catalog_subtotal_cents += origin.catalog_unit_price_cents * line.qty;
    current.effective_subtotal_cents += origin.unit_price_cents * line.qty;
    current.delta_cents = current.effective_subtotal_cents - current.catalog_subtotal_cents;
    applicationByList.set(origin.price_list_id, current);
  }
  const price_lists: QuoteResult['price_lists'] = applicationByList.size > 0
    ? {
      status: 'applied',
      applications: Object.freeze([...applicationByList.values()].map((application) => Object.freeze(application))),
    }
    : { status: 'not_applied', reason: options.priceListsEnabled === true ? 'no_eligible_list' : 'disabled' };
  const bundleApplications = servable.flatMap((line) => {
    const product = bySlug.get(line.slug);
    const resolution = product === undefined ? undefined : bundleByProduct.get(product.id);
    if (product === undefined || resolution === undefined) return [];
    return [Object.freeze({
      bundle_id: resolution.bundle.id, version: resolution.bundle.version,
      product_id: product.id, label: resolution.bundle.label, kind: resolution.bundle.kind,
      unit_price_cents: line.unit_price_cents, quantity: line.qty, snapshot: resolution.snapshot,
      components: Object.freeze(resolution.components.map((component) => Object.freeze({
        productId: component.productId, quantityPerBundle: component.quantity,
      }))),
    })];
  });
  const bundles: QuoteResult['bundles'] = bundleApplications.length === 0
    ? { status: 'not_applied', reason: options.bundlesEnabled === true ? 'no_bundle_lines' : 'disabled' }
    : { status: 'applied', applications: Object.freeze(bundleApplications) };
  const preorders: QuoteResult['preorders'] = preorderApplications.length === 0
    ? { status: 'not_applied', reason: options.preordersEnabled === true
      ? 'no_deferred_lines' : 'disabled' }
    : { status: 'applied', applications: Object.freeze(preorderApplications) };

  let shipping_cents: number | null = null;
  let shipping: QuoteResult['shipping'] = null;
  if (request.postal_code !== undefined) {
    const zone = resolveZone(request.postal_code);
    if (zone !== null) {
      const rate = await getRateForZone(db, zone);
      if (rate !== null) {
        shipping_cents = computeShippingCents(subtotal_cents, rate);
        shipping = { zone: rate.zone, label: rate.label, free_over_cents: rate.free_over_cents };
      }
    }
  }

  return {
    lines,
    subtotal_cents,
    shipping_cents,
    total_cents: shipping_cents === null ? null : subtotal_cents + shipping_cents,
    shipping,
    purchasable: lines.length > 0 && lines.every((line) => line.status === 'ok'),
    promotion,
    automatic_discount,
    quantity_offer,
    discount_combination,
    price_lists,
    bundles,
    preorders,
  };
}
