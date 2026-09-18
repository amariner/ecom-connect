-- Documentos operativos R3.11. Expand-only: los documentos propios son
-- snapshots imprimibles; factura y rectificativa solo registran el artefacto
-- emitido por una herramienta fiscal externa (ADR-0027).

CREATE UNIQUE INDEX idx_refunds_id_order
  ON refunds(id, order_id);

CREATE TABLE order_document_templates (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  template_key TEXT NOT NULL CHECK (length(trim(template_key)) BETWEEN 3 AND 80),
  document_type TEXT NOT NULL CHECK (document_type IN ('packing_slip', 'internal_label')),
  version INTEGER NOT NULL CHECK (version >= 1),
  renderer TEXT NOT NULL CHECK (renderer IN ('packing-slip-v1', 'internal-label-v1')),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(config_json) AND json_type(config_json) = 'object'
  ),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (template_key, version),
  UNIQUE (id, document_type)
);

CREATE INDEX idx_order_document_templates_active
  ON order_document_templates(document_type, active, version DESC);

CREATE TABLE order_documents (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 100),
  document_number TEXT NOT NULL UNIQUE CHECK (length(trim(document_number)) BETWEEN 3 AND 120),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  document_type TEXT NOT NULL CHECK (document_type IN (
    'packing_slip', 'internal_label', 'external_invoice', 'external_credit_note'
  )),
  source TEXT NOT NULL CHECK (source IN ('generated', 'external')),
  template_id TEXT,
  fulfillment_id INTEGER,
  refund_id INTEGER,
  document_version INTEGER NOT NULL CHECK (document_version >= 1),
  lifecycle_version INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_version >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'voided')),
  expected_amount_cents INTEGER CHECK (
    expected_amount_cents IS NULL OR (typeof(expected_amount_cents) = 'integer' AND expected_amount_cents >= 0)
  ),
  currency TEXT CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency))),
  external_provider TEXT CHECK (external_provider IS NULL OR length(trim(external_provider)) BETWEEN 2 AND 80),
  external_reference TEXT CHECK (external_reference IS NULL OR length(trim(external_reference)) BETWEEN 2 AND 120),
  external_url TEXT CHECK (external_url IS NULL OR external_url LIKE 'https://%'),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND json_type(snapshot_json) = 'object'),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 200),
  supersedes_id TEXT REFERENCES order_documents(id) ON DELETE RESTRICT,
  void_idempotency_key TEXT UNIQUE,
  void_reason TEXT CHECK (void_reason IS NULL OR length(trim(void_reason)) BETWEEN 3 AND 240),
  issued_at TEXT NOT NULL,
  voided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, order_id),
  FOREIGN KEY (template_id, document_type)
    REFERENCES order_document_templates(id, document_type) ON DELETE RESTRICT,
  FOREIGN KEY (fulfillment_id, order_id)
    REFERENCES fulfillments(id, order_id) ON DELETE RESTRICT,
  FOREIGN KEY (refund_id, order_id)
    REFERENCES refunds(id, order_id) ON DELETE RESTRICT,
  CHECK (
    (document_type IN ('packing_slip', 'internal_label')
      AND source = 'generated' AND template_id IS NOT NULL
      AND fulfillment_id IS NOT NULL AND refund_id IS NULL
      AND expected_amount_cents IS NULL AND currency IS NULL
      AND external_provider IS NULL AND external_reference IS NULL AND external_url IS NULL)
    OR
    (document_type = 'external_invoice'
      AND source = 'external' AND template_id IS NULL
      AND fulfillment_id IS NULL AND refund_id IS NULL
      AND expected_amount_cents IS NOT NULL AND currency IS NOT NULL
      AND external_provider IS NOT NULL AND external_reference IS NOT NULL)
    OR
    (document_type = 'external_credit_note'
      AND source = 'external' AND template_id IS NULL
      AND fulfillment_id IS NULL AND refund_id IS NOT NULL
      AND expected_amount_cents IS NOT NULL AND currency IS NOT NULL
      AND external_provider IS NOT NULL AND external_reference IS NOT NULL)
  ),
  CHECK (
    (status = 'voided' AND void_idempotency_key IS NOT NULL AND void_reason IS NOT NULL AND voided_at IS NOT NULL)
    OR (status <> 'voided' AND void_idempotency_key IS NULL AND void_reason IS NULL AND voided_at IS NULL)
  ),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

