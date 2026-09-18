-- R5.3b: solicitudes de derechos y evidencia verificable append-only.
-- Expand-only: no infiere solicitudes ni ejecuta exportaciones o mutaciones.

CREATE TABLE customer_data_rights_evidence (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 3 AND 200
      AND id GLOB '[a-z]*'
      AND id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(id, '_') > 0 OR instr(id, ':') > 0 OR instr(id, '-') > 0)
  ),
  request_id TEXT NOT NULL CHECK (
    length(request_id) BETWEEN 3 AND 200
      AND request_id GLOB '[a-z]*'
      AND request_id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(request_id, '_') > 0 OR instr(request_id, ':') > 0
        OR instr(request_id, '-') > 0)
  ),
  customer_profile_id TEXT
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  contact_identity_hash TEXT CHECK (
    contact_identity_hash IS NULL OR (
      length(contact_identity_hash) = 64
        AND contact_identity_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  request_kind TEXT NOT NULL CHECK (
    request_kind IN ('access', 'rectification', 'restriction', 'erasure')
  ),
  action TEXT NOT NULL CHECK (
    action IN ('requested', 'identity_verified', 'plan_attached', 'plan_approved',
      'plan_rejected', 'execution_started', 'completed', 'failed', 'cancelled')
  ),
  actor_id TEXT NOT NULL CHECK (
    length(actor_id) BETWEEN 3 AND 200
      AND actor_id GLOB '[a-z]*'
      AND actor_id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(actor_id, '_') > 0 OR instr(actor_id, ':') > 0
        OR instr(actor_id, '-') > 0)
  ),
  occurred_at TEXT NOT NULL CHECK (
    length(occurred_at) BETWEEN 20 AND 32
      AND substr(occurred_at, -1) = 'Z'
      AND julianday(occurred_at) IS NOT NULL
  ),
  recorded_at TEXT NOT NULL CHECK (
    length(recorded_at) BETWEEN 20 AND 32
      AND substr(recorded_at, -1) = 'Z'
      AND julianday(recorded_at) IS NOT NULL
      AND julianday(recorded_at) >= julianday(occurred_at)
  ),
  version INTEGER NOT NULL CHECK (
    typeof(version) = 'integer' AND version >= 1
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(trim(idempotency_key)) BETWEEN 8 AND 200
      AND idempotency_key = trim(idempotency_key)
  ),
  request_payload_reference TEXT CHECK (
    request_payload_reference IS NULL OR (
      length(request_payload_reference) BETWEEN 3 AND 200
        AND request_payload_reference GLOB '[a-z]*'
        AND request_payload_reference NOT GLOB '*[^a-z0-9_:-]*'
        AND (instr(request_payload_reference, '_') > 0
          OR instr(request_payload_reference, ':') > 0
          OR instr(request_payload_reference, '-') > 0)
    )
  ),
  verification_method_id TEXT CHECK (
    verification_method_id IS NULL OR (
      length(verification_method_id) BETWEEN 3 AND 120
        AND verification_method_id GLOB '[a-z]*'
        AND verification_method_id NOT GLOB '*[^a-z0-9._:-]*'
        AND (instr(verification_method_id, '.') > 0
          OR instr(verification_method_id, '_') > 0
          OR instr(verification_method_id, ':') > 0
          OR instr(verification_method_id, '-') > 0)
    )
  ),
  verification_evidence_reference TEXT CHECK (
    verification_evidence_reference IS NULL OR (
      length(verification_evidence_reference) BETWEEN 3 AND 200
        AND verification_evidence_reference GLOB '[a-z]*'
        AND verification_evidence_reference NOT GLOB '*[^a-z0-9_:-]*'
        AND (instr(verification_evidence_reference, '_') > 0
          OR instr(verification_evidence_reference, ':') > 0
          OR instr(verification_evidence_reference, '-') > 0)
    )
  ),
  plan_id TEXT CHECK (
    plan_id IS NULL OR (
      length(plan_id) BETWEEN 3 AND 200
        AND plan_id GLOB '[a-z]*'
        AND plan_id NOT GLOB '*[^a-z0-9_:-]*'
        AND (instr(plan_id, '_') > 0 OR instr(plan_id, ':') > 0
          OR instr(plan_id, '-') > 0)
    )
  ),
  plan_fingerprint TEXT CHECK (
    plan_fingerprint IS NULL OR (
      length(plan_fingerprint) = 64
        AND plan_fingerprint NOT GLOB '*[^0-9a-f]*'
    )
  ),
  plan_created_by TEXT CHECK (
    plan_created_by IS NULL OR (
      length(plan_created_by) BETWEEN 3 AND 200
        AND plan_created_by GLOB '[a-z]*'
        AND plan_created_by NOT GLOB '*[^a-z0-9_:-]*'
        AND (instr(plan_created_by, '_') > 0 OR instr(plan_created_by, ':') > 0
          OR instr(plan_created_by, '-') > 0)
    )
  ),
  plan_created_at TEXT CHECK (
    plan_created_at IS NULL OR (
      length(plan_created_at) BETWEEN 20 AND 32
        AND substr(plan_created_at, -1) = 'Z'
        AND julianday(plan_created_at) IS NOT NULL
    )
  ),
  reason_id TEXT CHECK (
    reason_id IS NULL OR (
      length(reason_id) BETWEEN 3 AND 120
        AND reason_id GLOB '[a-z]*'
        AND reason_id NOT GLOB '*[^a-z0-9._:-]*'
        AND (instr(reason_id, '.') > 0 OR instr(reason_id, '_') > 0
          OR instr(reason_id, ':') > 0 OR instr(reason_id, '-') > 0)
    )
  ),
  CHECK (
    (customer_profile_id IS NOT NULL AND contact_identity_hash IS NULL)
      OR (customer_profile_id IS NULL AND contact_identity_hash IS NOT NULL)
  ),
  CHECK (request_kind <> 'rectification' OR action <> 'requested'
    OR request_payload_reference IS NOT NULL),
  CHECK (
    (action = 'requested'
      AND verification_method_id IS NULL AND verification_evidence_reference IS NULL
      AND plan_id IS NULL AND plan_fingerprint IS NULL AND plan_created_by IS NULL
      AND plan_created_at IS NULL AND reason_id IS NULL)
    OR (action = 'identity_verified'
      AND request_payload_reference IS NULL
      AND verification_method_id IS NOT NULL AND verification_evidence_reference IS NOT NULL
      AND plan_id IS NULL AND plan_fingerprint IS NULL AND plan_created_by IS NULL
      AND plan_created_at IS NULL AND reason_id IS NULL)
    OR (action = 'plan_attached'
      AND request_payload_reference IS NULL
      AND verification_method_id IS NULL AND verification_evidence_reference IS NULL
      AND plan_id IS NOT NULL AND plan_fingerprint IS NOT NULL
      AND plan_created_by IS NOT NULL AND plan_created_at IS NOT NULL
      AND reason_id IS NULL)
    OR (action IN ('plan_approved', 'execution_started', 'completed')
      AND request_payload_reference IS NULL
      AND verification_method_id IS NULL AND verification_evidence_reference IS NULL
      AND plan_id IS NULL AND plan_fingerprint IS NOT NULL
      AND plan_created_by IS NULL AND plan_created_at IS NULL AND reason_id IS NULL)
    OR (action IN ('plan_rejected', 'cancelled')
      AND request_payload_reference IS NULL
      AND verification_method_id IS NULL AND verification_evidence_reference IS NULL
      AND plan_id IS NULL AND plan_fingerprint IS NULL
      AND plan_created_by IS NULL AND plan_created_at IS NULL AND reason_id IS NOT NULL)
    OR (action = 'failed'
      AND request_payload_reference IS NULL
      AND verification_method_id IS NULL AND verification_evidence_reference IS NULL
      AND plan_id IS NULL AND plan_fingerprint IS NOT NULL
      AND plan_created_by IS NULL AND plan_created_at IS NULL AND reason_id IS NOT NULL)
  )
);

