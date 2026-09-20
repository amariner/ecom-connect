-- Devoluciones pedidas por el comprador sobre un pedido entregado. El RMA
-- heredado (0023) exige elegibilidad contra `fulfillments`, un modelo de
-- expedición que esta demo no escribe: aquí la prueba de entrega son sus
-- propios pedidos entregados y sus expediciones.

CREATE TABLE order_returns (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 8 AND 80 AND id GLOB 'rma_*'
  ),
  return_number TEXT NOT NULL UNIQUE CHECK (length(return_number) BETWEEN 8 AND 40),
  public_ref TEXT NOT NULL UNIQUE CHECK (
    length(public_ref) = 36
      AND substr(public_ref, 1, 4) = 'ret_'
      AND substr(public_ref, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  customer_profile_id TEXT NOT NULL
    REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'accepted', 'received', 'refunded', 'rejected', 'cancelled'
  )),
  reason TEXT NOT NULL CHECK (reason IN (
    'damaged', 'defective', 'wrong_item', 'not_as_expected', 'other'
  )),
  comment TEXT CHECK (comment IS NULL OR length(comment) <= 500),
  decision_note TEXT CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  refund_cents INTEGER NOT NULL DEFAULT 0 CHECK (refund_cents >= 0),
  create_idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(trim(create_idempotency_key)) BETWEEN 8 AND 200
  ),
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (updated_at >= requested_at),
  -- El importe lo fija la transición desde las líneas devueltas: un artículo
  -- gratuito se reembolsa por cero, y cualquier otro estado no lleva importe.
  CHECK ((status = 'refunded' AND refund_cents >= 0) OR (status <> 'refunded' AND refund_cents = 0)),
  UNIQUE (id, order_id)
);

CREATE INDEX idx_order_returns_order ON order_returns(order_id, requested_at, id);
CREATE INDEX idx_order_returns_profile ON order_returns(customer_profile_id, requested_at, id);
CREATE INDEX idx_order_returns_open ON order_returns(status, updated_at)
  WHERE status IN ('requested', 'accepted', 'received');

CREATE TABLE order_return_lines (
  return_id TEXT NOT NULL REFERENCES order_returns(id) ON DELETE RESTRICT,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  PRIMARY KEY (return_id, order_item_id)
);

CREATE INDEX idx_order_return_lines_item ON order_return_lines(order_item_id, return_id);

-- Un movimiento por versión de la devolución: la unicidad hace que dos
-- decisiones simultáneas no puedan anotar la misma transición dos veces.
CREATE TABLE order_return_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL REFERENCES order_returns(id) ON DELETE RESTRICT,
  to_status TEXT NOT NULL,
  note TEXT CHECK (note IS NULL OR length(note) <= 300),
  actor TEXT NOT NULL CHECK (actor IN ('customer', 'panel')),
  version_after INTEGER NOT NULL CHECK (version_after >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (return_id, version_after)
);

CREATE INDEX idx_order_return_events_return ON order_return_events(return_id, id);

-- Solo el dueño de un pedido entregado y dentro de la ventana puede abrirla.
-- La decisión se toma dentro de la transacción: una entrega que se deshiciera
-- o una ventana que venciera entre la lectura y el alta cancelan la solicitud.
CREATE TRIGGER order_return_request_guard
BEFORE INSERT ON order_returns
BEGIN
  SELECT RAISE(ABORT, 'order_return_not_eligible')
  WHERE NEW.status <> 'requested' OR NEW.version <> 1 OR NEW.refund_cents <> 0
    OR NOT EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = NEW.order_id AND o.status = 'delivered'
        AND o.customer_profile_id = NEW.customer_profile_id
        AND julianday(NEW.requested_at) - julianday((
          SELECT MAX(e.created_at) FROM order_events e
          WHERE e.order_id = o.id AND e.to_status = 'delivered'
        )) BETWEEN 0 AND 30
    );

  -- Una devolución viva por pedido: el comprador amplía la abierta, no abre otra.
  SELECT RAISE(ABORT, 'order_return_already_open')
  WHERE EXISTS (
    SELECT 1 FROM order_returns existing
    WHERE existing.order_id = NEW.order_id
      AND existing.status IN ('requested', 'accepted', 'received')
  );
END;

-- Nadie puede devolver más unidades de las que compró: lo ya reclamado por una
-- solicitud viva o ya reembolsada cuenta, y una rechazada o anulada libera.
CREATE TRIGGER order_return_line_guard
BEFORE INSERT ON order_return_lines
BEGIN
  SELECT RAISE(ABORT, 'order_return_line_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM order_returns r
    JOIN order_items i ON i.id = NEW.order_item_id AND i.order_id = r.order_id
    WHERE r.id = NEW.return_id
      AND NEW.unit_price_cents = i.unit_price_cents
      AND NEW.qty + COALESCE((
        SELECT SUM(claimed.qty) FROM order_return_lines claimed
        JOIN order_returns other ON other.id = claimed.return_id
        WHERE claimed.order_item_id = NEW.order_item_id
          AND other.status NOT IN ('rejected', 'cancelled')
      ), 0) <= COALESCE(i.current_qty, i.qty)
  );
END;

CREATE TRIGGER order_return_line_immutable
BEFORE UPDATE ON order_return_lines
BEGIN
  SELECT RAISE(ABORT, 'order_return_line_immutable');
END;

-- Transiciones legales de una devolución. El panel decide, el comprador solo
-- puede anular la suya mientras nadie la haya aceptado.
CREATE TRIGGER order_return_transition_guard
BEFORE UPDATE ON order_returns
BEGIN
  SELECT RAISE(ABORT, 'order_return_transition_conflict')
  WHERE NEW.version <> OLD.version + 1
    OR NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id
    OR NEW.public_ref <> OLD.public_ref OR NEW.return_number <> OLD.return_number
    OR NEW.customer_profile_id <> OLD.customer_profile_id
    OR NEW.reason <> OLD.reason OR NEW.comment IS NOT OLD.comment
    OR NEW.create_idempotency_key <> OLD.create_idempotency_key
    OR NEW.requested_at <> OLD.requested_at
    OR NEW.updated_at < OLD.updated_at
    OR NOT (
      (OLD.status = 'requested' AND NEW.status IN ('accepted', 'rejected', 'cancelled'))
      OR (OLD.status = 'accepted' AND NEW.status IN ('received', 'rejected'))
      OR (OLD.status = 'received' AND NEW.status = 'refunded')
    )
    -- El importe simulado es el de las líneas devueltas, nunca uno libre.
    OR (NEW.status = 'refunded' AND NEW.refund_cents <> COALESCE((
      SELECT SUM(line.qty * line.unit_price_cents) FROM order_return_lines line
      WHERE line.return_id = OLD.id
    ), 0));
END;

-- La reposición pertenece al hecho, no a quien lo escribe: el disparador la
-- aplica exactamente en la transición a «recibida», de modo que dos decisiones
-- simultáneas no pueden devolver dos veces las mismas unidades al stock.
CREATE TRIGGER order_return_restock_on_receive
AFTER UPDATE OF status ON order_returns
WHEN NEW.status = 'received' AND OLD.status = 'accepted'
BEGIN
  UPDATE products SET stock = stock + (
    SELECT SUM(line.qty) FROM order_return_lines line
    JOIN order_items item ON item.id = line.order_item_id
    WHERE line.return_id = NEW.id AND item.product_id = products.id
  ) WHERE EXISTS (
    SELECT 1 FROM order_return_lines line
    JOIN order_items item ON item.id = line.order_item_id
    WHERE line.return_id = NEW.id AND item.product_id = products.id
  );
END;
