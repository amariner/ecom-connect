import { createAuditDiff, createAuditEntry, serializeAuditDiff } from '../../../shared-kernel/audit';
import type { ReserveEventIdentity } from '../../../shared-kernel/events';
import { reservePlatformEventIdentity } from '../../../composition/event-context';

export type OrderNoteVisibility = 'internal' | 'customer';
export type OrderCollaborationOutcome = 'applied' | 'unchanged' | 'not-found' | 'conflict';
export type OrderNoteWrite = Readonly<{ body: string; visibility: OrderNoteVisibility }>;
export type OrderNoteUpdate = OrderNoteWrite & Readonly<{ expectedVersion: number }>;
export type OrderTagAction = 'assign' | 'remove';

type OrderReference = Readonly<{ id: number; order_number: string }>;
type NoteSnapshot = Readonly<{ id: string; order_id: number; visibility: OrderNoteVisibility; body: string; version: number }>;
const ADMIN_ACTOR = Object.freeze({ kind: 'admin', id: 'admin-panel', label: 'Panel de administración' } as const);

function auditValues(entry: ReturnType<typeof createAuditEntry>): readonly unknown[] {
  return [entry.audit_id, entry.occurred_at, entry.actor.kind, entry.actor.id,
    entry.actor.label ?? null, entry.action, entry.entity.type, entry.entity.id,
    entry.entity.reference ?? null, entry.correlation_id, entry.source_event_id,
    serializeAuditDiff(entry.diff), entry.occurred_at];
}

function auditInsert(db: D1Database, entry: ReturnType<typeof createAuditEntry>, guardSql: string, guard: readonly unknown[]) {
  return db.prepare(`INSERT INTO audit_log (
    audit_id, occurred_at, actor_kind, actor_id, actor_label, action,
    entity_type, entity_id, entity_reference, correlation_id,
    source_event_id, diff_json, created_at
  ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${guardSql}`).bind(...auditValues(entry), ...guard);
}

function batchOutcome(results: readonly D1Result[]): OrderCollaborationOutcome {
  const changes = results.map((result) => result.meta.changes ?? 0);
  if (changes.every((value) => value === 1)) return 'applied';
  if (changes.every((value) => value === 0)) return 'conflict';
  throw new Error(`Unidad colaborativa inconsistente: ${changes.join(',')}.`);
}

export function normalizeOrderTagSlug(label: string): string {
  return label.trim().normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
}

