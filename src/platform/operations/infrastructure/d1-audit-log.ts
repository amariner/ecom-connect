/**
 * Unidad de trabajo D1 del audit log (R1.8).
 *
 * No ofrece lecturas ni export HTTP. Las escrituras de admin usan una guarda
 * optimista sobre el snapshot completo: si otra petición ganó antes, ni la
 * mutación ni su evidencia se insertan. D1 ejecuta cada par en una sola batch.
 */

import { serializeAuditDiff, type AuditDiff, type AuditEntry } from '../../../shared-kernel/audit';

export type AuditEventProjection = Readonly<{ action: string; diff: AuditDiff }>;

export type AuditedProductSnapshot = Readonly<{
  id: number;
  slug: string;
  name: string;
  price_cents: number;
  compare_at_price_cents: number | null;
  stock: number;
  category: string;
  active: number;
  default_variant_id: number | null;
  default_sku: string | null;
  default_gtin: string | null;
  default_mpn: string | null;
  default_variant_title: string | null;
  default_variant_status: 'draft' | 'active' | 'archived' | null;
  default_variant_price_cents: number | null;
  default_variant_compare_at_price_cents: number | null;
}>;

export type AuditedProductPatch = Readonly<{
  name?: string | undefined;
  price_cents?: number | undefined;
  stock?: number | undefined;
  active?: boolean | undefined;
  compare_at_price_cents?: number | null | undefined;
  sku?: string | undefined;
  gtin?: string | null | undefined;
  mpn?: string | null | undefined;
  variant_title?: string | undefined;
  variant_status?: 'draft' | 'active' | 'archived' | undefined;
}>;

export type AuditedShippingRateSnapshot = Readonly<{
  id: number;
  zone: string;
  label: string;
  price_cents: number;
  free_over_cents: number | null;
  active: number;
}>;

export type AuditedShippingRatePatch = Readonly<{
  price_cents?: number | undefined;
  free_over_cents?: number | null | undefined;
  active?: boolean | undefined;
}>;

export type AuditedMutationOutcome = 'applied' | 'conflict';

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

function outcomeOf(results: readonly D1Result[]): AuditedMutationOutcome {
  const auditChanges = results[0]?.meta.changes ?? 0;
  const mutationChanges = results.slice(1).map((result) => result.meta.changes ?? 0);
  if (auditChanges === 1 && mutationChanges.every((changes) => changes === 1)) return 'applied';
  if (auditChanges === 0 && mutationChanges.every((changes) => changes === 0)) return 'conflict';
  throw new Error(
    `Unidad de auditoría inconsistente: audit=${auditChanges}, mutations=${mutationChanges.join(',')}.`,
  );
}

