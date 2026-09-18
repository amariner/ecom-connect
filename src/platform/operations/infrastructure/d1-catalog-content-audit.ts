/** Unidades atómicas y auditadas para media/atributos R2.5. */
import type { AuditEntry } from '../../../shared-kernel/audit';
import { serializeAuditDiff } from '../../../shared-kernel/audit';

type Outcome = 'applied' | 'conflict';

type MediaSnapshot = Readonly<{
  id: number; product_id: number; kind: 'image' | 'video'; source: string;
  alt_text: string; focal_x_bps: number; focal_y_bps: number; position: number;
  variant_ids: readonly number[]; updated_at: string;
}>;

type MediaValues = Readonly<{
  kind: 'image' | 'video'; source: string; alt_text: string;
  focal_x_bps: number; focal_y_bps: number; variant_ids: readonly number[];
}>;

type DefinitionSnapshot = Readonly<{
  id: number; collection: string; category: string; code: string; label: string;
  value_type: string; unit: string | null; constraints_json: string; position: number;
  active: number; value_count: number; updated_at: string;
}>;

type DefinitionValues = Readonly<{
  code: string; label: string; value_type: string; unit: string | null;
  constraints_json: string; active: number;
}>;

type AttributeValueSnapshot = Readonly<{
  id: number; product_id: number; variant_id: number | null; attribute_definition_id: number;
  value_text: string | null; value_number: number | null; value_boolean: number | null;
  value_reference: string | null; value_list_json: string | null; updated_at: string;
}>;

type AttributeStorage = Omit<AttributeValueSnapshot, 'id' | 'product_id' | 'variant_id' | 'attribute_definition_id' | 'updated_at'>;

function entryValues(entry: AuditEntry): readonly unknown[] {
  return [
    entry.audit_id, entry.occurred_at, entry.actor.kind, entry.actor.id,
    entry.actor.label ?? null, entry.action, entry.entity.type, entry.entity.id,
    entry.entity.reference ?? null, entry.correlation_id, entry.source_event_id,
    serializeAuditDiff(entry.diff), entry.occurred_at,
  ];
}

function auditInsert(db: D1Database, entry: AuditEntry, fromAndGuard: string, guard: readonly unknown[]) {
  return db.prepare(`
    INSERT INTO audit_log (
      audit_id, occurred_at, actor_kind, actor_id, actor_label, action,
      entity_type, entity_id, entity_reference, correlation_id,
      source_event_id, diff_json, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${fromAndGuard}
  `).bind(...entryValues(entry), ...guard);
}

function outcome(results: readonly D1Result[], expected: readonly number[]): Outcome {
  const changes = results.map((result) => result.meta.changes ?? 0);
  if (changes.length === expected.length + 1 && changes[0] === 1 && expected.every((value, index) => changes[index + 1] === value)) {
    return 'applied';
  }
  if (changes.every((value) => value === 0)) return 'conflict';
  throw new Error(`Unidad de contenido inconsistente: ${changes.join(',')} vs audit+${expected.join(',')}.`);
}

function syncLegacyImage(db: D1Database, productId: number, auditId: string) {
  return db.prepare(`
    UPDATE products
    SET image = COALESCE((
      SELECT source FROM product_media
      WHERE product_id = products.id AND kind = 'image'
      ORDER BY position, id LIMIT 1
    ), '')
    WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
  `).bind(productId, auditId);
}

function mediaMappings(
  db: D1Database,
  auditId: string,
  productId: number,
  mediaId: number | null,
  mediaPosition: number,
  variantIds: readonly number[],
) {
  return variantIds.map((variantId) => db.prepare(`
    INSERT INTO product_variant_media (variant_id, product_id, media_id, position)
    SELECT ?, ?, COALESCE(?, (
      SELECT id FROM product_media WHERE product_id = ? AND position = ?
    )), ?
    WHERE EXISTS (
      SELECT 1 FROM product_variants
      WHERE id = ? AND product_id = ?
    ) AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
  `).bind(
    variantId, productId, mediaId, productId, mediaPosition, mediaPosition,
    variantId, productId, auditId,
  ));
}

