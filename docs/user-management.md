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

### Elevated roles, in two tiers

A role is reported with two flags, and the difference is load-bearing:

| Flag | Means | Effect |
|---|---|---|
| `is_site_admin` | can administer the site **or execute code on it** — `manage_options`, `promote_users`, `edit_users`, `delete_users`, `install_plugins`, `activate_plugins`, `edit_plugins`, `edit_themes`, `switch_themes`, `edit_files`, `update_core`, `import`/`export`, and the multisite equivalents | **Requires `users:admin` AND an explicit confirmation** |
| `is_admin_like` | the above, **or** `unfiltered_html` | Shown as a notice |

They are separate because **stock WordPress grants `unfiltered_html` to Editor**,
and Editor is every team's default role. A confirmation keyed on the broad flag
would fire on the single most common assignment there is — and a confirmation
that fires on the common case is one people learn to click through, which is
worse than not having it.

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

1. **Websites** tab → **Connect…** on the site → a code appears.
2. Open that site's WP Admin → **DE Monitoring** → **User management**, paste the
   code, press **Connect**.
3. Back in the dashboard, press **Re-check all**.

The code is valid for 15 minutes and works once. It grants nothing on its own —
the site must also present its own monitoring license key to redeem it.

**This step always needs someone with access to the client's WP Admin.** That is
deliberate: user management cannot be switched on remotely, so a compromised
dashboard cannot enroll a site by itself.

### 4. Decide what each site allows

While in DE Monitoring, that site's administrator chooses whether we may:

- **delete users** (`users:delete`)
- **grant Administrator** (`users:admin`)

**Both are off by default.** They are switched on locally, per site, and this
dashboard cannot turn them on — it is the client's kill switch, not ours.
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
- **Least privilege.** Administrator can never be a team or per-user *default*.
  It is granted per website, with an explicit confirmation _(later phase)_.
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

All of them run without a database or a WordPress install.

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
