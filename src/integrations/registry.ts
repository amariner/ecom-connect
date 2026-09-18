import {
  MODULE_REGISTRY,
  type CapabilityId,
  type ModuleId,
  type ModuleRegistry,
  type ResolvedCapabilityManifest,
} from '../platform/configuration';

export const INTEGRATION_IDS = ['stripe-checkout', 'resend-email', 'logistics-csv'] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export const INTEGRATION_STATES = ['inactive', 'active', 'degraded'] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

export const INTEGRATION_HEALTH_STATES = ['not-applicable', 'healthy', 'degraded'] as const;
export type IntegrationHealthState = (typeof INTEGRATION_HEALTH_STATES)[number];

export const INTEGRATION_ERROR_CODES = [
  'configuration.missing',
  'configuration.incomplete',
  'provider.unavailable',
  'provider.rejected',
  'operation.failed',
] as const;
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

type IntegrationDescriptor = Readonly<{
  id: IntegrationId;
  version: `${number}.${number}.${number}`;
  capabilityId: CapabilityId;
  ownerModuleId: ModuleId;
  healthcheckId: string;
  mode: 'hosted-payment' | 'transactional-email' | 'manual-export';
  implementation: string;
}>;

export const INTEGRATION_DESCRIPTORS = [
  {
    id: 'stripe-checkout',
    version: '1.0.0',
    capabilityId: 'INT-001',
    ownerModuleId: 'payments',
    healthcheckId: 'payments.stripe-checkout',
    mode: 'hosted-payment',
    implementation: 'src/lib/stripe.ts',
  },
  {
    id: 'resend-email',
    version: '1.0.0',
    capabilityId: 'INT-002',
    ownerModuleId: 'notifications',
    healthcheckId: 'notifications.resend-email',
    mode: 'transactional-email',
    implementation: 'src/lib/send-email.ts',
  },
  {
    id: 'logistics-csv',
    version: '1.0.0',
    capabilityId: 'INT-003',
    ownerModuleId: 'integrations',
    healthcheckId: 'integrations.logistics-csv',
    mode: 'manual-export',
    implementation: 'src/lib/csv.ts',
  },
] as const satisfies readonly IntegrationDescriptor[];

export type IntegrationRegistryIssue = Readonly<{
  code: 'invalid-descriptor' | 'duplicate-integration' | 'missing-integration' |
    'capability-owner-mismatch' | 'unknown-healthcheck';
  path: string;
  message: string;
}>;

export type IntegrationRegistry = Readonly<{
  descriptors: readonly IntegrationDescriptor[];
  byId: Readonly<Record<IntegrationId, IntegrationDescriptor>>;
}>;

export type IntegrationSecretPresence = Readonly<{
  stripeApiCredential: boolean;
  stripeWebhookCredential: boolean;
  resendApiCredential: boolean;
}>;

export type IntegrationOperationEvidence = Readonly<{
  lastSyncAt: string | null;
  lastError: Readonly<{ code: IntegrationErrorCode; at: string }> | null;
}>;

export type IntegrationEvidence = Readonly<{
  secrets: IntegrationSecretPresence;
  operations?: Readonly<Partial<Record<IntegrationId, IntegrationOperationEvidence>>>;
}>;

type StripeConfiguration = Readonly<{
  checkout: 'hosted';
  webhook: 'signed';
  apiCredentialConfigured: boolean;
  webhookCredentialConfigured: boolean;
}>;

type ResendConfiguration = Readonly<{
  delivery: 'capture' | 'send';
  apiCredentialConfigured: boolean;
}>;

type LogisticsCsvConfiguration = Readonly<{
  delivery: 'manual-export';
  format: 'csv';
  targets: readonly ['packlink-pro', 'sendcloud'];
}>;

export type IntegrationStatus = Readonly<{
  id: IntegrationId;
  capabilityId: CapabilityId;
  state: IntegrationState;
  health: IntegrationHealthState;
  healthcheckId: string;
  configuration: StripeConfiguration | ResendConfiguration | LogisticsCsvConfiguration;
  lastSyncAt: string | null;
  lastError: Readonly<{ code: IntegrationErrorCode; at: string | null }> | null;
}>;

export type IntegrationStatuses = Readonly<{
  all: readonly IntegrationStatus[];
  byId: Readonly<Record<IntegrationId, IntegrationStatus>>;
}>;

