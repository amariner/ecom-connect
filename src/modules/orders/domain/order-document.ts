export const GENERATED_ORDER_DOCUMENT_TYPES = ['packing_slip', 'internal_label'] as const;
export const EXTERNAL_ORDER_DOCUMENT_TYPES = ['external_invoice', 'external_credit_note'] as const;
export const ORDER_DOCUMENT_TYPES = [
  ...GENERATED_ORDER_DOCUMENT_TYPES,
  ...EXTERNAL_ORDER_DOCUMENT_TYPES,
] as const;

export type GeneratedOrderDocumentType = (typeof GENERATED_ORDER_DOCUMENT_TYPES)[number];
export type ExternalOrderDocumentType = (typeof EXTERNAL_ORDER_DOCUMENT_TYPES)[number];
export type OrderDocumentType = (typeof ORDER_DOCUMENT_TYPES)[number];
export type OrderDocumentStatus = 'active' | 'superseded' | 'voided';

export type OrderDocumentOrderContext = Readonly<{
  id: number;
  orderNumber: string;
  status: string;
  totalCents: number;
  currency: string;
}>;

export type OrderDocumentFulfillmentContext = Readonly<{
  id: number;
  orderId: number;
  status: string;
}>;

export type OrderDocumentRefundContext = Readonly<{
  id: number;
  orderId: number;
  status: string;
  totalCents: number;
}>;

export type OrderDocumentTemplateContext = Readonly<{
  id: string;
  documentType: GeneratedOrderDocumentType;
  version: number;
  renderer: 'packing-slip-v1' | 'internal-label-v1';
  active: boolean;
}>;

export type ExistingOrderDocument = Readonly<{
  id: string;
  documentVersion: number;
  status: OrderDocumentStatus;
}>;

export type GeneratedOrderDocumentDraft = Readonly<{
  documentType: GeneratedOrderDocumentType;
  order: OrderDocumentOrderContext;
  fulfillment: OrderDocumentFulfillmentContext | null;
  template: OrderDocumentTemplateContext | null;
  previous: ExistingOrderDocument | null;
  idempotencyKey: string;
}>;

export type ExternalOrderDocumentDraft = Readonly<{
  documentType: ExternalOrderDocumentType;
  order: OrderDocumentOrderContext;
  refund: OrderDocumentRefundContext | null;
  previous: ExistingOrderDocument | null;
  provider: string;
  externalReference: string;
  documentNumber: string;
  externalUrl?: string;
  idempotencyKey: string;
}>;

export type PlannedGeneratedOrderDocument = Readonly<{
  source: 'generated';
  documentType: GeneratedOrderDocumentType;
  documentVersion: number;
  supersedesId: string | null;
  documentNumber: string;
  template: OrderDocumentTemplateContext;
  fulfillment: OrderDocumentFulfillmentContext;
}>;

export type PlannedExternalOrderDocument = Readonly<{
  source: 'external';
  documentType: ExternalOrderDocumentType;
  documentVersion: number;
  supersedesId: string | null;
  documentNumber: string;
  expectedAmountCents: number;
  currency: string;
  provider: string;
  externalReference: string;
  externalUrl: string | null;
  refundId: number | null;
}>;

function assertKey(value: string): void {
  if (value.trim() !== value || value.length < 8 || value.length > 200) {
    throw new RangeError('Idempotency key inválida.');
  }
}

function normalizedToken(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > max) throw new RangeError(`${label} inválido.`);
  return normalized;
}

function nextVersion(previous: ExistingOrderDocument | null): Readonly<{
  documentVersion: number;
  supersedesId: string | null;
}> {
  if (!previous) return { documentVersion: 1, supersedesId: null };
  if (previous.status !== 'active') throw new Error('El documento anterior ya no está activo.');
  return { documentVersion: previous.documentVersion + 1, supersedesId: previous.id };
}

function generatedNumber(
  type: GeneratedOrderDocumentType,
  orderNumber: string,
  fulfillmentId: number,
  version: number,
): string {
  const prefix = type === 'packing_slip' ? 'ALB' : 'ETQ';
  return `${prefix}-${orderNumber}-${fulfillmentId}-V${version}`;
}

export function planGeneratedOrderDocument(
  draft: GeneratedOrderDocumentDraft,
): PlannedGeneratedOrderDocument {
  assertKey(draft.idempotencyKey);
  if (!draft.fulfillment || draft.fulfillment.orderId !== draft.order.id) {
    throw new Error('El envío no pertenece al pedido.');
  }
  if (draft.fulfillment.status === 'cancelled') throw new Error('El envío está cancelado.');
  if (!draft.template || !draft.template.active || draft.template.documentType !== draft.documentType) {
    throw new Error('La plantilla no está activa para este documento.');
  }
  const version = nextVersion(draft.previous);
  return Object.freeze({
    source: 'generated',
    documentType: draft.documentType,
    ...version,
    documentNumber: generatedNumber(
      draft.documentType,
      draft.order.orderNumber,
      draft.fulfillment.id,
      version.documentVersion,
    ),
    template: draft.template,
    fulfillment: draft.fulfillment,
  });
}

export function planExternalOrderDocument(
  draft: ExternalOrderDocumentDraft,
): PlannedExternalOrderDocument {
  assertKey(draft.idempotencyKey);
  const provider = normalizedToken(draft.provider, 'Proveedor', 80);
  const externalReference = normalizedToken(draft.externalReference, 'Referencia externa', 120);
  const documentNumber = normalizedToken(draft.documentNumber, 'Número de documento', 120);
  if (draft.externalUrl !== undefined && !draft.externalUrl.startsWith('https://')) {
    throw new Error('La URL externa debe usar HTTPS.');
  }
  if (!['paid', 'shipped', 'delivered'].includes(draft.order.status)) {
    throw new Error('El pedido todavía no admite un documento fiscal externo.');
  }
  const version = nextVersion(draft.previous);
  if (draft.documentType === 'external_invoice') {
    if (draft.refund) throw new Error('La factura externa no puede apuntar a un reembolso.');
    return Object.freeze({
      source: 'external', documentType: draft.documentType, ...version,
      documentNumber, expectedAmountCents: draft.order.totalCents,
      currency: draft.order.currency.toUpperCase(), provider, externalReference,
      externalUrl: draft.externalUrl ?? null, refundId: null,
    });
  }
  if (!draft.refund || draft.refund.orderId !== draft.order.id || draft.refund.status !== 'succeeded') {
    throw new Error('La rectificativa exige un reembolso confirmado del mismo pedido.');
  }
  return Object.freeze({
    source: 'external', documentType: draft.documentType, ...version,
    documentNumber, expectedAmountCents: draft.refund.totalCents,
    currency: draft.order.currency.toUpperCase(), provider, externalReference,
    externalUrl: draft.externalUrl ?? null, refundId: draft.refund.id,
  });
}

export function assertOrderDocumentVoid(status: OrderDocumentStatus, expectedVersion: number): void {
  if (status !== 'active') throw new Error('Solo un documento activo puede anularse.');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new RangeError('Versión inválida.');
}