export function createD1CatalogContentAuditWriter(db: D1Database) {
  return Object.freeze({
    async createMedia(
      entry: AuditEntry,
      product: Readonly<{ id: number; slug: string; image: string; media_count: number }>,
      values: MediaValues,
    ): Promise<Outcome> {
      const position = product.media_count;
      const audit = auditInsert(db, entry, `
        FROM products p
        WHERE p.id = ? AND p.slug = ? AND p.image = ?
          AND (SELECT count(*) FROM product_media WHERE product_id = p.id) = ?
      `, [product.id, product.slug, product.image, product.media_count]);
      const insert = db.prepare(`
        INSERT INTO product_media (
          product_id, kind, source, alt_text, focal_x_bps, focal_y_bps, position
        ) SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(
        product.id, values.kind, values.source, values.alt_text,
        values.focal_x_bps, values.focal_y_bps, position, entry.audit_id,
      );
      const mappings = mediaMappings(db, entry.audit_id, product.id, null, position, values.variant_ids);
      const sync = syncLegacyImage(db, product.id, entry.audit_id);
      return outcome(await db.batch([audit, insert, ...mappings, sync]), [1, ...mappings.map(() => 1), 1]);
    },

    async updateMedia(entry: AuditEntry, before: MediaSnapshot, values: MediaValues): Promise<Outcome> {
      const audit = auditInsert(db, entry, `
        FROM product_media
        WHERE id = ? AND product_id = ? AND kind = ? AND source = ? AND alt_text = ?
          AND focal_x_bps = ? AND focal_y_bps = ? AND position = ? AND updated_at = ?
          AND (SELECT count(*) FROM product_variant_media WHERE media_id = ?) = ?
      `, [
        before.id, before.product_id, before.kind, before.source, before.alt_text,
        before.focal_x_bps, before.focal_y_bps, before.position, before.updated_at,
        before.id, before.variant_ids.length,
      ]);
      const update = db.prepare(`
        UPDATE product_media SET kind = ?, source = ?, alt_text = ?,
          focal_x_bps = ?, focal_y_bps = ?, updated_at = datetime('now')
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(
        values.kind, values.source, values.alt_text, values.focal_x_bps,
        values.focal_y_bps, before.id, entry.audit_id,
      );
      const clear = db.prepare(`
        DELETE FROM product_variant_media
        WHERE media_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(before.id, entry.audit_id);
      const mappings = mediaMappings(
        db, entry.audit_id, before.product_id, before.id, before.position, values.variant_ids,
      );
      const sync = syncLegacyImage(db, before.product_id, entry.audit_id);
      return outcome(
        await db.batch([audit, update, clear, ...mappings, sync]),
        [1, before.variant_ids.length, ...mappings.map(() => 1), 1],
      );
    },

    async reorderMedia(
      entry: AuditEntry,
      product: Readonly<{ id: number; slug: string }>,
      before: readonly MediaSnapshot[],
      orderedIds: readonly number[],
    ): Promise<Outcome> {
      const mappingCount = before.reduce((sum, media) => sum + media.variant_ids.length, 0);
      const audit = auditInsert(db, entry, `
        FROM products p
        WHERE p.id = ? AND p.slug = ?
          AND (
            SELECT json_group_array(id) FROM (
              SELECT id FROM product_media WHERE product_id = p.id ORDER BY position, id
            )
          ) = ?
      `, [product.id, product.slug, JSON.stringify(before.map((media) => media.id))]);
      const offsetMedia = db.prepare(`
        UPDATE product_media SET position = position + 100000
        WHERE product_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(product.id, entry.audit_id);
      const offsetMappings = db.prepare(`
        UPDATE product_variant_media SET position = position + 100000
        WHERE product_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(product.id, entry.audit_id);
      const positionUpdates = orderedIds.map((id, position) => db.prepare(`
        UPDATE product_media SET position = ?, updated_at = datetime('now')
        WHERE id = ? AND product_id = ?
          AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(position, id, product.id, entry.audit_id));
      const alignMappings = db.prepare(`
        UPDATE product_variant_media
        SET position = (SELECT pm.position FROM product_media pm WHERE pm.id = media_id)
        WHERE product_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(product.id, entry.audit_id);
      const sync = syncLegacyImage(db, product.id, entry.audit_id);
      return outcome(
        await db.batch([audit, offsetMedia, offsetMappings, ...positionUpdates, alignMappings, sync]),
        [before.length, mappingCount, ...orderedIds.map(() => 1), mappingCount, 1],
      );
    },

    async deleteMedia(
      entry: AuditEntry,
      before: MediaSnapshot,
      laterMediaCount: number,
      laterMappingCount: number,
    ): Promise<Outcome> {
      const audit = auditInsert(db, entry, `
        FROM product_media
        WHERE id = ? AND product_id = ? AND kind = ? AND source = ? AND position = ?
          AND updated_at = ?
      `, [before.id, before.product_id, before.kind, before.source, before.position, before.updated_at]);
      const remove = db.prepare(`
        DELETE FROM product_media
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(before.id, entry.audit_id);
      const offsetMedia = db.prepare(`
        UPDATE product_media SET position = position + 100000
        WHERE product_id = ? AND position > ?
          AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(before.product_id, before.position, entry.audit_id);
      const compactMedia = db.prepare(`
        UPDATE product_media SET position = position - 100001, updated_at = datetime('now')
        WHERE product_id = ? AND position > 100000
          AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(before.product_id, entry.audit_id);
      const offsetMappings = db.prepare(`
        UPDATE product_variant_media SET position = position + 100000
        WHERE product_id = ? AND position > ?
          AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(before.product_id, before.position, entry.audit_id);
      const compactMappings = db.prepare(`
        UPDATE product_variant_media
        SET position = (SELECT pm.position FROM product_media pm WHERE pm.id = media_id)
        WHERE product_id = ? AND position > 100000
          AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(before.product_id, entry.audit_id);
      const sync = syncLegacyImage(db, before.product_id, entry.audit_id);
      return outcome(
        await db.batch([audit, remove, offsetMappings, offsetMedia, compactMedia, compactMappings, sync]),
        [1, laterMappingCount, laterMediaCount, laterMediaCount, laterMappingCount, 1],
      );
    },

    async createDefinition(
      entry: AuditEntry,
      scope: Readonly<{ product_id: number; collection: string; category: string; count: number }>,
      values: DefinitionValues,
    ): Promise<Outcome> {
      const audit = auditInsert(db, entry, `
        FROM products p
        WHERE p.id = ? AND p.collection = ? AND p.category = ?
          AND (SELECT count(*) FROM attribute_definitions WHERE collection = ? AND category = ?) = ?
      `, [scope.product_id, scope.collection, scope.category, scope.collection, scope.category, scope.count]);
      const insert = db.prepare(`
        INSERT INTO attribute_definitions (
          collection, category, code, label, value_type, unit,
          constraints_json, position, active
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(
        scope.collection, scope.category, values.code, values.label, values.value_type,
        values.unit, values.constraints_json, scope.count, values.active, entry.audit_id,
      );
      return outcome(await db.batch([audit, insert]), [1]);
    },

    async updateDefinition(entry: AuditEntry, before: DefinitionSnapshot, values: DefinitionValues): Promise<Outcome> {
      const audit = auditInsert(db, entry, `
        FROM attribute_definitions
        WHERE id = ? AND collection = ? AND category = ? AND code = ? AND label = ?
          AND value_type = ? AND unit IS ? AND constraints_json = ? AND position = ?
          AND active = ? AND updated_at = ?
          AND (SELECT count(*) FROM product_attribute_values WHERE attribute_definition_id = ?) = ?
      `, [
        before.id, before.collection, before.category, before.code, before.label,
        before.value_type, before.unit, before.constraints_json, before.position,
        before.active, before.updated_at, before.id, before.value_count,
      ]);
      const update = db.prepare(`
        UPDATE attribute_definitions SET code = ?, label = ?, value_type = ?,
          unit = ?, constraints_json = ?, active = ?, updated_at = datetime('now')
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(
        values.code, values.label, values.value_type, values.unit,
        values.constraints_json, values.active, before.id, entry.audit_id,
      );
      return outcome(await db.batch([audit, update]), [1]);
    },

    async deleteDefinition(entry: AuditEntry, before: DefinitionSnapshot): Promise<Outcome> {
      const audit = auditInsert(db, entry, `
        FROM attribute_definitions
        WHERE id = ? AND updated_at = ?
          AND (SELECT count(*) FROM product_attribute_values WHERE attribute_definition_id = ?) = 0
      `, [before.id, before.updated_at, before.id]);
      const remove = db.prepare(`
        DELETE FROM attribute_definitions
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(before.id, entry.audit_id);
      return outcome(await db.batch([audit, remove]), [1]);
    },

    async createAttributeValue(
      entry: AuditEntry,
      scope: Readonly<{ product_id: number; variant_id: number | null; definition_id: number }>,
      values: AttributeStorage,
    ): Promise<Outcome> {
      const audit = auditInsert(db, entry, `
        WHERE EXISTS (SELECT 1 FROM products WHERE id = ?)
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM product_variants WHERE id = ? AND product_id = ?
          ))
          AND NOT EXISTS (
            SELECT 1 FROM product_attribute_values
            WHERE product_id = ? AND variant_id IS ? AND attribute_definition_id = ?
          )
      `, [
        scope.product_id, scope.variant_id, scope.variant_id, scope.product_id,
        scope.product_id, scope.variant_id, scope.definition_id,
      ]);
      const insert = db.prepare(`
        INSERT INTO product_attribute_values (
          product_id, variant_id, attribute_definition_id, value_text,
          value_number, value_boolean, value_reference, value_list_json
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(
        scope.product_id, scope.variant_id, scope.definition_id,
        values.value_text, values.value_number, values.value_boolean,
        values.value_reference, values.value_list_json, entry.audit_id,
      );
      return outcome(await db.batch([audit, insert]), [1]);
    },

    async updateAttributeValue(
      entry: AuditEntry,
      before: AttributeValueSnapshot,
      values: AttributeStorage,
    ): Promise<Outcome> {
      const audit = auditInsert(db, entry, `
        FROM product_attribute_values
        WHERE id = ? AND product_id = ? AND variant_id IS ?
          AND attribute_definition_id = ? AND value_text IS ? AND value_number IS ?
          AND value_boolean IS ? AND value_reference IS ? AND value_list_json IS ?
          AND updated_at = ?
      `, [
        before.id, before.product_id, before.variant_id, before.attribute_definition_id,
        before.value_text, before.value_number, before.value_boolean,
        before.value_reference, before.value_list_json, before.updated_at,
      ]);
      const update = db.prepare(`
        UPDATE product_attribute_values SET value_text = ?, value_number = ?,
          value_boolean = ?, value_reference = ?, value_list_json = ?,
          updated_at = datetime('now')
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(
        values.value_text, values.value_number, values.value_boolean,
        values.value_reference, values.value_list_json, before.id, entry.audit_id,
      );
      return outcome(await db.batch([audit, update]), [1]);
    },

    async deleteAttributeValue(entry: AuditEntry, before: AttributeValueSnapshot): Promise<Outcome> {
      const audit = auditInsert(db, entry, `
        FROM product_attribute_values WHERE id = ? AND updated_at = ?
      `, [before.id, before.updated_at]);
      const remove = db.prepare(`
        DELETE FROM product_attribute_values
        WHERE id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)
      `).bind(before.id, entry.audit_id);
      return outcome(await db.batch([audit, remove]), [1]);
    },
  });
}

export type D1CatalogContentAuditWriter = ReturnType<typeof createD1CatalogContentAuditWriter>;
