import type {
  CapabilityId,
  ModuleId,
  ModuleRegistry,
  ResolvedCapabilityManifest,
} from '../configuration';
import { JOB_LIMITS, type JobDescriptor } from './contract';

const RETRIES = Object.freeze([30, 120, 600, 1_800] as const);

export const JOB_DESCRIPTORS = [
  {
    id: 'platform-configuration.demo-order-refresh',
    moduleId: 'platform-configuration',
    scope: 'deployment-maintenance',
    trigger: { kind: 'recurring', crons: ['17 3 * * 1'] },
    modes: ['demo'],
    timeoutSeconds: 60,
    maxAttempts: 5,
    retryDelaysSeconds: RETRIES,
  },
  {
    id: 'notifications.event-outbox-sweep',
    moduleId: 'notifications',
    scope: 'capability',
    requiredCapabilityId: 'AUT-002',
    trigger: { kind: 'recurring', crons: ['*/5 * * * *'] },
    modes: ['client'],
    timeoutSeconds: 120,
    maxAttempts: 5,
    retryDelaysSeconds: RETRIES,
  },
  {
    id: 'inventory.expire-reservations',
    moduleId: 'inventory',
    scope: 'capability',
    requiredCapabilityId: 'INV-004',
    trigger: { kind: 'recurring', crons: ['*/1 * * * *'] },
    modes: ['client'],
    timeoutSeconds: 120,
    maxAttempts: 5,
    retryDelaysSeconds: RETRIES,
  },
  {
    id: 'orders.execute-bulk-action',
    moduleId: 'orders',
    scope: 'capability',
    requiredCapabilityId: 'ORD-011',
    trigger: { kind: 'one-off' },
    modes: ['client'],
    timeoutSeconds: 120,
    maxAttempts: 5,
    retryDelaysSeconds: RETRIES,
  },
] as const satisfies readonly JobDescriptor[];

export type JobId = (typeof JOB_DESCRIPTORS)[number]['id'];

export type JobRegistryIssue = Readonly<{
  code: 'invalid-descriptor' | 'duplicate-job' | 'unknown-owner' | 'owner-mismatch' |
    'unknown-capability' | 'capability-owner-mismatch' | 'undeclared-job' | 'duplicate-cron';
  path: string;
  message: string;
}>;

export type JobRegistry = Readonly<{
  descriptors: readonly JobDescriptor[];
  byId: Readonly<Record<JobId, JobDescriptor>>;
}>;

