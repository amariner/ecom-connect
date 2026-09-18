import {
  CAPABILITY_DEFINITIONS,
  CAPABILITY_IDS,
  CONFIGURED_CAPABILITY_IDS,
  type CapabilityConfigById,
  type CapabilityId,
  type ConfiguredCapabilityId,
} from './capability-definitions';

export const CAPABILITY_STATES = ['absent', 'installed', 'disabled', 'active', 'degraded', 'retired'] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export const CAPABILITY_FLAG_NAMES = ['routes', 'navigation', 'jobs', 'sideEffects'] as const;
export type CapabilityFlagName = (typeof CAPABILITY_FLAG_NAMES)[number];

export type CapabilityFlags = Readonly<Record<CapabilityFlagName, boolean>>;
export type DeploymentMode = 'demo' | 'client';
export type DeploymentEnvironment = 'development' | 'preview' | 'production';
export type CapabilityPresetName = 'minimal' | 'standard' | 'advanced';

export type DeploymentConfiguration = Readonly<{
  id: string;
  mode: DeploymentMode;
  environment: DeploymentEnvironment;
  profile: CapabilityPresetName | 'custom';
}>;

type ConfigurationFor<Id extends CapabilityId> = Id extends ConfiguredCapabilityId
  ? { config?: CapabilityConfigById[Id] }
  : { config?: never };

type InactiveEntry = Readonly<{
  state: 'absent' | 'installed' | 'disabled' | 'retired';
  flags?: never;
  degradation?: never;
}>;

type ActiveEntry = Readonly<{
  state: 'active';
  flags: CapabilityFlags;
  degradation?: never;
}>;

type DegradedEntry = Readonly<{
  state: 'degraded';
  flags: CapabilityFlags;
  degradation: Readonly<{ reason: string; fallback: string }>;
}>;

export type CapabilityManifestEntry<Id extends CapabilityId> =
  (InactiveEntry | ActiveEntry | DegradedEntry) & ConfigurationFor<Id>;

export type CapabilityManifestEntries = {
  readonly [Id in CapabilityId]?: CapabilityManifestEntry<Id>;
};

export type CapabilityManifestInput = Readonly<{
  manifestVersion: 1;
  deployment: DeploymentConfiguration;
  capabilities: CapabilityManifestEntries;
}>;

export type ResolvedCapabilityEntry<Id extends CapabilityId = CapabilityId> = Readonly<{
  id: Id;
  state: CapabilityState;
  flags: CapabilityFlags;
  config?: Id extends ConfiguredCapabilityId ? CapabilityConfigById[Id] : never;
  degradation?: Readonly<{ reason: string; fallback: string }>;
}>;

export type ResolvedCapabilityManifest = Readonly<{
  manifestVersion: 1;
  deployment: DeploymentConfiguration;
  capabilities: Readonly<{ [Id in CapabilityId]: ResolvedCapabilityEntry<Id> }>;
}>;

export type CapabilityManifestIssue = Readonly<{
  path: string;
  code:
    | 'invalid-shape'
    | 'unknown-field'
    | 'unknown-capability'
    | 'invalid-state'
    | 'invalid-flags'
    | 'invalid-config'
    | 'invalid-degradation'
    | 'missing-dependency'
    | 'dependency-cycle';
  message: string;
}>;

export type CapabilityManifestValidation =
  | Readonly<{ ok: true; value: ResolvedCapabilityManifest; issues: readonly [] }>
  | Readonly<{ ok: false; issues: readonly CapabilityManifestIssue[] }>;

const DISABLED_FLAGS: CapabilityFlags = Object.freeze({
  routes: false,
  navigation: false,
  jobs: false,
  sideEffects: false,
});

const capabilityIdSet = new Set<string>(CAPABILITY_IDS);
const capabilityStateSet = new Set<string>(CAPABILITY_STATES);
const configuredCapabilityIdSet = new Set<string>(CONFIGURED_CAPABILITY_IDS);
const CUSTOMER_PASSWORDLESS_CHALLENGE_TTL_SECONDS = 10 * 60;
const CUSTOMER_PASSWORDLESS_MAX_CHALLENGE_TTL_SECONDS = 15 * 60;
const CUSTOMER_PASSWORDLESS_MAX_IDLE_TTL_SECONDS = 7 * 24 * 60 * 60;
const CUSTOMER_PASSWORDLESS_MAX_ABSOLUTE_TTL_SECONDS = 30 * 24 * 60 * 60;
const ATTESTATION_REF = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9][a-z0-9-]*)+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownFields(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key));
}

