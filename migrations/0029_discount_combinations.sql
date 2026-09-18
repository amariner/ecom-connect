-- R4.5: combinabilidad explícita. Sin política activa se conserva la
-- exclusividad histórica. No crea políticas ni modifica pedidos existentes.

CREATE TABLE discount_combination_policies (
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
  maximum_discount_basis_points INTEGER NOT NULL
    CHECK (typeof(maximum_discount_basis_points)='integer' AND maximum_discount_basis_points BETWEEN 1 AND 10000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (active_until IS NULL OR active_from IS NULL OR active_until>active_from)
);

CREATE TABLE discount_combination_source_pairs (
  policy_id TEXT NOT NULL REFERENCES discount_combination_policies(id) ON DELETE RESTRICT,
  left_source TEXT NOT NULL CHECK (left_source IN ('promotion_code','automatic_discount','quantity_offer')),
  right_source TEXT NOT NULL CHECK (right_source IN ('promotion_code','automatic_discount','quantity_offer')),
  PRIMARY KEY (policy_id, left_source, right_source),
  CHECK (left_source<right_source)
);

CREATE TABLE discount_combination_class_pairs (
  policy_id TEXT NOT NULL REFERENCES discount_combination_policies(id) ON DELETE RESTRICT,
  left_class TEXT NOT NULL CHECK (left_class IN ('product','order','shipping')),
  right_class TEXT NOT NULL CHECK (right_class IN ('product','order','shipping')),
  PRIMARY KEY (policy_id, left_class, right_class),
  CHECK (left_class<=right_class)
);

CREATE TABLE discount_combination_applications (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 120),
  policy_id TEXT NOT NULL REFERENCES discount_combination_policies(id) ON DELETE RESTRICT,
  policy_version INTEGER NOT NULL CHECK (policy_version>=1),
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  discount_cents INTEGER NOT NULL CHECK (discount_cents>0),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 3 AND 200),
  applied_at TEXT NOT NULL
);

