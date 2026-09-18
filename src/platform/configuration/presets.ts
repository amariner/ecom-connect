import type {
  CapabilityFlags,
  CapabilityManifestEntries,
  CapabilityManifestInput,
  CapabilityPresetName,
  DeploymentConfiguration,
} from './manifest';

const INTERNAL: CapabilityFlags = { routes: false, navigation: false, jobs: false, sideEffects: false };
const ROUTE: CapabilityFlags = { routes: true, navigation: false, jobs: false, sideEffects: false };
const NAVIGATION: CapabilityFlags = { routes: true, navigation: true, jobs: false, sideEffects: false };
const EFFECT: CapabilityFlags = { routes: false, navigation: false, jobs: false, sideEffects: true };
const JOB_EFFECT: CapabilityFlags = { routes: false, navigation: false, jobs: true, sideEffects: true };
const ROUTE_EFFECT: CapabilityFlags = { routes: true, navigation: false, jobs: false, sideEffects: true };
const NAVIGATION_EFFECT: CapabilityFlags = { routes: true, navigation: true, jobs: false, sideEffects: true };
const FULL_EFFECT: CapabilityFlags = { routes: true, navigation: true, jobs: true, sideEffects: true };

const MINIMAL_CAPABILITIES = {
  'PLT-001': { state: 'active', flags: INTERNAL },
  'PLT-004': { state: 'active', flags: INTERNAL, config: { failFast: true } },
  'CAT-001': { state: 'active', flags: NAVIGATION },
  'PRC-001': { state: 'active', flags: INTERNAL },
  'STO-001': { state: 'active', flags: NAVIGATION },
  'STO-008': { state: 'active', flags: INTERNAL },
  'MKT-001': { state: 'active', flags: INTERNAL, config: { currency: 'EUR' } },
  'SEC-012': { state: 'active', flags: INTERNAL },
} as const satisfies CapabilityManifestEntries;

const STANDARD_CAPABILITIES = {
  ...MINIMAL_CAPABILITIES,
  'INV-001': { state: 'active', flags: INTERNAL },
  // R2.8 está instalado pero exige opt-in explícito: sin flags no reserva,
  // consume ni ejecuta el job de expiración.
  'INV-004': { state: 'installed' },
  'CHK-001': { state: 'active', flags: NAVIGATION },
  'CHK-002': { state: 'active', flags: ROUTE },
  'CHK-003': { state: 'active', flags: ROUTE_EFFECT },
  'CHK-004': { state: 'active', flags: ROUTE_EFFECT },
  'ORD-001': { state: 'active', flags: NAVIGATION },
  'ORD-002': { state: 'active', flags: ROUTE },
  'FUL-001': {
    state: 'active',
    flags: NAVIGATION,
    config: { strategy: 'flat-zone', supportsFreeThreshold: true },
  },
  'CUS-001': { state: 'active', flags: INTERNAL },
  'MKT-002': { state: 'active', flags: INTERNAL, config: { country: 'ES', resolver: 'postal-prefix' } },
  'MAR-003': {
    state: 'active',
    flags: NAVIGATION_EFFECT,
    config: { demoDelivery: 'outbox', clientDelivery: 'provider' },
  },
  'AUT-001': { state: 'active', flags: INTERNAL },
  'AUT-002': { state: 'active', flags: JOB_EFFECT },
  'INT-001': {
    state: 'active',
    flags: EFFECT,
    config: {
      provider: 'stripe-checkout',
      secretRefs: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    },
  },
  'SEC-001': { state: 'active', flags: ROUTE },
  'SEC-003': { state: 'active', flags: INTERNAL },
  'SEC-004': { state: 'active', flags: INTERNAL },
} as const satisfies CapabilityManifestEntries;

