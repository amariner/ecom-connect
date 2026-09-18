import type { CapabilityFlagName, CapabilityState } from './manifest';
import type { CapabilityId } from './capability-definitions';
import { MODULE_REGISTRY } from './module-registry';

export type CapabilityAccess = Readonly<{
  capabilityState: (id: CapabilityId) => CapabilityState;
  hasCapabilityFlag: (id: CapabilityId, flag: CapabilityFlagName) => boolean;
  capability: (id: CapabilityId) => Readonly<{
    degradation?: Readonly<{ reason: string; fallback: string }>;
  }>;
}>;

export type AccessDecision =
  | Readonly<{
      allowed: true;
      capabilityId: CapabilityId;
      state: 'active' | 'degraded';
      degradation?: Readonly<{ reason: string; fallback: string }>;
    }>
  | Readonly<{
      allowed: false;
      capabilityId: CapabilityId;
      state: CapabilityState;
      status: 403 | 404;
    }>;

export const ADMIN_NAVIGATION_ITEMS = MODULE_REGISTRY.navigation;
export type { AdminNavigationId } from './module-registry';

export function decideCapabilityAccess(
  access: CapabilityAccess,
  capabilityId: CapabilityId,
  flag: CapabilityFlagName,
): AccessDecision {
  const state = access.capabilityState(capabilityId);
  if ((state === 'active' || state === 'degraded') && access.hasCapabilityFlag(capabilityId, flag)) {
    const degradation = access.capability(capabilityId).degradation;
    return {
      allowed: true,
      capabilityId,
      state,
      ...(degradation === undefined ? {} : { degradation }),
    };
  }
  return {
    allowed: false,
    capabilityId,
    state,
    // Una capacidad operativa cuya ruta está cerrada existe, pero no autoriza
    // esta superficie. Las capacidades no operativas se ocultan como ausentes.
    status: state === 'active' || state === 'degraded' ? 403 : 404,
  };
}

export function adminNavigationFor(access: CapabilityAccess) {
  return ADMIN_NAVIGATION_ITEMS.filter((item) =>
    decideCapabilityAccess(access, item.capabilityId, 'navigation').allowed,
  );
}

export function adminHomeHrefFor(access: CapabilityAccess): string | null {
  return adminNavigationFor(access)[0]?.href ?? null;
}

/**
 * Astro acepta por defecto una barra final opcional. Las decisiones de acceso
 * deben ver ambas formas como la misma ruta para que una variante no pueda
 * saltarse el manifest ni los guards del middleware.
 */
export function canonicalRoutePathname(pathname: string): string {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/, '') || '/';
}

export function routeCapability(pathname: string): CapabilityId | null {
  const canonicalPathname = canonicalRoutePathname(pathname);
  const route = MODULE_REGISTRY.routes.find((candidate) => {
    const candidatePath = canonicalRoutePathname(candidate.path);
    return candidate.match === 'exact'
      ? canonicalPathname === candidatePath
      : canonicalPathname === candidatePath || canonicalPathname.startsWith(`${candidatePath}/`);
  });
  return route?.capabilityId ?? null;
}

export function decideRouteAccess(access: CapabilityAccess, pathname: string): AccessDecision | null {
  const capabilityId = routeCapability(pathname);
  return capabilityId === null ? null : decideCapabilityAccess(access, capabilityId, 'routes');
}
