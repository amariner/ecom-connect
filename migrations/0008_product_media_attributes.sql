-- Media y atributos tipados (R2.5; ADR-0013).
--
-- Aditiva: conserva `products.image` y `products.specs_json` como espejos y
-- fallback legacy. No almacena binarios ni toca inventario, pagos o fulfillment.

CREATE TABLE product_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 500),
  alt_text TEXT NOT NULL CHECK (length(trim(alt_text)) BETWEEN 1 AND 240),
  focal_x_bps INTEGER NOT NULL DEFAULT 5000
    CHECK (typeof(focal_x_bps) = 'integer' AND focal_x_bps BETWEEN 0 AND 10000),
  focal_y_bps INTEGER NOT NULL DEFAULT 5000
    CHECK (typeof(focal_y_bps) = 'integer' AND focal_y_bps BETWEEN 0 AND 10000),
  position INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(position) = 'integer' AND position >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id, product_id),
  UNIQUE (product_id, position)
);

CREATE INDEX idx_product_media_product
  ON product_media(product_id, position, id);

CREATE TABLE product_variant_media (
  variant_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  media_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(position) = 'integer' AND position >= 0),
  PRIMARY KEY (variant_id, media_id),
  UNIQUE (variant_id, position),
  FOREIGN KEY (variant_id, product_id)
    REFERENCES product_variants(id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (media_id, product_id)
    REFERENCES product_media(id, product_id) ON DELETE CASCADE
);

CREATE INDEX idx_product_variant_media_media
  ON product_variant_media(media_id, variant_id);

CREATE TABLE attribute_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection TEXT NOT NULL CHECK (length(trim(collection)) BETWEEN 1 AND 80),
  category TEXT NOT NULL DEFAULT '' CHECK (length(category) <= 120),
  code TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(code)) BETWEEN 1 AND 80),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  value_type TEXT NOT NULL
    CHECK (value_type IN ('text', 'number', 'boolean', 'reference', 'list')),
  unit TEXT CHECK (
    unit IS NULL
    OR (value_type = 'number' AND length(trim(unit)) BETWEEN 1 AND 24)
  ),
  constraints_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      json_valid(constraints_json)
      AND json_type(constraints_json) = 'object'
      AND length(constraints_json) <= 4096
    ),
  position INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(position) = 'integer' AND position >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (collection, category, code),
  UNIQUE (collection, category, position),
  UNIQUE (id, collection)
);

CREATE INDEX idx_attribute_definitions_scope
  ON attribute_definitions(collection, category, active, position, id);

CREATE TABLE product_attribute_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id INTEGER,
  attribute_definition_id INTEGER NOT NULL
    REFERENCES attribute_definitions(id) ON DELETE RESTRICT,
  value_text TEXT CHECK (
    value_text IS NULL OR length(value_text) BETWEEN 1 AND 5000
  ),
  value_number REAL CHECK (
    value_number IS NULL OR typeof(value_number) IN ('integer', 'real')
  ),
  value_boolean INTEGER CHECK (
    value_boolean IS NULL OR value_boolean IN (0, 1)
  ),
  value_reference TEXT CHECK (
    value_reference IS NULL OR length(trim(value_reference)) BETWEEN 1 AND 500
  ),
  value_list_json TEXT CHECK (
    value_list_json IS NULL
    OR (
      json_valid(value_list_json)
      AND json_type(value_list_json) = 'array'
      AND json_array_length(value_list_json) > 0
      AND length(value_list_json) <= 4096
    )
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (variant_id, product_id)
    REFERENCES product_variants(id, product_id) ON DELETE CASCADE,
  CHECK (
    (value_text IS NOT NULL)
    + (value_number IS NOT NULL)
    + (value_boolean IS NOT NULL)
    + (value_reference IS NOT NULL)
    + (value_list_json IS NOT NULL) = 1
  )
);

CREATE UNIQUE INDEX idx_product_attribute_values_product
  ON product_attribute_values(product_id, attribute_definition_id)
  WHERE variant_id IS NULL;

CREATE UNIQUE INDEX idx_product_attribute_values_variant
  ON product_attribute_values(variant_id, attribute_definition_id)
  WHERE variant_id IS NOT NULL;

CREATE INDEX idx_product_attribute_values_definition
  ON product_attribute_values(attribute_definition_id, product_id, variant_id);

-- Backfill determinista del espejo legacy. `specs_json` no se interpreta:
-- sus etiquetas libres no permiten inferir códigos, tipos ni unidades.
INSERT INTO product_media (
  product_id, kind, source, alt_text, focal_x_bps, focal_y_bps, position,
  created_at, updated_at
)
SELECT
  id, 'image', image, name, 5000, 5000, 0, created_at, created_at
FROM products
WHERE length(trim(image)) > 0
ORDER BY id;