const ADVANCED_CAPABILITIES = {
  ...STANDARD_CAPABILITIES,
  'INV-004': { state: 'active', flags: JOB_EFFECT },
  'INV-005': { state: 'active', flags: NAVIGATION_EFFECT },
  'INV-007': { state: 'active', flags: NAVIGATION_EFFECT },
  'INV-008': { state: 'active', flags: NAVIGATION_EFFECT },
  'INV-011': { state: 'active', flags: NAVIGATION_EFFECT },
  'ORD-004': { state: 'active', flags: ROUTE_EFFECT },
  'ORD-005': { state: 'active', flags: ROUTE_EFFECT },
  'ORD-007': { state: 'active', flags: ROUTE_EFFECT },
  'ORD-010': { state: 'active', flags: ROUTE_EFFECT },
  'AUT-011': { state: 'active', flags: ROUTE },
  'ORD-011': { state: 'active', flags: FULL_EFFECT },
  'ORD-012': { state: 'active', flags: NAVIGATION_EFFECT },
  'CAT-002': { state: 'active', flags: INTERNAL },
  'CAT-003': { state: 'active', flags: ROUTE },
  'CAT-007': { state: 'active', flags: ROUTE },
  'CAT-008': { state: 'active', flags: ROUTE },
  'PRC-002': { state: 'active', flags: INTERNAL },
  'PRC-003': { state: 'active', flags: INTERNAL },
  'PRC-004': { state: 'active', flags: ROUTE_EFFECT },
  'PRC-005': { state: 'active', flags: ROUTE_EFFECT },
  'PRC-006': { state: 'active', flags: ROUTE_EFFECT },
  'PRC-007': { state: 'active', flags: ROUTE_EFFECT },
  'PRC-008': { state: 'active', flags: ROUTE_EFFECT },
  'PRC-009': { state: 'active', flags: ROUTE_EFFECT },
  'PRC-010': { state: 'active', flags: ROUTE_EFFECT },
  'PRC-011': { state: 'active', flags: ROUTE_EFFECT },
  'PRC-012': { state: 'active', flags: ROUTE_EFFECT },
  // El contrato R4.10 queda instalado, pero ningún preset decide proveedor,
  // precio o cadencia comercial. Un proyecto debe activarlo explícitamente.
  'PRC-013': { state: 'installed' },
  'PRC-014': { state: 'active', flags: ROUTE_EFFECT },
  // R4.11 solo instala el contrato: cada proyecto debe aportar importes,
  // vigencia, puerta de conversión y adaptador de enlace alojado.
  'ORD-008': { state: 'installed' },
  'CHK-011': { state: 'installed' },
  // R5.1 instala identidad/dominio, pero no crea perfiles hasta disponer de
  // persistencia expand-only y un secreto HMAC por despliegue.
  'CUS-002': { state: 'installed' },
  // R5.4a-b instala threat model, contratos y persistencia; no concede rutas,
  // cookies, proveedor ni acceso a pedidos/direcciones.
  'CUS-003': { state: 'installed' },
  // R5.5b instala referencias y reader; no concede rutas ni lectura de pedidos.
  'CUS-004': { state: 'installed' },
  // R5.5g instala persistencia owner-only; HTTP, UI y activacion quedan fuera.
  'CUS-005': { state: 'installed' },
  // R5.5e instala selectores y CAS de direcciones; no concede rutas ni acceso.
  'CUS-006': { state: 'installed' },
  // R5.2 fija evidencia y decisiones puras. Persistencia, captura y envíos
  // requieren gates separados, por eso el preset no concede efectos.
  'CUS-007': { state: 'installed' },
  // R5.3 instala lifecycle y persistencia; cualquier superficie, exportación o
  // mutación mantiene gates independientes.
  'CUS-008': { state: 'installed' },
  // R5.6a instala únicamente el lenguaje calculado y su lifecycle observable.
  // Persistencia, job, rutas y umbrales comerciales pertenecen a gates propios.
  'CUS-009': { state: 'installed' },
  'FUL-002': { state: 'active', flags: ROUTE },
  'FUL-003': { state: 'active', flags: ROUTE },
  'FUL-004': { state: 'active', flags: ROUTE_EFFECT },
  'FUL-005': { state: 'active', flags: INTERNAL },
  'FUL-011': { state: 'active', flags: NAVIGATION_EFFECT },
  'STO-002': { state: 'active', flags: INTERNAL },
  'MAR-001': { state: 'active', flags: ROUTE_EFFECT },
  'INT-002': {
    state: 'active',
    flags: EFFECT,
    config: { provider: 'resend', delivery: 'send', secretRef: 'RESEND_API_KEY' },
  },
  'INT-003': { state: 'active', flags: EFFECT },
  'INT-004': { state: 'active', flags: ROUTE },
} as const satisfies CapabilityManifestEntries;

/** Perfiles técnicos de prueba/clonado; no representan precios ni planes comerciales. */
export const CAPABILITY_PRESETS = Object.freeze({
  minimal: MINIMAL_CAPABILITIES,
  standard: STANDARD_CAPABILITIES,
  advanced: ADVANCED_CAPABILITIES,
}) satisfies Readonly<Record<CapabilityPresetName, CapabilityManifestEntries>>;

export function createPresetManifest(
  profile: CapabilityPresetName,
  deployment: Omit<DeploymentConfiguration, 'profile'>,
): CapabilityManifestInput {
  return {
    manifestVersion: 1,
    deployment: { ...deployment, profile },
    capabilities: CAPABILITY_PRESETS[profile],
  };
}

/**
 * La demo comercial enseña todas las superficies del panel con fixtures, pero
 * nunca ejecuta cobros, emails, jobs ni mutaciones. No es un cuarto plan: es
 * una composición `custom` específica de la muestra pública.
 */
export function createPublicDemoManifest(
  deployment: Omit<DeploymentConfiguration, 'mode' | 'profile'>,
): CapabilityManifestInput {
  const capabilities = Object.fromEntries(
    Object.entries(ADVANCED_CAPABILITIES).map(([id, entry]) => {
      if (entry.state !== 'active') return [id, entry];
      const config = id === 'INT-002'
        ? { provider: 'resend' as const, delivery: 'capture' as const }
        : 'config' in entry
          ? entry.config
          : undefined;
      return [
        id,
        {
          ...entry,
          flags: { ...entry.flags, jobs: false, sideEffects: false },
          ...(config === undefined ? {} : { config }),
        },
      ];
    }),
  ) as CapabilityManifestEntries;

  return {
    manifestVersion: 1,
    deployment: { ...deployment, mode: 'demo', profile: 'custom' },
    capabilities,
  };
}
