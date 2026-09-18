import type { PriceList } from '../domain/price-list';

type ListRow = Readonly<{
  id: string; version: number; label: string; state: PriceList['state']; priority: number;
  currency: string; active_from: string | null; active_until: string | null;
  markets_json: string; channels_json: string;
}>;
type ProductRow = Readonly<{ price_list_id: string; product_id: number; price_cents: number }>;
type CompanyRow = Readonly<{ price_list_id: string; company_key_hash: string }>;

export type PriceListApplication = Readonly<{
  priceListId: string;
  priceListVersion: number;
  catalogSubtotalCents: number;
  effectiveSubtotalCents: number;
  lineCount: number;
  snapshot: Readonly<Record<string, unknown>>;
}>;

function tokens(value: string, label: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} persistido inválido.`);
  }
  return Object.freeze(parsed as string[]);
}

export function createD1PriceLists(db: D1Database) {
  return Object.freeze({
    async listActive(): Promise<readonly PriceList[]> {
      const { results: rows } = await db.prepare(`SELECT id, version, label, state, priority,
        currency, active_from, active_until, markets_json, channels_json
        FROM price_lists WHERE state='active' ORDER BY priority, id`).all<ListRow>();
      if (rows.length === 0) return [];
      const [productResult, companyResult] = await Promise.all([
        db.prepare(`SELECT price_list_id, product_id, price_cents FROM price_list_products
          ORDER BY price_list_id, product_id`).all<ProductRow>(),
        db.prepare(`SELECT price_list_id, company_key_hash FROM price_list_companies
          ORDER BY price_list_id, company_key_hash`).all<CompanyRow>(),
      ]);
      return Object.freeze(rows.map((row) => Object.freeze({
        id: row.id, version: row.version, label: row.label, state: row.state,
        priority: row.priority, currency: row.currency, activeFrom: row.active_from,
        activeUntil: row.active_until, markets: tokens(row.markets_json, 'markets_json'),
        channels: tokens(row.channels_json, 'channels_json'),
        companyKeyHashes: Object.freeze(companyResult.results
          .filter((item) => item.price_list_id === row.id).map((item) => item.company_key_hash)),
        prices: Object.freeze(productResult.results.filter((item) => item.price_list_id === row.id)
          .map((item) => Object.freeze({ productId: item.product_id, priceCents: item.price_cents }))),
      })));
    },

    applicationStatement(orderNumber: string, application: PriceListApplication, appliedAt: string): D1PreparedStatement {
      return db.prepare(`INSERT INTO price_list_applications (
        id, price_list_id, price_list_version, order_id, catalog_subtotal_cents,
        effective_subtotal_cents, line_count, snapshot_json, idempotency_key, applied_at
      ) SELECT ?, ?, ?, o.id, ?, ?, ?, ?, ?, ? FROM orders o WHERE o.order_number=?`).bind(
        `price_list_app_${crypto.randomUUID()}`,
        application.priceListId,
        application.priceListVersion,
        application.catalogSubtotalCents,
        application.effectiveSubtotalCents,
        application.lineCount,
        JSON.stringify(application.snapshot),
        `price-list:${application.priceListId}:order:${orderNumber}`,
        appliedAt,
        orderNumber,
      );
    },
  });
}
