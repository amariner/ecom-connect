/**
 * Catálogo de eventos de pedido (R1.5). Es el primer productor real del sobre
 * de `shared-kernel`.
 *
 * Lo que hoy escribe una fila en `order_events` pasa a ser un hecho de dominio
 * con sobre. La fila del timeline queda como **proyección** del hecho
 * (`orderTimelineEntry`), no como el hecho en sí: el comportamiento observable
 * —los mismos `from_status`, `to_status` y nota de siempre— no cambia, pero el
 * dominio ya no depende de cómo se guarde ni de a quién avise.
 *
 * El payload NO lleva datos personales (ver `shared-kernel/events.ts`): quien
 * necesite nombre, email o líneas del pedido los pide a `orders`.
 *
 * Extensiones `.ts` explícitas en los imports relativos: este módulo entra en la
 * cadena del seed, que corre con `node seed/generate.ts` (ESM con type-stripping).
 */

import {
  createEventFromIdentity,
  type EmitEvent,
  type EventActor,
  type EventDraft,
  type EventEnvelope,
  type EventIdentity,
} from '../../../shared-kernel/events.ts';
import type { OrderStatus } from '../../../lib/order-transitions.ts';
import type {
  OrderHoldReasonCode,
  OrderHoldResolutionCode,
  OrderHoldSource,
} from './order-hold.ts';

/** Versión del contrato de payload de todos los eventos de pedido. */
export const ORDER_EVENT_VERSION = 1;

export const ORDER_EVENT_TYPES = [
  'orders.order_placed',
  'orders.order_paid',
  'orders.order_shipped',
  'orders.order_delivered',
  'orders.order_cancelled',
  'orders.order_refunded',
  'orders.order_partially_refunded',
  'orders.order_amendment_requested',
  'orders.order_amendment_applied',
  'orders.order_amendment_expired',
  'orders.order_hold_created',
  'orders.order_hold_assigned',
  'orders.order_hold_resolved',
] as const;

export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

/** Cómo se confirmó el cobro: pasarela real o el modo simulado sin claves. */
export type OrderPaymentSource = 'stripe' | 'simulated';

/** Por qué se cancela. Decide la nota del timeline y, mañana, la política. */
export type OrderCancellationReason = 'payment_session_expired' | 'admin';

export type OrderTracking = Readonly<{ carrier: string; number: string }>;

type OrderEventSubject = Readonly<{ order_id: number; order_number: string }>;

export type OrderPlacedPayload = OrderEventSubject & Readonly<{ from_status: null; to_status: 'pending' }>;
export type OrderPaidPayload = OrderEventSubject &
  Readonly<{
    from_status: 'pending';
    to_status: 'paid';
    payment_intent: string | null;
    source: OrderPaymentSource;
  }>;
export type OrderShippedPayload = OrderEventSubject &
  Readonly<{ from_status: OrderStatus; to_status: 'shipped'; tracking: OrderTracking }>;
export type OrderDeliveredPayload = OrderEventSubject &
  Readonly<{ from_status: OrderStatus; to_status: 'delivered' }>;
export type OrderCancelledPayload = OrderEventSubject &
  Readonly<{ from_status: OrderStatus; to_status: 'cancelled'; reason: OrderCancellationReason }>;
export type OrderRefundedPayload = OrderEventSubject &
  Readonly<{
    from_status: 'paid';
    to_status: 'cancelled';
    total_cents: number;
    currency: string;
    restock: boolean;
  }>;
export type OrderPartiallyRefundedPayload = OrderEventSubject &
  Readonly<{
    from_status: 'paid';
    to_status: OrderStatus;
    refund_id: number;
    subtotal_cents: number;
    shipping_cents: number;
    total_cents: number;
    currency: string;
    restock: boolean;
    allocations: readonly Readonly<{ order_item_id: number; quantity: number }>[];
    remaining_quantity: number;
  }>;
export type OrderAmendmentPayload = OrderEventSubject & Readonly<{
  from_status: 'paid';
  to_status: 'paid';
  amendment_id: string;
  delta_cents: number;
  currency: string;
  changed_line_count: number;
  address_changed: boolean;
}>;
export type OrderHoldCreatedPayload = OrderEventSubject & Readonly<{
  hold_id: string;
  source: OrderHoldSource;
  reason_code: OrderHoldReasonCode;
  due_at: string;
  hold_version: number;
}>;
export type OrderHoldAssignedPayload = OrderEventSubject & Readonly<{
  hold_id: string;
  hold_version: number;
}>;
export type OrderHoldResolvedPayload = OrderEventSubject & Readonly<{
  hold_id: string;
  resolution_code: OrderHoldResolutionCode;
  hold_version: number;
}>;

