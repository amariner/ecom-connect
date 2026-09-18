export const PAYMENT_PROVIDERS = ['stripe', 'simulated', 'legacy'] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_STATUSES = [
  'pending',
  'authorized',
  'captured',
  'partially_refunded',
  'refunded',
  'failed',
  'cancelled',
  'requires_review',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type PaymentLedgerEntry = Readonly<{
  id: number;
  order_id: number;
  provider: PaymentProvider;
  provider_reference: string | null;
  currency: string;
  expected_amount_cents: number;
  /** Parte del total comercial liquidada por tarjeta regalo/crédito. */
  stored_value_expected_cents?: number;
  status: PaymentStatus;
  version: number;
  refunded_cents: number;
  adjustment_refunded_cents?: number;
  cancellation_refunded_cents?: number;
}>;

export type RefundableCapture = Readonly<{
  transaction_id: number;
  payment_id: number;
  provider_reference: string;
  amount_cents: number;
  allocated_cents: number;
  occurred_at: string;
}>;

export type PlannedRefundCaptureAllocation = Readonly<{
  capture_transaction_id: number;
  amount_cents: number;
  payment_reference: string;
}>;

export type PaymentCaptureDraft = Readonly<{
  provider: Exclude<PaymentProvider, 'legacy'>;
  provider_reference: string;
  amount_cents: number;
  currency: string;
  idempotency_key: string;
  occurred_at: string;
}>;

export type PlannedPaymentCapture = PaymentCaptureDraft & Readonly<{
  status: 'captured';
  transaction_status: 'succeeded';
  version_after: number;
}>;

export const REFUND_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'cancelled',
  'requires_review',
] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export type RefundRestockDecision = 'none' | 'restock';
export const REFUND_OPERATION_TYPES = [
  'total_cancellation',
  'partial_cancellation',
  'return',
  'adjustment',
] as const;
export type RefundOperationType = (typeof REFUND_OPERATION_TYPES)[number];
export type PartialRefundShippingPolicy =
  | 'merchandise-only'
  | 'full-on-final-cancellation';

export type RefundLedgerEntry = Readonly<{
  id: number;
  order_id: number;
  payment_id: number;
  status: RefundStatus;
  reason: string;
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  provider_reference: string | null;
  idempotency_key: string;
  version: number;
  restock_decision: RefundRestockDecision;
  operation_type: RefundOperationType;
  amendment_id?: string | null;
}>;

export type TotalRefundLine = Readonly<{
  order_item_id: number;
  quantity: number;
  amount_cents: number;
}>;

export type PlannedTotalRefund = Readonly<{
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  lines: readonly TotalRefundLine[];
  restock_decision: RefundRestockDecision;
}>;

export type PartialRefundRequestLine = Readonly<{
  order_item_id: number;
  quantity: number;
}>;

export type PartialRefundLineSnapshot = Readonly<{
  order_item_id: number;
  unit_price_cents: number;
  ordered_quantity: number;
  fulfilled_quantity: number;
  cancelled_quantity: number;
}>;

export type PlannedPartialRefund = Readonly<{
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  lines: readonly TotalRefundLine[];
  restock_decision: RefundRestockDecision;
  remaining_quantity: number;
  payment_status_after: 'partially_refunded' | 'refunded';
}>;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} debe ser un entero seguro >= 1.`);
  }
}

function assertMoney(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} debe ser un entero seguro >= 0.`);
  }
}

function assertText(value: string, field: string, max: number): void {
  const length = value.trim().length;
  if (length < 1 || length > max) {
    throw new RangeError(`${field} debe medir entre 1 y ${max}.`);
  }
}

export function assertPaymentCurrency(currency: string): void {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new RangeError('currency debe ser un código ISO 4217 de tres letras mayúsculas.');
  }
}

/**
 * Planea una captura contra la intención persistida. El importe y la moneda
 * proceden del pedido; el hecho del proveedor solo aporta su referencia.
 */
export function planPaymentCapture(
  payment: PaymentLedgerEntry,
  draft: PaymentCaptureDraft,
): PlannedPaymentCapture {
  assertPositiveInteger(payment.id, 'payment.id');
  assertPositiveInteger(payment.order_id, 'payment.order_id');
  assertPositiveInteger(payment.version, 'payment.version');
  assertMoney(payment.expected_amount_cents, 'payment.expected_amount_cents');
  assertMoney(payment.refunded_cents, 'payment.refunded_cents');
  assertMoney(draft.amount_cents, 'amount_cents');
  assertPaymentCurrency(payment.currency);
  assertPaymentCurrency(draft.currency);
  assertText(draft.provider_reference, 'provider_reference', 200);
  assertText(draft.idempotency_key, 'idempotency_key', 200);
  if (!TIMESTAMP_PATTERN.test(draft.occurred_at)) {
    throw new RangeError('occurred_at debe ser ISO-8601 UTC con milisegundos.');
  }
  if (payment.status !== 'pending') throw new RangeError('solo un pago pending se puede capturar.');
  if (payment.provider !== draft.provider) throw new RangeError('el proveedor no coincide con la intención.');
  if (payment.currency !== draft.currency) throw new RangeError('la moneda no coincide con la intención.');
  if (payment.expected_amount_cents !== draft.amount_cents) {
    throw new RangeError('el importe capturado no coincide con el total decidido por el servidor.');
  }
  return Object.freeze({
    ...draft,
    status: 'captured',
    transaction_status: 'succeeded',
    version_after: payment.version + 1,
  });
}

