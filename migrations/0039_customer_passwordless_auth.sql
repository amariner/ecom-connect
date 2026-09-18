-- R5.4b: identidad passwordless, challenges y sesiones revocables.
-- Expand-only: no crea cuentas desde perfiles ni habilita proveedor/superficies.

CREATE TABLE customer_auth_identities (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 3 AND 200
      AND id GLOB '[a-z]*'
      AND id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(id, '_') > 0 OR instr(id, ':') > 0 OR instr(id, '-') > 0)
  ),
  customer_profile_id TEXT NOT NULL UNIQUE
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  contact_identity_hash TEXT NOT NULL UNIQUE CHECK (
    length(contact_identity_hash) = 64
      AND contact_identity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL CHECK (
    length(created_at) BETWEEN 20 AND 32
      AND substr(created_at, -1) = 'Z'
      AND julianday(created_at) IS NOT NULL
  ),
  revoked_at TEXT CHECK (
    revoked_at IS NULL OR (
      length(revoked_at) BETWEEN 20 AND 32
        AND substr(revoked_at, -1) = 'Z'
        AND julianday(revoked_at) IS NOT NULL
        AND julianday(revoked_at) >= julianday(created_at)
    )
  ),
  creation_idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(trim(creation_idempotency_key)) BETWEEN 8 AND 200
      AND creation_idempotency_key = trim(creation_idempotency_key)
  ),
  CHECK ((status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL))
);

CREATE TABLE customer_session_families (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 3 AND 200
      AND id GLOB '[a-z]*'
      AND id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(id, '_') > 0 OR instr(id, ':') > 0 OR instr(id, '-') > 0)
  ),
  identity_id TEXT NOT NULL
    REFERENCES customer_auth_identities(id) ON DELETE RESTRICT,
  customer_profile_id TEXT NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  created_at TEXT NOT NULL CHECK (
    length(created_at) BETWEEN 20 AND 32
      AND substr(created_at, -1) = 'Z'
      AND julianday(created_at) IS NOT NULL
  ),
  absolute_expires_at TEXT NOT NULL CHECK (
    length(absolute_expires_at) BETWEEN 20 AND 32
      AND substr(absolute_expires_at, -1) = 'Z'
      AND julianday(absolute_expires_at) IS NOT NULL
      AND julianday(absolute_expires_at) > julianday(created_at)
      AND (julianday(absolute_expires_at) - julianday(created_at)) * 86400000
        <= 2592000000
  ),
  revoked_at TEXT CHECK (
    revoked_at IS NULL OR (
      length(revoked_at) BETWEEN 20 AND 32
        AND substr(revoked_at, -1) = 'Z'
        AND julianday(revoked_at) IS NOT NULL
        AND julianday(revoked_at) >= julianday(created_at)
    )
  ),
  revocation_reason_id TEXT CHECK (
    revocation_reason_id IS NULL OR (
      length(revocation_reason_id) BETWEEN 3 AND 120
        AND revocation_reason_id GLOB '[a-z]*'
        AND revocation_reason_id NOT GLOB '*[^a-z0-9._:-]*'
        AND (instr(revocation_reason_id, '.') > 0
          OR instr(revocation_reason_id, '_') > 0
          OR instr(revocation_reason_id, ':') > 0
          OR instr(revocation_reason_id, '-') > 0)
    )
  ),
  transition_idempotency_key TEXT UNIQUE CHECK (
    transition_idempotency_key IS NULL OR (
      length(trim(transition_idempotency_key)) BETWEEN 8 AND 200
        AND transition_idempotency_key = trim(transition_idempotency_key)
    )
  ),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  UNIQUE (id, identity_id, customer_profile_id, absolute_expires_at),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_reason_id IS NULL
      AND transition_idempotency_key IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL
      AND revocation_reason_id IS NOT NULL AND transition_idempotency_key IS NOT NULL)
    OR (status = 'expired' AND revoked_at IS NULL AND revocation_reason_id IS NULL
      AND transition_idempotency_key IS NOT NULL)
  )
);

