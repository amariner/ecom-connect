/**
 * Contrato puro del registro de auditoría (R1.8).
 *
 * El audit log conserva evidencia de mutaciones; no es un log de peticiones ni
 * un mecanismo de entrega. Solo acepta escalares pequeños y aplica una denylist
 * defensiva aunque cada caso de uso ya declare una allowlist de campos.
 */

import type { EventActor, EventEntity, EventIdentity } from './events.ts';

export const AUDIT_REDACTED = '[REDACTED]';
export const AUDIT_DIFF_MAX_BYTES = 4096;
export const AUDIT_DIFF_MAX_FIELDS = 50;
export const AUDIT_VALUE_MAX_LENGTH = 256;

export type AuditValue = string | number | boolean | null;
export type AuditChange = Readonly<{ before: AuditValue; after: AuditValue }>;
export type AuditDiff = Readonly<Record<string, AuditChange>>;

export type AuditEntry = Readonly<{
  audit_id: string;
  occurred_at: string;
  actor: EventActor;
  action: string;
  entity: EventEntity;
  correlation_id: string;
  source_event_id: string | null;
  diff: AuditDiff;
}>;

export type AuditEntryDraft = Readonly<{
  actor: EventActor;
  action: string;
  entity: EventEntity;
  correlation_id?: string;
  source_event_id?: string | null;
  diff: AuditDiff;
}>;

const ACTION_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const FIELD_PATTERN = /^[a-z][a-z0-9_]*$/;
const SENSITIVE_FIELD =
  /(?:^|_)(?:address|body|card|company|customer|email|html|intent|nif|password|phone|secret|session|token)(?:_|$)/i;

function auditValue(field: string, value: unknown): AuditValue {
  if (SENSITIVE_FIELD.test(field)) return AUDIT_REDACTED;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= AUDIT_VALUE_MAX_LENGTH) return value;
  return AUDIT_REDACTED;
}

/** Construye un diff exclusivamente con los campos autorizados por el caso de uso. */
export function createAuditDiff(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  allowedFields: readonly string[],
): AuditDiff {
  if (allowedFields.length > AUDIT_DIFF_MAX_FIELDS) throw new Error('El diff de auditoría supera el máximo de campos.');
  const diff: Record<string, AuditChange> = {};
  for (const field of allowedFields) {
    if (!FIELD_PATTERN.test(field)) throw new Error(`Campo de auditoría inválido: ${field}.`);
    if (Object.is(before[field], after[field])) continue;
    diff[field] = Object.freeze({
      before: auditValue(field, before[field] ?? null),
      after: auditValue(field, after[field] ?? null),
    });
  }
  const serialized = JSON.stringify(diff);
  if (new TextEncoder().encode(serialized).byteLength > AUDIT_DIFF_MAX_BYTES) {
    throw new Error('El diff de auditoría supera 4 KB.');
  }
  return Object.freeze(diff);
}

export function serializeAuditDiff(diff: AuditDiff): string {
  const serialized = JSON.stringify(diff);
  if (new TextEncoder().encode(serialized).byteLength > AUDIT_DIFF_MAX_BYTES) {
    throw new Error('El diff de auditoría supera 4 KB.');
  }
  return serialized;
}

export function createAuditEntry(identity: EventIdentity, draft: AuditEntryDraft): AuditEntry {
  if (!ACTION_PATTERN.test(draft.action)) throw new Error(`Acción de auditoría inválida: ${draft.action}.`);
  if (draft.actor.id.length === 0 || draft.actor.id.length > 100) throw new Error('Actor de auditoría inválido.');
  if (draft.entity.type.length === 0 || draft.entity.type.length > 80) throw new Error('Tipo de entidad inválido.');
  if (draft.entity.id.length === 0 || draft.entity.id.length > 100) throw new Error('Id de entidad inválido.');
  if (draft.entity.reference !== undefined && draft.entity.reference.length > 160) {
    throw new Error('Referencia de entidad demasiado larga.');
  }
  serializeAuditDiff(draft.diff);
  return Object.freeze({
    audit_id: identity.event_id,
    occurred_at: identity.occurred_at,
    actor: Object.freeze({ ...draft.actor }),
    action: draft.action,
    entity: Object.freeze({ ...draft.entity }),
    correlation_id: draft.correlation_id ?? identity.event_id,
    source_event_id: draft.source_event_id ?? null,
    diff: draft.diff,
  });
}