export function paymentSettlementCents(payment: PaymentLedgerEntry): number {
  assertMoney(payment.expected_amount_cents, 'payment.expected_amount_cents');
  assertMoney(payment.stored_value_expected_cents ?? 0, 'payment.stored_value_expected_cents');
  const total = payment.expected_amount_cents + (payment.stored_value_expected_cents ?? 0);
  assertMoney(total, 'payment.settlement_cents');
  return total;
}

/** Congela el reembolso total desde snapshots servidor; stock y dinero son decisiones separadas. */
export function planTotalRefund(
  payment: PaymentLedgerEntry,
  order: Readonly<{ subtotal_cents: number; shipping_cents: number; total_cents: number }>,
  lines: readonly TotalRefundLine[],
  restockDecision: RefundRestockDecision,
): PlannedTotalRefund {
  if (payment.status !== 'captured' && payment.status !== 'partially_refunded') {
    throw new RangeError('solo un pago capturado se puede reembolsar por completo.');
  }
  if ((payment.cancellation_refunded_cents ?? 0) !== 0) {
    throw new RangeError('un pago con cancelaciones previas ya no admite reembolso total.');
  }
  assertMoney(order.subtotal_cents, 'order.subtotal_cents');
  assertMoney(order.shipping_cents, 'order.shipping_cents');
  assertMoney(order.total_cents, 'order.total_cents');
  if (order.total_cents !== order.subtotal_cents + order.shipping_cents) {
    throw new RangeError('el total del pedido no coincide con subtotal y envío.');
  }
  if (paymentSettlementCents(payment) - (payment.adjustment_refunded_cents ?? 0) !== order.total_cents) {
    throw new RangeError('el importe del pago no coincide con el pedido.');
  }
  if (lines.length < 1) throw new RangeError('el reembolso total necesita al menos una línea.');
  let subtotal = 0;
  for (const line of lines) {
    assertPositiveInteger(line.order_item_id, 'line.order_item_id');
    assertPositiveInteger(line.quantity, 'line.quantity');
    assertMoney(line.amount_cents, 'line.amount_cents');
    subtotal += line.amount_cents;
  }
  if (!Number.isSafeInteger(subtotal) || subtotal !== order.subtotal_cents) {
    throw new RangeError('las líneas del reembolso no suman el subtotal del pedido.');
  }
  if (restockDecision !== 'none' && restockDecision !== 'restock') {
    throw new RangeError('decisión de reposición inválida.');
  }
  return Object.freeze({
    subtotal_cents: order.subtotal_cents,
    shipping_cents: order.shipping_cents,
    total_cents: order.total_cents,
    lines: Object.freeze(lines.map((line) => Object.freeze({ ...line }))),
    restock_decision: restockDecision,
  });
}

/**
 * Calcula un parcial exclusivamente desde snapshots servidor. El navegador
 * selecciona ids/cantidades; precio, envío, saldo y estado salen del ledger.
 */
