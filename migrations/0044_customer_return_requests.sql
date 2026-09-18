-- R5.5g: selector publico y evidencia owner-only para solicitudes de devolucion.
-- Expand-only: reutiliza el RMA operativo sin activar CUS-005 ni abrir HTTP/UI.

ALTER TABLE return_requests
  ADD COLUMN customer_payload_fingerprint TEXT;
ALTER TABLE return_requests
  ADD COLUMN customer_ownership_version INTEGER;
ALTER TABLE return_requests
  ADD COLUMN customer_contract_version INTEGER;

CREATE TABLE customer_return_access_refs (
  return_id TEXT PRIMARY KEY REFERENCES return_requests(id) ON DELETE CASCADE,
  public_ref TEXT NOT NULL UNIQUE CHECK (
    length(public_ref) = 36
      AND substr(public_ref, 1, 4) = 'ret_'
      AND substr(public_ref, 5) NOT GLOB '*[^0-9a-f]*'
  )
);

INSERT INTO customer_return_access_refs (return_id, public_ref)
SELECT id, 'ret_' || lower(hex(randomblob(16))) FROM return_requests;

CREATE TRIGGER customer_return_access_after_insert
AFTER INSERT ON return_requests
BEGIN
  INSERT INTO customer_return_access_refs (return_id, public_ref)
  VALUES (NEW.id, 'ret_' || lower(hex(randomblob(16))));
END;

CREATE TRIGGER customer_return_access_ref_update_guard
BEFORE UPDATE ON customer_return_access_refs
BEGIN
  SELECT RAISE(ABORT, 'customer_return_access_ref_immutable');
END;

-- Las altas del portal congelan el owner y la version observada. Los RMA
-- historicos/administrativos permanecen compatibles y no se reclaman.
CREATE TRIGGER customer_return_request_evidence_guard
BEFORE INSERT ON return_requests
WHEN NEW.customer_contract_version IS NOT NULL AND COALESCE((
  NEW.customer_contract_version = 1
  AND NEW.requested_by_kind = 'customer'
  AND NEW.customer_payload_fingerprint IS NOT NULL
  AND length(NEW.customer_payload_fingerprint) = 64
  AND NEW.customer_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
  AND typeof(NEW.customer_ownership_version) = 'integer'
  AND NEW.customer_ownership_version >= 1
), 0) = 0
BEGIN
  SELECT RAISE(ABORT, 'customer_return_request_evidence_invalid');
END;

-- El snapshot no es una afirmacion del cliente: debe coincidir con el owner
-- canonico, su version y el estado entregado en el momento exacto del INSERT.
CREATE TRIGGER customer_return_request_owner_guard
BEFORE INSERT ON return_requests
WHEN NEW.customer_contract_version = 1
BEGIN
  SELECT RAISE(ABORT, 'customer_return_request_owner_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM orders o
    JOIN customer_order_access_refs access ON access.order_id=o.id
    JOIN customer_profiles profile ON profile.id=o.customer_profile_id
    WHERE o.id=NEW.order_id AND o.status='delivered'
      AND o.customer_profile_id=NEW.requested_by_id
      AND access.ownership_version=NEW.customer_ownership_version
      AND profile.status='active' AND profile.merged_into_profile_id IS NULL
  );
END;

-- La lectura previa solo mejora UX. Esta guarda vuelve a decidir ventana,
-- variante, precio congelado y cantidad elegible dentro de la transaccion.
CREATE TRIGGER customer_return_line_eligibility_guard
BEFORE INSERT ON return_request_lines
WHEN EXISTS (
  SELECT 1 FROM return_requests r
  WHERE r.id=NEW.return_id AND r.customer_contract_version=1
)
BEGIN
  SELECT RAISE(ABORT, 'customer_return_line_eligibility_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM return_requests r
    JOIN order_items oi ON oi.id=NEW.order_item_id AND oi.order_id=r.order_id
    JOIN product_variants default_variant
      ON default_variant.product_id=oi.product_id AND default_variant.is_default=1
    WHERE r.id=NEW.return_id AND r.order_id=NEW.order_id
      AND COALESCE(oi.variant_id, default_variant.id)=NEW.variant_id
      AND oi.unit_price_cents=NEW.unit_amount_cents
      AND EXISTS (
        SELECT 1 FROM fulfillment_items fi
        JOIN fulfillments f ON f.id=fi.fulfillment_id
        WHERE fi.order_item_id=oi.id AND f.status='delivered'
        GROUP BY fi.order_item_id
        HAVING max(f.delivered_at) <= r.requested_at
          AND julianday(r.requested_at) - julianday(max(f.delivered_at)) BETWEEN 0 AND 30
          AND sum(fi.quantity) - COALESCE((
            SELECT sum(existing.requested_quantity)
            FROM return_request_lines existing
            JOIN return_requests claimed ON claimed.id=existing.return_id
            WHERE existing.order_item_id=oi.id
              AND claimed.status NOT IN ('rejected','cancelled')
          ), 0)=NEW.eligible_quantity
      )
  );
END;

CREATE TRIGGER customer_return_request_evidence_immutable
BEFORE UPDATE OF requested_by_kind, requested_by_id, create_idempotency_key,
  customer_payload_fingerprint, customer_ownership_version, customer_contract_version
ON return_requests
WHEN NEW.requested_by_kind IS NOT OLD.requested_by_kind
  OR NEW.requested_by_id IS NOT OLD.requested_by_id
  OR NEW.create_idempotency_key IS NOT OLD.create_idempotency_key
  OR NEW.customer_payload_fingerprint IS NOT OLD.customer_payload_fingerprint
  OR NEW.customer_ownership_version IS NOT OLD.customer_ownership_version
  OR NEW.customer_contract_version IS NOT OLD.customer_contract_version
BEGIN
  SELECT RAISE(ABORT, 'customer_return_request_evidence_immutable');
END;
