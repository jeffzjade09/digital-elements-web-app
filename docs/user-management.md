# Centralized WordPress user management

Manage the agency's WordPress accounts across every connected client website
from one place, instead of creating each person by hand on each new site.

All controls live in this web app. The `digital-elements-helper` plugin's only
job is to provide the secure API the app calls — there is no user-management
screen inside the plugin.

> **Status.** Complete and released as helper plugin **2.6.0**.

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

1. a per-website override
2. the person's own default role
3. their team's default role
4. `subscriber`

Any of those may be **Administrator**, and the seeded teams default to it —
this agency administers the sites it builds, so that is the ordinary working
role rather than an exception. The choices are the core five plus every role
discovered on a connected website, so a client's custom role (`seo_editor`,
`shop_manager`) can be picked as a default too. The display name is shown; the
slug is stored.

### Elevated roles, in two tiers

A role is reported with two flags, and the difference is load-bearing:

| Flag | Means | Effect |
|---|---|---|
| `is_site_admin` | can administer the site **or execute code on it** — `manage_options`, `promote_users`, `edit_users`, `delete_users`, `install_plugins`, `activate_plugins`, `edit_plugins`, `edit_themes`, `switch_themes`, `edit_files`, `update_core`, `import`/`export`, and the multisite equivalents | **Requires `users:admin` AND an explicit confirmation** |
| `is_admin_like` | the above, **or** `unfiltered_html` | Shown as a notice |

They are separate because **stock WordPress grants `unfiltered_html` to Editor**,
which is an ordinary role to assign. A confirmation keyed on the broad flag
would fire on assignments that carry no real risk — and a confirmation that
fires on the common case is one people learn to click through, which is worse
than not having it.

The same reasoning is why Administrator is allowed as a default. Making the
common case awkward does not make it safer; it makes the warnings worthless.

Both flags come from the site's own capability map, so a plugin-defined role
that can administer the site is caught the same way Administrator is.

`install_plugins` alone is arbitrary code execution, and roles carrying it
*without* `manage_options` are common on real client sites — membership and LMS
plugins, agency "Site Manager" roles, anything built with a role editor. The
list is a deny-list rather than an allow-list because an allow-list would
classify every plugin-defined role as elevated, putting a confirmation in front
of ordinary work, which is the failure mode the two tiers exist to avoid.

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

## Setting it up

### 1. On this server, once

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put that in `USER_MGMT_ENC_KEY` and restart. It encrypts every site's
credential at rest.

**Back it up with your other secrets.** Losing or changing it makes every stored
credential undecryptable and every site has to be re-enrolled. Without it the
dashboard runs exactly as before — teams and staff still work, and the Websites
tab reports the feature unconfigured rather than failing.

### 2. Roll out the plugin

Helper **2.6.0** carries the `de/v2` API. `/api/plugin/manifest` offers it
automatically; sites with auto-updates on pick it up within a few hours, and the
rest need someone to press Update on that site's Plugins screen.

Settings → WP Users → **Sync status** lists exactly which sites are still
behind. Nothing else can be done from here — we cannot update a site remotely.

### 3. Connect each site (about 30 seconds per site)

> **Check the Websites tab first.** If a site shows **Wrong license**, its plugin
> is carrying a different website's license key — usually because the install was
> cloned from a staging copy. A code issued for it will be refused, because the
> site presents the other website's key when redeeming. Fix the key in that
> site's DE Monitoring panel first. The dashboard warns before issuing a code.


1. **Websites** tab → **Connect…** on the site → a code appears.
2. Open that site's WP Admin → **DE Monitoring** → **User management**, paste the
   code, press **Connect**.
3. Back in the dashboard, press **Re-check all**.

The code is valid for 15 minutes and works once. It grants nothing on its own —
the site must also present its own monitoring license key to redeem it.

**If a code is refused**, the site is told only that it was invalid — deliberately,
so the endpoint can't be used to probe for valid codes or keys. The real reason is
recorded in the dashboard: **Sync status** lists refusals from the last 7 days with
what actually went wrong, and the **Activity log** keeps the full history.