export function planPartialRefund(
  payment: PaymentLedgerEntry,
  order: Readonly<{ subtotal_cents: number; shipping_cents: number; total_cents: number }>,
  lines: readonly PartialRefundLineSnapshot[],
  requested: readonly PartialRefundRequestLine[],
  restockDecision: RefundRestockDecision,
  shippingPolicy: PartialRefundShippingPolicy,
): PlannedPartialRefund {
  if (payment.status !== 'captured' && payment.status !== 'partially_refunded') {
    throw new RangeError('solo un pago capturado admite cancelaciones parciales.');
  }
  assertMoney(payment.expected_amount_cents, 'payment.expected_amount_cents');
  assertMoney(payment.refunded_cents, 'payment.refunded_cents');
  assertMoney(order.subtotal_cents, 'order.subtotal_cents');
  assertMoney(order.shipping_cents, 'order.shipping_cents');
  assertMoney(order.total_cents, 'order.total_cents');
  if (order.total_cents !== order.subtotal_cents + order.shipping_cents ||
      paymentSettlementCents(payment) - (payment.adjustment_refunded_cents ?? 0) !== order.total_cents) {
    throw new RangeError('el pago y el total del pedido no coinciden.');
  }
  if (requested.length < 1) throw new RangeError('selecciona al menos una línea para cancelar.');
  if (restockDecision !== 'none' && restockDecision !== 'restock') {
    throw new RangeError('decisión de reposición inválida.');
  }
  if (shippingPolicy !== 'merchandise-only' &&
      shippingPolicy !== 'full-on-final-cancellation') {
    throw new RangeError('política de envío parcial inválida.');
  }

  const snapshots = new Map<number, PartialRefundLineSnapshot>();
  let outstandingQuantity = 0;
  let fulfilledQuantity = 0;
  for (const line of lines) {
    assertPositiveInteger(line.order_item_id, 'line.order_item_id');
    assertMoney(line.unit_price_cents, 'line.unit_price_cents');
    assertPositiveInteger(line.ordered_quantity, 'line.ordered_quantity');
    assertMoney(line.fulfilled_quantity, 'line.fulfilled_quantity');
    assertMoney(line.cancelled_quantity, 'line.cancelled_quantity');
    if (snapshots.has(line.order_item_id)) throw new RangeError('order_item_id no puede repetirse.');
    if (line.fulfilled_quantity + line.cancelled_quantity > line.ordered_quantity) {
      throw new RangeError('el saldo de la línea supera la cantidad comprada.');
    }
    snapshots.set(line.order_item_id, line);
    outstandingQuantity += line.ordered_quantity - line.fulfilled_quantity - line.cancelled_quantity;
    fulfilledQuantity += line.fulfilled_quantity;
  }

  const seen = new Set<number>();
  const plannedLines: TotalRefundLine[] = [];
  let selectedQuantity = 0;
  let subtotal = 0;
  for (const selection of requested) {
    assertPositiveInteger(selection.order_item_id, 'selection.order_item_id');
    assertPositiveInteger(selection.quantity, 'selection.quantity');
    if (seen.has(selection.order_item_id)) throw new RangeError('order_item_id no puede repetirse.');
    seen.add(selection.order_item_id);
    const snapshot = snapshots.get(selection.order_item_id);
    if (!snapshot) throw new RangeError('la línea no pertenece al pedido.');
    const available = snapshot.ordered_quantity -
      snapshot.fulfilled_quantity - snapshot.cancelled_quantity;
    if (selection.quantity > available) {
      throw new RangeError('quantity supera las unidades cancelables de la línea.');
    }
    const amount = snapshot.unit_price_cents * selection.quantity;
    assertMoney(amount, 'line.amount_cents');
    subtotal += amount;
    selectedQuantity += selection.quantity;
    assertMoney(subtotal, 'subtotal_cents');
    plannedLines.push(Object.freeze({
      order_item_id: selection.order_item_id,
      quantity: selection.quantity,
      amount_cents: amount,
    }));
  }

  const shipping = shippingPolicy === 'full-on-final-cancellation' &&
    fulfilledQuantity === 0 && selectedQuantity === outstandingQuantity
    ? order.shipping_cents
    : 0;
  const total = subtotal + shipping;
  assertMoney(total, 'total_cents');
  const refundedAfter = payment.refunded_cents + total;
  assertMoney(refundedAfter, 'refunded_after_cents');
  const settlementCents = paymentSettlementCents(payment);
  if (refundedAfter > settlementCents) {
    throw new RangeError('el reembolso acumulado supera la captura.');
  }
  return Object.freeze({
    subtotal_cents: subtotal,
    shipping_cents: shipping,
    total_cents: total,
    lines: Object.freeze(plannedLines),
    restock_decision: restockDecision,
    remaining_quantity: outstandingQuantity - selectedQuantity,
    payment_status_after: refundedAfter === settlementCents
      ? 'refunded'
      : 'partially_refunded',
  });
}

/** Reserva importe sobre capturas concretas, empezando por la más reciente. */
export function planRefundCaptureAllocations(
  captures: readonly RefundableCapture[],
  amountCents: number,
): readonly PlannedRefundCaptureAllocation[] {
  assertPositiveInteger(amountCents, 'amount_cents');
  let remaining = amountCents;
  const planned: PlannedRefundCaptureAllocation[] = [];
  const ordered = [...captures].sort((a, b) =>
    b.occurred_at.localeCompare(a.occurred_at) || b.transaction_id - a.transaction_id);
  for (const capture of ordered) {
    assertPositiveInteger(capture.transaction_id, 'capture.transaction_id');
    assertPositiveInteger(capture.payment_id, 'capture.payment_id');
    assertMoney(capture.amount_cents, 'capture.amount_cents');
    assertMoney(capture.allocated_cents, 'capture.allocated_cents');
    assertText(capture.provider_reference, 'capture.provider_reference', 200);
    if (capture.allocated_cents > capture.amount_cents) {
      throw new RangeError('una captura tiene más importe asignado que cobrado.');
    }
    const available = capture.amount_cents - capture.allocated_cents;
    if (available <= 0) continue;
    const allocated = Math.min(available, remaining);
    planned.push(Object.freeze({
      capture_transaction_id: capture.transaction_id,
      amount_cents: allocated,
      payment_reference: capture.provider_reference,
    }));
    remaining -= allocated;
    if (remaining === 0) break;
  }
  if (remaining !== 0) throw new RangeError('saldo capturado insuficiente para el reembolso.');
  return Object.freeze(planned);
}
