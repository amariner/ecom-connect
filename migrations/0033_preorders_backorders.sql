-- Preventa y backorder explícitos (R4.9; ADR-0036).
--
-- Expand-only: no altera stock ni pedidos existentes. El stock físico nunca se
-- vuelve negativo; una cantidad diferida vive como compromiso hasta que una
-- asignación consume inventario real mediante el ledger existente.

CREATE TABLE preorder_policies (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 120),
  variant_id INTEGER NOT NULL UNIQUE REFERENCES product_variants(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('preorder', 'backorder')),
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'archived')),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 120),
  public_message TEXT NOT NULL CHECK (length(trim(public_message)) BETWEEN 2 AND 240),
  sale_starts_at TEXT,
  sale_ends_at TEXT,
  availability_starts_at TEXT NOT NULL,
  availability_ends_at TEXT NOT NULL,
  max_deferred_quantity INTEGER NOT NULL
    CHECK (typeof(max_deferred_quantity) = 'integer' AND max_deferred_quantity > 0),
  committed_deferred_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(committed_deferred_quantity) = 'integer'
      AND committed_deferred_quantity >= 0
      AND committed_deferred_quantity <= max_deferred_quantity),
  payment_policy TEXT NOT NULL
    CHECK (payment_policy IN ('charge_now', 'charge_on_allocation')),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  capacity_version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(capacity_version) = 'integer' AND capacity_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (sale_starts_at IS NULL OR sale_ends_at IS NULL OR sale_starts_at < sale_ends_at),
  CHECK (availability_starts_at < availability_ends_at)
);

CREATE INDEX idx_preorder_policies_state
  ON preorder_policies(state, sale_starts_at, sale_ends_at, variant_id);

CREATE TABLE preorder_commitments (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 120),
  policy_id TEXT NOT NULL REFERENCES preorder_policies(id) ON DELETE RESTRICT,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  policy_capacity_version INTEGER NOT NULL CHECK (policy_capacity_version >= 1),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  order_item_id INTEGER NOT NULL UNIQUE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('preorder', 'backorder')),
  state TEXT NOT NULL CHECK (state IN (
    'pending_payment', 'awaiting_stock', 'partially_allocated',
    'allocated', 'partially_cancelled', 'cancelled'
  )),
  immediate_quantity INTEGER NOT NULL
    CHECK (typeof(immediate_quantity) = 'integer' AND immediate_quantity >= 0),
  deferred_quantity INTEGER NOT NULL
    CHECK (typeof(deferred_quantity) = 'integer' AND deferred_quantity > 0),
  allocated_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(allocated_quantity) = 'integer' AND allocated_quantity >= 0),
  restored_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(restored_quantity) = 'integer' AND restored_quantity >= 0),
  cancelled_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(cancelled_quantity) = 'integer' AND cancelled_quantity >= 0),
  snapshot_json TEXT NOT NULL
    CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  payment_policy TEXT NOT NULL CHECK (payment_policy = 'charge_now'),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  paid_at TEXT,
  allocated_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_item_id, order_id)
    REFERENCES order_items(id, order_id) ON DELETE RESTRICT,
  CHECK (allocated_quantity + cancelled_quantity <= deferred_quantity),
  CHECK (restored_quantity <= allocated_quantity),
  CHECK (
    (state = 'pending_payment' AND paid_at IS NULL AND allocated_quantity = 0
      AND restored_quantity = 0 AND cancelled_quantity = 0
      AND allocated_at IS NULL AND cancelled_at IS NULL)
    OR (state = 'awaiting_stock' AND paid_at IS NOT NULL AND allocated_quantity = 0
      AND restored_quantity = 0 AND cancelled_quantity = 0
      AND allocated_at IS NULL AND cancelled_at IS NULL)
    OR (state = 'partially_allocated' AND paid_at IS NOT NULL
      AND allocated_quantity > 0
      AND allocated_quantity + cancelled_quantity < deferred_quantity
      AND restored_quantity = 0 AND cancelled_quantity = 0
      AND allocated_at IS NULL AND cancelled_at IS NULL)
    OR (state = 'allocated' AND paid_at IS NOT NULL
      AND allocated_quantity + cancelled_quantity = deferred_quantity
      AND allocated_quantity > restored_quantity
      AND restored_quantity = 0 AND cancelled_quantity = 0
      AND allocated_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state = 'partially_cancelled' AND paid_at IS NOT NULL
      AND (cancelled_quantity > 0 OR restored_quantity > 0)
      AND (deferred_quantity - allocated_quantity - cancelled_quantity)
        + (allocated_quantity - restored_quantity) > 0
      AND cancelled_at IS NULL)
    OR (state = 'cancelled'
      AND (deferred_quantity - allocated_quantity - cancelled_quantity)
        + (allocated_quantity - restored_quantity) = 0
      AND cancelled_at IS NOT NULL)
  )
);

