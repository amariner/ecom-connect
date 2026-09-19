-- Cancelaciones del circuito omnicanal. El núcleo ya cancela el pedido y repone
-- el stock de tienda. Aquí se conserva quién la pidió, por qué y qué respondió
-- el proveedor demo, además del acuse de cancelación al marketplace.
CREATE TABLE supplier_order_cancellations (
  supplier_order_id TEXT PRIMARY KEY REFERENCES supplier_orders(supplier_order_id) ON DELETE CASCADE,
  creation_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- La solicitud se guarda antes de actuar. cancelled_at queda vacío hasta que la
-- cancelación termina, de modo que una interrupción siempre se puede completar.
CREATE TABLE order_cancellations (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('panel','marketplace')),
  reason TEXT NOT NULL CHECK(reason IN ('customer_request','out_of_stock','duplicate','other')),
  supplier_outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK(supplier_outcome IN ('pending','not_required','accepted','rejected')),
  requested_at TEXT NOT NULL,
  cancelled_at TEXT
);
-- Evidencia local del acuse de cancelación. No ejecuta tráfico externo.
CREATE TABLE marketplace_cancellation_updates (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('AMAZON','MIRAVIA','CARREFOUR','EBAY')),
  reference TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
