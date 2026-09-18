import {
  decideJobFailure,
  type ClaimedJobRun,
  type JobDescriptor,
  type JobRunRequest,
} from './contract';

type ClaimedRow = Readonly<{
  run_id: string;
  job_id: string;
  trigger_kind: ClaimedJobRun['triggerKind'];
  scheduled_for: string;
  idempotency_key: string;
  attempt_count: number;
  replay_count: number;
}>;

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function claimed(row: ClaimedRow): ClaimedJobRun {
  return Object.freeze({
    runId: row.run_id,
    jobId: row.job_id,
    triggerKind: row.trigger_kind,
    scheduledFor: row.scheduled_for,
    idempotencyKey: row.idempotency_key,
    attemptCount: row.attempt_count,
    replayCount: row.replay_count,
  });
}

export function createD1JobRunRepository(db: D1Database) {
  return {
    async schedule(
      descriptor: JobDescriptor,
      request: JobRunRequest,
      runId: string,
      now: string,
    ): Promise<boolean> {
      const result = await db.prepare(`
        INSERT OR IGNORE INTO platform_job_runs (
          run_id, job_id, trigger_kind, scheduled_for, idempotency_key,
          available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `).bind(
        runId,
        descriptor.id,
        request.triggerKind,
        request.scheduledFor,
        request.idempotencyKey,
        now,
        now,
        now,
      ).run();
      return result.meta.changes === 1;
    },

    async claim(
      descriptor: JobDescriptor,
      workerId: string,
      now: string,
    ): Promise<ClaimedJobRun | null> {
      const lockEnd = addSeconds(now, descriptor.timeoutSeconds);
      await db.batch([
        db.prepare(`
          UPDATE platform_job_runs
          SET status = 'pending', available_at = ?,
              locked_at = NULL, lock_expires_at = NULL, locked_by = NULL,
              last_error_code = 'job-timeout',
              last_error_message = 'La ejecución agotó su timeout y se reprogramó.',
              updated_at = ?
          WHERE job_id = ? AND status = 'running' AND lock_expires_at <= ?
            AND attempt_count < ?
        `).bind(now, now, descriptor.id, now, descriptor.maxAttempts),
        db.prepare(`
          UPDATE platform_job_runs
          SET status = 'dead', dead_at = ?,
              locked_at = NULL, lock_expires_at = NULL, locked_by = NULL,
              last_error_code = 'job-timeout',
              last_error_message = 'La ejecución agotó su timeout en el último intento.',
              updated_at = ?
          WHERE job_id = ? AND status = 'running' AND lock_expires_at <= ?
            AND attempt_count >= ?
        `).bind(now, now, descriptor.id, now, descriptor.maxAttempts),
        db.prepare(`
          UPDATE platform_job_runs
          SET status = 'running', attempt_count = attempt_count + 1,
              locked_at = ?, lock_expires_at = ?, locked_by = ?, updated_at = ?
          WHERE run_id = (
            SELECT run_id FROM platform_job_runs
            WHERE job_id = ? AND status = 'pending' AND available_at <= ?
              AND attempt_count < ?
            ORDER BY available_at, created_at, run_id
            LIMIT 1
          ) AND status = 'pending'
        `).bind(now, lockEnd, workerId, now, descriptor.id, now, descriptor.maxAttempts),
      ]);
      const row = await db.prepare(`
        SELECT run_id, job_id, trigger_kind, scheduled_for, idempotency_key,
               attempt_count, replay_count
        FROM platform_job_runs
        WHERE job_id = ? AND status = 'running' AND locked_by = ? AND locked_at = ?
        ORDER BY created_at, run_id LIMIT 1
      `).bind(descriptor.id, workerId, now).first<ClaimedRow>();
      return row ? claimed(row) : null;
    },

    async succeed(run: ClaimedJobRun, workerId: string, now: string): Promise<boolean> {
      const result = await db.prepare(`
        UPDATE platform_job_runs
        SET status = 'succeeded', completed_at = ?,
            locked_at = NULL, lock_expires_at = NULL, locked_by = NULL,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?
        WHERE run_id = ? AND status = 'running' AND locked_by = ?
      `).bind(now, now, run.runId, workerId).run();
      return result.meta.changes === 1;
    },

    async fail(
      descriptor: JobDescriptor,
      run: ClaimedJobRun,
      workerId: string,
      now: string,
      error: Readonly<{ code: string; message: string }>,
    ): Promise<'pending' | 'dead' | 'lost-lock'> {
      const decision = decideJobFailure(descriptor, run.attemptCount);
      const result = decision.state === 'dead'
        ? await db.prepare(`
            UPDATE platform_job_runs
            SET status = 'dead', dead_at = ?,
                locked_at = NULL, lock_expires_at = NULL, locked_by = NULL,
                last_error_code = ?, last_error_message = ?, updated_at = ?
            WHERE run_id = ? AND status = 'running' AND locked_by = ?
          `).bind(now, error.code, error.message, now, run.runId, workerId).run()
        : await db.prepare(`
            UPDATE platform_job_runs
            SET status = 'pending', available_at = ?,
                locked_at = NULL, lock_expires_at = NULL, locked_by = NULL,
                last_error_code = ?, last_error_message = ?, updated_at = ?
            WHERE run_id = ? AND status = 'running' AND locked_by = ?
          `).bind(
            addSeconds(now, decision.retryAfterSeconds),
            error.code,
            error.message,
            now,
            run.runId,
            workerId,
          ).run();
      return result.meta.changes === 0 ? 'lost-lock' : decision.state;
    },

    async replayDead(runId: string, now: string): Promise<boolean> {
      const result = await db.prepare(`
        UPDATE platform_job_runs
        SET status = 'pending', attempt_count = 0, replay_count = replay_count + 1,
            available_at = ?, dead_at = NULL,
            locked_at = NULL, lock_expires_at = NULL, locked_by = NULL,
            updated_at = ?
        WHERE run_id = ? AND status = 'dead'
      `).bind(now, now, runId).run();
      return result.meta.changes === 1;
    },

    async purgeSucceeded(now: string, retentionDays: number, limit: number): Promise<number> {
      const cutoff = new Date(Date.parse(now) - retentionDays * 86_400_000).toISOString();
      const result = await db.prepare(`
        DELETE FROM platform_job_runs
        WHERE run_id IN (
          SELECT run_id FROM platform_job_runs
          WHERE status = 'succeeded' AND completed_at < ?
          ORDER BY completed_at, run_id LIMIT ?
        )
      `).bind(cutoff, limit).run();
      return result.meta.changes;
    },
  };
}

export type D1JobRunRepository = ReturnType<typeof createD1JobRunRepository>;
