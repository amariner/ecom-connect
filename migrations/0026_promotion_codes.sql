-- R4.2: códigos promocionales sin texto claro, scopes de producto y usos
-- reservados/consumidos. Expand-only; sin códigos seed ni activación implícita.

CREATE TABLE promotion_codes (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 100),
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash)=64 AND code_hash=lower(code_hash)),
  code_hint TEXT NOT NULL CHECK (length(code_hint) BETWEEN 6 AND 12),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 120),
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
  global_usage_limit INTEGER CHECK (global_usage_limit IS NULL OR global_usage_limit>0),
  per_customer_usage_limit INTEGER CHECK (per_customer_usage_limit IS NULL OR per_customer_usage_limit>0),
  minimum_subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (minimum_subtotal_cents>=0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((effect_type='percentage_off' AND basis_points IS NOT NULL AND amount_cents IS NULL)
      OR (effect_type='amount_off' AND amount_cents IS NOT NULL AND basis_points IS NULL)),
  CHECK (active_until IS NULL OR active_from IS NULL OR active_until>active_from)
);

CREATE TABLE promotion_code_products (
  promotion_id TEXT NOT NULL REFERENCES promotion_codes(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  PRIMARY KEY (promotion_id, product_id)
);

CREATE TABLE promotion_code_usages (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 120),
  promotion_id TEXT NOT NULL REFERENCES promotion_codes(id) ON DELETE RESTRICT,
  promotion_version INTEGER NOT NULL CHECK (promotion_version>=1),
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  customer_key_hash TEXT NOT NULL CHECK (length(customer_key_hash)=64 AND customer_key_hash=lower(customer_key_hash)),
  status TEXT NOT NULL CHECK (status IN ('reserved','consumed','released')),
  discount_cents INTEGER NOT NULL CHECK (discount_cents>0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 3 AND 200),
  reserved_at TEXT NOT NULL,
  consumed_at TEXT,
  released_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((status='reserved' AND consumed_at IS NULL AND released_at IS NULL)
      OR (status='consumed' AND consumed_at IS NOT NULL AND released_at IS NULL)
      OR (status='released' AND consumed_at IS NULL AND released_at IS NOT NULL))
);

CREATE TRIGGER promotion_code_usage_insert_guard
BEFORE INSERT ON promotion_code_usages
BEGIN
  SELECT RAISE(ABORT, 'promotion_code_usage_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM promotion_codes pc JOIN orders o ON o.id=NEW.order_id
    WHERE pc.id=NEW.promotion_id AND upper(o.currency)=pc.currency
      AND (
        (NEW.status='reserved' AND o.status='pending'
          AND pc.version=NEW.promotion_version AND pc.state='active'
          AND (pc.active_from IS NULL OR pc.active_from<=NEW.reserved_at)
          AND (pc.active_until IS NULL OR pc.active_until>NEW.reserved_at)
          AND (pc.global_usage_limit IS NULL OR pc.global_usage_limit>(
            SELECT count(*) FROM promotion_code_usages u
            WHERE u.promotion_id=pc.id AND u.status IN ('reserved','consumed')
          ))
          AND (pc.per_customer_usage_limit IS NULL OR pc.per_customer_usage_limit>(
            SELECT count(*) FROM promotion_code_usages u
            WHERE u.promotion_id=pc.id AND u.customer_key_hash=NEW.customer_key_hash
              AND u.status IN ('reserved','consumed')
          )))
        OR (NEW.status='consumed' AND o.status IN ('paid','shipped','delivered','cancelled'))
        OR (NEW.status='released' AND o.status='cancelled')
      )
      AND NEW.discount_cents=(
        SELECT coalesce(sum(json_extract(oi.pricing_snapshot_json,'$.discount_cents')),0)
        FROM order_items oi WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')='promotion:'||pc.id
      )
      AND NEW.discount_cents>0
      AND pc.minimum_subtotal_cents<=(
        SELECT coalesce(sum(oi.base_unit_price_cents*coalesce(oi.current_qty,oi.qty)),0)
        FROM order_items oi WHERE oi.order_id=o.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')='promotion:'||pc.id
          AND (
            json_extract(oi.pricing_snapshot_json,'$.applied_rule.version') IS NOT NEW.promotion_version
            OR json_extract(oi.pricing_snapshot_json,'$.currency') IS NOT pc.currency
            OR json_extract(oi.pricing_snapshot_json,'$.base_unit_price_cents') IS NOT oi.base_unit_price_cents
            OR json_extract(oi.pricing_snapshot_json,'$.unit_price_cents') IS NOT oi.unit_price_cents
            OR json_extract(oi.pricing_snapshot_json,'$.quantity') IS NOT coalesce(oi.current_qty,oi.qty)
            OR json_extract(oi.pricing_snapshot_json,'$.discount_cents')
               IS NOT (oi.base_unit_price_cents-oi.unit_price_cents)*coalesce(oi.current_qty,oi.qty)
            OR NOT EXISTS (
              SELECT 1 FROM json_each(pc.markets_json) market
              WHERE market.value='*' OR market.value=json_extract(oi.pricing_snapshot_json,'$.context.market')
            )
            OR NOT EXISTS (
              SELECT 1 FROM json_each(pc.channels_json) channel
              WHERE channel.value='*' OR channel.value=json_extract(oi.pricing_snapshot_json,'$.context.channel')
            )
            OR (EXISTS (SELECT 1 FROM promotion_code_products scope WHERE scope.promotion_id=pc.id)
              AND NOT EXISTS (SELECT 1 FROM promotion_code_products scope
                WHERE scope.promotion_id=pc.id AND scope.product_id=oi.product_id))
          )
      )
  );
END;

CREATE INDEX idx_promotion_codes_lookup ON promotion_codes(code_hash, state);
CREATE INDEX idx_promotion_code_products_product ON promotion_code_products(product_id, promotion_id);
CREATE INDEX idx_promotion_code_usages_limit ON promotion_code_usages(promotion_id, status, customer_key_hash);
