/**
 * Devoluciones pedidas por el comprador. Lógica PURA: decide quién puede pedir
 * qué y a qué estado puede pasar una solicitud. Las guardas de la base vuelven
 * a decidir dentro de la transacción; esto evita ofrecer lo que se rechazará.
 */

export const RETURN_REASONS = ['damaged','defective','wrong_item','not_as_expected','other'] as const;
export type ReturnReason = typeof RETURN_REASONS[number];
export const RETURN_STATUSES = ['requested','accepted','received','refunded','rejected','cancelled'] as const;
export type ReturnStatus = typeof RETURN_STATUSES[number];
/** Días naturales desde la entrega para pedir una devolución. */
export const RETURN_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
/** El núcleo guarda `datetime('now')` en UTC y sin zona: se completa antes de leerla. */
export function parseInstant(value: string): number {
  return Date.parse(value.includes('T') ? value : `${value.replace(' ','T')}Z`);
}

export type ReturnWindow =
  | { open: true; closes_at: string; days_left: number }
  | { open: false; reason: string };

/**
 * Si el comprador puede abrir una devolución de este pedido. Un pedido que no
 * consta entregado no la admite: la prueba de entrega es del comercio, no suya.
 */
export function decideReturnWindow(order: {
  status: string; delivered_at: string | null; now: string; open_return: boolean;
}): ReturnWindow {
  if (order.open_return) return { open: false, reason: 'Ya tienes una devolución en curso para este pedido. Puedes seguirla desde aquí.' };
  if (order.status === 'cancelled') return { open: false, reason: 'Este pedido está cancelado: no hay nada que devolver.' };
  if (order.status !== 'delivered' || !order.delivered_at) {
    return { open: false, reason: 'Podrás pedir la devolución cuando el pedido conste entregado.' };
  }
  const delivered = parseInstant(order.delivered_at);
  const now = parseInstant(order.now);
  if (!Number.isFinite(delivered) || !Number.isFinite(now)) {
    return { open: false, reason: 'No hemos podido comprobar la fecha de entrega de este pedido.' };
  }
  const closes = delivered + RETURN_WINDOW_DAYS * DAY_MS;
  if (now > closes) {
    return { open: false, reason: `El plazo de ${RETURN_WINDOW_DAYS} días desde la entrega ha terminado. Escríbenos y lo revisamos.` };
  }
  return { open: true, closes_at: new Date(closes).toISOString(), days_left: Math.max(0,Math.ceil((closes - now) / DAY_MS)) };
}

export type ReturnableLine = {
  order_item_id: number; name: string; unit_price_cents: number; purchased: number; claimed: number;
};
/** Unidades que todavía se pueden devolver de una línea. */
export const returnableQuantity = (line: Pick<ReturnableLine,'purchased'|'claimed'>): number =>
  Math.max(0,line.purchased - line.claimed);

export type ReturnRequestLine = { order_item_id: number; qty: number };
export type ReturnSelection =
  | { ok: true; lines: (ReturnRequestLine & { unit_price_cents: number })[]; refund_cents: number }
  | { ok: false; error: string };

/** Comprueba la selección del comprador contra lo que queda por devolver. */
export function decideReturnSelection(
  requested: readonly ReturnRequestLine[], returnable: readonly ReturnableLine[],
): ReturnSelection {
  if (!requested.length) return { ok: false, error: 'Elige al menos un artículo para devolver.' };
  const byItem = new Map(returnable.map((line) => [line.order_item_id,line]));
  const lines: (ReturnRequestLine & { unit_price_cents: number })[] = [];
  const seen = new Set<number>();
  for (const line of requested) {
    if (seen.has(line.order_item_id)) return { ok: false, error: 'Has elegido dos veces el mismo artículo.' };
    seen.add(line.order_item_id);
    const source = byItem.get(line.order_item_id);
    if (!source) return { ok: false, error: 'Uno de los artículos elegidos no pertenece a este pedido.' };
    const available = returnableQuantity(source);
    if (line.qty > available) {
      return { ok: false, error: available > 0
        ? `De ${source.name} solo puedes devolver ${available} ${available === 1 ? 'unidad' : 'unidades'}.`
        : `${source.name} ya está devuelto por completo.` };
    }
    lines.push({ ...line, unit_price_cents: source.unit_price_cents });
  }
  return { ok: true, lines, refund_cents: lines.reduce((sum,line) => sum + line.qty * line.unit_price_cents,0) };
}

export const RETURN_ACTIONS = ['accept','reject','receive','refund','cancel'] as const;
export type ReturnAction = typeof RETURN_ACTIONS[number];
export type ReturnTransition = { ok: true; to: ReturnStatus } | { ok: false; error: string };

const TRANSITIONS: Record<ReturnAction,{ from: readonly ReturnStatus[]; to: ReturnStatus; error: string }> = {
  accept: { from:['requested'], to:'accepted', error:'Solo se puede aceptar una devolución pendiente de revisar.' },
  reject: { from:['requested','accepted'], to:'rejected', error:'Esta devolución ya está cerrada.' },
  receive: { from:['accepted'], to:'received', error:'Acepta la devolución antes de registrar su recepción.' },
  refund: { from:['received'], to:'refunded', error:'Registra la recepción antes de reembolsar.' },
  cancel: { from:['requested'], to:'cancelled', error:'Ya estamos tramitando esta devolución: no se puede anular.' },
};

export function decideReturnTransition(from: string, action: ReturnAction): ReturnTransition {
  const transition = TRANSITIONS[action];
  return (transition.from as readonly string[]).includes(from)
    ? { ok: true, to: transition.to } : { ok: false, error: transition.error };
}

/** Lo que el comprador lee en cada estado. El panel usa sus propias etiquetas. */
export const RETURN_STATUS_HELP: Record<ReturnStatus,{ label: string; help: string }> = {
  requested: { label:'Pendiente de revisar', help:'Hemos recibido tu solicitud y la estamos revisando.' },
  accepted: { label:'Aceptada', help:'Puedes enviarnos los artículos. Te avisaríamos al recibirlos.' },
  received: { label:'Recibida', help:'Ya tenemos los artículos de vuelta. Falta registrar el reembolso simulado.' },
  refunded: { label:'Reembolsada', help:'En una tienda real, el importe estaría de vuelta en tu forma de pago.' },
  rejected: { label:'Rechazada', help:'No hemos podido aceptar esta devolución.' },
  cancelled: { label:'Anulada', help:'Anulaste esta solicitud antes de que empezáramos a tramitarla.' },
};
export const RETURN_REASON_LABELS: Record<ReturnReason,string> = {
  damaged:'Llegó dañado', defective:'No funciona como debería', wrong_item:'No es lo que pedí',
  not_as_expected:'No es lo que esperaba', other:'Otro motivo',
};