CREATE TABLE customer_sessions (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 3 AND 200
      AND id GLOB '[a-z]*'
      AND id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(id, '_') > 0 OR instr(id, ':') > 0 OR instr(id, '-') > 0)
  ),
  family_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  customer_profile_id TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE CHECK (
    length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'
  ),
  can_revoke_sessions INTEGER NOT NULL CHECK (can_revoke_sessions IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'rotated', 'revoked', 'expired')),
  issued_at TEXT NOT NULL CHECK (
    length(issued_at) BETWEEN 20 AND 32
      AND substr(issued_at, -1) = 'Z' AND julianday(issued_at) IS NOT NULL
  ),
  expires_at TEXT NOT NULL CHECK (
    length(expires_at) BETWEEN 20 AND 32
      AND substr(expires_at, -1) = 'Z' AND julianday(expires_at) IS NOT NULL
      AND julianday(expires_at) > julianday(issued_at)
      AND (julianday(expires_at) - julianday(issued_at)) * 86400000 <= 604800000
  ),
  absolute_expires_at TEXT NOT NULL CHECK (
    length(absolute_expires_at) BETWEEN 20 AND 32
      AND substr(absolute_expires_at, -1) = 'Z'
      AND julianday(absolute_expires_at) IS NOT NULL
      AND julianday(absolute_expires_at) >= julianday(expires_at)
  ),
  generation INTEGER NOT NULL CHECK (typeof(generation) = 'integer' AND generation >= 1),
  rotated_from_session_id TEXT REFERENCES customer_sessions(id) ON DELETE RESTRICT,
  replaced_by_session_id TEXT REFERENCES customer_sessions(id) ON DELETE RESTRICT,
  revoked_at TEXT CHECK (
    revoked_at IS NULL OR (
      length(revoked_at) BETWEEN 20 AND 32
        AND substr(revoked_at, -1) = 'Z' AND julianday(revoked_at) IS NOT NULL
        AND julianday(revoked_at) >= julianday(issued_at)
    )
  ),
  revocation_reason_id TEXT CHECK (
    revocation_reason_id IS NULL OR (
      length(revocation_reason_id) BETWEEN 3 AND 120
        AND revocation_reason_id GLOB '[a-z]*'
        AND revocation_reason_id NOT GLOB '*[^a-z0-9._:-]*'
        AND (instr(revocation_reason_id, '.') > 0
          OR instr(revocation_reason_id, '_') > 0
          OR instr(revocation_reason_id, ':') > 0
          OR instr(revocation_reason_id, '-') > 0)
    )
  ),
  transition_idempotency_key TEXT CHECK (
    transition_idempotency_key IS NULL OR (
      length(trim(transition_idempotency_key)) BETWEEN 8 AND 200
        AND transition_idempotency_key = trim(transition_idempotency_key)
    )
  ),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  FOREIGN KEY (family_id, identity_id, customer_profile_id, absolute_expires_at)
    REFERENCES customer_session_families(
      id, identity_id, customer_profile_id, absolute_expires_at
    ) ON DELETE RESTRICT,
  UNIQUE (family_id, generation),
  CHECK ((generation = 1 AND rotated_from_session_id IS NULL)
    OR (generation > 1 AND rotated_from_session_id IS NOT NULL)),
  CHECK (
    (status = 'active' AND replaced_by_session_id IS NULL AND revoked_at IS NULL
      AND revocation_reason_id IS NULL AND transition_idempotency_key IS NULL)
    OR (status = 'rotated' AND replaced_by_session_id IS NOT NULL
      AND revoked_at IS NULL AND revocation_reason_id IS NULL
      AND transition_idempotency_key IS NOT NULL)
    OR (status = 'revoked' AND replaced_by_session_id IS NULL
      AND revoked_at IS NOT NULL AND revocation_reason_id IS NOT NULL
      AND transition_idempotency_key IS NOT NULL)
    OR (status = 'expired' AND replaced_by_session_id IS NULL
      AND revoked_at IS NULL AND revocation_reason_id IS NULL
      AND transition_idempotency_key IS NOT NULL)
  )
);

