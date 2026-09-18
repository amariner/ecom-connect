-- R4.3: descuentos automáticos versionados, scope de producto y aplicación
-- trazable por pedido. Expand-only; no crea campañas ni cambia precios.

CREATE TABLE automatic_discounts (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 100),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 120),
  public_reason TEXT NOT NULL CHECK (length(trim(public_reason)) BETWEEN 2 AND 160),
  state TEXT NOT NULL CHECK (state IN ('active','disabled','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version)='integer' AND version>=1),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (typeof(priority)='integer' AND priority BETWEEN 0 AND 100000),
  currency TEXT NOT NULL CHECK (length(currency)=3 AND currency=upper(currency)),
  effect_type TEXT NOT NULL CHECK (effect_type IN ('percentage_off','amount_off')),
  basis_points INTEGER CHECK (basis_points BETWEEN 1 AND 10000),
  amount_cents INTEGER CHECK (amount_cents BETWEEN 1 AND 10000000),
  active_from TEXT,
  active_until TEXT,
  markets_json TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(markets_json) AND json_type(markets_json)='array'),
  channels_json TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(channels_json) AND json_type(channels_json)='array'),
  minimum_subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (minimum_subtotal_cents>=0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((effect_type='percentage_off' AND basis_points IS NOT NULL AND amount_cents IS NULL)
      OR (effect_type='amount_off' AND amount_cents IS NOT NULL AND basis_points IS NULL)),
  CHECK (active_until IS NULL OR active_from IS NULL OR active_until>active_from)
);

CREATE TABLE automatic_discount_products (
  discount_id TEXT NOT NULL REFERENCES automatic_discounts(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  PRIMARY KEY (discount_id, product_id)
);

CREATE TABLE automatic_discount_applications (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 120),
  discount_id TEXT NOT NULL REFERENCES automatic_discounts(id) ON DELETE RESTRICT,
  discount_version INTEGER NOT NULL CHECK (discount_version>=1),
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  discount_cents INTEGER NOT NULL CHECK (discount_cents>0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 3 AND 200),
  applied_at TEXT NOT NULL
);

CREATE TRIGGER automatic_discount_application_insert_guard
BEFORE INSERT ON automatic_discount_applications
BEGIN
  SELECT RAISE(ABORT, 'automatic_discount_application_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM automatic_discounts ad JOIN orders o ON o.id=NEW.order_id
    WHERE ad.id=NEW.discount_id
      AND upper(o.currency)=ad.currency
      AND (
        (o.status='pending' AND (
          (ad.state='active' AND ad.version=NEW.discount_version
            AND (ad.active_from IS NULL OR ad.active_from<=NEW.applied_at)
            AND (ad.active_until IS NULL OR ad.active_until>NEW.applied_at))
          OR (NEW.applied_at<ad.updated_at AND NEW.discount_version<=ad.version)
        ))
        OR o.status IN ('paid','shipped','delivered','cancelled')
      )
      AND ad.minimum_subtotal_cents<=(
        SELECT coalesce(sum(oi.base_unit_price_cents*coalesce(oi.current_qty,oi.qty)),0)
        FROM order_items oi WHERE oi.order_id=o.id
      )
      AND NEW.discount_cents=(
        SELECT coalesce(sum(json_extract(oi.pricing_snapshot_json,'$.discount_cents')),0)
        FROM order_items oi WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')='automatic:'||ad.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM promotion_code_usages u WHERE u.order_id=o.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id') LIKE 'automatic:%'
          AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')<>'automatic:'||ad.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')='automatic:'||ad.id
          AND (
            json_extract(oi.pricing_snapshot_json,'$.applied_rule.version') IS NOT NEW.discount_version
            OR json_extract(oi.pricing_snapshot_json,'$.applied_rule.label') IS NOT ad.public_reason
            OR json_extract(oi.pricing_snapshot_json,'$.applied_rule.effect.type') IS NOT ad.effect_type
            OR (ad.effect_type='percentage_off'
              AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.effect.basisPoints') IS NOT ad.basis_points)
            OR (ad.effect_type='amount_off'
              AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.effect.amountCents') IS NOT ad.amount_cents)
            OR json_extract(oi.pricing_snapshot_json,'$.currency') IS NOT ad.currency
            OR json_extract(oi.pricing_snapshot_json,'$.base_unit_price_cents') IS NOT oi.base_unit_price_cents
            OR json_extract(oi.pricing_snapshot_json,'$.unit_price_cents') IS NOT oi.unit_price_cents
            OR json_extract(oi.pricing_snapshot_json,'$.quantity') IS NOT coalesce(oi.current_qty,oi.qty)
            OR json_extract(oi.pricing_snapshot_json,'$.discount_cents')
               IS NOT (oi.base_unit_price_cents-oi.unit_price_cents)*coalesce(oi.current_qty,oi.qty)
            OR NOT EXISTS (
              SELECT 1 FROM json_each(ad.markets_json) market
              WHERE market.value='*' OR market.value=json_extract(oi.pricing_snapshot_json,'$.context.market')
            )
            OR NOT EXISTS (
              SELECT 1 FROM json_each(ad.channels_json) channel
              WHERE channel.value='*' OR channel.value=json_extract(oi.pricing_snapshot_json,'$.context.channel')
            )
            OR (EXISTS (SELECT 1 FROM automatic_discount_products scope WHERE scope.discount_id=ad.id)
              AND NOT EXISTS (SELECT 1 FROM automatic_discount_products scope
                WHERE scope.discount_id=ad.id AND scope.product_id=oi.product_id))
          )
      )
  );
END;

CREATE TRIGGER promotion_code_usage_automatic_conflict_guard
BEFORE INSERT ON promotion_code_usages
WHEN EXISTS (SELECT 1 FROM automatic_discount_applications a WHERE a.order_id=NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'pricing_source_conflict');
END;

CREATE INDEX idx_automatic_discounts_active ON automatic_discounts(state, priority, id);
CREATE INDEX idx_automatic_discount_products_product ON automatic_discount_products(product_id, discount_id);
CREATE INDEX idx_automatic_discount_applications_discount ON automatic_discount_applications(discount_id, discount_version);
