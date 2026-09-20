# Centralized WordPress user management

Manage the agency's WordPress accounts across every connected client website
from one place, instead of creating each person by hand on each new site.

All controls live in this web app. The `digital-elements-helper` plugin's only
job is to provide the secure API the app calls — there is no user-management
screen inside the plugin.

> **Status.** This document describes the whole feature; the sections marked
> _(later phase)_ are not built yet. What ships today is the app-side roster:
> teams, staff and the activity log. Nothing in this phase contacts a WordPress
> site.

## Concepts

**Teams** group internal agency staff — SEO, Content, PPC, Web Development,
Admin. The entity is called `teams`, never `departments`: the Nexus app already
uses "departments" for the client product catalog (web_dev / ppc / seo /
social), and the two must not collide when this feature is ported.

**Staff users** are the roster synchronized to client sites. They are separate
from `app_users`, which is the dashboard sign-in allow-list — most staff need a
WordPress account without ever signing in to this dashboard. When the same
person has both, `staff_users.app_user_id` links them.

**Roles** are WordPress roles (Administrator, Editor, Author, Contributor,
Subscriber, plus any custom role a site defines). A person's role on a site is
resolved in this order:

1. a per-website override _(later phase)_
2. the person's own default role
3. their team's default role
4. `subscriber`

## Who can use it

The `manageWpUsers` permission. It is deliberately **not** the same as
`manageUsers`, which governs the dashboard sign-in allow-list — creating real
accounts on client sites is a much larger capability and gets its own grant.

It is held by:

- anyone with the `admin` dashboard role, and
- anyone on the explicit allow-list in `app_settings.wp_user_managers`
  (seeded with ryan@, danny@ and jeff@digitalelementsgroup.com).

The allow-list exists so the grant is visible rather than implied. Editing it
requires `manageUsers` (admin only), so a grantee cannot widen the grant to
themselves or anyone else. See `src/auth.js` and `src/usermgmt/grants.js`.

## Safety rules

These hold across every phase:

- **Agency domain.** Only `@digitalelementsgroup.com` addresses can be added
  unless an authorized administrator explicitly confirms an override, which is
  recorded in the activity log.
- **Least privilege.** Administrator can never be a team or per-user *default*.
  It is granted per website, with an explicit confirmation _(later phase)_.
- **Client accounts are untouchable.** _(later phase)_ Only accounts this tool
  created — or that an administrator deliberately linked — carry the
  managed-by-Digital-Elements flag, and only those can be modified.
- **No passwords, ever.** _(later phase)_ New accounts get a generated password
  that is never returned, displayed, logged or stored; WordPress sends its own
  set-password email.
- **Deleting a team deletes nobody.** The app asks what happens to its members
  and never touches a WordPress account as a side effect.
- **Removing someone from the roster** removes them from this app only. Their
  WordPress accounts are left exactly as they are.

## Architecture

```
src/migrate.js            ordered .sql migrations, applied once at boot
db/migrations/            001 core entities, 002 seeded roster
src/usermgmt/
  grants.js               who holds manageWpUsers, beyond the admin role
  roles.js                WordPress role vocabulary and admin-like detection
  teams.js                team CRUD and delete disposition
  staffUsers.js           roster CRUD, domain policy, role resolution
  audit.js                administrative action log (redacted)
src/routes/wpusers.js     thin Express layer over the modules above
public/wpusers.{js,css}   the Settings → WP Users interface
```

Business logic lives in `src/usermgmt/` and never touches `req`/`res`, so
porting to Nexus means writing a new router, not rewriting the feature.

## Migrations

`src/migrate.js` applies `db/migrations/*.sql` in filename order, once each,
recording them in `schema_migrations`. Each file runs in a transaction, so a
failure rolls back and aborts boot rather than leaving a half-migrated schema.

This sits alongside the self-healing `alter table ... if not exists` statements
in `bootstrap()`, which stay as they are. Migrations run *after* bootstrap so
the tables they reference already exist.

To add one: drop a `NNN_description.sql` file in `db/migrations/`. Never edit an
applied migration — the runner warns and refuses to re-run a changed file.

## API

All routes are under `/api/wpusers`, and all require a signed-in user with
`manageWpUsers`. Auth, permission and rate limiting are applied once at the
mount point in `src/server.js`.

| Method | Route | Purpose |
|---|---|---|
| GET | `/roles` | Role vocabulary for the dropdowns |
| GET/POST | `/teams` | List / create teams |
| PUT/DELETE | `/teams/:id` | Edit / delete a team (delete needs a member disposition) |
| GET/POST | `/users` | List / add staff |
| PUT/DELETE | `/users/:id` | Edit / remove from the roster |
| POST | `/users/move-team` | Bulk team move |
| GET | `/audit` | Activity log |
| GET/PUT | `/grants` | The manageWpUsers allow-list (admin only) |

Responses are always `{ ok: true, ... }` or `{ ok: false, error, code? }`.
A refusal caused by the agency-domain rule carries `code: "domain_restricted"`
so the UI can offer the override confirmation instead of just repeating the
refusal.

## Roadmap

| Phase | Contents |
|---|---|
| 0–1 ✅ | Migration runner, `manageWpUsers`, teams and staff, activity log, UI |
| 2 | Scoped per-site credential, HMAC request signing, `de/v2/capabilities`, enrollment, plugin version compatibility |
| 3 | Reading roles and users from sites, role cache, preflight review |
| 4 | Create / update / link / role change, sync jobs, bulk and whole-team assignment, retries |
| 5 | Content ownership, reassignment, guarded deletion |
| 6–7 | Sync dashboard, polish, plugin 2.6.0 release and rollout |

## Testing

```
npm test
```

`tests/usermgmt-policy.test.mjs` covers the permission model, role vocabulary,
domain restriction, username derivation and audit redaction.
`tests/usermgmt-migrations.test.mjs` checks migration ordering, that nothing
destructive is in them, and that the seeded roster matches the agency's.

Both run without a database. Integration tests against a real WordPress install
arrive with the phases that make plugin calls.