function addUnknownFieldIssues(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: CapabilityManifestIssue[],
): void {
  for (const field of unknownFields(value, allowed)) {
    issues.push({
      path: path ? `${path}.${field}` : field,
      code: 'unknown-field',
      message: `Campo desconocido: ${field}.`,
    });
  }
}

function readDeployment(value: unknown, issues: CapabilityManifestIssue[]): DeploymentConfiguration | null {
  if (!isRecord(value)) {
    issues.push({ path: 'deployment', code: 'invalid-shape', message: 'deployment debe ser un objeto.' });
    return null;
  }
  addUnknownFieldIssues(value, ['id', 'mode', 'environment', 'profile'], 'deployment', issues);
  const { id, mode, environment, profile } = value;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) {
    issues.push({
      path: 'deployment.id',
      code: 'invalid-shape',
      message: 'El id debe tener 3–64 caracteres en minúsculas, números o guiones.',
    });
  }
  if (mode !== 'demo' && mode !== 'client') {
    issues.push({ path: 'deployment.mode', code: 'invalid-shape', message: 'mode debe ser demo o client.' });
  }
  if (environment !== 'development' && environment !== 'preview' && environment !== 'production') {
    issues.push({
      path: 'deployment.environment',
      code: 'invalid-shape',
      message: 'environment debe ser development, preview o production.',
    });
  }
  if (profile !== 'minimal' && profile !== 'standard' && profile !== 'advanced' && profile !== 'custom') {
    issues.push({
      path: 'deployment.profile',
      code: 'invalid-shape',
      message: 'profile debe ser minimal, standard, advanced o custom.',
    });
  }
  if (issues.some((issue) => issue.path.startsWith('deployment'))) return null;
  return {
    id: id as string,
    mode: mode as DeploymentMode,
    environment: environment as DeploymentEnvironment,
    profile: profile as DeploymentConfiguration['profile'],
  };
}

function readFlags(value: unknown, path: string, issues: CapabilityManifestIssue[]): CapabilityFlags | null {
  if (!isRecord(value)) {
    issues.push({ path, code: 'invalid-flags', message: 'Una capacidad activa o degradada exige flags explícitos.' });
    return null;
  }
  addUnknownFieldIssues(value, CAPABILITY_FLAG_NAMES, path, issues);
  for (const flag of CAPABILITY_FLAG_NAMES) {
    if (typeof value[flag] !== 'boolean') {
      issues.push({ path: `${path}.${flag}`, code: 'invalid-flags', message: `${flag} debe ser booleano.` });
    }
  }
  if (issues.some((issue) => issue.path === path || issue.path.startsWith(`${path}.`))) return null;
  return Object.freeze({
    routes: value.routes as boolean,
    navigation: value.navigation as boolean,
    jobs: value.jobs as boolean,
    sideEffects: value.sideEffects as boolean,
  });
}

function isExactHttpsOrigin(value: unknown): value is `https://${string}` {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value;
  } catch {
    return false;
  }
}

