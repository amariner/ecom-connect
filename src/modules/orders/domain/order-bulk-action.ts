import type { OrderHoldReasonCode } from './order-hold.ts';

export const ORDER_BULK_LIMITS = Object.freeze({
  maxOrders: 500,
  maxPreviewLifetimeSeconds: 15 * 60,
  executionChunkSize: 25,
});

export const ORDER_BULK_ACTION_TYPES = ['add_tag', 'remove_tag', 'create_hold'] as const;
export type OrderBulkActionType = (typeof ORDER_BULK_ACTION_TYPES)[number];

export type OrderBulkAction = Readonly<
  | { type: 'add_tag'; tagId: number }
  | { type: 'remove_tag'; tagId: number }
  | {
    type: 'create_hold';
    reasonCode: OrderHoldReasonCode;
    owner: Readonly<{ kind: 'admin' | 'system'; id: string }>;
    dueAt: string;
  }
>;

export type OrderBulkOrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled';

export type OrderBulkCandidate = Readonly<{
  orderId: number;
  observedVersion: number;
  status: OrderBulkOrderStatus;
  tagIds: readonly number[];
  activeHoldReasonCodes: readonly OrderHoldReasonCode[];
}>;

export const ORDER_BULK_PREVIEW_REASONS = [
  'ready',
  'order_not_found',
  'already_applied',
  'already_absent',
  'active_hold_same_reason',
  'status_not_supported',
] as const;
export type OrderBulkPreviewReason = (typeof ORDER_BULK_PREVIEW_REASONS)[number];

export type OrderBulkPreviewRow = Readonly<{
  orderId: number;
  observedVersion: number | null;
  status: OrderBulkOrderStatus | null;
  eligibility: 'ready' | 'skipped';
  reason: OrderBulkPreviewReason;
}>;

export type OrderBulkPreview = Readonly<{
  action: OrderBulkAction;
  observedAt: string;
  expiresAt: string;
  selectionFingerprint: `sha256:${string}`;
  previewFingerprint: `sha256:${string}`;
  rows: readonly OrderBulkPreviewRow[];
  counts: Readonly<{ total: number; ready: number; skipped: number }>;
}>;

export type VerifiedOrderBulkPreview = OrderBulkPreview;

export const ORDER_BULK_EXECUTION_OUTCOMES = [
  'pending',
  'applied',
  'replayed',
  'skipped',
  'conflict',
  'retryable_failure',
  'permanent_failure',
] as const;
export type OrderBulkExecutionOutcome = (typeof ORDER_BULK_EXECUTION_OUTCOMES)[number];

export type OrderBulkExecutionRow = Readonly<{
  orderId: number;
  outcome: OrderBulkExecutionOutcome;
}>;

const ORDER_STATUSES: readonly OrderBulkOrderStatus[] = [
  'pending', 'paid', 'shipped', 'delivered', 'cancelled',
];
const HOLDABLE_ORDER_STATUSES: readonly OrderBulkOrderStatus[] = ['pending', 'paid', 'shipped'];
const HOLD_REASONS: readonly OrderHoldReasonCode[] = [
  'payment_review', 'inventory_issue', 'address_issue', 'customer_request',
  'fulfillment_issue', 'risk_review', 'other',
];

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} debe ser un entero positivo`);
  return value;
}

function timestamp(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} debe ser un instante ISO UTC`);
  }
  return value;
}

function identifier(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || !/^[A-Za-z0-9:_-]+$/.test(normalized)) {
    throw new Error(`${field} no es un identificador técnico válido`);
  }
  return normalized;
}

