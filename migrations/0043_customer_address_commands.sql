-- R5.5f: idempotencia durable de altas/revisiones de direcciones.
-- La evidencia vive en la revisión canónica; no crea una copia de la PII.

ALTER TABLE customer_address_revisions
  ADD COLUMN write_idempotency_key TEXT;
ALTER TABLE customer_address_revisions
  ADD COLUMN write_payload_fingerprint TEXT;

CREATE UNIQUE INDEX idx_customer_address_revisions_write_idempotency
  ON customer_address_revisions(write_idempotency_key)
  WHERE write_idempotency_key IS NOT NULL;

CREATE TRIGGER customer_address_write_evidence_guard
BEFORE INSERT ON customer_address_revisions
WHEN (NEW.write_idempotency_key IS NULL) <> (NEW.write_payload_fingerprint IS NULL)
  OR (NEW.write_idempotency_key IS NOT NULL AND NOT (
    length(trim(NEW.write_idempotency_key)) BETWEEN 8 AND 200
    AND NEW.write_idempotency_key = trim(NEW.write_idempotency_key)
    AND instr(NEW.write_idempotency_key, char(0)) = 0
    AND instr(NEW.write_idempotency_key, char(9)) = 0
    AND instr(NEW.write_idempotency_key, char(10)) = 0
    AND instr(NEW.write_idempotency_key, char(13)) = 0
    AND instr(NEW.write_idempotency_key, char(31)) = 0
    AND instr(NEW.write_idempotency_key, char(127)) = 0
    AND length(NEW.write_payload_fingerprint) = 64
    AND NEW.write_payload_fingerprint NOT GLOB '*[^0-9a-f]*'
  ))
BEGIN
  SELECT RAISE(ABORT, 'customer_address_write_evidence_invalid');
END;

CREATE TRIGGER customer_address_write_evidence_update_guard
BEFORE UPDATE OF write_idempotency_key, write_payload_fingerprint
ON customer_address_revisions
WHEN NEW.write_idempotency_key IS NOT OLD.write_idempotency_key
  OR NEW.write_payload_fingerprint IS NOT OLD.write_payload_fingerprint
BEGIN
  SELECT RAISE(ABORT, 'customer_address_write_evidence_immutable');
END;
