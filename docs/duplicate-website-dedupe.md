# The duplicate "Digital Elements Corp Site"

Investigated 22 September 2026, read-only, against production.

## What is actually there

Two `websites` rows carry the same URL, `https://digitalelementsgroup.com/`, and
the same name. The picker shows the site twice — one *Ready*, one *Update
required* — because those are two different rows with two different states.

| | `d95236c2-5313-49de-8cc5-142372825ebf` | `9048025b-171a-408c-96ac-7169199908dd` |
|---|---|---|
| Created | **2 Jul 2026** | 21 Sep 2026, 11:46 |
| Enrolled for user management | **yes** (21 Sep, 11:48) | no |
| Plugin version reported | 2.6.1 | — |
| Scopes | read, write, reassign, delete, admin | — |
| Hub scopes | `plugin:assign` | — |
| Licence | `DEG-C26E9-0F…`, expires 21 Sep 2027 | `DEG-BFA7C-72…`, **no expiry** |
| Metric samples | **1,851** | 1 |
| Status events | **36** | 0 |
| Audit rows | 5 | 0 |
| Enrollment codes | 1 | 0 |
| User assignments | 0 | 0 |

**`d95236c2` is the real one.** It holds the enrolment, the licence with an
expiry, and effectively all the monitoring history. `9048025b` was created two
minutes before the other was enrolled, which reads as a duplicate added while
setting enrolment up and then abandoned.

Neither row has user assignments, so nothing in the user-management feature
depends on either — which is what makes this safe to resolve now.

## Why it was possible

`websites.url` had no uniqueness and nothing normalised it, so two rows could
differ only by a trailing slash, a `www.`, or not at all.

## What migration 008 does

Nothing is deleted.

1. Groups live websites by normalised URL and picks a keeper per group —
   enrolled first, then most monitoring history, then oldest. For this group
   that is `d95236c2`.
2. **Refuses to run** if a loser has assignments or an enrolment, naming both
   rows. That case is not this one, and a person should decide rather than a
   migration.
3. Moves the loser's monitoring telemetry (`metric_samples`, `status_events`) to
   the keeper, so the history stays whole. Here that is the single orphan metric
   sample. Nothing whose meaning depends on which row recorded it — audit rows,
   assignments, enrollment codes — is touched.
4. Marks the loser `archived`, with `archived_reason` naming the keeper, and
   sets `helper_enabled = false`.
5. Creates a **partial** unique index on the normalised URL, `where not
   archived`, so this cannot recur and the archived row keeps its own URL.

## What archiving means

An archived website disappears from the website list, the scheduler, Sync
status, licence validation, and site-API credential resolution — it cannot call
`/api/site/v1` even though its credential is still in the row. It is still
readable through `getAllWebsitesIncludingArchived()`, and un-archiving is a
single `update`.

## If you later want it gone

Deleting the row is a one-liner, and every child row is `on delete cascade`, so
it is safe **once you are satisfied nothing you want lives on it**:

```sql
-- Check first. Expect: 0 assignments, 0 audit rows, and only telemetry
-- that migration 008 has already moved.
select
  (select count(*) from website_user_assignments where website_id = '9048025b-171a-408c-96ac-7169199908dd') as assignments,
  (select count(*) from audit_log                 where website_id = '9048025b-171a-408c-96ac-7169199908dd') as audit_rows,
  (select count(*) from metric_samples            where website_id = '9048025b-171a-408c-96ac-7169199908dd') as samples;

-- Then, only if that reads 0/0/0:
delete from websites where id = '9048025b-171a-408c-96ac-7169199908dd';
```

That is a decision for a person, which is why it is written here and not in a
migration.
