-- Cancelacion y reembolso parcial por cantidades (R2.13; ADR-0016).
--
-- Migracion aditiva. Las filas R2.10 conservan la semantica de cancelacion
-- total; las cancelaciones parciales reservan cantidades antes de llamar al
-- PSP y no invaden el futuro flujo de devoluciones/RMA.

ALTER TABLE refunds ADD COLUMN operation_type TEXT NOT NULL
  DEFAULT 'total_cancellation'
  CHECK (operation_type IN (
    'total_cancellation', 'partial_cancellation', 'return', 'adjustment'
  ));

CREATE INDEX idx_refunds_order_operation
  ON refunds(order_id, operation_type, status, id);

-- `refund_items` no repite order_id. Esta guarda demuestra la pertenencia a
-- traves de refunds.order_id y reserva cantidades antes de llamar al PSP.
-- Solo `cancelled` libera una intencion: failed/requires_review se reintentan
-- con la misma identidad y no permiten que otra solicitud use esas unidades.
CREATE TRIGGER refund_item_partial_guard
BEFORE INSERT ON refund_items
BEGIN
  SELECT RAISE(ABORT, 'refund_item_order_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM refunds target
    JOIN order_items oi
      ON oi.id = NEW.order_item_id AND oi.order_id = target.order_id
    WHERE target.id = NEW.refund_id
  );

  SELECT RAISE(ABORT, 'refund_item_quantity_conflict')
  WHERE EXISTS (
    SELECT 1 FROM refunds target
    WHERE target.id = NEW.refund_id
      AND target.operation_type IN ('total_cancellation', 'partial_cancellation')
  ) AND NOT EXISTS (
    SELECT 1
    FROM refunds target
    JOIN order_items oi
      ON oi.id = NEW.order_item_id AND oi.order_id = target.order_id
    WHERE target.id = NEW.refund_id
      AND NEW.quantity
        + COALESCE((
          SELECT sum(existing_item.quantity)
          FROM refund_items existing_item
          JOIN refunds existing_refund ON existing_refund.id = existing_item.refund_id
          WHERE existing_item.order_item_id = oi.id
            AND existing_refund.operation_type IN (
              'total_cancellation', 'partial_cancellation'
            )
            AND existing_refund.status <> 'cancelled'
        ), 0)
        + COALESCE((
          SELECT sum(fi.quantity)
          FROM fulfillment_items fi
          JOIN fulfillments f ON f.id = fi.fulfillment_id
          WHERE fi.order_item_id = oi.id AND f.status <> 'cancelled'
        ), 0)
        <= oi.qty
  );
END;
