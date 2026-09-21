-- 008: reconciliation, and one website per URL.
--
-- TWO PROBLEMS, ONE FILE, because the second is why the first was noticed.
--
-- 1. The dashboard's assignment rows were a belief that was never re-verified.
--    Two accounts deleted directly in WP Admin still read as "synced", so the
--    Team Members panel said "everyone is already here" while the site had one
--    user. The SITE is the authority on who exists there; these columns are
--    what lets the hub record that it asked, and what it found.
--
-- 2. Two websites rows carried the same URL, so the picker showed the same site
--    twice — one enrolled, one not. Nothing stopped that from happening.
--
-- Nothing is deleted here. The duplicate is ARCHIVED, which is reversible, and
-- the unique index is partial so an archived row can keep its URL.

-- ---------------------------------------------------------------- assignments

-- What the last reconciliation found. Distinct from `state`, which stays what
-- it has always been: how the last OPERATION went. A role someone changed in WP
-- Admin is drift, not a failed operation, and flattening the two would lose the
-- difference between "we couldn't set this" and "someone else changed it".
alter table website_user_assignments
  add column if not exists drift text,
  add column if not exists drift_detail jsonb,
  add column if not exists last_reconciled_at timestamptz;

-- Absence IS a state: the account this row describes is not on the site any
-- more, so nothing about the last operation is true of it now.
alter table website_user_assignments
  drop constraint if exists website_user_assignments_state_check;
alter table website_user_assignments
  add constraint website_user_assignments_state_check
  check (state in ('pending','processing','synced','linked','updated',
                   'skipped','failed','removing','removed','removed_externally'));

alter table website_user_assignments
  drop constraint if exists website_user_assignments_drift_check;
alter table website_user_assignments
  add constraint website_user_assignments_drift_check
  check (drift is null or drift in ('role_changed_externally','unmanaged_externally'));

create index if not exists wua_drift_idx
  on website_user_assignments (website_id) where drift is not null;
create index if not exists wua_removed_externally_idx
  on website_user_assignments (website_id) where state = 'removed_externally';

-- ------------------------------------------------------------------ websites

-- Archived, not deleted. A site that was added by mistake stops appearing in
-- pickers, stops being checked, stops being counted — and can still be looked
-- at, and can still be brought back, because the row is all still there.
alter table websites add column if not exists archived boolean not null default false;
alter table websites add column if not exists archived_at timestamptz;
alter table websites add column if not exists archived_reason text;

-- THE definition of "the same URL", in one place. The JS side
-- (normalizeWebsiteUrl in src/db.js) must produce the same string, and a test
-- asserts that against this function rather than trusting the two to agree:
--
--   lowercase, drop the scheme, drop a leading "www.", drop the trailing slash
--   and any query or fragment.
--
--   https://WWW.Example.com/  ->  example.com
--   http://example.com        ->  example.com
--   https://example.com/blog/ ->  example.com/blog
--
-- IMMUTABLE so it can be indexed; it reads nothing but its argument.
create or replace function de_normalize_url(u text) returns text
  language sql immutable strict as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(lower(btrim(u)), '^[a-z][a-z0-9+.-]*://', ''),
             '^www\.', ''),
           '[?#].*$', ''),
         '/+$', '')
$$;

-- Resolve the existing duplicates before the index can exist.
--
-- Generic on purpose: it states the RULE rather than naming a row, so it does
-- the right thing on a fresh database (nothing), on production (one pair), and
-- on anyone's local copy. The keeper is the row that is enrolled; failing that
-- the one with the most monitoring history; failing that the oldest.
do $$
declare
  grp record;
  keeper uuid;
  loser uuid;
begin
  for grp in
    select de_normalize_url(url) as norm, array_agg(id) as ids
      from websites where not archived
     group by 1 having count(*) > 1
  loop
    select w.id into keeper
      from websites w
     where w.id = any(grp.ids)
     order by (w.um_key_id is not null) desc,
              (select count(*) from metric_samples m where m.website_id = w.id) desc,
              w.created_at asc
     limit 1;

    foreach loser in array grp.ids loop
      continue when loser = keeper;

      -- Refuse to archive anything that is actually in use. If this fires, the
      -- duplicate is not the abandoned one this was written for and a person
      -- should decide, not a migration.
      if exists (select 1 from website_user_assignments where website_id = loser)
         or exists (select 1 from websites where id = loser and um_key_id is not null) then
        raise exception
          'Website % shares a URL with % but has assignments or an enrollment. Resolve it by hand before this migration can run.',
          loser, keeper;
      end if;

      -- Monitoring telemetry moves to the keeper so the history stays whole.
      -- Nothing with meaning attached to WHICH row it was recorded against
      -- (audit_log, assignments, enrollment codes) is touched.
      update metric_samples set website_id = keeper where website_id = loser;
      update status_events  set website_id = keeper where website_id = loser;

      update websites
         set archived = true,
             archived_at = now(),
             archived_reason = 'Duplicate of ' || keeper || ' (same URL). Archived by migration 008; nothing was deleted.',
             helper_enabled = false
       where id = loser;

      raise notice 'Archived duplicate website % (kept %)', loser, keeper;
    end loop;
  end loop;
end $$;

-- One live website per URL, from here on. Partial, so an archived row may keep
-- the URL it was created with rather than having its data edited to make room.
create unique index if not exists websites_normalized_url_uniq
  on websites (de_normalize_url(url)) where not archived;
