-- Motor de asignación R3.9. Expand-only: el pedido pagado sigue comprometido
-- en principal; una asignación secundaria traslada ese consumo al enviar.

CREATE TABLE inventory_routing_policies (
  location_id INTEGER PRIMARY KEY REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL DEFAULT 1000 CHECK (priority BETWEEN 0 AND 100000),
  handling_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (handling_cost_cents BETWEEN 0 AND 10000000),
  markets_json TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(markets_json) AND json_type(markets_json) = 'array'),
  channels_json TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(channels_json) AND json_type(channels_json) = 'array'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO inventory_routing_policies (
  location_id, priority, handling_cost_cents, markets_json, channels_json,
  enabled, version, created_at, updated_at
)
SELECT id, CASE WHEN is_primary = 1 THEN 100 ELSE 50 END, 0, '["*"]', '["*"]',
  1, 1, datetime('now'), datetime('now')
FROM inventory_locations ORDER BY id;

CREATE TRIGGER inventory_routing_policy_after_location_insert
AFTER INSERT ON inventory_locations BEGIN
  INSERT INTO inventory_routing_policies (
    location_id, priority, handling_cost_cents, markets_json, channels_json,
    enabled, version, created_at, updated_at
  ) VALUES (NEW.id, 1000, 0, '["*"]', '["*"]', 1, 1, NEW.created_at, NEW.updated_at);
END;

CREATE TABLE inventory_allocation_decisions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  fulfillment_id INTEGER NOT NULL UNIQUE REFERENCES fulfillments(id) ON DELETE RESTRICT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  location_id INTEGER NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
  market TEXT NOT NULL CHECK (length(market) BETWEEN 2 AND 20),
  channel TEXT NOT NULL CHECK (length(channel) BETWEEN 2 AND 40),
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  explanation_json TEXT NOT NULL CHECK (json_valid(explanation_json) AND json_type(explanation_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (id, fulfillment_id, order_id)
);

CREATE INDEX idx_inventory_allocation_decisions_order
  ON inventory_allocation_decisions(order_id, created_at, id);
CREATE INDEX idx_inventory_allocation_decisions_location
  ON inventory_allocation_decisions(location_id, created_at, id);

CREATE TABLE inventory_allocation_lines (
  decision_id TEXT NOT NULL,
  fulfillment_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  order_item_id INTEGER NOT NULL,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  available_before INTEGER NOT NULL CHECK (available_before >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (decision_id, order_item_id),
  FOREIGN KEY (decision_id, fulfillment_id, order_id)
    REFERENCES inventory_allocation_decisions(id, fulfillment_id, order_id) ON DELETE RESTRICT,
  FOREIGN KEY (order_item_id, order_id)
    REFERENCES order_items(id, order_id) ON DELETE RESTRICT
);

CREATE INDEX idx_inventory_allocation_lines_variant
  ON inventory_allocation_lines(variant_id, decision_id);

CREATE TABLE inventory_allocation_movements (
  decision_id TEXT NOT NULL REFERENCES inventory_allocation_decisions(id) ON DELETE RESTRICT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  movement_kind TEXT NOT NULL CHECK (movement_kind IN ('primary_release', 'secondary_consume')),
  location_movement_id INTEGER NOT NULL UNIQUE REFERENCES inventory_location_movements(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (decision_id, variant_id, movement_kind)
);

CREATE INDEX idx_inventory_allocation_movements_decision
  ON inventory_allocation_movements(decision_id, variant_id, movement_kind);
