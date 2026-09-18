import type {
  ProductAdminRepository,
  ProductAdminQuery,
  ProductAdminRow,
  AttributeDefinitionAdminRow,
  ProductOptionAdminRow,
  ProductOptionSnapshot,
  ProductOptionValueAdminRow,
  ProductOptionValueSnapshot,
  ProductAttributeValueAdminRow,
  ProductMediaAdminRow,
  ProductVariantAdminRow,
} from '../application/product-admin';

type OptionValueJoinRow = Readonly<{
  option_id: number;
  product_id: number;
  option_name: string;
  option_position: number;
  value_id: number | null;
  value: string | null;
  value_position: number | null;
}>;

type VariantValueJoinRow = Readonly<{
  id: number;
  product_id: number;
  sku: string;
  gtin: string | null;
  mpn: string | null;
  title: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  status: 'draft' | 'active' | 'archived';
  is_default: number;
  option_signature: string | null;
  option_value_id: number | null;
  order_item_count: number;
  inventory_on_hand: number;
  inventory_reserved: number;
  inventory_available: number;
  inventory_version: number;
  created_at: string;
  updated_at: string;
}>;

type MediaVariantJoinRow = Omit<ProductMediaAdminRow, 'variant_ids'> & Readonly<{
  variant_id: number | null;
}>;