const JOB_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function validateJobRegistry(
  input: unknown,
  modules: ModuleRegistry,
): readonly JobRegistryIssue[] {
  if (!Array.isArray(input)) {
    return [{ code: 'invalid-descriptor', path: 'jobs', message: 'El registro debe ser un array.' }];
  }
  const issues: JobRegistryIssue[] = [];
  const seen = new Set<string>();
  const declared = new Set(modules.descriptors.flatMap((module) => module.jobs));
  const cronOwners = new Map<string, string>();

  input.forEach((raw, index) => {
    const path = `jobs.${index}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      issues.push({ code: 'invalid-descriptor', path, message: 'Descriptor inválido.' });
      return;
    }
    const descriptor = raw as Partial<JobDescriptor>;
    const allowedFields = new Set([
      'id', 'moduleId', 'scope', 'requiredCapabilityId', 'trigger', 'modes',
      'timeoutSeconds', 'maxAttempts', 'retryDelaysSeconds',
    ]);
    if (Object.keys(raw).some((field) => !allowedFields.has(field))) {
      issues.push({ code: 'invalid-descriptor', path, message: 'El descriptor contiene campos desconocidos.' });
    }
    const id = descriptor.id;
    if (typeof id !== 'string' || !JOB_ID_PATTERN.test(id)) {
      issues.push({ code: 'invalid-descriptor', path: `${path}.id`, message: 'Id de job inválido.' });
      return;
    }
    if (seen.has(id)) issues.push({ code: 'duplicate-job', path: `${path}.id`, message: `Job duplicado: ${id}.` });
    seen.add(id);
    if (!descriptor.moduleId || !(descriptor.moduleId in modules.byId)) {
      issues.push({ code: 'unknown-owner', path: `${path}.moduleId`, message: 'Módulo propietario desconocido.' });
    } else {
      const moduleId = descriptor.moduleId as ModuleId;
      if (!id.startsWith(`${moduleId}.`)) {
        issues.push({ code: 'owner-mismatch', path: `${path}.id`, message: `${id} no pertenece a ${moduleId}.` });
      }
      if (!modules.byId[moduleId].jobs.includes(id)) {
        issues.push({ code: 'undeclared-job', path: `${path}.id`, message: `${moduleId} no declara ${id}.` });
      }
    }
    if (descriptor.scope !== 'deployment-maintenance' && descriptor.scope !== 'capability') {
      issues.push({ code: 'invalid-descriptor', path: `${path}.scope`, message: 'Scope de job inválido.' });
    }
    if (descriptor.scope === 'capability') {
      const capability = descriptor.requiredCapabilityId;
      if (!capability || !(capability in modules.capabilityOwners)) {
        issues.push({ code: 'unknown-capability', path: `${path}.requiredCapabilityId`, message: 'Capacidad requerida desconocida.' });
      } else if (modules.capabilityOwners[capability] !== descriptor.moduleId) {
        issues.push({
          code: 'capability-owner-mismatch', path: `${path}.requiredCapabilityId`,
          message: `${capability} no pertenece a ${String(descriptor.moduleId)}.`,
        });
      }
    } else if (descriptor.requiredCapabilityId !== undefined) {
      issues.push({ code: 'invalid-descriptor', path: `${path}.requiredCapabilityId`, message: 'Un job de despliegue no exige capacidad.' });
    }
    if (!Array.isArray(descriptor.modes) || descriptor.modes.length === 0 ||
        descriptor.modes.some((mode) => mode !== 'demo' && mode !== 'client')) {
      issues.push({ code: 'invalid-descriptor', path: `${path}.modes`, message: 'El job exige al menos un modo válido.' });
    }
    if (!isPositiveInteger(descriptor.timeoutSeconds) || descriptor.timeoutSeconds > JOB_LIMITS.maxTimeoutSeconds) {
      issues.push({ code: 'invalid-descriptor', path: `${path}.timeoutSeconds`, message: 'Timeout fuera de límites.' });
    }
    if (!isPositiveInteger(descriptor.maxAttempts) || descriptor.maxAttempts > JOB_LIMITS.maxAttempts) {
      issues.push({ code: 'invalid-descriptor', path: `${path}.maxAttempts`, message: 'Número de intentos fuera de límites.' });
    }
    if (!Array.isArray(descriptor.retryDelaysSeconds) ||
        descriptor.retryDelaysSeconds.length !== Number(descriptor.maxAttempts) - 1 ||
        descriptor.retryDelaysSeconds.some((seconds) => !isPositiveInteger(seconds))) {
      issues.push({ code: 'invalid-descriptor', path: `${path}.retryDelaysSeconds`, message: 'La política exige un backoff por reintento.' });
    }
    const trigger = descriptor.trigger;
    if (!trigger || (trigger.kind !== 'one-off' && trigger.kind !== 'recurring')) {
      issues.push({ code: 'invalid-descriptor', path: `${path}.trigger`, message: 'Trigger inválido.' });
    } else if (trigger.kind === 'recurring') {
      if (Object.keys(trigger).some((field) => field !== 'kind' && field !== 'crons')) {
        issues.push({ code: 'invalid-descriptor', path: `${path}.trigger`, message: 'El trigger contiene campos desconocidos.' });
      }
      if (!Array.isArray(trigger.crons) || trigger.crons.length === 0 ||
          trigger.crons.some((cron) => typeof cron !== 'string' || cron.trim().length === 0)) {
        issues.push({ code: 'invalid-descriptor', path: `${path}.trigger.crons`, message: 'Un job recurrente exige crons.' });
      } else {
        for (const cron of trigger.crons) {
          const key = `${cron}:${(descriptor.modes ?? []).toSorted().join(',')}`;
          const owner = cronOwners.get(key);
          if (owner && owner !== id) {
            issues.push({ code: 'duplicate-cron', path: `${path}.trigger.crons`, message: `${cron} ya activa ${owner} en los mismos modos.` });
          } else cronOwners.set(key, id);
        }
      }
    } else if (Object.keys(trigger).some((field) => field !== 'kind')) {
      issues.push({ code: 'invalid-descriptor', path: `${path}.trigger`, message: 'Un job único solo declara kind.' });
    }
  });

  for (const job of declared) {
    if (!seen.has(job)) issues.push({ code: 'undeclared-job', path: `modules.${modules.jobOwners[job]}.jobs`, message: `${job} no tiene descriptor ejecutable.` });
  }
  return issues;
}

export class JobRegistryError extends Error {
  readonly issues: readonly JobRegistryIssue[];

  constructor(issues: readonly JobRegistryIssue[]) {
    super(`Registro de jobs inválido:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'JobRegistryError';
    this.issues = issues;
  }
}

export function createJobRegistry(
  input: unknown,
  modules: ModuleRegistry,
): JobRegistry {
  const issues = validateJobRegistry(input, modules);
  if (issues.length > 0) throw new JobRegistryError(issues);
  const descriptors = Object.freeze((input as readonly JobDescriptor[]).map((descriptor) => Object.freeze({
    ...descriptor,
    trigger: Object.freeze(descriptor.trigger.kind === 'recurring'
      ? { ...descriptor.trigger, crons: Object.freeze([...descriptor.trigger.crons]) }
      : { ...descriptor.trigger }),
    modes: Object.freeze([...descriptor.modes]),
    retryDelaysSeconds: Object.freeze([...descriptor.retryDelaysSeconds]),
  })));
  const byId = Object.freeze(Object.fromEntries(descriptors.map((descriptor) => [descriptor.id, descriptor]))) as Readonly<Record<JobId, JobDescriptor>>;
  return Object.freeze({ descriptors, byId });
}

export function resolveScheduledJobs(
  registry: JobRegistry,
  operationalModuleIds: ReadonlySet<ModuleId>,
  manifest: ResolvedCapabilityManifest,
  cron: string,
): readonly JobDescriptor[] {
  return Object.freeze(registry.descriptors.filter((descriptor) => {
    if (!operationalModuleIds.has(descriptor.moduleId)) return false;
    if (!descriptor.modes.includes(manifest.deployment.mode)) return false;
    if (descriptor.trigger.kind !== 'recurring' || !descriptor.trigger.crons.includes(cron)) return false;
    if (descriptor.scope === 'deployment-maintenance') return true;
    const capabilityId = descriptor.requiredCapabilityId as CapabilityId;
    const capability = manifest.capabilities[capabilityId];
    return (capability.state === 'active' || capability.state === 'degraded') && capability.flags.jobs;
  }));
}
