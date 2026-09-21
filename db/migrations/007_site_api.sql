-- ===========================================================================
-- The site-initiated API: a connected website calling the hub.
--
-- Until now traffic ran one way — the dashboard signed requests to each site.
-- This adds the reverse direction, so a member of staff already working in a
-- client's WP Admin can add colleagues to THAT site without switching apps.
-- The site never creates anyone itself; it asks the hub, and the hub runs the
-- same de/v2 path it always has.
-- ===========================================================================

-- ---- Two authorities, two columns -----------------------------------------
-- um_scopes is SITE-controlled: the plugin reports what that site's own
-- administrator has allowed (users:admin, users:delete), and every successful
-- capability probe overwrites it. That is what makes the client's kill switch
-- real, in both directions.
--
-- um_hub_scopes is HUB-controlled: permissions the dashboard grants to a site,
-- which the plugin knows nothing about and therefore never reports.
--
-- They are separate columns rather than one merged set on purpose. A probe
-- writes um_scopes wholesale; if plugin:assign lived there it would be wiped by
-- the next probe, and a revoke made in the dashboard would silently come back a
-- few minutes later. Keeping them apart means the persist path *cannot* touch
-- the hub's column, rather than merely remembering not to.
alter table websites add column if not exists um_hub_scopes text[] not null default '{}';

-- Every site already enrolled gets plugin:assign, so sites connected before
-- 2.7.0 work without anyone revisiting them. Granted at enrollment from here
-- on, and revocable per site from the dashboard.
update websites
   set um_hub_scopes = array['plugin:assign']
 where um_key_id is not null
   and not (um_hub_scopes @> array['plugin:assign']);

-- ---- Replay protection for inbound requests --------------------------------
-- The plugin side has had this since 2.6.0 (an options row claimed with
-- add_option). The hub needs its own, because a signature it has already
-- accepted must never be accepted twice.
--
-- The primary key IS the mechanism: an insert that conflicts means the nonce
-- has been seen, so two concurrent replays cannot both win.
create table if not exists site_request_nonces (
  key_id  text        not null,
  nonce   text        not null,
  seen_at timestamptz not null default now(),
  primary key (key_id, nonce)
);
create index if not exists site_request_nonces_seen_idx on site_request_nonces (seen_at);

-- ---- Idempotent jobs -------------------------------------------------------
-- A plugin-initiated assignment is one HTTP request that starts a background
-- job. If that request is retried — a dropped connection, an impatient click —
-- it must return the SAME job rather than starting a second one that assigns
-- everybody twice.
--
-- Partial index so the column stays optional: jobs started from the dashboard
-- carry no key and must not collide with each other on null.
alter table user_sync_jobs add column if not exists idempotency_key text;
create unique index if not exists user_sync_jobs_idempotency_idx
  on user_sync_jobs (idempotency_key) where idempotency_key is not null;

-- Which site a plugin-initiated job belongs to, so a site can be shown its own
-- job and nothing else. Dashboard jobs leave it null.
alter table user_sync_jobs add column if not exists origin_website_id uuid references websites(id) on delete set null;
create index if not exists user_sync_jobs_origin_idx on user_sync_jobs (origin_website_id);
