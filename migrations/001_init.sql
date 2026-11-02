-- Raw events are the source of truth. Everything else can be rebuilt from them.
-- The primary key is the idempotency key: it is scoped to the tenant, so two
-- tenants may use the same event_id without colliding.
CREATE TABLE IF NOT EXISTS events (
  tenant_id        text             NOT NULL,
  event_id         text             NOT NULL,
  view_id          text             NOT NULL,
  ad_id            text             NOT NULL,
  type             text             NOT NULL
                   CHECK (type IN ('first_token', 'render_complete', 'visibility', 'view_end')),
  ts_ms            integer          NOT NULL CHECK (ts_ms >= 0),
  seq              integer          NOT NULL CHECK (seq >= 0),
  visible_fraction double precision CHECK (visible_fraction BETWEEN 0 AND 1),
  body_hash        text             NOT NULL,
  received_at      timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id),
  CHECK ((type = 'visibility') = (visible_fraction IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS events_view_idx ON events (tenant_id, view_id);

-- One row per ad view. Ingestion locks this row before it touches the view's
-- events, which serialises batches that carry events of the same view.
CREATE TABLE IF NOT EXISTS ad_views (
  tenant_id text NOT NULL,
  view_id   text NOT NULL,
  ad_id     text NOT NULL,
  PRIMARY KEY (tenant_id, view_id)
);

CREATE INDEX IF NOT EXISTS ad_views_ad_idx ON ad_views (tenant_id, ad_id);

-- Derived: the verdict of each strategy for each view. Rebuilt from events by
-- the recompute script when a strategy's parameters change.
CREATE TABLE IF NOT EXISTS view_results (
  tenant_id      text    NOT NULL,
  view_id        text    NOT NULL,
  strategy       text    NOT NULL,
  counted        boolean NOT NULL,
  counted_at_ms  integer,
  longest_run_ms integer NOT NULL,
  PRIMARY KEY (tenant_id, view_id, strategy),
  FOREIGN KEY (tenant_id, view_id) REFERENCES ad_views (tenant_id, view_id) ON DELETE CASCADE,
  CHECK (counted = (counted_at_ms IS NOT NULL))
);