**This step always needs someone with access to the client's WP Admin.** That is
deliberate: user management cannot be switched on remotely, so a compromised
dashboard cannot enroll a site by itself.

### 4. Decide what each site allows

While in DE Monitoring, that site's administrator chooses whether we may:

- **delete users** (`users:delete`)
- **grant Administrator** (`users:admin`)

**Both are off by default.** They are switched on locally, per site, and this
dashboard cannot turn them on — it is the client's kill switch, not ours.

The dashboard mirrors whatever the site reports on every successful probe, in
both directions: granting a scope there starts working here after a **Re-check**,
and revoking it there stops working here on the next probe. A site we can't
reach is left as it was — an unreachable site has told us nothing about what it
grants, so a slow site never silently revokes a client's permission.
Reading users, creating and updating them, and reassigning content come with
enrollment.

### Order of operations

```
USER_MGMT_ENC_KEY  →  plugin 2.6.0 reaches the site  →  site redeems a code
                   →  site chooses its scopes        →  assignments can run
```

A site missing any step shows the reason in Sync status rather than failing
part-way through a bulk run.

## Safety rules

These hold across every phase:

- **Agency domain.** Only `@digitalelementsgroup.com` addresses can be added
  unless an authorized administrator explicitly confirms an override, which is
  recorded in the activity log.
- **Administrator is allowed as a default, and still gated.** It may be a team
  or per-user default. What protects a client is not the role's absence from a
  dropdown — it never was — but the two things that did the actual work:
  a website only accepts an administering role if **its own administrator
  granted `users:admin`**, which this dashboard cannot do, and assigning one
  needs an **explicit confirmation before the job runs**. Sites that haven't
  granted it show those assignments as blocked in the review, with the reason.
  Every grant is written to the audit log.
- **A site opts in.** User management cannot be switched on remotely. The site
  redeems a one-time code that someone with access to its WP admin pasted in,
  and it can disconnect at any time.
- **Client accounts are untouchable.** Only accounts this tool created — or that
  an administrator deliberately linked — carry `_de_managed`, and every mutating
  route refuses anything without it. `/link` is the single exception and is how
  an account becomes managed in the first place.
- **The last administrator is never stranded.** Demoting or unlinking a site's
  only administrator is refused by the site itself.
- **A linked account is not ours.** Changing an account's email address or
  triggering its password reset both hand control to whoever receives the mail,
  so they are allowed **only for accounts we created**. Linking a client's
  Editor lets us manage its *role* — nothing more.
- **No passwords, ever.** New accounts get a generated password that is never
  returned, displayed, logged or stored; WordPress sends its own set-password
  email. If that email fails, it is a **warning on a successful create** — there
  is no condition under which a password is disclosed instead.
- **Deleting a team deletes nobody.** The app asks what happens to its members
  and never touches a WordPress account as a side effect.
- **Removing someone from the roster** removes them from this app only. Their
  WordPress accounts are left exactly as they are.
- **Nothing is ever orphaned.** `wp_delete_user()` is never reached while an
  account still owns anything, and ownership is re-counted *inside the delete
  request* — not trusted from whatever the dashboard saw earlier.

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
  preflight.js            predicts every (person × website) outcome; writes nothing
  sync.js                 planner, bounded executor, retries, job recovery
  contentOwnership.js     per-site ownership, reassignment, guarded deletion
src/routes/wpusers.js     thin Express layer over the modules above
public/wpusers.{js,css}   the Settings → WP Users interface

wordpress-plugin/digital-elements-helper/includes/
  um-auth.php             signature verification, nonces, scopes, idempotency
  um-rest.php             the de/v2 namespace and the capabilities probe
  um-users.php            read endpoints: roles, users, existence lookup
  um-write.php            create / update / link / unlink / password reset + guards
  um-content.php          ownership counts, reassignment, guarded deletion
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
| `USER_SYNC_CONCURRENCY` | How many websites a bulk run touches at once. Default 4, capped at 16. |
| `UM_ALLOW_LOCAL_SITES` | `1` to allow calls to localhost/`*.test`. Off by default so a website URL can't make the server call its own network. Needed for local WordPress testing. |

