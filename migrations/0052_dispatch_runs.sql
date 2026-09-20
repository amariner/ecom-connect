-- Registro de cada ejecución del envío agrupado, manual o programada. El índice
-- parcial impide que dos ejecuciones procesen pendientes a la vez.
CREATE TABLE dispatch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('manual','scheduled')),
  status TEXT NOT NULL CHECK(status IN ('running','completed','skipped','failed')),
  reason TEXT CHECK(reason IS NULL OR reason IN ('paused','overlap','interrupted','unexpected_error')),
  processed INTEGER NOT NULL DEFAULT 0 CHECK(processed >= 0),
  errors INTEGER NOT NULL DEFAULT 0 CHECK(errors >= 0),
  remaining INTEGER NOT NULL DEFAULT 0 CHECK(remaining >= 0),
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX idx_dispatch_runs_running ON dispatch_runs(status) WHERE status='running';
