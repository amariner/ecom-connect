import { resolveBundle, type BundleDefinition, type BundleResolution, type BundleSelection } from '../domain/bundle';

type BundleRow = Readonly<{
  id: string; product_id: number; label: string; kind: BundleDefinition['kind'];
  state: BundleDefinition['state']; version: number;
}>;
type GroupRow = Readonly<{
  bundle_id: string; id: string; label: string; minimum_selections: number;
  maximum_selections: number;
}>;
type ComponentRow = Readonly<{
  bundle_id: string; group_id: string | null; product_id: number; quantity: number; is_default: number;
}>;
type AvailableRow = Readonly<{ product_id: number; available: number }>;

export type BundleApplication = Readonly<{
  bundleId: string;
  bundleVersion: number;
  bundleProductId: number;
  unitPriceCents: number;
  quantity: number;
  snapshot: BundleResolution['snapshot'];
  components: readonly Readonly<{ productId: number; quantityPerBundle: number }>[];
}>;

export type BundleInventoryItem = Readonly<{
  order_item_id: number; product_id: number; variant_id: number; is_default: boolean;
  name_snapshot: string; unit_price_cents: number; qty: number;
}>;

function definitions(rows: readonly BundleRow[], groups: readonly GroupRow[], components: readonly ComponentRow[]) {
  return Object.freeze(rows.map((row): BundleDefinition => Object.freeze({
    id: row.id, productId: row.product_id, label: row.label, kind: row.kind,
    state: row.state, version: row.version,
    components: row.kind === 'fixed'
      ? Object.freeze(components.filter((item) => item.bundle_id === row.id)
        .map((item) => Object.freeze({ productId: item.product_id, quantity: item.quantity })))
      : [],
    groups: row.kind === 'configurable'
      ? Object.freeze(groups.filter((group) => group.bundle_id === row.id).map((group) => Object.freeze({
        id: group.id, label: group.label, minimumSelections: group.minimum_selections,
        maximumSelections: group.maximum_selections,
        options: Object.freeze(components.filter((item) => item.bundle_id === row.id && item.group_id === group.id)
          .map((item) => Object.freeze({ productId: item.product_id, quantity: item.quantity,
            isDefault: item.is_default === 1 }))),
      })))
      : [],
  })));
}

