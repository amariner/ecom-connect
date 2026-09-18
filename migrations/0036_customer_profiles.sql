-- R5.1: perfil de cliente deduplicable, identidad opaca y checkout invitado intacto.
-- Expand-only: no crea perfiles desde pedidos existentes ni modifica sus snapshots.

CREATE TABLE customer_profiles (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 3 AND 200
      AND id GLOB '[a-z]*'
      AND id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(id, '_') > 0 OR instr(id, ':') > 0 OR instr(id, '-') > 0)
  ),
  primary_email TEXT NOT NULL CHECK (
    length(primary_email) BETWEEN 3 AND 200
      AND primary_email = lower(trim(primary_email))
      AND instr(primary_email, '@') > 1
      AND instr(primary_email, ' ') = 0
  ),
  email_identity_hash TEXT NOT NULL UNIQUE CHECK (
    length(email_identity_hash) = 64
      AND email_identity_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged')),
  merged_into_profile_id TEXT REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(version) = 'integer' AND version >= 1
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'active' AND merged_into_profile_id IS NULL)
      OR (status = 'merged' AND merged_into_profile_id IS NOT NULL
        AND merged_into_profile_id <> id)
  )
);

CREATE INDEX idx_customer_profiles_merge_target
  ON customer_profiles(merged_into_profile_id, id)
  WHERE merged_into_profile_id IS NOT NULL;

CREATE TABLE customer_address_revisions (
  address_id TEXT NOT NULL CHECK (
    length(address_id) BETWEEN 3 AND 200
      AND address_id GLOB '[a-z]*'
      AND address_id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(address_id, '_') > 0 OR instr(address_id, ':') > 0
        OR instr(address_id, '-') > 0)
  ),
  customer_profile_id TEXT NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer' AND revision >= 1
  ),
  recipient_name TEXT NOT NULL CHECK (length(trim(recipient_name)) BETWEEN 2 AND 160),
  phone TEXT CHECK (phone IS NULL OR length(trim(phone)) BETWEEN 3 AND 30),
  street TEXT NOT NULL CHECK (length(trim(street)) BETWEEN 3 AND 200),
  city TEXT NOT NULL CHECK (length(trim(city)) BETWEEN 2 AND 100),
  region TEXT CHECK (region IS NULL OR length(trim(region)) BETWEEN 1 AND 100),
  postal_code TEXT NOT NULL CHECK (length(trim(postal_code)) BETWEEN 1 AND 20),
  country_code TEXT NOT NULL CHECK (
    length(country_code) = 2 AND country_code = upper(country_code)
      AND country_code NOT GLOB '*[^A-Z]*'
  ),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  PRIMARY KEY (address_id, revision),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE INDEX idx_customer_address_revisions_profile
  ON customer_address_revisions(customer_profile_id, address_id, revision);
CREATE UNIQUE INDEX idx_customer_address_revisions_current
  ON customer_address_revisions(address_id)
  WHERE valid_to IS NULL;

-- Una única sentencia INSERT valida la versión vigente y cierra la anterior.
-- Si el INSERT posterior falla, SQLite revierte también este UPDATE del trigger.
CREATE TRIGGER customer_address_revision_guard
BEFORE INSERT ON customer_address_revisions
BEGIN
  SELECT RAISE(ABORT, 'customer_address_revision_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_profiles profile
    WHERE profile.id = NEW.customer_profile_id AND profile.status = 'active'
  );

  SELECT RAISE(ABORT, 'customer_address_revision_conflict')
  WHERE (
    NEW.revision = 1 AND EXISTS (
      SELECT 1 FROM customer_address_revisions existing
      WHERE existing.address_id = NEW.address_id
    )
  ) OR (
    NEW.revision > 1 AND NOT EXISTS (
      SELECT 1 FROM customer_address_revisions current
      WHERE current.address_id = NEW.address_id
        AND current.customer_profile_id = NEW.customer_profile_id
        AND current.revision = NEW.revision - 1
        AND (current.valid_to IS NULL OR current.valid_to = NEW.valid_from)
        AND NEW.valid_from >= current.valid_from
    )
  );

  UPDATE customer_address_revisions
  SET valid_to = NEW.valid_from
  WHERE NEW.revision > 1
    AND address_id = NEW.address_id
    AND customer_profile_id = NEW.customer_profile_id
    AND revision = NEW.revision - 1
    AND valid_to IS NULL;
END;

CREATE TABLE customer_profile_merges (
  idempotency_key TEXT PRIMARY KEY CHECK (
    length(trim(idempotency_key)) BETWEEN 8 AND 200
  ),
  source_profile_id TEXT NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  target_profile_id TEXT NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  source_version_before INTEGER NOT NULL CHECK (source_version_before >= 1),
  target_version_before INTEGER NOT NULL CHECK (target_version_before >= 1),
  reviewed_by TEXT NOT NULL CHECK (
    length(reviewed_by) BETWEEN 3 AND 200
      AND reviewed_by GLOB '[a-z]*'
      AND reviewed_by NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(reviewed_by, '_') > 0 OR instr(reviewed_by, ':') > 0
        OR instr(reviewed_by, '-') > 0)
  ),
  reviewed_at TEXT NOT NULL,
  CHECK (source_profile_id <> target_profile_id)
);

CREATE INDEX idx_customer_profile_merges_source
  ON customer_profile_merges(source_profile_id, reviewed_at, idempotency_key);
CREATE INDEX idx_customer_profile_merges_target
  ON customer_profile_merges(target_profile_id, reviewed_at, idempotency_key);

-- El alta de la evidencia y las dos mutaciones forman una única sentencia.
CREATE TRIGGER customer_profile_merge_guard
BEFORE INSERT ON customer_profile_merges
BEGIN
  SELECT RAISE(ABORT, 'customer_profile_merge_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM customer_profiles source
    JOIN customer_profiles target ON target.id = NEW.target_profile_id
    WHERE source.id = NEW.source_profile_id
      AND source.id <> target.id
      AND source.status = 'active' AND target.status = 'active'
      AND source.version = NEW.source_version_before
      AND target.version = NEW.target_version_before
      AND source.email_identity_hash = target.email_identity_hash
      AND source.primary_email = target.primary_email
      AND NEW.reviewed_at >= source.created_at
      AND NEW.reviewed_at >= target.created_at
  );
END;

CREATE TRIGGER customer_profile_merge_apply
AFTER INSERT ON customer_profile_merges
BEGIN
  UPDATE customer_profiles
  SET status = 'merged', merged_into_profile_id = NEW.target_profile_id,
    version = version + 1, updated_at = NEW.reviewed_at
  WHERE id = NEW.source_profile_id AND status = 'active'
    AND version = NEW.source_version_before;

  UPDATE customer_profiles
  SET version = version + 1, updated_at = NEW.reviewed_at
  WHERE id = NEW.target_profile_id AND status = 'active'
    AND version = NEW.target_version_before;
END;

CREATE TRIGGER customer_profile_merge_update_guard
BEFORE UPDATE ON customer_profile_merges
BEGIN
  SELECT RAISE(ABORT, 'customer_profile_merge_immutable');
END;

ALTER TABLE orders ADD COLUMN customer_profile_id TEXT
  REFERENCES customer_profiles(id) ON DELETE RESTRICT;

CREATE INDEX idx_orders_customer_profile
  ON orders(customer_profile_id, created_at, id)
  WHERE customer_profile_id IS NOT NULL;
