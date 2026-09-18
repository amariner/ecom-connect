-- R4.4: tramos por cantidad/importe y compra X/Y, versionados y trazables.
-- Expand-only: no crea ofertas ni modifica precios existentes.

CREATE TABLE quantity_offers (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 100),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 120),
  public_reason TEXT NOT NULL CHECK (length(trim(public_reason)) BETWEEN 2 AND 160),
  state TEXT NOT NULL CHECK (state IN ('active','disabled','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version)='integer' AND version>=1),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (typeof(priority)='integer' AND priority BETWEEN 0 AND 100000),
  currency TEXT NOT NULL CHECK (length(currency)=3 AND currency=upper(currency)),
  kind TEXT NOT NULL CHECK (kind IN ('quantity_tier','buy_x_get_y')),
  tier_basis TEXT CHECK (tier_basis IN ('quantity','subtotal')),
  buy_quantity INTEGER CHECK (buy_quantity BETWEEN 1 AND 99),
  reward_quantity INTEGER CHECK (reward_quantity BETWEEN 1 AND 99),
  reward_effect_type TEXT CHECK (reward_effect_type IN ('percentage_off','amount_off')),
  reward_basis_points INTEGER CHECK (reward_basis_points BETWEEN 1 AND 10000),
  reward_amount_cents INTEGER CHECK (reward_amount_cents BETWEEN 1 AND 10000000),
  max_applications INTEGER CHECK (max_applications BETWEEN 1 AND 99),
  active_from TEXT,
  active_until TEXT,
  markets_json TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(markets_json) AND json_type(markets_json)='array'),
  channels_json TEXT NOT NULL DEFAULT '["*"]' CHECK (json_valid(channels_json) AND json_type(channels_json)='array'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (active_until IS NULL OR active_from IS NULL OR active_until>active_from),
  CHECK (
    (kind='quantity_tier' AND tier_basis IS NOT NULL
      AND buy_quantity IS NULL AND reward_quantity IS NULL
      AND reward_effect_type IS NULL AND reward_basis_points IS NULL
      AND reward_amount_cents IS NULL AND max_applications IS NULL)
    OR
    (kind='buy_x_get_y' AND tier_basis IS NULL
      AND buy_quantity IS NOT NULL AND reward_quantity IS NOT NULL
      AND ((reward_effect_type='percentage_off' AND reward_basis_points IS NOT NULL AND reward_amount_cents IS NULL)
        OR (reward_effect_type='amount_off' AND reward_amount_cents IS NOT NULL AND reward_basis_points IS NULL)))
  )
);

CREATE TABLE quantity_offer_tiers (
  offer_id TEXT NOT NULL REFERENCES quantity_offers(id) ON DELETE RESTRICT,
  threshold INTEGER NOT NULL CHECK (typeof(threshold)='integer' AND threshold>=1),
  effect_type TEXT NOT NULL CHECK (effect_type IN ('percentage_off','amount_off')),
  basis_points INTEGER CHECK (basis_points BETWEEN 1 AND 10000),
  amount_cents INTEGER CHECK (amount_cents BETWEEN 1 AND 10000000),
  PRIMARY KEY (offer_id, threshold),
  CHECK ((effect_type='percentage_off' AND basis_points IS NOT NULL AND amount_cents IS NULL)
      OR (effect_type='amount_off' AND amount_cents IS NOT NULL AND basis_points IS NULL))
);

CREATE TABLE quantity_offer_products (
  offer_id TEXT NOT NULL REFERENCES quantity_offers(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('eligible','buy','reward')),
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  PRIMARY KEY (offer_id, role, product_id)
);

CREATE TABLE quantity_offer_applications (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 120),
  offer_id TEXT NOT NULL REFERENCES quantity_offers(id) ON DELETE RESTRICT,
  offer_version INTEGER NOT NULL CHECK (offer_version>=1),
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  discount_cents INTEGER NOT NULL CHECK (discount_cents>0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 3 AND 200),
  applied_at TEXT NOT NULL
);

