import { JOB_LIMITS, type ClaimedJobRun, type JobDescriptor, type JobRunRequest } from './contract';
import { createD1JobRunRepository } from './d1-job-run-repository';

export type JobHandler = (
  run: ClaimedJobRun,
  signal: AbortSignal,
) => Promise<void>;

export type JobExecutionResult = Readonly<{
  jobId: string;
  runId: string | null;
  status: 'succeeded' | 'pending' | 'dead' | 'duplicate' | 'locked' | 'lost-lock';
}>;

class JobTimeoutError extends Error {
  constructor() {
    super('job-timeout');
    this.name = 'JobTimeoutError';
  }
}

function safeFailure(error: unknown): Readonly<{ code: string; message: string }> {
  const raw = error instanceof JobTimeoutError
    ? 'job-timeout'
    : error instanceof Error
      ? error.name
      : 'job-failed';
  const code = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, JOB_LIMITS.maxErrorCodeLength) || 'job-failed';
  return Object.freeze({
    code,
    message: 'La ejecución falló; revisa el job y su identificador de ejecución.',
  });
}

async function withTimeout(
  handler: JobHandler,
  run: ClaimedJobRun,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new JobTimeoutError());
    }, timeoutMs);
  });
  try {
    await Promise.race([handler(run, controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function executeJob(
  db: D1Database,
  descriptor: JobDescriptor,
  request: JobRunRequest,
  handler: JobHandler,
  options: Readonly<{
    now?: string;
    clock?: () => Date;
    workerId?: string;
    runId?: string;
    timeoutMs?: number;
  }> = {},
): Promise<JobExecutionResult> {
  if (descriptor.trigger.kind !== request.triggerKind) {
    throw new RangeError(`El trigger ${request.triggerKind} no corresponde a ${descriptor.id}.`);
  }
  if (!Number.isFinite(Date.parse(request.scheduledFor)) ||
      request.idempotencyKey.length < 1 || request.idempotencyKey.length > 200) {
    throw new RangeError('Solicitud de job inválida.');
  }
  const clock = options.clock ?? (() => new Date());
  const now = options.now ?? clock().toISOString();
  const workerId = options.workerId ?? `job-worker-${crypto.randomUUID()}`;
  const runId = options.runId ?? `job-run-${crypto.randomUUID()}`;
  const repository = createD1JobRunRepository(db);
  const scheduled = await repository.schedule(descriptor, request, runId, now);
  const run = await repository.claim(descriptor, workerId, now);
  if (!run) return Object.freeze({ jobId: descriptor.id, runId: null, status: scheduled ? 'locked' : 'duplicate' });
  try {
    await withTimeout(handler, run, options.timeoutMs ?? descriptor.timeoutSeconds * 1000);
    const completedAt = clock().toISOString();
    const acknowledged = await repository.succeed(run, workerId, completedAt);
    await repository.purgeSucceeded(
      completedAt,
      JOB_LIMITS.succeededRetentionDays,
      JOB_LIMITS.purgeBatchSize,
    );
    return Object.freeze({ jobId: descriptor.id, runId: run.runId, status: acknowledged ? 'succeeded' : 'lost-lock' });
  } catch (error) {
    const status = await repository.fail(
      descriptor,
      run,
      workerId,
      clock().toISOString(),
      safeFailure(error),
    );
    return Object.freeze({ jobId: descriptor.id, runId: run.runId, status });
  }
}
