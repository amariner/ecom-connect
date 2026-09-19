-- Recibos de cambios de precio ficticios: reintentar nunca revierte otro cambio.
CREATE TABLE supplier_price_changes (
  idempotency_key TEXT PRIMARY KEY NOT NULL CHECK(length(idempotency_key)=36),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 120),
  before_price_cents INTEGER NOT NULL CHECK(typeof(before_price_cents)='integer' AND before_price_cents BETWEEN 0 AND 1000000),
  before_pvp_cents INTEGER CHECK(before_pvp_cents IS NULL OR
    (typeof(before_pvp_cents)='integer' AND before_pvp_cents>before_price_cents AND before_pvp_cents<=1000000)),
  after_price_cents INTEGER NOT NULL CHECK(typeof(after_price_cents)='integer' AND after_price_cents BETWEEN 0 AND 1000000),
  after_pvp_cents INTEGER CHECK(after_pvp_cents IS NULL OR
    (typeof(after_pvp_cents)='integer' AND after_pvp_cents>after_price_cents AND after_pvp_cents<=1000000)),
  creation_token TEXT NOT NULL,
  created_at TEXT NOT NULL
);