function uniquePositiveIntegers(values: readonly number[], field: string): readonly number[] {
  const normalized = values.map((value) => positiveInteger(value, field)).toSorted((a, b) => a - b);
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} contiene duplicados`);
  return Object.freeze(normalized);
}

function normalizedAction(action: OrderBulkAction, observedAt: string): OrderBulkAction {
  if (action.type === 'add_tag' || action.type === 'remove_tag') {
    return Object.freeze({ type: action.type, tagId: positiveInteger(action.tagId, 'action.tagId') });
  }
  if (action.type !== 'create_hold') throw new Error('action.type no es válido');
  if (!HOLD_REASONS.includes(action.reasonCode)) throw new Error('action.reasonCode no es válido');
  if (action.owner.kind !== 'admin' && action.owner.kind !== 'system') {
    throw new Error('action.owner.kind no es válido');
  }
  const dueAt = timestamp(action.dueAt, 'action.dueAt');
  if (Date.parse(dueAt) <= Date.parse(observedAt)) throw new Error('action.dueAt debe ser futuro');
  return Object.freeze({
    type: action.type,
    reasonCode: action.reasonCode,
    owner: Object.freeze({
      kind: action.owner.kind,
      id: identifier(action.owner.id, 'action.owner.id', 80),
    }),
    dueAt,
  });
}

function normalizedCandidate(candidate: OrderBulkCandidate): OrderBulkCandidate {
  const orderId = positiveInteger(candidate.orderId, 'candidate.orderId');
  const observedVersion = positiveInteger(candidate.observedVersion, 'candidate.observedVersion');
  if (!ORDER_STATUSES.includes(candidate.status)) throw new Error('candidate.status no es válido');
  const activeHoldReasonCodes = [...candidate.activeHoldReasonCodes].toSorted();
  if (activeHoldReasonCodes.some((reason) => !HOLD_REASONS.includes(reason))) {
    throw new Error('candidate.activeHoldReasonCodes contiene un motivo no válido');
  }
  if (new Set(activeHoldReasonCodes).size !== activeHoldReasonCodes.length) {
    throw new Error('candidate.activeHoldReasonCodes contiene duplicados');
  }
  return Object.freeze({
    orderId,
    observedVersion,
    status: candidate.status,
    tagIds: uniquePositiveIntegers(candidate.tagIds, 'candidate.tagIds'),
    activeHoldReasonCodes: Object.freeze(activeHoldReasonCodes),
  });
}

function previewRow(orderId: number, candidate: OrderBulkCandidate | undefined, action: OrderBulkAction): OrderBulkPreviewRow {
  if (!candidate) {
    return Object.freeze({ orderId, observedVersion: null, status: null, eligibility: 'skipped', reason: 'order_not_found' });
  }
  if (action.type === 'add_tag' && candidate.tagIds.includes(action.tagId)) {
    return Object.freeze({ orderId, observedVersion: candidate.observedVersion, status: candidate.status, eligibility: 'skipped', reason: 'already_applied' });
  }
  if (action.type === 'remove_tag' && !candidate.tagIds.includes(action.tagId)) {
    return Object.freeze({ orderId, observedVersion: candidate.observedVersion, status: candidate.status, eligibility: 'skipped', reason: 'already_absent' });
  }
  if (action.type === 'create_hold') {
    if (!HOLDABLE_ORDER_STATUSES.includes(candidate.status)) {
      return Object.freeze({ orderId, observedVersion: candidate.observedVersion, status: candidate.status, eligibility: 'skipped', reason: 'status_not_supported' });
    }
    if (candidate.activeHoldReasonCodes.includes(action.reasonCode)) {
      return Object.freeze({ orderId, observedVersion: candidate.observedVersion, status: candidate.status, eligibility: 'skipped', reason: 'active_hold_same_reason' });
    }
  }
  return Object.freeze({ orderId, observedVersion: candidate.observedVersion, status: candidate.status, eligibility: 'ready', reason: 'ready' });
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

function previewFingerprintInput(preview: Pick<
  OrderBulkPreview,
  'selectionFingerprint' | 'action' | 'observedAt' | 'expiresAt' | 'rows'
>): string {
  return JSON.stringify({
    version: 1,
    selectionFingerprint: preview.selectionFingerprint,
    action: preview.action,
    observedAt: preview.observedAt,
    expiresAt: preview.expiresAt,
    rows: preview.rows,
  });
}

export async function createOrderBulkPreview(input: Readonly<{
  orderIds: readonly number[];
  candidates: readonly OrderBulkCandidate[];
  action: OrderBulkAction;
  observedAt: string;
  expiresAt: string;
}>): Promise<OrderBulkPreview> {
  const orderIds = uniquePositiveIntegers(input.orderIds, 'orderIds');
  if (orderIds.length === 0 || orderIds.length > ORDER_BULK_LIMITS.maxOrders) {
    throw new Error(`orderIds debe contener entre 1 y ${ORDER_BULK_LIMITS.maxOrders} pedidos`);
  }
  const observedAt = timestamp(input.observedAt, 'observedAt');
  const expiresAt = timestamp(input.expiresAt, 'expiresAt');
  const lifetime = Date.parse(expiresAt) - Date.parse(observedAt);
  if (lifetime <= 0 || lifetime > ORDER_BULK_LIMITS.maxPreviewLifetimeSeconds * 1_000) {
    throw new Error('expiresAt debe estar dentro de la ventana de preview');
  }
  const action = normalizedAction(input.action, observedAt);
  const candidates = input.candidates.map(normalizedCandidate);
  const candidateIds = candidates.map((candidate) => candidate.orderId);
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error('candidates contiene pedidos duplicados');
  if (candidateIds.some((orderId) => !orderIds.includes(orderId))) {
    throw new Error('candidates contiene pedidos fuera de la selección');
  }
  const byId = new Map(candidates.map((candidate) => [candidate.orderId, candidate]));
  const rows = Object.freeze(orderIds.map((orderId) => previewRow(orderId, byId.get(orderId), action)));
  const ready = rows.filter((row) => row.eligibility === 'ready').length;
  const selectionFingerprint = await sha256(JSON.stringify({ version: 1, orderIds }));
  const previewFingerprint = await sha256(previewFingerprintInput({
    selectionFingerprint, action, observedAt, expiresAt, rows,
  }));
  return Object.freeze({
    action,
    observedAt,
    expiresAt,
    selectionFingerprint,
    previewFingerprint,
    rows,
    counts: Object.freeze({ total: rows.length, ready, skipped: rows.length - ready }),
  });
}

/**
 * Revalida el sobre devuelto por el dry-run antes de congelarlo. El fingerprint
 * no sustituye la autorización admin: evita confirmar por accidente una vista
 * alterada o distinta a la que se previsualizó.
 */
export async function verifyOrderBulkPreview(preview: OrderBulkPreview): Promise<VerifiedOrderBulkPreview> {
  const observedAt = timestamp(preview.observedAt, 'preview.observedAt');
  const expiresAt = timestamp(preview.expiresAt, 'preview.expiresAt');
  const action = normalizedAction(preview.action, observedAt);
  const rows = [...preview.rows];
  if (rows.length === 0 || rows.length > ORDER_BULK_LIMITS.maxOrders) {
    throw new Error(`preview.rows debe contener entre 1 y ${ORDER_BULK_LIMITS.maxOrders} pedidos`);
  }
  const orderIds = uniquePositiveIntegers(rows.map((row) => row.orderId), 'preview.rows.orderId');
  if (rows.some((row, index) => row.orderId !== orderIds[index])) {
    throw new Error('preview.rows debe conservar el orden canónico');
  }
  for (const row of rows) {
    const reason = row.reason;
    if (!ORDER_BULK_PREVIEW_REASONS.includes(reason)) throw new Error('preview.rows.reason no es válido');
    if ((row.eligibility === 'ready') !== (reason === 'ready')) {
      throw new Error('preview.rows contiene una elegibilidad incoherente');
    }
    if (row.observedVersion === null || row.status === null) {
      if (row.observedVersion !== null || row.status !== null || reason !== 'order_not_found') {
        throw new Error('preview.rows contiene un snapshot incompleto');
      }
    } else {
      positiveInteger(row.observedVersion, 'preview.rows.observedVersion');
      if (!ORDER_STATUSES.includes(row.status)) throw new Error('preview.rows.status no es válido');
    }
  }
  const ready = rows.filter((row) => row.eligibility === 'ready').length;
  if (preview.counts.total !== rows.length || preview.counts.ready !== ready ||
      preview.counts.skipped !== rows.length - ready) {
    throw new Error('preview.counts no coincide con sus filas');
  }
  const selectionFingerprint = await sha256(JSON.stringify({ version: 1, orderIds }));
  if (selectionFingerprint !== preview.selectionFingerprint) {
    throw new Error('selectionFingerprint no coincide con la selección');
  }
  const previewFingerprint = await sha256(previewFingerprintInput({
    selectionFingerprint, action, observedAt, expiresAt, rows,
  }));
  if (previewFingerprint !== preview.previewFingerprint) {
    throw new Error('previewFingerprint no coincide con el preview');
  }
  return Object.freeze({
    action,
    observedAt,
    expiresAt,
    selectionFingerprint,
    previewFingerprint,
    rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
    counts: Object.freeze({ ...preview.counts }),
  });
}

export function assertOrderBulkPreviewCurrent(preview: Pick<OrderBulkPreview, 'expiresAt'>, now: string): void {
  const observedAt = timestamp(now, 'now');
  if (Date.parse(observedAt) >= Date.parse(timestamp(preview.expiresAt, 'preview.expiresAt'))) {
    throw new Error('el preview ha caducado');
  }
}

export function orderBulkRowIdempotencyKey(
  batchId: string,
  orderId: number,
  actionType: OrderBulkActionType,
): string {
  if (!ORDER_BULK_ACTION_TYPES.includes(actionType)) throw new Error('actionType no es válido');
  return `bulk:${identifier(batchId, 'batchId', 80)}:${actionType}:order:${positiveInteger(orderId, 'orderId')}`;
}

export function summarizeOrderBulkExecution(rows: readonly OrderBulkExecutionRow[]): Readonly<{
  total: number;
  completed: number;
  pending: number;
  applied: number;
  replayed: number;
  skipped: number;
  conflict: number;
  failed: number;
  replayableOrderIds: readonly number[];
}> {
  const orderIds = rows.map((row) => positiveInteger(row.orderId, 'row.orderId'));
  if (new Set(orderIds).size !== orderIds.length) throw new Error('rows contiene pedidos duplicados');
  if (rows.some((row) => !ORDER_BULK_EXECUTION_OUTCOMES.includes(row.outcome))) {
    throw new Error('row.outcome no es válido');
  }
  const count = (outcome: OrderBulkExecutionOutcome) => rows.filter((row) => row.outcome === outcome).length;
  const pending = count('pending');
  const retryableFailures = count('retryable_failure');
  return Object.freeze({
    total: rows.length,
    completed: rows.length - pending - retryableFailures,
    pending,
    applied: count('applied'),
    replayed: count('replayed'),
    skipped: count('skipped'),
    conflict: count('conflict'),
    failed: retryableFailures + count('permanent_failure'),
    replayableOrderIds: Object.freeze(rows
      .filter((row) => row.outcome === 'pending' || row.outcome === 'retryable_failure')
      .map((row) => row.orderId)
      .toSorted((a, b) => a - b)),
  });
}