CREATE INDEX idx_preorder_commitments_order
  ON preorder_commitments(order_id, state, order_item_id);
CREATE INDEX idx_preorder_commitments_fifo
  ON preorder_commitments(variant_id, paid_at, created_at, id)
  WHERE state IN ('awaiting_stock', 'partially_allocated', 'partially_cancelled');

CREATE TABLE preorder_commitment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commitment_id TEXT NOT NULL REFERENCES preorder_commitments(id) ON DELETE RESTRICT,
  transition TEXT NOT NULL CHECK (transition IN (
    'payment_confirmed', 'allocation', 'cancellation'
  )),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  allocated_delta INTEGER NOT NULL DEFAULT 0 CHECK (allocated_delta >= 0),
  restored_delta INTEGER NOT NULL DEFAULT 0 CHECK (restored_delta >= 0),
  cancelled_delta INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_delta >= 0),
  allocated_after INTEGER NOT NULL CHECK (allocated_after >= 0),
  restored_after INTEGER NOT NULL CHECK (restored_after >= 0),
  cancelled_after INTEGER NOT NULL CHECK (cancelled_after >= 0),
  version_after INTEGER NOT NULL CHECK (version_after >= 2),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  occurred_at TEXT NOT NULL,
  UNIQUE (commitment_id, version_after),
  CHECK (
    (transition = 'payment_confirmed' AND from_state = 'pending_payment'
      AND to_state = 'awaiting_stock' AND allocated_delta = 0
      AND restored_delta = 0 AND cancelled_delta = 0)
    OR (transition = 'allocation' AND allocated_delta > 0
      AND restored_delta = 0 AND cancelled_delta = 0)
    OR (transition = 'cancellation' AND allocated_delta = 0
      AND restored_delta + cancelled_delta > 0)
  )
);

CREATE INDEX idx_preorder_commitment_events_commitment
  ON preorder_commitment_events(commitment_id, version_after, id);

