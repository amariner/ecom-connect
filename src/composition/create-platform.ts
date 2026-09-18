import {
  resolveCapabilityManifest,
  resolveOperationalModules,
  MODULE_REGISTRY,
  type CapabilityFlagName,
  type CapabilityId,
  type CapabilityManifestInput,
  type CapabilityState,
  type ResolvedCapabilityEntry,
  type ResolvedCapabilityManifest,
  type ModuleId,
  type ModuleRegistry,
  type OperationalModule,
} from '../platform/configuration';
import {
  INTEGRATION_REGISTRY,
  IntegrationRegistryError,
  type IntegrationId,
  type IntegrationRegistry,
  validateIntegrationRegistry,
} from '../integrations';
import {
  JOB_DESCRIPTORS,
  createJobRegistry,
  resolveScheduledJobs,
  type JobDescriptor,
  type JobRegistry,
} from '../platform/jobs';

export type Platform = Readonly<{
  manifest: ResolvedCapabilityManifest;
  registry: ModuleRegistry;
  integrationRegistry: IntegrationRegistry;
  jobRegistry: JobRegistry;
  modules: readonly OperationalModule[];
  module: (id: ModuleId) => OperationalModule | null;
  hasModule: (id: ModuleId) => boolean;
  integration: (id: IntegrationId) => IntegrationRegistry['byId'][IntegrationId];
  scheduledJobs: (cron: string) => readonly JobDescriptor[];
  capability: <Id extends CapabilityId>(id: Id) => ResolvedCapabilityEntry<Id>;
  capabilityState: (id: CapabilityId) => CapabilityState;
  isCapabilityActive: (id: CapabilityId) => boolean;
  hasCapabilityFlag: (id: CapabilityId, flag: CapabilityFlagName) => boolean;
}>;

/**
 * Composition root puro: resuelve capacidades y compone solo los módulos que
 * quedan operativos para ese manifiesto.
 */
export function createPlatform(
  input: CapabilityManifestInput,
  registry: ModuleRegistry = MODULE_REGISTRY,
  integrationRegistry: IntegrationRegistry = INTEGRATION_REGISTRY,
): Platform {
  const integrationIssues = validateIntegrationRegistry(integrationRegistry.descriptors, registry);
  if (integrationIssues.length > 0) throw new IntegrationRegistryError(integrationIssues);
  const manifest = resolveCapabilityManifest(input);
  const modules = resolveOperationalModules(registry, manifest);
  const modulesById = new Map(modules.map((module) => [module.descriptor.id, module]));
  const jobRegistry = createJobRegistry(JOB_DESCRIPTORS, registry);
  return Object.freeze({
    manifest,
    registry,
    integrationRegistry,
    jobRegistry,
    modules,
    module: (id: ModuleId): OperationalModule | null => modulesById.get(id) ?? null,
    hasModule: (id: ModuleId): boolean => modulesById.has(id),
    integration: (id: IntegrationId) => integrationRegistry.byId[id],
    scheduledJobs: (cron: string): readonly JobDescriptor[] => resolveScheduledJobs(
      jobRegistry,
      new Set(modulesById.keys()),
      manifest,
      cron,
    ),
    capability: <Id extends CapabilityId>(id: Id): ResolvedCapabilityEntry<Id> => manifest.capabilities[id],
    capabilityState: (id: CapabilityId): CapabilityState => manifest.capabilities[id].state,
    isCapabilityActive: (id: CapabilityId): boolean => manifest.capabilities[id].state === 'active',
    hasCapabilityFlag: (id: CapabilityId, flag: CapabilityFlagName): boolean => {
      const entry = manifest.capabilities[id];
      return (entry.state === 'active' || entry.state === 'degraded') && entry.flags[flag];
    },
  });
}
