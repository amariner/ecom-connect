-- R5.5e: referencias públicas opacas para direcciones guardadas.
-- Expand-only: no activa CUS-006, no abre rutas y no duplica PII.

CREATE TABLE customer_address_access_refs (
  address_id TEXT PRIMARY KEY CHECK (
    length(address_id) BETWEEN 3 AND 200
      AND address_id GLOB '[a-z]*'
      AND address_id NOT GLOB '*[^a-z0-9_:-]*'
      AND (instr(address_id, '_') > 0 OR instr(address_id, ':') > 0
        OR instr(address_id, '-') > 0)
  ),
  public_ref TEXT NOT NULL UNIQUE CHECK (
    length(public_ref) = 37
      AND substr(public_ref, 1, 5) = 'addr_'
      AND substr(public_ref, 6) NOT GLOB '*[^0-9a-f]*'
  )
);

-- La referencia representa el address_id estable, no una revisión ni sus
-- datos. La revisión vigente sigue siendo la única fuente de owner y versión.
INSERT INTO customer_address_access_refs (address_id, public_ref)
SELECT address_id, 'addr_' || lower(hex(randomblob(16)))
FROM customer_address_revisions
GROUP BY address_id;

-- La primera revisión y su selector nacen en la misma transacción. Una
-- colisión UNIQUE aborta el alta completa, evitando direcciones sin selector.
CREATE TRIGGER customer_address_access_after_revision_insert
AFTER INSERT ON customer_address_revisions
WHEN NEW.revision = 1
BEGIN
  INSERT INTO customer_address_access_refs (address_id, public_ref)
  SELECT NEW.address_id, 'addr_' || lower(hex(randomblob(16)))
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_address_access_refs access
    WHERE access.address_id = NEW.address_id
  );
END;

-- El selector no rota mientras exista cualquier revisión del recurso.
CREATE TRIGGER customer_address_access_ref_update_guard
BEFORE UPDATE ON customer_address_access_refs
BEGIN
  SELECT RAISE(ABORT, 'customer_address_access_ref_immutable');
END;

CREATE TRIGGER customer_address_access_ref_delete_guard
BEFORE DELETE ON customer_address_access_refs
WHEN EXISTS (
  SELECT 1 FROM customer_address_revisions revision
  WHERE revision.address_id = OLD.address_id
)
BEGIN
  SELECT RAISE(ABORT, 'customer_address_access_ref_in_use');
END;

-- R5.3 puede purgar todas las revisiones cuando la política aprobada lo
-- permita. La última baja retira también el selector sin copiar contenido.
CREATE TRIGGER customer_address_access_after_revision_delete
AFTER DELETE ON customer_address_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM customer_address_revisions revision
  WHERE revision.address_id = OLD.address_id
)
BEGIN
  DELETE FROM customer_address_access_refs WHERE address_id = OLD.address_id;
END;