### Where outbound requests may go

A website's URL is editable by anyone with `manageWebsites` — a lower bar than
`manageWpUsers` — and the capabilities probe carries that site's monitoring
license key. So before any request leaves the server, the target is checked
twice:

1. **By address.** The host is parsed and range-checked, not string-matched:
   loopback, RFC 1918, CGNAT, link-local (including cloud metadata at
   `169.254.169.254`), IPv6 unique-local and link-local, and IPv4-mapped IPv6
   such as `::ffff:127.0.0.1` are all refused. Hostnames ending in `.local`,
   `.test`, `.internal` or `.intranet`, and `localhost`, are refused too.
2. **By resolution.** A hostname is resolved and *every* answer must be public.
   `localtest.me` is an ordinary public name that points at `127.0.0.1`, and
   nothing about the string says so.

This narrows the window rather than closing it: the HTTP client resolves the
name again when it connects, so a record that changes in between is still
theoretically possible. Closing that fully means pinning the connection to the
validated address, which needs a custom dispatcher. Given the URL is only
settable by signed-in staff, that residual risk is accepted and stated here
rather than left implied.

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
| GET | `/websites/:id/roles` | That site's real roles (`?refresh=1` re-asks) |
| POST | `/preflight` | Predicts every (person × website) outcome. Writes nothing |
| POST | `/assign` | Applies a reviewed plan. Returns `{ jobId }` |
| POST | `/remove` | Stops managing accounts (unlink). Returns `{ jobId }` |
| GET | `/jobs/:id` | Job progress, polled by the UI |
| POST | `/jobs/:id/retry` | Retries a job's **failed** operations only |
| GET | `/content/:staffUserId/:websiteId` | What that account owns on ONE website, and who could receive it |
| POST | `/content/:staffUserId/:websiteId/reassign` | Moves it, then returns the **verified** remaining count |
| POST | `/deletion-plan` | Checks every selected website independently. Writes nothing |
| POST | `/delete-accounts` | Deletes, through the job system. Needs `confirm: "DELETE"` |
| POST | `/websites/:id/enrollment-code` | Issue a one-time connect code |
| POST | `/websites/:id/rotate-credential` | Revoke and issue a new code |
| POST | `/websites/:id/revoke-credential` | Disconnect a site |
| GET | `/assignments` | Every website assignment, for the Users filters |
| GET | `/sync-status` | Per-site readiness, recent runs, interrupted operations |
| GET | `/audit` | Activity log, filterable by entity / website / actor / action |
| GET/PUT | `/grants` | The manageWpUsers allow-list (admin only) |

Responses are always `{ ok: true, ... }` or `{ ok: false, error, code? }`.
A refusal caused by the agency-domain rule carries `code: "domain_restricted"`
so the UI can offer the override confirmation instead of just repeating the
refusal.

`POST /api/plugin/enroll` is the one route outside this group. It is public and
rate-limited, called by the plugin rather than a browser, and answers every
failure identically so it cannot be used as an oracle for valid codes or
license keys.

## Preflight — the review screen's contract

`POST /api/wpusers/preflight` returns one row per (person × website) with
`exists`, `currentRoles`, `managed`, `requestedRole`, `roleAvailable`,
`pluginSupported`, `pluginVersion`, a predicted `action`, and `blockers[]`.

| Action | Meaning |
|---|---|
| `create` | No account here — one would be made |
| `update` | A managed account exists with a different role |
| `link_required` | An account exists that **isn't ours to touch** |
| `skip` | Already correct |
| `blocked` | Can't proceed; see `blockers[]` |

Three details matter more than the rest:

- **`link_required` is not a variant of `update`.** An account we didn't create
  and nobody linked belongs to the client. It is reported, never adopted — even
  when the role already matches, which would otherwise look like a harmless
  skip.
- **"Couldn't read the roles" is not "the role isn't available".** They are
  separate blocker codes (`roles_unknown` vs `role_not_available`), because
  saying a role is missing when we simply couldn't ask would be a lie.
