-- Edicion segura de pedidos (R3.3; ADR-0019).
--
-- Migracion expand-only. Los snapshots originales de `orders` y
-- `order_items.qty` permanecen disponibles para rollback; el runtime nuevo
-- usa `edit_version` y `current_qty` como proyecciones vigentes.

ALTER TABLE orders ADD COLUMN edit_version INTEGER NOT NULL DEFAULT 1
  CHECK (typeof(edit_version) = 'integer' AND edit_version >= 1);

ALTER TABLE order_items ADD COLUMN current_qty INTEGER
  CHECK (
    current_qty IS NULL
    OR (typeof(current_qty) = 'integer' AND current_qty >= 0)
  );

UPDATE order_items SET current_qty = qty WHERE current_qty IS NULL;

CREATE UNIQUE INDEX idx_order_items_order_variant
  ON order_items(order_id, variant_id)
  WHERE variant_id IS NOT NULL;

CREATE TABLE order_amendments (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(trim(id)) BETWEEN 8 AND 120),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'pending_payment', 'pending_refund', 'ready', 'applied',
    'expired', 'cancelled', 'requires_review'
  )),
  expected_order_version INTEGER NOT NULL
    CHECK (typeof(expected_order_version) = 'integer' AND expected_order_version >= 1),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 240),
  currency TEXT NOT NULL
    CHECK (length(currency) = 3 AND currency = upper(currency)),
  address_before_json TEXT NOT NULL CHECK (json_valid(address_before_json)),
  address_after_json TEXT NOT NULL CHECK (json_valid(address_after_json)),
  subtotal_before_cents INTEGER NOT NULL
    CHECK (typeof(subtotal_before_cents) = 'integer' AND subtotal_before_cents >= 0),
  shipping_before_cents INTEGER NOT NULL
    CHECK (typeof(shipping_before_cents) = 'integer' AND shipping_before_cents >= 0),
  total_before_cents INTEGER NOT NULL
    CHECK (typeof(total_before_cents) = 'integer' AND total_before_cents >= 0
      AND total_before_cents = subtotal_before_cents + shipping_before_cents),
  subtotal_after_cents INTEGER NOT NULL
    CHECK (typeof(subtotal_after_cents) = 'integer' AND subtotal_after_cents >= 0),
  shipping_after_cents INTEGER NOT NULL
    CHECK (typeof(shipping_after_cents) = 'integer' AND shipping_after_cents >= 0),
  total_after_cents INTEGER NOT NULL
    CHECK (typeof(total_after_cents) = 'integer' AND total_after_cents >= 0
      AND total_after_cents = subtotal_after_cents + shipping_after_cents),
  delta_cents INTEGER NOT NULL CHECK (
    typeof(delta_cents) = 'integer'
    AND delta_cents = total_after_cents - total_before_cents
  ),
  stripe_session_id TEXT UNIQUE,
  expires_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  expired_at TEXT,
  cancelled_at TEXT,
  UNIQUE (id, order_id),
  CHECK (
    (status = 'pending_payment' AND delta_cents > 0
      AND stripe_session_id IS NOT NULL AND expires_at IS NOT NULL
      AND applied_at IS NULL AND expired_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'pending_refund' AND delta_cents < 0
      AND stripe_session_id IS NULL AND expires_at IS NULL
      AND applied_at IS NULL AND expired_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'ready' AND delta_cents = 0
      AND stripe_session_id IS NULL AND expires_at IS NULL
      AND applied_at IS NULL AND expired_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'applied' AND applied_at IS NOT NULL
      AND expired_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'expired' AND delta_cents > 0 AND expired_at IS NOT NULL
      AND applied_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL
      AND applied_at IS NULL AND expired_at IS NULL)
    OR (status = 'requires_review' AND delta_cents < 0
      AND applied_at IS NULL AND expired_at IS NULL AND cancelled_at IS NULL)
  )
);

CREATE UNIQUE INDEX idx_order_amendments_active
  ON order_amendments(order_id)
  WHERE status IN ('pending_payment', 'pending_refund', 'ready', 'requires_review');

CREATE INDEX idx_order_amendments_order
  ON order_amendments(order_id, created_at, id);

CREATE INDEX idx_order_amendments_expiry
  ON order_amendments(expires_at, id)
  WHERE status = 'pending_payment';