export function createD1OrderCollaboration(db: D1Database, reserveIdentity: ReserveEventIdentity = reservePlatformEventIdentity) {
  const findOrder = (id: number) => db.prepare('SELECT id, order_number FROM orders WHERE id = ?')
    .bind(id).first<OrderReference>();
  const findNote = (orderId: number, noteId: string) => db.prepare(
    'SELECT id, order_id, visibility, body, version FROM order_notes WHERE id = ? AND order_id = ?',
  ).bind(noteId, orderId).first<NoteSnapshot>();

  return Object.freeze({
    async createNote(orderId: number, write: OrderNoteWrite): Promise<OrderCollaborationOutcome> {
      const order = await findOrder(orderId);
      if (!order) return 'not-found';
      const identity = reserveIdentity();
      const noteId = identity.event_id;
      const entry = createAuditEntry(identity, {
        actor: ADMIN_ACTOR, action: 'orders.note_created',
        entity: { type: 'order_note', id: noteId, reference: order.order_number },
        diff: createAuditDiff(
          { visibility: null, version: null, content_changed: false },
          { visibility: write.visibility, version: 1, content_changed: true },
          ['visibility', 'version', 'content_changed'],
        ),
      });
      const audit = auditInsert(db, entry, 'FROM orders WHERE id = ? AND order_number = ?', [order.id, order.order_number]);
      const note = db.prepare(`INSERT INTO order_notes (
        id, order_id, visibility, body, version, actor_kind, actor_id,
        actor_label, created_at, updated_at
      ) SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)`)
        .bind(noteId, orderId, write.visibility, write.body, ADMIN_ACTOR.kind,
          ADMIN_ACTOR.id, ADMIN_ACTOR.label, identity.occurred_at, identity.occurred_at, entry.audit_id);
      const revision = db.prepare(`INSERT INTO order_note_revisions (
        id, note_id, order_id, version, visibility, body, actor_kind,
        actor_id, actor_label, created_at
      ) SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)`)
        .bind(`${noteId}:1`, noteId, orderId, write.visibility, write.body,
          ADMIN_ACTOR.kind, ADMIN_ACTOR.id, ADMIN_ACTOR.label, identity.occurred_at, entry.audit_id);
      return batchOutcome(await db.batch([audit, note, revision]));
    },

    async updateNote(orderId: number, noteId: string, write: OrderNoteUpdate): Promise<OrderCollaborationOutcome> {
      const before = await findNote(orderId, noteId);
      if (!before) return 'not-found';
      if (before.version !== write.expectedVersion) return 'conflict';
      if (before.body === write.body && before.visibility === write.visibility) return 'unchanged';
      const identity = reserveIdentity();
      const nextVersion = before.version + 1;
      const entry = createAuditEntry(identity, {
        actor: ADMIN_ACTOR, action: 'orders.note_updated', entity: { type: 'order_note', id: noteId },
        diff: createAuditDiff(
          { visibility: before.visibility, version: before.version, content_changed: false },
          { visibility: write.visibility, version: nextVersion, content_changed: before.body !== write.body },
          ['visibility', 'version', 'content_changed'],
        ),
      });
      const audit = auditInsert(db, entry, `FROM order_notes
        WHERE id = ? AND order_id = ? AND version = ? AND visibility = ? AND body = ?`,
        [noteId, orderId, before.version, before.visibility, before.body]);
      const note = db.prepare(`UPDATE order_notes SET body = ?, visibility = ?, version = ?,
        actor_kind = ?, actor_id = ?, actor_label = ?, updated_at = ?
        WHERE id = ? AND order_id = ? AND version = ?
          AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)`)
        .bind(write.body, write.visibility, nextVersion, ADMIN_ACTOR.kind, ADMIN_ACTOR.id,
          ADMIN_ACTOR.label, identity.occurred_at, noteId, orderId, before.version, entry.audit_id);
      const revision = db.prepare(`INSERT INTO order_note_revisions (
        id, note_id, order_id, version, visibility, body, actor_kind,
        actor_id, actor_label, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)`)
        .bind(`${noteId}:${nextVersion}`, noteId, orderId, nextVersion, write.visibility,
          write.body, ADMIN_ACTOR.kind, ADMIN_ACTOR.id, ADMIN_ACTOR.label,
          identity.occurred_at, entry.audit_id);
      return batchOutcome(await db.batch([audit, note, revision]));
    },

    async createTag(labelInput: string): Promise<OrderCollaborationOutcome> {
      const label = labelInput.trim();
      const slug = normalizeOrderTagSlug(label);
      if (!slug) return 'conflict';
      if (await db.prepare('SELECT id FROM order_tags WHERE slug = ?').bind(slug).first()) return 'unchanged';
      const identity = reserveIdentity();
      const entry = createAuditEntry(identity, {
        actor: ADMIN_ACTOR, action: 'orders.tag_created',
        entity: { type: 'order_tag', id: slug, reference: label },
        diff: createAuditDiff({ label: null, active: null }, { label, active: true }, ['label', 'active']),
      });
      const audit = auditInsert(db, entry, 'WHERE NOT EXISTS (SELECT 1 FROM order_tags WHERE slug = ?)', [slug]);
      const tag = db.prepare(`INSERT INTO order_tags (slug, label, active, created_at, updated_at)
        SELECT ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)`)
        .bind(slug, label, identity.occurred_at, identity.occurred_at, entry.audit_id);
      return batchOutcome(await db.batch([audit, tag]));
    },

    async changeTag(orderId: number, tagId: number, action: OrderTagAction): Promise<OrderCollaborationOutcome> {
      const order = await findOrder(orderId);
      if (!order) return 'not-found';
      const tag = await db.prepare('SELECT id, slug, label FROM order_tags WHERE id = ? AND active = 1')
        .bind(tagId).first<{ id: number; slug: string; label: string }>();
      if (!tag) return 'not-found';
      const assigned = Boolean(await db.prepare(
        'SELECT 1 AS present FROM order_tag_assignments WHERE order_id = ? AND tag_id = ?',
      ).bind(orderId, tagId).first());
      if ((action === 'assign' && assigned) || (action === 'remove' && !assigned)) return 'unchanged';
      const identity = reserveIdentity();
      const entry = createAuditEntry(identity, {
        actor: ADMIN_ACTOR, action: action === 'assign' ? 'orders.tag_assigned' : 'orders.tag_removed',
        entity: { type: 'order', id: String(orderId), reference: order.order_number },
        diff: createAuditDiff(
          { tag: action === 'remove' ? tag.slug : null },
          { tag: action === 'assign' ? tag.slug : null }, ['tag'],
        ),
      });
      const existence = action === 'assign' ? 'NOT EXISTS' : 'EXISTS';
      const audit = auditInsert(db, entry, `FROM orders o JOIN order_tags t ON t.id = ? AND t.active = 1
        WHERE o.id = ? AND ${existence} (
          SELECT 1 FROM order_tag_assignments a WHERE a.order_id = o.id AND a.tag_id = t.id
        )`, [tagId, orderId]);
      const assignment = action === 'assign'
        ? db.prepare(`INSERT INTO order_tag_assignments (
            order_id, tag_id, actor_kind, actor_id, actor_label, created_at
          ) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)`)
            .bind(orderId, tagId, ADMIN_ACTOR.kind, ADMIN_ACTOR.id, ADMIN_ACTOR.label, identity.occurred_at, entry.audit_id)
        : db.prepare(`DELETE FROM order_tag_assignments WHERE order_id = ? AND tag_id = ?
            AND EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)`)
            .bind(orderId, tagId, entry.audit_id);
      const event = db.prepare(`INSERT INTO order_tag_events (
        id, order_id, tag_id, action, tag_slug_snapshot, tag_label_snapshot,
        actor_kind, actor_id, actor_label, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)`)
        .bind(identity.event_id, orderId, tagId, action === 'assign' ? 'assigned' : 'removed',
          tag.slug, tag.label, ADMIN_ACTOR.kind, ADMIN_ACTOR.id, ADMIN_ACTOR.label,
          identity.occurred_at, entry.audit_id);
      return batchOutcome(await db.batch([audit, assignment, event]));
    },
  });
}
