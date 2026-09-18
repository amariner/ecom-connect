-- R4.10: suscripciones detrás de un adaptador verificable.
-- Expand-only: no altera ni elimina tablas previas y no crea planes comerciales.

CREATE TABLE subscription_plans (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 120),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'active', 'paused', 'archived')),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 2 AND 120),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  interval_unit TEXT NOT NULL CHECK (interval_unit IN ('day', 'week', 'month', 'year')),
  interval_count INTEGER NOT NULL CHECK (
    typeof(interval_count) = 'integer' AND interval_count BETWEEN 1 AND 365
  ),
  provider_adapter TEXT NOT NULL CHECK (length(trim(provider_adapter)) BETWEEN 2 AND 80),
  provider_plan_reference TEXT CHECK (
    provider_plan_reference IS NULL OR length(trim(provider_plan_reference)) BETWEEN 2 AND 200
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_subscription_plans_provider_reference
  ON subscription_plans(provider_adapter, provider_plan_reference)
  WHERE provider_plan_reference IS NOT NULL;
CREATE INDEX idx_subscription_plans_variant
  ON subscription_plans(variant_id, state, id);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 120),
  plan_id TEXT NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  provider_adapter TEXT NOT NULL CHECK (length(trim(provider_adapter)) BETWEEN 2 AND 80),
  provider_subscription_reference TEXT NOT NULL
    CHECK (length(trim(provider_subscription_reference)) BETWEEN 2 AND 200),
  provider_customer_reference TEXT NOT NULL
    CHECK (length(trim(provider_customer_reference)) BETWEEN 2 AND 200),
  contact_email TEXT NOT NULL CHECK (
    length(trim(contact_email)) BETWEEN 3 AND 254 AND instr(contact_email, '@') > 1
  ),
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 10000),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'active', 'paused', 'past_due', 'cancel_at_period_end', 'cancelled'
  )),
  plan_snapshot_json TEXT NOT NULL CHECK (json_valid(plan_snapshot_json)),
  current_period_starts_at TEXT,
  current_period_ends_at TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  failed_payment_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_payment_count >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_adapter, provider_subscription_reference),
  CHECK (current_period_ends_at IS NULL OR current_period_starts_at IS NOT NULL),
  CHECK (status = 'cancel_at_period_end' OR cancel_at_period_end = 0),
  CHECK ((status = 'cancelled' AND cancelled_at IS NOT NULL)
    OR (status <> 'cancelled' AND cancelled_at IS NULL))
);

CREATE INDEX idx_subscriptions_status
  ON subscriptions(status, current_period_ends_at, id);
CREATE INDEX idx_subscriptions_contact
  ON subscriptions(contact_email, status, id);

CREATE TABLE subscription_provider_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_adapter TEXT NOT NULL CHECK (length(trim(provider_adapter)) BETWEEN 2 AND 80),
  provider_event_reference TEXT NOT NULL
    CHECK (length(trim(provider_event_reference)) BETWEEN 2 AND 200),
  provider_subscription_reference TEXT NOT NULL
    CHECK (length(trim(provider_subscription_reference)) BETWEEN 2 AND 200),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'subscription_created', 'subscription_activated', 'payment_succeeded',
    'payment_failed', 'subscription_paused', 'subscription_resumed',
    'plan_changed', 'cancellation_scheduled', 'subscription_cancelled'
  )),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  UNIQUE (provider_adapter, provider_event_reference)
);

CREATE INDEX idx_subscription_provider_events_subscription
  ON subscription_provider_events(provider_adapter, provider_subscription_reference, occurred_at, id);

CREATE TABLE subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  provider_event_id INTEGER NOT NULL UNIQUE
    REFERENCES subscription_provider_events(id) ON DELETE RESTRICT,
  transition TEXT NOT NULL CHECK (transition IN (
    'activated', 'payment_succeeded', 'payment_failed', 'paused', 'resumed',
    'plan_changed', 'cancellation_scheduled', 'cancelled'
  )),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  plan_id_after TEXT NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  plan_version_after INTEGER NOT NULL CHECK (plan_version_after >= 1),
  failed_payment_count_after INTEGER NOT NULL CHECK (failed_payment_count_after >= 0),
  current_period_starts_at_after TEXT,
  current_period_ends_at_after TEXT,
  version_after INTEGER NOT NULL CHECK (version_after >= 2),
  occurred_at TEXT NOT NULL,
  UNIQUE (subscription_id, version_after)
);

CREATE INDEX idx_subscription_events_subscription
  ON subscription_events(subscription_id, version_after, id);

CREATE TABLE subscription_cycles (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 8 AND 160),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  provider_cycle_reference TEXT NOT NULL
    CHECK (length(trim(provider_cycle_reference)) BETWEEN 2 AND 200),
  status TEXT NOT NULL CHECK (status IN ('paid', 'failed')),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  attempt_count INTEGER NOT NULL CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 1),
  failure_code TEXT CHECK (
    failure_code IS NULL OR length(trim(failure_code)) BETWEEN 2 AND 80
  ),
  period_starts_at TEXT NOT NULL,
  period_ends_at TEXT NOT NULL,
  provider_event_id INTEGER NOT NULL UNIQUE
    REFERENCES subscription_provider_events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (subscription_id, provider_cycle_reference),
  CHECK ((status = 'paid' AND failure_code IS NULL)
    OR (status = 'failed' AND failure_code IS NOT NULL))
);

