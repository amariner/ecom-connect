-- R4.7: bundles fijos/configurables con composición congelada e inventario por componente.
-- Expand-only: no crea bundles ni modifica productos/pedidos existentes.

CREATE TABLE bundles (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 100),
  product_id INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE RESTRICT,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 120),
  kind TEXT NOT NULL CHECK (kind IN ('fixed','configurable')),
  state TEXT NOT NULL CHECK (state IN ('active','disabled','archived')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(version)='integer' AND version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE bundle_groups (
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE RESTRICT,
  id TEXT NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 100),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 120),
  minimum_selections INTEGER NOT NULL CHECK (minimum_selections BETWEEN 0 AND 20),
  maximum_selections INTEGER NOT NULL CHECK (maximum_selections BETWEEN 1 AND 20),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 100000),
  PRIMARY KEY (bundle_id, id),
  CHECK (minimum_selections<=maximum_selections)
);

CREATE TABLE bundle_components (
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE RESTRICT,
  group_id TEXT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 100000),
  PRIMARY KEY (bundle_id, product_id),
  FOREIGN KEY (bundle_id, group_id) REFERENCES bundle_groups(bundle_id, id) ON DELETE RESTRICT
);

CREATE TABLE order_bundle_components (
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE RESTRICT,
  bundle_version INTEGER NOT NULL CHECK (bundle_version>=1),
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity_per_bundle INTEGER NOT NULL CHECK (quantity_per_bundle BETWEEN 1 AND 99),
  name_snapshot TEXT NOT NULL CHECK (length(trim(name_snapshot))>=1),
  sku_snapshot TEXT NOT NULL CHECK (length(trim(sku_snapshot))>=1),
  PRIMARY KEY (order_item_id, variant_id)
);

CREATE TABLE bundle_applications (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 3 AND 120),
  bundle_id TEXT NOT NULL REFERENCES bundles(id) ON DELETE RESTRICT,
  bundle_version INTEGER NOT NULL CHECK (bundle_version>=1),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  order_item_id INTEGER NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE RESTRICT,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 10000000),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json)='object'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 3 AND 200),
  applied_at TEXT NOT NULL,
  UNIQUE (bundle_id, order_item_id)
);

CREATE TABLE bundle_return_inventory_movements (
  return_id TEXT NOT NULL REFERENCES return_requests(id) ON DELETE RESTRICT,
  return_line_id TEXT NOT NULL REFERENCES return_request_lines(id) ON DELETE RESTRICT,
  component_variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  location_movement_id INTEGER NOT NULL REFERENCES inventory_location_movements(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity>0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (return_id, return_line_id, component_variant_id)
);

CREATE TRIGGER bundle_group_insert_guard
BEFORE INSERT ON bundle_groups
BEGIN
  SELECT RAISE(ABORT, 'bundle_group_kind_conflict') WHERE NOT EXISTS (
    SELECT 1 FROM bundles bundle WHERE bundle.id=NEW.bundle_id AND bundle.kind='configurable'
  );
END;

CREATE TRIGGER bundle_component_insert_guard
BEFORE INSERT ON bundle_components
BEGIN
  SELECT RAISE(ABORT, 'bundle_component_conflict') WHERE NOT EXISTS (
    SELECT 1 FROM bundles bundle WHERE bundle.id=NEW.bundle_id
      AND bundle.product_id<>NEW.product_id
      AND ((bundle.kind='fixed' AND NEW.group_id IS NULL AND NEW.is_default=1)
        OR (bundle.kind='configurable' AND NEW.group_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM bundle_groups group_item
            WHERE group_item.bundle_id=bundle.id AND group_item.id=NEW.group_id)))
  );
END;

CREATE TRIGGER bundle_state_activation_guard
BEFORE UPDATE OF state ON bundles WHEN NEW.state='active'
BEGIN
  SELECT RAISE(ABORT, 'bundle_activation_conflict') WHERE
    (NEW.kind='fixed' AND NOT EXISTS (SELECT 1 FROM bundle_components component
      WHERE component.bundle_id=NEW.id AND component.group_id IS NULL))
    OR (NEW.kind='configurable' AND (
      NOT EXISTS (SELECT 1 FROM bundle_groups group_item WHERE group_item.bundle_id=NEW.id)
      OR EXISTS (SELECT 1 FROM bundle_groups group_item WHERE group_item.bundle_id=NEW.id AND (
        group_item.maximum_selections>(SELECT count(*) FROM bundle_components component
          WHERE component.bundle_id=NEW.id AND component.group_id=group_item.id)
        OR group_item.minimum_selections>(SELECT count(*) FROM bundle_components component
          WHERE component.bundle_id=NEW.id AND component.group_id=group_item.id AND component.is_default=1)
        OR group_item.maximum_selections<(SELECT count(*) FROM bundle_components component
          WHERE component.bundle_id=NEW.id AND component.group_id=group_item.id AND component.is_default=1)
      ))
    ));
END;

