import type { CapabilityId, DeploymentMode, ModuleId } from '../configuration';

export const JOB_TRIGGER_KINDS = ['one-off', 'recurring'] as const;
export type JobTriggerKind = (typeof JOB_TRIGGER_KINDS)[number];

export type JobDescriptor = Readonly<{
  id: `${string}.${string}`;
  moduleId: ModuleId;
  scope: 'deployment-maintenance' | 'capability';
  requiredCapabilityId?: CapabilityId;
  trigger: Readonly<
    | { kind: 'one-off' }
    | { kind: 'recurring'; crons: readonly string[] }
  >;
  modes: readonly DeploymentMode[];
  timeoutSeconds: number;
  maxAttempts: number;
  retryDelaysSeconds: readonly number[];
}>;

export type JobRunRequest = Readonly<{
  triggerKind: JobTriggerKind;
  scheduledFor: string;
  idempotencyKey: string;
}>;

export type ClaimedJobRun = Readonly<{
  runId: string;
  jobId: string;
  triggerKind: JobTriggerKind;
  scheduledFor: string;
  idempotencyKey: string;
  attemptCount: number;
  replayCount: number;
}>;

export type JobFailureDecision = Readonly<
  | { state: 'pending'; retryAfterSeconds: number }
  | { state: 'dead'; retryAfterSeconds: null }
>;

export const JOB_LIMITS = Object.freeze({
  maxAttempts: 8,
  maxTimeoutSeconds: 900,
  maxErrorCodeLength: 80,
  maxErrorMessageLength: 500,
  succeededRetentionDays: 30,
  purgeBatchSize: 100,
});

export function decideJobFailure(
  descriptor: JobDescriptor,
  attemptCount: number,
): JobFailureDecision {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new RangeError('attemptCount debe ser un entero positivo.');
  }
  if (attemptCount >= descriptor.maxAttempts) {
    return Object.freeze({ state: 'dead', retryAfterSeconds: null });
  }
  const retryAfterSeconds = descriptor.retryDelaysSeconds[attemptCount - 1];
  if (retryAfterSeconds === undefined) {
    throw new RangeError('La política no define el backoff del intento.');
  }
  return Object.freeze({ state: 'pending', retryAfterSeconds });
}
