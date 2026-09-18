export const PRELIMINARY_ORDER_STATUSES = [
  'draft',
  'issued',
  'approved',
  'converted',
  'expired',
  'cancelled',
] as const;

export const PRELIMINARY_ORDER_PAYMENT_STATUSES = [
  'unpaid',
  'deposit_paid',
  'paid',
] as const;

export const PRELIMINARY_ORDER_CONVERSION_GATES = [
  'approval',
  'deposit',
  'full_payment',
] as const;

export const PRELIMINARY_ORDER_PAYMENT_STAGES = ['deposit', 'balance', 'full'] as const;

export type PreliminaryOrderStatus = (typeof PRELIMINARY_ORDER_STATUSES)[number];
export type PreliminaryOrderPaymentStatus =
  (typeof PRELIMINARY_ORDER_PAYMENT_STATUSES)[number];
export type PreliminaryOrderConversionGate =
  (typeof PRELIMINARY_ORDER_CONVERSION_GATES)[number];
export type PreliminaryOrderPaymentStage =
  (typeof PRELIMINARY_ORDER_PAYMENT_STAGES)[number];

export type PreliminaryOrder = Readonly<{
  id: string;
  status: PreliminaryOrderStatus;
  paymentStatus: PreliminaryOrderPaymentStatus;
  currency: string;
  totalCents: number;
  depositCents: number;
  paidCents: number;
  conversionGate: PreliminaryOrderConversionGate;
  expiresAt: string;
  version: number;
  issuedAt: string | null;
  approvedAt: string | null;
  convertedOrderId: number | null;
  convertedAt: string | null;
}>;

export type PreliminaryOrderDraft = Readonly<{
  id: string;
  currency: string;
  totalCents: number;
  depositCents: number;
  conversionGate: PreliminaryOrderConversionGate;
  expiresAt: string;
}>;

export type PreliminaryOrderPaymentPlan = Readonly<{
  stage: PreliminaryOrderPaymentStage;
  amountCents: number;
  currency: string;
  preliminaryOrderVersion: number;
}>;

export type ConfirmedPreliminaryOrderPayment = Readonly<{
  confirmed: true;
  stage: PreliminaryOrderPaymentStage;
  amountCents: number;
  currency: string;
  paidAt: string;
  expectedVersion: number;
}>;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const TOKEN_PATTERN = /^[a-z0-9](?:[a-z0-9:_-]{0,198}[a-z0-9])?$/;