export type OrderPlacedEvent = EventEnvelope<'orders.order_placed', OrderPlacedPayload>;
export type OrderPaidEvent = EventEnvelope<'orders.order_paid', OrderPaidPayload>;
export type OrderShippedEvent = EventEnvelope<'orders.order_shipped', OrderShippedPayload>;
export type OrderDeliveredEvent = EventEnvelope<'orders.order_delivered', OrderDeliveredPayload>;
export type OrderCancelledEvent = EventEnvelope<'orders.order_cancelled', OrderCancelledPayload>;
export type OrderRefundedEvent = EventEnvelope<'orders.order_refunded', OrderRefundedPayload>;
export type OrderPartiallyRefundedEvent = EventEnvelope<
  'orders.order_partially_refunded',
  OrderPartiallyRefundedPayload
>;
export type OrderAmendmentRequestedEvent = EventEnvelope<
  'orders.order_amendment_requested', OrderAmendmentPayload
>;
export type OrderAmendmentAppliedEvent = EventEnvelope<
  'orders.order_amendment_applied', OrderAmendmentPayload
>;
export type OrderAmendmentExpiredEvent = EventEnvelope<
  'orders.order_amendment_expired', OrderAmendmentPayload
>;
export type OrderHoldCreatedEvent = EventEnvelope<'orders.order_hold_created', OrderHoldCreatedPayload>;
export type OrderHoldAssignedEvent = EventEnvelope<'orders.order_hold_assigned', OrderHoldAssignedPayload>;
export type OrderHoldResolvedEvent = EventEnvelope<'orders.order_hold_resolved', OrderHoldResolvedPayload>;
export type OrderHoldEvent = OrderHoldCreatedEvent | OrderHoldAssignedEvent | OrderHoldResolvedEvent;

export type OrderDomainEvent =
  | OrderPlacedEvent
  | OrderPaidEvent
  | OrderShippedEvent
  | OrderDeliveredEvent
  | OrderCancelledEvent
  | OrderRefundedEvent
  | OrderPartiallyRefundedEvent
  | OrderAmendmentRequestedEvent
  | OrderAmendmentAppliedEvent
  | OrderAmendmentExpiredEvent;

/** Origen del hecho. El actor identifica el canal, nunca a la persona. */
export const ORDER_ACTORS = {
  customer: { kind: 'customer', id: 'guest-checkout', label: 'Comprador invitado' },
  stripe: { kind: 'provider', id: 'stripe', label: 'Stripe' },
  simulated: { kind: 'system', id: 'simulated-payment', label: 'Pago simulado' },
  holdPolicy: { kind: 'system', id: 'order-hold-policy', label: 'Política de incidencias' },
  admin: { kind: 'admin', id: 'admin-panel', label: 'Panel de pedidos' },
} as const satisfies Record<string, EventActor>;

/**
 * Un pedido es un flujo: todos sus hechos comparten correlación, así que el
 * timeline, los emails y (desde R1.9) los logs se pueden reconstruir por pedido
 * aunque los provoquen actores distintos con horas de diferencia.
 */
export function orderCorrelationId(orderNumber: string): string {
  return `order:${orderNumber}`;
}

/**
 * La clave de idempotencia es el hecho, no la entrega: dos webhooks del mismo
 * cobro producen la misma clave y un consumidor puede descartar el segundo.
 */
function orderIdempotencyKey(orderNumber: string, type: OrderEventType, suffix?: string): string {
  const base = `${orderCorrelationId(orderNumber)}:${type.slice('orders.'.length)}`;
  return suffix ? `${base}:${suffix}` : base;
}

type EmitOptions = Readonly<{ causationId?: string | null; idempotencySuffix?: string }>;

function draftFor<TType extends OrderEventType, TPayload extends OrderEventSubject>(
  type: TType,
  actor: EventActor,
  payload: TPayload,
  options: EmitOptions,
): EventDraft<TType, TPayload> {
  return {
    type,
    version: ORDER_EVENT_VERSION,
    actor,
    entity: { type: 'order', id: String(payload.order_id), reference: payload.order_number },
    idempotency_key: orderIdempotencyKey(payload.order_number, type, options.idempotencySuffix),
    correlation_id: orderCorrelationId(payload.order_number),
    causation_id: options.causationId ?? null,
    payload,
  };
}