- **A failed lookup never predicts `create`.** If we couldn't determine whether
  an account exists, predicting `create` would risk a duplicate, so the pair is
  blocked instead.

The predicted actions use the same vocabulary the sync phase reports back, so
the review screen and the results screen line up.

## Granting Administrator

Administrator (and any role that can install plugins or edit files) is gated by
two things, neither of which is the dropdown it was chosen from:

**1. The website must have allowed it.** Someone with access to that site's WP
Admin switches on `users:admin` under DE Monitoring → User management. This
dashboard cannot turn it on. A site that hasn't shows those assignments as
**blocked** in the review with the reason and where the switch lives, rather
than failing one site at a time during a run.

**2. One confirmation, per job.** Before anything is applied:

> **This grants Administrator on 7 websites.**
> _(the websites, named)_
> 34 assignments in total.

One confirmation for the whole job, phrased in **websites** rather than
assignments — "on 7 websites" is a sentence someone can weigh; "34 assignments"
is not. Blocked sites are excluded from that count, because they aren't going to
happen.

Every grant is written to the audit log with the actor, the site and the role.

## Applying a plan

### What makes "Retry failed" safe to press

Every operation carries an idempotency key derived from
`sha256(JSON([jobId, websiteId, staffUserId, action]))` — **stable across every
retry of the same unit of work**. A retry presents the same key, so the site
replays its stored result rather than applying the change a second time. JSON
rather than a joined string because joining on a separator lets `("a:b","c")`
and `("a","b:c")` collide, and a key two operations can share is the one thing
this must never produce.

Only failed operations are retried. Successful ones are never re-run.

### Retry policy

Automatic retry happens **once**, and only for transport failures: `timeout`,
`unreachable`, `site_error`, `rate_limited`. A 4xx is the site refusing the
request — retrying it unchanged just fails again, and for
`role_requires_confirmation` it would mean hammering past a deliberate guard.

### Bounded concurrency

`USER_SYNC_CONCURRENCY` (default 4) sites in flight, 20s per-site timeout. Work
is pulled from a shared cursor rather than chunked, so one very slow site
doesn't leave the other workers idle.

### Surviving a restart

Operations live in Postgres, not memory. On boot, anything still `processing`
for more than 10 minutes is marked `interrupted` — visible and retryable —
instead of leaving a job that never finishes and a spinner that never stops.

### "Remove" means unlink

`POST /remove` clears `_de_managed`. **The WordPress account keeps its role, its
content and its access** — we simply stop managing it. Deleting an account needs
the content-ownership checks from the next phase; offering deletion without them
is how content gets orphaned, so the route refuses `deleteAccounts` outright.

## Adding staff from inside a client's WP Admin

A member of staff already working in a client's WP Admin can add colleagues to
**that** site without switching to the dashboard: **DE Monitoring → Team
Members**.

### The plugin never creates anyone

It sends a signed request to the hub, and the hub runs the **same** `de/v2` path
the dashboard uses — same guards, same idempotency, same audit rows, same
set-password email. The plugin renders the result. That is why there is no
second implementation to drift out of step.

### How a site is identified

By the credential that signed the request. **No route in the site API takes a
website id**, so a compromised site cannot name another site's id and be
believed — it can only ever act as itself. That is structural, not a check that
could be forgotten on one route.

| Method | Route | Scope |
|---|---|---|
| GET | `/api/site/v1/roster` | `users:read` |
| POST | `/api/site/v1/preflight` | `users:read` |
| POST | `/api/site/v1/assign` | `plugin:assign` + `users:write` |
| GET | `/api/site/v1/jobs/:id` | `users:read` (own jobs only) |

Requests are signed with **`DE1-SITE-HMAC-SHA256`** — a different version string
from the hub→site direction. Both share a secret and a canonical string, so
without this a signature captured from one direction could in principle be
presented in the other; the distinct version makes that impossible rather than
merely unlikely.

### Two authorities for permissions

