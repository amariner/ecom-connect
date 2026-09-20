/**
 * Cómo se le cuenta a un comprador el estado de su pedido. Traduce el estado
 * interno a una frase suya; no decide nada del pedido ni habla con la base.
 */
export type OrderTone = 'wait' | 'progress' | 'done' | 'cancelled';
export type OrderStatusView = { label: string; tone: OrderTone; help: string };

const STATUS_VIEWS: Record<string,OrderStatusView> = {
  pending: { label:'Pago pendiente', tone:'wait',
    help:'Todavía no hemos confirmado el pago simulado de este pedido.' },
  paid: { label:'En preparación', tone:'progress',
    help:'Hemos recibido tu pedido y lo estamos preparando para enviarlo.' },
  shipped: { label:'Enviado', tone:'progress',
    help:'Tu pedido ya ha salido. Puedes seguirlo con su número de seguimiento simulado.' },
  delivered: { label:'Entregado', tone:'done',
    help:'La entrega simulada de este pedido está completada.' },
  cancelled: { label:'Cancelado', tone:'cancelled',
    help:'Este pedido está cancelado. En una tienda real, el importe se devolvería a tu forma de pago.' },
};
export const statusView = (status: string): OrderStatusView =>
  STATUS_VIEWS[status] ?? { label:status, tone:'wait', help:'' };

/** Etapas visibles del recorrido. Un pedido cancelado no las recorre. */
export const ORDER_STAGES = [
  { id:'paid', label:'Confirmado' },
  { id:'shipped', label:'Enviado' },
  { id:'delivered', label:'Entregado' },
] as const;
export function stageIndex(status: string): number {
  const index = ORDER_STAGES.findIndex((stage) => stage.id === status);
  return status === 'pending' ? -1 : index;
}

/** El núcleo guarda `datetime('now')` en UTC y sin zona: se completa antes de leerla. */
export function orderDate(value: string, withTime = false): string {
  const normalized = value.includes('T') ? value : `${value.replace(' ','T')}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('es-ES',{ day:'numeric', month:'long', year:'numeric',
    ...(withTime ? { hour:'2-digit', minute:'2-digit' } : {}) });
}

/** Las notas del panel están escritas para la trastienda; el cliente lee las suyas. */
export function eventTitle(status: string): string {
  const views: Record<string,string> = {
    pending:'Pedido recibido', paid:'Pago confirmado', shipped:'Pedido enviado',
    delivered:'Pedido entregado', cancelled:'Pedido cancelado',
  };
  return views[status] ?? status;
}

export const CANCELLATION_REASON_LABELS: Record<string,string> = {
  customer_request:'A petición tuya', out_of_stock:'Sin disponibilidad',
  duplicate:'Pedido duplicado', other:'Otro motivo',
};
