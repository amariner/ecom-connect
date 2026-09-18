-- Holds e incidencias operativas de pedido (R3.4; ADR-0020).
--
-- Migracion expand-only. El estado comercial de `orders` no cambia y no se
-- crea ningun hold durante el rollout. Un Worker anterior ignora estas tablas.

CREATE TABLE order_holds (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 8 AND 120),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'resolved')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'automatic')),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'payment_review', 'inventory_issue', 'address_issue', 'customer_request',
    'fulfillment_issue', 'risk_review', 'other'
  )),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('admin', 'system')),
  owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) BETWEEN 1 AND 80),
  owner_label TEXT NOT NULL CHECK (length(trim(owner_label)) BETWEEN 1 AND 120),
  due_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 160),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_code TEXT CHECK (resolution_code IN (
    'cleared', 'order_cancelled', 'duplicate', 'superseded'
  )),
  UNIQUE (id, order_id),
  CHECK (
    (status = 'active' AND resolved_at IS NULL AND resolution_code IS NULL)
    OR
    (status = 'resolved' AND resolved_at IS NOT NULL AND resolution_code IS NOT NULL)
  )
);

CREATE INDEX idx_order_holds_order_active
  ON order_holds(order_id, created_at, id)
  WHERE status = 'active';

CREATE INDEX idx_order_holds_sla_active
  ON order_holds(due_at, order_id, id)
  WHERE status = 'active';

CREATE INDEX idx_order_holds_owner_active
  ON order_holds(owner_kind, owner_id, due_at, id)
  WHERE status = 'active';

CREATE TABLE order_hold_events (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 8 AND 140),
  hold_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'assigned', 'resolved')),
  hold_version INTEGER NOT NULL
    CHECK (typeof(hold_version) = 'integer' AND hold_version >= 1),
  source TEXT CHECK (source IN ('manual', 'automatic')),
  reason_code TEXT CHECK (reason_code IN (
    'payment_review', 'inventory_issue', 'address_issue', 'customer_request',
    'fulfillment_issue', 'risk_review', 'other'
  )),
  owner_kind TEXT CHECK (owner_kind IN ('admin', 'system')),
  owner_id TEXT CHECK (owner_id IS NULL OR length(trim(owner_id)) BETWEEN 1 AND 80),
  owner_label TEXT CHECK (owner_label IS NULL OR length(trim(owner_label)) BETWEEN 1 AND 120),
  resolution_code TEXT CHECK (resolution_code IN (
    'cleared', 'order_cancelled', 'duplicate', 'superseded'
  )),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'system')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 100),
  actor_label TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (hold_id, hold_version),
  FOREIGN KEY (hold_id, order_id)
    REFERENCES order_holds(id, order_id) ON DELETE RESTRICT,
  CHECK (
    (event_type = 'created' AND hold_version = 1
      AND source IS NOT NULL AND reason_code IS NOT NULL
      AND owner_kind IS NOT NULL AND owner_id IS NOT NULL AND owner_label IS NOT NULL
      AND resolution_code IS NULL)
    OR
    (event_type = 'assigned' AND hold_version >= 2
      AND source IS NULL AND reason_code IS NULL
      AND owner_kind IS NOT NULL AND owner_id IS NOT NULL AND owner_label IS NOT NULL
      AND resolution_code IS NULL)
    OR
    (event_type = 'resolved' AND hold_version >= 2
      AND source IS NULL AND reason_code IS NULL
      AND owner_kind IS NULL AND owner_id IS NULL AND owner_label IS NULL
      AND resolution_code IS NOT NULL)
  )
);

CREATE INDEX idx_order_hold_events_order_created
  ON order_hold_events(order_id, created_at DESC, id DESC);

CREATE INDEX idx_order_hold_events_hold_version
  ON order_hold_events(hold_id, hold_version DESC);
