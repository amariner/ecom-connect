import {
  cancelPreorderCommitment,
  confirmPreorderPayment,
  allocatePreorderCommitment,
  resolvePreorderLine,
  type PreorderCommitment,
  type PreorderLineResolution,
  type PreorderPolicy,
  type PreorderSnapshot,
} from '../domain/preorder';

type PolicyRow = Readonly<{
  id: string;
  product_id: number;
  variant_id: number;
  version: number;
  state: PreorderPolicy['state'];
  kind: PreorderPolicy['kind'];
  label: string;
  public_message: string;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  availability_starts_at: string;
  availability_ends_at: string;
  max_deferred_quantity: number;
  committed_deferred_quantity: number;
  capacity_version: number;
  payment_policy: PreorderPolicy['paymentPolicy'];
}>;

type CommitmentRow = Readonly<{
  id: string;
  variant_id: number;
  state: PreorderCommitment['state'];
  immediate_quantity: number;
  deferred_quantity: number;
  allocated_quantity: number;
  restored_quantity: number;
  cancelled_quantity: number;
  version: number;
  paid_at: string | null;
  created_at: string;
  policy_id: string;
  policy_version: number;
  policy_capacity_version: number;
  order_id: number;
  order_item_id: number;
  kind: PreorderPolicy['kind'];
  snapshot_json: string;
}>;

export type PreorderApplication = Readonly<{
  policyId: string;
  policyVersion: number;
  policyCapacityVersion: number;
  productId: number;
  variantId: number;
  kind: PreorderPolicy['kind'];
  immediateQuantity: number;
  deferredQuantity: number;
  snapshot: PreorderSnapshot;
}>;

export type PreorderCommitmentRecord = PreorderCommitment & Readonly<{
  policyId: string;
  policyVersion: number;
  policyCapacityVersion: number;
  orderId: number;
  orderItemId: number;
  kind: PreorderPolicy['kind'];
  snapshot: PreorderSnapshot;
}>;

function policyOf(row: PolicyRow): PreorderPolicy {
  return Object.freeze({
    id: row.id,
    variantId: row.variant_id,
    version: row.version,
    state: row.state,
    kind: row.kind,
    label: row.label,
    publicMessage: row.public_message,
    saleStartsAt: row.sale_starts_at,
    saleEndsAt: row.sale_ends_at,
    availabilityStartsAt: row.availability_starts_at,
    availabilityEndsAt: row.availability_ends_at,
    maxDeferredQuantity: row.max_deferred_quantity,
    committedDeferredQuantity: row.committed_deferred_quantity,
    capacityVersion: row.capacity_version,
    paymentPolicy: row.payment_policy,
  });
}

function commitmentOf(row: CommitmentRow): PreorderCommitmentRecord {
  return Object.freeze({
    id: row.id,
    variantId: row.variant_id,
    state: row.state,
    immediateQuantity: row.immediate_quantity,
    deferredQuantity: row.deferred_quantity,
    allocatedQuantity: row.allocated_quantity,
    restoredQuantity: row.restored_quantity,
    cancelledQuantity: row.cancelled_quantity,
    version: row.version,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    policyCapacityVersion: row.policy_capacity_version,
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    kind: row.kind,
    snapshot: JSON.parse(row.snapshot_json) as PreorderSnapshot,
  });
}