CREATE TRIGGER quantity_offer_tier_insert_guard
BEFORE INSERT ON quantity_offer_tiers
BEGIN
  SELECT RAISE(ABORT, 'quantity_offer_tier_kind_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM quantity_offers offer
    WHERE offer.id=NEW.offer_id AND offer.kind='quantity_tier'
  );
END;

CREATE TRIGGER quantity_offer_product_insert_guard
BEFORE INSERT ON quantity_offer_products
BEGIN
  SELECT RAISE(ABORT, 'quantity_offer_product_role_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM quantity_offers offer
    WHERE offer.id=NEW.offer_id
      AND ((offer.kind='quantity_tier' AND NEW.role='eligible')
        OR (offer.kind='buy_x_get_y' AND NEW.role IN ('buy','reward')))
  );
END;

CREATE TRIGGER quantity_offer_application_insert_guard
BEFORE INSERT ON quantity_offer_applications
BEGIN
  SELECT RAISE(ABORT, 'quantity_offer_application_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM quantity_offers offer JOIN orders o ON o.id=NEW.order_id
    WHERE offer.id=NEW.offer_id
      AND upper(o.currency)=offer.currency
      AND (
        (o.status='pending' AND (
          (offer.state='active' AND offer.version=NEW.offer_version
            AND (offer.active_from IS NULL OR offer.active_from<=NEW.applied_at)
            AND (offer.active_until IS NULL OR offer.active_until>NEW.applied_at))
          OR (NEW.applied_at<offer.updated_at AND NEW.offer_version<=offer.version)
        ))
        OR o.status IN ('paid','shipped','delivered','cancelled')
      )
      AND json_extract(NEW.snapshot_json,'$.schema')=1
      AND json_extract(NEW.snapshot_json,'$.offer_id')=offer.id
      AND json_extract(NEW.snapshot_json,'$.version')=NEW.offer_version
      AND json_extract(NEW.snapshot_json,'$.kind')=offer.kind
      AND json_extract(NEW.snapshot_json,'$.discount_cents')=NEW.discount_cents
      AND NEW.discount_cents=(
        SELECT coalesce(sum(json_extract(oi.pricing_snapshot_json,'$.discount_cents')),0)
        FROM order_items oi WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')='quantity:'||offer.id
      )
      AND NOT EXISTS (SELECT 1 FROM promotion_code_usages u WHERE u.order_id=o.id)
      AND NOT EXISTS (SELECT 1 FROM automatic_discount_applications a WHERE a.order_id=o.id)
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id') LIKE 'quantity:%'
          AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')<>'quantity:'||offer.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id=o.id
          AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')='quantity:'||offer.id
          AND (
            json_extract(oi.pricing_snapshot_json,'$.applied_rule.version') IS NOT NEW.offer_version
            OR json_extract(oi.pricing_snapshot_json,'$.applied_rule.label') IS NOT offer.public_reason
            OR json_extract(oi.pricing_snapshot_json,'$.currency') IS NOT offer.currency
            OR json_extract(oi.pricing_snapshot_json,'$.base_unit_price_cents') IS NOT oi.base_unit_price_cents
            OR json_extract(oi.pricing_snapshot_json,'$.unit_price_cents') IS NOT oi.unit_price_cents
            OR json_extract(oi.pricing_snapshot_json,'$.quantity') IS NOT oi.qty
            OR json_extract(oi.pricing_snapshot_json,'$.discount_cents')
               IS NOT (oi.base_unit_price_cents-oi.unit_price_cents)*oi.qty
            OR NOT EXISTS (
              SELECT 1 FROM json_each(offer.markets_json) market
              WHERE market.value='*' OR market.value=json_extract(oi.pricing_snapshot_json,'$.context.market')
            )
            OR NOT EXISTS (
              SELECT 1 FROM json_each(offer.channels_json) channel
              WHERE channel.value='*' OR channel.value=json_extract(oi.pricing_snapshot_json,'$.context.channel')
            )
          )
      )
      AND (
        (offer.kind='quantity_tier'
          AND json_extract(NEW.snapshot_json,'$.evidence.kind')='quantity_tier'
          AND json_extract(NEW.snapshot_json,'$.evidence.tier_basis')=offer.tier_basis
          AND json_extract(NEW.snapshot_json,'$.evidence.measured_value')=(
            SELECT CASE offer.tier_basis
              WHEN 'quantity' THEN coalesce(sum(oi.qty),0)
              ELSE coalesce(sum(oi.base_unit_price_cents*oi.qty),0)
            END
            FROM order_items oi WHERE oi.order_id=o.id
              AND (NOT EXISTS (SELECT 1 FROM quantity_offer_products scope
                    WHERE scope.offer_id=offer.id AND scope.role='eligible')
                OR EXISTS (SELECT 1 FROM quantity_offer_products scope
                    WHERE scope.offer_id=offer.id AND scope.role='eligible' AND scope.product_id=oi.product_id))
          )
          AND json_extract(NEW.snapshot_json,'$.evidence.threshold')=(
            SELECT max(tier.threshold) FROM quantity_offer_tiers tier
            WHERE tier.offer_id=offer.id AND tier.threshold<=(
              SELECT CASE offer.tier_basis
                WHEN 'quantity' THEN coalesce(sum(oi.qty),0)
                ELSE coalesce(sum(oi.base_unit_price_cents*oi.qty),0)
              END
              FROM order_items oi WHERE oi.order_id=o.id
                AND (NOT EXISTS (SELECT 1 FROM quantity_offer_products scope
                      WHERE scope.offer_id=offer.id AND scope.role='eligible')
                  OR EXISTS (SELECT 1 FROM quantity_offer_products scope
                      WHERE scope.offer_id=offer.id AND scope.role='eligible' AND scope.product_id=oi.product_id))
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM order_items oi WHERE oi.order_id=o.id
              AND (NOT EXISTS (SELECT 1 FROM quantity_offer_products scope
                    WHERE scope.offer_id=offer.id AND scope.role='eligible')
                OR EXISTS (SELECT 1 FROM quantity_offer_products scope
                    WHERE scope.offer_id=offer.id AND scope.role='eligible' AND scope.product_id=oi.product_id))
              AND coalesce(json_extract(oi.pricing_snapshot_json,'$.applied_rule.id'),'')<>'quantity:'||offer.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM order_items oi
            WHERE oi.order_id=o.id
              AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')='quantity:'||offer.id
              AND (
                (EXISTS (SELECT 1 FROM quantity_offer_products scope
                    WHERE scope.offer_id=offer.id AND scope.role='eligible')
                  AND NOT EXISTS (SELECT 1 FROM quantity_offer_products scope
                    WHERE scope.offer_id=offer.id AND scope.role='eligible' AND scope.product_id=oi.product_id))
                OR NOT EXISTS (
                  SELECT 1 FROM quantity_offer_tiers tier
                  WHERE tier.offer_id=offer.id
                    AND tier.threshold=json_extract(NEW.snapshot_json,'$.evidence.threshold')
                    AND tier.effect_type=json_extract(oi.pricing_snapshot_json,'$.applied_rule.effect.type')
                    AND (tier.effect_type<>'percentage_off'
                      OR tier.basis_points=json_extract(oi.pricing_snapshot_json,'$.applied_rule.effect.basisPoints'))
                    AND (tier.effect_type<>'amount_off'
                      OR tier.amount_cents=json_extract(oi.pricing_snapshot_json,'$.applied_rule.effect.amountCents'))
                )
              )
          )
        )
        OR
        (offer.kind='buy_x_get_y'
          AND json_extract(NEW.snapshot_json,'$.evidence.kind')='buy_x_get_y'
          AND typeof(json_extract(NEW.snapshot_json,'$.evidence.applications'))='integer'
          AND json_extract(NEW.snapshot_json,'$.evidence.applications')>=1
          AND (offer.max_applications IS NULL
            OR json_extract(NEW.snapshot_json,'$.evidence.applications')<=offer.max_applications)
          AND json_extract(NEW.snapshot_json,'$.evidence.proportional_basis_points') BETWEEN 1 AND 10000
          AND NOT EXISTS (
            SELECT 1 FROM order_items oi WHERE oi.order_id=o.id
              AND EXISTS (SELECT 1 FROM quantity_offer_products scope
                WHERE scope.offer_id=offer.id AND scope.role IN ('buy','reward') AND scope.product_id=oi.product_id)
              AND coalesce(json_extract(oi.pricing_snapshot_json,'$.applied_rule.id'),'')<>'quantity:'||offer.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM order_items oi
            WHERE oi.order_id=o.id
              AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')='quantity:'||offer.id
              AND (
                NOT EXISTS (SELECT 1 FROM quantity_offer_products scope
                  WHERE scope.offer_id=offer.id AND scope.role IN ('buy','reward') AND scope.product_id=oi.product_id)
                OR json_extract(oi.pricing_snapshot_json,'$.applied_rule.effect.type')<>'percentage_off'
                OR json_extract(oi.pricing_snapshot_json,'$.applied_rule.effect.basisPoints')
                   <>json_extract(NEW.snapshot_json,'$.evidence.proportional_basis_points')
              )
          )
          AND (
            (
              NOT EXISTS (
                SELECT product_id FROM quantity_offer_products
                WHERE offer_id=offer.id AND role='buy'
                EXCEPT SELECT product_id FROM quantity_offer_products
                WHERE offer_id=offer.id AND role='reward'
              )
              AND NOT EXISTS (
                SELECT product_id FROM quantity_offer_products
                WHERE offer_id=offer.id AND role='reward'
                EXCEPT SELECT product_id FROM quantity_offer_products
                WHERE offer_id=offer.id AND role='buy'
              )
              AND (SELECT coalesce(sum(oi.qty),0) FROM order_items oi WHERE oi.order_id=o.id
                AND EXISTS (SELECT 1 FROM quantity_offer_products scope
                  WHERE scope.offer_id=offer.id AND scope.role='buy' AND scope.product_id=oi.product_id))
                >=json_extract(NEW.snapshot_json,'$.evidence.applications')*(offer.buy_quantity+offer.reward_quantity)
            )
            OR
            (
              NOT EXISTS (
                SELECT 1 FROM quantity_offer_products buy
                JOIN quantity_offer_products reward ON reward.offer_id=buy.offer_id
                  AND reward.role='reward' AND reward.product_id=buy.product_id
                WHERE buy.offer_id=offer.id AND buy.role='buy'
              )
              AND (SELECT coalesce(sum(oi.qty),0) FROM order_items oi WHERE oi.order_id=o.id
                AND EXISTS (SELECT 1 FROM quantity_offer_products scope
                  WHERE scope.offer_id=offer.id AND scope.role='buy' AND scope.product_id=oi.product_id))
                >=json_extract(NEW.snapshot_json,'$.evidence.applications')*offer.buy_quantity
              AND (SELECT coalesce(sum(oi.qty),0) FROM order_items oi WHERE oi.order_id=o.id
                AND EXISTS (SELECT 1 FROM quantity_offer_products scope
                  WHERE scope.offer_id=offer.id AND scope.role='reward' AND scope.product_id=oi.product_id))
                >=json_extract(NEW.snapshot_json,'$.evidence.applications')*offer.reward_quantity
            )
          )
          AND (SELECT coalesce(sum(json_extract(reward.value,'$.quantity')),0)
            FROM json_each(NEW.snapshot_json,'$.evidence.selected_reward_units') reward)
            =json_extract(NEW.snapshot_json,'$.evidence.applications')*offer.reward_quantity
          AND NOT EXISTS (
            SELECT 1 FROM json_each(NEW.snapshot_json,'$.evidence.selected_reward_units') reward
            WHERE typeof(json_extract(reward.value,'$.product_id'))<>'integer'
              OR typeof(json_extract(reward.value,'$.quantity'))<>'integer'
              OR json_extract(reward.value,'$.quantity')<1
              OR NOT EXISTS (SELECT 1 FROM quantity_offer_products scope
                WHERE scope.offer_id=offer.id AND scope.role='reward'
                  AND scope.product_id=json_extract(reward.value,'$.product_id'))
              OR json_extract(reward.value,'$.quantity')>(SELECT coalesce(sum(oi.qty),0)
                FROM order_items oi WHERE oi.order_id=o.id
                  AND oi.product_id=json_extract(reward.value,'$.product_id'))
          )
          AND json_extract(NEW.snapshot_json,'$.evidence.theoretical_discount_cents')=(
            SELECT coalesce(sum(json_extract(reward.value,'$.quantity')*
              CASE offer.reward_effect_type
                WHEN 'percentage_off' THEN min(oi.base_unit_price_cents,
                  cast(oi.base_unit_price_cents*offer.reward_basis_points/10000 AS integer))
                ELSE min(oi.base_unit_price_cents,offer.reward_amount_cents)
              END),0)
            FROM json_each(NEW.snapshot_json,'$.evidence.selected_reward_units') reward
            JOIN order_items oi ON oi.order_id=o.id
              AND oi.product_id=json_extract(reward.value,'$.product_id')
          )
          AND json_extract(NEW.snapshot_json,'$.evidence.theoretical_discount_cents')<=(
            SELECT sum(cast(oi.base_unit_price_cents*
              json_extract(NEW.snapshot_json,'$.evidence.proportional_basis_points')/10000 AS integer)*oi.qty)
            FROM order_items oi WHERE oi.order_id=o.id
              AND EXISTS (SELECT 1 FROM quantity_offer_products scope
                WHERE scope.offer_id=offer.id AND scope.role IN ('buy','reward') AND scope.product_id=oi.product_id)
          )
          AND (json_extract(NEW.snapshot_json,'$.evidence.proportional_basis_points')=1
            OR json_extract(NEW.snapshot_json,'$.evidence.theoretical_discount_cents')>(
              SELECT sum(cast(oi.base_unit_price_cents*
                (json_extract(NEW.snapshot_json,'$.evidence.proportional_basis_points')-1)/10000 AS integer)*oi.qty)
              FROM order_items oi WHERE oi.order_id=o.id
                AND EXISTS (SELECT 1 FROM quantity_offer_products scope
                  WHERE scope.offer_id=offer.id AND scope.role IN ('buy','reward') AND scope.product_id=oi.product_id)
            ))
        )
      )
  );
END;

CREATE TRIGGER promotion_code_usage_quantity_offer_conflict_guard
BEFORE INSERT ON promotion_code_usages
WHEN EXISTS (SELECT 1 FROM quantity_offer_applications a WHERE a.order_id=NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'pricing_source_conflict');
END;

CREATE TRIGGER automatic_discount_application_quantity_offer_conflict_guard
BEFORE INSERT ON automatic_discount_applications
WHEN EXISTS (SELECT 1 FROM quantity_offer_applications a WHERE a.order_id=NEW.order_id)
BEGIN
  SELECT RAISE(ABORT, 'pricing_source_conflict');
END;

CREATE INDEX idx_quantity_offers_active ON quantity_offers(state, priority, id);
CREATE INDEX idx_quantity_offer_products_product ON quantity_offer_products(product_id, role, offer_id);
CREATE INDEX idx_quantity_offer_applications_offer ON quantity_offer_applications(offer_id, offer_version);
