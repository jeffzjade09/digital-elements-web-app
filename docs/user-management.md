# Centralized WordPress user management

Manage the agency's WordPress accounts across every connected client website
from one place, instead of creating each person by hand on each new site.

All controls live in this web app. The `digital-elements-helper` plugin's only
job is to provide the secure API the app calls — there is no user-management
screen inside the plugin.

> **Status.** This document describes the whole feature; the sections marked
> _(later phase)_ are not built yet. What exists today is the app-side roster
> (teams, staff, activity log) and the secure channel to each site (enrollment,
> signed requests, capability probing). Reading and writing WordPress users
> comes next.

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
- **A site opts in.** User management cannot be switched on remotely. The site
  redeems a one-time code that someone with access to its WP admin pasted in,
  and it can disconnect at any time.
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
  credentials.js          per-site credential: encrypt, rotate, enrollment codes
  signing.js              the canonical string and HMAC (mirrored in PHP)
  wpClient.js             signed calls to a site, SSRF guard, error mapping
  capabilities.js         per-site probe + cache, readiness states
src/routes/wpusers.js     thin Express layer over the modules above
public/wpusers.{js,css}   the Settings → WP Users interface

wordpress-plugin/digital-elements-helper/includes/
  um-auth.php             signature verification, nonces, scopes, idempotency
  um-rest.php             the de/v2 namespace and the capabilities probe
  um-admin.php            the site's own connect / permissions / disconnect panel
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

## The secure channel

### Why not the license key

Every monitoring request is authorized by one shared bearer token per site — the
license key. That is proportionate for reading update counts. It is not
proportionate for endpoints that create and delete WordPress users: one leaked
key would mean Administrator creation on every connected site, and rotating it
disrupts monitoring.

User management therefore uses a **separate, scoped, independently rotatable
credential**, and signs every request.

### Enrollment

1. An administrator generates a one-time code in Settings → WP Users → Websites.
2. Someone with access to that site's WP admin pastes it into
   **DE Monitoring → User management** and presses Connect.
3. The site POSTs the code **and its own license key** to
   `/api/plugin/enroll` over TLS and stores the credential it gets back.

Two independent secrets are required, so neither an intercepted code nor a
leaked license key is enough on its own. The site always initiates: the
dashboard never pushes a credential, which is what stops user management being
switchable on remotely.

The code is stored only as a hash, expires in 15 minutes, and is single-use.
The secret is stored encrypted (AES-256-GCM under `USER_MGMT_ENC_KEY`) and is
never returned by any API — not even to an administrator.

### Request signing

```
X-DE-Key-Id:     dek_ab12cd34ef56
X-DE-Timestamp:  1790000000
X-DE-Nonce:      <uuid>
X-DE-Signature:  DE1-HMAC-SHA256 <base64>
Idempotency-Key: <optional>

canonical = METHOD \n ROUTE \n CANONICAL_QUERY \n TIMESTAMP \n NONCE
            \n IDEMPOTENCY_KEY \n sha256hex(body)
```

The signature commits to everything that matters, so a captured request cannot
be replayed, pointed at another route, or have its body or idempotency key
edited in flight. The plugin rejects a timestamp more than 5 minutes out, a
nonce it has seen before, and — only after the signature verifies — anything
outside the credential's scopes.

The canonical string is defined once in `src/usermgmt/signing.js` and mirrored
in `um-auth.php`. Both are checked against the same vectors
(`tests/fixtures/signing-vectors.json`), so the two implementations cannot
drift apart.

### How the plugin authorizes, with no logged-in user

REST callbacks run with no WordPress user, so `current_user_can()` is always
false and can authorize nothing. Three gates stack instead:

1. **Credential** — signed by this site's secret, inside the time window, with
   an unused nonce.
2. **Scope** — the credential grants the scope the route declares. `users:read`,
   `users:write` and `content:reassign` come with enrollment. **`users:delete`
   and `users:admin` are off** unless that site's own administrator turns them
   on in DE Monitoring — a local kill switch no leaked credential can flip.
3. **Guard** — the handler's own rules: managed-only, role whitelist,
   last-administrator protection _(later phase)_.

There is deliberately no `wp_set_current_user()` anywhere. Impersonating an
administrator would collapse all three gates back into "holds a secret".

## Plugin version compatibility

Before any user operation, each site is probed at `de/v2/capabilities` and the
answer is cached for 10 minutes on the `websites` row. Sites are gated on the
**capability** they report, not on the plugin's version string, so a capability
can ship without every screen knowing which release introduced it.

Readiness states, shown in the Websites tab and in every site picker:

| State | Meaning |
|---|---|
| `ready` | Connected and capable |
| `needs_enrollment` | Plugin supports it; the site hasn't connected |
| `plugin_update_required` | Helper is older than contract revision 1 |
| `helper_disabled` | The helper plugin isn't enabled for this website |
| `unreachable` | Timed out, or the site returned an error |
| `unknown` | Not probed yet |

The capabilities probe accepts the **license key** as well as a signature — it
has to be answerable before enrollment, or "needs a plugin update" and "needs
connecting" would be indistinguishable. It returns only version and feature
information, never anything about a user.

## Configuration

| Variable | Purpose |
|---|---|
| `USER_MGMT_ENC_KEY` | 32 bytes (base64 or hex) encrypting stored credentials. Without it, teams and staff work and the Websites tab reports the feature unconfigured. **Losing it means re-enrolling every site.** |
| `UM_ALLOW_LOCAL_SITES` | `1` to allow calls to localhost/`*.test`. Off by default so a mistyped website URL can't make the server call its own network. Needed for local WordPress testing. |

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
| GET | `/websites` | Sites with readiness, plugin version and scopes (`?refresh=1` re-probes) |
| GET | `/websites/:id/capabilities` | One site's probe result |
| POST | `/websites/:id/enrollment-code` | Issue a one-time connect code |
| POST | `/websites/:id/rotate-credential` | Revoke and issue a new code |
| POST | `/websites/:id/revoke-credential` | Disconnect a site |
| GET | `/audit` | Activity log |
| GET/PUT | `/grants` | The manageWpUsers allow-list (admin only) |

Responses are always `{ ok: true, ... }` or `{ ok: false, error, code? }`.
A refusal caused by the agency-domain rule carries `code: "domain_restricted"`
so the UI can offer the override confirmation instead of just repeating the
refusal.

`POST /api/plugin/enroll` is the one route outside this group. It is public and
rate-limited, called by the plugin rather than a browser, and answers every
failure identically so it cannot be used as an oracle for valid codes or
license keys.

## Roadmap

| Phase | Contents |
|---|---|
| 0–1 ✅ | Migration runner, `manageWpUsers`, teams and staff, activity log, UI |
| 2 ✅ | Scoped per-site credential, HMAC request signing, `de/v2/capabilities`, enrollment, plugin version compatibility |
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

`tests/usermgmt-signing.test.mjs` covers the canonical string, credential
encryption, the SSRF guard and capability gating.
`tests/usermgmt-auth.test.php` covers the plugin's side of the same contract
against a stubbed WordPress: signature tampering, the clock window, replay
protection, scopes and rate limiting.

All four run without a database or a WordPress install.

### Against a real WordPress install

```bash
php scripts/live-usermgmt-check.php D:/laragon/www/wordpresstester
```

Covers what stubs can't: that the routes are registered and guarded, that the
real options API behaves the way the nonce and idempotency stores assume, and
that an unauthenticated request is genuinely refused. Start MySQL first.

The script **refuses to run against any host that isn't local**, restores the
site's original options afterwards, and creates, changes or deletes no
WordPress user. Never point any of this at a client site.