export function createD1Preorders(db: D1Database) {
  async function policies(productIds?: readonly number[]): Promise<readonly (PreorderPolicy & { productId: number })[]> {
    const ids = productIds === undefined ? [] : [...new Set(productIds)];
    if (productIds !== undefined && ids.length === 0) return [];
    const { results } = await db.prepare(`SELECT policy.*, variant.product_id
      FROM preorder_policies policy
      JOIN product_variants variant ON variant.id=policy.variant_id AND variant.is_default=1
      ${productIds === undefined ? '' : `WHERE variant.product_id IN (${ids.map(() => '?').join(',')})`}
      ORDER BY variant.product_id, policy.id`).bind(...ids).all<PolicyRow>();
    return Object.freeze(results.map((row) => Object.freeze({ ...policyOf(row), productId: row.product_id })));
  }

  async function commitmentsForOrder(orderId: number): Promise<readonly PreorderCommitmentRecord[]> {
    const { results } = await db.prepare(`SELECT * FROM preorder_commitments
      WHERE order_id=? ORDER BY order_item_id`).bind(orderId).all<CommitmentRow>();
    return Object.freeze(results.map(commitmentOf));
  }

  async function commitmentsForVariant(variantId: number): Promise<readonly PreorderCommitmentRecord[]> {
    const { results } = await db.prepare(`SELECT * FROM preorder_commitments
      WHERE variant_id=? AND state IN ('awaiting_stock','partially_allocated','partially_cancelled')
      ORDER BY paid_at, created_at, id`).bind(variantId).all<CommitmentRow>();
    return Object.freeze(results.map(commitmentOf));
  }

  return Object.freeze({
    policies,
    commitmentsForOrder,
    commitmentsForVariant,

    async resolveForProducts(input: readonly Readonly<{
      productId: number;
      requestedQuantity: number;
      availableQuantity: number;
    }>[], at: string): Promise<ReadonlyMap<number, Readonly<{
      policy: (PreorderPolicy & { productId: number }) | null;
      resolution: PreorderLineResolution;
    }>>> {
      const configured = await policies(input.map((line) => line.productId));
      const byProduct = new Map(configured.map((policy) => [policy.productId, policy]));
      return new Map(input.map((line) => {
        const policy = byProduct.get(line.productId) ?? null;
        return [line.productId, Object.freeze({ policy, resolution: resolvePreorderLine({
          policy,
          requestedQuantity: line.requestedQuantity,
          availableQuantity: line.availableQuantity,
          at,
        }) })] as const;
      }));
    },

    commitmentStatements(
      orderNumber: string,
      application: PreorderApplication,
      createdAt: string,
    ): readonly D1PreparedStatement[] {
      const commitmentId = `pre_${crypto.randomUUID()}`;
      const idempotencyKey = `preorder:${application.policyId}:order:${orderNumber}:product:${application.productId}`;
      return Object.freeze([
        db.prepare(`INSERT INTO preorder_commitments (
          id, policy_id, policy_version, policy_capacity_version, order_id, order_item_id,
          variant_id, kind, state, immediate_quantity, deferred_quantity,
          allocated_quantity, restored_quantity, cancelled_quantity, snapshot_json,
          payment_policy, idempotency_key, version, created_at, updated_at
        ) SELECT ?, ?, ?, ?, purchase.id, item.id, ?, ?, 'pending_payment', ?, ?,
          0, 0, 0, ?, 'charge_now', ?, 1, ?, ?
          FROM orders purchase JOIN order_items item
            ON item.order_id=purchase.id AND item.product_id=?
          WHERE purchase.order_number=?`).bind(
          commitmentId, application.policyId, application.policyVersion,
          application.policyCapacityVersion, application.variantId, application.kind,
          application.immediateQuantity, application.deferredQuantity,
          JSON.stringify(application.snapshot), idempotencyKey, createdAt, createdAt,
          application.productId, orderNumber,
        ),
        db.prepare(`UPDATE preorder_policies SET
          committed_deferred_quantity=committed_deferred_quantity+?,
          capacity_version=capacity_version+1, updated_at=?
          WHERE id=? AND version=? AND capacity_version=?
            AND committed_deferred_quantity+?<=max_deferred_quantity
            AND EXISTS (SELECT 1 FROM preorder_commitments WHERE id=?)`).bind(
          application.deferredQuantity, createdAt, application.policyId,
          application.policyVersion, application.policyCapacityVersion,
          application.deferredQuantity, commitmentId,
        ),
      ]);
    },

    paymentConfirmationStatements(
      commitment: PreorderCommitmentRecord,
      paidAt: string,
      eventId: string,
    ): readonly D1PreparedStatement[] {
      const mutation = confirmPreorderPayment(commitment, paidAt);
      const key = `preorder:${commitment.id}:paid`;
      return Object.freeze([
        db.prepare(`INSERT INTO preorder_commitment_events (
          commitment_id, transition, from_state, to_state, allocated_delta,
          restored_delta, cancelled_delta, allocated_after, restored_after,
          cancelled_after, version_after, idempotency_key, occurred_at
        ) SELECT ?, 'payment_confirmed', ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id=?)`).bind(
          commitment.id, commitment.state, mutation.commitment.state,
          mutation.commitment.allocatedQuantity, mutation.commitment.restoredQuantity,
          mutation.commitment.cancelledQuantity, mutation.commitment.version,
          key, paidAt, eventId,
        ),
        db.prepare(`UPDATE preorder_commitments SET state=?, version=?, paid_at=?, updated_at=?
          WHERE id=? AND state=? AND version=? AND EXISTS (
            SELECT 1 FROM preorder_commitment_events WHERE idempotency_key=?)`).bind(
          mutation.commitment.state, mutation.commitment.version, paidAt, paidAt,
          commitment.id, commitment.state, commitment.version, key,
        ),
      ]);
    },

    cancellationStatements(
      commitment: PreorderCommitmentRecord,
      quantity: number,
      occurredAt: string,
      eventId: string,
      idempotencyKey: string,
    ): readonly D1PreparedStatement[] {
      const mutation = cancelPreorderCommitment(commitment, quantity);
      const eventKey = `${idempotencyKey}:commitment:${commitment.id}`;
      return Object.freeze([
        db.prepare(`INSERT INTO preorder_commitment_events (
          commitment_id, transition, from_state, to_state, allocated_delta,
          restored_delta, cancelled_delta, allocated_after, restored_after,
          cancelled_after, version_after, idempotency_key, occurred_at
        ) SELECT ?, 'cancellation', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM event_outbox_events WHERE event_id=?)`).bind(
          commitment.id, commitment.state, mutation.commitment.state,
          mutation.restockQuantity, mutation.cancelledDelta,
          mutation.commitment.allocatedQuantity, mutation.commitment.restoredQuantity,
          mutation.commitment.cancelledQuantity, mutation.commitment.version,
          eventKey, occurredAt, eventId,
        ),
        db.prepare(`UPDATE preorder_commitments SET state=?, restored_quantity=?,
          cancelled_quantity=?, version=?, cancelled_at=?, updated_at=?
          WHERE id=? AND state=? AND version=? AND EXISTS (
            SELECT 1 FROM preorder_commitment_events WHERE idempotency_key=?)`).bind(
          mutation.commitment.state, mutation.commitment.restoredQuantity,
          mutation.commitment.cancelledQuantity, mutation.commitment.version,
          mutation.commitment.state === 'cancelled' ? occurredAt : null, occurredAt,
          commitment.id, commitment.state, commitment.version, eventKey,
        ),
        ...(mutation.cancelledDelta === 0 ? [] : [db.prepare(`UPDATE preorder_policies SET
          committed_deferred_quantity=committed_deferred_quantity-?,
          capacity_version=capacity_version+1, updated_at=?
          WHERE id=? AND committed_deferred_quantity>=? AND EXISTS (
            SELECT 1 FROM preorder_commitment_events WHERE idempotency_key=?)`).bind(
          mutation.cancelledDelta, occurredAt, commitment.policyId,
          mutation.cancelledDelta, eventKey,
        )]),
      ]);
    },

    allocationStatements(
      commitment: PreorderCommitmentRecord,
      quantity: number,
      occurredAt: string,
      auditId: string,
      idempotencyKey: string,
    ): readonly D1PreparedStatement[] {
      const mutation = allocatePreorderCommitment(commitment, quantity);
      const eventKey = `${idempotencyKey}:commitment:${commitment.id}`;
      const movementKey = `${idempotencyKey}:inventory:${commitment.id}`;
      const allocationId = `pra_${crypto.randomUUID()}`;
      return Object.freeze([
        db.prepare(`INSERT INTO preorder_commitment_events (
          commitment_id, transition, from_state, to_state, allocated_delta,
          restored_delta, cancelled_delta, allocated_after, restored_after,
          cancelled_after, version_after, idempotency_key, occurred_at
        ) SELECT ?, 'allocation', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_id=?)`).bind(
          commitment.id, commitment.state, mutation.commitment.state,
          mutation.allocatedDelta, mutation.commitment.allocatedQuantity,
          mutation.commitment.restoredQuantity, mutation.commitment.cancelledQuantity,
          mutation.commitment.version, eventKey, occurredAt, auditId,
        ),
        db.prepare(`UPDATE preorder_commitments SET state=?, allocated_quantity=?,
          version=?, allocated_at=?, updated_at=?
          WHERE id=? AND state=? AND version=? AND EXISTS (
            SELECT 1 FROM preorder_commitment_events WHERE idempotency_key=?)`).bind(
          mutation.commitment.state, mutation.commitment.allocatedQuantity,
          mutation.commitment.version,
          mutation.commitment.state === 'allocated' ? occurredAt : null,
          occurredAt, commitment.id, commitment.state, commitment.version, eventKey,
        ),
        db.prepare(`UPDATE preorder_policies SET
          committed_deferred_quantity=committed_deferred_quantity-?,
          capacity_version=capacity_version+1, updated_at=?
          WHERE id=? AND committed_deferred_quantity>=? AND EXISTS (
            SELECT 1 FROM preorder_commitment_events WHERE idempotency_key=?)`).bind(
          quantity, occurredAt, commitment.policyId, quantity, eventKey,
        ),
        db.prepare(`INSERT INTO preorder_allocations (
          id, commitment_id, commitment_event_id, location_id, variant_id, quantity,
          inventory_movement_id, location_movement_id, idempotency_key, created_at
        ) SELECT ?, ?, event.id, location.id, ?, ?, movement.id,
          location_movement.id, ?, ?
          FROM preorder_commitment_events event
          JOIN inventory_movements movement ON movement.idempotency_key=?
          JOIN inventory_locations location ON location.is_primary=1
          JOIN inventory_location_movements location_movement
            ON location_movement.source_movement_id=movement.id
           AND location_movement.location_id=location.id
          WHERE event.idempotency_key=?`).bind(
          allocationId, commitment.id, commitment.variantId, quantity,
          `${idempotencyKey}:allocation:${commitment.id}`, occurredAt,
          movementKey, eventKey,
        ),
      ]);
    },
  });
}

export type D1Preorders = ReturnType<typeof createD1Preorders>;
