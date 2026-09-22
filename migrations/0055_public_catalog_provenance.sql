-- Datos públicos del catálogo, separados de existencias e integraciones simuladas.
ALTER TABLE products ADD COLUMN source_url TEXT;
ALTER TABLE products ADD COLUMN source_product_id TEXT;
ALTER TABLE products ADD COLUMN source_reference TEXT;
ALTER TABLE products ADD COLUMN source_fetched_at TEXT;
ALTER TABLE products ADD COLUMN source_availability TEXT;
ALTER TABLE products ADD COLUMN source_categories TEXT NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX idx_products_public_source ON products(source_product_id) WHERE source_product_id IS NOT NULL;
