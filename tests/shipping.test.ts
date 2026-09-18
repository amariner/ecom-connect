import { describe, expect, it } from 'vitest';
import { resolveZone } from '../src/lib/shipping';

describe('resolveZone', () => {
  it('resuelve CPs de península', () => {
    expect(resolveZone('12001')).toBe('peninsula'); // Castellón
    expect(resolveZone('28013')).toBe('peninsula'); // Madrid
    expect(resolveZone('01001')).toBe('peninsula'); // Vitoria
  });

  it('resuelve Baleares, Canarias y Ceuta/Melilla', () => {
    expect(resolveZone('07001')).toBe('baleares');
    expect(resolveZone('35001')).toBe('canarias');
    expect(resolveZone('38001')).toBe('canarias');
    expect(resolveZone('51001')).toBe('ceuta-melilla');
    expect(resolveZone('52001')).toBe('ceuta-melilla');
  });

  it('devuelve null para CPs no reconocidos o malformados', () => {
    expect(resolveZone('99999')).toBeNull(); // prefijo inexistente
    expect(resolveZone('1200')).toBeNull(); // 4 dígitos
    expect(resolveZone('abcde')).toBeNull();
    expect(resolveZone('')).toBeNull();
  });

  it('tolera espacios alrededor', () => {
    expect(resolveZone(' 12580 ')).toBe('peninsula'); // Benicarló
  });
});