CREATE TABLE order_amendment_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amendment_id TEXT NOT NULL,
  order_id INTEGER NOT NULL,
  order_item_id INTEGER,
  product_id INTEGER NOT NULL,
  variant_id INTEGER NOT NULL,
  name_snapshot TEXT NOT NULL CHECK (length(trim(name_snapshot)) BETWEEN 1 AND 200),
  sku_snapshot TEXT NOT NULL CHECK (length(trim(sku_snapshot)) BETWEEN 1 AND 100),
  variant_name_snapshot TEXT,
  unit_price_cents INTEGER NOT NULL
    CHECK (typeof(unit_price_cents) = 'integer' AND unit_price_cents >= 0),
  quantity_before INTEGER NOT NULL
    CHECK (typeof(quantity_before) = 'integer' AND quantity_before >= 0),
  quantity_after INTEGER NOT NULL
    CHECK (typeof(quantity_after) = 'integer' AND quantity_after >= 0),
  quantity_delta INTEGER NOT NULL CHECK (
    typeof(quantity_delta) = 'integer'
    AND quantity_delta = quantity_after - quantity_before
    AND quantity_delta <> 0
  ),
  amount_delta_cents INTEGER NOT NULL CHECK (
    typeof(amount_delta_cents) = 'integer'
    AND amount_delta_cents = unit_price_cents * quantity_delta
  ),
  created_at TEXT NOT NULL,
  UNIQUE (amendment_id, variant_id),
  FOREIGN KEY (amendment_id, order_id)
    REFERENCES order_amendments(id, order_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_item_id, order_id)
    REFERENCES order_items(id, order_id) ON DELETE RESTRICT,
  FOREIGN KEY (variant_id, product_id)
    REFERENCES product_variants(id, product_id) ON DELETE RESTRICT
);

CREATE INDEX idx_order_amendment_lines_order
  ON order_amendment_lines(order_id, amendment_id, id);

ALTER TABLE refunds ADD COLUMN amendment_id TEXT
  REFERENCES order_amendments(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_refunds_amendment
  ON refunds(amendment_id)
  WHERE amendment_id IS NOT NULL;

CREATE UNIQUE INDEX idx_payment_transactions_id_payment
  ON payment_transactions(id, payment_id);

CREATE TABLE refund_payment_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id INTEGER NOT NULL REFERENCES refunds(id) ON DELETE RESTRICT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  capture_transaction_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL
    CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed',
    'requires_review', 'cancelled'
  )),
  provider_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (refund_id, capture_transaction_id),
  FOREIGN KEY (capture_transaction_id, payment_id)
    REFERENCES payment_transactions(id, payment_id) ON DELETE RESTRICT
);

CREATE INDEX idx_refund_allocations_refund
  ON refund_payment_allocations(refund_id, id);

CREATE INDEX idx_refund_allocations_capture
  ON refund_payment_allocations(capture_transaction_id, status, id);

-- Cada asignacion pertenece al mismo pago que su reembolso y reserva saldo de
-- una captura concreta. failed/requires_review siguen reservando el importe:
-- solo cancelled lo libera, igual que las cantidades de R2.13.
CREATE TRIGGER refund_payment_allocation_guard
BEFORE INSERT ON refund_payment_allocations
BEGIN
  SELECT RAISE(ABORT, 'refund_payment_allocation_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM refunds r
    JOIN payment_transactions capture
      ON capture.id = NEW.capture_transaction_id
     AND capture.payment_id = NEW.payment_id
     AND capture.type = 'capture'
     AND capture.status = 'succeeded'
    WHERE r.id = NEW.refund_id
      AND r.payment_id = NEW.payment_id
      AND NEW.amount_cents + COALESCE((
        SELECT sum(existing.amount_cents)
        FROM refund_payment_allocations existing
        WHERE existing.capture_transaction_id = capture.id
          AND existing.status <> 'cancelled'
      ), 0) <= capture.amount_cents
  );
END;

-- Backfill determinista de los reembolsos R2 existentes. Antes de R3.3 cada
-- pago tenia una sola captura; el preflight del rehearsal bloquea cualquier
-- historia que no cumpla esa invariante.
INSERT INTO refund_payment_allocations (
  refund_id, payment_id, capture_transaction_id, amount_cents,
  status, provider_reference, idempotency_key, version, created_at, updated_at
)
SELECT
  r.id,
  r.payment_id,
  (
    SELECT capture.id FROM payment_transactions capture
    WHERE capture.payment_id = r.payment_id
      AND capture.type = 'capture' AND capture.status = 'succeeded'
    ORDER BY capture.occurred_at, capture.id LIMIT 1
  ),
  r.total_cents,
  CASE r.status
    WHEN 'succeeded' THEN 'succeeded'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE r.status
  END,
  r.provider_reference,
  r.idempotency_key || ':allocation:1',
  r.version,
  r.created_at,
  r.updated_at
FROM refunds r
WHERE r.total_cents > 0;
