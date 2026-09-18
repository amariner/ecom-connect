export const PREORDER_POLICY_STATES = ['active', 'paused', 'archived'] as const;
export const PREORDER_KINDS = ['preorder', 'backorder'] as const;
export const PREORDER_PAYMENT_POLICIES = ['charge_now', 'charge_on_allocation'] as const;
export const PREORDER_COMMITMENT_STATES = [
  'pending_payment',
  'awaiting_stock',
  'partially_allocated',
  'allocated',
  'partially_cancelled',
  'cancelled',
] as const;

export type PreorderPolicyState = (typeof PREORDER_POLICY_STATES)[number];
export type PreorderKind = (typeof PREORDER_KINDS)[number];
export type PreorderPaymentPolicy = (typeof PREORDER_PAYMENT_POLICIES)[number];
export type PreorderCommitmentState = (typeof PREORDER_COMMITMENT_STATES)[number];

export type PreorderPolicy = Readonly<{
  id: string;
  variantId: number;
  version: number;
  state: PreorderPolicyState;
  kind: PreorderKind;
  label: string;
  publicMessage: string;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  availabilityStartsAt: string;
  availabilityEndsAt: string;
  maxDeferredQuantity: number;
  committedDeferredQuantity: number;
  capacityVersion: number;
  paymentPolicy: PreorderPaymentPolicy;
}>;

export type PreorderSnapshot = Readonly<{
  schema: 1;
  policy_id: string;
  policy_version: number;
  kind: PreorderKind;
  label: string;
  public_message: string;
  availability_starts_at: string;
  availability_ends_at: string;
  payment_policy: 'charge_now';
  allocation_policy: 'paid_fifo';
}>;

export type PreorderLineResolution = Readonly<
  | {
    status: 'available';
    immediateQuantity: number;
    deferredQuantity: 0;
    remainingDeferredCapacity: number | null;
    snapshot: null;
  }
  | {
    status: 'deferred';
    immediateQuantity: number;
    deferredQuantity: number;
    remainingDeferredCapacity: number;
    snapshot: PreorderSnapshot;
  }
  | {
    status: 'rejected';
    reason:
      | 'no_active_policy'
      | 'outside_sale_window'
      | 'availability_window_elapsed'
      | 'unsupported_payment_policy'
      | 'insufficient_deferred_capacity';
    immediateQuantity: number;
    deferredQuantity: number;
    remainingDeferredCapacity: number | null;
    snapshot: null;
  }
>;

export type PreorderCommitment = Readonly<{
  id: string;
  variantId: number;
  state: PreorderCommitmentState;
  immediateQuantity: number;
  deferredQuantity: number;
  allocatedQuantity: number;
  restoredQuantity: number;
  cancelledQuantity: number;
  version: number;
  paidAt: string | null;
  createdAt: string;
}>;

export type PreorderCommitmentMutation = Readonly<{
  commitment: PreorderCommitment;
  allocatedDelta: number;
  cancelledDelta: number;
  restockQuantity: number;
}>;

export type PreorderAllocationPlan = Readonly<{
  allocations: readonly Readonly<{ commitmentId: string; quantity: number }>[];
  allocatedQuantity: number;
  remainingQuantity: number;
}>;

