/**
 * Identificadores de pedido. La aplicación en D1 de las transiciones vive desde
 * R1.5 en `src/modules/orders/infrastructure/d1-order-writer.ts`.
 */

import { shopConfig } from '../../shop.config';

/** Número de pedido legible: {prefijo}-AAMMDD-XXXX (XXXX aleatorio sin ambiguos). */
export function generateOrderNumber(now: Date = new Date()): string {
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `${shopConfig.orderNumberPrefix}-${yy}${mm}${dd}-${suffix}`;
}

/**
 * Token de sesión de pago simulado (sin claves de Stripe): `/demo/gracias` busca
 * el pedido por este valor y expone nombre/email/total sin autenticar, igual que
 * haría con un `session_id` real de Stripe (que trae ~120 bits de entropía propia).
 * El nº de pedido legible NO sirve como token: su sufijo de 4 caracteres
 * (~20 bits, y la fecha va en claro) es enumerable en un día de peticiones.
 */
export function generateSimulatedSessionToken(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}