CREATE TABLE customer_data_rights_plan_decisions (
  evidence_id TEXT NOT NULL
    REFERENCES customer_data_rights_evidence(id) ON DELETE RESTRICT,
  owner_id TEXT NOT NULL CHECK (
    length(owner_id) BETWEEN 3 AND 120
      AND owner_id GLOB '[a-z]*'
      AND owner_id NOT GLOB '*[^a-z0-9._:-]*'
      AND (instr(owner_id, '.') > 0 OR instr(owner_id, '_') > 0
        OR instr(owner_id, ':') > 0 OR instr(owner_id, '-') > 0)
  ),
  operation TEXT NOT NULL CHECK (
    operation IN ('export', 'correct', 'restrict', 'anonymize', 'retain', 'manual_review')
  ),
  policy_reason_id TEXT NOT NULL CHECK (
    length(policy_reason_id) BETWEEN 3 AND 120
      AND policy_reason_id GLOB '[a-z]*'
      AND policy_reason_id NOT GLOB '*[^a-z0-9._:-]*'
      AND (instr(policy_reason_id, '.') > 0 OR instr(policy_reason_id, '_') > 0
        OR instr(policy_reason_id, ':') > 0 OR instr(policy_reason_id, '-') > 0)
  ),
  payload_reference TEXT CHECK (
    payload_reference IS NULL OR (
      length(payload_reference) BETWEEN 3 AND 200
        AND payload_reference GLOB '[a-z]*'
        AND payload_reference NOT GLOB '*[^a-z0-9_:-]*'
        AND (instr(payload_reference, '_') > 0 OR instr(payload_reference, ':') > 0
          OR instr(payload_reference, '-') > 0)
    )
  ),
  position INTEGER NOT NULL CHECK (
    typeof(position) = 'integer' AND position BETWEEN 0 AND 99
  ),
  PRIMARY KEY (evidence_id, owner_id),
  UNIQUE (evidence_id, position),
  CHECK ((operation = 'correct') = (payload_reference IS NOT NULL))
);