CREATE UNIQUE INDEX idx_order_documents_scope_version
  ON order_documents(
    order_id, document_type, coalesce(fulfillment_id, 0), coalesce(refund_id, 0), document_version
  );

CREATE UNIQUE INDEX idx_order_documents_active_scope
  ON order_documents(
    order_id, document_type, coalesce(fulfillment_id, 0), coalesce(refund_id, 0)
  ) WHERE status = 'active';

CREATE UNIQUE INDEX idx_order_documents_external_reference
  ON order_documents(external_provider, document_type, external_reference)
  WHERE source = 'external';

CREATE INDEX idx_order_documents_order
  ON order_documents(order_id, issued_at DESC, id DESC);

CREATE INDEX idx_order_documents_work
  ON order_documents(status, document_type, issued_at DESC, id DESC);

CREATE TABLE order_document_artifacts (
  document_id TEXT PRIMARY KEY REFERENCES order_documents(id) ON DELETE RESTRICT,
  content_type TEXT NOT NULL DEFAULT 'text/html' CHECK (content_type = 'text/html'),
  content_text TEXT NOT NULL CHECK (length(content_text) BETWEEN 1 AND 1000000),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 1000000),
  created_at TEXT NOT NULL
);

CREATE TABLE order_document_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES order_documents(id) ON DELETE RESTRICT,
  transition TEXT NOT NULL CHECK (transition IN ('created', 'superseded', 'voided')),
  from_status TEXT,
  to_status TEXT NOT NULL CHECK (to_status IN ('active', 'superseded', 'voided')),
  lifecycle_version_after INTEGER NOT NULL CHECK (lifecycle_version_after >= 1),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'system', 'provider')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 2 AND 80),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) BETWEEN 8 AND 240),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  occurred_at TEXT NOT NULL,
  UNIQUE (document_id, lifecycle_version_after)
);

CREATE INDEX idx_order_document_events_document
  ON order_document_events(document_id, lifecycle_version_after, id);

-- La lectura prepara la UX; estas guardas deciden la validez real dentro de la
-- misma transacción que inserta el documento.
CREATE TRIGGER order_document_insert_guard
BEFORE INSERT ON order_documents
BEGIN
  SELECT RAISE(ABORT, 'document_fulfillment_conflict')
  WHERE NEW.fulfillment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fulfillments f
    WHERE f.id = NEW.fulfillment_id AND f.order_id = NEW.order_id AND f.status <> 'cancelled'
  );

  SELECT RAISE(ABORT, 'document_invoice_amount_conflict')
  WHERE NEW.document_type = 'external_invoice' AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.id = NEW.order_id AND o.status IN ('paid', 'shipped', 'delivered')
      AND o.total_cents = NEW.expected_amount_cents
      AND upper(o.currency) = NEW.currency
  );

  SELECT RAISE(ABORT, 'document_credit_note_amount_conflict')
  WHERE NEW.document_type = 'external_credit_note' AND NOT EXISTS (
    SELECT 1 FROM refunds r JOIN orders o ON o.id = r.order_id
    WHERE r.id = NEW.refund_id AND r.order_id = NEW.order_id AND r.status = 'succeeded'
      AND r.total_cents = NEW.expected_amount_cents AND upper(o.currency) = NEW.currency
  );

  SELECT RAISE(ABORT, 'document_supersedes_conflict')
  WHERE NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM order_documents previous
    WHERE previous.id = NEW.supersedes_id AND previous.order_id = NEW.order_id
      AND previous.document_type = NEW.document_type
      AND coalesce(previous.fulfillment_id, 0) = coalesce(NEW.fulfillment_id, 0)
      AND coalesce(previous.refund_id, 0) = coalesce(NEW.refund_id, 0)
      AND previous.status = 'superseded'
      AND previous.document_version + 1 = NEW.document_version
  );
END;

CREATE TRIGGER order_document_artifact_guard
BEFORE INSERT ON order_document_artifacts
BEGIN
  SELECT RAISE(ABORT, 'document_artifact_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM order_documents d
    WHERE d.id = NEW.document_id AND d.source = 'generated'
      AND d.content_sha256 = NEW.content_sha256
  );
END;
