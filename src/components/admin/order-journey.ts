export type JourneySource = {
  order: {
    channel: string;
    status: string;
    supplier_status: string;
    supplier_order_id?: string | null;
    tracking_number?: string | null;
    tracking_carrier?: string | null;
  };
  marketplace_warning?: string;
  marketplace_sync: {
    supplier_status: string;
    tracking_number: string | null;
    tracking_carrier: string | null;
  } | null;
};

export function hasCurrentMarketplaceAcknowledgement(data: JourneySource) {
  const sync = data.marketplace_sync;
  return Boolean(sync && !data.marketplace_warning
    && sync.supplier_status === data.order.supplier_status
    && (sync.tracking_number ?? '') === (data.order.tracking_number ?? '')
    && (sync.tracking_carrier ?? '') === (data.order.tracking_carrier ?? ''));
}
export function createOrderJourney(data: JourneySource, options: { dispatchMode: 'immediate' | 'grouped'; channelName: string }) {
  const { order } = data;
  const cancelled = order.status === 'cancelled';
  const paid = ['paid', 'shipped', 'delivered'].includes(order.status);
  const accepted = Boolean(order.supplier_order_id);
  const shipped = paid && accepted && order.supplier_status === 'SUPPLIER_SHIPPED' && Boolean(order.tracking_number);
  const hasMarketplace = order.channel !== 'WEB';
  const acknowledged = hasCurrentMarketplaceAcknowledgement(data);
  const returned = shipped && acknowledged;
  const supplierError = order.supplier_status === 'ERROR';
  const partial = order.supplier_status === 'SUPPLIER_PARTIAL';
  const steps = [
    { title: 'Venta confirmada', complete: paid, detail: paid ? 'Pago simulado registrado' : order.status === 'cancelled' ? 'Pedido cancelado' : 'Pago simulado pendiente' },
    { title: 'Proveedor acepta', complete: accepted, detail: accepted ? `Referencia demo ${order.supplier_order_id}` : supplierError ? 'El envío necesita un reintento' : 'Pendiente de enviar al proveedor' },
    { title: 'Envío y tracking', complete: shipped, detail: shipped ? order.tracking_number! : supplierError && accepted ? 'Incidencia de proveedor por resolver' : partial ? 'Envío parcial · falta completar la expedición' : order.supplier_status === 'SUPPLIER_SHIPPED' ? 'Tracking pendiente de recuperar' : accepted ? 'Preparación y expedición pendientes' : 'Disponible tras la aceptación' },
    ...(hasMarketplace ? [{ title: 'Retorno al canal', complete: returned, detail: returned ? `Seguimiento registrado · ${options.channelName} demo` : shipped ? 'Pendiente de conciliar el seguimiento simulado' : acknowledged ? 'Estado simulado registrado · seguimiento pendiente' : 'Confirmación simulada del canal pendiente' }] : []),
  ];
  const firstPending = steps.findIndex(step => !step.complete);
  const current = firstPending < 0 ? steps.length - 1 : firstPending;
  let next = '';
  let href = '#supplier-management';
  let actionLabel = 'Gestionar proveedor';
  if (!paid) {
    next = order.status === 'cancelled' ? 'Este pedido está cancelado. Puedes consultar los cambios en su historial.' : 'El pago simulado no está confirmado. El envío al proveedor permanece bloqueado; consulta el historial del pedido.';
    href = '#order-history'; actionLabel = 'Ver historial';
  } else if (!accepted) {
    next = supplierError ? 'Revisa el stock del proveedor y reintenta el envío con la misma referencia de pedido.' : options.dispatchMode === 'grouped' ? 'El pedido espera el envío agrupado. Puedes enviarlo ahora desde Gestión del proveedor.' : 'Envía este pedido al proveedor simulado para continuar su preparación.';
    actionLabel = supplierError ? 'Revisar y reintentar' : 'Ir al envío del proveedor';
  } else if (!shipped) {
    next = supplierError ? 'La aceptación está registrada, pero hay una incidencia posterior. Simula la recuperación del proveedor desde su gestión.' : partial ? 'El envío sigue siendo parcial. Simula «Enviado + tracking» cuando quieras completar la expedición.' : order.supplier_status === 'SUPPLIER_SHIPPED' ? 'La expedición figura como enviada, pero aún falta el número de seguimiento. Revisa la última actualización del proveedor.' : 'Simula la preparación o selecciona «Enviado + tracking» para completar la expedición.';
  } else if (hasMarketplace && !returned) {
    next = `El seguimiento simulado ya está disponible. Concilia la sincronización para actualizar la confirmación de ${options.channelName} demo.`;
    href = '#marketplace-return'; actionLabel = 'Conciliar retorno al canal';
  } else {
    next = hasMarketplace ? `El proveedor simulado ha generado el seguimiento. La confirmación de ${options.channelName} demo está registrada en Ecom Connect.` : 'El envío simulado y su seguimiento están registrados para FarmaHouse. El recorrido de demostración de este pedido web está completo.';
    href = hasMarketplace ? '#marketplace-return' : '#order-history'; actionLabel = hasMarketplace ? 'Ver confirmación del canal' : 'Ver historial';
  }
  return { steps, current, complete: firstPending < 0, requiresAttention: supplierError, cancelled, next, href, actionLabel };
}
