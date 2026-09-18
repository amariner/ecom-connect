-- Migration number: 0002 	 Colecciones + capacidades opcionales de producto (Fase 9B.1)
--
-- DOS cosas en UNA sola migración, decididas juntas el 2026-07-21:
--
-- (a) COLECCIONES. Cada tema del catálogo de estilos tiene su propio catálogo de
--     productos, pero comparte UN backend: un esquema, una lógica de precios, un
--     checkout, un backoffice. La alternativa (tabla por tema) serían 8 backends
--     de facto, que es exactamente el fracaso que esta arquitectura existe para
--     evitar.
--
-- (b) CAPACIDADES OPCIONALES de producto. Tres temas piden datos que el modelo no
--     tenía (subtítulo técnico, precio anterior, ficha de especificaciones). Se
--     resuelven UNA vez aquí, como columnas nullable que cada tema usa o ignora,
--     en vez de con tres apaños distintos derivados del seed. Un cliente real
--     también quiere descuentos y ficha técnica: esto los hereda de serie.
--
-- ⚠️ GUARDARRAÍL DE DINERO — `compare_at_price_cents` es EXCLUSIVAMENTE
--    PRESENTACIÓN. Es el precio anterior tachado, nada más. NO entra en
--    lib/pricing.ts, ni en lib/shipping.ts, ni en el umbral de envío gratis, ni
--    en los line_items de Stripe. El precio real es `price_cents` y solo él.
--    Un descuento que se cuele en la lógica de cobro es un bug de dinero.
--    Lo fija `tests/pricing-guard.test.ts`, que falla si la cadena
--    "compare_at_price" aparece en cualquier módulo de la ruta de cobro.

-- (a) Colección a la que pertenece el producto. El DEFAULT retro-llena las filas
--     existentes en el mismo ALTER (SQLite lo permite porque no es nulo), así que
--     el catálogo actual queda íntegro en la colección 'demo'.
ALTER TABLE products ADD COLUMN collection TEXT NOT NULL DEFAULT 'demo';

-- (b) Capacidades opcionales. Todas nullable, todas ignorables por un tema.
--     NOTA: SQLite no admite CHECK en ALTER TABLE ADD COLUMN. Las invariantes
--     (compare_at_price_cents > price_cents; specs_json con forma
--     [{label,value}]) se validan en el seed y en el PATCH del admin, con test.
ALTER TABLE products ADD COLUMN subtitle TEXT;                  -- Industrial: subtítulo técnico bajo el nombre
ALTER TABLE products ADD COLUMN compare_at_price_cents INTEGER; -- Natural: precio anterior tachado (SOLO presentación)
ALTER TABLE products ADD COLUMN specs_json TEXT;                -- Specs: filas [{label,value}] de ficha técnica

-- El índice que sirve a la lectura de catálogo: siempre se filtra por colección
-- activa, y casi siempre además por categoría.
CREATE INDEX idx_products_collection ON products(collection, active, category);
