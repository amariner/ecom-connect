-- Ledger de pagos y estructura de reembolsos (R2.9; ADR-0012).
--
-- Migracion aditiva. `orders.status` y `orders.stripe_*` permanecen como
-- espejos de rollback hasta R2.14; ninguna respuesta cruda del PSP ni dato de
-- tarjeta entra en estas tablas.

-- El valor vacío es la ventana expand/contract: el binario anterior puede
-- seguir insertando durante la migración. El backfill coordinado lo sustituye
-- por `shopConfig.currency`; el binario R2.9 siempre escribe moneda explícita.
ALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT ''
  CHECK (currency = '' OR (length(currency) = 3 AND currency = upper(currency)));

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'simulated', 'legacy')),
  provider_reference TEXT,
  currency TEXT NOT NULL
    CHECK (length(currency) = 3 AND currency = upper(currency)),
  expected_amount_cents INTEGER NOT NULL
    CHECK (typeof(expected_amount_cents) = 'integer' AND expected_amount_cents >= 0),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'authorized', 'captured', 'partially_refunded', 'refunded',
    'failed', 'cancelled', 'requires_review'
  )),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_payments_order ON payments(order_id, id);
CREATE UNIQUE INDEX idx_payments_provider_reference
  ON payments(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE TABLE payment_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN (
    'authorization', 'capture', 'refund', 'void', 'adjustment'
  )),
  amount_cents INTEGER NOT NULL
    CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  currency TEXT NOT NULL
    CHECK (length(currency) = 3 AND currency = upper(currency)),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'succeeded', 'failed', 'requires_review'
  )),
  provider_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_payment_transactions_payment
  ON payment_transactions(payment_id, occurred_at, id);
CREATE UNIQUE INDEX idx_payment_transactions_provider_reference
  ON payment_transactions(type, provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE TABLE refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed', 'cancelled', 'requires_review'
  )),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 240),
  subtotal_cents INTEGER NOT NULL
    CHECK (typeof(subtotal_cents) = 'integer' AND subtotal_cents >= 0),
  shipping_cents INTEGER NOT NULL
    CHECK (typeof(shipping_cents) = 'integer' AND shipping_cents >= 0),
  total_cents INTEGER NOT NULL
    CHECK (typeof(total_cents) = 'integer' AND total_cents >= 0
      AND total_cents = subtotal_cents + shipping_cents),
  provider_reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_refunds_order ON refunds(order_id, id);
CREATE INDEX idx_refunds_payment ON refunds(payment_id, id);
CREATE UNIQUE INDEX idx_refunds_provider_reference
  ON refunds(provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE TABLE refund_items (
  refund_id INTEGER NOT NULL REFERENCES refunds(id) ON DELETE RESTRICT,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL
    CHECK (typeof(quantity) = 'integer' AND quantity > 0),
  amount_cents INTEGER NOT NULL
    CHECK (typeof(amount_cents) = 'integer' AND amount_cents >= 0),
  restock_decision TEXT NOT NULL DEFAULT 'pending'
    CHECK (restock_decision IN ('pending', 'none', 'restock')),
  PRIMARY KEY (refund_id, order_item_id)
);

CREATE INDEX idx_refund_items_order_item
  ON refund_items(order_item_id, refund_id);

-- Una transaccion es un asiento inmutable. La guarda valida moneda, saldo y
-- referencia al insertar; cualquier correccion futura sera otro asiento.
-- Véase la nota equivalente en 0010: una sola línea y sin CASE ... END anidado.
CREATE TRIGGER payment_transaction_guard BEFORE INSERT ON payment_transactions BEGIN SELECT RAISE(ABORT, 'payment_transaction_conflict') WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW.payment_id AND p.currency = NEW.currency AND (NEW.status <> 'succeeded' OR (NEW.type IN ('authorization', 'capture') AND NEW.amount_cents + COALESCE((SELECT sum(t.amount_cents) FROM payment_transactions t WHERE t.payment_id = p.id AND t.type = NEW.type AND t.status = 'succeeded'), 0) <= p.expected_amount_cents) OR (NEW.type = 'refund' AND NEW.amount_cents > 0 AND NEW.amount_cents + COALESCE((SELECT sum(t.amount_cents) FROM payment_transactions t WHERE t.payment_id = p.id AND t.type = 'refund' AND t.status = 'succeeded'), 0) <= COALESCE((SELECT sum(t.amount_cents) FROM payment_transactions t WHERE t.payment_id = p.id AND t.type = 'capture' AND t.status = 'succeeded'), 0)) OR NEW.type = 'adjustment' OR (NEW.type = 'void' AND NEW.amount_cents = 0))); END;
