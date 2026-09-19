import { describe, expect, it } from 'vitest';
import { createOrderJourney, hasCurrentMarketplaceAcknowledgement, orderDispatchPolicy, type JourneySource } from '../src/components/admin/order-journey';

const options = { channelName: 'Amazon' };
function source(overrides: Partial<JourneySource['order']> = {}): JourneySource {
  return {
    order: { channel: 'AMAZON', status: 'paid', supplier_status: 'PENDING_SUPPLIER', supplier_dispatch_mode: 'grouped', ...overrides },
    marketplace_sync: null,
  };
}
function shipment(): JourneySource {
  return source({ status: 'shipped', supplier_status: 'SUPPLIER_SHIPPED', supplier_order_id: 'DEMO-1', tracking_number: 'TRACK-DEMO', tracking_carrier: 'Proveedor Demo' });
}
function acknowledge(data: JourneySource) {
  data.marketplace_sync = { supplier_status: data.order.supplier_status, tracking_number: data.order.tracking_number ?? null, tracking_carrier: data.order.tracking_carrier ?? null };
  return data;
}

describe('demo order journey', () => {
  it('blocks fulfillment until simulated payment is confirmed', () => {
    const journey = createOrderJourney(source({ status: 'pending' }), options);
    expect(journey.steps.map(step => step.complete)).toEqual([false, false, false, false]);
    expect(journey.current).toBe(0);
    expect(journey.href).toBe('#order-history');
  });

  it('directs a paid grouped order to dispatch instead of suggesting automatic delivery', () => {
    const journey = createOrderJourney(source(), options);
    expect(journey.current).toBe(1);
    expect(journey.next).toContain('envío agrupado');
    expect(journey.href).toBe('#supplier-management');
  });

  it('keeps the order mode when the workspace now uses the opposite mode', () => {
    const workspaceNowImmediate = { channelName: 'Amazon', dispatchMode: 'immediate' as const };
    const grouped = source({ supplier_dispatch_mode: 'grouped' });
    expect(createOrderJourney(grouped, workspaceNowImmediate).next).toContain('conserva el envío agrupado');
    expect(orderDispatchPolicy(grouped.order).label).toBe('Envío agrupado');

    const workspaceNowGrouped = { channelName: 'Amazon', dispatchMode: 'grouped' as const };
    const immediate = source({ supplier_dispatch_mode: 'immediate' });
    const journey = createOrderJourney(immediate, workspaceNowGrouped);
    expect(journey.next).toContain('se creó con envío inmediato');
    expect(journey.next).toContain('aceptación todavía no está confirmada');
    expect(journey.steps[1]?.complete).toBe(false);
    expect(orderDispatchPolicy(immediate.order).label).toBe('Envío inmediato');
  });

  it.each([null, undefined])('uses conservative manual management for a legacy order with mode %s', mode => {
    const legacy = source({ supplier_dispatch_mode: null });
    if (mode === undefined) delete legacy.order.supplier_dispatch_mode;
    const journey = createOrderJourney(legacy, { channelName: 'Amazon', ...{ dispatchMode: 'immediate' } });
    expect(journey.next).toContain('manualmente');
    expect(journey.next).not.toContain('envío agrupado');
    expect(journey.next).not.toContain('envío inmediato');
    expect(orderDispatchPolicy(legacy.order)).toEqual({ label: 'Gestión manual', description: 'Sin política de envío registrada. Puedes revisar y enviar el pedido desde este panel.' });
    expect(journey.href).toBe('#supplier-management');
  });

  it('preserves the original mode while an uncertain dispatch needs a retry', () => {
    const data = source({ supplier_dispatch_mode: 'immediate', supplier_status: 'ERROR' });
    const journey = createOrderJourney(data, options);
    expect(journey.next).toContain('misma referencia');
    expect(journey.requiresAttention).toBe(true);
    expect(orderDispatchPolicy(data.order).label).toBe('Envío inmediato');
  });

  it('marks a cancelled journey as stopped and links to history', () => {
    const journey = createOrderJourney(source({ status: 'cancelled' }), options);
    expect(journey.cancelled).toBe(true);
    expect(journey.complete).toBe(false);
    expect(journey.href).toBe('#order-history');
    expect(journey.next).toContain('cancelado');
  });

  it('does not mistake a current acceptance acknowledgement for shipment or tracking returned', () => {
    const data = acknowledge(source({ supplier_status: 'SUPPLIER_ACCEPTED', supplier_order_id: 'DEMO-1' }));
    expect(hasCurrentMarketplaceAcknowledgement(data)).toBe(true);
    const journey = createOrderJourney(data, options);
    expect(journey.steps.map(step => step.complete)).toEqual([true, true, false, false]);
    expect(journey.current).toBe(2);
    expect(journey.complete).toBe(false);
  });

  it.each(['SUPPLIER_PARTIAL', 'ERROR'])('keeps accepted history without declaring %s shipped, even with stale tracking', supplierStatus => {
    const data = acknowledge(source({ supplier_status: supplierStatus, supplier_order_id: 'DEMO-1', tracking_number: 'TRACK-DEMO', tracking_carrier: 'Proveedor Demo' }));
    const journey = createOrderJourney(data, options);
    expect(journey.steps.map(step => step.complete)).toEqual([true, true, false, false]);
    expect(journey.current).toBe(2);
    expect(journey.complete).toBe(false);
    expect(journey.requiresAttention).toBe(supplierStatus === 'ERROR');
  });

  it('reports shipped and pending units while the shipment is partial', () => {
    const data = acknowledge(source({ supplier_status: 'SUPPLIER_PARTIAL', supplier_order_id: 'DEMO-1' }));
    data.fulfillment = { lines: [{ ordered: 2, shipped: 1 }, { ordered: 1, shipped: 0 }], shipments: [{ marketplace_synced_at: '2026-09-19T10:00:00.000Z' }] };
    const journey = createOrderJourney(data, options);
    expect(journey.steps[2]).toMatchObject({ complete: false, detail: 'Envío parcial · 1 de 3 unidades expedidas en 1 expedición' });
    expect(journey.next).toContain('Registra otra expedición');
    expect(journey.href).toBe('#order-shipments');
  });

  it('keeps the partial wording generic when no shipment has been registered yet', () => {
    const data = acknowledge(source({ supplier_status: 'SUPPLIER_PARTIAL', supplier_order_id: 'DEMO-1' }));
    data.fulfillment = { lines: [{ ordered: 2, shipped: 0 }], shipments: [] };
    expect(createOrderJourney(data, options).steps[2]?.detail).toBe('Envío parcial · falta completar la expedición');
  });

  it('requires reconciliation while any shipment lacks its own acknowledgement', () => {
    const data = acknowledge(shipment());
    data.fulfillment = { lines: [{ ordered: 2, shipped: 2 }], shipments: [{ marketplace_synced_at: '2026-09-19T10:00:00.000Z' }, { marketplace_synced_at: null }] };
    expect(hasCurrentMarketplaceAcknowledgement(data)).toBe(false);
    expect(createOrderJourney(data, options).current).toBe(3);
    data.fulfillment.shipments[1]!.marketplace_synced_at = '2026-09-19T10:05:00.000Z';
    expect(hasCurrentMarketplaceAcknowledgement(data)).toBe(true);
    expect(createOrderJourney(data, options).complete).toBe(true);
  });

  it('does not wait for shipment acknowledgements on web orders', () => {
    const data = shipment();
    data.order.channel = 'WEB';
    data.fulfillment = { lines: [{ ordered: 1, shipped: 1 }], shipments: [{ marketplace_synced_at: null }] };
    expect(createOrderJourney(data, options).complete).toBe(true);
  });

  it('does not complete shipment until tracking exists', () => {
    const data = acknowledge(source({ status: 'shipped', supplier_status: 'SUPPLIER_SHIPPED', supplier_order_id: 'DEMO-1' }));
    const journey = createOrderJourney(data, options);
    expect(journey.steps[2]?.complete).toBe(false);
    expect(journey.steps[3]?.complete).toBe(false);
    expect(journey.next).toContain('falta el número de seguimiento');
  });

  it.each(['status', 'tracking', 'carrier', 'missing', 'warning'])('requires reconciliation when the acknowledgement has a %s mismatch', mismatch => {
    const data = acknowledge(shipment());
    if (mismatch === 'status') data.marketplace_sync!.supplier_status = 'SUPPLIER_ACCEPTED';
    if (mismatch === 'tracking') data.marketplace_sync!.tracking_number = 'OLDER-TRACK';
    if (mismatch === 'carrier') data.marketplace_sync!.tracking_carrier = 'Otro proveedor demo';
    if (mismatch === 'missing') data.marketplace_sync = null;
    if (mismatch === 'warning') data.marketplace_warning = 'No se pudo leer el acuse';
    expect(hasCurrentMarketplaceAcknowledgement(data)).toBe(false);
    const journey = createOrderJourney(data, options);
    expect(journey.steps.map(step => step.complete)).toEqual([true, true, true, false]);
    expect(journey.current).toBe(3);
    expect(journey.href).toBe('#marketplace-return');
    expect(journey.complete).toBe(false);
  });

  it('finishes a marketplace journey only with current shipment and full acknowledgement', () => {
    const journey = createOrderJourney(acknowledge(shipment()), options);
    expect(journey.steps.every(step => step.complete)).toBe(true);
    expect(journey.complete).toBe(true);
    expect(journey.current).toBe(3);
    expect(journey.steps[3]?.detail).toBe('Seguimiento registrado · Amazon demo');
    expect(journey.next).toContain('proveedor simulado');
    expect(journey.next).toContain('Amazon demo');
    expect(journey.next).toContain('Ecom Connect');
  });

  it('omits marketplace acknowledgement for a web order', () => {
    const data = shipment();
    data.order.channel = 'WEB';
    const journey = createOrderJourney(data, { ...options, channelName: 'Tienda web' });
    expect(journey.steps).toHaveLength(3);
    expect(journey.complete).toBe(true);
    expect(journey.current).toBe(2);
    expect(journey.href).toBe('#order-history');
    expect(journey.next).toContain('FarmaHouse');
    expect(journey.next).toContain('simulado');
  });
});