function isPositiveIntegerWithin(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function validCustomerPasswordlessConfig(value: Record<string, unknown>): boolean {
  if (
    unknownFields(value, [
      'methods',
      'provider',
      'origin',
      'challengeTtlSeconds',
      'session',
      'secretRefs',
      'rateLimit',
      'tracking',
    ]).length > 0 ||
    !Array.isArray(value.methods) ||
    value.methods.length !== 1 ||
    value.methods[0] !== 'email_magic_link' ||
    value.provider !== 'resend' ||
    !isExactHttpsOrigin(value.origin) ||
    value.challengeTtlSeconds !== CUSTOMER_PASSWORDLESS_CHALLENGE_TTL_SECONDS ||
    value.challengeTtlSeconds > CUSTOMER_PASSWORDLESS_MAX_CHALLENGE_TTL_SECONDS ||
    !Array.isArray(value.secretRefs) ||
    value.secretRefs.length !== 3 ||
    value.secretRefs[0] !== 'CUSTOMER_PROFILE_HMAC_SECRET' ||
    value.secretRefs[1] !== 'CUSTOMER_AUTH_CSRF_SECRET' ||
    value.secretRefs[2] !== 'RESEND_API_KEY'
  ) {
    return false;
  }

  if (
    !isRecord(value.session) ||
    unknownFields(value.session, ['idleTtlSeconds', 'absoluteTtlSeconds']).length > 0 ||
    !isPositiveIntegerWithin(value.session.idleTtlSeconds, CUSTOMER_PASSWORDLESS_MAX_IDLE_TTL_SECONDS) ||
    !isPositiveIntegerWithin(value.session.absoluteTtlSeconds, CUSTOMER_PASSWORDLESS_MAX_ABSOLUTE_TTL_SECONDS) ||
    value.session.idleTtlSeconds > value.session.absoluteTtlSeconds
  ) {
    return false;
  }

  const validRateLimit = isRecord(value.rateLimit) &&
    unknownFields(value.rateLimit, ['enforcement', 'failClosed', 'attestationRef']).length === 0 &&
    value.rateLimit.enforcement === 'edge-durable' &&
    value.rateLimit.failClosed === true &&
    typeof value.rateLimit.attestationRef === 'string' &&
    value.rateLimit.attestationRef.length >= 8 &&
    value.rateLimit.attestationRef.length <= 200 &&
    ATTESTATION_REF.test(value.rateLimit.attestationRef);
  const validTracking = isRecord(value.tracking) &&
    unknownFields(value.tracking, ['click', 'open', 'attestationRef']).length === 0 &&
    value.tracking.click === false && value.tracking.open === false &&
    typeof value.tracking.attestationRef === 'string' &&
    value.tracking.attestationRef.length >= 8 &&
    value.tracking.attestationRef.length <= 200 &&
    ATTESTATION_REF.test(value.tracking.attestationRef);
  return validRateLimit && validTracking;
}

function validConfig(id: ConfiguredCapabilityId, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (id) {
    case 'PLT-004':
      return value.failFast === true && unknownFields(value, ['failFast']).length === 0;
    case 'FUL-001':
      return (
        value.strategy === 'flat-zone' &&
        typeof value.supportsFreeThreshold === 'boolean' &&
        unknownFields(value, ['strategy', 'supportsFreeThreshold']).length === 0
      );
    case 'MKT-001':
      return value.currency === 'EUR' && unknownFields(value, ['currency']).length === 0;
    case 'MKT-002':
      return (
        value.country === 'ES' &&
        value.resolver === 'postal-prefix' &&
        unknownFields(value, ['country', 'resolver']).length === 0
      );
    case 'MAR-003':
      return (
        value.demoDelivery === 'outbox' &&
        value.clientDelivery === 'provider' &&
        unknownFields(value, ['demoDelivery', 'clientDelivery']).length === 0
      );
    case 'INT-001':
      return (
        value.provider === 'stripe-checkout' &&
        Array.isArray(value.secretRefs) &&
        value.secretRefs.length === 2 &&
        value.secretRefs[0] === 'STRIPE_SECRET_KEY' &&
        value.secretRefs[1] === 'STRIPE_WEBHOOK_SECRET' &&
        unknownFields(value, ['provider', 'secretRefs']).length === 0
      );
    case 'INT-002':
      return (
        value.provider === 'resend' &&
        ((value.delivery === 'capture' &&
          !('secretRef' in value) &&
          unknownFields(value, ['provider', 'delivery']).length === 0) ||
          (value.delivery === 'send' &&
            value.secretRef === 'RESEND_API_KEY' &&
            unknownFields(value, ['provider', 'delivery', 'secretRef']).length === 0))
      );
    case 'CUS-003':
      return validCustomerPasswordlessConfig(value);
  }
}

function freezeConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeConfigValue));
  if (!isRecord(value)) return value;
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeConfigValue(item)])),
  );
}

function freezeConfig(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return freezeConfigValue(value) as Readonly<Record<string, unknown>>;
}

function dependencyAccepts(dependentState: CapabilityState, dependencyState: CapabilityState): boolean {
  if (dependentState === 'active') return dependencyState === 'active';
  if (dependentState === 'degraded') return dependencyState === 'active' || dependencyState === 'degraded';
  if (dependentState === 'installed' || dependentState === 'disabled') {
    return dependencyState !== 'absent' && dependencyState !== 'retired';
  }
  return true;
}

function definitionCycleIssues(): CapabilityManifestIssue[] {
  const issues: CapabilityManifestIssue[] = [];
  const state = new Map<CapabilityId, 'visiting' | 'done'>();
  const stack: CapabilityId[] = [];
  const visit = (id: CapabilityId): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const start = stack.indexOf(id);
      issues.push({
        path: `capabilities.${id}`,
        code: 'dependency-cycle',
        message: `Ciclo de dependencias: ${[...stack.slice(start), id].join(' -> ')}.`,
      });
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of CAPABILITY_DEFINITIONS[id].dependencies) visit(dependency);
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of CAPABILITY_IDS) visit(id);
  return issues;
}