CREATE TRIGGER discount_combination_application_insert_guard
BEFORE INSERT ON discount_combination_applications
BEGIN
  SELECT RAISE(ABORT, 'discount_combination_application_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM discount_combination_policies policy JOIN orders o ON o.id=NEW.order_id
    WHERE policy.id=NEW.policy_id AND upper(o.currency)=policy.currency
      AND (
        (o.status='pending' AND (
          (policy.version=NEW.policy_version AND policy.state='active'
            AND (policy.active_from IS NULL OR policy.active_from<=NEW.applied_at)
            AND (policy.active_until IS NULL OR policy.active_until>NEW.applied_at))
          OR (NEW.applied_at<policy.updated_at AND NEW.policy_version<=policy.version)
        ))
        OR (o.status IN ('paid','shipped','delivered','cancelled')
          AND NEW.policy_version<=policy.version)
      )
      AND json_extract(NEW.snapshot_json,'$.schema')=1
      AND json_extract(NEW.snapshot_json,'$.policy_id')=policy.id
      AND json_extract(NEW.snapshot_json,'$.version')=NEW.policy_version
      AND json_extract(NEW.snapshot_json,'$.maximum_discount_basis_points')=policy.maximum_discount_basis_points
      AND json_extract(NEW.snapshot_json,'$.discount_cents')=NEW.discount_cents
      AND json_type(NEW.snapshot_json,'$.selected_sources')='array'
      AND json_array_length(json_extract(NEW.snapshot_json,'$.selected_sources')) BETWEEN 2 AND 3
      AND (SELECT count(DISTINCT json_extract(source.value,'$.source'))
        FROM json_each(NEW.snapshot_json,'$.selected_sources') source)
        =json_array_length(json_extract(NEW.snapshot_json,'$.selected_sources'))
      AND NEW.discount_cents=(SELECT coalesce(sum(json_extract(source.value,'$.discount_cents')),0)
        FROM json_each(NEW.snapshot_json,'$.selected_sources') source)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.snapshot_json,'$.selected_sources') source
        WHERE json_extract(source.value,'$.source') NOT IN ('promotion_code','automatic_discount','quantity_offer')
          OR json_extract(source.value,'$.discount_class') NOT IN ('product','order','shipping')
          OR typeof(json_extract(source.value,'$.rule_version'))<>'integer'
          OR json_extract(source.value,'$.rule_version')<1
          OR typeof(json_extract(source.value,'$.discount_cents'))<>'integer'
          OR json_extract(source.value,'$.discount_cents')<0
          OR CASE json_extract(source.value,'$.source')
            WHEN 'promotion_code' THEN json_extract(source.value,'$.rule_id') NOT LIKE 'promotion:%'
              OR NOT EXISTS (SELECT 1 FROM promotion_codes item
                WHERE item.id=substr(json_extract(source.value,'$.rule_id'),11)
                  AND item.version=json_extract(source.value,'$.rule_version')
                  AND item.state='active' AND item.currency=policy.currency)
            WHEN 'automatic_discount' THEN json_extract(source.value,'$.rule_id') NOT LIKE 'automatic:%'
              OR NOT EXISTS (SELECT 1 FROM automatic_discounts item
                WHERE item.id=substr(json_extract(source.value,'$.rule_id'),11)
                  AND item.version=json_extract(source.value,'$.rule_version')
                  AND item.state='active' AND item.currency=policy.currency)
            WHEN 'quantity_offer' THEN json_extract(source.value,'$.rule_id') NOT LIKE 'quantity:%'
              OR NOT EXISTS (SELECT 1 FROM quantity_offers item
                WHERE item.id=substr(json_extract(source.value,'$.rule_id'),10)
                  AND item.version=json_extract(source.value,'$.rule_version')
                  AND item.state='active' AND item.currency=policy.currency)
            ELSE 1 END
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.snapshot_json,'$.selected_sources') left_source
        JOIN json_each(NEW.snapshot_json,'$.selected_sources') right_source
          ON cast(left_source.key AS integer)<cast(right_source.key AS integer)
        WHERE NOT EXISTS (
          SELECT 1 FROM discount_combination_source_pairs pair
          WHERE pair.policy_id=policy.id
            AND pair.left_source=min(json_extract(left_source.value,'$.source'),json_extract(right_source.value,'$.source'))
            AND pair.right_source=max(json_extract(left_source.value,'$.source'),json_extract(right_source.value,'$.source'))
        ) OR NOT EXISTS (
          SELECT 1 FROM discount_combination_class_pairs pair
          WHERE pair.policy_id=policy.id
            AND pair.left_class=min(json_extract(left_source.value,'$.discount_class'),json_extract(right_source.value,'$.discount_class'))
            AND pair.right_class=max(json_extract(left_source.value,'$.discount_class'),json_extract(right_source.value,'$.discount_class'))
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM order_items oi WHERE oi.order_id=o.id AND (
          json_extract(oi.pricing_snapshot_json,'$.schema')<>2
          OR json_extract(oi.pricing_snapshot_json,'$.currency')<>policy.currency
          OR json_extract(oi.pricing_snapshot_json,'$.base_unit_price_cents')<>oi.base_unit_price_cents
          OR json_extract(oi.pricing_snapshot_json,'$.unit_price_cents')<>oi.unit_price_cents
          OR json_extract(oi.pricing_snapshot_json,'$.quantity')<>coalesce(oi.current_qty,oi.qty)
          OR json_extract(oi.pricing_snapshot_json,'$.discount_cents')
             <>(oi.base_unit_price_cents-oi.unit_price_cents)*coalesce(oi.current_qty,oi.qty)
          OR json_extract(oi.pricing_snapshot_json,'$.discount_cents')>
             cast(oi.base_unit_price_cents*policy.maximum_discount_basis_points/10000 AS integer)
               *coalesce(oi.current_qty,oi.qty)
          OR NOT EXISTS (SELECT 1 FROM json_each(policy.markets_json) market
            WHERE market.value='*' OR market.value=json_extract(oi.pricing_snapshot_json,'$.context.market'))
          OR NOT EXISTS (SELECT 1 FROM json_each(policy.channels_json) channel
            WHERE channel.value='*' OR channel.value=json_extract(oi.pricing_snapshot_json,'$.context.channel'))
          OR json_extract(oi.pricing_snapshot_json,'$.discount_cents')<>
             coalesce((SELECT sum(json_extract(rule.value,'$.discount_per_unit_cents'))
               FROM json_each(oi.pricing_snapshot_json,'$.applied_rules') rule),0)*coalesce(oi.current_qty,oi.qty)
          OR EXISTS (SELECT 1 FROM json_each(oi.pricing_snapshot_json,'$.applied_rules') rule
            WHERE typeof(json_extract(rule.value,'$.discount_per_unit_cents'))<>'integer'
              OR json_extract(rule.value,'$.discount_per_unit_cents')<0
              OR json_extract(rule.value,'$.raw_discount_per_unit_cents')<json_extract(rule.value,'$.discount_per_unit_cents')
              OR NOT EXISTS (SELECT 1 FROM json_each(NEW.snapshot_json,'$.selected_sources') source
                WHERE json_extract(source.value,'$.rule_id')=json_extract(rule.value,'$.id')
                  AND json_extract(source.value,'$.rule_version')=json_extract(rule.value,'$.version')))
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(NEW.snapshot_json,'$.selected_sources') source
        WHERE json_extract(source.value,'$.discount_cents')<>(
          SELECT coalesce(sum(json_extract(rule.value,'$.discount_per_unit_cents')*coalesce(oi.current_qty,oi.qty)),0)
          FROM order_items oi JOIN json_each(oi.pricing_snapshot_json,'$.applied_rules') rule
          WHERE oi.order_id=o.id AND json_extract(rule.value,'$.id')=json_extract(source.value,'$.rule_id')
        ) OR NOT EXISTS (
          SELECT 1 FROM order_items oi JOIN json_each(oi.pricing_snapshot_json,'$.applied_rules') rule
          WHERE oi.order_id=o.id AND json_extract(rule.value,'$.id')=json_extract(source.value,'$.rule_id')
        )
      )
      AND NEW.discount_cents=(SELECT coalesce(sum(json_extract(oi.pricing_snapshot_json,'$.discount_cents')),0)
        FROM order_items oi WHERE oi.order_id=o.id)
  );