function integer(value: number, label: string, minimum: number, maximum = 1_000_000_000): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} inválido.`);
  }
}

function token(value: string, label: string): void {
  if (!/^[a-z0-9](?:[a-z0-9:_-]{0,118}[a-z0-9])?$/.test(value)) {
    throw new RangeError(`${label} inválido.`);
  }
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`${label} inválido.`);
  return parsed;
}

function optionalTimestamp(value: string | null, label: string): number | null {
  return value === null ? null : timestamp(value, label);
}

export function assertPreorderPolicy(policy: PreorderPolicy): void {
  token(policy.id, 'preorderPolicy.id');
  integer(policy.variantId, 'preorderPolicy.variantId', 1, 2_147_483_647);
  integer(policy.version, 'preorderPolicy.version', 1, 1_000_000);
  if (!PREORDER_POLICY_STATES.includes(policy.state)) throw new RangeError('preorderPolicy.state inválido.');
  if (!PREORDER_KINDS.includes(policy.kind)) throw new RangeError('preorderPolicy.kind inválido.');
  if (!PREORDER_PAYMENT_POLICIES.includes(policy.paymentPolicy)) {
    throw new RangeError('preorderPolicy.paymentPolicy inválido.');
  }
  if (policy.label.trim().length < 2 || policy.label.trim().length > 120) {
    throw new RangeError('preorderPolicy.label inválido.');
  }
  if (policy.publicMessage.trim().length < 2 || policy.publicMessage.trim().length > 240) {
    throw new RangeError('preorderPolicy.publicMessage inválido.');
  }
  const saleStartsAt = optionalTimestamp(policy.saleStartsAt, 'preorderPolicy.saleStartsAt');
  const saleEndsAt = optionalTimestamp(policy.saleEndsAt, 'preorderPolicy.saleEndsAt');
  if (saleStartsAt !== null && saleEndsAt !== null && saleStartsAt >= saleEndsAt) {
    throw new RangeError('La ventana de venta debe ser creciente.');
  }
  const availabilityStartsAt = timestamp(
    policy.availabilityStartsAt,
    'preorderPolicy.availabilityStartsAt',
  );
  const availabilityEndsAt = timestamp(
    policy.availabilityEndsAt,
    'preorderPolicy.availabilityEndsAt',
  );
  if (availabilityStartsAt >= availabilityEndsAt) {
    throw new RangeError('La ventana de disponibilidad debe ser creciente.');
  }
  integer(policy.maxDeferredQuantity, 'preorderPolicy.maxDeferredQuantity', 1);
  integer(
    policy.committedDeferredQuantity,
    'preorderPolicy.committedDeferredQuantity',
    0,
    policy.maxDeferredQuantity,
  );
  integer(policy.capacityVersion, 'preorderPolicy.capacityVersion', 1, 1_000_000_000);
}

export function resolvePreorderLine(input: Readonly<{
  policy: PreorderPolicy | null;
  requestedQuantity: number;
  availableQuantity: number;
  at: string;
}>): PreorderLineResolution {
  integer(input.requestedQuantity, 'requestedQuantity', 1, 99);
  integer(input.availableQuantity, 'availableQuantity', 0);
  const at = timestamp(input.at, 'at');
  if (input.policy === null) {
    const immediateQuantity = Math.min(input.availableQuantity, input.requestedQuantity);
    const deferredQuantity = input.requestedQuantity - immediateQuantity;
    return deferredQuantity === 0
      ? Object.freeze({ status: 'available', immediateQuantity, deferredQuantity: 0,
        remainingDeferredCapacity: null, snapshot: null })
      : Object.freeze({ status: 'rejected', reason: 'no_active_policy', immediateQuantity,
        deferredQuantity, remainingDeferredCapacity: null, snapshot: null });
  }
  assertPreorderPolicy(input.policy);
  const remainingDeferredCapacity =
    input.policy.maxDeferredQuantity - input.policy.committedDeferredQuantity;
  const immediateQuantity = input.policy.kind === 'preorder'
    ? 0
    : Math.min(input.availableQuantity, input.requestedQuantity);
  const deferredQuantity = input.requestedQuantity - immediateQuantity;

  if (deferredQuantity === 0) {
    return Object.freeze({ status: 'available', immediateQuantity, deferredQuantity: 0,
      remainingDeferredCapacity, snapshot: null });
  }
  if (input.policy.state !== 'active') {
    return Object.freeze({ status: 'rejected', reason: 'no_active_policy', immediateQuantity,
      deferredQuantity, remainingDeferredCapacity, snapshot: null });
  }
  const saleStartsAt = optionalTimestamp(input.policy.saleStartsAt, 'preorderPolicy.saleStartsAt');
  const saleEndsAt = optionalTimestamp(input.policy.saleEndsAt, 'preorderPolicy.saleEndsAt');
  if ((saleStartsAt !== null && at < saleStartsAt) || (saleEndsAt !== null && at >= saleEndsAt)) {
    return Object.freeze({ status: 'rejected', reason: 'outside_sale_window', immediateQuantity,
      deferredQuantity, remainingDeferredCapacity, snapshot: null });
  }
  if (at >= timestamp(input.policy.availabilityEndsAt, 'preorderPolicy.availabilityEndsAt')) {
    return Object.freeze({ status: 'rejected', reason: 'availability_window_elapsed', immediateQuantity,
      deferredQuantity, remainingDeferredCapacity, snapshot: null });
  }
  if (input.policy.paymentPolicy !== 'charge_now') {
    return Object.freeze({ status: 'rejected', reason: 'unsupported_payment_policy', immediateQuantity,
      deferredQuantity, remainingDeferredCapacity, snapshot: null });
  }
  if (deferredQuantity > remainingDeferredCapacity) {
    return Object.freeze({ status: 'rejected', reason: 'insufficient_deferred_capacity', immediateQuantity,
      deferredQuantity, remainingDeferredCapacity, snapshot: null });
  }
  return Object.freeze({
    status: 'deferred',
    immediateQuantity,
    deferredQuantity,
    remainingDeferredCapacity,
    snapshot: Object.freeze({
      schema: 1 as const,
      policy_id: input.policy.id,
      policy_version: input.policy.version,
      kind: input.policy.kind,
      label: input.policy.label.trim(),
      public_message: input.policy.publicMessage.trim(),
      availability_starts_at: input.policy.availabilityStartsAt,
      availability_ends_at: input.policy.availabilityEndsAt,
      payment_policy: 'charge_now' as const,
      allocation_policy: 'paid_fifo' as const,
    }),
  });
}

export function assertPreorderCommitment(commitment: PreorderCommitment): void {
  token(commitment.id, 'preorderCommitment.id');
  integer(commitment.variantId, 'preorderCommitment.variantId', 1, 2_147_483_647);
  integer(commitment.immediateQuantity, 'preorderCommitment.immediateQuantity', 0);
  integer(commitment.deferredQuantity, 'preorderCommitment.deferredQuantity', 1);
  integer(commitment.allocatedQuantity, 'preorderCommitment.allocatedQuantity', 0);
  integer(commitment.restoredQuantity, 'preorderCommitment.restoredQuantity', 0);
  integer(commitment.cancelledQuantity, 'preorderCommitment.cancelledQuantity', 0);
  integer(commitment.version, 'preorderCommitment.version', 1);
  if (!PREORDER_COMMITMENT_STATES.includes(commitment.state)) {
    throw new RangeError('preorderCommitment.state inválido.');
  }
  if (commitment.allocatedQuantity + commitment.cancelledQuantity > commitment.deferredQuantity) {
    throw new RangeError('El compromiso supera la cantidad diferida.');
  }
  if (commitment.restoredQuantity > commitment.allocatedQuantity) {
    throw new RangeError('No se puede reponer más de lo asignado.');
  }
  const createdAt = timestamp(commitment.createdAt, 'preorderCommitment.createdAt');
  const paidAt = commitment.paidAt === null
    ? null
    : timestamp(commitment.paidAt, 'preorderCommitment.paidAt');
  if (paidAt !== null && paidAt < createdAt) {
    throw new RangeError('La fecha de pago no puede preceder al compromiso.');
  }
  if (commitment.state === 'pending_payment' && commitment.paidAt !== null) {
    throw new RangeError('Un compromiso pendiente no puede tener fecha de pago.');
  }
  if (!['pending_payment', 'cancelled'].includes(commitment.state) && commitment.paidAt === null) {
    throw new RangeError('Un compromiso operativo exige fecha de pago.');
  }
  const pending = commitment.deferredQuantity - commitment.allocatedQuantity - commitment.cancelledQuantity;
  const activeAllocated = commitment.allocatedQuantity - commitment.restoredQuantity;
  const active = pending + activeAllocated;
  const quantitiesMatchState =
    (commitment.state === 'pending_payment' && commitment.allocatedQuantity === 0 &&
      commitment.restoredQuantity === 0 && commitment.cancelledQuantity === 0) ||
    (commitment.state === 'awaiting_stock' && pending > 0 && commitment.allocatedQuantity === 0 &&
      commitment.restoredQuantity === 0 && commitment.cancelledQuantity === 0) ||
    (commitment.state === 'partially_allocated' && pending > 0 && commitment.allocatedQuantity > 0 &&
      commitment.restoredQuantity === 0 && commitment.cancelledQuantity === 0) ||
    (commitment.state === 'allocated' && pending === 0 && activeAllocated > 0 &&
      commitment.restoredQuantity === 0 && commitment.cancelledQuantity === 0) ||
    (commitment.state === 'partially_cancelled' && active > 0 &&
      (commitment.restoredQuantity > 0 || commitment.cancelledQuantity > 0)) ||
    (commitment.state === 'cancelled' && active === 0);
  if (!quantitiesMatchState) throw new RangeError('El estado no coincide con las cantidades del compromiso.');
}

function stateAfterQuantities(commitment: PreorderCommitment): PreorderCommitmentState {
  const pending = commitment.deferredQuantity - commitment.allocatedQuantity - commitment.cancelledQuantity;
  const activeAllocated = commitment.allocatedQuantity - commitment.restoredQuantity;
  const active = pending + activeAllocated;
  if (active === 0) return 'cancelled';
  if (commitment.cancelledQuantity > 0 || commitment.restoredQuantity > 0) return 'partially_cancelled';
  if (pending === 0) return 'allocated';
  if (commitment.allocatedQuantity > 0) return 'partially_allocated';
  return 'awaiting_stock';
}

export function confirmPreorderPayment(
  commitment: PreorderCommitment,
  paidAt: string,
): PreorderCommitmentMutation {
  assertPreorderCommitment(commitment);
  timestamp(paidAt, 'paidAt');
  if (commitment.state !== 'pending_payment') throw new RangeError('El compromiso no espera pago.');
  const next = Object.freeze({ ...commitment, state: 'awaiting_stock' as const,
    version: commitment.version + 1, paidAt });
  return Object.freeze({ commitment: next, allocatedDelta: 0, cancelledDelta: 0, restockQuantity: 0 });
}

export function allocatePreorderCommitment(
  commitment: PreorderCommitment,
  quantity: number,
): PreorderCommitmentMutation {
  assertPreorderCommitment(commitment);
  integer(quantity, 'quantity', 1);
  if (!['awaiting_stock', 'partially_allocated', 'partially_cancelled'].includes(commitment.state)) {
    throw new RangeError('El compromiso no admite asignación.');
  }
  const pending = commitment.deferredQuantity - commitment.allocatedQuantity - commitment.cancelledQuantity;
  if (quantity > pending) throw new RangeError('La asignación supera la cantidad pendiente.');
  const draft: PreorderCommitment = { ...commitment,
    allocatedQuantity: commitment.allocatedQuantity + quantity,
    version: commitment.version + 1 };
  const next = Object.freeze({ ...draft, state: stateAfterQuantities(draft) });
  return Object.freeze({ commitment: next, allocatedDelta: quantity,
    cancelledDelta: 0, restockQuantity: 0 });
}

export function cancelPreorderCommitment(
  commitment: PreorderCommitment,
  quantity: number,
): PreorderCommitmentMutation {
  assertPreorderCommitment(commitment);
  integer(quantity, 'quantity', 1);
  if (commitment.state === 'cancelled') throw new RangeError('El compromiso ya está cancelado.');
  const pending = commitment.deferredQuantity - commitment.allocatedQuantity - commitment.cancelledQuantity;
  const activeAllocated = commitment.allocatedQuantity - commitment.restoredQuantity;
  if (quantity > pending + activeAllocated) throw new RangeError('La cancelación supera la cantidad activa.');
  if (commitment.state === 'pending_payment' && quantity !== pending) {
    throw new RangeError('Un compromiso impagado solo admite cancelación total.');
  }
  const cancelledFromPending = Math.min(quantity, pending);
  const restockQuantity = quantity - cancelledFromPending;
  const draft: PreorderCommitment = {
    ...commitment,
    cancelledQuantity: commitment.cancelledQuantity + cancelledFromPending,
    restoredQuantity: commitment.restoredQuantity + restockQuantity,
    version: commitment.version + 1,
  };
  const next = Object.freeze({ ...draft, state: stateAfterQuantities(draft) });
  return Object.freeze({ commitment: next, allocatedDelta: 0,
    cancelledDelta: cancelledFromPending, restockQuantity });
}

export function planPreorderAllocations(input: Readonly<{
  variantId: number;
  availableQuantity: number;
  commitments: readonly PreorderCommitment[];
}>): PreorderAllocationPlan {
  integer(input.variantId, 'variantId', 1, 2_147_483_647);
  integer(input.availableQuantity, 'availableQuantity', 0);
  const ids = new Set<string>();
  const eligible = input.commitments.map((commitment) => {
    assertPreorderCommitment(commitment);
    if (commitment.variantId !== input.variantId) {
      throw new RangeError('La cola contiene un compromiso de otra variante.');
    }
    if (ids.has(commitment.id)) throw new RangeError('Compromiso duplicado.');
    ids.add(commitment.id);
    const pending = commitment.deferredQuantity - commitment.allocatedQuantity - commitment.cancelledQuantity;
    return { commitment, pending };
  }).filter(({ commitment, pending }) =>
    commitment.paidAt !== null && pending > 0 &&
    ['awaiting_stock', 'partially_allocated', 'partially_cancelled'].includes(commitment.state))
    .sort((left, right) =>
      left.commitment.paidAt!.localeCompare(right.commitment.paidAt!) ||
      left.commitment.createdAt.localeCompare(right.commitment.createdAt) ||
      left.commitment.id.localeCompare(right.commitment.id));
  let remaining = input.availableQuantity;
  const allocations: Array<{ commitmentId: string; quantity: number }> = [];
  for (const { commitment, pending } of eligible) {
    const quantity = Math.min(pending, remaining);
    if (quantity === 0) break;
    allocations.push(Object.freeze({ commitmentId: commitment.id, quantity }));
    remaining -= quantity;
  }
  return Object.freeze({
    allocations: Object.freeze(allocations),
    allocatedQuantity: input.availableQuantity - remaining,
    remainingQuantity: remaining,
  });
}
