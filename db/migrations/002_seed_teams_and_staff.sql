-- ===========================================================================
-- Seed the agency's current teams and staff as DATA.
--
-- This is a starting roster, not a fixed list: teams can be renamed, created
-- and deleted, and staff moved between them, entirely through the UI. Nothing
-- below is referenced by application code.
--
-- Names are intentionally left null — we only know email addresses today, and
-- guessing display names from the local part produces things like "Npappas".
-- The UI falls back to the email local part until an administrator fills them
-- in, which is honest about what we actually know.
--
-- Every insert is conflict-tolerant so re-running against a database that
-- already has some of these rows is a no-op.
-- ===========================================================================

insert into teams (name, slug, description, default_wp_role) values
  ('SEO',             'seo',             'Search engine optimization', 'editor'),
  ('Content',         'content',         'Content writing and editorial', 'editor'),
  ('PPC',             'ppc',             'Paid search and paid social', 'editor'),
  ('Web Development', 'web-development', 'Website build and maintenance', 'editor'),
  ('Admin',           'admin',           'Agency administration', 'editor')
on conflict (slug) do nothing;

insert into staff_users (email, team_id)
select v.email, t.id
from (values
  ('jason@digitalelementsgroup.com',     'seo'),
  ('npappas@digitalelementsgroup.com',   'seo'),
  ('jhaley@digitalelementsgroup.com',    'seo'),
  ('bhalinar@digitalelementsgroup.com',  'seo'),
  ('wsmall@digitalelementsgroup.com',    'seo'),

  ('regan@digitalelementsgroup.com',     'content'),
  ('mwhittle@digitalelementsgroup.com',  'content'),
  ('agill@digitalelementsgroup.com',     'content'),
  ('bpowell@digitalelementsgroup.com',   'content'),

  ('pdemeter@digitalelementsgroup.com',  'ppc'),
  ('jmosher@digitalelementsgroup.com',   'ppc'),
  ('jaguilar@digitalelementsgroup.com',  'ppc'),

  ('groseman@digitalelementsgroup.com',  'web-development'),
  ('ggardner@digitalelementsgroup.com',  'web-development'),
  ('jeff@digitalelementsgroup.com',      'web-development'),

  ('ryan@digitalelementsgroup.com',      'admin'),
  ('danny@digitalelementsgroup.com',     'admin')
) as v(email, team_slug)
join teams t on t.slug = v.team_slug
on conflict (lower(email)) do nothing;

-- Link any staff member who already has a dashboard login to their app_users
-- row, so the two rosters agree from day one.
update staff_users s
set app_user_id = a.id
from app_users a
where lower(a.email) = lower(s.email) and s.app_user_id is null;

-- ---- manageWpUsers grant list ---------------------------------------------
-- The permission is granted to the 'admin' dashboard role AND to the explicit
-- addresses below, so the grant is visible and auditable rather than implied
-- by a role. Editable from the UI; see src/usermgmt/grants.js.
insert into app_settings (key, value)
values ('wp_user_managers',
        'ryan@digitalelementsgroup.com,danny@digitalelementsgroup.com,jeff@digitalelementsgroup.com')
on conflict (key) do nothing;
