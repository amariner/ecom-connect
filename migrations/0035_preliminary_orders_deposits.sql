-- R4.11: presupuestos, depósitos y saldo mediante transiciones explícitas.
-- Expand-only: no altera pedidos existentes, no crea términos comerciales y
-- no persiste URLs alojadas, payloads remotos ni datos de tarjeta.

CREATE TABLE preliminary_orders (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 120),
  reference TEXT NOT NULL UNIQUE CHECK (length(trim(reference)) BETWEEN 3 AND 80),
  email TEXT NOT NULL CHECK (
    length(trim(email)) BETWEEN 3 AND 254 AND instr(email, '@') > 1
  ),
  customer_name TEXT NOT NULL CHECK (length(trim(customer_name)) BETWEEN 2 AND 160),
  address_json TEXT NOT NULL CHECK (json_valid(address_json)),
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'issued', 'approved', 'converted', 'expired', 'cancelled'
  )),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'deposit_paid', 'paid')),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  subtotal_cents INTEGER NOT NULL CHECK (
    typeof(subtotal_cents) = 'integer' AND subtotal_cents > 0
  ),
  shipping_cents INTEGER NOT NULL CHECK (
    typeof(shipping_cents) = 'integer' AND shipping_cents >= 0
  ),
  total_cents INTEGER NOT NULL CHECK (
    typeof(total_cents) = 'integer' AND total_cents = subtotal_cents + shipping_cents
  ),
  deposit_cents INTEGER NOT NULL CHECK (
    typeof(deposit_cents) = 'integer' AND deposit_cents BETWEEN 0 AND total_cents
  ),
  paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(paid_cents) = 'integer' AND paid_cents BETWEEN 0 AND total_cents
  ),
  conversion_gate TEXT NOT NULL CHECK (conversion_gate IN (
    'approval', 'deposit', 'full_payment'
  )),
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version) = 'integer' AND version >= 1),
  issued_at TEXT,
  approved_at TEXT,
  converted_order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  converted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (conversion_gate <> 'deposit' OR deposit_cents > 0),
  CHECK (
    (paid_cents = 0 AND payment_status = 'unpaid') OR
    (paid_cents = total_cents AND payment_status = 'paid') OR
    (deposit_cents > 0 AND deposit_cents < total_cents
      AND paid_cents = deposit_cents AND payment_status = 'deposit_paid')
  ),
  CHECK (
    (status = 'draft' AND issued_at IS NULL AND approved_at IS NULL) OR
    (status = 'issued' AND issued_at IS NOT NULL AND approved_at IS NULL) OR
    (status = 'approved' AND issued_at IS NOT NULL AND approved_at IS NOT NULL) OR
    (status = 'converted' AND issued_at IS NOT NULL AND approved_at IS NOT NULL
      AND converted_order_id IS NOT NULL AND converted_at IS NOT NULL) OR
    (status IN ('expired', 'cancelled') AND approved_at IS NULL
      AND converted_order_id IS NULL AND converted_at IS NULL)
  ),
  CHECK (status IN ('approved', 'converted') OR paid_cents = 0),
  CHECK ((status = 'converted') = (converted_order_id IS NOT NULL))
);

CREATE INDEX idx_preliminary_orders_status
  ON preliminary_orders(status, expires_at, id);
CREATE INDEX idx_preliminary_orders_email
  ON preliminary_orders(email, created_at, id);

CREATE TABLE preliminary_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preliminary_order_id TEXT NOT NULL REFERENCES preliminary_orders(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  name_snapshot TEXT NOT NULL CHECK (length(trim(name_snapshot)) BETWEEN 1 AND 240),
  sku_snapshot TEXT NOT NULL CHECK (length(trim(sku_snapshot)) BETWEEN 1 AND 120),
  unit_price_cents INTEGER NOT NULL CHECK (
    typeof(unit_price_cents) = 'integer' AND unit_price_cents >= 0
  ),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 10000),
  line_subtotal_cents INTEGER NOT NULL CHECK (
    typeof(line_subtotal_cents) = 'integer'
      AND line_subtotal_cents = unit_price_cents * quantity
  ),
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(discount_cents) = 'integer' AND discount_cents BETWEEN 0 AND line_subtotal_cents
  ),
  line_total_cents INTEGER NOT NULL CHECK (
    typeof(line_total_cents) = 'integer'
      AND line_total_cents = line_subtotal_cents - discount_cents
  ),
  pricing_snapshot_json TEXT NOT NULL CHECK (json_valid(pricing_snapshot_json)),
  created_at TEXT NOT NULL,
  UNIQUE (preliminary_order_id, variant_id)
);

CREATE INDEX idx_preliminary_order_lines_order
  ON preliminary_order_lines(preliminary_order_id, id);

