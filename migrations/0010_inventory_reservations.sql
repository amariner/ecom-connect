-- Reservas de inventario por variante (R2.8; ADR-0014).
--
-- Aditiva y apagada por capacidad. `version` continúa perteneciendo al ledger
-- físico; `reservation_version` serializa cambios de `reserved` sin crear
-- huecos en `inventory_movements`.

ALTER TABLE inventory_balances ADD COLUMN reservation_version INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(reservation_version) = 'integer' AND reservation_version >= 1);

CREATE TABLE inventory_reservations (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 120),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('cart', 'checkout', 'order')),
  owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'consumed', 'expired')),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  released_at TEXT,
  consumed_at TEXT,
  expired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_type, owner_id),
  CHECK (
    (status = 'active' AND released_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL AND consumed_at IS NULL AND expired_at IS NULL)
    OR (status = 'consumed' AND released_at IS NULL AND consumed_at IS NOT NULL AND expired_at IS NULL)
    OR (status = 'expired' AND released_at IS NULL AND consumed_at IS NULL AND expired_at IS NOT NULL)
  )
);

CREATE TABLE inventory_reservation_lines (
  reservation_id TEXT NOT NULL
    REFERENCES inventory_reservations(id) ON DELETE RESTRICT,
  variant_id INTEGER NOT NULL
    REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL
    CHECK (typeof(quantity) = 'integer' AND quantity > 0),
  PRIMARY KEY (reservation_id, variant_id)
);

-- Historial de la cabecera: una transición terminal ocupa exactamente la
-- siguiente versión. El trigger convierte una lectura obsoleta en aborto de la
-- batch completa, incluyendo pedido/evento/auditoría si forman parte de ella.
CREATE TABLE inventory_reservation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL
    REFERENCES inventory_reservations(id) ON DELETE RESTRICT,
  transition TEXT NOT NULL CHECK (transition IN ('released', 'consumed', 'expired')),
  from_status TEXT NOT NULL CHECK (from_status = 'active'),
  to_status TEXT NOT NULL CHECK (to_status = transition),
  version_after INTEGER NOT NULL
    CHECK (typeof(version_after) = 'integer' AND version_after >= 2),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  occurred_at TEXT NOT NULL,
  UNIQUE (reservation_id, version_after)
);

-- D1 remoto requiere una sola línea y un único END en la ruta de
-- `migrations apply`; SELECT RAISE ... WHERE evita el CASE anidado equivalente.
CREATE TRIGGER inventory_reservation_event_guard BEFORE INSERT ON inventory_reservation_events BEGIN SELECT RAISE(ABORT, 'inventory_reservation_conflict') WHERE NOT EXISTS (SELECT 1 FROM inventory_reservations r WHERE r.id = NEW.reservation_id AND ((r.status = 'active' AND r.version + 1 = NEW.version_after AND ((NEW.transition = 'expired' AND r.expires_at <= NEW.occurred_at) OR (NEW.transition = 'consumed' AND r.expires_at > NEW.occurred_at) OR NEW.transition = 'released')) OR (r.status = NEW.transition AND r.version >= NEW.version_after))); END;

-- Este historial es además la guarda optimista del balance reservado. Se
-- inserta antes del UPDATE: versión repetida aborta una carrera y los triggers
-- impiden registrar un resultado que no corresponda al balance vigente.
CREATE TABLE inventory_reservation_balance_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL,
  variant_id INTEGER NOT NULL,
  transition TEXT NOT NULL CHECK (transition IN ('created', 'released', 'consumed', 'expired')),
  quantity_delta INTEGER NOT NULL CHECK (
    typeof(quantity_delta) = 'integer'
    AND quantity_delta <> 0
    AND ((transition = 'created' AND quantity_delta > 0)
      OR (transition <> 'created' AND quantity_delta < 0))
  ),
  reserved_after INTEGER NOT NULL
    CHECK (typeof(reserved_after) = 'integer' AND reserved_after >= 0),
  reservation_version_after INTEGER NOT NULL
    CHECK (typeof(reservation_version_after) = 'integer' AND reservation_version_after >= 2),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (reservation_id, variant_id)
    REFERENCES inventory_reservation_lines(reservation_id, variant_id) ON DELETE RESTRICT,
  UNIQUE (variant_id, reservation_version_after),
  UNIQUE (reservation_id, variant_id, transition)
);

CREATE TRIGGER inventory_reservation_balance_event_guard BEFORE INSERT ON inventory_reservation_balance_events BEGIN SELECT RAISE(ABORT, 'inventory_reservation_balance_conflict') WHERE NOT EXISTS (SELECT 1 FROM inventory_balances b JOIN inventory_reservations r ON r.id = NEW.reservation_id JOIN inventory_reservation_lines l ON l.reservation_id = r.id AND l.variant_id = NEW.variant_id WHERE b.variant_id = NEW.variant_id AND NEW.quantity_delta IN (l.quantity, -l.quantity) AND ((b.reservation_version + 1 = NEW.reservation_version_after AND b.reserved + NEW.quantity_delta = NEW.reserved_after AND NEW.reserved_after <= b.on_hand) OR b.reservation_version >= NEW.reservation_version_after) AND ((NEW.transition = 'created' AND r.version >= 1) OR (NEW.transition <> 'created' AND EXISTS (SELECT 1 FROM inventory_reservation_events e WHERE e.reservation_id = r.id AND e.transition = NEW.transition AND e.occurred_at = NEW.occurred_at)))); END;

CREATE INDEX idx_inventory_reservations_expiry
  ON inventory_reservations(expires_at, id)
  WHERE status = 'active';
CREATE INDEX idx_inventory_reservation_lines_variant
  ON inventory_reservation_lines(variant_id, reservation_id);
CREATE INDEX idx_inventory_reservation_events_reservation
  ON inventory_reservation_events(reservation_id, version_after);
CREATE INDEX idx_inventory_reservation_balance_events_reservation
  ON inventory_reservation_balance_events(reservation_id, id);