CREATE INDEX idx_subscription_cycles_subscription
  ON subscription_cycles(subscription_id, period_starts_at, id);

-- El snapshot comercial pertenece al plan observado; el adaptador solo conserva
-- referencias opacas. Ningún dato de tarjeta entra en estas tablas.
CREATE TRIGGER subscription_insert_guard
BEFORE INSERT ON subscriptions
BEGIN
  SELECT RAISE(ABORT, 'subscription_insert_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM subscription_plans plan
    WHERE plan.id = NEW.plan_id
      AND plan.version = NEW.plan_version
      AND plan.variant_id = NEW.variant_id
      AND plan.provider_adapter = NEW.provider_adapter
      AND plan.state IN ('active', 'paused')
      AND json_extract(NEW.plan_snapshot_json, '$.schema') = 1
      AND json_extract(NEW.plan_snapshot_json, '$.plan_id') = NEW.plan_id
      AND json_extract(NEW.plan_snapshot_json, '$.plan_version') = NEW.plan_version
      AND json_extract(NEW.plan_snapshot_json, '$.variant_id') = NEW.variant_id
      AND json_extract(NEW.plan_snapshot_json, '$.amount_cents') = plan.amount_cents
      AND json_extract(NEW.plan_snapshot_json, '$.currency') = plan.currency
      AND json_extract(NEW.plan_snapshot_json, '$.interval_unit') = plan.interval_unit
      AND json_extract(NEW.plan_snapshot_json, '$.interval_count') = plan.interval_count
  );
END;

-- Cada hecho verificado ocupa exactamente la siguiente versión y proyecta una
-- transición admitida. Un replay o lectura obsoleta aborta toda la batch.
CREATE TRIGGER subscription_event_insert_guard
BEFORE INSERT ON subscription_events
BEGIN
  SELECT RAISE(ABORT, 'subscription_event_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM subscriptions subscription
    JOIN subscription_provider_events provider_event ON provider_event.id = NEW.provider_event_id
    JOIN subscription_plans plan ON plan.id = NEW.plan_id_after
    WHERE subscription.id = NEW.subscription_id
      AND subscription.status = NEW.from_status
      AND subscription.version + 1 = NEW.version_after
      AND subscription.provider_adapter = provider_event.provider_adapter
      AND subscription.provider_subscription_reference = provider_event.provider_subscription_reference
      AND plan.version = NEW.plan_version_after
      AND plan.variant_id = subscription.variant_id
      AND plan.provider_adapter = subscription.provider_adapter
      AND (
        (NEW.transition = 'activated' AND NEW.from_status IN ('pending', 'past_due')
          AND NEW.to_status = 'active')
        OR (NEW.transition = 'payment_succeeded' AND NEW.from_status IN ('active', 'past_due')
          AND NEW.to_status = 'active' AND NEW.failed_payment_count_after = 0)
        OR (NEW.transition = 'payment_failed' AND NEW.from_status IN ('active', 'past_due')
          AND NEW.to_status = 'past_due'
          AND NEW.failed_payment_count_after = subscription.failed_payment_count + 1)
        OR (NEW.transition = 'paused' AND NEW.from_status IN ('active', 'past_due')
          AND NEW.to_status = 'paused')
        OR (NEW.transition = 'resumed' AND NEW.from_status = 'paused'
          AND NEW.to_status = 'active')
        OR (NEW.transition = 'plan_changed' AND NEW.from_status IN ('active', 'paused', 'past_due')
          AND NEW.to_status = NEW.from_status)
        OR (NEW.transition = 'cancellation_scheduled'
          AND NEW.from_status IN ('active', 'paused', 'past_due')
          AND NEW.to_status = 'cancel_at_period_end')
        OR (NEW.transition = 'cancelled' AND NEW.from_status <> 'cancelled'
          AND NEW.to_status = 'cancelled')
      )
  );
END;

-- Un ciclo económico solo puede provenir de un hecho de pago verificado y usa
-- el importe/moneda del snapshot congelado, nunca del navegador.
CREATE TRIGGER subscription_cycle_insert_guard
BEFORE INSERT ON subscription_cycles
BEGIN
  SELECT RAISE(ABORT, 'subscription_cycle_conflict')
  WHERE NOT EXISTS (
    SELECT 1
    FROM subscriptions subscription
    JOIN subscription_provider_events provider_event ON provider_event.id = NEW.provider_event_id
    WHERE subscription.id = NEW.subscription_id
      AND subscription.provider_adapter = provider_event.provider_adapter
      AND subscription.provider_subscription_reference = provider_event.provider_subscription_reference
      AND provider_event.event_type = CASE NEW.status
        WHEN 'paid' THEN 'payment_succeeded' ELSE 'payment_failed' END
      AND NEW.amount_cents = json_extract(subscription.plan_snapshot_json, '$.amount_cents')
        * subscription.quantity
      AND NEW.currency = json_extract(subscription.plan_snapshot_json, '$.currency')
  );
END;
