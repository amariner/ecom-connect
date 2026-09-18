-- R5.4d: sustitución atómica de challenges y throttling durable sin PII.
-- Expand-only: no habilita rutas, proveedor ni capacidades por sí sola.

CREATE TABLE customer_auth_throttle_events (
  idempotency_key TEXT PRIMARY KEY CHECK (
    length(idempotency_key) BETWEEN 8 AND 160
      AND idempotency_key GLOB '[a-z]*'
      AND idempotency_key NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(idempotency_key, '_') > 0
        OR instr(idempotency_key, ':') > 0
        OR instr(idempotency_key, '-') > 0)
  ),
  scope TEXT NOT NULL CHECK (scope IN ('contact_start', 'challenge_failure')),
  subject_digest TEXT NOT NULL CHECK (
    length(subject_digest) = 64
      AND subject_digest NOT GLOB '*[^0-9a-f]*'
  ),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'limited')),
  short_window_count INTEGER NOT NULL CHECK (
    typeof(short_window_count) = 'integer' AND short_window_count >= 1
  ),
  daily_window_count INTEGER NOT NULL CHECK (
    typeof(daily_window_count) = 'integer'
      AND daily_window_count >= short_window_count
  ),
  occurred_at TEXT NOT NULL CHECK (
    length(occurred_at) = 24
      AND substr(occurred_at, -1) = 'Z'
      AND julianday(occurred_at) IS NOT NULL
  ),
  expires_at TEXT NOT NULL CHECK (
    length(expires_at) = 24
      AND substr(expires_at, -1) = 'Z'
      AND julianday(expires_at) IS NOT NULL
      AND julianday(expires_at) > julianday(occurred_at)
      AND (julianday(expires_at) - julianday(occurred_at)) * 86400000
        <= 86400000
  ),
  CHECK (
    (scope = 'contact_start'
      AND short_window_count <= daily_window_count
      AND ((decision = 'accepted'
          AND short_window_count <= 3 AND daily_window_count <= 10)
        OR (decision = 'limited'
          AND (short_window_count > 3 OR daily_window_count > 10))))
    OR
    (scope = 'challenge_failure'
      AND short_window_count = daily_window_count
      AND ((decision = 'accepted' AND short_window_count < 5)
        OR (decision = 'limited' AND short_window_count >= 5)))
  )
);

CREATE INDEX idx_customer_auth_throttle_subject_window
  ON customer_auth_throttle_events(scope, subject_digest, occurred_at);
CREATE INDEX idx_customer_auth_throttle_expiry
  ON customer_auth_throttle_events(expires_at);

CREATE TRIGGER customer_auth_throttle_update_guard
BEFORE UPDATE ON customer_auth_throttle_events
BEGIN
  SELECT RAISE(ABORT, 'customer_auth_throttle_immutable');
END;

-- Ledger canónico para que revoke-all sea idempotente incluso cuando el target
-- no tiene familias. Solo conserva referencias operacionales opacas.
CREATE TABLE customer_auth_revoke_all_operations (
  idempotency_key TEXT PRIMARY KEY CHECK (
    length(idempotency_key) BETWEEN 8 AND 160
      AND idempotency_key = trim(idempotency_key)
      AND idempotency_key GLOB '[a-z]*'
      AND idempotency_key NOT GLOB '*[^a-z0-9_:/-]*'
      AND (instr(idempotency_key, '_') > 0
        OR instr(idempotency_key, ':') > 0
        OR instr(idempotency_key, '/') > 0
        OR instr(idempotency_key, '-') > 0)
  ),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('identity', 'profile')),
  target_id TEXT NOT NULL CHECK (
    length(target_id) BETWEEN 3 AND 200
      AND target_id GLOB '[a-z]*'
      AND target_id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(target_id, '_') > 0
        OR instr(target_id, ':') > 0
        OR instr(target_id, '-') > 0)
  ),
  occurred_at TEXT NOT NULL CHECK (
    length(occurred_at) BETWEEN 20 AND 32
      AND substr(occurred_at, -1) = 'Z'
      AND julianday(occurred_at) IS NOT NULL
  ),
  reason_id TEXT NOT NULL CHECK (
    length(reason_id) BETWEEN 3 AND 120
      AND reason_id GLOB '[a-z]*'
      AND reason_id NOT GLOB '*[^a-z0-9._:-]*'
      AND (instr(reason_id, '.') > 0
        OR instr(reason_id, '_') > 0
        OR instr(reason_id, ':') > 0
        OR instr(reason_id, '-') > 0)
  ),
  audit_id TEXT NOT NULL UNIQUE
    REFERENCES audit_log(audit_id) ON DELETE RESTRICT,
  audit_correlation_id TEXT NOT NULL CHECK (
    length(audit_correlation_id) BETWEEN 3 AND 160
      AND audit_correlation_id GLOB '[a-z]*'
      AND audit_correlation_id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(audit_correlation_id, '_') > 0
        OR instr(audit_correlation_id, ':') > 0
        OR instr(audit_correlation_id, '-') > 0)
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  families_revoked INTEGER NOT NULL CHECK (
    typeof(families_revoked) = 'integer' AND families_revoked >= 0
  ),
  sessions_revoked INTEGER NOT NULL CHECK (
    typeof(sessions_revoked) = 'integer' AND sessions_revoked >= 0
  ),
  created_at TEXT NOT NULL CHECK (created_at = occurred_at)
);