export function orderPlacedEvent(
  emit: EmitEvent,
  subject: OrderEventSubject,
  options: EmitOptions = {},
): OrderPlacedEvent {
  const payload: OrderPlacedPayload = { ...subject, from_status: null, to_status: 'pending' };
  return emit(draftFor('orders.order_placed', ORDER_ACTORS.customer, payload, options));
}

/** Completa el alta con la identidad reservada antes de que D1 asigne `order_id`. */
export function orderPlacedEventFromIdentity(
  identity: EventIdentity,
  subject: OrderEventSubject,
): OrderPlacedEvent {
  const payload: OrderPlacedPayload = { ...subject, from_status: null, to_status: 'pending' };
  return createEventFromIdentity(identity, draftFor('orders.order_placed', ORDER_ACTORS.customer, payload, {}));
}

export function orderPaidEvent(
  emit: EmitEvent,
  input: OrderEventSubject & Readonly<{ payment_intent: string | null; source: OrderPaymentSource }>,
  options: EmitOptions = {},
): OrderPaidEvent {
  const payload: OrderPaidPayload = {
    order_id: input.order_id,
    order_number: input.order_number,
    from_status: 'pending',
    to_status: 'paid',
    payment_intent: input.payment_intent,
    source: input.source,
  };
  const actor = input.source === 'stripe' ? ORDER_ACTORS.stripe : ORDER_ACTORS.simulated;
  return emit(draftFor('orders.order_paid', actor, payload, options));
}

export function orderShippedEvent(
  emit: EmitEvent,
  input: OrderEventSubject & Readonly<{ from_status: OrderStatus; tracking: OrderTracking }>,
  options: EmitOptions = {},
): OrderShippedEvent {
  const payload: OrderShippedPayload = {
    order_id: input.order_id,
    order_number: input.order_number,
    from_status: input.from_status,
    to_status: 'shipped',
    tracking: input.tracking,
  };
  return emit(draftFor('orders.order_shipped', ORDER_ACTORS.admin, payload, options));
}

export function orderDeliveredEvent(
  emit: EmitEvent,
  input: OrderEventSubject & Readonly<{ from_status: OrderStatus }>,
  options: EmitOptions = {},
): OrderDeliveredEvent {
  const payload: OrderDeliveredPayload = {
    order_id: input.order_id,
    order_number: input.order_number,
    from_status: input.from_status,
    to_status: 'delivered',
  };
  return emit(draftFor('orders.order_delivered', ORDER_ACTORS.admin, payload, options));
}

export function orderCancelledEvent(
  emit: EmitEvent,
  input: OrderEventSubject & Readonly<{ from_status: OrderStatus; reason: OrderCancellationReason }>,
  options: EmitOptions = {},
): OrderCancelledEvent {
  const payload: OrderCancelledPayload = {
    order_id: input.order_id,
    order_number: input.order_number,
    from_status: input.from_status,
    to_status: 'cancelled',
    reason: input.reason,
  };
  const actor = input.reason === 'payment_session_expired' ? ORDER_ACTORS.stripe : ORDER_ACTORS.admin;
  return emit(draftFor('orders.order_cancelled', actor, payload, options));
}

export function orderRefundedEvent(
  emit: EmitEvent,
  input: OrderEventSubject & Readonly<{
    total_cents: number;
    currency: string;
    restock: boolean;
  }>,
  options: EmitOptions = {},
): OrderRefundedEvent {
  const payload: OrderRefundedPayload = {
    order_id: input.order_id,
    order_number: input.order_number,
    from_status: 'paid',
    to_status: 'cancelled',
    total_cents: input.total_cents,
    currency: input.currency,
    restock: input.restock,
  };
  return emit(draftFor('orders.order_refunded', ORDER_ACTORS.admin, payload, options));
}

export function orderPartiallyRefundedEvent(
  emit: EmitEvent,
  input: OrderEventSubject & Readonly<{
    to_status: OrderStatus;
    refund_id: number;
    subtotal_cents: number;
    shipping_cents: number;
    total_cents: number;
    currency: string;
    restock: boolean;
    allocations: readonly Readonly<{ order_item_id: number; quantity: number }>[];
    remaining_quantity: number;
  }>,
  options: EmitOptions = {},
): OrderPartiallyRefundedEvent {
  const payload: OrderPartiallyRefundedPayload = {
    order_id: input.order_id,
    order_number: input.order_number,
    from_status: 'paid',
    to_status: input.to_status,
    refund_id: input.refund_id,
    subtotal_cents: input.subtotal_cents,
    shipping_cents: input.shipping_cents,
    total_cents: input.total_cents,
    currency: input.currency,
    restock: input.restock,
    allocations: Object.freeze(input.allocations.map((line) => Object.freeze({ ...line }))),
    remaining_quantity: input.remaining_quantity,
  };
  return emit(draftFor('orders.order_partially_refunded', ORDER_ACTORS.admin, payload, {
    ...options,
    idempotencySuffix: String(input.refund_id),
  }));
}

