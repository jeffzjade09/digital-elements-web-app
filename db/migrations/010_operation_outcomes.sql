-- 010: telling a deletion apart from an unlink.
--
-- Both are "we stopped managing this person here", and until now both finished
-- an operation with status='removed'. They are not the same thing and the
-- difference is the whole point of the pair:
--
--   remove / unlink  the WordPress account stays, with its role, its content
--                    and its access. We simply stop managing it.
--   delete           the WordPress account is gone.
--
-- Reading one word for both meant the dashboard told whoever ran a deletion
-- "No longer managed", which is the unlink sentence. The fact survived in
-- user_sync_operations.result (the plugin returns result:'deleted'), but every
-- screen reads status, so every screen said the softer thing.
--
-- The alternative was deriving it at read time from that result payload. That
-- leaves the column asserting something false and makes each future reader
-- learn the trick; widening the column makes it true instead.
--
-- ADDITIVE. No existing row is rewritten: rows written before this migration
-- keep status='removed' and stay valid, because 'removed' remains in the list.
-- A historical unlink and a historical deletion are genuinely indistinguishable
-- in that column, and backfilling a guess about which one happened would invent
-- history rather than record it. Anything from here on says which it was.

alter table user_sync_operations
  drop constraint if exists user_sync_operations_status_check;
alter table user_sync_operations
  add constraint user_sync_operations_status_check
  check (status in ('pending','processing','synced','linked','updated',
                    'skipped','failed','removed','deleted','interrupted'));

-- Deletions are the rows anyone auditing this system looks for first, and they
-- are a small minority of the table.
create index if not exists user_sync_operations_deleted_idx
  on user_sync_operations (job_id) where status = 'deleted';
