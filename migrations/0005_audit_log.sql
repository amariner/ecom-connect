-- Registro de auditoría transversal (R1.8).
-- Aditiva: no modifica tablas existentes ni expone una ruta de lectura.

CREATE TABLE audit_log (
  audit_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(audit_id) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL
    CHECK (actor_kind IN ('system', 'customer', 'admin', 'provider')),
  actor_id TEXT NOT NULL
    CHECK (length(actor_id) BETWEEN 1 AND 100),
  actor_label TEXT
    CHECK (actor_label IS NULL OR length(actor_label) BETWEEN 1 AND 120),
  action TEXT NOT NULL
    CHECK (length(action) BETWEEN 3 AND 100),
  entity_type TEXT NOT NULL
    CHECK (length(entity_type) BETWEEN 1 AND 80),
  entity_id TEXT NOT NULL
    CHECK (length(entity_id) BETWEEN 1 AND 100),
  entity_reference TEXT
    CHECK (entity_reference IS NULL OR length(entity_reference) BETWEEN 1 AND 160),
  correlation_id TEXT NOT NULL
    CHECK (length(correlation_id) BETWEEN 1 AND 160),
  source_event_id TEXT UNIQUE
    CHECK (source_event_id IS NULL OR length(source_event_id) BETWEEN 1 AND 80),
  diff_json TEXT NOT NULL
    CHECK (
      json_valid(diff_json)
      AND json_type(diff_json) = 'object'
      AND length(diff_json) <= 4096
    ),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_log_entity
  ON audit_log(entity_type, entity_id, occurred_at, audit_id);

CREATE INDEX idx_audit_log_correlation
  ON audit_log(correlation_id, occurred_at, audit_id);
