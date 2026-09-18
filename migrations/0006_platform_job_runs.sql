-- Ejecuciones duraderas de jobs de plataforma (R1.11; ADR-0011).
-- Aditiva: no modifica datos comerciales ni tablas existentes.

CREATE TABLE platform_job_runs (
  run_id TEXT NOT NULL PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 128),
  job_id TEXT NOT NULL CHECK (length(job_id) BETWEEN 3 AND 128),
  trigger_kind TEXT NOT NULL
    CHECK (trigger_kind IN ('one-off', 'recurring')),
  scheduled_for TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count BETWEEN 0 AND 8),
  replay_count INTEGER NOT NULL DEFAULT 0
    CHECK (replay_count >= 0),
  available_at TEXT NOT NULL,
  locked_at TEXT,
  lock_expires_at TEXT,
  locked_by TEXT,
  completed_at TEXT,
  dead_at TEXT,
  last_error_code TEXT
    CHECK (last_error_code IS NULL OR length(last_error_code) <= 80),
  last_error_message TEXT
    CHECK (last_error_message IS NULL OR length(last_error_message) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'pending' AND locked_at IS NULL AND lock_expires_at IS NULL
      AND locked_by IS NULL AND completed_at IS NULL AND dead_at IS NULL)
    OR
    (status = 'running' AND locked_at IS NOT NULL AND lock_expires_at IS NOT NULL
      AND locked_by IS NOT NULL AND completed_at IS NULL AND dead_at IS NULL)
    OR
    (status = 'succeeded' AND locked_at IS NULL AND lock_expires_at IS NULL
      AND locked_by IS NULL AND completed_at IS NOT NULL AND dead_at IS NULL)
    OR
    (status = 'dead' AND locked_at IS NULL AND lock_expires_at IS NULL
      AND locked_by IS NULL AND completed_at IS NULL AND dead_at IS NOT NULL)
  )
);

CREATE INDEX idx_platform_job_runs_claim
  ON platform_job_runs(job_id, available_at, created_at)
  WHERE status = 'pending';

CREATE INDEX idx_platform_job_runs_lock
  ON platform_job_runs(lock_expires_at, job_id)
  WHERE status = 'running';

CREATE INDEX idx_platform_job_runs_history
  ON platform_job_runs(job_id, scheduled_for DESC, created_at DESC);
