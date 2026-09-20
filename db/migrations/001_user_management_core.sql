-- ===========================================================================
-- Centralized WordPress user management — core entities.
--
-- Naming note: internal agency staff are grouped into TEAMS. The name
-- "departments" is deliberately avoided because the Nexus app already uses it
-- for the client product catalog (web_dev / ppc / seo / social) and the two
-- concepts must not collide when this feature is ported.
--
-- This migration adds the app-side roster only. Nothing here talks to
-- WordPress; per-site assignments, role caching and sync jobs arrive with the
-- phases that actually make plugin calls.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---- Teams ----------------------------------------------------------------
-- default_wp_role is the role a team's members get on a website unless a
-- per-user or per-website override says otherwise. It is seeded to 'editor'
-- for every team on purpose: Administrator is only ever granted through the
-- explicit per-assignment confirmation flow, never inherited from a default.
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
-- Case-insensitive uniqueness without depending on the citext extension.
create unique index if not exists teams_name_lower_idx on teams (lower(name));

-- ---- Staff users ----------------------------------------------------------
-- Deliberately separate from app_users: app_users is the dashboard sign-in
-- allow-list (Google SSO identities with dashboard roles), while staff_users is
-- the roster we synchronize to client WordPress sites. Most staff need a
-- WordPress account without ever signing in to this dashboard. app_user_id
-- links the two when the same person has both.
create table if not exists staff_users (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  first_name      text,
  last_name       text,
  display_name    text,
  team_id         uuid references teams(id) on delete set null,
  default_wp_role text,                       -- per-user override of the team default
  status          text not null default 'active' check (status in ('active','disabled')),
  app_user_id     uuid references app_users(id) on delete set null,
  -- Set when an administrator explicitly allowed an address outside the agency
  -- domain. Recorded so the exception stays visible, not just audited once.
  domain_override boolean not null default false,
  created_by      uuid references app_users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists staff_users_email_lower_idx on staff_users (lower(email));
create index if not exists staff_users_team_idx on staff_users (team_id);

-- ---- Audit log ------------------------------------------------------------
-- Generic on purpose: every administrative action in this feature writes here,
-- and nothing about the shape is user-management specific, so other areas of
-- the app can adopt it later. before/after hold redacted snapshots — secrets
-- and passwords never reach this table (see src/usermgmt/audit.js).
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
create index if not exists audit_log_at_idx on audit_log (at desc);
create index if not exists audit_log_entity_idx on audit_log (entity_type, entity_id);
create index if not exists audit_log_website_idx on audit_log (website_id, at desc);
