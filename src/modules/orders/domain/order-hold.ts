export const ORDER_HOLD_SOURCES = ['manual', 'automatic'] as const;
export type OrderHoldSource = (typeof ORDER_HOLD_SOURCES)[number];

export const ORDER_HOLD_REASON_CODES = [
  'payment_review',
  'inventory_issue',
  'address_issue',
  'customer_request',
  'fulfillment_issue',
  'risk_review',
  'other',
] as const;
export type OrderHoldReasonCode = (typeof ORDER_HOLD_REASON_CODES)[number];

export const ORDER_HOLD_RESOLUTION_CODES = [
  'cleared',
  'order_cancelled',
  'duplicate',
  'superseded',
] as const;
export type OrderHoldResolutionCode = (typeof ORDER_HOLD_RESOLUTION_CODES)[number];

export type OrderHoldOwner = Readonly<{
  kind: 'admin' | 'system';
  id: string;
  label: string;
}>;

export type OrderHoldSnapshot = Readonly<{
  id: string;
  order_id: number;
  status: 'active' | 'resolved';
  source: OrderHoldSource;
  reason_code: OrderHoldReasonCode;
  owner: OrderHoldOwner;
  due_at: string;
  version: number;
  created_at: string;
  resolved_at: string | null;
  resolution_code: OrderHoldResolutionCode | null;
}>;

export type PlannedOrderHold = Omit<OrderHoldSnapshot, 'id' | 'order_id'> & Readonly<{
  idempotency_key: string;
}>;

export type PlannedOrderHoldAssignment = Readonly<{
  owner: OrderHoldOwner;
  version: number;
  assigned_at: string;
}>;

export type PlannedOrderHoldResolution = Readonly<{
  status: 'resolved';
  resolution_code: OrderHoldResolutionCode;
  resolved_at: string;
  version: number;
}>;

export type OrderHoldSlaState = 'on_track' | 'breached' | 'resolved';

function normalizedText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${field} debe contener entre 1 y ${maxLength} caracteres`);
  }
  return normalized;
}

function timestamp(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} debe ser un instante ISO UTC`);
  }
  return value;
}

function normalizedOwner(owner: OrderHoldOwner): OrderHoldOwner {
  if (owner.kind !== 'admin' && owner.kind !== 'system') {
    throw new Error('owner.kind no es válido');
  }
  return {
    kind: owner.kind,
    id: normalizedText(owner.id, 'owner.id', 80),
    label: normalizedText(owner.label, 'owner.label', 120),
  };
}

function assertVersion(snapshot: OrderHoldSnapshot, expectedVersion: number): void {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('expectedVersion debe ser un entero positivo');
  }
  if (snapshot.version !== expectedVersion) {
    throw new Error(`hold obsoleto: versión ${snapshot.version}, recibida ${expectedVersion}`);
  }
}

function assertActive(snapshot: OrderHoldSnapshot): void {
  if (snapshot.status !== 'active' || snapshot.resolved_at || snapshot.resolution_code) {
    throw new Error('el hold ya está resuelto');
  }
}

export function planOrderHold(input: Readonly<{
  source: OrderHoldSource;
  reasonCode: OrderHoldReasonCode;
  owner: OrderHoldOwner;
  createdAt: string;
  dueAt: string;
  idempotencyKey: string;
}>): PlannedOrderHold {
  if (!(ORDER_HOLD_SOURCES as readonly string[]).includes(input.source)) {
    throw new Error('source no es válido');
  }
  if (!(ORDER_HOLD_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
    throw new Error('reasonCode no es válido');
  }
  const createdAt = timestamp(input.createdAt, 'createdAt');
  const dueAt = timestamp(input.dueAt, 'dueAt');
  if (Date.parse(dueAt) <= Date.parse(createdAt)) {
    throw new Error('dueAt debe ser posterior a createdAt');
  }
  return {
    status: 'active',
    source: input.source,
    reason_code: input.reasonCode,
    owner: normalizedOwner(input.owner),
    due_at: dueAt,
    version: 1,
    created_at: createdAt,
    resolved_at: null,
    resolution_code: null,
    idempotency_key: normalizedText(input.idempotencyKey, 'idempotencyKey', 160),
  };
}

export function planOrderHoldAssignment(
  snapshot: OrderHoldSnapshot,
  input: Readonly<{ expectedVersion: number; owner: OrderHoldOwner; assignedAt: string }>,
): PlannedOrderHoldAssignment {
  assertActive(snapshot);
  assertVersion(snapshot, input.expectedVersion);
  const assignedAt = timestamp(input.assignedAt, 'assignedAt');
  if (Date.parse(assignedAt) < Date.parse(snapshot.created_at)) {
    throw new Error('assignedAt no puede preceder a la creación');
  }
  const owner = normalizedOwner(input.owner);
  if (owner.kind === snapshot.owner.kind && owner.id === snapshot.owner.id) {
    throw new Error('el hold ya tiene ese responsable');
  }
  return { owner, version: snapshot.version + 1, assigned_at: assignedAt };
}

export function planOrderHoldResolution(
  snapshot: OrderHoldSnapshot,
  input: Readonly<{
    expectedVersion: number;
    resolutionCode: OrderHoldResolutionCode;
    resolvedAt: string;
  }>,
): PlannedOrderHoldResolution {
  assertActive(snapshot);
  assertVersion(snapshot, input.expectedVersion);
  if (!(ORDER_HOLD_RESOLUTION_CODES as readonly string[]).includes(input.resolutionCode)) {
    throw new Error('resolutionCode no es válido');
  }
  const resolvedAt = timestamp(input.resolvedAt, 'resolvedAt');
  if (Date.parse(resolvedAt) < Date.parse(snapshot.created_at)) {
    throw new Error('resolvedAt no puede preceder a la creación');
  }
  return {
    status: 'resolved',
    resolution_code: input.resolutionCode,
    resolved_at: resolvedAt,
    version: snapshot.version + 1,
  };
}

export function orderHoldSlaState(
  hold: Pick<OrderHoldSnapshot, 'status' | 'due_at'>,
  now: string,
): OrderHoldSlaState {
  if (hold.status === 'resolved') return 'resolved';
  const observedAt = timestamp(now, 'now');
  return Date.parse(observedAt) >= Date.parse(timestamp(hold.due_at, 'dueAt'))
    ? 'breached'
    : 'on_track';
}

export function activeOrderHoldIds(
  holds: readonly Pick<OrderHoldSnapshot, 'id' | 'status'>[],
): readonly string[] {
  return holds.filter((hold) => hold.status === 'active').map((hold) => hold.id);
}

export function assertOrderPreparationAllowed(
  holds: readonly Pick<OrderHoldSnapshot, 'id' | 'status'>[],
): void {
  const activeIds = activeOrderHoldIds(holds);
  if (activeIds.length > 0) {
    throw new Error(`pedido bloqueado por ${activeIds.length} hold(s) activo(s)`);
  }
}
