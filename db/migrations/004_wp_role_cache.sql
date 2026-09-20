-- ===========================================================================
-- Per-website WordPress role cache.
--
-- Connected sites do not share a role list: plugins add roles freely
-- (WooCommerce alone adds two), and site owners can restrict what is assignable
-- through get_editable_roles(). So the roles offered for a site have to come
-- from that site, and are cached here so the role picker doesn't make one
-- request per site every time it opens.
--
-- This is a cache, not a source of truth: rows are refreshed from the site and
-- are safe to delete at any time.
-- ===========================================================================

create table if not exists wp_role_cache (
  website_id    uuid not null references websites(id) on delete cascade,
  slug          text not null,
  name          text not null,
  -- Two tiers, because collapsing them makes the flag useless. is_admin_like
  -- covers manage_options, promote_users, edit_users, delete_users AND
  -- unfiltered_html; is_site_admin covers only the first four.
  --
  -- Stock WordPress grants unfiltered_html to EDITOR, which is every team's
  -- default role. A confirmation keyed on the broad flag would therefore fire
  -- on the most common assignment there is, and a confirmation that fires on
  -- the common case is one people learn to click through. The confirmation
  -- keys on is_site_admin; is_admin_like is shown as a lesser notice.
  is_admin_like boolean not null default false,
  is_site_admin boolean not null default false,
  capability_count int not null default 0,
  fetched_at    timestamptz not null default now(),
  primary key (website_id, slug)
);
create index if not exists wp_role_cache_site_idx on wp_role_cache (website_id);

-- The role a site hands out to new users when nothing else is specified.
-- Cached alongside the roles so the picker can show which one is the site's own
-- default.
alter table websites add column if not exists um_default_role text;
alter table websites add column if not exists um_roles_fetched_at timestamptz;