const integrationIdSet = new Set<string>(INTEGRATION_IDS);
const expectedContracts = {
  'stripe-checkout': {
    capabilityId: 'INT-001', ownerModuleId: 'payments', healthcheckId: 'payments.stripe-checkout',
    mode: 'hosted-payment', implementation: 'src/lib/stripe.ts',
  },
  'resend-email': {
    capabilityId: 'INT-002', ownerModuleId: 'notifications', healthcheckId: 'notifications.resend-email',
    mode: 'transactional-email', implementation: 'src/lib/send-email.ts',
  },
  'logistics-csv': {
    capabilityId: 'INT-003', ownerModuleId: 'integrations', healthcheckId: 'integrations.logistics-csv',
    mode: 'manual-export', implementation: 'src/lib/csv.ts',
  },
} as const satisfies Readonly<Record<IntegrationId, Omit<IntegrationDescriptor, 'id' | 'version'>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateIntegrationRegistry(
  input: unknown,
  moduleRegistry: ModuleRegistry = MODULE_REGISTRY,
): readonly IntegrationRegistryIssue[] {
  if (!Array.isArray(input)) {
    return [{ code: 'invalid-descriptor', path: 'integrations', message: 'El registro debe ser un array.' }];
  }
  const issues: IntegrationRegistryIssue[] = [];
  const seen = new Set<string>();
  input.forEach((raw, index) => {
    const path = `integrations.${index}`;
    if (!isRecord(raw)) {
      issues.push({ code: 'invalid-descriptor', path, message: 'Descriptor inválido.' });
      return;
    }
    const allowed = ['id', 'version', 'capabilityId', 'ownerModuleId', 'healthcheckId', 'mode', 'implementation'];
    if (Object.keys(raw).some((key) => !allowed.includes(key)) ||
        typeof raw.id !== 'string' || !integrationIdSet.has(raw.id) ||
        typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.version) ||
        typeof raw.capabilityId !== 'string' || typeof raw.ownerModuleId !== 'string' ||
        typeof raw.healthcheckId !== 'string' || typeof raw.mode !== 'string' ||
        typeof raw.implementation !== 'string' || !raw.implementation.startsWith('src/')) {
      issues.push({ code: 'invalid-descriptor', path, message: 'Forma o campos del descriptor inválidos.' });
      return;
    }
    if (seen.has(raw.id)) {
      issues.push({ code: 'duplicate-integration', path: `${path}.id`, message: `Integración duplicada: ${raw.id}.` });
    }
    seen.add(raw.id);
    const expected = expectedContracts[raw.id as IntegrationId];
    if (raw.capabilityId !== expected.capabilityId || raw.ownerModuleId !== expected.ownerModuleId ||
        raw.healthcheckId !== expected.healthcheckId || raw.mode !== expected.mode ||
        raw.implementation !== expected.implementation) {
      issues.push({
        code: 'invalid-descriptor',
        path,
        message: `${raw.id} no coincide con su adaptador real.`,
      });
    }
    if (moduleRegistry.capabilityOwners[raw.capabilityId as CapabilityId] !== raw.ownerModuleId) {
      issues.push({
        code: 'capability-owner-mismatch',
        path: `${path}.ownerModuleId`,
        message: `${raw.ownerModuleId} no posee ${raw.capabilityId}.`,
      });
    }
    if (moduleRegistry.healthcheckOwners[raw.healthcheckId] !== raw.ownerModuleId) {
      issues.push({
        code: 'unknown-healthcheck',
        path: `${path}.healthcheckId`,
        message: `${raw.healthcheckId} no pertenece a ${raw.ownerModuleId}.`,
      });
    }
  });
  for (const id of INTEGRATION_IDS) {
    if (!seen.has(id)) issues.push({ code: 'missing-integration', path: `integrations.${id}`, message: `Falta ${id}.` });
  }
  return issues;
}

export class IntegrationRegistryError extends Error {
  readonly issues: readonly IntegrationRegistryIssue[];

