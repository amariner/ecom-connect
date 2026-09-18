-- Devoluciones/RMA R3.10. Expand-only: separa la logística inversa del
-- reembolso de cancelaciones y no reescribe fulfillments ni ledgers previos.

CREATE TABLE return_requests (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  return_number TEXT NOT NULL UNIQUE CHECK (length(return_number) BETWEEN 8 AND 40),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  receive_location_id INTEGER REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'authorized', 'in_transit', 'received', 'inspected',
    'resolved', 'rejected', 'cancelled'
  )),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'damaged', 'defective', 'wrong_item', 'not_as_expected', 'other'
  )),
  requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('customer', 'admin')),
  requested_by_id TEXT NOT NULL CHECK (length(trim(requested_by_id)) BETWEEN 2 AND 80),
  resolution TEXT CHECK (resolution IN ('refund', 'exchange', 'reject')),
  refund_id INTEGER UNIQUE REFERENCES refunds(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  create_idempotency_key TEXT NOT NULL UNIQUE CHECK (length(create_idempotency_key) BETWEEN 8 AND 200),
  authorize_idempotency_key TEXT UNIQUE,
  transit_idempotency_key TEXT UNIQUE,
  receive_idempotency_key TEXT UNIQUE,
  inspect_idempotency_key TEXT UNIQUE,
  resolve_idempotency_key TEXT UNIQUE,
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  requested_at TEXT NOT NULL,
  authorized_at TEXT,
  in_transit_at TEXT,
  received_at TEXT,
  inspected_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, order_id),
  CHECK ((status IN ('resolved', 'rejected') AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status NOT IN ('resolved', 'rejected') AND resolution IS NULL AND resolved_at IS NULL))
);

CREATE INDEX idx_return_requests_order ON return_requests(order_id, created_at, id);
CREATE INDEX idx_return_requests_work ON return_requests(status, updated_at, id);

CREATE TABLE return_request_lines (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 100),
  return_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  order_item_id INTEGER NOT NULL,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  requested_quantity INTEGER NOT NULL CHECK (requested_quantity > 0),
  eligible_quantity INTEGER NOT NULL CHECK (eligible_quantity >= requested_quantity),
  received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (
    received_quantity >= 0 AND received_quantity <= requested_quantity
  ),
  inspection TEXT NOT NULL DEFAULT 'pending' CHECK (
    inspection IN ('pending', 'restock', 'damaged', 'reject')
  ),
  resolution TEXT NOT NULL DEFAULT 'pending' CHECK (
    resolution IN ('pending', 'refund', 'exchange', 'reject')
  ),
  unit_amount_cents INTEGER NOT NULL CHECK (unit_amount_cents >= 0),
  exchange_variant_id INTEGER REFERENCES product_variants(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (return_id, order_item_id),
  FOREIGN KEY (return_id, order_id) REFERENCES return_requests(id, order_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_item_id, order_id) REFERENCES order_items(id, order_id) ON DELETE RESTRICT,
  CHECK ((resolution = 'exchange' AND exchange_variant_id IS NOT NULL)
    OR (resolution <> 'exchange' AND exchange_variant_id IS NULL)),
  CHECK ((inspection = 'pending' AND resolution = 'pending')
    OR (inspection <> 'pending' AND resolution <> 'pending'))
);

CREATE INDEX idx_return_request_lines_order_item
  ON return_request_lines(order_item_id, return_id);
CREATE INDEX idx_return_request_lines_variant
  ON return_request_lines(variant_id, return_id);

-- La lectura de elegibilidad mejora UX, pero esta guarda decide la carrera:
-- dos solicitudes simultáneas nunca reclaman la misma unidad entregada.
CREATE TRIGGER return_request_line_quantity_guard
BEFORE INSERT ON return_request_lines
BEGIN
  SELECT RAISE(ABORT, 'return_line_order_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM return_requests r
    JOIN order_items oi ON oi.id=NEW.order_item_id AND oi.order_id=r.order_id
    WHERE r.id=NEW.return_id AND r.order_id=NEW.order_id
  );

  SELECT RAISE(ABORT, 'return_line_quantity_conflict')
  WHERE NEW.requested_quantity + COALESCE((
    SELECT sum(existing.requested_quantity)
    FROM return_request_lines existing
    JOIN return_requests claimed ON claimed.id=existing.return_id
    WHERE existing.order_item_id=NEW.order_item_id
      AND claimed.status NOT IN ('rejected','cancelled')
  ), 0) > COALESCE((
    SELECT sum(fi.quantity)
    FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id
    WHERE fi.order_item_id=NEW.order_item_id AND f.status='delivered'
  ), 0);
END;

CREATE TABLE return_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL REFERENCES return_requests(id) ON DELETE RESTRICT,
  transition TEXT NOT NULL CHECK (transition IN (
    'created', 'authorized', 'in_transit', 'received', 'inspected',
    'resolved', 'rejected', 'cancelled'
  )),
  from_status TEXT,
  to_status TEXT NOT NULL,
  version_after INTEGER NOT NULL CHECK (version_after >= 1),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('customer', 'admin', 'system', 'provider')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  occurred_at TEXT NOT NULL,
  UNIQUE (return_id, version_after)
);

CREATE INDEX idx_return_events_return ON return_events(return_id, version_after, id);

CREATE TABLE return_inventory_movements (
  return_id TEXT NOT NULL REFERENCES return_requests(id) ON DELETE RESTRICT,
  return_line_id TEXT NOT NULL REFERENCES return_request_lines(id) ON DELETE RESTRICT,
  location_movement_id INTEGER NOT NULL REFERENCES inventory_location_movements(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (return_id, return_line_id)
);

CREATE TABLE return_exchange_lines (
  return_id TEXT NOT NULL REFERENCES return_requests(id) ON DELETE RESTRICT,
  return_line_id TEXT NOT NULL REFERENCES return_request_lines(id) ON DELETE RESTRICT,
  source_variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  exchange_variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reserved', 'fulfilled', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (return_id, return_line_id)
);
