import { describe, expect, it } from 'vitest';
import { createOrderJourney, hasCurrentMarketplaceAcknowledgement, type JourneySource } from '../src/components/admin/order-journey';

const options = { dispatchMode: 'grouped' as const, channelName: 'Amazon' };
function source(overrides: Partial<JourneySource['order']> = {}): JourneySource {
  return {
    order: { channel: 'AMAZON', status: 'paid', supplier_status: 'PENDING_SUPPLIER', ...overrides },
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