type AmendmentEventInput = OrderEventSubject & Readonly<{
  amendment_id: string;
  delta_cents: number;
  currency: string;
  changed_line_count: number;
  address_changed: boolean;
}>;

function amendmentPayload(input: AmendmentEventInput): OrderAmendmentPayload {
  return Object.freeze({
    order_id: input.order_id,
    order_number: input.order_number,
    from_status: 'paid',
    to_status: 'paid',
    amendment_id: input.amendment_id,
    delta_cents: input.delta_cents,
    currency: input.currency,
    changed_line_count: input.changed_line_count,
    address_changed: input.address_changed,
  });
}

export function orderAmendmentRequestedEvent(
  emit: EmitEvent,
  input: AmendmentEventInput,
  options: EmitOptions = {},
): OrderAmendmentRequestedEvent {
  const payload = amendmentPayload(input);
  return emit(draftFor('orders.order_amendment_requested', ORDER_ACTORS.admin, payload, {
    ...options,
    idempotencySuffix: input.amendment_id,
  }));
}

export function orderAmendmentAppliedEvent(
  emit: EmitEvent,
  input: AmendmentEventInput,
  options: EmitOptions = {},
): OrderAmendmentAppliedEvent {
  const payload = amendmentPayload(input);
  return emit(draftFor('orders.order_amendment_applied', ORDER_ACTORS.admin, payload, {
    ...options,
    idempotencySuffix: input.amendment_id,
  }));
}

export function orderAmendmentExpiredEvent(
  emit: EmitEvent,
  input: AmendmentEventInput,
  options: EmitOptions = {},
): OrderAmendmentExpiredEvent {
  const payload = amendmentPayload(input);
  return emit(draftFor('orders.order_amendment_expired', ORDER_ACTORS.stripe, payload, {
    ...options,
    idempotencySuffix: input.amendment_id,
  }));
}

export function orderHoldCreatedEvent(
  emit: EmitEvent,
  input: OrderEventSubject & Readonly<{
    hold_id: string;
    source: OrderHoldSource;
    reason_code: OrderHoldReasonCode;
    due_at: string;
    hold_version: number;
  }>,
  options: EmitOptions = {},
): OrderHoldCreatedEvent {
  const payload: OrderHoldCreatedPayload = Object.freeze({
    order_id: input.order_id,
    order_number: input.order_number,
    hold_id: input.hold_id,
    source: input.source,
    reason_code: input.reason_code,
    due_at: input.due_at,
    hold_version: input.hold_version,
  });
  const actor = input.source === 'automatic' ? ORDER_ACTORS.holdPolicy : ORDER_ACTORS.admin;
  return emit(draftFor('orders.order_hold_created', actor, payload, {
    ...options,
    idempotencySuffix: input.hold_id,
  }));
}

export function orderHoldAssignedEvent(
  emit: EmitEvent,
  input: OrderEventSubject & Readonly<{ hold_id: string; hold_version: number }>,
  options: EmitOptions = {},
): OrderHoldAssignedEvent {
  const payload: OrderHoldAssignedPayload = Object.freeze({
    order_id: input.order_id,
    order_number: input.order_number,
    hold_id: input.hold_id,
    hold_version: input.hold_version,
  });
  return emit(draftFor('orders.order_hold_assigned', ORDER_ACTORS.admin, payload, {
    ...options,
    idempotencySuffix: `${input.hold_id}:${input.hold_version}`,
  }));
}

export function orderHoldResolvedEvent(
  emit: EmitEvent,
  input: OrderEventSubject & Readonly<{
    hold_id: string;
    resolution_code: OrderHoldResolutionCode;
    hold_version: number;
  }>,
  options: EmitOptions = {},
): OrderHoldResolvedEvent {
  const payload: OrderHoldResolvedPayload = Object.freeze({
    order_id: input.order_id,
    order_number: input.order_number,
    hold_id: input.hold_id,
    resolution_code: input.resolution_code,
    hold_version: input.hold_version,
  });
  return emit(draftFor('orders.order_hold_resolved', ORDER_ACTORS.admin, payload, {
    ...options,
    idempotencySuffix: `${input.hold_id}:${input.hold_version}`,
  }));
}

