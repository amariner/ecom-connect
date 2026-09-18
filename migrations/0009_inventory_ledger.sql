-- Ledger de inventario global por variante (R2.7; ADR-0014).
--
-- Migracion aditiva. `products.stock` permanece como espejo de la variante
-- default para permitir rollback del binario hasta R2.14.

CREATE TABLE inventory_balances (
  variant_id INTEGER NOT NULL PRIMARY KEY
    REFERENCES product_variants(id) ON DELETE RESTRICT,
  on_hand INTEGER NOT NULL
    CHECK (typeof(on_hand) = 'integer' AND on_hand >= 0),
  reserved INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(reserved) = 'integer' AND reserved >= 0),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (reserved <= on_hand)
);

CREATE TABLE inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL
    REFERENCES product_variants(id) ON DELETE RESTRICT,
  delta INTEGER NOT NULL CHECK (
    typeof(delta) = 'integer'
    AND (delta <> 0 OR reason = 'legacy_opening_balance')
  ),
  reason TEXT NOT NULL CHECK (reason IN (
    'legacy_opening_balance',
    'sale',
    'cancellation_restock',
    'return_restock',
    'manual_adjustment',
    'reconciliation_correction',
    'damage'
  )),
  balance_after INTEGER NOT NULL
    CHECK (typeof(balance_after) = 'integer' AND balance_after >= 0),
  version_after INTEGER NOT NULL
    CHECK (typeof(version_after) = 'integer' AND version_after >= 1),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'admin', 'provider')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 120),
  reference_type TEXT NOT NULL CHECK (length(trim(reference_type)) BETWEEN 1 AND 80),
  reference_id TEXT NOT NULL CHECK (length(trim(reference_id)) BETWEEN 1 AND 160),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  correlation_id TEXT NOT NULL
    CHECK (length(trim(correlation_id)) BETWEEN 1 AND 160),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (variant_id, version_after)
);

CREATE INDEX idx_inventory_movements_variant
  ON inventory_movements(variant_id, version_after, id);
CREATE INDEX idx_inventory_movements_reference
  ON inventory_movements(reference_type, reference_id, id);
CREATE INDEX idx_inventory_movements_correlation
  ON inventory_movements(correlation_id, id);

-- El modelo legacy no distinguia pools: ADR-0012 replica el stock del producto
-- en cada variante. Cero tambien genera apertura para que sum(delta)=on_hand.
INSERT INTO inventory_balances (variant_id, on_hand, reserved, version, updated_at)
SELECT pv.id, p.stock, 0, 1, datetime('now')
FROM product_variants pv
JOIN products p ON p.id = pv.product_id
ORDER BY pv.id;

INSERT INTO inventory_movements (
  variant_id, delta, reason, balance_after, version_after,
  actor_kind, actor_id, reference_type, reference_id,
  idempotency_key, correlation_id, occurred_at, created_at
)
SELECT
  b.variant_id, b.on_hand, 'legacy_opening_balance', b.on_hand, 1,
  'system', 'migration-0009', 'migration', '0009_inventory_ledger',
  'r2:inventory:opening:' || b.variant_id,
  'inventory:variant:' || b.variant_id,
  b.updated_at, b.updated_at
FROM inventory_balances b
ORDER BY b.variant_id;