export function createD1Bundles(db: D1Database) {
  async function list(state?: BundleDefinition['state']): Promise<readonly BundleDefinition[]> {
    const { results: rows } = await db.prepare(`SELECT id, product_id, label, kind, state, version
      FROM bundles ${state === undefined ? '' : 'WHERE state=?'} ORDER BY id`)
      .bind(...(state === undefined ? [] : [state])).all<BundleRow>();
    if (rows.length === 0) return [];
    const [groupResult, componentResult] = await Promise.all([
      db.prepare(`SELECT bundle_id, id, label, minimum_selections, maximum_selections
        FROM bundle_groups ORDER BY bundle_id, sort_order, id`).all<GroupRow>(),
      db.prepare(`SELECT bundle_id, group_id, product_id, quantity, is_default
        FROM bundle_components ORDER BY bundle_id, sort_order, product_id`).all<ComponentRow>(),
    ]);
    return definitions(rows, groupResult.results, componentResult.results);
  }

  async function availability(productIds: readonly number[]): Promise<ReadonlyMap<number, number>> {
    if (productIds.length === 0) return new Map();
    const { results } = await db.prepare(`SELECT pv.product_id,
      max(0, b.on_hand-b.reserved) AS available FROM product_variants pv
      JOIN inventory_balances b ON b.variant_id=pv.id
      WHERE pv.is_default=1 AND pv.status='active'
        AND pv.product_id IN (${productIds.map(() => '?').join(',')})`).bind(...productIds).all<AvailableRow>();
    return new Map(results.map((row) => [row.product_id, row.available]));
  }

  return Object.freeze({
    list,
    listActive: () => list('active'),

    async resolveForProduct(productId: number, selections: readonly BundleSelection[] = []): Promise<BundleResolution | null> {
      const bundle = (await list('active')).find((item) => item.productId === productId);
      if (!bundle) return null;
      const allProductIds = bundle.kind === 'fixed'
        ? bundle.components.map((item) => item.productId)
        : bundle.groups.flatMap((group) => group.options.map((item) => item.productId));
      return resolveBundle({ bundle, selections, availableByProduct: await availability(allProductIds) });
    },

    async productIdsBySlugs(slugs: readonly string[]): Promise<ReadonlyMap<string, number>> {
      if (slugs.length === 0) return new Map();
      const { results } = await db.prepare(`SELECT slug, id FROM products WHERE active=1
        AND slug IN (${slugs.map(() => '?').join(',')})`).bind(...slugs)
        .all<{ slug: string; id: number }>();
      return new Map(results.map((row) => [row.slug, row.id]));
    },

    applicationStatements(orderNumber: string, application: BundleApplication, appliedAt: string): readonly D1PreparedStatement[] {
      const componentStatements = application.components.map((component) => db.prepare(`
        INSERT INTO order_bundle_components (order_item_id, bundle_id, bundle_version,
          product_id, variant_id, quantity_per_bundle, name_snapshot, sku_snapshot)
        SELECT oi.id, ?, ?, component.id, variant.id, ?, component.name, variant.sku
        FROM orders o JOIN order_items oi ON oi.order_id=o.id AND oi.product_id=?
        JOIN products component ON component.id=?
        JOIN product_variants variant ON variant.product_id=component.id AND variant.is_default=1
        WHERE o.order_number=?`).bind(application.bundleId, application.bundleVersion,
        component.quantityPerBundle, application.bundleProductId, component.productId, orderNumber));
      return Object.freeze([...componentStatements, db.prepare(`INSERT INTO bundle_applications (
        id, bundle_id, bundle_version, order_id, order_item_id, unit_price_cents,
        quantity, snapshot_json, idempotency_key, applied_at
      ) SELECT ?, ?, ?, o.id, oi.id, ?, ?, ?, ?, ? FROM orders o
        JOIN order_items oi ON oi.order_id=o.id AND oi.product_id=? WHERE o.order_number=?`).bind(
        `bundle_app_${crypto.randomUUID()}`, application.bundleId, application.bundleVersion,
        application.unitPriceCents, application.quantity, JSON.stringify(application.snapshot),
        `bundle:${application.bundleId}:order:${orderNumber}:product:${application.bundleProductId}`,
        appliedAt, application.bundleProductId, orderNumber,
      )]);
    },

    async expandInventoryItems(orderId: number, items: readonly BundleInventoryItem[]): Promise<readonly BundleInventoryItem[]> {
      const { results } = await db.prepare(`SELECT oi.id AS order_item_id, component.product_id,
        component.variant_id, pv.is_default, component.name_snapshot,
        oi.unit_price_cents, coalesce(oi.current_qty,oi.qty)*component.quantity_per_bundle AS qty
        FROM order_items oi JOIN order_bundle_components component ON component.order_item_id=oi.id
        JOIN product_variants pv ON pv.id=component.variant_id WHERE oi.order_id=?
        ORDER BY oi.id, component.variant_id`).bind(orderId).all<{
          order_item_id: number; product_id: number; variant_id: number; is_default: number;
          name_snapshot: string; unit_price_cents: number; qty: number;
        }>();
      if (results.length === 0) return items;
      const bundledIds = new Set(results.map((row) => row.order_item_id));
      return Object.freeze([
        ...items.filter((item) => !bundledIds.has(item.order_item_id)),
        ...results.map((row) => Object.freeze({ ...row, is_default: row.is_default === 1 })),
      ]);
    },

    async expandRestockItems(
      orderId: number,
      items: readonly BundleInventoryItem[],
      quantities: ReadonlyMap<number, number>,
    ): Promise<readonly Readonly<{ item: BundleInventoryItem; quantity: number }>[]> {
      const { results } = await db.prepare(`SELECT oi.id AS order_item_id, component.product_id,
        component.variant_id, pv.is_default, component.name_snapshot, oi.unit_price_cents,
        component.quantity_per_bundle
        FROM order_items oi JOIN order_bundle_components component ON component.order_item_id=oi.id
        JOIN product_variants pv ON pv.id=component.variant_id WHERE oi.order_id=?
        ORDER BY oi.id, component.variant_id`).bind(orderId).all<{
          order_item_id: number; product_id: number; variant_id: number; is_default: number;
          name_snapshot: string; unit_price_cents: number; quantity_per_bundle: number;
        }>();
      const bundledIds = new Set(results.map((row) => row.order_item_id));
      return Object.freeze([
        ...items.filter((item) => !bundledIds.has(item.order_item_id)).map((item) => Object.freeze({
          item, quantity: quantities.get(item.order_item_id) ?? 0,
        })),
        ...results.map((row) => Object.freeze({
          item: Object.freeze({ ...row, is_default: row.is_default === 1, qty: row.quantity_per_bundle }),
          quantity: (quantities.get(row.order_item_id) ?? 0) * row.quantity_per_bundle,
        })),
      ]);
    },
  });
}
