-- ===========================================================================
-- Website assignments, and the jobs that apply them.
--
-- Three tables, with distinct jobs:
--
--   website_user_assignments — the intended state. One row per person per site,
--     surviving every job, so "who should have what, where" is answerable
--     without replaying history.
--
--   user_sync_jobs — one administrator action ("add these five people to these
--     three sites"), for the progress view and the audit trail.
--
--   user_sync_operations — one unit of work: one person on one site. This is
--     the level retries happen at, and the level the idempotency key is derived
--     from, so a retry of a partially applied job cannot double-apply anything.
--
-- Operations live here rather than in memory specifically so a process restart
-- mid-job is recoverable: anything left 'processing' is swept to 'interrupted'
-- on boot and can be retried safely.
-- ===========================================================================

-- ---- Intended state --------------------------------------------------------
create table if not exists website_user_assignments (
  id             uuid primary key default gen_random_uuid(),
  staff_user_id  uuid not null references staff_users(id) on delete cascade,
  website_id     uuid not null references websites(id) on delete cascade,
  wp_role        text not null,
  wp_user_id     int,
  wp_user_login  text,
  -- Mapped 1:1 to what the UI shows and what a sync operation reports, so the
  -- review screen, the progress view and this table all speak one vocabulary.
  state          text not null default 'pending'
                 check (state in ('pending','processing','synced','linked','updated',
                                  'skipped','failed','removing','removed')),
  -- False once an account has been unlinked: it still exists on the site, we
  -- simply no longer manage it. Deleting the WordPress account is a separate,
  -- guarded operation.
  managed        boolean not null default true,
  last_result    jsonb,
  last_error     text,
  last_error_code text,
  last_synced_at timestamptz,
  created_by     uuid references app_users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (staff_user_id, website_id)
);
create index if not exists wua_website_idx on website_user_assignments (website_id);
create index if not exists wua_state_idx on website_user_assignments (state);

-- ---- Jobs ------------------------------------------------------------------
create table if not exists user_sync_jobs (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('assign','remove','update_role','reassign_content','delete')),
  initiated_by    uuid references app_users(id) on delete set null,
  initiated_email text,
  params          jsonb not null default '{}'::jsonb,
  status          text not null default 'queued'
                  check (status in ('queued','running','done','partial','failed','interrupted')),
  totals          jsonb,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
create index if not exists user_sync_jobs_created_idx on user_sync_jobs (created_at desc);

-- ---- Operations ------------------------------------------------------------
create table if not exists user_sync_operations (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references user_sync_jobs(id) on delete cascade,
  website_id      uuid references websites(id) on delete set null,
  staff_user_id   uuid references staff_users(id) on delete set null,
  action          text not null,
  -- Derived from (job, website, person, action), so it is stable across every
  -- retry of the same unit of work. That stability is what makes a retry safe:
  -- the site replays its stored result instead of applying the change twice.
  idempotency_key text not null unique,
  status          text not null default 'pending'
                  check (status in ('pending','processing','synced','linked','updated',
                                    'skipped','failed','removed','interrupted')),
  attempt         int not null default 0,
  requested_role  text,
  result          jsonb,
  error_code      text,
  error           text,
  warnings        jsonb,
  started_at      timestamptz,
  finished_at     timestamptz
);
create index if not exists user_sync_operations_job_idx on user_sync_operations (job_id);
create index if not exists user_sync_operations_status_idx on user_sync_operations (status);