CREATE TRIGGER customer_auth_revoke_all_operation_update_guard
BEFORE UPDATE ON customer_auth_revoke_all_operations
BEGIN
  SELECT RAISE(ABORT, 'customer_auth_revoke_all_operation_transition_conflict')
  WHERE OLD.status <> 'pending' OR NEW.status <> 'completed'
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.target_kind <> OLD.target_kind OR NEW.target_id <> OLD.target_id
    OR NEW.occurred_at <> OLD.occurred_at OR NEW.reason_id <> OLD.reason_id
    OR NEW.audit_id <> OLD.audit_id
    OR NEW.audit_correlation_id <> OLD.audit_correlation_id
    OR NEW.families_revoked <> OLD.families_revoked
    OR NEW.sessions_revoked <> OLD.sessions_revoked
    OR NEW.created_at <> OLD.created_at;
END;

-- Confirmación durable de que el proveedor aceptó la entrega. No contiene
-- proof, URL, destino, email ni respuesta libre del proveedor.
CREATE TABLE customer_passwordless_challenge_deliveries (
  challenge_id TEXT PRIMARY KEY
    REFERENCES customer_passwordless_challenges(id) ON DELETE RESTRICT,
  provider_reference TEXT NOT NULL UNIQUE CHECK (
    length(provider_reference) BETWEEN 3 AND 200
      AND provider_reference GLOB '[a-z]*'
      AND provider_reference NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(provider_reference, '_') > 0
        OR instr(provider_reference, ':') > 0
        OR instr(provider_reference, '-') > 0)
  ),
  accepted_at TEXT NOT NULL CHECK (
    length(accepted_at) BETWEEN 20 AND 32
      AND substr(accepted_at, -1) = 'Z'
      AND julianday(accepted_at) IS NOT NULL
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(idempotency_key) BETWEEN 8 AND 160
      AND idempotency_key = trim(idempotency_key)
      AND idempotency_key GLOB '[a-z]*'
      AND idempotency_key NOT GLOB '*[^a-z0-9_:/-]*'
      AND (instr(idempotency_key, '_') > 0
        OR instr(idempotency_key, ':') > 0
        OR instr(idempotency_key, '/') > 0
        OR instr(idempotency_key, '-') > 0)
  ),
  created_at TEXT NOT NULL CHECK (created_at = accepted_at)
);

CREATE TRIGGER customer_passwordless_delivery_insert_guard
BEFORE INSERT ON customer_passwordless_challenge_deliveries
BEGIN
  SELECT RAISE(ABORT, 'customer_passwordless_delivery_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_passwordless_challenges challenge
    WHERE challenge.id = NEW.challenge_id
      AND challenge.provider_reference = NEW.provider_reference
      AND challenge.status = 'pending'
      AND julianday(NEW.accepted_at) >= julianday(challenge.requested_at)
      AND julianday(NEW.accepted_at) < julianday(challenge.expires_at)
  );
END;

CREATE TRIGGER customer_passwordless_delivery_update_guard
BEFORE UPDATE ON customer_passwordless_challenge_deliveries
BEGIN
  SELECT RAISE(ABORT, 'customer_passwordless_delivery_immutable');
END;

CREATE TRIGGER customer_passwordless_delivery_delete_guard
BEFORE DELETE ON customer_passwordless_challenge_deliveries
BEGIN
  SELECT RAISE(ABORT, 'customer_passwordless_delivery_immutable');
END;

CREATE TRIGGER customer_passwordless_consumption_delivery_guard
BEFORE UPDATE OF status ON customer_passwordless_challenges
WHEN OLD.status = 'pending' AND NEW.status = 'consumed'
BEGIN
  SELECT RAISE(ABORT, 'customer_passwordless_delivery_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_passwordless_challenge_deliveries delivery
    WHERE delivery.challenge_id = OLD.id
      AND delivery.provider_reference = OLD.provider_reference
      AND julianday(delivery.accepted_at) <= julianday(NEW.consumed_at)
  );
