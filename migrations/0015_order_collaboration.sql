-- R3.2: notas, etiquetas y actividad colaborativa de pedidos.
--
-- Migracion aditiva. `order_events` conserva el historial transaccional; la
-- lectura administrativa compone ambas fuentes sin reescribir hechos previos.

CREATE TABLE order_notes (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL CHECK (visibility IN ('internal', 'customer')),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'system', 'customer', 'provider')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 100),
  actor_label TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE order_note_revisions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  note_id TEXT NOT NULL REFERENCES order_notes(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  visibility TEXT NOT NULL CHECK (visibility IN ('internal', 'customer')),
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'system', 'customer', 'provider')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 100),
  actor_label TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(note_id, version)
);

CREATE TABLE order_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 64 AND slug = lower(slug)),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 80),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE order_tag_assignments (
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES order_tags(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'system', 'customer', 'provider')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 100),
  actor_label TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (order_id, tag_id)
);

CREATE TABLE order_tag_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES order_tags(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('assigned', 'removed')),
  tag_slug_snapshot TEXT NOT NULL,
  tag_label_snapshot TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('admin', 'system', 'customer', 'provider')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 100),
  actor_label TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_order_notes_order_updated
  ON order_notes(order_id, updated_at DESC, id DESC);
CREATE INDEX idx_order_note_revisions_note_version
  ON order_note_revisions(note_id, version DESC);
CREATE INDEX idx_order_note_revisions_order_created
  ON order_note_revisions(order_id, created_at DESC, id DESC);
CREATE INDEX idx_order_tag_assignments_tag_order
  ON order_tag_assignments(tag_id, order_id);
CREATE INDEX idx_order_tag_events_order_created
  ON order_tag_events(order_id, created_at DESC, id DESC);