  constructor(issues: readonly IntegrationRegistryIssue[]) {
    super(`Registro de integraciones inválido:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'IntegrationRegistryError';
    this.issues = issues;
  }
}

export function createIntegrationRegistry(
  input: unknown = INTEGRATION_DESCRIPTORS,
  moduleRegistry: ModuleRegistry = MODULE_REGISTRY,
): IntegrationRegistry {
  const issues = validateIntegrationRegistry(input, moduleRegistry);
  if (issues.length > 0) throw new IntegrationRegistryError(issues);
  const descriptors = Object.freeze((input as readonly IntegrationDescriptor[]).map((descriptor) => Object.freeze({ ...descriptor })));
  const byId = Object.freeze(Object.fromEntries(descriptors.map((descriptor) => [descriptor.id, descriptor]))) as
    Readonly<Record<IntegrationId, IntegrationDescriptor>>;
  return Object.freeze({ descriptors, byId });
}

function isOperational(manifest: ResolvedCapabilityManifest, capabilityId: CapabilityId): boolean {
  const state = manifest.capabilities[capabilityId].state;
  return state === 'active' || state === 'degraded';
}

function validTimestamp(value: string | null): boolean {
  return value === null || (!Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value);
}

function operationEvidence(
  id: IntegrationId,
  evidence: IntegrationEvidence,
): IntegrationOperationEvidence {
  const operation = evidence.operations?.[id] ?? { lastSyncAt: null, lastError: null };
  if (!validTimestamp(operation.lastSyncAt) ||
      (operation.lastError !== null && (!INTEGRATION_ERROR_CODES.includes(operation.lastError.code) || !validTimestamp(operation.lastError.at)))) {
    throw new IntegrationRegistryError([{
      code: 'invalid-descriptor',
      path: `evidence.operations.${id}`,
      message: 'La evidencia debe usar timestamps ISO y códigos de error seguros.',
    }]);
  }
  return operation;
}

function statusBase(
  descriptor: IntegrationDescriptor,
  state: IntegrationState,
  health: IntegrationHealthState,
  operation: IntegrationOperationEvidence,
  fallbackError: IntegrationErrorCode | null,
): Omit<IntegrationStatus, 'configuration'> {
  const lastError = operation.lastError ?? (fallbackError === null ? null : { code: fallbackError, at: null });
  return {
    id: descriptor.id,
    capabilityId: descriptor.capabilityId,
    state,
    health,
    healthcheckId: descriptor.healthcheckId,
    lastSyncAt: operation.lastSyncAt,
    lastError: lastError === null ? null : Object.freeze({ ...lastError }),
  };
}

function stripeStatus(
  descriptor: IntegrationDescriptor,
  manifest: ResolvedCapabilityManifest,
  evidence: IntegrationEvidence,
): IntegrationStatus {
  const operation = operationEvidence(descriptor.id, evidence);
  const configuration: StripeConfiguration = Object.freeze({
    checkout: 'hosted',
    webhook: 'signed',
    apiCredentialConfigured: evidence.secrets.stripeApiCredential,
    webhookCredentialConfigured: evidence.secrets.stripeWebhookCredential,
  });
  if (!isOperational(manifest, descriptor.capabilityId) || manifest.deployment.mode === 'demo') {
    return Object.freeze({ ...statusBase(descriptor, 'inactive', 'not-applicable', operation, null), configuration });
  }
  const configured = configuration.apiCredentialConfigured && configuration.webhookCredentialConfigured;
  const partial = configuration.apiCredentialConfigured || configuration.webhookCredentialConfigured;
  const healthy = configured && operation.lastError === null;
  return Object.freeze({
    ...statusBase(
      descriptor,
      healthy ? 'active' : 'degraded',
      healthy ? 'healthy' : 'degraded',
      operation,
      configured ? null : partial ? 'configuration.incomplete' : 'configuration.missing',
    ),
    configuration,
  });
}

function resendStatus(
  descriptor: IntegrationDescriptor,
  manifest: ResolvedCapabilityManifest,
  evidence: IntegrationEvidence,
): IntegrationStatus {
  const operation = operationEvidence(descriptor.id, evidence);
  const config = manifest.capabilities['INT-002'].config;
  const delivery = config?.provider === 'resend' ? config.delivery : 'capture';
  const configuration: ResendConfiguration = Object.freeze({
    delivery,
    apiCredentialConfigured: evidence.secrets.resendApiCredential,
  });
  if (!isOperational(manifest, descriptor.capabilityId) || delivery === 'capture' || manifest.deployment.mode === 'demo') {
    return Object.freeze({ ...statusBase(descriptor, 'inactive', 'not-applicable', operation, null), configuration });
  }
  const configured = configuration.apiCredentialConfigured;
  const healthy = configured && operation.lastError === null;
  return Object.freeze({
    ...statusBase(descriptor, healthy ? 'active' : 'degraded', healthy ? 'healthy' : 'degraded', operation,
      configured ? null : 'configuration.missing'),
    configuration,
  });
}

function logisticsStatus(
  descriptor: IntegrationDescriptor,
  manifest: ResolvedCapabilityManifest,
  evidence: IntegrationEvidence,
): IntegrationStatus {
  const operation = operationEvidence(descriptor.id, evidence);
  const configuration: LogisticsCsvConfiguration = Object.freeze({
    delivery: 'manual-export',
    format: 'csv',
    targets: Object.freeze(['packlink-pro', 'sendcloud'] as const),
  });
  const active = isOperational(manifest, descriptor.capabilityId);
  const healthy = active && operation.lastError === null;
  return Object.freeze({
    ...statusBase(
      descriptor,
      !active ? 'inactive' : healthy ? 'active' : 'degraded',
      !active ? 'not-applicable' : healthy ? 'healthy' : 'degraded',
      operation,
      null,
    ),
    configuration,
  });
}

export function resolveIntegrationStatuses(
  manifest: ResolvedCapabilityManifest,
  evidence: IntegrationEvidence,
  registry: IntegrationRegistry = INTEGRATION_REGISTRY,
): IntegrationStatuses {
  const all = Object.freeze(registry.descriptors.map((descriptor): IntegrationStatus => {
    if (descriptor.id === 'stripe-checkout') return stripeStatus(descriptor, manifest, evidence);
    if (descriptor.id === 'resend-email') return resendStatus(descriptor, manifest, evidence);
    return logisticsStatus(descriptor, manifest, evidence);
  }));
  const byId = Object.freeze(Object.fromEntries(all.map((status) => [status.id, status]))) as
    Readonly<Record<IntegrationId, IntegrationStatus>>;
  return Object.freeze({ all, byId });
}

export const INTEGRATION_REGISTRY = createIntegrationRegistry();
