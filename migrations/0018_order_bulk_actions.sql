-- Acciones masivas seguras sobre pedidos (R3.5; ADR-0021).
--
-- Migracion expand-only. No crea lotes ni cambia pedidos al aplicarse. Workers
-- anteriores ignoran las tablas y el runtime nuevo permanece tras ORD-011.

CREATE TABLE order_bulk_batches (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 8 AND 64),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'add_tag', 'remove_tag', 'create_hold'
  )),
  tag_id INTEGER REFERENCES order_tags(id) ON DELETE RESTRICT,
  hold_reason_code TEXT CHECK (hold_reason_code IN (
    'payment_review', 'inventory_issue', 'address_issue', 'customer_request',
    'fulfillment_issue', 'risk_review', 'other'
  )),
  hold_owner_kind TEXT CHECK (hold_owner_kind IN ('admin', 'system')),
  hold_owner_id TEXT
    CHECK (hold_owner_id IS NULL OR length(trim(hold_owner_id)) BETWEEN 1 AND 80),
  hold_owner_label TEXT
    CHECK (hold_owner_label IS NULL OR length(trim(hold_owner_label)) BETWEEN 1 AND 120),
  hold_due_at TEXT,
  selection_fingerprint TEXT NOT NULL
    CHECK (length(selection_fingerprint) = 71 AND selection_fingerprint GLOB 'sha256:[0-9a-f]*'),
  preview_fingerprint TEXT NOT NULL UNIQUE
    CHECK (length(preview_fingerprint) = 71 AND preview_fingerprint GLOB 'sha256:[0-9a-f]*'),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'system')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 100),
  actor_label TEXT CHECK (actor_label IS NULL OR length(trim(actor_label)) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'completed', 'completed_with_errors'
  )),
  execution_run_id TEXT,
  replay_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(replay_count) = 'integer' AND replay_count BETWEEN 0 AND 20),
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (expires_at > observed_at),
  CHECK (
    (action_type IN ('add_tag', 'remove_tag')
      AND tag_id IS NOT NULL
      AND hold_reason_code IS NULL AND hold_owner_kind IS NULL
      AND hold_owner_id IS NULL AND hold_owner_label IS NULL AND hold_due_at IS NULL)
    OR
    (action_type = 'create_hold'
      AND tag_id IS NULL
      AND hold_reason_code IS NOT NULL AND hold_owner_kind IS NOT NULL
      AND hold_owner_id IS NOT NULL AND hold_owner_label IS NOT NULL AND hold_due_at IS NOT NULL)
  ),
  CHECK (
    (status = 'pending' AND execution_run_id IS NULL AND completed_at IS NULL)
    OR (status = 'running' AND execution_run_id IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('completed', 'completed_with_errors') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_order_bulk_batches_status
  ON order_bulk_batches(status, updated_at, id);

CREATE INDEX idx_order_bulk_batches_selection
  ON order_bulk_batches(selection_fingerprint, created_at, id);

CREATE INDEX idx_order_bulk_batches_retention
  ON order_bulk_batches(completed_at, id)
  WHERE status IN ('completed', 'completed_with_errors');

CREATE TABLE order_bulk_batch_rows (
  batch_id TEXT NOT NULL REFERENCES order_bulk_batches(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL
    CHECK (typeof(order_id) = 'integer' AND order_id >= 1),
  selection_position INTEGER NOT NULL
    CHECK (typeof(selection_position) = 'integer' AND selection_position BETWEEN 1 AND 500),
  observed_version INTEGER
    CHECK (observed_version IS NULL OR (typeof(observed_version) = 'integer' AND observed_version >= 1)),
  observed_status TEXT CHECK (observed_status IN (
    'pending', 'paid', 'shipped', 'delivered', 'cancelled'
  )),
  preview_eligibility TEXT NOT NULL CHECK (preview_eligibility IN ('ready', 'skipped')),
  preview_reason TEXT NOT NULL CHECK (preview_reason IN (
    'ready', 'order_not_found', 'already_applied', 'already_absent',
    'active_hold_same_reason', 'status_not_supported'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'pending', 'applied', 'replayed', 'skipped', 'conflict',
    'retryable_failure', 'permanent_failure'
  )),
  result_code TEXT CHECK (result_code IN (
    'applied', 'replayed_same_batch', 'already_applied', 'already_absent',
    'active_hold_same_reason', 'status_not_supported', 'order_not_found',
    'tag_not_found', 'hold_due_elapsed', 'precondition_changed',
    'retryable_failure', 'permanent_failure'
  )),
  evidence_type TEXT CHECK (evidence_type IN ('order_tag_event', 'order_hold')),
  evidence_id TEXT
    CHECK (evidence_id IS NULL OR length(trim(evidence_id)) BETWEEN 1 AND 140),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 160),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(attempt_count) = 'integer' AND attempt_count BETWEEN 0 AND 8),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (batch_id, order_id),
  UNIQUE (batch_id, selection_position),
  CHECK (
    (preview_eligibility = 'ready' AND preview_reason = 'ready')
    OR (preview_eligibility = 'skipped' AND preview_reason <> 'ready')
  ),
  CHECK (
    (observed_version IS NULL AND observed_status IS NULL)
    OR (observed_version IS NOT NULL AND observed_status IS NOT NULL)
  ),
  CHECK (
    (outcome IN ('pending', 'retryable_failure') AND completed_at IS NULL)
    OR (outcome NOT IN ('pending', 'retryable_failure') AND completed_at IS NOT NULL)
  ),
  CHECK (
    (outcome IN ('applied', 'replayed')
      AND evidence_type IS NOT NULL AND evidence_id IS NOT NULL)
    OR (outcome NOT IN ('applied', 'replayed')
      AND evidence_type IS NULL AND evidence_id IS NULL)
  )
);

CREATE INDEX idx_order_bulk_rows_pending
  ON order_bulk_batch_rows(batch_id, selection_position)
  WHERE outcome IN ('pending', 'retryable_failure');

CREATE INDEX idx_order_bulk_rows_order
  ON order_bulk_batch_rows(order_id, created_at, batch_id);
