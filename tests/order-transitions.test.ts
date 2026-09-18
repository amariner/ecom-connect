import { describe, expect, it } from 'vitest';
import { decideTransition } from '../src/lib/order-transitions';

describe('decideTransition', () => {
  it('paid → shipped exige tracking completo', () => {
    expect(decideTransition('paid', { to: 'shipped' }).ok).toBe(false);
    expect(decideTransition('paid', { to: 'shipped', tracking_carrier: 'SEUR', tracking_number: ' ' }).ok).toBe(false);
    const ok = decideTransition('paid', { to: 'shipped', tracking_carrier: 'SEUR', tracking_number: 'ES123' });
    expect(ok).toEqual({
      ok: true,
      to: 'shipped',
      tracking: { carrier: 'SEUR', number: 'ES123' },
      restoreStock: false,
    });
  });

  it('shipped → delivered no arrastra tracking nuevo', () => {
    const res = decideTransition('shipped', { to: 'delivered' });
    expect(res).toEqual({ ok: true, to: 'delivered', tracking: null, restoreStock: false });
  });

  it('la decisión no redacta la nota ni decide el email: eso es del hecho de dominio', () => {
    const res = decideTransition('paid', { to: 'shipped', tracking_carrier: 'SEUR', tracking_number: 'ES123' });
    expect(Object.keys(res).toSorted()).toEqual(['ok', 'restoreStock', 'to', 'tracking']);
  });

  it('pending solo puede cancelarse a mano (paid es cosa del webhook)', () => {
    expect(decideTransition('pending', { to: 'paid' }).ok).toBe(false);
    expect(decideTransition('pending', { to: 'cancelled' }).ok).toBe(true);
  });

  it('estados finales no admiten transiciones', () => {
    expect(decideTransition('delivered', { to: 'cancelled' }).ok).toBe(false);
    expect(decideTransition('cancelled', { to: 'paid' }).ok).toBe(false);
  });

  it('no se puede saltar de paid a delivered', () => {
    expect(decideTransition('paid', { to: 'delivered' }).ok).toBe(false);
  });

  it('paid → cancelled devuelve el stock (el webhook lo había decrementado)', () => {
    const res = decideTransition('paid', { to: 'cancelled' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.restoreStock).toBe(true);
  });

  it('pending → cancelled NO devuelve stock (nunca se decrementó)', () => {
    const res = decideTransition('pending', { to: 'cancelled' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.restoreStock).toBe(false);
  });
});