function assertInteger(value: number, field: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${field} debe ser un entero seguro entre ${minimum} y ${maximum}.`);
  }
}

function assertToken(value: string, field: string): void {
  if (!TOKEN_PATTERN.test(value)) throw new RangeError(`${field} inválido.`);
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.endsWith('Z')) {
    throw new RangeError(`${field} debe ser una fecha ISO-8601 UTC.`);
  }
  return parsed;
}

function expectedPaymentStatus(order: PreliminaryOrder): PreliminaryOrderPaymentStatus {
  if (order.paidCents === 0) return 'unpaid';
  if (order.paidCents === order.totalCents) return 'paid';
  if (
    order.depositCents > 0 &&
    order.depositCents < order.totalCents &&
    order.paidCents === order.depositCents
  ) return 'deposit_paid';
  throw new RangeError('paidCents no coincide con el depósito o el total congelados.');
}

export function assertPreliminaryOrder(order: PreliminaryOrder): void {
  assertToken(order.id, 'preliminaryOrder.id');
  if (!PRELIMINARY_ORDER_STATUSES.includes(order.status)) {
    throw new RangeError('preliminaryOrder.status inválido.');
  }
  if (!PRELIMINARY_ORDER_PAYMENT_STATUSES.includes(order.paymentStatus)) {
    throw new RangeError('preliminaryOrder.paymentStatus inválido.');
  }
  if (!PRELIMINARY_ORDER_CONVERSION_GATES.includes(order.conversionGate)) {
    throw new RangeError('preliminaryOrder.conversionGate inválido.');
  }
  if (!CURRENCY_PATTERN.test(order.currency)) {
    throw new RangeError('preliminaryOrder.currency debe ser ISO 4217 en mayúsculas.');
  }
  assertInteger(order.totalCents, 'preliminaryOrder.totalCents', 1, 1_000_000_000);
  assertInteger(order.depositCents, 'preliminaryOrder.depositCents', 0, order.totalCents);
  assertInteger(order.paidCents, 'preliminaryOrder.paidCents', 0, order.totalCents);
  assertInteger(order.version, 'preliminaryOrder.version', 1, 1_000_000_000);
  timestamp(order.expiresAt, 'preliminaryOrder.expiresAt');

  if (order.conversionGate === 'deposit' && order.depositCents === 0) {
    throw new RangeError('La conversión por depósito exige un importe de depósito explícito.');
  }
  if (expectedPaymentStatus(order) !== order.paymentStatus) {
    throw new RangeError('paymentStatus no coincide con paidCents.');
  }

  const issuedAt = order.issuedAt === null
    ? null
    : timestamp(order.issuedAt, 'preliminaryOrder.issuedAt');
  const approvedAt = order.approvedAt === null
    ? null
    : timestamp(order.approvedAt, 'preliminaryOrder.approvedAt');
  const convertedAt = order.convertedAt === null
    ? null
    : timestamp(order.convertedAt, 'preliminaryOrder.convertedAt');

  if (approvedAt !== null && (issuedAt === null || approvedAt < issuedAt)) {
    throw new RangeError('La aprobación debe ser posterior a la emisión.');
  }
  if (convertedAt !== null && (approvedAt === null || convertedAt < approvedAt)) {
    throw new RangeError('La conversión debe ser posterior a la aprobación.');
  }

  if (order.status === 'draft' && (issuedAt !== null || approvedAt !== null)) {
    throw new RangeError('Un borrador no puede estar emitido o aprobado.');
  }
  if (order.status === 'issued' && (issuedAt === null || approvedAt !== null)) {
    throw new RangeError('Un presupuesto emitido exige issuedAt y no puede estar aprobado.');
  }
  if (order.status === 'approved' && (issuedAt === null || approvedAt === null)) {
    throw new RangeError('Un presupuesto aprobado exige emisión y aprobación.');
  }
  if (order.status === 'converted') {
    if (
      issuedAt === null || approvedAt === null || convertedAt === null ||
      order.convertedOrderId === null
    ) throw new RangeError('Un presupuesto convertido exige pedido e hitos completos.');
    assertInteger(order.convertedOrderId, 'preliminaryOrder.convertedOrderId', 1, 2_147_483_647);
  } else if (order.convertedOrderId !== null || convertedAt !== null) {
    throw new RangeError('Solo un presupuesto convertido puede enlazar un pedido.');
  }

  if (
    !['approved', 'converted'].includes(order.status) &&
    order.paidCents !== 0
  ) throw new RangeError('No se puede cobrar antes de aprobar el presupuesto.');
}

export function createPreliminaryOrderDraft(input: PreliminaryOrderDraft): PreliminaryOrder {
  const draft: PreliminaryOrder = Object.freeze({
    ...input,
    status: 'draft',
    paymentStatus: 'unpaid',
    paidCents: 0,
    version: 1,
    issuedAt: null,
    approvedAt: null,
    convertedOrderId: null,
    convertedAt: null,
  });
  assertPreliminaryOrder(draft);
  return draft;
}

function freezeValid(order: PreliminaryOrder): PreliminaryOrder {
  assertPreliminaryOrder(order);
  return Object.freeze(order);
}

function assertBeforeExpiry(order: PreliminaryOrder, at: string): void {
  if (timestamp(at, 'at') >= timestamp(order.expiresAt, 'preliminaryOrder.expiresAt')) {
    throw new RangeError('El presupuesto ha caducado.');
  }
}

export function issuePreliminaryOrder(order: PreliminaryOrder, at: string): PreliminaryOrder {
  assertPreliminaryOrder(order);
  if (order.status !== 'draft') throw new RangeError('Solo un borrador puede emitirse.');
  assertBeforeExpiry(order, at);
  return freezeValid({ ...order, status: 'issued', issuedAt: at, version: order.version + 1 });
}

export function approvePreliminaryOrder(order: PreliminaryOrder, at: string): PreliminaryOrder {
  assertPreliminaryOrder(order);
  if (order.status !== 'issued') throw new RangeError('Solo un presupuesto emitido puede aprobarse.');
  assertBeforeExpiry(order, at);
  if (order.issuedAt === null || timestamp(at, 'at') < timestamp(order.issuedAt, 'issuedAt')) {
    throw new RangeError('La aprobación no puede preceder a la emisión.');
  }
  return freezeValid({ ...order, status: 'approved', approvedAt: at, version: order.version + 1 });
}

export function expirePreliminaryOrder(order: PreliminaryOrder, at: string): PreliminaryOrder {
  assertPreliminaryOrder(order);
  if (order.status !== 'draft' && order.status !== 'issued') {
    throw new RangeError('Solo un presupuesto no aprobado puede caducar.');
  }
  if (timestamp(at, 'at') < timestamp(order.expiresAt, 'preliminaryOrder.expiresAt')) {
    throw new RangeError('El presupuesto todavía no ha alcanzado su caducidad.');
  }
  return freezeValid({ ...order, status: 'expired', version: order.version + 1 });
}

export function cancelPreliminaryOrder(order: PreliminaryOrder): PreliminaryOrder {
  assertPreliminaryOrder(order);
  if (!['draft', 'issued', 'approved'].includes(order.status)) {
    throw new RangeError('El presupuesto no admite cancelación desde su estado actual.');
  }
  if (order.paidCents !== 0) {
    throw new RangeError('Un presupuesto cobrado requiere conciliación o reembolso explícito.');
  }
  return freezeValid({ ...order, status: 'cancelled', version: order.version + 1 });
}

export function nextPreliminaryOrderPayment(
  order: PreliminaryOrder,
): PreliminaryOrderPaymentPlan | null {
  assertPreliminaryOrder(order);
  if (order.status !== 'approved' && order.status !== 'converted') {
    throw new RangeError('El presupuesto debe estar aprobado antes de solicitar un pago.');
  }
  if (order.paymentStatus === 'paid') return null;

  if (order.paymentStatus === 'deposit_paid') {
    return Object.freeze({
      stage: 'balance',
      amountCents: order.totalCents - order.paidCents,
      currency: order.currency,
      preliminaryOrderVersion: order.version,
    });
  }

  const hasPartialDeposit = order.depositCents > 0 && order.depositCents < order.totalCents;
  return Object.freeze({
    stage: hasPartialDeposit ? 'deposit' : 'full',
    amountCents: hasPartialDeposit ? order.depositCents : order.totalCents,
    currency: order.currency,
    preliminaryOrderVersion: order.version,
  });
}

export function applyConfirmedPreliminaryOrderPayment(
  order: PreliminaryOrder,
  payment: ConfirmedPreliminaryOrderPayment,
): PreliminaryOrder {
  assertPreliminaryOrder(order);
  if (!payment.confirmed) throw new RangeError('El pago no está confirmado por la aplicación.');
  const paidAt = timestamp(payment.paidAt, 'payment.paidAt');
  if (
    order.approvedAt !== null &&
    paidAt < timestamp(order.approvedAt, 'preliminaryOrder.approvedAt')
  ) throw new RangeError('El pago no puede preceder a la aprobación.');
  if (payment.expectedVersion !== order.version) {
    throw new RangeError('La versión del presupuesto ha cambiado.');
  }
  const expected = nextPreliminaryOrderPayment(order);
  if (expected === null) throw new RangeError('El presupuesto ya está completamente pagado.');
  if (
    payment.stage !== expected.stage ||
    payment.amountCents !== expected.amountCents ||
    payment.currency !== expected.currency
  ) throw new RangeError('El pago no coincide con la etapa e importe decididos por el servidor.');

  const paidCents = order.paidCents + payment.amountCents;
  return freezeValid({
    ...order,
    paidCents,
    paymentStatus: paidCents === order.totalCents ? 'paid' : 'deposit_paid',
    version: order.version + 1,
  });
}

export function convertPreliminaryOrder(
  order: PreliminaryOrder,
  input: Readonly<{ orderId: number; convertedAt: string }>,
): PreliminaryOrder {
  assertPreliminaryOrder(order);
  if (order.status !== 'approved') {
    throw new RangeError('Solo un presupuesto aprobado puede convertirse en pedido.');
  }
  assertInteger(input.orderId, 'orderId', 1, 2_147_483_647);
  const convertedAt = timestamp(input.convertedAt, 'convertedAt');
  if (
    order.approvedAt === null ||
    convertedAt < timestamp(order.approvedAt, 'preliminaryOrder.approvedAt')
  ) throw new RangeError('La conversión no puede preceder a la aprobación.');
  const gateSatisfied =
    order.conversionGate === 'approval' ||
    (order.conversionGate === 'deposit' && order.paidCents >= order.depositCents) ||
    (order.conversionGate === 'full_payment' && order.paidCents === order.totalCents);
  if (!gateSatisfied) throw new RangeError('La condición de conversión congelada no se ha cumplido.');
  return freezeValid({
    ...order,
    status: 'converted',
    convertedOrderId: input.orderId,
    convertedAt: input.convertedAt,
    version: order.version + 1,
  });
}
