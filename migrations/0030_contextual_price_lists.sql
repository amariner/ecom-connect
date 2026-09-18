-- R4.6: listas de precios por empresa/mercado/canal con fallback por producto.
-- Expand-only: no crea listas ni altera precios del catálogo o pedidos existentes.

CREATE TABLE price_lists (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 100),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 120),
  state TEXT NOT NULL CHECK (state IN ('active','disabled','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version)='integer' AND version>=1),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (typeof(priority)='integer' AND priority BETWEEN 0 AND 100000),
  currency TEXT NOT NULL CHECK (length(currency)=3 AND currency=upper(currency)),
  active_from TEXT,
  active_until TEXT,
  markets_json TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(markets_json) AND json_type(markets_json)='array'),
  channels_json TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(channels_json) AND json_type(channels_json)='array'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (active_until IS NULL OR active_from IS NULL OR active_until>active_from)
);

CREATE TABLE price_list_products (
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  price_cents INTEGER NOT NULL CHECK (typeof(price_cents)='integer' AND price_cents BETWEEN 1 AND 10000000),
  PRIMARY KEY (price_list_id, product_id)
);

CREATE TABLE price_list_companies (
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) ON DELETE RESTRICT,
  company_key_hash TEXT NOT NULL CHECK (
    length(company_key_hash)=64 AND company_key_hash=lower(company_key_hash)
    AND company_key_hash NOT GLOB '*[^a-f0-9]*'
  ),
  PRIMARY KEY (price_list_id, company_key_hash)
);

CREATE TABLE price_list_applications (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 120),
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) ON DELETE RESTRICT,
  price_list_version INTEGER NOT NULL CHECK (price_list_version>=1),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  catalog_subtotal_cents INTEGER NOT NULL CHECK (catalog_subtotal_cents>=0),
  effective_subtotal_cents INTEGER NOT NULL CHECK (effective_subtotal_cents>=0),
  line_count INTEGER NOT NULL CHECK (line_count>=1),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 3 AND 200),
  applied_at TEXT NOT NULL,
  UNIQUE (price_list_id, order_id)
);

CREATE TRIGGER price_list_application_insert_guard
BEFORE INSERT ON price_list_applications
BEGIN
  SELECT RAISE(ABORT, 'price_list_application_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM price_lists list JOIN orders o ON o.id=NEW.order_id
    WHERE list.id=NEW.price_list_id AND upper(o.currency)=list.currency
      AND (
        (o.status='pending' AND (
          (list.version=NEW.price_list_version AND list.state='active'
            AND (list.active_from IS NULL OR list.active_from<=NEW.applied_at)
            AND (list.active_until IS NULL OR list.active_until>NEW.applied_at))
          OR (NEW.applied_at<list.updated_at AND NEW.price_list_version<=list.version)
        ))
        OR (o.status IN ('paid','shipped','delivered','cancelled')
          AND NEW.price_list_version<=list.version)
      )
      AND json_extract(NEW.snapshot_json,'$.schema')=1
      AND json_extract(NEW.snapshot_json,'$.price_list_id')=list.id
      AND json_extract(NEW.snapshot_json,'$.version')=NEW.price_list_version
      AND json_extract(NEW.snapshot_json,'$.line_count')=NEW.line_count
      AND json_extract(NEW.snapshot_json,'$.catalog_subtotal_cents')=NEW.catalog_subtotal_cents
      AND json_extract(NEW.snapshot_json,'$.effective_subtotal_cents')=NEW.effective_subtotal_cents
      AND json_extract(NEW.snapshot_json,'$.delta_cents')=
        NEW.effective_subtotal_cents-NEW.catalog_subtotal_cents
      AND NEW.line_count=(SELECT count(*) FROM order_items oi WHERE oi.order_id=o.id
        AND json_extract(oi.pricing_snapshot_json,'$.price_origin.type')='price_list'
        AND json_extract(oi.pricing_snapshot_json,'$.price_origin.price_list_id')=list.id)
      AND NEW.catalog_subtotal_cents=(SELECT coalesce(sum(
        json_extract(oi.pricing_snapshot_json,'$.price_origin.catalog_unit_price_cents')
          *coalesce(oi.current_qty,oi.qty)),0)
        FROM order_items oi WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.price_origin.type')='price_list'
          AND json_extract(oi.pricing_snapshot_json,'$.price_origin.price_list_id')=list.id)
      AND NEW.effective_subtotal_cents=(SELECT coalesce(sum(
        oi.base_unit_price_cents*coalesce(oi.current_qty,oi.qty)),0)
        FROM order_items oi WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.price_origin.type')='price_list'
          AND json_extract(oi.pricing_snapshot_json,'$.price_origin.price_list_id')=list.id)
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.price_origin.type')='price_list'
          AND json_extract(oi.pricing_snapshot_json,'$.price_origin.price_list_id')=list.id
          AND (
            json_extract(oi.pricing_snapshot_json,'$.price_origin.version') IS NOT NEW.price_list_version
            OR json_extract(oi.pricing_snapshot_json,'$.price_origin.label') IS NOT list.label
            OR json_extract(oi.pricing_snapshot_json,'$.price_origin.priority') IS NOT list.priority
            OR json_extract(oi.pricing_snapshot_json,'$.price_origin.unit_price_cents') IS NOT oi.base_unit_price_cents
            OR json_extract(oi.pricing_snapshot_json,'$.base_unit_price_cents') IS NOT oi.base_unit_price_cents
            OR json_extract(oi.pricing_snapshot_json,'$.currency') IS NOT list.currency
            OR json_extract(oi.pricing_snapshot_json,'$.quantity') IS NOT coalesce(oi.current_qty,oi.qty)
            OR json_extract(oi.pricing_snapshot_json,'$.price_origin.company_scoped') IS NOT
              CASE WHEN EXISTS (SELECT 1 FROM price_list_companies company
                WHERE company.price_list_id=list.id) THEN 1 ELSE 0 END
            OR NOT EXISTS (SELECT 1 FROM price_list_products product
              WHERE product.price_list_id=list.id AND product.product_id=oi.product_id
                AND product.price_cents=oi.base_unit_price_cents)
            OR NOT EXISTS (SELECT 1 FROM json_each(list.markets_json) market
              WHERE market.value='*' OR market.value=json_extract(oi.pricing_snapshot_json,'$.context.market'))
            OR NOT EXISTS (SELECT 1 FROM json_each(list.channels_json) channel
              WHERE channel.value='*' OR channel.value=json_extract(oi.pricing_snapshot_json,'$.context.channel'))
          )
      )
  );
END;

CREATE INDEX idx_price_lists_active ON price_lists(state, priority, id);
CREATE INDEX idx_price_list_companies_hash ON price_list_companies(company_key_hash, price_list_id);
CREATE INDEX idx_price_list_applications_list ON price_list_applications(price_list_id, price_list_version);
