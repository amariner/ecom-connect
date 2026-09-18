-- Producto-variante aditivo (R2.2; ADR-0012).
--
-- El binario actual sigue leyendo `products`: esta migracion solo materializa
-- la unidad vendible, conserva las columnas legacy y prepara el shadow-read de
-- R2.3. Inventario, pagos, fulfillment, media y atributos quedan fuera.

CREATE TABLE product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(sku)) BETWEEN 1 AND 100),
  gtin TEXT
    CHECK (
      gtin IS NULL
      OR (
        length(gtin) BETWEEN 8 AND 14
        AND gtin NOT GLOB '*[^0-9]*'
      )
    ),
  mpn TEXT
    CHECK (mpn IS NULL OR length(trim(mpn)) BETWEEN 1 AND 100),
  title TEXT NOT NULL DEFAULT ''
    CHECK (length(title) <= 160),
  price_cents INTEGER NOT NULL
    CHECK (typeof(price_cents) = 'integer' AND price_cents >= 0),
  compare_at_price_cents INTEGER
    CHECK (
      compare_at_price_cents IS NULL
      OR (
        typeof(compare_at_price_cents) = 'integer'
        AND compare_at_price_cents > price_cents
      )
    ),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived')),
  is_default INTEGER NOT NULL DEFAULT 0
    CHECK (is_default IN (0, 1)),
  -- Firma canonica de ids de valor, por ejemplo `[12,18]`. NULL significa
  -- producto simple. R2.3 fijara el constructor tipado; los indices de abajo
  -- impiden repetir tanto la combinacion vacia como una firma materializada.
  option_signature TEXT
    CHECK (
      option_signature IS NULL
      OR (
        json_valid(option_signature)
        AND json_type(option_signature) = 'array'
        AND json_array_length(option_signature) > 0
      )
    ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sku),
  UNIQUE (id, product_id),
  UNIQUE (product_id, option_signature)
);

CREATE INDEX idx_product_variants_product
  ON product_variants(product_id, status, id);

CREATE UNIQUE INDEX idx_product_variants_default
  ON product_variants(product_id)
  WHERE is_default = 1;

CREATE UNIQUE INDEX idx_product_variants_simple
  ON product_variants(product_id)
  WHERE option_signature IS NULL;

CREATE TABLE product_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(name)) BETWEEN 1 AND 80),
  position INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(position) = 'integer' AND position >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, name),
  UNIQUE (product_id, position),
  UNIQUE (id, product_id)
);

CREATE INDEX idx_product_options_product
  ON product_options(product_id, position, id);

CREATE TABLE product_option_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  option_id INTEGER NOT NULL REFERENCES product_options(id) ON DELETE CASCADE,
  value TEXT NOT NULL COLLATE NOCASE
    CHECK (length(trim(value)) BETWEEN 1 AND 100),
  position INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(position) = 'integer' AND position >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (option_id, value),
  UNIQUE (option_id, position),
  UNIQUE (id, option_id)
);

CREATE INDEX idx_product_option_values_option
  ON product_option_values(option_id, position, id);

CREATE TABLE product_variant_option_values (
  variant_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  option_id INTEGER NOT NULL,
  option_value_id INTEGER NOT NULL,
  PRIMARY KEY (variant_id, option_id),
  UNIQUE (variant_id, option_value_id),
  FOREIGN KEY (variant_id, product_id)
    REFERENCES product_variants(id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (option_id, product_id)
    REFERENCES product_options(id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (option_value_id, option_id)
    REFERENCES product_option_values(id, option_id) ON DELETE CASCADE
);

CREATE INDEX idx_product_variant_values_product
  ON product_variant_option_values(product_id, option_id, option_value_id);

CREATE INDEX idx_product_variant_values_value
  ON product_variant_option_values(option_value_id, variant_id);

-- Columnas expand/contract: las lineas conservan product_id/name_snapshot y
-- ganan la referencia/snapshots de variante sin obligar a ningun lector nuevo.
ALTER TABLE order_items ADD COLUMN variant_id INTEGER
  REFERENCES product_variants(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN sku_snapshot TEXT;
ALTER TABLE order_items ADD COLUMN product_name_snapshot TEXT;
ALTER TABLE order_items ADD COLUMN variant_name_snapshot TEXT;

CREATE INDEX idx_order_items_variant ON order_items(variant_id);

-- Backfill 1:1 determinista. La variante simple no inventa un titulo visible;
-- replica precio, precio anterior, actividad y timestamp del producto legacy.
INSERT INTO product_variants (
  product_id,
  sku,
  title,
  price_cents,
  compare_at_price_cents,
  status,
  is_default,
  option_signature,
  created_at,
  updated_at
)
SELECT
  id,
  'LEGACY-' || id,
  '',
  price_cents,
  compare_at_price_cents,
  CASE active WHEN 1 THEN 'active' ELSE 'archived' END,
  1,
  NULL,
  created_at,
  created_at
FROM products
ORDER BY id;

UPDATE order_items
SET
  variant_id = (
    SELECT product_variants.id
    FROM product_variants
    WHERE product_variants.product_id = order_items.product_id
      AND product_variants.is_default = 1
  ),
  sku_snapshot = (
    SELECT product_variants.sku
    FROM product_variants
    WHERE product_variants.product_id = order_items.product_id
      AND product_variants.is_default = 1
  ),
  product_name_snapshot = name_snapshot,
  variant_name_snapshot = NULL;
