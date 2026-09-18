-- Outbox transaccional de eventos (R1.7; diseño aprobado en ADR-0007).
-- Aditiva: no cambia ninguna tabla ni dato existente.

CREATE TABLE event_outbox_events (
  event_id TEXT NOT NULL PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version >= 1),
  occurred_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL
    CHECK (actor_kind IN ('system', 'customer', 'admin', 'provider')),
  actor_id TEXT NOT NULL,
  actor_label TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_reference TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_event_outbox_events_correlation
  ON event_outbox_events(correlation_id, occurred_at, event_id);

CREATE TABLE event_outbox_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES event_outbox_events(event_id) ON DELETE CASCADE,
  consumer_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 8),
  available_at TEXT NOT NULL,
  claimed_at TEXT,
  claim_expires_at TEXT,
  claimed_by TEXT,
  delivered_at TEXT,
  dead_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  last_error_message TEXT CHECK (last_error_message IS NULL OR length(last_error_message) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, consumer_id),
  CHECK (
    (status = 'pending' AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND claimed_by IS NULL AND delivered_at IS NULL AND dead_at IS NULL)
    OR
    (status = 'processing' AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL
      AND claimed_by IS NOT NULL AND delivered_at IS NULL AND dead_at IS NULL)
    OR
    (status = 'delivered' AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND claimed_by IS NULL AND delivered_at IS NOT NULL AND dead_at IS NULL)
    OR
    (status = 'dead' AND claimed_at IS NULL AND claim_expires_at IS NULL
      AND claimed_by IS NULL AND delivered_at IS NULL AND dead_at IS NOT NULL)
  )
);

CREATE INDEX idx_event_outbox_deliveries_claim
  ON event_outbox_deliveries(available_at, id)
  WHERE status = 'pending';

CREATE INDEX idx_event_outbox_deliveries_lease
  ON event_outbox_deliveries(claim_expires_at, id)
  WHERE status = 'processing';

CREATE INDEX idx_event_outbox_deliveries_event
  ON event_outbox_deliveries(event_id, consumer_id);

CREATE INDEX idx_event_outbox_deliveries_retention
  ON event_outbox_deliveries(delivered_at, id)
  WHERE status = 'delivered';