END;

-- Gate operacional singleton de CUS-003. La ausencia de fila significa
-- installed/version 0: aplicar 0040 nunca activa la capacidad por sí solo.
CREATE TABLE customer_auth_capability_operations (
  idempotency_key TEXT PRIMARY KEY CHECK (
    length(idempotency_key) BETWEEN 8 AND 160
      AND idempotency_key = trim(idempotency_key)
      AND idempotency_key GLOB '[a-z]*'
      AND idempotency_key NOT GLOB '*[^a-z0-9_:/-]*'
      AND (instr(idempotency_key, '_') > 0
        OR instr(idempotency_key, ':') > 0
        OR instr(idempotency_key, '/') > 0
        OR instr(idempotency_key, '-') > 0)
  ),
  capability_id TEXT NOT NULL CHECK (capability_id = 'CUS-003'),
  from_state TEXT NOT NULL CHECK (from_state IN ('installed', 'active')),
  to_state TEXT NOT NULL CHECK (to_state IN ('installed', 'active')),
  expected_version INTEGER NOT NULL CHECK (
    typeof(expected_version) = 'integer' AND expected_version >= 0
  ),
  resulting_version INTEGER NOT NULL CHECK (
    typeof(resulting_version) = 'integer'
      AND resulting_version = expected_version + 1
  ),
  occurred_at TEXT NOT NULL CHECK (
    length(occurred_at) BETWEEN 20 AND 32
      AND substr(occurred_at, -1) = 'Z'
      AND julianday(occurred_at) IS NOT NULL
  ),
  audit_id TEXT NOT NULL UNIQUE
    REFERENCES audit_log(audit_id) ON DELETE RESTRICT,
  audit_correlation_id TEXT NOT NULL CHECK (
    length(audit_correlation_id) BETWEEN 3 AND 160
      AND audit_correlation_id GLOB '[a-z]*'
      AND audit_correlation_id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(audit_correlation_id, '_') > 0
        OR instr(audit_correlation_id, ':') > 0
        OR instr(audit_correlation_id, '-') > 0)
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at TEXT NOT NULL CHECK (created_at = occurred_at),
  UNIQUE (capability_id, resulting_version),
  CHECK (from_state <> to_state),
  CHECK ((from_state = 'installed' AND to_state = 'active')
    OR (from_state = 'active' AND to_state = 'installed'))
);

CREATE TABLE customer_auth_capability_state (
  capability_id TEXT PRIMARY KEY CHECK (capability_id = 'CUS-003'),
  state TEXT NOT NULL CHECK (state IN ('installed', 'active')),
  version INTEGER NOT NULL CHECK (
    typeof(version) = 'integer' AND version >= 1
  ),
  transitioned_at TEXT NOT NULL CHECK (
    length(transitioned_at) BETWEEN 20 AND 32
      AND substr(transitioned_at, -1) = 'Z'
      AND julianday(transitioned_at) IS NOT NULL
  ),
  transition_idempotency_key TEXT NOT NULL UNIQUE
    REFERENCES customer_auth_capability_operations(idempotency_key)
      ON DELETE RESTRICT,
  audit_id TEXT NOT NULL UNIQUE
    REFERENCES audit_log(audit_id) ON DELETE RESTRICT
);

CREATE TRIGGER customer_auth_capability_operation_insert_guard
BEFORE INSERT ON customer_auth_capability_operations
BEGIN
  SELECT RAISE(ABORT, 'customer_auth_capability_transition_conflict')
  WHERE NEW.status <> 'pending'
    OR NOT (
      (NEW.expected_version = 0 AND NEW.from_state = 'installed'
        AND NEW.to_state = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM customer_auth_capability_state
          WHERE capability_id = NEW.capability_id
        ))
      OR EXISTS (
        SELECT 1 FROM customer_auth_capability_state state
        WHERE state.capability_id = NEW.capability_id
          AND state.state = NEW.from_state
          AND state.version = NEW.expected_version
      )
    )
    OR (NEW.to_state = 'installed' AND EXISTS (
      SELECT 1 FROM customer_session_families WHERE status = 'active'
    ));
END;

CREATE TRIGGER customer_auth_capability_state_insert_guard
BEFORE INSERT ON customer_auth_capability_state
BEGIN
  SELECT RAISE(ABORT, 'customer_auth_capability_state_conflict')
  WHERE NEW.state <> 'active' OR NEW.version <> 1
    OR NOT EXISTS (
      SELECT 1 FROM customer_auth_capability_operations operation
      WHERE operation.idempotency_key = NEW.transition_idempotency_key
        AND operation.capability_id = NEW.capability_id
        AND operation.from_state = 'installed'
        AND operation.to_state = NEW.state
        AND operation.expected_version = 0
        AND operation.resulting_version = NEW.version
        AND operation.occurred_at = NEW.transitioned_at
        AND operation.audit_id = NEW.audit_id
        AND operation.status = 'pending'
    );
