-- Tarjetas regalo y crédito en tienda (R4.8; ADR-0035).
--
-- Expand-only. El valor almacenado es un medio de pago: el total comercial del
-- pedido no cambia y `payments.expected_amount_cents` conserva exclusivamente
-- la parte externa. No se guarda nunca el código claro ni una identidad de
-- cliente reversible.

ALTER TABLE payments ADD COLUMN stored_value_expected_cents INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(stored_value_expected_cents) = 'integer' AND stored_value_expected_cents >= 0);

CREATE TABLE stored_value_accounts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 120),
  kind TEXT NOT NULL CHECK (kind IN ('gift_card', 'store_credit')),
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'closed')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 120),
  code_hash TEXT UNIQUE,
  owner_key_hash TEXT,
  balance_cents INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(balance_cents) = 'integer' AND balance_cents >= 0),
  reserved_cents INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(reserved_cents) = 'integer' AND reserved_cents >= 0
      AND reserved_cents <= balance_cents),
  expires_at TEXT,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'gift_card' AND length(code_hash) = 64 AND owner_key_hash IS NULL)
    OR (kind = 'store_credit' AND code_hash IS NULL AND length(owner_key_hash) = 64)
  )
);

CREATE UNIQUE INDEX idx_stored_value_accounts_owner
  ON stored_value_accounts(owner_key_hash, currency, state)
  WHERE owner_key_hash IS NOT NULL;
CREATE INDEX idx_stored_value_accounts_state
  ON stored_value_accounts(state, expires_at, id);

CREATE TABLE stored_value_reservations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 120),
  account_id TEXT NOT NULL REFERENCES stored_value_accounts(id) ON DELETE RESTRICT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL
    CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'captured', 'released')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  captured_at TEXT,
  released_at TEXT,
  CHECK (
    (status = 'active' AND captured_at IS NULL AND released_at IS NULL)
    OR (status = 'captured' AND captured_at IS NOT NULL AND released_at IS NULL)
    OR (status = 'released' AND captured_at IS NULL AND released_at IS NOT NULL)
  )
);

CREATE INDEX idx_stored_value_reservations_account
  ON stored_value_reservations(account_id, status, id);

CREATE TABLE stored_value_applications (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 120),
  account_id TEXT NOT NULL REFERENCES stored_value_accounts(id) ON DELETE RESTRICT,
  reservation_id TEXT NOT NULL UNIQUE REFERENCES stored_value_reservations(id) ON DELETE RESTRICT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL
    CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  applied_at TEXT NOT NULL
);

CREATE INDEX idx_stored_value_applications_account
  ON stored_value_applications(account_id, applied_at, id);

