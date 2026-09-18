import type {
  GeneratedOrderDocumentType,
  OrderDocumentStatus,
  OrderDocumentType,
} from '../domain/order-document';

export type OrderDocumentTemplateRecord = Readonly<{
  id: string;
  template_key: string;
  document_type: GeneratedOrderDocumentType;
  version: number;
  renderer: 'packing-slip-v1' | 'internal-label-v1';
  config_json: string;
  active: number;
  created_at: string;
}>;

export type OrderDocumentRecord = Readonly<{
  id: string;
  document_number: string;
  order_id: number;
  order_number: string;
  document_type: OrderDocumentType;
  source: 'generated' | 'external';
  template_id: string | null;
  template_key: string | null;
  template_version: number | null;
  fulfillment_id: number | null;
  carrier: string | null;
  tracking_number: string | null;
  refund_id: number | null;
  document_version: number;
  lifecycle_version: number;
  status: OrderDocumentStatus;
  expected_amount_cents: number | null;
  currency: string | null;
  external_provider: string | null;
  external_reference: string | null;
  external_url: string | null;
  snapshot_json: string;
  content_sha256: string;
  idempotency_key: string;
  supersedes_id: string | null;
  void_reason: string | null;
  issued_at: string;
  voided_at: string | null;
  created_at: string;
  updated_at: string;
  has_artifact: number;
}>;

export type OrderDocumentEventRecord = Readonly<{
  id: number;
  document_id: string;
  transition: 'created' | 'superseded' | 'voided';
  from_status: string | null;
  to_status: OrderDocumentStatus;
  lifecycle_version_after: number;
  actor_kind: string;
  actor_id: string;
  detail_json: string;
  occurred_at: string;
}>;

export type OrderDocumentDetail = Readonly<{
  document: OrderDocumentRecord;
  events: readonly OrderDocumentEventRecord[];
}>;

export type OrderDocumentOrderData = Readonly<{
  id: number;
  order_number: string;
  email: string;
  customer_name: string;
  address_json: string;
  total_cents: number;
  currency: string;
  status: string;
}>;

export type OrderDocumentFulfillmentData = Readonly<{
  id: number;
  order_id: number;
  status: string;
  carrier: string | null;
  tracking_number: string | null;
}>;

export type OrderDocumentLineData = Readonly<{
  order_item_id: number;
  sku: string;
  name: string;
  quantity: number;
}>;

export type OrderDocumentRefundData = Readonly<{
  id: number;
  order_id: number;
  status: string;
  total_cents: number;
}>;

export type GeneratedDocumentContext = Readonly<{
  order: OrderDocumentOrderData | null;
  fulfillment: OrderDocumentFulfillmentData | null;
  template: OrderDocumentTemplateRecord | null;
  lines: readonly OrderDocumentLineData[];
  previous: OrderDocumentRecord | null;
}>;

export type ExternalDocumentContext = Readonly<{
  order: OrderDocumentOrderData | null;
  refund: OrderDocumentRefundData | null;
  previous: OrderDocumentRecord | null;
}>;

export type OrderDocumentAdminOptions = Readonly<{
  orders: readonly Readonly<{ id: number; order_number: string; status: string }>[];
  fulfillments: readonly Readonly<{
    id: number; order_id: number; order_number: string; status: string;
    carrier: string | null; tracking_number: string | null;
  }>[];
  refunds: readonly Readonly<{
    id: number; order_id: number; order_number: string; total_cents: number;
  }>[];
  templates: readonly OrderDocumentTemplateRecord[];
}>;

const SELECT_DOCUMENT = `SELECT d.*, o.order_number, t.template_key,
  t.version AS template_version, f.carrier, f.tracking_number,
  CASE WHEN a.document_id IS NULL THEN 0 ELSE 1 END AS has_artifact
  FROM order_documents d JOIN orders o ON o.id=d.order_id
  LEFT JOIN order_document_templates t ON t.id=d.template_id
  LEFT JOIN fulfillments f ON f.id=d.fulfillment_id
  LEFT JOIN order_document_artifacts a ON a.document_id=d.id`;