CREATE TABLE preliminary_order_payment_links (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 160),
  preliminary_order_id TEXT NOT NULL REFERENCES preliminary_orders(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('deposit', 'balance', 'full')),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  provider_adapter TEXT NOT NULL CHECK (length(trim(provider_adapter)) BETWEEN 2 AND 80),
  provider_reference TEXT NOT NULL CHECK (length(trim(provider_reference)) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'expired', 'cancelled')),
  expected_order_version INTEGER NOT NULL CHECK (expected_order_version >= 1),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_adapter, provider_reference),
  CHECK ((status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL))
);

CREATE INDEX idx_preliminary_payment_links_order
  ON preliminary_order_payment_links(preliminary_order_id, status, created_at, id);

CREATE TABLE preliminary_order_payments (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 160),
  preliminary_order_id TEXT NOT NULL REFERENCES preliminary_orders(id) ON DELETE RESTRICT,
  payment_link_id TEXT NOT NULL UNIQUE
    REFERENCES preliminary_order_payment_links(id) ON DELETE RESTRICT,
  stage TEXT NOT NULL CHECK (stage IN ('deposit', 'balance', 'full')),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  provider_adapter TEXT NOT NULL CHECK (length(trim(provider_adapter)) BETWEEN 2 AND 80),
  provider_event_reference TEXT NOT NULL CHECK (
    length(trim(provider_event_reference)) BETWEEN 1 AND 200
  ),
  provider_payment_reference TEXT NOT NULL CHECK (
    length(trim(provider_payment_reference)) BETWEEN 1 AND 200
  ),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider_adapter, provider_event_reference),
  UNIQUE (provider_adapter, provider_payment_reference)
);

CREATE INDEX idx_preliminary_payments_order
  ON preliminary_order_payments(preliminary_order_id, occurred_at, id);

CREATE TABLE preliminary_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preliminary_order_id TEXT NOT NULL REFERENCES preliminary_orders(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'issued', 'approved', 'expired', 'cancelled', 'payment_confirmed', 'converted'
  )),
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_payment_status TEXT,
  to_payment_status TEXT NOT NULL,
  payment_id TEXT UNIQUE REFERENCES preliminary_order_payments(id) ON DELETE RESTRICT,
  converted_order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(amount_cents) = 'integer' AND amount_cents >= 0
  ),
  version_after INTEGER NOT NULL CHECK (typeof(version_after) = 'integer' AND version_after >= 1),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (preliminary_order_id, version_after)
);

CREATE INDEX idx_preliminary_order_events_order
  ON preliminary_order_events(preliminary_order_id, version_after, id);

-- El alta se confirma con líneas completas y subtotal derivado en servidor.
CREATE TRIGGER preliminary_order_created_event_guard
BEFORE INSERT ON preliminary_order_events
WHEN NEW.event_type = 'created'
BEGIN
  SELECT RAISE(ABORT, 'preliminary_order_created_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM preliminary_orders draft
    WHERE draft.id = NEW.preliminary_order_id
      AND draft.status = 'draft' AND draft.payment_status = 'unpaid'
      AND draft.version = 1 AND NEW.version_after = 1
      AND NEW.from_status IS NULL AND NEW.to_status = 'draft'
      AND NEW.from_payment_status IS NULL AND NEW.to_payment_status = 'unpaid'
      AND NEW.payment_id IS NULL AND NEW.converted_order_id IS NULL AND NEW.amount_cents = 0
      AND draft.subtotal_cents = COALESCE((
        SELECT sum(line.line_total_cents) FROM preliminary_order_lines line
        WHERE line.preliminary_order_id = draft.id
      ), -1)
  );
END;