CREATE TABLE stored_value_refund_allocations (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 120),
  refund_id INTEGER NOT NULL REFERENCES refunds(id) ON DELETE RESTRICT,
  application_id TEXT NOT NULL REFERENCES stored_value_applications(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES stored_value_accounts(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL
    CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (refund_id, application_id)
);

CREATE INDEX idx_stored_value_refunds_refund
  ON stored_value_refund_allocations(refund_id, status, id);

CREATE TABLE stored_value_ledger_entries (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 120),
  account_id TEXT NOT NULL REFERENCES stored_value_accounts(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN (
    'issuance', 'reservation', 'release', 'capture', 'refund', 'expiration'
  )),
  balance_delta_cents INTEGER NOT NULL CHECK (typeof(balance_delta_cents) = 'integer'),
  reserved_delta_cents INTEGER NOT NULL CHECK (typeof(reserved_delta_cents) = 'integer'),
  balance_after_cents INTEGER NOT NULL
    CHECK (typeof(balance_after_cents) = 'integer' AND balance_after_cents >= 0),
  reserved_after_cents INTEGER NOT NULL
    CHECK (typeof(reserved_after_cents) = 'integer' AND reserved_after_cents >= 0
      AND reserved_after_cents <= balance_after_cents),
  version_after INTEGER NOT NULL CHECK (typeof(version_after) = 'integer' AND version_after >= 2),
  order_id INTEGER REFERENCES orders(id) ON DELETE RESTRICT,
  refund_id INTEGER REFERENCES refunds(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  occurred_at TEXT NOT NULL,
  CHECK (
    (type = 'issuance' AND balance_delta_cents > 0 AND reserved_delta_cents = 0
      AND order_id IS NULL AND refund_id IS NULL)
    OR (type = 'reservation' AND balance_delta_cents = 0 AND reserved_delta_cents > 0
      AND order_id IS NOT NULL AND refund_id IS NULL)
    OR (type = 'release' AND balance_delta_cents = 0 AND reserved_delta_cents < 0
      AND order_id IS NOT NULL AND refund_id IS NULL)
    OR (type = 'capture' AND balance_delta_cents < 0
      AND reserved_delta_cents = balance_delta_cents AND order_id IS NOT NULL AND refund_id IS NULL)
    OR (type = 'refund' AND balance_delta_cents > 0 AND reserved_delta_cents = 0
      AND order_id IS NOT NULL AND refund_id IS NOT NULL)
    OR (type = 'expiration' AND balance_delta_cents <= 0 AND reserved_delta_cents = 0
      AND order_id IS NULL AND refund_id IS NULL)
  )
);

CREATE INDEX idx_stored_value_ledger_account
  ON stored_value_ledger_entries(account_id, version_after, id);
CREATE INDEX idx_stored_value_ledger_order
  ON stored_value_ledger_entries(order_id, id) WHERE order_id IS NOT NULL;

-- Un asiento solo puede proyectar exactamente el siguiente estado del saldo.
CREATE TRIGGER stored_value_ledger_guard
BEFORE INSERT ON stored_value_ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'stored_value_ledger_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM stored_value_accounts account
    WHERE account.id = NEW.account_id
      AND NEW.version_after = account.version + 1
      AND NEW.balance_after_cents = account.balance_cents + NEW.balance_delta_cents
      AND NEW.reserved_after_cents = account.reserved_cents + NEW.reserved_delta_cents
      AND NEW.reserved_after_cents <= NEW.balance_after_cents
  );
END;

-- Una asignación devuelve como máximo lo capturado por esa aplicación y
-- pertenece obligatoriamente a su misma cuenta/pedido.
CREATE TRIGGER stored_value_refund_allocation_guard
BEFORE INSERT ON stored_value_refund_allocations
BEGIN
  SELECT RAISE(ABORT, 'stored_value_refund_allocation_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM refunds refund
    JOIN stored_value_applications application
      ON application.id = NEW.application_id
     AND application.account_id = NEW.account_id
     AND application.order_id = refund.order_id
    WHERE refund.id = NEW.refund_id
      AND NEW.amount_cents + COALESCE((
        SELECT sum(existing.amount_cents)
        FROM stored_value_refund_allocations existing
        WHERE existing.application_id = application.id
          AND existing.status <> 'cancelled'
      ), 0) <= application.amount_cents
  );
END;

-- Pago externo + valor almacenado debe ser exactamente el total del pedido.
CREATE TRIGGER stored_value_payment_guard
BEFORE UPDATE OF stored_value_expected_cents ON payments
BEGIN
  SELECT RAISE(ABORT, 'stored_value_payment_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM orders o WHERE o.id = NEW.order_id
      AND NEW.expected_amount_cents + NEW.stored_value_expected_cents = o.total_cents
  );
END;

CREATE TRIGGER stored_value_payment_insert_guard
BEFORE INSERT ON payments
WHEN NEW.stored_value_expected_cents > 0
BEGIN
  SELECT RAISE(ABORT, 'stored_value_payment_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM orders o WHERE o.id = NEW.order_id
      AND NEW.expected_amount_cents + NEW.stored_value_expected_cents = o.total_cents
  );
END;