| | Set by | Stored in | Reported by the plugin? |
|---|---|---|---|
| `users:read`, `users:write`, `users:admin`, `users:delete`, `content:reassign` | **the website's own administrator** | `um_scopes` | Yes — every probe overwrites it |
| `plugin:assign` | **the dashboard** | `um_hub_scopes` | No |

They are separate columns on purpose. A capability probe writes `um_scopes`
wholesale; if `plugin:assign` lived there, the next probe would wipe it and a
revoke made in the dashboard would silently come back minutes later. Keeping
them apart means the persist path *cannot* touch the hub's column.

`plugin:assign` is granted at enrollment and revocable per site from the
Websites tab ("We allow"). Sites enrolled before 2.7.0 are backfilled by
migration 007, so nothing needs re-enrolling.

### What a compromised site could do

Read the agency roster (names, emails, teams, default roles of active staff),
run preflight for itself, and assign **existing** roster members to **itself**.

It cannot touch another site, create or edit staff or teams, delete anything, or
escalate beyond that site's own `users:admin` grant. **The real residual risk is
roster disclosure** — staff names and emails become readable by any connected
site. Mitigated by exposing only what the form needs, excluding external
addresses entirely, per-site rate limits, an independently revocable
`plugin:assign`, and auditing every read.

### Who can see the screen

Four conditions, **all** required, **all** checked in PHP on every entry point —
the page callback and each of the four AJAX handlers — never by hiding markup:

1. the license is present, verified and unexpired;
2. the site is enrolled, granted `users:write`, and the dashboard grants it
   `plugin:assign`;
3. the logged-in user holds **both** `edit_users` and `promote_users` here;
4. the logged-in user is `_de_managed` **and** has an `@digitalelementsgroup.com`
   address.

Condition 4 is the one that matters. A client's own Administrator holds every
capability on their own site, so 3 alone would admit them. Being a
Digital-Elements-managed account is what separates "our staff working here" from
"the site's owner", and it is checked against user meta the hub writes, not
against anything the browser sends.

The submenu is registered for `read` and the **callback** enforces the gate,
rather than the menu being hidden and that trusted. Hiding markup is
presentation; the callback is the control.

### Why the screen is unavailable, in nine distinct ways

| State | What it means |
|---|---|
| `license_missing` | no license key on this site |
| `license_invalid` | the hub doesn't recognise the key |
| `license_expired` | the license has run out |
| `not_enrolled` | user management was never connected here |
| `write_not_granted` | this site withheld `users:write` |
| `plugin_assign_not_granted` | the dashboard hasn't permitted this site to assign |
| `hub_unreachable` | the dashboard didn't answer |
| `roster_empty` | there is nobody to add yet |
| `no_permission` | this account may not use the screen |

Each has its own title and its own sentence. Collapsing them into "unavailable"
would leave whoever hits it with nothing to act on, and these need completely
different actions — renew a license, connect a site, ask Digital Elements, or
nothing at all.

**A failed hub call is never a half-rendered page.** The gate runs a second time
with the roster in hand, so an unreachable dashboard produces the notice and no
selection UI at all.

### Where the roster comes from

`GET /api/site/v1/roster`, cached in a transient for five minutes. The cache key
is a hash of the site's **`um_key_id`**, not of the site: rotate or revoke the
credential and the old roster becomes unreachable rather than continuing to be
served to a site that has just lost access.

`canAssign` on that response is what tells the plugin whether the dashboard
still permits assignment. `plugin:assign` is hub-controlled and deliberately
never reported by the plugin, so without it the panel could only discover a
revoke by having a submission refused after someone had picked people.

### The flow

Pick people → **Review** (preflight: who exists, who would be created, who is
blocked) → confirm → assign → poll `GET /jobs/:id` → results.

The browser generates a request id once per submission and sends it back
unchanged on **Retry**. That is what makes Retry safe: it becomes the
`Idempotency-Key`, and the hub returns the *same* job rather than starting a
second one that adds everybody twice.

Non-agency roster members are refused outright — dropped at the hub, and dropped
again when the roster is shaped for the page. Adding one is a deliberate
dashboard action with its own confirmation and audit trail, and reproducing that
inside a client's WP Admin would weaken it.

