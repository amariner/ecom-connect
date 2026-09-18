-- Ubicaciones de inventario R3.6. Expand-only: el ledger global sigue siendo
-- compatible y se proyecta íntegramente sobre la ubicación principal.

CREATE TABLE inventory_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE
    CHECK (length(code) BETWEEN 2 AND 32 AND code = lower(code) AND code NOT GLOB '*[^a-z0-9-]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 100),
  kind TEXT NOT NULL CHECK (kind IN ('warehouse', 'store')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  timezone TEXT NOT NULL DEFAULT 'Europe/Madrid' CHECK (length(trim(timezone)) BETWEEN 3 AND 64),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_inventory_locations_primary
  ON inventory_locations(is_primary) WHERE is_primary = 1;
CREATE INDEX idx_inventory_locations_status
  ON inventory_locations(status, kind, name, id);

INSERT INTO inventory_locations (
  code, name, kind, status, is_primary, timezone, created_at, updated_at
) VALUES (
  'principal', 'Ubicación principal', 'warehouse', 'active', 1,
  'Europe/Madrid', datetime('now'), datetime('now')
);

CREATE TABLE inventory_location_balances (
  location_id INTEGER NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  on_hand INTEGER NOT NULL CHECK (on_hand >= 0),
  reserved INTEGER NOT NULL CHECK (reserved >= 0 AND reserved <= on_hand),
  movement_version INTEGER NOT NULL CHECK (movement_version >= 1),
  reservation_version INTEGER NOT NULL CHECK (reservation_version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (location_id, variant_id)
);

CREATE INDEX idx_inventory_location_balances_variant
  ON inventory_location_balances(variant_id, location_id);

INSERT INTO inventory_location_balances (
  location_id, variant_id, on_hand, reserved, movement_version,
  reservation_version, updated_at
)
SELECT l.id, b.variant_id, b.on_hand, b.reserved, b.version,
  b.reservation_version, b.updated_at
FROM inventory_locations l CROSS JOIN inventory_balances b
WHERE l.is_primary = 1
ORDER BY b.variant_id;

CREATE TABLE inventory_location_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  source_movement_id INTEGER UNIQUE REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN (
    'legacy_opening_balance', 'sale', 'cancellation_restock', 'return_restock',
    'manual_adjustment', 'reconciliation_correction', 'damage'
  )),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  version_after INTEGER NOT NULL CHECK (version_after >= 1),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'admin', 'provider')),
  actor_id TEXT NOT NULL,
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (location_id, variant_id, version_after)
);

CREATE INDEX idx_inventory_location_movements_history
  ON inventory_location_movements(location_id, variant_id, version_after, id);

INSERT INTO inventory_location_movements (
  location_id, variant_id, source_movement_id, delta, reason, balance_after,
  version_after, actor_kind, actor_id, reference_type, reference_id,
  idempotency_key, correlation_id, occurred_at, created_at
)
SELECT l.id, m.variant_id, m.id, m.delta, m.reason, m.balance_after,
  m.version_after, m.actor_kind, m.actor_id, m.reference_type, m.reference_id,
  'location:principal:' || m.idempotency_key, m.correlation_id,
  m.occurred_at, m.created_at
FROM inventory_locations l CROSS JOIN inventory_movements m
WHERE l.is_primary = 1
ORDER BY m.id;

CREATE TRIGGER inventory_location_balance_insert AFTER INSERT ON inventory_balances BEGIN INSERT INTO inventory_location_balances (location_id, variant_id, on_hand, reserved, movement_version, reservation_version, updated_at) SELECT id, NEW.variant_id, NEW.on_hand, NEW.reserved, NEW.version, NEW.reservation_version, NEW.updated_at FROM inventory_locations WHERE is_primary = 1; END;
CREATE TRIGGER inventory_location_balance_update AFTER UPDATE OF on_hand, reserved, version, reservation_version ON inventory_balances BEGIN UPDATE inventory_location_balances SET on_hand = NEW.on_hand, reserved = NEW.reserved, movement_version = NEW.version, reservation_version = NEW.reservation_version, updated_at = NEW.updated_at WHERE variant_id = NEW.variant_id AND location_id = (SELECT id FROM inventory_locations WHERE is_primary = 1); END;
CREATE TRIGGER inventory_location_movement_insert AFTER INSERT ON inventory_movements BEGIN INSERT INTO inventory_location_movements (location_id, variant_id, source_movement_id, delta, reason, balance_after, version_after, actor_kind, actor_id, reference_type, reference_id, idempotency_key, correlation_id, occurred_at, created_at) SELECT id, NEW.variant_id, NEW.id, NEW.delta, NEW.reason, NEW.balance_after, NEW.version_after, NEW.actor_kind, NEW.actor_id, NEW.reference_type, NEW.reference_id, 'location:principal:' || NEW.idempotency_key, NEW.correlation_id, NEW.occurred_at, NEW.created_at FROM inventory_locations WHERE is_primary = 1; END;
