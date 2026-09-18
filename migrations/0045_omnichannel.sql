-- Extensión aislada de la demo: reutiliza products/orders y el ledger original.
ALTER TABLE products ADD COLUMN sku TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN supplier_sku TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN ean TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN brand TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN vat INTEGER NOT NULL DEFAULT 21 CHECK (vat IN (0,4,10,21));
ALTER TABLE products ADD COLUMN last_synced_at TEXT;
CREATE UNIQUE INDEX idx_product_supplier_sku ON products(supplier_sku) WHERE supplier_sku <> '';
ALTER TABLE orders ADD COLUMN channel TEXT NOT NULL DEFAULT 'WEB' CHECK (channel IN ('WEB','AMAZON','MIRAVIA','CARREFOUR','EBAY'));
ALTER TABLE orders ADD COLUMN supplier_status TEXT NOT NULL DEFAULT 'PENDING_SUPPLIER'
  CHECK (supplier_status IN ('PENDING_SUPPLIER','SUPPLIER_ACCEPTED','SUPPLIER_PROCESSING','SUPPLIER_PARTIAL','SUPPLIER_SHIPPED','ERROR'));
ALTER TABLE orders ADD COLUMN supplier_order_id TEXT;
ALTER TABLE orders ADD COLUMN last_supplier_sync TEXT;
ALTER TABLE orders ADD COLUMN supplier_stock_committed INTEGER NOT NULL DEFAULT 0 CHECK (supplier_stock_committed IN (0,1));
ALTER TABLE orders ADD COLUMN request_hash TEXT;
CREATE INDEX idx_orders_channel ON orders(channel,created_at);
CREATE INDEX idx_orders_supplier_pending ON orders(status,supplier_stock_committed,supplier_status);
CREATE TABLE supplier_products (
  code TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0), pvp_cents INTEGER,
  discount INTEGER NOT NULL DEFAULT 0 CHECK(discount BETWEEN 0 AND 100), brand TEXT NOT NULL,
  vat INTEGER NOT NULL DEFAULT 21 CHECK(vat IN (0,4,10,21)), category TEXT NOT NULL,
  image TEXT NOT NULL, ean TEXT NOT NULL, sku TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  stock INTEGER NOT NULL CHECK(stock >= 0), backup_stock INTEGER NOT NULL DEFAULT 0 CHECK(backup_stock >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE supplier_orders (
  supplier_order_id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','processing','partial','shipped','error')),
  items_json TEXT NOT NULL, creation_token TEXT NOT NULL,
  expedition_number TEXT, tracking TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE integration_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE integration_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, integration TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE integration_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, title TEXT NOT NULL,
  detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE marketplace_publications (
  channel TEXT PRIMARY KEY CHECK(channel IN ('AMAZON','MIRAVIA','CARREFOUR','EBAY')),
  published INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