function hydrateMedia(rows: readonly MediaVariantJoinRow[]): readonly ProductMediaAdminRow[] {
  const byId = new Map<number, MediaVariantJoinRow[]>();
  for (const row of rows) {
    const current = byId.get(row.id) ?? [];
    current.push(row);
    byId.set(row.id, current);
  }
  return [...byId.values()].map((mediaRows) => {
    const row = mediaRows[0]!;
    return Object.freeze({
      id: row.id,
      product_id: row.product_id,
      kind: row.kind,
      source: row.source,
      alt_text: row.alt_text,
      focal_x_bps: row.focal_x_bps,
      focal_y_bps: row.focal_y_bps,
      position: row.position,
      variant_ids: Object.freeze(mediaRows.flatMap((candidate) =>
        candidate.variant_id === null ? [] : [candidate.variant_id],
      ).toSorted((a, b) => a - b)),
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  });
}

const variantSelect = `
  SELECT pv.id, pv.product_id, pv.sku, pv.gtin, pv.mpn, pv.title,
         pv.price_cents, pv.compare_at_price_cents, pv.status, pv.is_default,
         pv.option_signature, pv.created_at, pv.updated_at,
         pvov.option_value_id,
         ib.on_hand AS inventory_on_hand,
         ib.reserved AS inventory_reserved,
         ib.on_hand - ib.reserved AS inventory_available,
         ib.version AS inventory_version,
         (SELECT count(*) FROM order_items oi WHERE oi.variant_id = pv.id) AS order_item_count
  FROM product_variants pv
  JOIN inventory_balances ib ON ib.variant_id = pv.id
  LEFT JOIN product_variant_option_values pvov ON pvov.variant_id = pv.id`;

function hydrateVariants(rows: readonly VariantValueJoinRow[]): readonly ProductVariantAdminRow[] {
  const byId = new Map<number, VariantValueJoinRow[]>();
  for (const row of rows) {
    const current = byId.get(row.id) ?? [];
    current.push(row);
    byId.set(row.id, current);
  }
  return [...byId.values()].map((variantRows) => {
    const row = variantRows[0]!;
    return Object.freeze({
      id: row.id,
      product_id: row.product_id,
      sku: row.sku,
      gtin: row.gtin,
      mpn: row.mpn,
      title: row.title,
      price_cents: row.price_cents,
      compare_at_price_cents: row.compare_at_price_cents,
      status: row.status,
      is_default: row.is_default === 1,
      option_signature: row.option_signature,
      option_value_ids: Object.freeze(variantRows.flatMap((candidate) =>
        candidate.option_value_id === null ? [] : [candidate.option_value_id],
      ).toSorted((a, b) => a - b)),
      order_item_count: row.order_item_count,
      inventory_on_hand: row.inventory_on_hand,
      inventory_reserved: row.inventory_reserved,
      inventory_available: row.inventory_available,
      inventory_version: row.inventory_version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  });
}

export function createD1ProductAdminRepository(db: D1Database): ProductAdminRepository {
  const select = `
    SELECT p.id, p.slug, p.name, p.image, p.price_cents, p.compare_at_price_cents,
           ib.on_hand AS stock, p.category, p.collection, p.active,
           pv.id AS default_variant_id, pv.sku AS default_sku,
           pv.gtin AS default_gtin, pv.mpn AS default_mpn,
           pv.title AS default_variant_title, pv.status AS default_variant_status,
           pv.price_cents AS default_variant_price_cents,
           pv.compare_at_price_cents AS default_variant_compare_at_price_cents,
           (SELECT count(*) FROM product_variants all_pv WHERE all_pv.product_id = p.id) AS variant_count
    FROM products p
    LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.is_default = 1
    LEFT JOIN inventory_balances ib ON ib.variant_id = pv.id`;
  return {
    async list() {
      const { results } = await db.prepare(
        `${select} ORDER BY p.category, p.name`,
      ).all<ProductAdminRow>();
      return results;
    },
    async search(query: ProductAdminQuery) {
      const clauses: string[] = [];
      const bindings: unknown[] = [];
      const search = query.search?.trim();
      if (search) {
        clauses.push("(p.name LIKE ? ESCAPE '\\' OR p.slug LIKE ? ESCAPE '\\' OR pv.sku LIKE ? ESCAPE '\\')");
        const pattern = `%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        bindings.push(pattern, pattern, pattern);
      }
      if (query.category) {
        clauses.push('p.category = ?');
        bindings.push(query.category);
      }
      if (query.status) {
        clauses.push(`p.active = ${query.status === 'active' ? 1 : 0}`);
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const [rows, count, categoryRows] = await Promise.all([
        db.prepare(`${select}${where} ORDER BY p.name, p.id LIMIT ? OFFSET ?`)
          .bind(...bindings, query.limit, query.offset ?? 0).all<ProductAdminRow>(),
        db.prepare(`SELECT count(*) AS n FROM products p
          LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.is_default = 1${where}`)
          .bind(...bindings).first<{ n: number }>(),
        db.prepare('SELECT DISTINCT category FROM products ORDER BY category').all<{ category: string }>(),
      ]);
      return Object.freeze({
        products: Object.freeze(rows.results),
        total: count?.n ?? 0,
        categories: Object.freeze(categoryRows.results.map((row) => row.category)),
      });
    },
    find(id) {
      return db.prepare(
        `${select} WHERE p.id = ?`,
      ).bind(id).first<ProductAdminRow>();
    },
    async details(id) {
      const product = await db.prepare(`${select} WHERE p.id = ?`).bind(id).first<ProductAdminRow>();
      if (!product) return null;
      const [optionResult, variantResult, mediaResult, definitionResult, attributeValueResult] = await Promise.all([
        db.prepare(`
          SELECT po.id AS option_id, po.product_id, po.name AS option_name,
                 po.position AS option_position, pov.id AS value_id,
                 pov.value, pov.position AS value_position
          FROM product_options po
          LEFT JOIN product_option_values pov ON pov.option_id = po.id
          WHERE po.product_id = ?
          ORDER BY po.position, po.id, pov.position, pov.id
        `).bind(id).all<OptionValueJoinRow>(),
        db.prepare(`
          ${variantSelect}
          WHERE pv.product_id = ?
          ORDER BY pv.is_default DESC, pv.id, pvov.option_id
        `).bind(id).all<VariantValueJoinRow>(),
        db.prepare(`
          SELECT pm.id, pm.product_id, pm.kind, pm.source, pm.alt_text,
                 pm.focal_x_bps, pm.focal_y_bps, pm.position,
                 pm.created_at, pm.updated_at, pvm.variant_id
          FROM product_media pm
          LEFT JOIN product_variant_media pvm ON pvm.media_id = pm.id
          WHERE pm.product_id = ?
          ORDER BY pm.position, pm.id, pvm.variant_id
        `).bind(id).all<MediaVariantJoinRow>(),
        db.prepare(`
          SELECT ad.id, ad.collection, ad.category, ad.code, ad.label,
                 ad.value_type, ad.unit, ad.constraints_json, ad.position,
                 ad.active, ad.created_at, ad.updated_at,
                 (SELECT count(*) FROM product_attribute_values pav
                  WHERE pav.attribute_definition_id = ad.id) AS value_count
          FROM attribute_definitions ad
          WHERE ad.collection = ?
            AND (ad.category = '' OR ad.category = ?)
          ORDER BY ad.category = '' DESC, ad.position, ad.id
        `).bind(product.collection, product.category).all<AttributeDefinitionAdminRow>(),
        db.prepare(`
          SELECT id, product_id, variant_id, attribute_definition_id,
                 value_text, value_number, value_boolean, value_reference,
                 value_list_json, created_at, updated_at
          FROM product_attribute_values
          WHERE product_id = ?
          ORDER BY attribute_definition_id, variant_id IS NOT NULL, variant_id, id
        `).bind(id).all<ProductAttributeValueAdminRow>(),
      ]);
      const options = new Map<number, ProductOptionAdminRow>();
      for (const row of optionResult.results) {
        const current = options.get(row.option_id) ?? Object.freeze({
          id: row.option_id,
          product_id: row.product_id,
          name: row.option_name,
          position: row.option_position,
          values: Object.freeze([]) as readonly ProductOptionValueAdminRow[],
        });
        const values = [...current.values];
        if (row.value_id !== null && row.value !== null && row.value_position !== null) {
          values.push(Object.freeze({
            id: row.value_id,
            option_id: row.option_id,
            value: row.value,
            position: row.value_position,
          }));
        }
        options.set(row.option_id, Object.freeze({ ...current, values: Object.freeze(values) }));
      }
      return Object.freeze({
        product,
        options: Object.freeze([...options.values()]),
        variants: Object.freeze(hydrateVariants(variantResult.results)),
        media: Object.freeze(hydrateMedia(mediaResult.results)),
        attribute_definitions: Object.freeze(definitionResult.results),
        attribute_values: Object.freeze(attributeValueResult.results),
      });
    },
    findOption(id) {
      return db.prepare(`
        SELECT po.id, po.product_id, p.slug AS product_slug, po.name, po.position,
               (SELECT count(*) FROM product_option_values pov WHERE pov.option_id = po.id) AS value_count,
               (SELECT count(*) FROM product_variant_option_values pvov WHERE pvov.option_id = po.id) AS variant_count
        FROM product_options po
        JOIN products p ON p.id = po.product_id
        WHERE po.id = ?
      `).bind(id).first<ProductOptionSnapshot>();
    },
    findOptionValue(id) {
      return db.prepare(`
        SELECT pov.id, pov.option_id, po.product_id, p.slug AS product_slug,
               pov.value, pov.position,
               (SELECT count(*) FROM product_variant_option_values pvov WHERE pvov.option_value_id = pov.id) AS variant_count
        FROM product_option_values pov
        JOIN product_options po ON po.id = pov.option_id
        JOIN products p ON p.id = po.product_id
        WHERE pov.id = ?
      `).bind(id).first<ProductOptionValueSnapshot>();
    },
    async findVariant(id) {
      const { results } = await db.prepare(`
        ${variantSelect}
        WHERE pv.id = ?
        ORDER BY pvov.option_id
      `).bind(id).all<VariantValueJoinRow>();
      return hydrateVariants(results)[0] ?? null;
    },
    async findMedia(id) {
      const { results } = await db.prepare(`
        SELECT pm.id, pm.product_id, pm.kind, pm.source, pm.alt_text,
               pm.focal_x_bps, pm.focal_y_bps, pm.position,
               pm.created_at, pm.updated_at, pvm.variant_id
        FROM product_media pm
        LEFT JOIN product_variant_media pvm ON pvm.media_id = pm.id
        WHERE pm.id = ?
        ORDER BY pvm.variant_id
      `).bind(id).all<MediaVariantJoinRow>();
      return hydrateMedia(results)[0] ?? null;
    },
    findAttributeDefinition(id) {
      return db.prepare(`
        SELECT ad.id, ad.collection, ad.category, ad.code, ad.label,
               ad.value_type, ad.unit, ad.constraints_json, ad.position,
               ad.active, ad.created_at, ad.updated_at,
               (SELECT count(*) FROM product_attribute_values pav
                WHERE pav.attribute_definition_id = ad.id) AS value_count
        FROM attribute_definitions ad WHERE ad.id = ?
      `).bind(id).first<AttributeDefinitionAdminRow>();
    },
    findAttributeValue(id) {
      return db.prepare(`
        SELECT id, product_id, variant_id, attribute_definition_id,
               value_text, value_number, value_boolean, value_reference,
               value_list_json, created_at, updated_at
        FROM product_attribute_values WHERE id = ?
      `).bind(id).first<ProductAttributeValueAdminRow>();
    },
  };
}