CREATE TABLE customer_passwordless_challenges (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 3 AND 200
      AND id GLOB '[a-z]*'
      AND id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(id, '_') > 0 OR instr(id, ':') > 0 OR instr(id, '-') > 0)
  ),
  identity_id TEXT NOT NULL
    REFERENCES customer_auth_identities(id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK (method IN ('email_magic_link', 'webauthn')),
  purpose TEXT NOT NULL CHECK (purpose IN ('sign_in', 'step_up', 'link_contact')),
  provider_reference TEXT NOT NULL CHECK (
    length(provider_reference) BETWEEN 3 AND 200
      AND provider_reference GLOB '[a-z]*'
      AND provider_reference NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(provider_reference, '_') > 0 OR instr(provider_reference, ':') > 0
        OR instr(provider_reference, '-') > 0)
  ),
  secret_digest TEXT NOT NULL UNIQUE CHECK (
    length(secret_digest) = 64 AND secret_digest NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),
  requested_at TEXT NOT NULL CHECK (
    length(requested_at) BETWEEN 20 AND 32
      AND substr(requested_at, -1) = 'Z' AND julianday(requested_at) IS NOT NULL
  ),
  expires_at TEXT NOT NULL CHECK (
    length(expires_at) BETWEEN 20 AND 32
      AND substr(expires_at, -1) = 'Z' AND julianday(expires_at) IS NOT NULL
      AND julianday(expires_at) > julianday(requested_at)
      AND (julianday(expires_at) - julianday(requested_at)) * 86400000 <= 900000
  ),
  consumed_at TEXT CHECK (
    consumed_at IS NULL OR (
      length(consumed_at) BETWEEN 20 AND 32
        AND substr(consumed_at, -1) = 'Z' AND julianday(consumed_at) IS NOT NULL
        AND julianday(consumed_at) >= julianday(requested_at)
        AND julianday(consumed_at) < julianday(expires_at)
    )
  ),
  consumed_by_session_id TEXT
    REFERENCES customer_sessions(id) ON DELETE RESTRICT,
  transition_idempotency_key TEXT UNIQUE CHECK (
    transition_idempotency_key IS NULL OR (
      length(trim(transition_idempotency_key)) BETWEEN 8 AND 200
        AND transition_idempotency_key = trim(transition_idempotency_key)
    )
  ),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  CHECK (
    (status = 'pending' AND consumed_at IS NULL AND consumed_by_session_id IS NULL
      AND transition_idempotency_key IS NULL AND version = 1)
    OR (status = 'consumed' AND consumed_at IS NOT NULL
      AND consumed_by_session_id IS NOT NULL AND transition_idempotency_key IS NOT NULL)
    OR (status IN ('revoked', 'expired') AND consumed_at IS NULL
      AND consumed_by_session_id IS NULL AND transition_idempotency_key IS NOT NULL)
  )
);

CREATE INDEX idx_customer_auth_identity_contact
  ON customer_auth_identities(contact_identity_hash);
CREATE INDEX idx_customer_auth_profile
  ON customer_auth_identities(customer_profile_id, status);
CREATE INDEX idx_customer_session_family_status
  ON customer_session_families(identity_id, status, absolute_expires_at);
CREATE INDEX idx_customer_session_token
  ON customer_sessions(token_digest);
CREATE INDEX idx_customer_session_family_generation
  ON customer_sessions(family_id, generation);
CREATE INDEX idx_customer_challenge_identity_status
  ON customer_passwordless_challenges(identity_id, status, expires_at);
CREATE UNIQUE INDEX idx_customer_challenge_provider_reference
  ON customer_passwordless_challenges(provider_reference);

CREATE TRIGGER customer_auth_identity_update_guard
BEFORE UPDATE ON customer_auth_identities
BEGIN
  SELECT RAISE(ABORT, 'customer_auth_identity_immutable');
END;

CREATE TRIGGER customer_session_family_insert_guard
BEFORE INSERT ON customer_session_families
BEGIN
  SELECT RAISE(ABORT, 'customer_session_family_identity_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_auth_identities identity
    WHERE identity.id = NEW.identity_id
      AND identity.customer_profile_id = NEW.customer_profile_id
      AND identity.status = 'active'
  );
END;

CREATE TRIGGER customer_session_family_update_guard
BEFORE UPDATE ON customer_session_families
BEGIN
  SELECT RAISE(ABORT, 'customer_session_family_transition_conflict')
  WHERE OLD.status <> 'active'
    OR NEW.status NOT IN ('revoked', 'expired')
    OR NEW.version <> OLD.version + 1
    OR NEW.id <> OLD.id OR NEW.identity_id <> OLD.identity_id
    OR NEW.customer_profile_id <> OLD.customer_profile_id
    OR NEW.created_at <> OLD.created_at
    OR NEW.absolute_expires_at <> OLD.absolute_expires_at;
END;

