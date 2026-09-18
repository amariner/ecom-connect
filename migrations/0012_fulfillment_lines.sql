-- Fulfillment por lineas (R2.11; ADR-0015).
--
-- Migracion aditiva. `orders.status` y `orders.tracking_*` permanecen como
-- proyeccion de rollback hasta R2.14; el tracking canonico pertenece al grupo.

-- Permite que las dos relaciones compuestas de fulfillment_items demuestren
-- en D1 que el grupo y la linea pertenecen al mismo pedido.
CREATE UNIQUE INDEX idx_order_items_id_order
  ON order_items(id, order_id);

CREATE TABLE fulfillments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL
    REFERENCES orders(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'shipped', 'delivered', 'cancelled')),
  carrier TEXT CHECK (
    carrier IS NULL OR length(trim(carrier)) BETWEEN 1 AND 60
  ),
  tracking_number TEXT CHECK (
    tracking_number IS NULL OR length(trim(tracking_number)) BETWEEN 1 AND 80
  ),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 200),
  version INTEGER NOT NULL DEFAULT 1
    CHECK (typeof(version) = 'integer' AND version >= 1),
  ready_at TEXT,
  shipped_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id, order_id),
  CHECK ((carrier IS NULL) = (tracking_number IS NULL)),
  CHECK (
    (status = 'pending'
      AND ready_at IS NULL AND shipped_at IS NULL
      AND delivered_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'ready'
      AND ready_at IS NOT NULL AND shipped_at IS NULL
      AND delivered_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'shipped'
      AND carrier IS NOT NULL AND tracking_number IS NOT NULL
      AND shipped_at IS NOT NULL AND delivered_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'delivered'
      AND carrier IS NOT NULL AND tracking_number IS NOT NULL
      AND shipped_at IS NOT NULL AND delivered_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled'
      AND shipped_at IS NULL AND delivered_at IS NULL AND cancelled_at IS NOT NULL)
  )
);

CREATE TABLE fulfillment_items (
  fulfillment_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  order_item_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL
    CHECK (typeof(quantity) = 'integer' AND quantity > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (fulfillment_id, order_item_id),
  FOREIGN KEY (fulfillment_id, order_id)
    REFERENCES fulfillments(id, order_id) ON DELETE CASCADE,
  FOREIGN KEY (order_item_id, order_id)
    REFERENCES order_items(id, order_id) ON DELETE RESTRICT
);

CREATE INDEX idx_fulfillments_order
  ON fulfillments(order_id, status, id);

CREATE INDEX idx_fulfillments_operation
  ON fulfillments(status, updated_at, id);

CREATE INDEX idx_fulfillment_items_order_item
  ON fulfillment_items(order_item_id, fulfillment_id);