END;

CREATE TRIGGER customer_auth_capability_state_update_guard
BEFORE UPDATE ON customer_auth_capability_state
BEGIN
  SELECT RAISE(ABORT, 'customer_auth_capability_state_conflict')
  WHERE NEW.capability_id <> OLD.capability_id
    OR NEW.state = OLD.state OR NEW.version <> OLD.version + 1
    OR julianday(NEW.transitioned_at) < julianday(OLD.transitioned_at)
    OR NEW.transition_idempotency_key = OLD.transition_idempotency_key
    OR NEW.audit_id = OLD.audit_id
    OR NOT EXISTS (
      SELECT 1 FROM customer_auth_capability_operations operation
      WHERE operation.idempotency_key = NEW.transition_idempotency_key
        AND operation.capability_id = NEW.capability_id
        AND operation.from_state = OLD.state
        AND operation.to_state = NEW.state
        AND operation.expected_version = OLD.version
        AND operation.resulting_version = NEW.version
        AND operation.occurred_at = NEW.transitioned_at
        AND operation.audit_id = NEW.audit_id
        AND operation.status = 'pending'
    );
END;

CREATE TRIGGER customer_auth_capability_state_delete_guard
BEFORE DELETE ON customer_auth_capability_state
BEGIN
  SELECT RAISE(ABORT, 'customer_auth_capability_state_immutable');
END;

CREATE TRIGGER customer_auth_capability_operation_update_guard
BEFORE UPDATE ON customer_auth_capability_operations
BEGIN
  SELECT RAISE(ABORT, 'customer_auth_capability_operation_transition_conflict')
  WHERE OLD.status <> 'pending' OR NEW.status <> 'completed'
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.capability_id <> OLD.capability_id
    OR NEW.from_state <> OLD.from_state OR NEW.to_state <> OLD.to_state
    OR NEW.expected_version <> OLD.expected_version
    OR NEW.resulting_version <> OLD.resulting_version
    OR NEW.occurred_at <> OLD.occurred_at OR NEW.audit_id <> OLD.audit_id
    OR NEW.audit_correlation_id <> OLD.audit_correlation_id
    OR NEW.created_at <> OLD.created_at
    OR NOT EXISTS (
      SELECT 1 FROM customer_auth_capability_state state
      WHERE state.capability_id = NEW.capability_id
        AND state.state = NEW.to_state
        AND state.version = NEW.resulting_version
        AND state.transitioned_at = NEW.occurred_at
        AND state.transition_idempotency_key = NEW.idempotency_key
        AND state.audit_id = NEW.audit_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM audit_log audit
      WHERE audit.audit_id = NEW.audit_id
        AND audit.occurred_at = NEW.occurred_at
        AND audit.actor_kind = 'system'
        AND audit.actor_id = 'customer_auth:capability_gate'
        AND audit.actor_label IS NULL
        AND audit.action = 'auth.capability_transitioned'
        AND audit.entity_type = 'platform_capability'
        AND audit.entity_id = 'capability:cus-003'
        AND audit.entity_reference IS NULL
        AND audit.correlation_id = NEW.audit_correlation_id
        AND audit.source_event_id IS NULL
        AND audit.diff_json = '{"state":{"before":"' || NEW.from_state
          || '","after":"' || NEW.to_state || '"},"version":{"before":'
          || NEW.expected_version || ',"after":' || NEW.resulting_version || '}}'
        AND audit.created_at = NEW.occurred_at
    );
END;

CREATE TRIGGER customer_auth_capability_operation_delete_guard
BEFORE DELETE ON customer_auth_capability_operations
BEGIN
  SELECT RAISE(ABORT, 'customer_auth_capability_operation_immutable');
END;

-- Solo una inserción nueva dispara la sustitución. Un INSERT OR IGNORE de
-- replay no ejecuta este trigger y, por tanto, no puede revocar un challenge
-- posterior. La clave terminal es opaca, única y no deriva del challenge.
CREATE TRIGGER customer_passwordless_challenge_supersede_pending
AFTER INSERT ON customer_passwordless_challenges
WHEN NEW.status = 'pending'
BEGIN
  UPDATE customer_passwordless_challenges
  SET status = 'revoked',
      transition_idempotency_key =
        'auth:supersede:' || lower(hex(randomblob(16))),
      version = version + 1
  WHERE identity_id = NEW.identity_id
    AND id <> NEW.id
    AND status = 'pending';
END;
