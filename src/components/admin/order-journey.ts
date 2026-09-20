export type JourneySource = {
  order: {
    channel: string;
    status: string;
    supplier_status: string;
    supplier_dispatch_mode?: 'immediate' | 'grouped' | null;
    supplier_order_id?: string | null;
    tracking_number?: string | null;
    tracking_carrier?: string | null;
  };
  marketplace_warning?: string;
  fulfillment?: {
    lines: { ordered: number; shipped: number }[];
    shipments: { marketplace_synced_at: string | null }[];
  };
  cancellation?: { marketplace_synced_at: string | null; cancelled_at?: string | null } | null;
  marketplace_sync: {
    supplier_status: string;
    tracking_number: string | null;
    tracking_carrier: string | null;
  } | null;
};

export function orderDispatchPolicy(order: Pick<JourneySource['order'], 'supplier_dispatch_mode'>) {
  if (order.supplier_dispatch_mode === 'immediate') return { label: 'Envío inmediato', description: 'Registrado al crear el pedido. Se intenta el envío al confirmar el pago simulado.' };
  if (order.supplier_dispatch_mode === 'grouped') return { label: 'Envío agrupado', description: 'Registrado al crear el pedido. Se gestiona desde el envío de pendientes o de forma individual.' };
  return { label: 'Gestión manual', description: 'Sin política de envío registrada. Puedes revisar y enviar el pedido desde este panel.' };
}

