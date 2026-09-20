-- ===========================================================================
-- Per-website user-management credential.
--
-- The license key stays exactly as it is: it authorizes the read-only
-- monitoring endpoints and nothing else. User writes get a separate, scoped
-- credential so a leaked license key can never create an Administrator on a
-- client site, and either can be rotated without disturbing the other.
--
-- The secret is stored encrypted (AES-256-GCM under USER_MGMT_ENC_KEY) and is
-- never returned by any API. um_key_id is the public half, safe to display.
-- ===========================================================================

alter table websites add column if not exists um_key_id text;
alter table websites add column if not exists um_secret_enc text;
alter table websites add column if not exists um_scopes text[] not null default '{}';
alter table websites add column if not exists um_enrolled_at timestamptz;
alter table websites add column if not exists um_rotated_at timestamptz;

-- Cached answer from the site's capabilities probe, so the UI can show which
-- sites are ready without re-asking every site on every page load.
alter table websites add column if not exists um_plugin_version text;
alter table websites add column if not exists um_api_version int;
alter table websites add column if not exists um_caps text[] not null default '{}';
alter table websites add column if not exists um_caps_checked_at timestamptz;
alter table websites add column if not exists um_caps_error text;

create unique index if not exists websites_um_key_id_idx on websites (um_key_id);

-- ---- Enrollment codes ------------------------------------------------------
-- A site opts in to user management by a WP admin pasting a short-lived code
-- into the DE Monitoring panel; the plugin redeems it for the secret over TLS.
-- The code is stored as a hash so the table is useless to anyone who reads it,
-- and each code is single-use and short-lived.
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
create index if not exists um_enrollment_codes_site_idx on um_enrollment_codes (website_id, created_at desc);
create index if not exists um_enrollment_codes_expiry_idx on um_enrollment_codes (expires_at);
