-- Área de cliente de la tienda. Activa el esquema heredado de clientes
-- (perfiles, identidad passwordless, direcciones) añadiendo lo que faltaba
-- para atender a un comprador: su nombre visible, su dirección preferida y
-- una cancelación pedida por él mismo, distinta de la del panel.

-- El perfil heredado solo guarda el correo. El nombre y el teléfono son los
-- datos que el propio cliente mantiene desde su cuenta; los del pedido siguen
-- congelados en su snapshot y no se reescriben.
ALTER TABLE customer_profiles ADD COLUMN display_name TEXT
  CHECK (display_name IS NULL OR length(trim(display_name)) BETWEEN 2 AND 120);
ALTER TABLE customer_profiles ADD COLUMN phone TEXT
  CHECK (phone IS NULL OR length(trim(phone)) BETWEEN 3 AND 30);

-- La dirección preferida es una elección revocable del cliente, no un atributo
-- de la dirección: vive fuera de las revisiones y nunca las modifica.
CREATE TABLE customer_default_addresses (
  customer_profile_id TEXT PRIMARY KEY
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  address_id TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) BETWEEN 20 AND 32
      AND substr(updated_at, -1) = 'Z'
      AND julianday(updated_at) IS NOT NULL
  )
);

-- Solo puede preferirse una dirección vigente del propio perfil. La guarda
-- decide dentro de la transacción: una baja simultánea nunca deja preferida
-- una dirección archivada ni ajena.
CREATE TRIGGER customer_default_address_insert_guard
BEFORE INSERT ON customer_default_addresses
BEGIN
  SELECT RAISE(ABORT, 'customer_default_address_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_address_revisions revision
    WHERE revision.address_id = NEW.address_id
      AND revision.customer_profile_id = NEW.customer_profile_id
      AND revision.valid_to IS NULL
  );
END;

CREATE TRIGGER customer_default_address_update_guard
BEFORE UPDATE ON customer_default_addresses
BEGIN
  SELECT RAISE(ABORT, 'customer_default_address_conflict')
  WHERE NEW.customer_profile_id <> OLD.customer_profile_id
    OR NOT EXISTS (
      SELECT 1 FROM customer_address_revisions revision
      WHERE revision.address_id = NEW.address_id
        AND revision.customer_profile_id = NEW.customer_profile_id
        AND revision.valid_to IS NULL
    );
END;

-- Archivar la dirección preferida retira la preferencia en la misma sentencia.
CREATE TRIGGER customer_default_address_after_archive
AFTER UPDATE OF valid_to ON customer_address_revisions
WHEN NEW.valid_to IS NOT NULL AND OLD.valid_to IS NULL
BEGIN
  DELETE FROM customer_default_addresses
  WHERE address_id = NEW.address_id
    AND customer_profile_id = NEW.customer_profile_id;
END;

-- El origen de una cancelación forma parte de su evidencia: una pedida por el
-- comprador desde su cuenta no es una decisión del comercio. SQLite no permite
-- ampliar un CHECK, así que la tabla se reconstruye conservando sus filas.
CREATE TABLE order_cancellations_rebuilt (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK(source IN ('panel','marketplace','account')),
  reason TEXT NOT NULL CHECK(reason IN ('customer_request','out_of_stock','duplicate','other')),
  supplier_outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK(supplier_outcome IN ('pending','not_required','accepted','rejected')),
  requested_at TEXT NOT NULL,
  cancelled_at TEXT
);

INSERT INTO order_cancellations_rebuilt (
  order_id, source, reason, supplier_outcome, requested_at, cancelled_at
)
SELECT order_id, source, reason, supplier_outcome, requested_at, cancelled_at
FROM order_cancellations;

DROP TABLE order_cancellations;

ALTER TABLE order_cancellations_rebuilt RENAME TO order_cancellations;