/** Entrada del timeline tal y como la guarda `order_events` desde la Fase 3. */
export type OrderTimelineEntry = Readonly<{
  from_status: string | null;
  to_status: string;
  note: string;
}>;

/**
 * Hecho mínimo del que se deriva la nota. Existe aparte del sobre porque el
 * seed de la demo fabrica timelines sin pasar por el motor y debe redactar
 * exactamente las mismas notas.
 */
export type OrderTimelineFact =
  | Readonly<{ to_status: 'pending' }>
  | Readonly<{ to_status: 'paid'; source: OrderPaymentSource }>
  | Readonly<{ to_status: 'shipped'; tracking: OrderTracking | null }>
  | Readonly<{ to_status: 'delivered' }>
  | Readonly<{ to_status: 'cancelled'; reason: OrderCancellationReason }>;

/** Única redacción de las notas del timeline en todo el proyecto. */
export function orderTimelineNote(fact: OrderTimelineFact): string {
  switch (fact.to_status) {
    case 'pending':
      return 'Pedido creado, esperando pago';
    case 'paid':
      return fact.source === 'stripe' ? 'Pago confirmado por Stripe' : 'Pago confirmado (simulado)';
    case 'shipped':
      return fact.tracking ? `Enviado con ${fact.tracking.carrier} (${fact.tracking.number})` : 'Enviado';
    case 'delivered':
      return 'Marcado como entregado';
    case 'cancelled':
      if (fact.reason === 'payment_session_expired') return 'Sesión de pago caducada';
      return 'Cancelado desde el panel';
  }
}

function timelineFactOf(
  event: Exclude<
    OrderDomainEvent,
    OrderRefundedEvent | OrderPartiallyRefundedEvent |
    OrderAmendmentRequestedEvent | OrderAmendmentAppliedEvent | OrderAmendmentExpiredEvent
  >,
): OrderTimelineFact {
  switch (event.type) {
    case 'orders.order_placed':
      return { to_status: 'pending' };
    case 'orders.order_paid':
      return { to_status: 'paid', source: event.payload.source };
    case 'orders.order_shipped':
      return { to_status: 'shipped', tracking: event.payload.tracking };
    case 'orders.order_delivered':
      return { to_status: 'delivered' };
    case 'orders.order_cancelled':
      return { to_status: 'cancelled', reason: event.payload.reason };
  }
}

/** Proyecta el hecho a la fila de `order_events`. Es presentación del hecho, no el hecho. */
export function orderTimelineEntry(event: OrderDomainEvent): OrderTimelineEntry {
  if (event.type === 'orders.order_refunded') {
    return Object.freeze({
      from_status: event.payload.from_status,
      to_status: event.payload.to_status,
      note: 'Reembolso total confirmado y pedido cancelado',
    });
  }
  if (event.type === 'orders.order_partially_refunded') {
    const quantity = event.payload.allocations.reduce((sum, line) => sum + line.quantity, 0);
    return Object.freeze({
      from_status: event.payload.from_status,
      to_status: event.payload.to_status,
      note: `Reembolso parcial confirmado: ${quantity} ${quantity === 1 ? 'unidad' : 'unidades'}`,
    });
  }
  if (event.type === 'orders.order_amendment_applied') {
    const direction = event.payload.delta_cents > 0
      ? 'cobro adicional'
      : event.payload.delta_cents < 0
        ? 'reembolso'
        : 'sin ajuste económico';
    return Object.freeze({
      from_status: 'paid',
      to_status: 'paid',
      note: `Pedido editado (${direction})`,
    });
  }
  if (event.type === 'orders.order_amendment_expired') {
    return Object.freeze({
      from_status: 'paid',
      to_status: 'paid',
      note: 'Edición caducada sin aplicar',
    });
  }
  if (event.type === 'orders.order_amendment_requested') {
    return Object.freeze({
      from_status: 'paid',
      to_status: 'paid',
      note: 'Edición pendiente de conciliación',
    });
  }
  return Object.freeze({
    from_status: event.payload.from_status,
    to_status: event.payload.to_status,
    note: orderTimelineNote(timelineFactOf(event)),
  });
}