function freezeCapabilities(
  entries: Record<CapabilityId, ResolvedCapabilityEntry>,
): Readonly<{ [Id in CapabilityId]: ResolvedCapabilityEntry<Id> }> {
  for (const id of CAPABILITY_IDS) Object.freeze(entries[id]);
  return Object.freeze(entries) as Readonly<{ [Id in CapabilityId]: ResolvedCapabilityEntry<Id> }>;
}

export function validateCapabilityManifest(input: unknown): CapabilityManifestValidation {
  const issues: CapabilityManifestIssue[] = [...definitionCycleIssues()];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: '', code: 'invalid-shape', message: 'El manifest debe ser un objeto.' }] };
  }
  addUnknownFieldIssues(input, ['manifestVersion', 'deployment', 'capabilities'], '', issues);
  if (input.manifestVersion !== 1) {
    issues.push({ path: 'manifestVersion', code: 'invalid-shape', message: 'manifestVersion debe ser 1.' });
  }
  const deployment = readDeployment(input.deployment, issues);
  const rawCapabilities = input.capabilities;
  if (!isRecord(rawCapabilities)) {
    issues.push({ path: 'capabilities', code: 'invalid-shape', message: 'capabilities debe ser un objeto.' });
    return { ok: false, issues };
  }
  for (const id of Object.keys(rawCapabilities)) {
    if (!capabilityIdSet.has(id)) {
      issues.push({ path: `capabilities.${id}`, code: 'unknown-capability', message: `Capacidad desconocida: ${id}.` });
    }
  }

  const resolved = {} as Record<CapabilityId, ResolvedCapabilityEntry>;
  for (const id of CAPABILITY_IDS) {
    const raw = rawCapabilities[id];
    if (raw === undefined) {
      resolved[id] = { id, state: 'absent', flags: DISABLED_FLAGS } as ResolvedCapabilityEntry;
      continue;
    }
    const path = `capabilities.${id}`;
    if (!isRecord(raw)) {
      issues.push({ path, code: 'invalid-shape', message: 'La entrada de capacidad debe ser un objeto.' });
      resolved[id] = { id, state: 'absent', flags: DISABLED_FLAGS } as ResolvedCapabilityEntry;
      continue;
    }
    addUnknownFieldIssues(raw, ['state', 'flags', 'config', 'degradation'], path, issues);
    const state = raw.state;
    if (typeof state !== 'string' || !capabilityStateSet.has(state)) {
      issues.push({ path: `${path}.state`, code: 'invalid-state', message: `Estado inválido para ${id}.` });
      resolved[id] = { id, state: 'absent', flags: DISABLED_FLAGS } as ResolvedCapabilityEntry;
      continue;
    }
    const capabilityState = state as CapabilityState;
    const operational = capabilityState === 'active' || capabilityState === 'degraded';
    const flags = operational ? readFlags(raw.flags, `${path}.flags`, issues) ?? DISABLED_FLAGS : DISABLED_FLAGS;
    if (!operational && raw.flags !== undefined) {
      issues.push({
        path: `${path}.flags`,
        code: 'invalid-flags',
        message: `${capabilityState} no admite flags operativos.`,
      });
    }
    if (flags.navigation && !flags.routes) {
      issues.push({ path: `${path}.flags.navigation`, code: 'invalid-flags', message: 'navigation exige routes=true.' });
    }

    let degradation: Readonly<{ reason: string; fallback: string }> | undefined;
    if (capabilityState === 'degraded') {
      if (
        !isRecord(raw.degradation) ||
        typeof raw.degradation.reason !== 'string' ||
        raw.degradation.reason.trim().length < 3 ||
        typeof raw.degradation.fallback !== 'string' ||
        raw.degradation.fallback.trim().length < 3 ||
        unknownFields(raw.degradation, ['reason', 'fallback']).length > 0
      ) {
        issues.push({
          path: `${path}.degradation`,
          code: 'invalid-degradation',
          message: 'degraded exige reason y fallback explícitos.',
        });
      } else {
        degradation = Object.freeze({ reason: raw.degradation.reason, fallback: raw.degradation.fallback });
      }
    } else if (raw.degradation !== undefined) {
      issues.push({ path: `${path}.degradation`, code: 'invalid-degradation', message: `${capabilityState} no admite degradation.` });
    }

    let config: unknown;
    if (configuredCapabilityIdSet.has(id)) {
      if ((capabilityState === 'active' || capabilityState === 'degraded') && raw.config === undefined) {
        issues.push({ path: `${path}.config`, code: 'invalid-config', message: `${id} exige configuración al estar operativa.` });
      } else if (raw.config !== undefined && !validConfig(id as ConfiguredCapabilityId, raw.config)) {
        issues.push({ path: `${path}.config`, code: 'invalid-config', message: `Configuración inválida para ${id}.` });
      } else {
        config = isRecord(raw.config) ? freezeConfig(raw.config) : raw.config;
      }
    } else if (raw.config !== undefined) {
      issues.push({ path: `${path}.config`, code: 'invalid-config', message: `${id} no admite configuración propia en R1.2.` });
    }
    if (capabilityState === 'absent' && raw.config !== undefined) {
      issues.push({ path: `${path}.config`, code: 'invalid-config', message: 'absent no puede conservar configuración efectiva.' });
    }

    resolved[id] = {
      id,
      state: capabilityState,
      flags,
      ...(config === undefined ? {} : { config }),
      ...(degradation === undefined ? {} : { degradation }),
    } as ResolvedCapabilityEntry;
  }

  for (const id of CAPABILITY_IDS) {
    const entry = resolved[id];
    for (const dependency of CAPABILITY_DEFINITIONS[id].dependencies) {
      const dependencyEntry = resolved[dependency];
      if (!dependencyAccepts(entry.state, dependencyEntry.state)) {
        issues.push({
          path: `capabilities.${id}`,
          code: 'missing-dependency',
          message: `${id} (${entry.state}) exige ${dependency} en un estado compatible; está ${dependencyEntry.state}.`,
        });
      }
    }
  }
  const customerPasswordless = resolved['CUS-003'];
  const emailIntegration = resolved['INT-002'];
  const emailIntegrationConfig = emailIntegration.config as CapabilityConfigById['INT-002'] | undefined;
  if (customerPasswordless.state === 'degraded') {
    issues.push({
      path: 'capabilities.CUS-003.state',
      code: 'invalid-state',
      message: 'CUS-003 no admite degraded hasta definir un fallback de autenticación seguro.',
    });
  }
  if (
    customerPasswordless.state === 'active' &&
    (!customerPasswordless.flags.routes || !customerPasswordless.flags.sideEffects ||
      customerPasswordless.flags.navigation || customerPasswordless.flags.jobs)
  ) {
    issues.push({
      path: 'capabilities.CUS-003.flags',
      code: 'invalid-flags',
      message: 'CUS-003 activa exige solo routes=true y sideEffects=true.',
    });
  }
  if (
    (customerPasswordless.state === 'active' || customerPasswordless.state === 'degraded') &&
    (emailIntegrationConfig?.delivery !== 'send' || !emailIntegration.flags.sideEffects)
  ) {
    issues.push({
      path: 'capabilities.CUS-003.config',
      code: 'invalid-config',
      message: 'CUS-003 exige INT-002 con entrega Resend real, nunca capture.',
    });
  }
  for (const required of ['PLT-001', 'PLT-004'] as const) {
    if (resolved[required].state !== 'active') {
      issues.push({
        path: `capabilities.${required}`,
        code: 'invalid-state',
        message: `${required} debe estar active en todo despliegue.`,
      });
    }
  }

  if (deployment?.mode === 'demo') {
    for (const id of CAPABILITY_IDS) {
      const entry = resolved[id];
      if ((entry.state === 'active' || entry.state === 'degraded') && (entry.flags.jobs || entry.flags.sideEffects)) {
        issues.push({
          path: `capabilities.${id}.flags`,
          code: 'invalid-flags',
          message: 'Un despliegue demo no activa jobs ni efectos comerciales.',
        });
      }
    }
  }

  if (!deployment || issues.length > 0) return { ok: false, issues };
  const manifest: ResolvedCapabilityManifest = Object.freeze({
    manifestVersion: 1,
    deployment: Object.freeze(deployment),
    capabilities: freezeCapabilities(resolved),
  });
  return { ok: true, value: manifest, issues: [] };
}

export class CapabilityManifestError extends Error {
  readonly issues: readonly CapabilityManifestIssue[];

  constructor(issues: readonly CapabilityManifestIssue[]) {
    super(`Capability manifest inválido:\n${issues.map((issue) => `- ${issue.path || '<root>'}: ${issue.message}`).join('\n')}`);
    this.name = 'CapabilityManifestError';
    this.issues = issues;
  }
}

export function resolveCapabilityManifest(input: unknown): ResolvedCapabilityManifest {
  const result = validateCapabilityManifest(input);
  if (!result.ok) throw new CapabilityManifestError(result.issues);
  return result.value;
}