CREATE TABLE customer_data_rights_artifact_references (
  evidence_id TEXT NOT NULL
    REFERENCES customer_data_rights_evidence(id) ON DELETE RESTRICT,
  artifact_reference TEXT NOT NULL CHECK (
    length(artifact_reference) BETWEEN 3 AND 200
      AND artifact_reference GLOB '[a-z]*'
      AND artifact_reference NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(artifact_reference, '_') > 0 OR instr(artifact_reference, ':') > 0
        OR instr(artifact_reference, '-') > 0)
  ),
  position INTEGER NOT NULL CHECK (
    typeof(position) = 'integer' AND position BETWEEN 0 AND 99
  ),
  PRIMARY KEY (evidence_id, artifact_reference),
  UNIQUE (evidence_id, position)
);

CREATE UNIQUE INDEX idx_customer_data_rights_request_version
  ON customer_data_rights_evidence(request_id, version);

CREATE INDEX idx_customer_data_rights_request_history
  ON customer_data_rights_evidence(request_id, occurred_at, id);

CREATE INDEX idx_customer_data_rights_profile
  ON customer_data_rights_evidence(customer_profile_id, request_id)
  WHERE customer_profile_id IS NOT NULL;

-- Contexto, versión y tiempo se validan en la misma sentencia de inserción.
-- Bajo carrera, una única versión gana y nunca se sobrescribe evidencia.
CREATE TRIGGER customer_data_rights_evidence_insert_guard
BEFORE INSERT ON customer_data_rights_evidence
BEGIN
  SELECT RAISE(ABORT, 'customer_data_rights_version_conflict')
  WHERE NEW.version <> COALESCE((
    SELECT MAX(existing.version)
    FROM customer_data_rights_evidence existing
    WHERE existing.request_id = NEW.request_id
  ), 0) + 1;

  SELECT RAISE(ABORT, 'customer_data_rights_initial_action_conflict')
  WHERE (NEW.version = 1 AND NEW.action <> 'requested')
    OR (NEW.version > 1 AND NEW.action = 'requested');

  SELECT RAISE(ABORT, 'customer_data_rights_context_conflict')
  WHERE EXISTS (
    SELECT 1
    FROM customer_data_rights_evidence existing
    WHERE existing.request_id = NEW.request_id
      AND (
        existing.customer_profile_id IS NOT NEW.customer_profile_id
        OR existing.contact_identity_hash IS NOT NEW.contact_identity_hash
        OR existing.request_kind <> NEW.request_kind
      )
  );

  SELECT RAISE(ABORT, 'customer_data_rights_time_conflict')
  WHERE EXISTS (
    SELECT 1
    FROM customer_data_rights_evidence existing
    WHERE existing.request_id = NEW.request_id
      AND existing.version = NEW.version - 1
      AND julianday(NEW.occurred_at) < julianday(existing.occurred_at)
  );
END;

CREATE TRIGGER customer_data_rights_evidence_update_guard
BEFORE UPDATE ON customer_data_rights_evidence
BEGIN
  SELECT RAISE(ABORT, 'customer_data_rights_evidence_immutable');
END;

CREATE TRIGGER customer_data_rights_plan_decision_insert_guard
BEFORE INSERT ON customer_data_rights_plan_decisions
BEGIN
  SELECT RAISE(ABORT, 'customer_data_rights_plan_decision_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_data_rights_evidence evidence
    WHERE evidence.id = NEW.evidence_id AND evidence.action = 'plan_attached'
  );
END;

CREATE TRIGGER customer_data_rights_plan_decision_update_guard
BEFORE UPDATE ON customer_data_rights_plan_decisions
BEGIN
  SELECT RAISE(ABORT, 'customer_data_rights_plan_decision_immutable');
END;

CREATE TRIGGER customer_data_rights_artifact_reference_insert_guard
BEFORE INSERT ON customer_data_rights_artifact_references
BEGIN
  SELECT RAISE(ABORT, 'customer_data_rights_artifact_reference_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_data_rights_evidence evidence
    WHERE evidence.id = NEW.evidence_id AND evidence.action = 'completed'
  );
END;

CREATE TRIGGER customer_data_rights_artifact_reference_update_guard
BEFORE UPDATE ON customer_data_rights_artifact_references
BEGIN
  SELECT RAISE(ABORT, 'customer_data_rights_artifact_reference_immutable');
END;