END;

-- El uso de código conserva límites concurrentes y valida su parte del descuento,
-- no el total de la línea, cuando existe un snapshot combinado schema 2.
DROP TRIGGER promotion_code_usage_insert_guard;
CREATE TRIGGER promotion_code_usage_insert_guard
BEFORE INSERT ON promotion_code_usages
BEGIN
  SELECT RAISE(ABORT, 'pricing_source_conflict')
  WHERE (EXISTS (SELECT 1 FROM automatic_discount_applications application
          WHERE application.order_id=NEW.order_id)
      OR EXISTS (SELECT 1 FROM quantity_offer_applications application
          WHERE application.order_id=NEW.order_id))
    AND NOT EXISTS (SELECT 1 FROM discount_combination_applications application
      WHERE application.order_id=NEW.order_id);
  SELECT RAISE(ABORT, 'promotion_code_usage_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM promotion_codes pc JOIN orders o ON o.id=NEW.order_id
    WHERE pc.id=NEW.promotion_id AND upper(o.currency)=pc.currency
      AND (
        (NEW.status='reserved' AND o.status='pending'
          AND pc.version=NEW.promotion_version AND pc.state='active'
          AND (pc.active_from IS NULL OR pc.active_from<=NEW.reserved_at)
          AND (pc.active_until IS NULL OR pc.active_until>NEW.reserved_at)
          AND (pc.global_usage_limit IS NULL OR pc.global_usage_limit>(SELECT count(*)
            FROM promotion_code_usages u WHERE u.promotion_id=pc.id AND u.status IN ('reserved','consumed')))
          AND (pc.per_customer_usage_limit IS NULL OR pc.per_customer_usage_limit>(SELECT count(*)
            FROM promotion_code_usages u WHERE u.promotion_id=pc.id AND u.customer_key_hash=NEW.customer_key_hash
              AND u.status IN ('reserved','consumed'))))
        OR (NEW.status='consumed' AND o.status IN ('paid','shipped','delivered','cancelled'))
        OR (NEW.status='released' AND o.status='cancelled')
      )
      AND NEW.discount_cents=(SELECT coalesce(sum(CASE
        WHEN json_extract(oi.pricing_snapshot_json,'$.schema')=2 THEN coalesce((
          SELECT sum(json_extract(rule.value,'$.discount_per_unit_cents'))
          FROM json_each(oi.pricing_snapshot_json,'$.applied_rules') rule
          WHERE json_extract(rule.value,'$.id')='promotion:'||pc.id
        ),0)*coalesce(oi.current_qty,oi.qty)
        WHEN json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')='promotion:'||pc.id
          THEN json_extract(oi.pricing_snapshot_json,'$.discount_cents') ELSE 0 END),0)
        FROM order_items oi WHERE oi.order_id=o.id)
      AND NEW.discount_cents>0
      AND pc.minimum_subtotal_cents<=(SELECT coalesce(sum(oi.base_unit_price_cents*coalesce(oi.current_qty,oi.qty)),0)
        FROM order_items oi WHERE oi.order_id=o.id)
      AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id
        AND json_extract(oi.pricing_snapshot_json,'$.schema')=2
        AND EXISTS (SELECT 1 FROM json_each(oi.pricing_snapshot_json,'$.applied_rules') rule
          WHERE json_extract(rule.value,'$.id')='promotion:'||pc.id)
        AND NOT EXISTS (SELECT 1 FROM discount_combination_applications combination
          JOIN json_each(combination.snapshot_json,'$.selected_sources') source
          WHERE combination.order_id=o.id AND json_extract(source.value,'$.source')='promotion_code'
            AND json_extract(source.value,'$.rule_id')='promotion:'||pc.id))
      AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id
        AND (json_extract(oi.pricing_snapshot_json,'$.applied_rule.id')='promotion:'||pc.id
          OR EXISTS (SELECT 1 FROM json_each(oi.pricing_snapshot_json,'$.applied_rules') rule
            WHERE json_extract(rule.value,'$.id')='promotion:'||pc.id))
        AND (
          json_extract(oi.pricing_snapshot_json,'$.currency') IS NOT pc.currency
          OR json_extract(oi.pricing_snapshot_json,'$.base_unit_price_cents') IS NOT oi.base_unit_price_cents
          OR json_extract(oi.pricing_snapshot_json,'$.unit_price_cents') IS NOT oi.unit_price_cents
          OR json_extract(oi.pricing_snapshot_json,'$.quantity') IS NOT coalesce(oi.current_qty,oi.qty)
          OR json_extract(oi.pricing_snapshot_json,'$.discount_cents')
             IS NOT (oi.base_unit_price_cents-oi.unit_price_cents)*coalesce(oi.current_qty,oi.qty)
          OR (json_extract(oi.pricing_snapshot_json,'$.schema')=1
            AND json_extract(oi.pricing_snapshot_json,'$.applied_rule.version') IS NOT NEW.promotion_version)
          OR (json_extract(oi.pricing_snapshot_json,'$.schema')=2 AND NOT EXISTS (
            SELECT 1 FROM json_each(oi.pricing_snapshot_json,'$.applied_rules') rule
            WHERE json_extract(rule.value,'$.id')='promotion:'||pc.id
              AND json_extract(rule.value,'$.version')=NEW.promotion_version
              AND json_extract(rule.value,'$.discount_per_unit_cents')>0))
          OR NOT EXISTS (SELECT 1 FROM json_each(pc.markets_json) market
            WHERE market.value='*' OR market.value=json_extract(oi.pricing_snapshot_json,'$.context.market'))
          OR NOT EXISTS (SELECT 1 FROM json_each(pc.channels_json) channel
            WHERE channel.value='*' OR channel.value=json_extract(oi.pricing_snapshot_json,'$.context.channel'))
          OR (EXISTS (SELECT 1 FROM promotion_code_products scope WHERE scope.promotion_id=pc.id)
            AND NOT EXISTS (SELECT 1 FROM promotion_code_products scope
              WHERE scope.promotion_id=pc.id AND scope.product_id=oi.product_id))
        ))
  );
END;

CREATE INDEX idx_discount_combination_policies_active
  ON discount_combination_policies(state, priority, id);
CREATE INDEX idx_discount_combination_applications_policy
  ON discount_combination_applications(policy_id, policy_version);
