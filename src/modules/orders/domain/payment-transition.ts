/**
 * Lógica PURA de la transición de pago (webhook y pago simulado). Sin I/O:
 * decide qué mutar y **emite el hecho**; quien lo persiste o lo notifica es
 * otro (adaptador D1 y consumidores del evento).
 *
 * R1.5 le quitó la construcción de emails: el pedido ya no sabe qué se avisa ni
 * a quién — solo declara que se ha cobrado.
 */

import type { EmitEvent } from '../../../shared-kernel/events.ts';
import { orderPaidEvent, type OrderPaidEvent, type OrderPaymentSource } from './order-events.ts';

export type OrderForPayment = {
  id: number;
  order_number: string;
  status: string;
  email: string;
  customer_name: string;
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  currency: string;
};

export type OrderItemForPayment = {
  order_item_id: number;
  product_id: number;
  variant_id: number;
  is_default: boolean;
  name_snapshot: string;
  unit_price_cents: number;
  qty: number;
};

export type PaidMutation = {
  orderId: number;
  paymentIntent: string | null;
  /** Movimientos por variante; inventario valida saldo y versión. */
  stockDecrements: { product_id: number; variant_id: number; is_default: boolean; qty: number }[];
  /** El hecho de dominio. La fila de `order_events` es su proyección. */
  event: OrderPaidEvent;
};

export type PaidMutationContext = Readonly<{
  emit: EmitEvent;
  source: OrderPaymentSource;
  /** Id del hecho que lo provoca: evento de Stripe o sobre del pedido creado. */
  causationId?: string | null;
}>;

/**
 * Devuelve la mutación a aplicar, o null si no hay nada que hacer.
 * Idempotencia (CLAUDE.md §7.3): pedido inexistente o ya procesado → null
 * (el webhook responde 200 igualmente; Stripe reintenta si no).
 */
export function buildPaidMutation(
  order: OrderForPayment | null,
  items: readonly OrderItemForPayment[],
  paymentIntent: string | null,
  context: PaidMutationContext,
): PaidMutation | null {
  if (order === null) return null;
  if (order.status !== 'pending') return null;

  return {
    orderId: order.id,
    paymentIntent,
    stockDecrements: items.map((item) => ({
      product_id: item.product_id,
      variant_id: item.variant_id,
      is_default: item.is_default,
      qty: item.qty,
    })),
    event: orderPaidEvent(
      context.emit,
      {
        order_id: order.id,
        order_number: order.order_number,
        payment_intent: paymentIntent,
        source: context.source,
      },
      { causationId: context.causationId ?? null },
    ),
  };
}

/** Stock resultante tras un decremento: nunca negativo. */
export function stockAfterDecrement(currentStock: number, qty: number): number {
  return Math.max(currentStock - qty, 0);
}
