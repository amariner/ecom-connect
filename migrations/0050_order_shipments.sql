-- Expediciones por línea: un pedido comercial puede servirse en varios paquetes.
-- El proveedor demo registra cada expedición y Ecom Connect conserva su copia
-- canónica, que es la que se comunica al marketplace.
CREATE TABLE supplier_shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_order_id TEXT NOT NULL REFERENCES supplier_orders(supplier_order_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  expedition_number TEXT NOT NULL UNIQUE,
  tracking TEXT NOT NULL UNIQUE,
  request_key TEXT NOT NULL,
  creation_token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(supplier_order_id,sequence),
  UNIQUE(supplier_order_id,request_key)
);
CREATE TABLE supplier_shipment_lines (
  shipment_id INTEGER NOT NULL REFERENCES supplier_shipments(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty >= 1),
  PRIMARY KEY(shipment_id,code)
);
CREATE TABLE order_shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 1),
  expedition_number TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  tracking_carrier TEXT NOT NULL,
  shipped_at TEXT NOT NULL,
  UNIQUE(order_id,sequence)
);
CREATE TABLE order_shipment_lines (
  shipment_id INTEGER NOT NULL REFERENCES order_shipments(id) ON DELETE CASCADE,
  supplier_sku TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty >= 1),
  PRIMARY KEY(shipment_id,supplier_sku)
);
-- Evidencia local del acuse de cada expedición. No ejecuta tráfico externo.
CREATE TABLE marketplace_shipment_updates (
  shipment_id INTEGER PRIMARY KEY REFERENCES order_shipments(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('AMAZON','MIRAVIA','CARREFOUR','EBAY')),
  reference TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  tracking_carrier TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX idx_order_shipments_order ON order_shipments(order_id,sequence);

-- Histórico: cada pedido ya expedido equivale a una única expedición completa.
INSERT INTO supplier_shipments(supplier_order_id,sequence,expedition_number,tracking,request_key,creation_token,created_at)
SELECT supplier_order_id,1,expedition_number,tracking,'complete','backfill-' || supplier_order_id,updated_at
FROM supplier_orders WHERE status='shipped' AND expedition_number IS NOT NULL AND tracking IS NOT NULL;
INSERT INTO supplier_shipment_lines(shipment_id,code,qty)
SELECT s.id,json_extract(line.value,'$.code'),json_extract(line.value,'$.qty')
FROM supplier_shipments s JOIN supplier_orders so ON so.supplier_order_id=s.supplier_order_id, json_each(so.items_json) line;
INSERT INTO order_shipments(order_id,sequence,expedition_number,tracking_number,tracking_carrier,shipped_at)
SELECT o.id,s.sequence,s.expedition_number,s.tracking,COALESCE(o.tracking_carrier,'Proveedor Demo'),COALESCE(o.last_supplier_sync,s.created_at)
FROM supplier_shipments s JOIN supplier_orders so ON so.supplier_order_id=s.supplier_order_id
JOIN orders o ON o.order_number=so.reference;
INSERT INTO order_shipment_lines(shipment_id,supplier_sku,qty)
SELECT c.id,l.code,l.qty FROM order_shipments c JOIN orders o ON o.id=c.order_id
JOIN supplier_orders so ON so.reference=o.order_number
JOIN supplier_shipments s ON s.supplier_order_id=so.supplier_order_id AND s.sequence=c.sequence
JOIN supplier_shipment_lines l ON l.shipment_id=s.id;
-- Un acuse vigente ya comunicó ese seguimiento: su expedición no queda pendiente.
INSERT INTO marketplace_shipment_updates(shipment_id,order_id,channel,reference,tracking_number,tracking_carrier,lines_json,synced_at)
SELECT c.id,c.order_id,m.channel,m.reference,c.tracking_number,c.tracking_carrier,
  (SELECT json_group_array(json_object('sku',l.supplier_sku,'qty',l.qty)) FROM order_shipment_lines l WHERE l.shipment_id=c.id),
  m.synced_at
FROM order_shipments c JOIN marketplace_order_updates m ON m.order_id=c.order_id AND m.tracking_number=c.tracking_number;
