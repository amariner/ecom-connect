/**
 * Resolución de zona de envío a partir del código postal.
 * Las zonas se definen en shop.config.ts; las tarifas viven en D1.
 */

import { shopConfig } from '../../shop.config';

const CP_REGEX = /^\d{5}$/;

/** Devuelve el id de zona para un CP español, o null si no hay cobertura. */
export function resolveZone(postalCode: string): string | null {
  const cp = postalCode.trim();
  if (!CP_REGEX.test(cp)) return null;

  let best: { zoneId: string; prefixLen: number } | null = null;
  for (const zone of shopConfig.shipping.zones) {
    for (const prefix of zone.postalPrefixes) {
      if (cp.startsWith(prefix) && (best === null || prefix.length > best.prefixLen)) {
        best = { zoneId: zone.id, prefixLen: prefix.length };
      }
    }
  }
  return best?.zoneId ?? null;
}
