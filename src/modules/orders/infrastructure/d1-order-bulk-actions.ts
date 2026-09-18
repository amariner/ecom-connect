import { createAuditDiff, createAuditEntry, serializeAuditDiff } from '../../../shared-kernel/audit';
import {
  ORDER_BULK_LIMITS,
  orderBulkRowIdempotencyKey,
  type OrderBulkAction,
  type OrderBulkActionType,
  type OrderBulkCandidate,
  type OrderBulkExecutionOutcome,
  type OrderBulkPreview,
  type OrderBulkPreviewReason,
} from '../domain/order-bulk-action';
import type { OrderHoldReasonCode } from '../domain/order-hold';

export type OrderBulkBatchStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors';
export type OrderBulkResultCode =
  | 'applied' | 'replayed_same_batch' | 'already_applied' | 'already_absent'
  | 'active_hold_same_reason' | 'status_not_supported' | 'order_not_found'
  | 'tag_not_found' | 'hold_due_elapsed' | 'precondition_changed'
  | 'retryable_failure' | 'permanent_failure';

export type OrderBulkBatchRecord = Readonly<{
  id: string;
  action_type: OrderBulkActionType;
  tag_id: number | null;
  hold_reason_code: OrderHoldReasonCode | null;
  hold_owner_kind: 'admin' | 'system' | null;
  hold_owner_id: string | null;
  hold_owner_label: string | null;
  hold_due_at: string | null;
  selection_fingerprint: `sha256:${string}`;
  preview_fingerprint: `sha256:${string}`;
  actor_kind: 'admin' | 'system';
  actor_id: string;
  actor_label: string | null;
  status: OrderBulkBatchStatus;
  execution_run_id: string | null;
  replay_count: number;
  observed_at: string;
  expires_at: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}>;

