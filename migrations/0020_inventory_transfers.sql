-- Transferencias de inventario R3.7. Expand-only: la ubicación principal
-- continúa siendo el espejo vendible del ledger legacy hasta R3.9.

CREATE TABLE inventory_transfers (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  transfer_number TEXT NOT NULL UNIQUE CHECK (length(transfer_number) BETWEEN 8 AND 40),
  source_location_id INTEGER NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  destination_location_id INTEGER NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_transit', 'partially_received', 'received')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  create_idempotency_key TEXT NOT NULL UNIQUE CHECK (length(create_idempotency_key) BETWEEN 8 AND 160),
  ship_idempotency_key TEXT UNIQUE CHECK (ship_idempotency_key IS NULL OR length(ship_idempotency_key) BETWEEN 8 AND 160),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  shipped_at TEXT,
  completed_at TEXT,
  CHECK (source_location_id <> destination_location_id),
  CHECK ((status = 'draft' AND shipped_at IS NULL AND completed_at IS NULL) OR
         (status IN ('in_transit', 'partially_received') AND shipped_at IS NOT NULL AND completed_at IS NULL) OR
         (status = 'received' AND shipped_at IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE INDEX idx_inventory_transfers_status
  ON inventory_transfers(status, updated_at DESC, id);
CREATE INDEX idx_inventory_transfers_locations
  ON inventory_transfers(source_location_id, destination_location_id, status, id);

CREATE TABLE inventory_transfer_lines (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  transfer_id TEXT NOT NULL REFERENCES inventory_transfers(id) ON DELETE RESTRICT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity BETWEEN 1 AND 100000),
  sent_quantity INTEGER NOT NULL DEFAULT 0 CHECK (sent_quantity >= 0 AND sent_quantity <= requested_quantity),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0 AND received_quantity <= sent_quantity),
  discrepancy_quantity INTEGER NOT NULL DEFAULT 0 CHECK (discrepancy_quantity >= 0 AND discrepancy_quantity <= sent_quantity),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (transfer_id, variant_id),
  CHECK (received_quantity + discrepancy_quantity <= sent_quantity)
);

CREATE INDEX idx_inventory_transfer_lines_variant
  ON inventory_transfer_lines(variant_id, transfer_id);

CREATE TABLE inventory_transfer_receipts (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  transfer_id TEXT NOT NULL REFERENCES inventory_transfers(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_inventory_transfer_receipts_transfer
  ON inventory_transfer_receipts(transfer_id, occurred_at, id);

CREATE TABLE inventory_transfer_receipt_lines (
  receipt_id TEXT NOT NULL REFERENCES inventory_transfer_receipts(id) ON DELETE RESTRICT,
  transfer_line_id TEXT NOT NULL REFERENCES inventory_transfer_lines(id) ON DELETE RESTRICT,
  received_quantity INTEGER NOT NULL CHECK (received_quantity >= 0),
  discrepancy_quantity INTEGER NOT NULL CHECK (discrepancy_quantity >= 0),
  PRIMARY KEY (receipt_id, transfer_line_id),
  CHECK (received_quantity + discrepancy_quantity > 0)
);

CREATE TABLE inventory_transfer_movements (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  transfer_id TEXT NOT NULL REFERENCES inventory_transfers(id) ON DELETE RESTRICT,
  transfer_line_id TEXT NOT NULL REFERENCES inventory_transfer_lines(id) ON DELETE RESTRICT,
  receipt_id TEXT REFERENCES inventory_transfer_receipts(id) ON DELETE RESTRICT,
  location_movement_id INTEGER NOT NULL UNIQUE REFERENCES inventory_location_movements(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('dispatch', 'receipt')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL,
  CHECK ((direction = 'dispatch' AND receipt_id IS NULL) OR
         (direction = 'receipt' AND receipt_id IS NOT NULL))
);

CREATE INDEX idx_inventory_transfer_movements_transfer
  ON inventory_transfer_movements(transfer_id, transfer_line_id, direction, id);
