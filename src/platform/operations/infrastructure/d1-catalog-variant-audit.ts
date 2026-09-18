/**
 * Unidades de trabajo auditadas para el editor de opciones y variantes R2.4.
 *
 * Cada batch empieza insertando la evidencia mediante un SELECT optimista. El
 * resto de sentencias solo progresa si esa fila existe; conflicto, constraint
 * o FK revierten el lote completo en D1.
 */

import { serializeAuditDiff, type AuditEntry } from '../../../shared-kernel/audit';

export type CatalogProductGuard = Readonly<{
  id: number;
  slug: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  active: number;
  default_variant_id: number;
  option_count: number;
  option_value_count: number;
  variant_count: number;
}>;

export type CatalogOptionGuard = Readonly<{
  id: number;
  product_id: number;
  name: string;
  position: number;
  value_count: number;
  variant_count: number;
}>;

export type CatalogOptionValueGuard = Readonly<{
  id: number;
  option_id: number;
  product_id: number;
  value: string;
  position: number;
  variant_count: number;
}>;

export type CatalogVariantGuard = Readonly<{
  id: number;
  product_id: number;
  sku: string;
  gtin: string | null;
  mpn: string | null;
  title: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  status: 'draft' | 'active' | 'archived';
  is_default: boolean;
  option_signature: string | null;
  option_value_ids: readonly number[];
  order_item_count: number;
}>;

export type CatalogVariantValues = Readonly<{
  sku: string;
  gtin: string | null;
  mpn: string | null;
  title: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  status: 'draft' | 'active' | 'archived';
  option_value_ids: readonly number[];
  option_signature: string;
}>;

export type CatalogAuditedOutcome = 'applied' | 'conflict';

function entryValues(entry: AuditEntry): readonly unknown[] {
  return [
    entry.audit_id,
    entry.occurred_at,
    entry.actor.kind,
    entry.actor.id,
    entry.actor.label ?? null,
    entry.action,
    entry.entity.type,
    entry.entity.id,
    entry.entity.reference ?? null,
    entry.correlation_id,
    entry.source_event_id,
    serializeAuditDiff(entry.diff),
    entry.occurred_at,
  ];
}

function auditInsert(db: D1Database, entry: AuditEntry, fromAndGuard: string, guard: readonly unknown[]) {
  return db.prepare(`
    INSERT INTO audit_log (
      audit_id, occurred_at, actor_kind, actor_id, actor_label, action,
      entity_type, entity_id, entity_reference, correlation_id,
      source_event_id, diff_json, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    ${fromAndGuard}
  `).bind(...entryValues(entry), ...guard);
}

function outcomeOf(results: readonly D1Result[], expectedChanges: readonly number[]): CatalogAuditedOutcome {
  const auditChanges = results[0]?.meta.changes ?? 0;
  const mutationChanges = results.slice(1).map((result) => result.meta.changes ?? 0);
  if (
    auditChanges === 1 && mutationChanges.length === expectedChanges.length &&
    mutationChanges.every((changes, index) => changes === expectedChanges[index])
  ) return 'applied';
  if (auditChanges === 0 && mutationChanges.every((changes) => changes === 0)) return 'conflict';
  throw new Error(
    `Unidad de catálogo inconsistente: audit=${auditChanges}, mutations=${mutationChanges.join(',')}, expected=${expectedChanges.join(',')}.`,
  );
}

function productAudit(
  db: D1Database,
  entry: AuditEntry,
  expected: CatalogProductGuard,
): D1PreparedStatement {
  return auditInsert(db, entry, `
    FROM products p
    WHERE p.id = ? AND p.slug = ? AND p.price_cents = ?
      AND p.compare_at_price_cents IS ? AND p.active = ?
      AND (SELECT id FROM product_variants WHERE product_id = p.id AND is_default = 1) = ?
      AND (SELECT count(*) FROM product_options WHERE product_id = p.id) = ?
      AND (
        SELECT count(*) FROM product_option_values pov
        JOIN product_options po ON po.id = pov.option_id
        WHERE po.product_id = p.id
      ) = ?
      AND (SELECT count(*) FROM product_variants WHERE product_id = p.id) = ?
  `, [
    expected.id,
    expected.slug,
    expected.price_cents,
    expected.compare_at_price_cents,
    expected.active,
    expected.default_variant_id,
    expected.option_count,
    expected.option_value_count,
    expected.variant_count,
  ]);
}