CREATE TRIGGER order_bundle_component_insert_guard
BEFORE INSERT ON order_bundle_components
BEGIN
  SELECT RAISE(ABORT, 'order_bundle_component_conflict') WHERE NOT EXISTS (
    SELECT 1 FROM order_items oi JOIN bundles bundle ON bundle.id=NEW.bundle_id
    JOIN product_variants variant ON variant.id=NEW.variant_id
    JOIN bundle_components component ON component.bundle_id=bundle.id
      AND component.product_id=NEW.product_id
    WHERE oi.id=NEW.order_item_id AND oi.product_id=bundle.product_id
      AND NEW.bundle_version<=bundle.version
      AND variant.product_id=NEW.product_id AND variant.is_default=1
      AND component.quantity=NEW.quantity_per_bundle
      AND json_extract(oi.pricing_snapshot_json,'$.bundle.bundle_id')=bundle.id
      AND json_extract(oi.pricing_snapshot_json,'$.bundle.version')=NEW.bundle_version
      AND EXISTS (SELECT 1 FROM json_each(oi.pricing_snapshot_json,'$.bundle.components') selected
        WHERE json_extract(selected.value,'$.product_id')=NEW.product_id
          AND json_extract(selected.value,'$.quantity_per_bundle')=NEW.quantity_per_bundle)
      AND (bundle.kind='fixed' OR EXISTS (
        SELECT 1 FROM json_each(oi.pricing_snapshot_json,'$.bundle.selections') selected
        WHERE json_extract(selected.value,'$.group_id')=component.group_id
          AND json_extract(selected.value,'$.product_id')=component.product_id))
  );
END;

CREATE TRIGGER bundle_application_insert_guard
BEFORE INSERT ON bundle_applications
BEGIN
  SELECT RAISE(ABORT, 'bundle_application_conflict') WHERE NOT EXISTS (
    SELECT 1 FROM bundles bundle JOIN orders o ON o.id=NEW.order_id
    JOIN order_items oi ON oi.id=NEW.order_item_id AND oi.order_id=o.id
    WHERE bundle.id=NEW.bundle_id AND oi.product_id=bundle.product_id
      AND NEW.bundle_version<=bundle.version
      AND ((o.status='pending' AND (
          (bundle.state='active' AND bundle.version=NEW.bundle_version)
          OR (NEW.applied_at<bundle.updated_at AND NEW.bundle_version<=bundle.version)))
        OR o.status IN ('paid','shipped','delivered','cancelled'))
      AND NEW.unit_price_cents=oi.unit_price_cents
      AND NEW.quantity=coalesce(oi.current_qty,oi.qty)
      AND json_extract(NEW.snapshot_json,'$.schema')=1
      AND json_extract(NEW.snapshot_json,'$.bundle_id')=bundle.id
      AND json_extract(NEW.snapshot_json,'$.version')=NEW.bundle_version
      AND json_extract(NEW.snapshot_json,'$.kind')=bundle.kind
      AND json_extract(oi.pricing_snapshot_json,'$.bundle.bundle_id')=bundle.id
      AND json_extract(oi.pricing_snapshot_json,'$.bundle.version')=NEW.bundle_version
      AND json_extract(oi.pricing_snapshot_json,'$.bundle')=json_extract(NEW.snapshot_json,'$')
      AND json_array_length(json_extract(NEW.snapshot_json,'$.components'))=
        (SELECT count(*) FROM order_bundle_components ordered WHERE ordered.order_item_id=oi.id)
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.snapshot_json,'$.components') selected
        WHERE NOT EXISTS (SELECT 1 FROM order_bundle_components ordered
          WHERE ordered.order_item_id=oi.id
            AND ordered.product_id=json_extract(selected.value,'$.product_id')
            AND ordered.quantity_per_bundle=json_extract(selected.value,'$.quantity_per_bundle')))
      AND (bundle.kind<>'fixed' OR NOT EXISTS (SELECT 1 FROM bundle_components component
        WHERE component.bundle_id=bundle.id AND NOT EXISTS (
          SELECT 1 FROM order_bundle_components ordered WHERE ordered.order_item_id=oi.id
            AND ordered.product_id=component.product_id
            AND ordered.quantity_per_bundle=component.quantity)))
      AND (bundle.kind<>'configurable' OR (
        json_array_length(json_extract(NEW.snapshot_json,'$.components'))=
          json_array_length(json_extract(NEW.snapshot_json,'$.selections'))
        AND json_array_length(json_extract(NEW.snapshot_json,'$.selections'))=(
          SELECT count(DISTINCT json_extract(selected.value,'$.group_id')||':'||
            json_extract(selected.value,'$.product_id'))
          FROM json_each(NEW.snapshot_json,'$.selections') selected)
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.snapshot_json,'$.selections') selected
          WHERE NOT EXISTS (SELECT 1 FROM bundle_components component
            WHERE component.bundle_id=bundle.id
              AND component.group_id=json_extract(selected.value,'$.group_id')
              AND component.product_id=json_extract(selected.value,'$.product_id')))
        AND NOT EXISTS (SELECT 1 FROM bundle_groups group_item
          WHERE group_item.bundle_id=bundle.id AND (
            (SELECT count(*) FROM json_each(NEW.snapshot_json,'$.selections') selected
              WHERE json_extract(selected.value,'$.group_id')=group_item.id)<group_item.minimum_selections
            OR (SELECT count(*) FROM json_each(NEW.snapshot_json,'$.selections') selected
              WHERE json_extract(selected.value,'$.group_id')=group_item.id)>group_item.maximum_selections))))
  );
END;

CREATE INDEX idx_bundles_active ON bundles(state, product_id, id);
CREATE INDEX idx_bundle_components_product ON bundle_components(product_id, bundle_id);
CREATE INDEX idx_order_bundle_components_bundle ON order_bundle_components(bundle_id, bundle_version);
CREATE INDEX idx_bundle_applications_bundle ON bundle_applications(bundle_id, bundle_version);
CREATE INDEX idx_bundle_return_movements_location
  ON bundle_return_inventory_movements(location_movement_id, component_variant_id);
