-- ===========================================================================
-- Digital Elements Site Monitor — database schema (Supabase / PostgreSQL)
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor > New query).
-- ===========================================================================

create extension if not exists "pgcrypto";  -- for gen_random_uuid()

-- ---- Users -----------------------------------------------------------------
-- Identity comes from Google SSO; this table is the allow-list + roles.
-- Only emails present here can sign in. Roles drive permissions.
create table if not exists app_users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  name        text,
  role        text not null default 'seo'
              check (role in ('admin','webdev','seo','publisher','social')),
  theme       text not null default 'dark',   -- 'dark' | 'light' | 'system'
  created_at  timestamptz not null default now(),
  last_login  timestamptz
);

-- ---- Websites --------------------------------------------------------------
create table if not exists websites (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  url               text not null,
  helper_enabled    boolean not null default false,
  helper_endpoint   text,
  helper_token      text,
  expect_cloudflare boolean not null default true,
  expect_ctm        boolean not null default true,
  expect_google_tag boolean not null default true,
  clickup_enabled   boolean not null default false,
  clickup_list_ids  text[] not null default '{}',
  clickup_folder_id text,
  clickup_space_id  text,
  zoho_enabled      boolean not null default false,
  zoho_project_ids  text[] not null default '{}',
  license_key       text unique,
  license_expires_at timestamptz,
  created_by        uuid references app_users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---- Social links (per website) --------------------------------------------
create table if not exists social_links (
  id          uuid primary key default gen_random_uuid(),
  website_id  uuid not null references websites(id) on delete cascade,
  platform    text not null,           -- e.g. Facebook, Instagram, LinkedIn
  url         text not null,
  created_by  uuid references app_users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists social_links_website_idx on social_links(website_id);

-- ---- History: status transitions + metric samples --------------------------
create table if not exists status_events (
  id          uuid primary key default gen_random_uuid(),
  website_id  uuid not null references websites(id) on delete cascade,
  from_status text,
  to_status   text,
  at          timestamptz not null default now()
);
create index if not exists status_events_site_at_idx on status_events(website_id, at);

create table if not exists metric_samples (
  id          uuid primary key default gen_random_uuid(),
  website_id  uuid not null references websites(id) on delete cascade,
  overall     text,
  pagespeed   int,
  ssl_days    int,
  response_ms int,
  at          timestamptz not null default now()
);
create index if not exists metric_samples_site_at_idx on metric_samples(website_id, at);

-- ---- Session store (connect-pg-simple) -------------------------------------
-- Auto-created by the app on first run, but included here for reference.
create table if not exists "session" (
  "sid"    varchar not null collate "default",
  "sess"   json not null,
  "expire" timestamp(6) not null
) with (oids=false);
alter table "session" drop constraint if exists "session_pkey";
alter table "session" add constraint "session_pkey" primary key ("sid") not deferrable initially immediate;
create index if not exists "IDX_session_expire" on "session" ("expire");

-- ===========================================================================
-- Centralized WordPress user management
--
-- Reference only. These tables are created by the ordered migrations in
-- db/migrations/, which the app runs at boot (see src/migrate.js) — you do NOT
-- need to run the statements below by hand. They are reproduced here so this
-- file stays a complete picture of the schema.
-- ===========================================================================

-- Applied-migration ledger.
create table if not exists schema_migrations (
  version    text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
);

-- Teams of internal agency staff. Named "teams" rather than "departments"
-- because Nexus already uses "departments" for the client product catalog.
create table if not exists teams (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text not null unique,
  description     text,
  default_wp_role text not null default 'editor',
  created_by      uuid references app_users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The roster synchronized to client WordPress sites. Separate from app_users,
-- which is the dashboard sign-in allow-list.
create table if not exists staff_users (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  first_name      text,
  last_name       text,
  display_name    text,
  team_id         uuid references teams(id) on delete set null,
  default_wp_role text,
  status          text not null default 'active' check (status in ('active','disabled')),
  app_user_id     uuid references app_users(id) on delete set null,
  domain_override boolean not null default false,
  created_by      uuid references app_users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Administrative action history. before/after are redacted snapshots —
-- secrets and passwords never reach this table.
create table if not exists audit_log (
  id            uuid primary key default gen_random_uuid(),
  actor_user_id uuid references app_users(id) on delete set null,
  actor_email   text,
  action        text not null,
  entity_type   text,
  entity_id     text,
  website_id    uuid references websites(id) on delete set null,
  target_email  text,
  before        jsonb,
  after         jsonb,
  result        text,
  ip            text,
  at            timestamptz not null default now()
);

-- Per-site user-management credential (added to `websites` by migration 003).
-- Separate from the license key so a leaked license key can never authorize a
-- user write, and either can be rotated independently. The secret is stored
-- encrypted (AES-256-GCM under USER_MGMT_ENC_KEY) and never leaves the server.
--   um_key_id, um_secret_enc, um_scopes, um_enrolled_at, um_rotated_at,
--   um_plugin_version, um_api_version, um_caps, um_caps_checked_at, um_caps_error

-- One-time codes a site redeems for its credential. The code itself is stored
-- only as a hash, so this table is useless to anyone who reads it.
create table if not exists um_enrollment_codes (
  id          uuid primary key default gen_random_uuid(),
  website_id  uuid not null references websites(id) on delete cascade,
  code_hash   text not null unique,
  expires_at  timestamptz not null,
  redeemed_at timestamptz,
  redeemed_ip text,
  created_by  uuid references app_users(id) on delete set null,
  created_at  timestamptz not null default now()
);
