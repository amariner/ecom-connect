-- Evidencia local del retorno de estado/tracking al hub. No ejecuta tráfico externo.
CREATE TABLE marketplace_order_updates (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('AMAZON','MIRAVIA','CARREFOUR','EBAY')),
  reference TEXT NOT NULL,
  supplier_status TEXT NOT NULL CHECK(supplier_status IN (
    'PENDING_SUPPLIER','SUPPLIER_ACCEPTED','SUPPLIER_PROCESSING','SUPPLIER_PARTIAL','SUPPLIER_SHIPPED','ERROR'
  )),
  tracking_number TEXT,
  tracking_carrier TEXT,
  synced_at TEXT NOT NULL,
  UNIQUE(channel,reference)
);
