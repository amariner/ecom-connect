-- R5.2: evidencia de consentimiento versionada por sujeto, canal y finalidad.
-- Expand-only: no infiere grants desde pedidos, perfiles, preferencias ni outbox.

CREATE TABLE customer_consent_evidence (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 3 AND 200
      AND id GLOB '[a-z]*'
      AND id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(id, '_') > 0 OR instr(id, ':') > 0 OR instr(id, '-') > 0)
  ),
  customer_profile_id TEXT
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  contact_identity_hash TEXT CHECK (
    contact_identity_hash IS NULL OR (
      length(contact_identity_hash) = 64
        AND contact_identity_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'push')),
  purpose_id TEXT NOT NULL CHECK (
    length(purpose_id) BETWEEN 3 AND 120
      AND purpose_id GLOB '[a-z]*'
      AND purpose_id NOT GLOB '*[^a-z0-9._:-]*'
      AND (instr(purpose_id, '.') > 0 OR instr(purpose_id, '_') > 0
        OR instr(purpose_id, ':') > 0 OR instr(purpose_id, '-') > 0)
  ),
  action TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn')),
  notice_id TEXT NOT NULL CHECK (
    length(notice_id) BETWEEN 3 AND 120
      AND notice_id GLOB '[a-z]*'
      AND notice_id NOT GLOB '*[^a-z0-9._:-]*'
      AND (instr(notice_id, '.') > 0 OR instr(notice_id, '_') > 0
        OR instr(notice_id, ':') > 0 OR instr(notice_id, '-') > 0)
  ),
  notice_version TEXT NOT NULL CHECK (
    length(notice_version) BETWEEN 1 AND 80
      AND notice_version NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('storefront', 'operator', 'import', 'api')
  ),
  source_reference TEXT CHECK (
    source_reference IS NULL OR (
      length(source_reference) BETWEEN 3 AND 200
        AND source_reference GLOB '[a-z]*'
        AND source_reference NOT GLOB '*[^a-z0-9_:-]*'
        AND (instr(source_reference, '_') > 0 OR instr(source_reference, ':') > 0
          OR instr(source_reference, '-') > 0)
    )
  ),
  region TEXT NOT NULL CHECK (
    length(region) BETWEEN 2 AND 32
      AND region = upper(region)
      AND region NOT GLOB '*[^A-Z0-9_-]*'
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
  withdraws_evidence_id TEXT
    REFERENCES customer_consent_evidence(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (
    typeof(version) = 'integer' AND version >= 1
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(trim(idempotency_key)) BETWEEN 8 AND 200
      AND idempotency_key = trim(idempotency_key)
  ),
  CHECK (
    (customer_profile_id IS NOT NULL AND contact_identity_hash IS NULL)
      OR (customer_profile_id IS NULL AND contact_identity_hash IS NOT NULL)
  ),
  CHECK (
    (action = 'granted' AND withdraws_evidence_id IS NULL)
      OR (action = 'withdrawn' AND withdraws_evidence_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_customer_consent_profile_scope_version
  ON customer_consent_evidence(customer_profile_id, channel, purpose_id, version)
  WHERE customer_profile_id IS NOT NULL;

CREATE UNIQUE INDEX idx_customer_consent_contact_scope_version
  ON customer_consent_evidence(contact_identity_hash, channel, purpose_id, version)
  WHERE contact_identity_hash IS NOT NULL;

CREATE INDEX idx_customer_consent_profile_history
  ON customer_consent_evidence(customer_profile_id, channel, purpose_id, occurred_at, id)
  WHERE customer_profile_id IS NOT NULL;

CREATE INDEX idx_customer_consent_contact_history
  ON customer_consent_evidence(contact_identity_hash, channel, purpose_id, occurred_at, id)
  WHERE contact_identity_hash IS NOT NULL;

CREATE INDEX idx_customer_consent_withdrawal
  ON customer_consent_evidence(withdraws_evidence_id)
  WHERE withdraws_evidence_id IS NOT NULL;

-- La versión, el orden temporal y la retirada del grant vigente se validan en
-- la misma sentencia que inserta el nuevo hecho. Una carrera deja un ganador.
CREATE TRIGGER customer_consent_evidence_insert_guard
BEFORE INSERT ON customer_consent_evidence
BEGIN
  SELECT RAISE(ABORT, 'customer_consent_profile_conflict')
  WHERE NEW.customer_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM customer_profiles profile
    WHERE profile.id = NEW.customer_profile_id AND profile.status = 'active'
  );

  SELECT RAISE(ABORT, 'customer_consent_version_conflict')
  WHERE NEW.version <> COALESCE((
    SELECT MAX(existing.version)
    FROM customer_consent_evidence existing
    WHERE existing.customer_profile_id IS NEW.customer_profile_id
      AND existing.contact_identity_hash IS NEW.contact_identity_hash
      AND existing.channel = NEW.channel
      AND existing.purpose_id = NEW.purpose_id
  ), 0) + 1;

  SELECT RAISE(ABORT, 'customer_consent_time_conflict')
  WHERE EXISTS (
    SELECT 1
    FROM customer_consent_evidence existing
    WHERE existing.customer_profile_id IS NEW.customer_profile_id
      AND existing.contact_identity_hash IS NEW.contact_identity_hash
      AND existing.channel = NEW.channel
      AND existing.purpose_id = NEW.purpose_id
      AND existing.version = NEW.version - 1
      AND julianday(NEW.occurred_at) < julianday(existing.occurred_at)
  );

  SELECT RAISE(ABORT, 'customer_consent_withdrawal_conflict')
  WHERE NEW.action = 'withdrawn' AND NOT EXISTS (
    SELECT 1
    FROM customer_consent_evidence granted
    WHERE granted.id = NEW.withdraws_evidence_id
      AND granted.action = 'granted'
      AND granted.customer_profile_id IS NEW.customer_profile_id
      AND granted.contact_identity_hash IS NEW.contact_identity_hash
      AND granted.channel = NEW.channel
      AND granted.purpose_id = NEW.purpose_id
      AND granted.notice_id = NEW.notice_id
      AND granted.notice_version = NEW.notice_version
      AND granted.id = (
        SELECT current.id
        FROM customer_consent_evidence current
        WHERE current.customer_profile_id IS NEW.customer_profile_id
          AND current.contact_identity_hash IS NEW.contact_identity_hash
          AND current.channel = NEW.channel
          AND current.purpose_id = NEW.purpose_id
        ORDER BY current.version DESC
        LIMIT 1
      )
  );
END;

CREATE TRIGGER customer_consent_evidence_update_guard
BEFORE UPDATE ON customer_consent_evidence
BEGIN
  SELECT RAISE(ABORT, 'customer_consent_evidence_immutable');
END;
