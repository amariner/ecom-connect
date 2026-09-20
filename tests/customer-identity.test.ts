import { describe, expect, it } from 'vitest';
import { customerEvents } from '../src/components/shop/account-view';
import {
  ACCESS_LINK_TTL_MS, SESSION_FAMILY_TTL_MS, SESSION_TTL_MS, addMilliseconds, customerId,
  decideAccountOrderActions, decideThrottle, normalizeEmail, randomHex,
} from '../src/modules/customers/domain/customer-identity';

describe('identidad del comprador',() => {
  it('normaliza el correo para que un mismo cliente no tenga dos cuentas',() => {
    expect(normalizeEmail('  Laura@Example.TEST ')).toBe('laura@example.test');
  });

  it('genera identificadores que cumplen la gramática del esquema heredado',() => {
    for (const kind of ['profile','identity','family','session','challenge','address','consent'] as const) {
      const id = customerId(kind);
      expect(id).toMatch(/^[a-z]+_[a-f0-9]{32}$/);
      expect(id.length).toBeLessThanOrEqual(200);
    }
    expect(randomHex(32)).toMatch(/^[a-f0-9]{64}$/);
    expect(randomHex()).not.toBe(randomHex());
  });

  it('mantiene cada plazo por debajo del máximo que admite su CHECK',() => {
    const start = '2026-09-20T10:00:00.000Z';
    const julianDelta = (end: string) => (Date.parse(end) - Date.parse(start));
    expect(julianDelta(addMilliseconds(start,ACCESS_LINK_TTL_MS))).toBeLessThan(900_000);
    expect(julianDelta(addMilliseconds(start,SESSION_TTL_MS))).toBeLessThan(604_800_000);
    expect(julianDelta(addMilliseconds(start,SESSION_FAMILY_TTL_MS))).toBeLessThan(2_592_000_000);
    expect(addMilliseconds(start,ACCESS_LINK_TTL_MS)).toBe('2026-09-20T10:10:00.000Z');
  });
});

describe('límite de enlaces de acceso',() => {
  it('acepta los primeros intentos y corta la ráfaga',() => {
    expect(decideThrottle({short:1,daily:1})).toMatchObject({decision:'accepted'});
    expect(decideThrottle({short:3,daily:5})).toMatchObject({decision:'accepted'});
    expect(decideThrottle({short:4,daily:4})).toMatchObject({decision:'limited'});
    expect(decideThrottle({short:1,daily:11})).toMatchObject({decision:'limited'});
  });

  it('nunca produce contadores que el CHECK del esquema rechazaría',() => {
    const decision = decideThrottle({short:9,daily:2});
    expect(decision.daily_window_count).toBeGreaterThanOrEqual(decision.short_window_count);
    expect(decideThrottle({short:0,daily:0}).short_window_count).toBe(1);
  });
});

describe('lo que el comprador puede hacer con su pedido',() => {
  it('permite cancelar mientras nada ha salido del almacén',() => {
    expect(decideAccountOrderActions({status:'pending',shipped_units:0})).toEqual({can_cancel:true,cancel_note:null});
    expect(decideAccountOrderActions({status:'paid',shipped_units:0})).toEqual({can_cancel:true,cancel_note:null});
  });

  it('explica por qué no puede cancelar en lugar de ofrecer una acción que se rechazará',() => {
    expect(decideAccountOrderActions({status:'paid',shipped_units:1}))
      .toMatchObject({can_cancel:false,cancel_note:expect.stringContaining('expedidas')});
    expect(decideAccountOrderActions({status:'shipped',shipped_units:2}))
      .toMatchObject({can_cancel:false,cancel_note:expect.stringContaining('entregado')});
    expect(decideAccountOrderActions({status:'delivered',shipped_units:2}))
      .toMatchObject({can_cancel:false,cancel_note:expect.stringContaining('devolución')});
    expect(decideAccountOrderActions({status:'delivered',shipped_units:2}).can_cancel).toBe(false);
    expect(decideAccountOrderActions({status:'cancelled',shipped_units:0})).toEqual({can_cancel:false,cancel_note:null});
  });
});

describe('el historial que lee el comprador',() => {
  it('traduce los movimientos del proveedor y omite los que no le afectan',() => {
    const events = [
      {to_status:'pending',created_at:'2026-09-20T10:00:00.000Z'},
      {to_status:'paid',created_at:'2026-09-20T10:01:00.000Z'},
      {to_status:'PENDING_SUPPLIER',created_at:'2026-09-20T10:02:00.000Z'},
      {to_status:'SUPPLIER_ACCEPTED',created_at:'2026-09-20T10:03:00.000Z'},
      {to_status:'SUPPLIER_PROCESSING',created_at:'2026-09-20T10:04:00.000Z'},
      {to_status:'ERROR',created_at:'2026-09-20T10:05:00.000Z'},
      {to_status:'SUPPLIER_SHIPPED',created_at:'2026-09-20T10:06:00.000Z'},
      {to_status:'delivered',created_at:'2026-09-20T10:07:00.000Z'},
    ];
    expect(customerEvents(events).map(event => event.title))
      .toEqual(['Pedido recibido','Pago confirmado','Pedido en preparación','Pedido enviado','Pedido entregado']);
    expect(customerEvents(events)[3]?.created_at).toBe('2026-09-20T10:06:00.000Z');
    expect(customerEvents([])).toEqual([]);
  });
});