CREATE TABLE preorder_allocations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 120),
  commitment_id TEXT NOT NULL REFERENCES preorder_commitments(id) ON DELETE RESTRICT,
  commitment_event_id INTEGER NOT NULL UNIQUE
    REFERENCES preorder_commitment_events(id) ON DELETE RESTRICT,
  location_id INTEGER NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
  inventory_movement_id INTEGER NOT NULL UNIQUE
    REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  location_movement_id INTEGER NOT NULL UNIQUE
    REFERENCES inventory_location_movements(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_preorder_allocations_commitment
  ON preorder_allocations(commitment_id, created_at, id);

-- Una política activa siempre cobra ahora mediante el checkout alojado. Cobro
-- posterior queda representable pero no se puede activar en R4.9.
CREATE TRIGGER preorder_policy_activation_insert_guard
BEFORE INSERT ON preorder_policies
WHEN NEW.state = 'active'
BEGIN
  SELECT RAISE(ABORT, 'preorder_policy_activation_conflict')
  WHERE NEW.payment_policy <> 'charge_now';
END;

CREATE TRIGGER preorder_policy_activation_update_guard
BEFORE UPDATE OF state, payment_policy ON preorder_policies
WHEN NEW.state = 'active'
BEGIN
  SELECT RAISE(ABORT, 'preorder_policy_activation_conflict')
  WHERE NEW.payment_policy <> 'charge_now';
END;

-- Snapshot, variante, cantidad y cupo se deciden contra D1. El navegador no
-- puede convertir por sí solo una línea agotada en backorder.
CREATE TRIGGER preorder_commitment_insert_guard
BEFORE INSERT ON preorder_commitments
BEGIN
  SELECT RAISE(ABORT, 'preorder_commitment_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM preorder_policies policy
    JOIN order_items item
      ON item.id = NEW.order_item_id
     AND item.order_id = NEW.order_id
     AND item.variant_id = NEW.variant_id
    JOIN orders purchase ON purchase.id = NEW.order_id
    WHERE policy.id = NEW.policy_id
      AND policy.variant_id = NEW.variant_id
      AND policy.version = NEW.policy_version
      AND policy.capacity_version = NEW.policy_capacity_version
      AND policy.kind = NEW.kind
      AND policy.state = 'active'
      AND policy.payment_policy = 'charge_now'
      AND purchase.status = 'pending'
      AND COALESCE(item.current_qty, item.qty)
        = NEW.immediate_quantity + NEW.deferred_quantity
      AND policy.committed_deferred_quantity + NEW.deferred_quantity
        <= policy.max_deferred_quantity
      AND json_extract(NEW.snapshot_json, '$.schema') = 1
      AND json_extract(NEW.snapshot_json, '$.policy_id') = NEW.policy_id
      AND json_extract(NEW.snapshot_json, '$.policy_version') = NEW.policy_version
      AND json_extract(NEW.snapshot_json, '$.kind') = NEW.kind
      AND json_extract(NEW.snapshot_json, '$.payment_policy') = 'charge_now'
      AND json_extract(NEW.snapshot_json, '$.allocation_policy') = 'paid_fifo'
  );
END;

-- El evento ocupa exactamente la siguiente versión y describe la proyección
-- completa. Una lectura obsoleta aborta la batch en vez de asignar dos veces.
CREATE TRIGGER preorder_commitment_event_guard
BEFORE INSERT ON preorder_commitment_events
BEGIN
  SELECT RAISE(ABORT, 'preorder_commitment_event_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM preorder_commitments commitment
    WHERE commitment.id = NEW.commitment_id
      AND commitment.state = NEW.from_state
      AND commitment.version + 1 = NEW.version_after
      AND commitment.allocated_quantity + NEW.allocated_delta = NEW.allocated_after
      AND commitment.restored_quantity + NEW.restored_delta = NEW.restored_after
      AND commitment.cancelled_quantity + NEW.cancelled_delta = NEW.cancelled_after
      AND NEW.allocated_after + NEW.cancelled_after <= commitment.deferred_quantity
      AND NEW.restored_after <= NEW.allocated_after
      AND (
        (NEW.to_state = 'awaiting_stock' AND NEW.allocated_after = 0
          AND NEW.restored_after = 0 AND NEW.cancelled_after = 0)
        OR (NEW.to_state = 'partially_allocated' AND NEW.allocated_after > 0
          AND NEW.allocated_after + NEW.cancelled_after < commitment.deferred_quantity
          AND NEW.restored_after = 0 AND NEW.cancelled_after = 0)
        OR (NEW.to_state = 'allocated'
          AND NEW.allocated_after + NEW.cancelled_after = commitment.deferred_quantity
          AND NEW.allocated_after > NEW.restored_after
          AND NEW.restored_after = 0 AND NEW.cancelled_after = 0)
        OR (NEW.to_state = 'partially_cancelled'
          AND (NEW.cancelled_after > 0 OR NEW.restored_after > 0)
          AND (commitment.deferred_quantity - NEW.allocated_after - NEW.cancelled_after)
            + (NEW.allocated_after - NEW.restored_after) > 0)
        OR (NEW.to_state = 'cancelled'
          AND (commitment.deferred_quantity - NEW.allocated_after - NEW.cancelled_after)
            + (NEW.allocated_after - NEW.restored_after) = 0)
      )
  );
END;

-- Cada asignación apunta al evento que proyecta exactamente su cantidad y a
-- dos movimientos reales y coherentes (global + ubicación principal).
CREATE TRIGGER preorder_allocation_insert_guard
BEFORE INSERT ON preorder_allocations
BEGIN
  SELECT RAISE(ABORT, 'preorder_allocation_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM preorder_commitments commitment
    JOIN preorder_commitment_events event
      ON event.id = NEW.commitment_event_id
     AND event.commitment_id = commitment.id
     AND event.transition = 'allocation'
     AND event.allocated_delta = NEW.quantity
    JOIN inventory_movements movement
      ON movement.id = NEW.inventory_movement_id
     AND movement.variant_id = NEW.variant_id
     AND movement.delta = -NEW.quantity
     AND movement.reason = 'sale'
     AND movement.reference_type = 'preorder_commitment'
     AND movement.reference_id = commitment.id
    JOIN inventory_location_movements location_movement
      ON location_movement.id = NEW.location_movement_id
     AND location_movement.location_id = NEW.location_id
     AND location_movement.variant_id = NEW.variant_id
     AND location_movement.delta = -NEW.quantity
     AND location_movement.source_movement_id = movement.id
    WHERE commitment.id = NEW.commitment_id
      AND commitment.variant_id = NEW.variant_id
  );
END;