### One rule that is a guard, not a boundary

The plugin will refuse to let someone assign a role above their own level on
that site, defined as capability-subset. **This can only be enforced in the
plugin**, because only the plugin knows the acting WordPress user's
capabilities — the hub sees a site credential, not a WP session.

So it is a guard against honest mistakes, **not a security boundary**: a
compromised site could bypass it, but a compromised site can already call
`wp_create_user()` on itself. The boundaries that *are* real are the hub's —
role whitelist, `users:admin` scope, agency-domain rule, last-administrator.

It compares the role's declared capabilities against the acting user's
**assigned** capabilities (`$user->allcaps`), not `current_user_can()`. Stock
WordPress declares `manage_links` and `unfiltered_upload` on the Editor and
Administrator roles but denies both in `map_meta_cap` — the Links Manager is off
by default, and `unfiltered_upload` is granted to nobody. Judged by
`current_user_can()`, nobody on a default install could ever grant Editor or
Administrator, including a full administrator. Comparing declared capabilities
on both sides keeps the two from being measured on different scales. (Found by
the live check against WordPress 6.3.1; stubs cannot show it, because the denial
lives in `map_meta_cap`.)

## Deleting an account

### Why it is called "Delete from this website"

On single-site WordPress there is no way to remove someone from a site without
deleting their account. Calling the button anything softer would describe a
gentler action than the one about to happen.

### The flow, which does not shorten

```
ownership breakdown  →  pick a recipient  →  reassign
                     →  the app RE-CHECKS and shows 0 remaining as proof
                     →  only then does the delete button unlock
                     →  typed DELETE confirmation
```

Reassignment gets its own typed confirmation (`REASSIGN`): it destroys nothing,
but it changes authorship everywhere it appears on the site and undoing it means
reassigning back by hand. Deleting from more than one website needs a separate
acknowledgement of that fact.

### Three independent verifications

The zero the administrator sees is **evidence**, not the safety mechanism.
Between the click and a lost post stand:

1. `planDeletion()` — per website, before anything is offered.
2. The job's own re-check, immediately before calling the site.
3. **The plugin's re-count inside the delete request itself.**

Number 3 is the one that matters. A dashboard can show a correct "0 remaining"
and then sit on screen while an editor publishes a post, a scheduled post goes
live, or a plugin creates an attachment. Deleting on the strength of that
earlier count would silently destroy content, so the count is taken again in the
same request that does the deleting, and a non-zero result refuses outright with
`has_content`.

### Why not `wp_delete_user($id, $reassign)`

WordPress's own reassignment argument moves **only posts and links**, and
silently deletes everything else the account owns. So reassignment is a
separate, verified step, and `wp_delete_user()` is called with **no** second
argument — by then there is deliberately nothing left to reassign, and passing
one would hide a failure of the check above.

### What counts as content

Every registered post type, public and private, including `attachment` — a
rehab site's `location` CPT or a shop's `product` is exactly the content a check
that only looked at posts and pages would destroy unnoticed. Broken down by
status, with **scheduled** called out separately: nothing on the site shows it
yet, and deleting its author is how a launch quietly fails to happen. Authored
comments count too; post reassignment doesn't move them.

Revisions are excluded — they are copies, and WordPress removes them with their
parent.

### Per website, always

A person owns different things on each site. One site answering "nothing here"
says nothing about the other four, so every website is checked, reassigned and
verified independently.

### Deleting a team

`DELETE /api/wpusers/teams/:id` takes `{ onUsers, moveToTeamId?, onAssignments }`.
Both dispositions are required when they apply — never guessed.

**`onAssignments: "remove"` means unlink, not delete.** The WordPress accounts
keep their role, content and access; we stop administering them. Folding account
deletion into a team delete would be the most dangerous shortcut in this
feature, so the return value states `deletesWordPressAccounts: false` explicitly.

## The activity log

Every administrative change: who did it, what changed, on which site, and the
result. `before`/`after` are redacted **on write and again on read** — an entry
written by an earlier version, or by a future caller that forgets, still cannot
render a secret, a signature or an idempotency key in a browser. The log records
*what changed and who changed it*, never how the request was authenticated.