export function createD1AuditLogWriter(db: D1Database) {
  return {
    /** Proyecta un hecho persistido: un reintento perdedor no crea evidencia duplicada. */
    eventStatement(sourceEventId: string, projection: AuditEventProjection): D1PreparedStatement {
      return db.prepare(`
        INSERT INTO audit_log (
          audit_id, occurred_at, actor_kind, actor_id, actor_label, action,
          entity_type, entity_id, entity_reference, correlation_id,
          source_event_id, diff_json, created_at
        )
        SELECT
          event_id, occurred_at, actor_kind, actor_id, actor_label, ?,
          entity_type, entity_id, entity_reference, correlation_id,
          event_id, ?, occurred_at
        FROM event_outbox_events
        WHERE event_id = ?
      `).bind(projection.action, serializeAuditDiff(projection.diff), sourceEventId);
    },

    async updateProduct(
      entry: AuditEntry,
      expected: AuditedProductSnapshot,
      patch: AuditedProductPatch,
      guardedStatements: readonly D1PreparedStatement[] = [],
    ): Promise<AuditedMutationOutcome> {
      const productSets: string[] = [];
      const productValues: unknown[] = [];
      const variantSets: string[] = [];
      const variantValues: unknown[] = [];
      if (patch.name !== undefined) { productSets.push('name = ?'); productValues.push(patch.name); }
      if (patch.price_cents !== undefined) {
        productSets.push('price_cents = ?'); productValues.push(patch.price_cents);
        variantSets.push('price_cents = ?'); variantValues.push(patch.price_cents);
      }
      if (patch.compare_at_price_cents !== undefined) {
        productSets.push('compare_at_price_cents = ?'); productValues.push(patch.compare_at_price_cents);
        variantSets.push('compare_at_price_cents = ?'); variantValues.push(patch.compare_at_price_cents);
      }
      // R2.7: el stock lo escribe el ledger y asigna después el espejo legacy.
      // La ruta sin sentencias extra se conserva para compatibilidad aislada.
      if (patch.stock !== undefined && guardedStatements.length === 0) {
        productSets.push('stock = ?'); productValues.push(patch.stock);
      }
      if (patch.active !== undefined) {
        productSets.push('active = ?'); productValues.push(patch.active ? 1 : 0);
        if (patch.variant_status === undefined) {
          variantSets.push('status = ?'); variantValues.push(patch.active ? 'active' : 'archived');
        }
      }
      if (patch.sku !== undefined) { variantSets.push('sku = ?'); variantValues.push(patch.sku); }
      if (patch.gtin !== undefined) { variantSets.push('gtin = ?'); variantValues.push(patch.gtin); }
      if (patch.mpn !== undefined) { variantSets.push('mpn = ?'); variantValues.push(patch.mpn); }
      if (patch.variant_title !== undefined) {
        variantSets.push('title = ?'); variantValues.push(patch.variant_title);
      }
      if (patch.variant_status !== undefined) {
        variantSets.push('status = ?'); variantValues.push(patch.variant_status);
        if (patch.active === undefined) {
          productSets.push('active = ?'); productValues.push(patch.variant_status === 'active' ? 1 : 0);
        }
      }
      if (variantSets.length > 0) variantSets.push("updated_at = datetime('now')");

      const guard = [
        expected.id, expected.slug, expected.name, expected.price_cents,
        expected.compare_at_price_cents,
        expected.stock, expected.category, expected.active, expected.default_variant_id,
        expected.default_sku, expected.default_gtin, expected.default_mpn,
        expected.default_variant_title, expected.default_variant_status,
        expected.default_variant_price_cents, expected.default_variant_compare_at_price_cents,
      ] as const;
      const audit = db.prepare(`
        INSERT INTO audit_log (
          audit_id, occurred_at, actor_kind, actor_id, actor_label, action,
          entity_type, entity_id, entity_reference, correlation_id,
          source_event_id, diff_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM products p
        LEFT JOIN product_variants pv ON pv.product_id = p.id AND pv.is_default = 1
        WHERE p.id = ? AND p.slug = ? AND p.name = ? AND p.price_cents = ?
          AND p.compare_at_price_cents IS ?
          AND p.stock = ? AND p.category = ? AND p.active = ?
          AND pv.id IS ? AND pv.sku IS ? AND pv.gtin IS ? AND pv.mpn IS ?
          AND pv.title IS ? AND pv.status IS ? AND pv.price_cents IS ?
          AND pv.compare_at_price_cents IS ?
      `).bind(...entryValues(entry), ...guard);
      const mutations: D1PreparedStatement[] = [];
      if (productSets.length > 0) {
        mutations.push(db.prepare(`
          UPDATE products SET ${productSets.join(', ')}
          WHERE id = ? AND slug = ? AND name = ? AND price_cents = ?
            AND compare_at_price_cents IS ? AND stock = ? AND category = ? AND active = ?
            AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
        `).bind(...productValues, ...guard.slice(0, 8), entry.audit_id));
      }
      if (variantSets.length > 0) {
        mutations.push(db.prepare(`
          UPDATE product_variants SET ${variantSets.join(', ')}
          WHERE id IS ? AND sku IS ? AND gtin IS ? AND mpn IS ?
            AND title IS ? AND status IS ? AND price_cents IS ?
            AND compare_at_price_cents IS ?
            AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
        `).bind(...variantValues, ...guard.slice(8), entry.audit_id));
      }
      return outcomeOf(await db.batch([audit, ...mutations, ...guardedStatements]));
    },

    async updateShippingRate(
      entry: AuditEntry,
      expected: AuditedShippingRateSnapshot,
      patch: AuditedShippingRatePatch,
    ): Promise<AuditedMutationOutcome> {
      const sets: string[] = [];
      const values: unknown[] = [];
      if (patch.price_cents !== undefined) { sets.push('price_cents = ?'); values.push(patch.price_cents); }
      if (patch.free_over_cents !== undefined) { sets.push('free_over_cents = ?'); values.push(patch.free_over_cents); }
      if (patch.active !== undefined) { sets.push('active = ?'); values.push(patch.active ? 1 : 0); }

      const guard = [
        expected.id, expected.zone, expected.label, expected.price_cents,
        expected.free_over_cents, expected.active,
      ] as const;
      const audit = db.prepare(`
        INSERT INTO audit_log (
          audit_id, occurred_at, actor_kind, actor_id, actor_label, action,
          entity_type, entity_id, entity_reference, correlation_id,
          source_event_id, diff_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM shipping_rates
        WHERE id = ? AND zone = ? AND label = ? AND price_cents = ?
          AND free_over_cents IS ? AND active = ?
      `).bind(...entryValues(entry), ...guard);
      const mutation = db.prepare(`
        UPDATE shipping_rates SET ${sets.join(', ')}
        WHERE id = ? AND zone = ? AND label = ? AND price_cents = ?
          AND free_over_cents IS ? AND active = ?
          AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(...values, ...guard, entry.audit_id);
      return outcomeOf(await db.batch([audit, mutation]));
    },
  };
}

export type D1AuditLogWriter = ReturnType<typeof createD1AuditLogWriter>;