export function hasCurrentMarketplaceAcknowledgement(data: JourneySource) {
  const sync = data.marketplace_sync;
  return Boolean(sync && !data.marketplace_warning
    && sync.supplier_status === data.order.supplier_status
    && (sync.tracking_number ?? '') === (data.order.tracking_number ?? '')
    && (sync.tracking_carrier ?? '') === (data.order.tracking_carrier ?? '')
    && (data.fulfillment?.shipments ?? []).every(shipment => shipment.marketplace_synced_at)
    && (!data.cancellation || (data.cancellation.marketplace_synced_at && data.cancellation.cancelled_at !== null)));
}
export function createOrderJourney(data: JourneySource, options: { channelName: string }) {
  const { order } = data;
  const cancelled = order.status === 'cancelled';
  const paid = ['paid', 'shipped', 'delivered'].includes(order.status);
  const accepted = Boolean(order.supplier_order_id);
  const shipped = paid && accepted && order.supplier_status === 'SUPPLIER_SHIPPED' && Boolean(order.tracking_number);
  const delivered = order.status === 'delivered';
  const hasMarketplace = order.channel !== 'WEB';
  const acknowledged = hasCurrentMarketplaceAcknowledgement(data);
  const returned = shipped && acknowledged;
  const supplierError = order.supplier_status === 'ERROR';
  const partial = order.supplier_status === 'SUPPLIER_PARTIAL';
  const shipments = data.fulfillment?.shipments.length ?? 0;
  const units = (key: 'ordered' | 'shipped') => (data.fulfillment?.lines ?? []).reduce((sum, line) => sum + line[key], 0);
  const partialDetail = shipments
    ? `Envío parcial · ${units('shipped')} de ${units('ordered')} unidades expedidas en ${shipments} ${shipments === 1 ? 'expedición' : 'expediciones'}`
    : 'Envío parcial · falta completar la expedición';
  const steps = [
    { title: 'Venta confirmada', complete: paid, detail: paid ? 'Pago simulado registrado' : order.status === 'cancelled' ? 'Pedido cancelado' : 'Pago simulado pendiente' },
    { title: 'Proveedor acepta', complete: accepted, detail: accepted ? `Referencia demo ${order.supplier_order_id}` : supplierError ? 'El envío necesita un reintento' : 'Pendiente de enviar al proveedor' },
    { title: 'Envío y tracking', complete: shipped, detail: shipped ? order.tracking_number! : supplierError && accepted ? 'Incidencia de proveedor por resolver' : partial ? partialDetail : order.supplier_status === 'SUPPLIER_SHIPPED' ? 'Tracking pendiente de recuperar' : accepted ? 'Preparación y expedición pendientes' : 'Disponible tras la aceptación' },
    ...(hasMarketplace ? [{ title: 'Retorno al canal', complete: returned, detail: returned ? `Seguimiento registrado · ${options.channelName} demo` : shipped ? 'Pendiente de conciliar el seguimiento simulado' : acknowledged ? 'Estado simulado registrado · seguimiento pendiente' : 'Confirmación simulada del canal pendiente' }] : []),
    { title: 'Entrega', complete: delivered, detail: delivered ? 'Entrega confirmada · el comprador ya puede pedir su devolución' : shipped ? 'Pendiente de confirmar la entrega' : 'Disponible cuando el pedido salga' },
  ];
  const firstPending = steps.findIndex(step => !step.complete);
  const current = firstPending < 0 ? steps.length - 1 : firstPending;
  let next = '';
  let href = '#supplier-management';
  let actionLabel = 'Gestionar proveedor';
  if (!paid) {
    next = order.status === 'cancelled' ? 'Este pedido está cancelado. Puedes consultar los cambios en su historial.' : 'El pago simulado no está confirmado. El envío al proveedor permanece bloqueado; consulta el historial del pedido.';
    href = '#order-history'; actionLabel = 'Ver historial';
    if (cancelled && data.cancellation) { href = '#order-cancellation'; actionLabel = 'Ver la cancelación'; }
  } else if (!accepted) {
    next = supplierError ? 'Revisa el stock del proveedor y reintenta el envío con la misma referencia de pedido.'
      : order.supplier_dispatch_mode === 'grouped' ? 'Este pedido conserva el envío agrupado. Puedes enviarlo ahora desde Gestión del proveedor.'
        : order.supplier_dispatch_mode === 'immediate' ? 'Este pedido se creó con envío inmediato, pero la aceptación todavía no está confirmada. Revisa el proveedor y reintenta el envío con la misma referencia.'
          : 'Este pedido no tiene una política de envío registrada. Gestiona su envío manualmente desde Gestión del proveedor.';
    actionLabel = supplierError ? 'Revisar y reintentar' : 'Ir al envío del proveedor';
  } else if (!shipped) {
    next = supplierError ? 'La aceptación está registrada, pero hay una incidencia posterior. Simula la recuperación del proveedor desde su gestión.' : partial ? 'El envío sigue siendo parcial. Registra otra expedición con las unidades pendientes o simula «Enviado + tracking» para expedir el resto.' : order.supplier_status === 'SUPPLIER_SHIPPED' ? 'La expedición figura como enviada, pero aún falta el número de seguimiento. Revisa la última actualización del proveedor.' : 'Simula la preparación o selecciona «Enviado + tracking» para completar la expedición.';
    if (partial && !supplierError) { href = '#order-shipments'; actionLabel = 'Gestionar expediciones'; }
  } else if (hasMarketplace && !returned) {
    next = `El seguimiento simulado ya está disponible. Concilia la sincronización para actualizar la confirmación de ${options.channelName} demo.`;
    href = '#marketplace-return'; actionLabel = 'Conciliar retorno al canal';
  } else if (!delivered) {
    next = 'El envío está registrado. Confirma la entrega cuando el comprador reciba el pedido: a partir de ahí podrá pedir su devolución desde su cuenta.';
    actionLabel = 'Confirmar la entrega';
  } else {
    next = hasMarketplace ? `El seguimiento simulado y la entrega constan registrados, con la confirmación de ${options.channelName} demo en Ecom Connect.` : 'Envío, seguimiento y entrega simulados están registrados. Si el comprador pide una devolución, la verás en este pedido.';
    href = '#order-returns'; actionLabel = 'Ver devoluciones';
  }
  return { steps, current, complete: firstPending < 0, requiresAttention: supplierError, cancelled, next, href, actionLabel };
}
