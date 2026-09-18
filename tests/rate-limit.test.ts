import { describe, expect, it } from 'vitest';
import { RateLimiter, type RateLimitRule } from '../src/lib/rate-limit';

const RULE: RateLimitRule = { limit: 3, windowMs: 60_000 };
const T0 = 1_752_000_000_000;

describe('RateLimiter', () => {
  it('permite hasta el límite dentro de la ventana y corta después', () => {
    const limiter = new RateLimiter();
    expect(limiter.check('ip1', RULE, T0)).toBe(true);
    expect(limiter.check('ip1', RULE, T0 + 1000)).toBe(true);
    expect(limiter.check('ip1', RULE, T0 + 2000)).toBe(true);
    expect(limiter.check('ip1', RULE, T0 + 3000)).toBe(false);
  });

  it('la ventana expira y vuelve a permitir', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 4; i++) limiter.check('ip1', RULE, T0);
    expect(limiter.check('ip1', RULE, T0 + RULE.windowMs)).toBe(true);
  });

  it('las claves no se pisan entre sí', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 4; i++) limiter.check('ip1', RULE, T0);
    expect(limiter.check('ip2', RULE, T0)).toBe(true);
  });

  it('Retry-After apunta al final de la ventana', () => {
    const limiter = new RateLimiter();
    limiter.check('ip1', RULE, T0);
    expect(limiter.retryAfterSeconds('ip1', RULE, T0 + 10_000)).toBe(50);
    expect(limiter.retryAfterSeconds('desconocida', RULE, T0)).toBe(0);
  });

  it('purga ventanas caducadas al llegar al techo de claves (sin crecer sin límite)', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5000; i++) limiter.check(`ip${i}`, RULE, T0);
    expect(limiter.size).toBe(5000);
    // Todas caducadas → la siguiente clave fuerza la purga.
    expect(limiter.check('nueva', RULE, T0 + RULE.windowMs)).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it('con el mapa lleno de claves vivas, vacía en vez de crecer', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5000; i++) limiter.check(`ip${i}`, RULE, T0);
    expect(limiter.check('nueva', RULE, T0 + 1000)).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(2);
  });
});