export function createD1OrderDocuments(db: D1Database) {
  async function previous(
    orderId: number,
    type: OrderDocumentType,
    fulfillmentId: number | null,
    refundId: number | null,
  ): Promise<OrderDocumentRecord | null> {
    return db.prepare(`${SELECT_DOCUMENT} WHERE d.order_id=? AND d.document_type=?
      AND coalesce(d.fulfillment_id, 0)=coalesce(?, 0)
      AND coalesce(d.refund_id, 0)=coalesce(?, 0) AND d.status='active'`)
      .bind(orderId, type, fulfillmentId, refundId).first<OrderDocumentRecord>();
  }

  return Object.freeze({
    async list(orderId?: number): Promise<readonly OrderDocumentRecord[]> {
      const filter = orderId === undefined ? '' : 'WHERE d.order_id=?';
      const statement = db.prepare(`${SELECT_DOCUMENT} ${filter}
        ORDER BY d.issued_at DESC, d.id DESC LIMIT 300`);
      const { results } = orderId === undefined
        ? await statement.all<OrderDocumentRecord>()
        : await statement.bind(orderId).all<OrderDocumentRecord>();
      return Object.freeze(results.map((row) => Object.freeze(row)));
    },

    async find(id: string): Promise<OrderDocumentDetail | null> {
      const document = await db.prepare(`${SELECT_DOCUMENT} WHERE d.id=?`)
        .bind(id).first<OrderDocumentRecord>();
      if (!document) return null;
      const { results } = await db.prepare(`SELECT * FROM order_document_events
        WHERE document_id=? ORDER BY lifecycle_version_after, id`)
        .bind(id).all<OrderDocumentEventRecord>();
      return Object.freeze({
        document: Object.freeze(document),
        events: Object.freeze(results.map((row) => Object.freeze(row))),
      });
    },

    async findByIssueKey(key: string): Promise<OrderDocumentDetail | null> {
      const id = await db.prepare('SELECT id FROM order_documents WHERE idempotency_key=?')
        .bind(key).first<string>('id');
      return typeof id === 'string' ? this.find(id) : null;
    },

    async findByVoidKey(key: string): Promise<OrderDocumentDetail | null> {
      const id = await db.prepare('SELECT id FROM order_documents WHERE void_idempotency_key=?')
        .bind(key).first<string>('id');
      return typeof id === 'string' ? this.find(id) : null;
    },

    async artifact(id: string): Promise<Readonly<{
      content_type: 'text/html'; content_text: string; content_sha256: string; byte_size: number;
    }> | null> {
      return db.prepare(`SELECT content_type, content_text, content_sha256, byte_size
        FROM order_document_artifacts WHERE document_id=?`).bind(id).first();
    },

    async generatedContext(input: Readonly<{
      orderId: number; fulfillmentId: number; templateId: string; type: GeneratedOrderDocumentType;
    }>): Promise<GeneratedDocumentContext> {
      const [order, fulfillment, template, lineRows, active] = await Promise.all([
        db.prepare(`SELECT id, order_number, email, customer_name, address_json,
          total_cents, currency, status FROM orders WHERE id=?`)
          .bind(input.orderId).first<OrderDocumentOrderData>(),
        db.prepare(`SELECT id, order_id, status, carrier, tracking_number
          FROM fulfillments WHERE id=?`).bind(input.fulfillmentId).first<OrderDocumentFulfillmentData>(),
        db.prepare('SELECT * FROM order_document_templates WHERE id=?')
          .bind(input.templateId).first<OrderDocumentTemplateRecord>(),
        db.prepare(`SELECT oi.id AS order_item_id,
          COALESCE(exact.sku, fallback.sku, 'SIN-SKU') AS sku,
          oi.name_snapshot AS name, fi.quantity
          FROM fulfillment_items fi
          JOIN order_items oi ON oi.id=fi.order_item_id
          LEFT JOIN product_variants exact ON exact.id=oi.variant_id
          LEFT JOIN product_variants fallback ON fallback.product_id=oi.product_id AND fallback.is_default=1
          WHERE fi.fulfillment_id=? ORDER BY oi.id`)
          .bind(input.fulfillmentId).all<OrderDocumentLineData>(),
        previous(input.orderId, input.type, input.fulfillmentId, null),
      ]);
      return Object.freeze({
        order, fulfillment, template,
        lines: Object.freeze(lineRows.results.map((row) => Object.freeze(row))),
        previous: active,
      });
    },

    async externalContext(input: Readonly<{
      orderId: number; type: 'external_invoice' | 'external_credit_note'; refundId: number | null;
    }>): Promise<ExternalDocumentContext> {
      const [order, refund, active] = await Promise.all([
        db.prepare(`SELECT id, order_number, email, customer_name, address_json,
          total_cents, currency, status FROM orders WHERE id=?`)
          .bind(input.orderId).first<OrderDocumentOrderData>(),
        input.refundId === null ? Promise.resolve(null) : db.prepare(`SELECT id, order_id, status, total_cents
          FROM refunds WHERE id=?`).bind(input.refundId).first<OrderDocumentRefundData>(),
        previous(input.orderId, input.type, null, input.refundId),
      ]);
      return Object.freeze({ order, refund, previous: active });
    },

    async adminOptions(): Promise<OrderDocumentAdminOptions> {
      const [orders, fulfillments, refunds, templates] = await Promise.all([
        db.prepare(`SELECT id, order_number, status FROM orders
          WHERE status IN ('paid','shipped','delivered') ORDER BY updated_at DESC, id DESC LIMIT 200`)
          .all<{ id: number; order_number: string; status: string }>(),
        db.prepare(`SELECT f.id, f.order_id, o.order_number, f.status, f.carrier, f.tracking_number
          FROM fulfillments f JOIN orders o ON o.id=f.order_id WHERE f.status <> 'cancelled'
          ORDER BY f.updated_at DESC, f.id DESC LIMIT 300`)
          .all<{ id: number; order_id: number; order_number: string; status: string; carrier: string | null; tracking_number: string | null }>(),
        db.prepare(`SELECT r.id, r.order_id, o.order_number, r.total_cents
          FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.status='succeeded'
          ORDER BY r.updated_at DESC, r.id DESC LIMIT 200`)
          .all<{ id: number; order_id: number; order_number: string; total_cents: number }>(),
        db.prepare(`SELECT * FROM order_document_templates WHERE active=1
          ORDER BY document_type, version DESC, id`).all<OrderDocumentTemplateRecord>(),
      ]);
      return Object.freeze({
        orders: Object.freeze(orders.results.map((row) => Object.freeze(row))),
        fulfillments: Object.freeze(fulfillments.results.map((row) => Object.freeze(row))),
        refunds: Object.freeze(refunds.results.map((row) => Object.freeze(row))),
        templates: Object.freeze(templates.results.map((row) => Object.freeze(row))),
      });
    },
  });
}

export type D1OrderDocuments = ReturnType<typeof createD1OrderDocuments>;
