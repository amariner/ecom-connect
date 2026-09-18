/**
 * Transiciones de estado de pedidos desde el panel. Lógica PURA y testeada;
 * el endpoint PATCH aplica el resultado en D1.
 */

export const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Transiciones que puede hacer el comercio a mano desde el panel. */
const ALLOWED: Record<OrderStatus, OrderStatus[]> = {
  pending: ['cancelled'], // el paso a paid lo hace SOLO el webhook
  paid: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export type TransitionRequest = {
  to: OrderStatus;
  tracking_carrier?: string | undefined;
  tracking_number?: string | undefined;
};

/**
 * Estados a los que el panel SÍ puede llevar un pedido. `pending` es el estado
 * de nacimiento y `paid` lo marca únicamente la pasarela: ninguno de los dos es
 * un destino manual, y el tipo lo hace explícito para quien construya el hecho.
 */
export const PANEL_TRANSITION_TARGETS = ['shipped', 'delivered', 'cancelled'] as const;
export type PanelTransitionTarget = (typeof PANEL_TRANSITION_TARGETS)[number];

function isPanelTarget(status: OrderStatus): status is PanelTransitionTarget {
  return (PANEL_TRANSITION_TARGETS as readonly string[]).includes(status);
}

/**
 * La decisión NO redacta la nota del timeline ni decide qué email sale: ambas
 * cosas se derivan del hecho de dominio que emite el panel (R1.5,
 * `modules/orders/domain/order-events.ts` y el consumidor de notificaciones).
 * Aquí solo vive lo que es política de pedido: si la transición es legal, qué
 * datos exige y qué pasa con el stock.
 */
/**
 * Transición ya validada. Es una unión correlacionada a propósito: solo el
 * destino `shipped` lleva tracking, así que quien construya el hecho no puede
 * olvidarlo ni inventárselo para los demás destinos.
 */
export type PanelTransition =
  | { to: 'shipped'; tracking: { carrier: string; number: string }; restoreStock: false }
  | { to: 'delivered'; tracking: null; restoreStock: false }
  | { to: 'cancelled'; tracking: null; restoreStock: boolean };

export type TransitionDecision = ({ ok: true } & PanelTransition) | { ok: false; error: string };

export function decideTransition(from: OrderStatus, req: TransitionRequest): TransitionDecision {
  // `ALLOWED` ya excluye pending y paid como destino; la segunda comprobación
  // lo hace verdad para el compilador, no solo en tiempo de ejecución.
  if (!ALLOWED[from].includes(req.to) || !isPanelTarget(req.to)) {
    return { ok: false, error: `No se puede pasar de «${from}» a «${req.to}»` };
  }
  if (req.to === 'shipped') {
    if (!req.tracking_carrier?.trim() || !req.tracking_number?.trim()) {
      return { ok: false, error: 'Para marcar enviado hacen falta transportista y nº de seguimiento' };
    }
    return {
      ok: true,
      to: req.to,
      tracking: { carrier: req.tracking_carrier.trim(), number: req.tracking_number.trim() },
      restoreStock: false,
    };
  }
  if (req.to === 'delivered') return { ok: true, to: 'delivered', tracking: null, restoreStock: false };
  // El stock solo se decrementó al pasar a 'paid' (webhook): cancelar un pedido
  // pagado debe devolverlo. Cancelar desde 'pending' no toca stock (nunca se descontó).
  return { ok: true, to: 'cancelled', tracking: null, restoreStock: from === 'paid' };
}
