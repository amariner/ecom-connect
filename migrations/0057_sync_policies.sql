CREATE TABLE sync_policies (
 id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL CHECK(json_valid(value)),
 revision INTEGER NOT NULL, creation_token TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE orders ADD COLUMN supplier_delivery_json TEXT CHECK(supplier_delivery_json IS NULL OR json_valid(supplier_delivery_json));
CREATE TABLE supplier_order_messages (
 supplier_order_id TEXT NOT NULL REFERENCES supplier_orders(supplier_order_id),
 sequence INTEGER NOT NULL, packing TEXT NOT NULL CHECK(packing IN ('order','product')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY(supplier_order_id,sequence)
);
CREATE TABLE automation_slots (
 slot_key TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed')), result_json TEXT, error TEXT
);
CREATE TABLE hub_sync_runs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, status TEXT NOT NULL,
 started_at TEXT NOT NULL, finished_at TEXT, error TEXT
);
CREATE UNIQUE INDEX idx_hub_sync_running ON hub_sync_runs(status) WHERE status='running';
CREATE TABLE hub_sync_steps (
 run_id INTEGER NOT NULL REFERENCES hub_sync_runs(id), resource TEXT NOT NULL, direction TEXT NOT NULL,
 processed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(run_id,resource)
);
CREATE TABLE marketplace_catalog_snapshots (
 channel TEXT PRIMARY KEY, products_json TEXT NOT NULL CHECK(json_valid(products_json)), synced_at TEXT NOT NULL
);
CREATE TABLE hub_web_sales (
 order_id INTEGER PRIMARY KEY REFERENCES orders(id), payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), synced_at TEXT NOT NULL
);