function mappingInsert(
  db: D1Database,
  auditId: string,
  variantId: number | null,
  variantSku: string | null,
  productId: number,
  optionValueId: number,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO product_variant_option_values (
      variant_id, product_id, option_id, option_value_id
    )
    SELECT
      COALESCE(?, (SELECT id FROM product_variants WHERE product_id = ? AND sku = ?)),
      ?,
      (
        SELECT po.id FROM product_option_values pov
        JOIN product_options po ON po.id = pov.option_id
        WHERE pov.id = ? AND po.product_id = ?
      ),
      (
        SELECT pov.id FROM product_option_values pov
        JOIN product_options po ON po.id = pov.option_id
        WHERE pov.id = ? AND po.product_id = ?
      )
    WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
  `).bind(
    variantId,
    productId,
    variantSku,
    productId,
    optionValueId,
    productId,
    optionValueId,
    productId,
    auditId,
  );
}

export function createD1CatalogVariantAuditWriter(db: D1Database) {
  return Object.freeze({
    async createOption(
      entry: AuditEntry,
      expected: CatalogProductGuard,
      input: Readonly<{ name: string; position: number }>,
    ): Promise<CatalogAuditedOutcome> {
      const audit = productAudit(db, entry, expected);
      const mutation = db.prepare(`
        INSERT INTO product_options (product_id, name, position)
        SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(expected.id, input.name, input.position, entry.audit_id);
      return outcomeOf(await db.batch([audit, mutation]), [1]);
    },

    async updateOption(
      entry: AuditEntry,
      expected: CatalogOptionGuard,
      name: string,
    ): Promise<CatalogAuditedOutcome> {
      const audit = auditInsert(db, entry, `
        FROM product_options
        WHERE id = ? AND product_id = ? AND name = ? AND position = ?
          AND (SELECT count(*) FROM product_option_values WHERE option_id = ?) = ?
          AND (SELECT count(*) FROM product_variant_option_values WHERE option_id = ?) = ?
      `, [
        expected.id, expected.product_id, expected.name, expected.position,
        expected.id, expected.value_count, expected.id, expected.variant_count,
      ]);
      const mutation = db.prepare(`
        UPDATE product_options SET name = ?, updated_at = datetime('now')
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(name, expected.id, entry.audit_id);
      return outcomeOf(await db.batch([audit, mutation]), [1]);
    },

    async deleteOption(entry: AuditEntry, expected: CatalogOptionGuard): Promise<CatalogAuditedOutcome> {
      const audit = auditInsert(db, entry, `
        FROM product_options
        WHERE id = ? AND product_id = ? AND name = ? AND position = ?
          AND (SELECT count(*) FROM product_option_values WHERE option_id = ?) = ?
          AND (SELECT count(*) FROM product_variant_option_values WHERE option_id = ?) = 0
      `, [
        expected.id, expected.product_id, expected.name, expected.position,
        expected.id, expected.value_count, expected.id,
      ]);
      const mutation = db.prepare(`
        DELETE FROM product_options
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(expected.id, entry.audit_id);
      return outcomeOf(await db.batch([audit, mutation]), [1]);
    },

    async createOptionValue(
      entry: AuditEntry,
      expected: CatalogOptionGuard,
      input: Readonly<{ value: string; position: number }>,
    ): Promise<CatalogAuditedOutcome> {
      const audit = auditInsert(db, entry, `
        FROM product_options
        WHERE id = ? AND product_id = ? AND name = ? AND position = ?
          AND (SELECT count(*) FROM product_option_values WHERE option_id = ?) = ?
          AND (SELECT count(*) FROM product_variant_option_values WHERE option_id = ?) = ?
      `, [
        expected.id, expected.product_id, expected.name, expected.position,
        expected.id, expected.value_count, expected.id, expected.variant_count,
      ]);
      const mutation = db.prepare(`
        INSERT INTO product_option_values (option_id, value, position)
        SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(expected.id, input.value, input.position, entry.audit_id);
      return outcomeOf(await db.batch([audit, mutation]), [1]);
    },

    async updateOptionValue(
      entry: AuditEntry,
      expected: CatalogOptionValueGuard,
      value: string,
    ): Promise<CatalogAuditedOutcome> {
      const audit = auditInsert(db, entry, `
        FROM product_option_values
        WHERE id = ? AND option_id = ? AND value = ? AND position = ?
          AND (SELECT count(*) FROM product_variant_option_values WHERE option_value_id = ?) = ?
      `, [
        expected.id, expected.option_id, expected.value, expected.position,
        expected.id, expected.variant_count,
      ]);
      const mutation = db.prepare(`
        UPDATE product_option_values SET value = ?, updated_at = datetime('now')
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(value, expected.id, entry.audit_id);
      return outcomeOf(await db.batch([audit, mutation]), [1]);
    },

    async deleteOptionValue(
      entry: AuditEntry,
      expected: CatalogOptionValueGuard,
    ): Promise<CatalogAuditedOutcome> {
      const audit = auditInsert(db, entry, `
        FROM product_option_values
        WHERE id = ? AND option_id = ? AND value = ? AND position = ?
          AND (SELECT count(*) FROM product_variant_option_values WHERE option_value_id = ?) = 0
      `, [expected.id, expected.option_id, expected.value, expected.position, expected.id]);
      const mutation = db.prepare(`
        DELETE FROM product_option_values
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(expected.id, entry.audit_id);
      return outcomeOf(await db.batch([audit, mutation]), [1]);
    },

    async createVariant(
      entry: AuditEntry,
      expected: CatalogProductGuard,
      input: CatalogVariantValues,
    ): Promise<CatalogAuditedOutcome> {
      const audit = productAudit(db, entry, expected);
      const insert = db.prepare(`
        INSERT INTO product_variants (
          product_id, sku, gtin, mpn, title, price_cents,
          compare_at_price_cents, status, is_default, option_signature
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, ?
        WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(
        expected.id,
        input.sku,
        input.gtin,
        input.mpn,
        input.title,
        input.price_cents,
        input.compare_at_price_cents,
        input.status,
        input.option_signature,
        entry.audit_id,
      );
      const mappings = input.option_value_ids.map((valueId) =>
        mappingInsert(db, entry.audit_id, null, input.sku, expected.id, valueId),
      );
      const openingBalance = db.prepare(`
        INSERT INTO inventory_balances (variant_id, on_hand, reserved, version, updated_at)
        SELECT pv.id, p.stock, 0, 1, ?
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        WHERE pv.product_id = ? AND pv.sku = ?
          AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(entry.occurred_at, expected.id, input.sku, entry.audit_id);
      const openingMovement = db.prepare(`
        INSERT INTO inventory_movements (
          variant_id, delta, reason, balance_after, version_after,
          actor_kind, actor_id, reference_type, reference_id,
          idempotency_key, correlation_id, occurred_at, created_at
        )
        SELECT b.variant_id, b.on_hand, 'legacy_opening_balance', b.on_hand, 1,
               'admin', 'admin-panel', 'product_variant', CAST(b.variant_id AS TEXT),
               'r2:inventory:opening:' || b.variant_id,
               'inventory:variant:' || b.variant_id, ?, ?
        FROM inventory_balances b
        JOIN product_variants pv ON pv.id = b.variant_id
        WHERE pv.product_id = ? AND pv.sku = ?
          AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(entry.occurred_at, entry.occurred_at, expected.id, input.sku, entry.audit_id);
      return outcomeOf(
        await db.batch([audit, insert, openingBalance, openingMovement, ...mappings]),
        [1, 1, 1, ...mappings.map(() => 1)],
      );
    },

    async updateVariant(
      entry: AuditEntry,
      product: CatalogProductGuard,
      expected: CatalogVariantGuard,
      input: CatalogVariantValues,
      makeDefault: boolean,
    ): Promise<CatalogAuditedOutcome> {
      const audit = auditInsert(db, entry, `
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        WHERE pv.id = ? AND pv.product_id = ? AND pv.sku = ?
          AND pv.gtin IS ? AND pv.mpn IS ? AND pv.title = ?
          AND pv.price_cents = ? AND pv.compare_at_price_cents IS ?
          AND pv.status = ? AND pv.is_default = ? AND pv.option_signature IS ?
          AND p.slug = ? AND p.price_cents = ? AND p.compare_at_price_cents IS ? AND p.active = ?
          AND (SELECT id FROM product_variants WHERE product_id = p.id AND is_default = 1) = ?
      `, [
        expected.id, expected.product_id, expected.sku, expected.gtin, expected.mpn,
        expected.title, expected.price_cents, expected.compare_at_price_cents,
        expected.status, expected.is_default ? 1 : 0, expected.option_signature,
        product.slug, product.price_cents, product.compare_at_price_cents,
        product.active, product.default_variant_id,
      ]);
      const statements: D1PreparedStatement[] = [audit];
      const expectedChanges: number[] = [];
      if (makeDefault && !expected.is_default) {
        statements.push(db.prepare(`
          UPDATE product_variants SET is_default = 0, updated_at = datetime('now')
          WHERE id = ? AND product_id = ? AND is_default = 1
            AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
        `).bind(product.default_variant_id, product.id, entry.audit_id));
        expectedChanges.push(1);
      }
      statements.push(db.prepare(`
        UPDATE product_variants
        SET sku = ?, gtin = ?, mpn = ?, title = ?, price_cents = ?,
            compare_at_price_cents = ?, status = ?, option_signature = ?,
            is_default = ?, updated_at = datetime('now')
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(
        input.sku,
        input.gtin,
        input.mpn,
        input.title,
        input.price_cents,
        input.compare_at_price_cents,
        input.status,
        input.option_signature,
        expected.is_default || makeDefault ? 1 : 0,
        expected.id,
        entry.audit_id,
      ));
      expectedChanges.push(1);
      if (expected.is_default || makeDefault) {
        statements.push(db.prepare(`
          UPDATE products
          SET price_cents = ?, compare_at_price_cents = ?, active = ?,
              stock = (SELECT on_hand FROM inventory_balances WHERE variant_id = ?)
          WHERE id = ? AND price_cents = ? AND compare_at_price_cents IS ? AND active = ?
            AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
        `).bind(
          input.price_cents,
          input.compare_at_price_cents,
          input.status === 'active' ? 1 : 0,
          expected.id,
          product.id,
          product.price_cents,
          product.compare_at_price_cents,
          product.active,
          entry.audit_id,
        ));
        expectedChanges.push(1);
      }
      statements.push(db.prepare(`
        DELETE FROM product_variant_option_values
        WHERE variant_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(expected.id, entry.audit_id));
      expectedChanges.push(expected.option_value_ids.length);
      for (const valueId of input.option_value_ids) {
        statements.push(mappingInsert(db, entry.audit_id, expected.id, null, expected.product_id, valueId));
        expectedChanges.push(1);
      }
      return outcomeOf(await db.batch(statements), expectedChanges);
    },

    async deleteVariant(
      entry: AuditEntry,
      expected: CatalogVariantGuard,
    ): Promise<CatalogAuditedOutcome> {
      const audit = auditInsert(db, entry, `
        FROM product_variants
        WHERE id = ? AND product_id = ? AND sku = ? AND gtin IS ? AND mpn IS ?
          AND title = ? AND price_cents = ? AND compare_at_price_cents IS ?
          AND status = ? AND is_default = 0 AND option_signature IS ?
          AND (SELECT count(*) FROM order_items WHERE variant_id = ?) = 0
      `, [
        expected.id, expected.product_id, expected.sku, expected.gtin, expected.mpn,
        expected.title, expected.price_cents, expected.compare_at_price_cents,
        expected.status, expected.option_signature, expected.id,
      ]);
      const mutation = db.prepare(`
        DELETE FROM product_variants
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(expected.id, entry.audit_id);
      return outcomeOf(await db.batch([audit, mutation]), [1]);
    },
  });
}

export type D1CatalogVariantAuditWriter = ReturnType<typeof createD1CatalogVariantAuditWriter>;
