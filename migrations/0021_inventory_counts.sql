-- Conteos y ajustes R3.8. Expand-only: cada sesión congela saldo y versión;
-- los deltas aplicados quedan enlazados al ledger append-only por ubicación.

CREATE TABLE inventory_counts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  count_number TEXT NOT NULL UNIQUE CHECK (length(count_number) BETWEEN 8 AND 40),
  location_id INTEGER NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'applied')),
  reason TEXT NOT NULL CHECK (reason IN ('cycle_count', 'reconciliation', 'damage')),
  requires_approval INTEGER NOT NULL DEFAULT 0 CHECK (requires_approval IN (0, 1)),
  counted_by TEXT NOT NULL CHECK (length(trim(counted_by)) BETWEEN 2 AND 120),
  reviewed_by TEXT CHECK (reviewed_by IS NULL OR length(trim(reviewed_by)) BETWEEN 2 AND 120),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  create_idempotency_key TEXT NOT NULL UNIQUE CHECK (length(create_idempotency_key) BETWEEN 8 AND 160),
  submit_idempotency_key TEXT UNIQUE CHECK (submit_idempotency_key IS NULL OR length(submit_idempotency_key) BETWEEN 8 AND 160),
  approve_idempotency_key TEXT UNIQUE CHECK (approve_idempotency_key IS NULL OR length(approve_idempotency_key) BETWEEN 8 AND 160),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  applied_at TEXT,
  CHECK (reviewed_by IS NULL OR reviewed_by <> counted_by),
  CHECK (
    (status = 'draft' AND submit_idempotency_key IS NULL AND approve_idempotency_key IS NULL AND reviewed_by IS NULL AND submitted_at IS NULL AND applied_at IS NULL) OR
    (status = 'pending_approval' AND requires_approval = 1 AND submit_idempotency_key IS NOT NULL AND approve_idempotency_key IS NULL AND reviewed_by IS NULL AND submitted_at IS NOT NULL AND applied_at IS NULL) OR
    (status = 'applied' AND submit_idempotency_key IS NOT NULL AND submitted_at IS NOT NULL AND applied_at IS NOT NULL AND
      ((requires_approval = 0 AND approve_idempotency_key IS NULL AND reviewed_by IS NULL) OR
       (requires_approval = 1 AND approve_idempotency_key IS NOT NULL AND reviewed_by IS NOT NULL)))
  )
);

CREATE INDEX idx_inventory_counts_status
  ON inventory_counts(status, updated_at DESC, id);
CREATE INDEX idx_inventory_counts_location
  ON inventory_counts(location_id, status, updated_at DESC, id);

CREATE TABLE inventory_count_lines (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  count_id TEXT NOT NULL REFERENCES inventory_counts(id) ON DELETE RESTRICT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  expected_quantity INTEGER NOT NULL CHECK (expected_quantity >= 0),
  counted_quantity INTEGER NOT NULL CHECK (counted_quantity >= 0),
  delta INTEGER NOT NULL,
  expected_movement_version INTEGER NOT NULL CHECK (expected_movement_version >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (count_id, variant_id),
  CHECK (delta = counted_quantity - expected_quantity)
);

CREATE INDEX idx_inventory_count_lines_variant
  ON inventory_count_lines(variant_id, count_id);

CREATE TABLE inventory_count_movements (
  count_line_id TEXT PRIMARY KEY REFERENCES inventory_count_lines(id) ON DELETE RESTRICT,
  count_id TEXT NOT NULL REFERENCES inventory_counts(id) ON DELETE RESTRICT,
  location_movement_id INTEGER NOT NULL UNIQUE REFERENCES inventory_location_movements(id) ON DELETE RESTRICT,
  delta INTEGER NOT NULL CHECK (delta <> 0),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_inventory_count_movements_count
  ON inventory_count_movements(count_id, count_line_id);
