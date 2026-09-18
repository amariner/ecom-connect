-- R4.1 conserva en cada línea el precio base y el desglose que produjo el
-- precio cobrado. Expand-only y compatible con Writers anteriores.

ALTER TABLE order_items ADD COLUMN base_unit_price_cents INTEGER NOT NULL DEFAULT 0
  CHECK (base_unit_price_cents >= 0 AND base_unit_price_cents <= 10000000);
ALTER TABLE order_items ADD COLUMN pricing_snapshot_json TEXT NOT NULL
  DEFAULT '{"schema":1,"source":"legacy-default"}'
  CHECK (json_valid(pricing_snapshot_json) AND json_type(pricing_snapshot_json)='object');

UPDATE order_items
SET base_unit_price_cents = unit_price_cents,
    pricing_snapshot_json = json_object(
      'schema', 1,
      'currency', upper((SELECT currency FROM orders WHERE orders.id=order_items.order_id)),
      'base_unit_price_cents', unit_price_cents,
      'unit_price_cents', unit_price_cents,
      'quantity', COALESCE(current_qty, qty),
      'base_subtotal_cents', unit_price_cents * COALESCE(current_qty, qty),
      'discount_cents', 0,
      'subtotal_cents', unit_price_cents * COALESCE(current_qty, qty),
      'applied_rule', NULL,
      'evaluations', json('[]'),
      'source', 'r4.1-backfill'
    );

CREATE TRIGGER order_item_pricing_snapshot_legacy_insert
AFTER INSERT ON order_items
WHEN NEW.pricing_snapshot_json='{"schema":1,"source":"legacy-default"}'
BEGIN
  UPDATE order_items
  SET base_unit_price_cents=NEW.unit_price_cents,
      pricing_snapshot_json=json_object(
        'schema', 1,
        'currency', upper((SELECT currency FROM orders WHERE id=NEW.order_id)),
        'base_unit_price_cents', NEW.unit_price_cents,
        'unit_price_cents', NEW.unit_price_cents,
        'quantity', COALESCE(NEW.current_qty, NEW.qty),
        'base_subtotal_cents', NEW.unit_price_cents * COALESCE(NEW.current_qty, NEW.qty),
        'discount_cents', 0,
        'subtotal_cents', NEW.unit_price_cents * COALESCE(NEW.current_qty, NEW.qty),
        'applied_rule', NULL,
        'evaluations', json('[]'),
        'source', 'legacy-writer'
      )
  WHERE id=NEW.id;
END;

CREATE INDEX idx_order_items_pricing_rule
  ON order_items(json_extract(pricing_snapshot_json, '$.applied_rule.id'))
  WHERE json_extract(pricing_snapshot_json, '$.applied_rule.id') IS NOT NULL;