Filters are built from what is actually in the log, so a new action type appears
the first time it happens rather than the next time someone remembers to add it.

## Roadmap

| Phase | Contents |
|---|---|
| 0–1 ✅ | Migration runner, `manageWpUsers`, teams and staff, activity log, UI |
| 2 ✅ | Scoped per-site credential, HMAC request signing, `de/v2/capabilities`, enrollment, plugin version compatibility |
| 3 ✅ | Reading roles and users from sites, role cache, preflight review |
| 4 ✅ | Create / update / link / role change, sync jobs, bulk and whole-team assignment, retries |
| 5 ✅ | Content ownership, reassignment, guarded deletion |
| 6–7 ✅ | Sync dashboard, activity log, polish, plugin 2.6.0 release and rollout |

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
`tests/usermgmt-preflight.test.mjs` covers the prediction decision table and
role classification.
`tests/usermgmt-users.test.php` covers the read routes' scope enforcement and,
above all, that a user leaves a site carrying only the fields we chose.
`tests/usermgmt-write.test.php` covers every write guard independently, and that
no generated password reaches a response under any condition.
`tests/usermgmt-sync.test.mjs` covers the idempotency key, the retry rule and
the bounded executor.
`tests/usermgmt-content.test.php` covers ownership counting across custom post
types, reassignment target validation, every deletion refusal, and above all the
stale-UI case: content created between the check and the delete must refuse.
`tests/usermgmt-deletion.test.mjs` covers the ownership summary, per-website
independence, and the team-delete disposition.
`tests/usermgmt-scopes.test.mjs` covers scope persistence and the two
authorities.
`tests/usermgmt-site-api.test.mjs` covers the site API's identification,
tenancy and response envelope.
`tests/usermgmt-site-panel.test.php` covers the Team Members panel: every gate
state, a client's own Administrator refused, the agency-domain rule, the nonce
on all four AJAX handlers, the capability-subset rule, the roster cache key, and
that a hub failure becomes a clean unavailable state rather than a half-rendered
page. It also asserts the plugin never calls `wp_insert_user()` or
`wp_create_user()`.

All of them run without a database or a WordPress install.

### Against a real WordPress install

```bash
php scripts/live-usermgmt-check.php D:/laragon/www/wordpresstester
```

Covers what stubs can't: that the routes are registered and guarded, that the
real options API behaves the way the nonce and idempotency stores assume, and
that an unauthenticated request is genuinely refused. Start MySQL first.

The script **refuses to run against any host that isn't local**, restores the
site's original options afterwards, and removes every user and post it created.
Never point any of this at a client site.

It also covers the Team Members panel against the real options, user and
transient APIs — including a real WordPress Administrator who is not
`_de_managed` being refused, and the capability-subset rule measured against
real role definitions.

#### The round-trip to a dashboard

Without a hub the panel's **unreachable** path is what gets exercised. To cover
the whole flow, point it at a local dashboard:

```bash
UM_LIVE_HUB=http://127.0.0.1:3000 php scripts/live-usermgmt-check.php D:/laragon/www/wordpresstester
```

That adds roster → preflight → assign → poll → results → retry, and asserts the
retry returns the *same* job and creates no second account. `DEHELED_HUB_URL` is
defined by the script before the plugin loads, so a live check can never reach
the production dashboard; with no `UM_LIVE_HUB` it points at a dead port on
purpose.

The hub has to be able to call the site back over HTTP. Laragon's Apache is
broken on this machine (`ServerRoot` points at a missing `httpd-2.4.57`), so the
rig used for this is PHP's own server with a small router, the same one used
in #16:

```bash
php -S 127.0.0.1:8765 -t D:/laragon/www/wordpresstester router.php
```

The router sets `REQUEST_SCHEME`, which `php -S` does not and this site's
`wp-config.php` reads — without it a PHP warning is printed before the JSON body
and nothing can parse the response. That is a property of the rig, not of the
plugin.