CREATE TRIGGER customer_session_insert_guard
BEFORE INSERT ON customer_sessions
BEGIN
  SELECT RAISE(ABORT, 'customer_session_initial_state_conflict')
  WHERE NEW.status <> 'active' OR NEW.version <> 1;
  SELECT RAISE(ABORT, 'customer_session_family_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_session_families family
    WHERE family.id = NEW.family_id
      AND family.identity_id = NEW.identity_id
      AND family.customer_profile_id = NEW.customer_profile_id
      AND family.absolute_expires_at = NEW.absolute_expires_at
      AND family.status = 'active'
  );
  SELECT RAISE(ABORT, 'customer_session_rotation_source_conflict')
  WHERE NEW.generation > 1 AND NOT EXISTS (
    SELECT 1 FROM customer_sessions previous
    WHERE previous.id = NEW.rotated_from_session_id
      AND previous.family_id = NEW.family_id
      AND previous.identity_id = NEW.identity_id
      AND previous.customer_profile_id = NEW.customer_profile_id
      AND previous.absolute_expires_at = NEW.absolute_expires_at
      AND previous.generation = NEW.generation - 1
      AND previous.status = 'active'
      AND previous.replaced_by_session_id IS NULL
      AND julianday(NEW.issued_at) >= julianday(previous.issued_at)
      AND julianday(NEW.issued_at) < julianday(previous.expires_at)
      AND julianday(NEW.issued_at) < julianday(previous.absolute_expires_at)
  );
END;

CREATE TRIGGER customer_session_scope_rotation_guard
BEFORE INSERT ON customer_sessions
WHEN NEW.generation > 1
BEGIN
  SELECT RAISE(ABORT, 'customer_session_scope_escalation_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_sessions previous
    WHERE previous.id = NEW.rotated_from_session_id
      AND previous.can_revoke_sessions = NEW.can_revoke_sessions
  );
END;

CREATE TRIGGER customer_session_update_guard
BEFORE UPDATE ON customer_sessions
BEGIN
  SELECT RAISE(ABORT, 'customer_session_transition_conflict')
  WHERE OLD.status <> 'active'
    OR NEW.status NOT IN ('rotated', 'revoked', 'expired')
    OR NEW.version <> OLD.version + 1
    OR NEW.id <> OLD.id OR NEW.family_id <> OLD.family_id
    OR NEW.identity_id <> OLD.identity_id
    OR NEW.customer_profile_id <> OLD.customer_profile_id
    OR NEW.token_digest <> OLD.token_digest
    OR NEW.can_revoke_sessions <> OLD.can_revoke_sessions
    OR NEW.issued_at <> OLD.issued_at OR NEW.expires_at <> OLD.expires_at
    OR NEW.absolute_expires_at <> OLD.absolute_expires_at
    OR NEW.generation <> OLD.generation
    OR NEW.rotated_from_session_id IS NOT OLD.rotated_from_session_id;
  SELECT RAISE(ABORT, 'customer_session_replacement_conflict')
  WHERE NEW.status = 'rotated' AND NOT EXISTS (
    SELECT 1 FROM customer_sessions replacement
    WHERE replacement.id = NEW.replaced_by_session_id
      AND replacement.rotated_from_session_id = OLD.id
      AND replacement.family_id = OLD.family_id
      AND replacement.generation = OLD.generation + 1
      AND replacement.status = 'active'
  );
END;

CREATE TRIGGER customer_passwordless_challenge_insert_guard
BEFORE INSERT ON customer_passwordless_challenges
BEGIN
  SELECT RAISE(ABORT, 'customer_passwordless_identity_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_auth_identities identity
    WHERE identity.id = NEW.identity_id AND identity.status = 'active'
  );
END;

CREATE TRIGGER customer_passwordless_challenge_update_guard
BEFORE UPDATE ON customer_passwordless_challenges
BEGIN
  SELECT RAISE(ABORT, 'customer_passwordless_challenge_transition_conflict')
  WHERE OLD.status <> 'pending'
    OR NEW.status NOT IN ('consumed', 'revoked', 'expired')
    OR NEW.version <> OLD.version + 1
    OR NEW.id <> OLD.id OR NEW.identity_id <> OLD.identity_id
    OR NEW.method <> OLD.method OR NEW.purpose <> OLD.purpose
    OR NEW.provider_reference <> OLD.provider_reference
    OR NEW.secret_digest <> OLD.secret_digest
    OR NEW.requested_at <> OLD.requested_at OR NEW.expires_at <> OLD.expires_at;
  SELECT RAISE(ABORT, 'customer_passwordless_session_conflict')
  WHERE NEW.status = 'consumed' AND NOT EXISTS (
    SELECT 1 FROM customer_sessions session
    WHERE session.id = NEW.consumed_by_session_id
      AND session.identity_id = OLD.identity_id
      AND session.status = 'active'
      AND julianday(session.issued_at) >= julianday(NEW.consumed_at)
  );
END;