-- Toda mutación posterior ocupa exactamente la siguiente versión y respeta el
-- reducer R4.11. El evento se inserta antes del UPDATE guardado en la misma batch.
CREATE TRIGGER preliminary_order_event_guard
BEFORE INSERT ON preliminary_order_events
WHEN NEW.event_type <> 'created'
BEGIN
  SELECT RAISE(ABORT, 'preliminary_order_event_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM preliminary_orders current
    WHERE current.id = NEW.preliminary_order_id
      AND current.status = NEW.from_status
      AND current.payment_status = NEW.from_payment_status
      AND current.version + 1 = NEW.version_after
      AND (
        (NEW.event_type = 'issued' AND current.status = 'draft'
          AND NEW.to_status = 'issued' AND NEW.to_payment_status = 'unpaid'
          AND NEW.occurred_at < current.expires_at AND NEW.amount_cents = 0)
        OR (NEW.event_type = 'approved' AND current.status = 'issued'
          AND NEW.to_status = 'approved' AND NEW.to_payment_status = 'unpaid'
          AND NEW.occurred_at < current.expires_at AND NEW.amount_cents = 0)
        OR (NEW.event_type = 'expired' AND current.status IN ('draft', 'issued')
          AND NEW.to_status = 'expired' AND NEW.to_payment_status = 'unpaid'
          AND NEW.occurred_at >= current.expires_at AND NEW.amount_cents = 0)
        OR (NEW.event_type = 'cancelled' AND current.status IN ('draft', 'issued', 'approved')
          AND current.paid_cents = 0 AND NEW.to_status = 'cancelled'
          AND NEW.to_payment_status = 'unpaid' AND NEW.amount_cents = 0)
        OR (NEW.event_type = 'payment_confirmed' AND current.status IN ('approved', 'converted')
          AND NEW.to_status = current.status AND NEW.payment_id IS NOT NULL
          AND NEW.converted_order_id IS NULL AND NEW.amount_cents > 0
          AND EXISTS (
            SELECT 1 FROM preliminary_order_payments payment
            WHERE payment.id = NEW.payment_id
              AND payment.preliminary_order_id = current.id
              AND payment.amount_cents = NEW.amount_cents
              AND payment.currency = current.currency
              AND (
                (current.payment_status = 'unpaid'
                  AND current.deposit_cents > 0 AND current.deposit_cents < current.total_cents
                  AND payment.stage = 'deposit' AND payment.amount_cents = current.deposit_cents
                  AND NEW.to_payment_status = 'deposit_paid')
                OR (current.payment_status = 'unpaid'
                  AND (current.deposit_cents = 0 OR current.deposit_cents = current.total_cents)
                  AND payment.stage = 'full' AND payment.amount_cents = current.total_cents
                  AND NEW.to_payment_status = 'paid')
                OR (current.payment_status = 'deposit_paid'
                  AND payment.stage = 'balance'
                  AND payment.amount_cents = current.total_cents - current.paid_cents
                  AND NEW.to_payment_status = 'paid')
              )
          ))
        OR (NEW.event_type = 'converted' AND current.status = 'approved'
          AND NEW.to_status = 'converted'
          AND NEW.to_payment_status = current.payment_status
          AND NEW.payment_id IS NULL AND NEW.converted_order_id IS NOT NULL
          AND NEW.amount_cents = 0
          AND EXISTS (
            SELECT 1 FROM orders purchase
            WHERE purchase.id = NEW.converted_order_id
              AND purchase.email = current.email
              AND purchase.customer_name = current.customer_name
              AND purchase.currency = current.currency
              AND purchase.subtotal_cents = current.subtotal_cents
              AND purchase.shipping_cents = current.shipping_cents
              AND purchase.total_cents = current.total_cents
          )
          AND (
            current.conversion_gate = 'approval'
            OR (current.conversion_gate = 'deposit' AND current.paid_cents >= current.deposit_cents)
            OR (current.conversion_gate = 'full_payment' AND current.paid_cents = current.total_cents)
          ))
      )
  );
END;

-- Un enlace solo refleja el siguiente tramo decidido por el servidor y no
-- puede sobrevivir a una versión distinta del presupuesto.
CREATE TRIGGER preliminary_payment_link_guard
BEFORE INSERT ON preliminary_order_payment_links
BEGIN
  SELECT RAISE(ABORT, 'preliminary_payment_link_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM preliminary_orders current
    WHERE current.id = NEW.preliminary_order_id
      AND current.status IN ('approved', 'converted')
      AND current.version = NEW.expected_order_version
      AND current.currency = NEW.currency
      AND NEW.status = 'active' AND NEW.expires_at > NEW.created_at
      AND (
        (current.payment_status = 'unpaid'
          AND current.deposit_cents > 0 AND current.deposit_cents < current.total_cents
          AND NEW.stage = 'deposit' AND NEW.amount_cents = current.deposit_cents)
        OR (current.payment_status = 'unpaid'
          AND (current.deposit_cents = 0 OR current.deposit_cents = current.total_cents)
          AND NEW.stage = 'full' AND NEW.amount_cents = current.total_cents)
        OR (current.payment_status = 'deposit_paid'
          AND NEW.stage = 'balance' AND NEW.amount_cents = current.total_cents - current.paid_cents)
      )
  );
END;

-- El pago solo nace de un enlace activo no vencido y conserva referencias
-- verificadas. El evento y el UPDATE posterior materializan el saldo.
CREATE TRIGGER preliminary_payment_guard
BEFORE INSERT ON preliminary_order_payments
BEGIN
  SELECT RAISE(ABORT, 'preliminary_payment_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM preliminary_order_payment_links link
    JOIN preliminary_orders current ON current.id = link.preliminary_order_id
    WHERE link.id = NEW.payment_link_id
      AND link.preliminary_order_id = NEW.preliminary_order_id
      AND link.status = 'active' AND link.expires_at > NEW.occurred_at
      AND link.expected_order_version = current.version
      AND link.stage = NEW.stage AND link.amount_cents = NEW.amount_cents
      AND link.currency = NEW.currency AND link.provider_adapter = NEW.provider_adapter
  );
END;
