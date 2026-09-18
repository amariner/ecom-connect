-- R5.5b: referencias públicas opacas y versión de ownership de pedidos.
-- Expand-only: no activa CUS-004, no abre rutas y no asocia pedidos guest.

CREATE TABLE customer_order_access_refs (
  order_id INTEGER PRIMARY KEY
    REFERENCES orders(id) ON DELETE CASCADE,
  public_ref TEXT NOT NULL UNIQUE CHECK (
    length(public_ref) = 36
      AND substr(public_ref, 1, 4) = 'ord_'
      AND substr(public_ref, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  ownership_version INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(ownership_version) = 'integer' AND ownership_version >= 1
  )
);

-- Cada fila existente recibe un selector aleatorio propio. La asociación de
-- owner permanece exclusivamente en orders.customer_profile_id y no se toca.
INSERT INTO customer_order_access_refs (order_id, public_ref, ownership_version)
SELECT id, 'ord_' || lower(hex(randomblob(16))), 1
FROM orders;

-- Todo pedido futuro recibe la referencia dentro de la misma transacción. Una
-- colisión UNIQUE aborta también el INSERT del pedido; nunca queda media alta.
CREATE TRIGGER customer_order_access_after_order_insert
AFTER INSERT ON orders
BEGIN
  INSERT INTO customer_order_access_refs (
    order_id, public_ref, ownership_version
  ) VALUES (
    NEW.id, 'ord_' || lower(hex(randomblob(16))), 1
  );
END;

-- La fila de acceso debe existir antes de cambiar ownership. Evita que un
-- writer incompleto eluda el control optimista de las superficies futuras.
CREATE TRIGGER customer_order_access_owner_precondition
BEFORE UPDATE OF customer_profile_id ON orders
WHEN NEW.customer_profile_id IS NOT OLD.customer_profile_id
BEGIN
  SELECT RAISE(ABORT, 'customer_order_access_ref_missing')
  WHERE NOT EXISTS (
    SELECT 1 FROM customer_order_access_refs access
    WHERE access.order_id = OLD.id
  );
END;

CREATE TRIGGER customer_order_access_owner_version
AFTER UPDATE OF customer_profile_id ON orders
WHEN NEW.customer_profile_id IS NOT OLD.customer_profile_id
BEGIN
  UPDATE customer_order_access_refs
  SET ownership_version = ownership_version + 1
  WHERE order_id = NEW.id;
END;

-- Referencia y relación con el pedido son inmutables. La versión solo avanza
-- una unidad; el trigger anterior es el único writer compuesto del motor.
CREATE TRIGGER customer_order_access_ref_update_guard
BEFORE UPDATE ON customer_order_access_refs
BEGIN
  SELECT RAISE(ABORT, 'customer_order_access_ref_immutable')
  WHERE NEW.order_id <> OLD.order_id
    OR NEW.public_ref <> OLD.public_ref
    OR NEW.ownership_version <> OLD.ownership_version + 1;
END;