export type OrderBulkBatchRowRecord = Readonly<{
  batch_id: string;
  order_id: number;
  order_number: string | null;
  selection_position: number;
  observed_version: number | null;
  observed_status: OrderBulkCandidate['status'] | null;
  preview_eligibility: 'ready' | 'skipped';
  preview_reason: OrderBulkPreviewReason;
  outcome: OrderBulkExecutionOutcome;
  result_code: OrderBulkResultCode | null;
  evidence_type: 'order_tag_event' | 'order_hold' | null;
  evidence_id: string | null;
  idempotency_key: string;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

export type OrderBulkProgress = Readonly<{
  total: number;
  pending: number;
  applied: number;
  replayed: number;
  skipped: number;
  conflict: number;
  retryableFailure: number;
  permanentFailure: number;
  completed: number;
}>;

export type OrderBulkBatchView = Readonly<{
  batch: OrderBulkBatchRecord;
  action: OrderBulkAction;
  progress: OrderBulkProgress;
  rows: readonly OrderBulkBatchRowRecord[];
}>;

export type OrderBulkOutcomeInput = Readonly<{
  batchId: string;
  orderId: number;
  outcome: Exclude<OrderBulkExecutionOutcome, 'pending' | 'retryable_failure'>;
  resultCode: OrderBulkResultCode;
  now: string;
  evidence?: Readonly<{ type: 'order_tag_event' | 'order_hold'; id: string }>;
  guardSql?: string;
  guardValues?: readonly unknown[];
}>;

const ACTOR = Object.freeze({ kind: 'admin', id: 'admin-panel', label: 'Panel de administración' } as const);

function actionFromRecord(record: OrderBulkBatchRecord): OrderBulkAction {
  if (record.action_type === 'add_tag' || record.action_type === 'remove_tag') {
    if (record.tag_id === null) throw new Error('Lote de etiqueta incompleto.');
    return Object.freeze({ type: record.action_type, tagId: record.tag_id });
  }
  if (!record.hold_reason_code || !record.hold_owner_kind || !record.hold_owner_id ||
      !record.hold_owner_label || !record.hold_due_at) {
    throw new Error('Lote de hold incompleto.');
  }
  return Object.freeze({
    type: 'create_hold',
    reasonCode: record.hold_reason_code,
    owner: Object.freeze({ kind: record.hold_owner_kind, id: record.hold_owner_id }),
    dueAt: record.hold_due_at,
  });
}

function batchIdFor(preview: OrderBulkPreview): string {
  return `bulk_${preview.previewFingerprint.slice('sha256:'.length, 'sha256:'.length + 32)}`;
}

function auditValues(entry: ReturnType<typeof createAuditEntry>): readonly unknown[] {
  return [
    entry.audit_id, entry.occurred_at, entry.actor.kind, entry.actor.id,
    entry.actor.label ?? null, entry.action, entry.entity.type, entry.entity.id,
    entry.entity.reference ?? null, entry.correlation_id, entry.source_event_id,
    serializeAuditDiff(entry.diff), entry.occurred_at,
  ];
}

function chunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function progressFrom(row: Readonly<Record<string, number | null>>): OrderBulkProgress {
  const value = (key: string): number => Number(row[key] ?? 0);
  const total = value('total');
  const pending = value('pending') + value('retryable_failure');
  return Object.freeze({
    total,
    pending,
    applied: value('applied'),
    replayed: value('replayed'),
    skipped: value('skipped'),
    conflict: value('conflict'),
    retryableFailure: value('retryable_failure'),
    permanentFailure: value('permanent_failure'),
    completed: total - pending,
  });
}

export function createD1OrderBulkActions(db: D1Database) {
  const findBatch = (id: string) => db.prepare('SELECT * FROM order_bulk_batches WHERE id = ?')
    .bind(id).first<OrderBulkBatchRecord>();

  const progress = async (batchId: string): Promise<OrderBulkProgress> => {
    const row = await db.prepare(`SELECT count(*) AS total,
      sum(CASE WHEN outcome = 'pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN outcome = 'applied' THEN 1 ELSE 0 END) AS applied,
      sum(CASE WHEN outcome = 'replayed' THEN 1 ELSE 0 END) AS replayed,
      sum(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped,
      sum(CASE WHEN outcome = 'conflict' THEN 1 ELSE 0 END) AS conflict,
      sum(CASE WHEN outcome = 'retryable_failure' THEN 1 ELSE 0 END) AS retryable_failure,
      sum(CASE WHEN outcome = 'permanent_failure' THEN 1 ELSE 0 END) AS permanent_failure
      FROM order_bulk_batch_rows WHERE batch_id = ?`).bind(batchId)
      .first<Record<string, number | null>>();
    return progressFrom(row ?? {});
  };

  return Object.freeze({
    async candidates(orderIds: readonly number[]): Promise<readonly OrderBulkCandidate[]> {
      const candidates: OrderBulkCandidate[] = [];
      for (const group of chunks(orderIds, ORDER_BULK_LIMITS.executionChunkSize)) {
        if (group.length === 0) continue;
        const placeholders = group.map(() => '?').join(',');
        const result = await db.prepare(`SELECT
          o.id AS order_id, o.edit_version AS observed_version, o.status,
          COALESCE((SELECT group_concat(a.tag_id) FROM order_tag_assignments a
            WHERE a.order_id = o.id), '') AS tag_ids,
          COALESCE((SELECT group_concat(reason_code) FROM (
            SELECT DISTINCT h.reason_code FROM order_holds h
            WHERE h.order_id = o.id AND h.status = 'active' ORDER BY h.reason_code
          )), '') AS active_hold_reason_codes
          FROM orders o WHERE o.id IN (${placeholders}) ORDER BY o.id`)
          .bind(...group).all<{
            order_id: number; observed_version: number; status: OrderBulkCandidate['status'];
            tag_ids: string; active_hold_reason_codes: string;
          }>();
        candidates.push(...result.results.map((row) => Object.freeze({
          orderId: row.order_id,
          observedVersion: row.observed_version,
          status: row.status,
          tagIds: Object.freeze(row.tag_ids ? row.tag_ids.split(',').map(Number).toSorted((a, b) => a - b) : []),
          activeHoldReasonCodes: Object.freeze(row.active_hold_reason_codes
            ? row.active_hold_reason_codes.split(',') as OrderBulkCandidate['activeHoldReasonCodes']
            : []),
        })));
      }
      return Object.freeze(candidates.toSorted((a, b) => a.orderId - b.orderId));
    },

    async createBatch(preview: OrderBulkPreview, createdAt: string): Promise<Readonly<{
      batch: OrderBulkBatchRecord;
      created: boolean;
    }>> {
      const id = batchIdFor(preview);
      const action = preview.action;
      const completed = preview.counts.ready === 0;
      const audit = createAuditEntry({ event_id: id, occurred_at: createdAt }, {
        actor: ACTOR,
        action: 'orders.bulk_created',
        entity: { type: 'order_bulk_batch', id },
        correlation_id: id,
        diff: createAuditDiff(
          { action_type: null, total: null, ready: null },
          { action_type: action.type, total: preview.counts.total, ready: preview.counts.ready },
          ['action_type', 'total', 'ready'],
        ),
      });
      const batch = db.prepare(`INSERT INTO order_bulk_batches (
        id, action_type, tag_id, hold_reason_code, hold_owner_kind,
        hold_owner_id, hold_owner_label, hold_due_at,
        selection_fingerprint, preview_fingerprint,
        actor_kind, actor_id, actor_label, status,
        observed_at, expires_at, created_at, completed_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM order_bulk_batches WHERE preview_fingerprint = ?)`)
        .bind(
          id, action.type,
          action.type === 'create_hold' ? null : action.tagId,
          action.type === 'create_hold' ? action.reasonCode : null,
          action.type === 'create_hold' ? action.owner.kind : null,
          action.type === 'create_hold' ? action.owner.id : null,
          action.type === 'create_hold' ? action.owner.id : null,
          action.type === 'create_hold' ? action.dueAt : null,
          preview.selectionFingerprint, preview.previewFingerprint,
          ACTOR.kind, ACTOR.id, ACTOR.label, completed ? 'completed' : 'pending',
          preview.observedAt, preview.expiresAt, createdAt, completed ? createdAt : null, createdAt,
          preview.previewFingerprint,
        );
      const auditInsert = db.prepare(`INSERT INTO audit_log (
        audit_id, occurred_at, actor_kind, actor_id, actor_label, action,
        entity_type, entity_id, entity_reference, correlation_id,
        source_event_id, diff_json, created_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM order_bulk_batches WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE audit_id = ?)`)
        .bind(...auditValues(audit), id, id);
      const rowsJson = JSON.stringify(preview.rows.map((row, index) => ({
        order_id: row.orderId,
        selection_position: index + 1,
        observed_version: row.observedVersion,
        observed_status: row.status,
        preview_eligibility: row.eligibility,
        preview_reason: row.reason,
        outcome: row.eligibility === 'ready' ? 'pending' : 'skipped',
        result_code: row.eligibility === 'ready' ? null : row.reason,
        idempotency_key: orderBulkRowIdempotencyKey(id, row.orderId, action.type),
      })));
      const rows = db.prepare(`INSERT INTO order_bulk_batch_rows (
        batch_id, order_id, selection_position, observed_version, observed_status,
        preview_eligibility, preview_reason, outcome, result_code,
        idempotency_key, created_at, updated_at, completed_at
      ) SELECT ?,
        CAST(json_extract(value, '$.order_id') AS INTEGER),
        CAST(json_extract(value, '$.selection_position') AS INTEGER),
        CAST(json_extract(value, '$.observed_version') AS INTEGER),
        json_extract(value, '$.observed_status'),
        json_extract(value, '$.preview_eligibility'),
        json_extract(value, '$.preview_reason'),
        json_extract(value, '$.outcome'),
        json_extract(value, '$.result_code'),
        json_extract(value, '$.idempotency_key'), ?, ?,
        CASE WHEN json_extract(value, '$.outcome') = 'skipped' THEN ? ELSE NULL END
      FROM json_each(?)
      WHERE EXISTS (SELECT 1 FROM order_bulk_batches WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM order_bulk_batch_rows WHERE batch_id = ?)`)
        .bind(id, createdAt, createdAt, createdAt, rowsJson, id, id);
      const results = await db.batch([batch, auditInsert, rows]);
      const created = (results[0]?.meta.changes ?? 0) === 1;
      const stored = await findBatch(id);
      if (!stored || stored.preview_fingerprint !== preview.previewFingerprint) {
        throw new Error('No se pudo congelar el lote masivo.');
      }
      const storedRows = Number((await db.prepare(`SELECT count(*) AS n FROM order_bulk_batch_rows
        WHERE batch_id = ?`).bind(id).first<{ n: number }>())?.n ?? 0);
      if (storedRows !== preview.rows.length) throw new Error('La selección masiva quedó incompleta.');
      return Object.freeze({ batch: stored, created });
    },

    findBatch,

    async view(batchId: string): Promise<OrderBulkBatchView | null> {
      const batch = await findBatch(batchId);
      if (!batch) return null;
      const rows = (await db.prepare(`SELECT r.*, o.order_number
        FROM order_bulk_batch_rows r LEFT JOIN orders o ON o.id = r.order_id
        WHERE r.batch_id = ? ORDER BY r.selection_position`).bind(batchId)
        .all<OrderBulkBatchRowRecord>()).results;
      return Object.freeze({ batch, action: actionFromRecord(batch), progress: await progress(batchId), rows: Object.freeze(rows) });
    },

    progress,

    async claim(batchId: string, runId: string, now: string): Promise<boolean> {
      const result = await db.prepare(`UPDATE order_bulk_batches SET
        status = 'running', execution_run_id = ?, started_at = COALESCE(started_at, ?),
        completed_at = NULL, updated_at = ?
        WHERE id = ? AND (
          (status = 'pending' AND execution_run_id IS NULL)
          OR (status = 'running' AND execution_run_id = ?)
        )`).bind(runId, now, now, batchId, runId).run();
      return result.meta.changes === 1;
    },

    async pendingRows(batchId: string): Promise<readonly OrderBulkBatchRowRecord[]> {
      return Object.freeze((await db.prepare(`SELECT r.*, o.order_number
        FROM order_bulk_batch_rows r LEFT JOIN orders o ON o.id = r.order_id
        WHERE r.batch_id = ? AND r.outcome IN ('pending', 'retryable_failure')
        ORDER BY r.selection_position LIMIT ?`).bind(batchId, ORDER_BULK_LIMITS.executionChunkSize)
        .all<OrderBulkBatchRowRecord>()).results);
    },

    outcomeStatement(input: OrderBulkOutcomeInput): D1PreparedStatement {
      return db.prepare(`UPDATE order_bulk_batch_rows SET outcome = ?, result_code = ?,
        evidence_type = ?, evidence_id = ?, attempt_count = attempt_count + 1,
        updated_at = ?, completed_at = ?
        WHERE batch_id = ? AND order_id = ?
          AND outcome IN ('pending', 'retryable_failure') ${input.guardSql ?? ''}`)
        .bind(
          input.outcome, input.resultCode, input.evidence?.type ?? null,
          input.evidence?.id ?? null, input.now, input.now,
          input.batchId, input.orderId, ...(input.guardValues ?? []),
        );
    },

    async markOutcome(input: OrderBulkOutcomeInput): Promise<boolean> {
      const result = await db.prepare(`UPDATE order_bulk_batch_rows SET outcome = ?, result_code = ?,
        evidence_type = ?, evidence_id = ?, attempt_count = attempt_count + 1,
        updated_at = ?, completed_at = ?
        WHERE batch_id = ? AND order_id = ?
          AND outcome IN ('pending', 'retryable_failure') ${input.guardSql ?? ''}`)
        .bind(
          input.outcome, input.resultCode, input.evidence?.type ?? null,
          input.evidence?.id ?? null, input.now, input.now,
          input.batchId, input.orderId, ...(input.guardValues ?? []),
        ).run();
      return result.meta.changes === 1;
    },

    async markFailure(batchId: string, orderId: number, now: string): Promise<void> {
      await db.prepare(`UPDATE order_bulk_batch_rows SET
        outcome = CASE WHEN attempt_count + 1 >= 5 THEN 'permanent_failure' ELSE 'retryable_failure' END,
        result_code = CASE WHEN attempt_count + 1 >= 5 THEN 'permanent_failure' ELSE 'retryable_failure' END,
        evidence_type = NULL, evidence_id = NULL, attempt_count = attempt_count + 1,
        updated_at = ?, completed_at = CASE WHEN attempt_count + 1 >= 5 THEN ? ELSE NULL END
        WHERE batch_id = ? AND order_id = ? AND outcome IN ('pending', 'retryable_failure')`)
        .bind(now, now, batchId, orderId).run();
    },

    async finish(batchId: string, runId: string, now: string): Promise<OrderBulkProgress> {
      const current = await progress(batchId);
      const hasErrors = current.conflict + current.retryableFailure + current.permanentFailure > 0;
      const result = await db.prepare(`UPDATE order_bulk_batches SET status = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND execution_run_id = ?`)
        .bind(hasErrors ? 'completed_with_errors' : 'completed', now, now, batchId, runId).run();
      if (result.meta.changes !== 1) throw new Error('bulk-batch-lost-claim');
      return current;
    },

    async prepareReplay(batchId: string, now: string): Promise<boolean> {
      const result = await db.prepare(`UPDATE order_bulk_batches SET
        status = 'pending', execution_run_id = NULL, replay_count = replay_count + 1,
        completed_at = NULL, updated_at = ?
        WHERE id = ? AND replay_count < 20
          AND status = 'completed_with_errors'
          AND EXISTS (SELECT 1 FROM order_bulk_batch_rows
            WHERE batch_id = ? AND outcome = 'retryable_failure')`)
        .bind(now, batchId, batchId).run();
      return result.meta.changes === 1;
    },

    async purgeTerminal(cutoff: string, limit = 100): Promise<number> {
      const result = await db.prepare(`DELETE FROM order_bulk_batches WHERE id IN (
        SELECT id FROM order_bulk_batches
        WHERE status IN ('completed', 'completed_with_errors') AND completed_at < ?
        ORDER BY completed_at, id LIMIT ?
      )`).bind(cutoff, limit).run();
      return result.meta.changes;
    },
  });
}

export type D1OrderBulkActions = ReturnType<typeof createD1OrderBulkActions>;
