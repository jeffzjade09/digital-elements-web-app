# WP Monitor

A self-hosted dashboard for maintaining multiple WordPress sites. For every site it checks, in one sweep:

- **HTTPS response** — reachability, status code, response time, HTTP→HTTPS
- **SSL certificate** — days until expiry (warns before it lapses)
- **Cloudflare** — whether traffic is served through Cloudflare
- **CTM script** — whether the CallTrackingMetrics tracking script is present
- **Google Tag** — whether GTM / GA4 (gtag.js) is present, and the container IDs
- **PageSpeed** — Google PageSpeed Insights performance score + Core Web Vitals
- **Updates** — pending WordPress core, plugin and theme updates (via a helper plugin)

Checks run **on demand** from the dashboard and **on a schedule** in the background, with **alerts** (Slack and/or email) when a site's status changes.

---

## Requirements

- Node.js 18 or newer (`node -v`)
- A Google PageSpeed Insights API key (free, optional but recommended)
- Admin access to each WordPress site to install the small helper plugin (only needed for the update counts)

## Setup

```bash
npm install

cp .env.example .env                       # then edit .env
cp config/sites.example.json config/sites.json   # then edit your sites
```

Edit `.env` (PageSpeed key, schedule, alert channels) and `config/sites.json` (your sites). Then:

```bash
npm start          # dashboard at http://localhost:4000
```

Open the URL, hit **Run checks**, and click any site row for full detail. To run a one-off sweep from the terminal instead:

```bash
npm run check
```

## PageSpeed API key

Without a key you share a tiny anonymous quota and will be rate-limited fast. Create a free key at
https://developers.google.com/speed/docs/insights/v5/get-started and put it in `.env` as `PAGESPEED_API_KEY`.

## WordPress helper plugin (for update counts)

The public-facing checks need no login, but reading pending updates requires talking to each site. Install the helper:

1. Open `wordpress-plugin/wpmonitor-helper.php`.
2. Set a long, unique token per site — change the `WPMONITOR_TOKEN` value (or define `WPMONITOR_TOKEN` in that site's `wp-config.php`, which takes priority).
3. Upload it to the site at `wp-content/mu-plugins/wpmonitor-helper.php`. The `mu-plugins` folder auto-activates the file and clients can't disable it. (Create the folder if it doesn't exist.)
   *Alternative:* put the file in its own folder, zip it, and upload via **Plugins → Add New → Upload**, then activate.
4. In `config/sites.json`, set the matching token and endpoint for that site:

```json
"helper": {
  "enabled": true,
  "endpoint": "https://clientsite.com/wp-json/wpmonitor/v1/status",
  "token": "the-same-token-you-set-in-the-plugin"
}
```

Sites with `"helper": { "enabled": false }` simply show "Not set up" for the Updates column; every other check still runs.

Quick test from your machine:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://clientsite.com/wp-json/wpmonitor/v1/status
```

## Per-site expectations

Each site can declare what it *should* have, so optional integrations don't flag as problems:

```json
"expect": { "cloudflare": true, "ctm": true, "googleTag": true }
```

Set any of these to `false` and a missing script/integration shows a neutral "Not used" instead of a warning or failure.

## Scheduling & alerts

In `.env`:

- `CHECK_CRON` — when background sweeps run (default `0 */6 * * *`, every 6 hours)
- `CHECK_ON_START` — run one sweep immediately when the server boots
- `SLACK_WEBHOOK_URL` — incoming webhook for Slack alerts
- `SMTP_*` + `ALERT_EMAIL_TO` — email alerts via SMTP

Alerts fire only on **status changes** (a check newly degrading, or recovering), so you're not paged about the same issue every cycle. With no channel configured, changes are logged to the console.

## Status meaning

- **OK** (green) — passing
- **Warn** (amber) — needs attention (updates pending, SSL expiring soon, PageSpeed below target, expected integration missing)
- **Fail** (red) — broken (site down, SSL expired/error, required script missing, helper unreachable)
- **Skip** (grey) — not configured for this site (e.g. helper disabled)

Thresholds (`PAGESPEED_WARN`, `PAGESPEED_FAIL`, `SSL_WARN_DAYS`) are tunable in `.env`.

## Keeping it running

For a server, run it under a process manager so it restarts on reboot/crash:

```bash
npm install -g pm2
pm2 start src/server.js --name wp-monitor
pm2 save && pm2 startup
```

## Optimizations

On a site's detail page, users with `manageWebsites` see an **Optimization** panel.
Each action proxies to that site's helper plugin, which does the work on WordPress
and reports back per-layer results the dashboard renders inline.

| Action | Helper version | Effect |
| --- | --- | --- |
| **Clear cache** | 2.3+ | Flushes the object cache and any active caching plugin (WP Rocket, W3TC, WP Super Cache, LiteSpeed, Cloudflare, Autoptimize, SiteGround). Only regenerable caches — reversible by definition. |
| **Remove transients** | 2.3.2+ | Deletes all transients and any genuinely orphaned timeout rows. Transients are regenerable temporary data. |
| **Scan images** | 2.5+ | **Read-only audit.** Reports images stored far wider than they are rendered, files over 500 KB, and JPEG/PNGs with no WebP version, then turns those measurements into a prioritised, actionable report. Changes nothing. |

### The Scan images report

The plugin measures; the dashboard turns those measurements into recommendations
in [`src/imageReport.js`](src/imageReport.js). That split is deliberate — wording
and priority thresholds get tuned often, and keeping them server-side means no
plugin release to every client site, plus the logic is testable without WordPress.

Each report contains:

- **A summary** — issue count, recoverable size as an absolute and as a share of
  media weight, and a breakdown by priority.
- **One block per issue**, worst first, each with why it matters, the recommended
  change, numbered steps to carry it out, the worst offending files, and how to
  verify the change worked.
- **Priority** — Critical / High / Medium / Low, **derived from measured impact**,
  never hand-assigned, so it can't drift out of step with the numbers beside it.
  Both absolute size and proportion count: 20 MB matters on a 40 MB library and
  barely registers on a 4 GB one. Critical is deliberately hard to reach.
- **Before / after** — every metric against the previous scan, with signed deltas.
  A first scan says it has no baseline rather than implying nothing changed, and
  an unchanged scan reads "no change" rather than as an improvement.

Two things the report is careful about, both worth preserving if you extend it:

- **No double-counting.** "Files over 500 KB" describes the same bytes as the
  resize and WebP issues, so it contributes **zero** to the headline total. Left
  unchecked, overlapping rules inflate the figure past what is actually
  recoverable.
- **Estimates stay labelled.** Savings come from pixel area and a typical WebP
  ratio, not measured re-encodes. The area model holds up for PNG and is rougher
  for JPEG.

Issue IDs (`images.oversized`, `images.webp`, `images.large`,
`images.missing_files`) are stable so per-issue workflow state can attach to them
later. Every issue currently reports `status: "pending"`; approval and status
transitions are the next increment.

Notes on **Scan images** specifically, since its output feeds the monthly
optimization workflow:

- It is an *audit*, not an optimizer. No file is resized, re-encoded, converted,
  or deleted. Acting on the findings is a separate, deliberately approval-gated
  step (not yet built).
- Savings are **estimates** — derived from pixel area for oversized images and a
  conservative 28% ratio for WebP — not measured re-encodes. The estimates chain
  rather than sum, so a resize and a WebP conversion of the same file are not
  double-counted.
- The scan is bounded by an item cap (5,000 images) *and* a 12-second budget. If
  either cuts it short, the result says so explicitly and reports how many of how
  many were checked — a partial scan never presents as a complete one.
- Results are cached for 12 hours. Thresholds are filterable:
  `deheled_images_large_bytes`, `deheled_images_max_items`,
  `deheled_images_budget_ms`, `deheled_images_cache_ttl`.

## Building the helper plugin

The zip served by `/api/plugin/download` is a build artifact, not something to
edit by hand:

```bash
npm run build:plugin
```

This reads the version from the plugin header, **fails** if `DEHELED_VERSION`
disagrees with it, packages `wordpress-plugin/digital-elements-helper/` into
`wordpress-plugin/dist/`, and writes a `.sha256` alongside. Output is
byte-reproducible for identical input, so the checksum is stable and meaningful.
Run it after any plugin change — otherwise `/api/plugin/manifest` advertises a
version the downloadable zip doesn't contain, and WordPress will offer the same
update forever.

## WordPress user management

Settings → **WP Users** manages the agency's WordPress accounts across every
connected site from one place: teams of staff, their default WordPress roles,
and an activity log of every administrative change.

Access is governed by its own `manageWpUsers` permission — separate from
`manageUsers`, which only governs who may sign in to this dashboard. It is held
by anyone with the `admin` role plus an explicit allow-list stored in
`app_settings.wp_user_managers`.

Connected websites are enrolled one at a time: the dashboard issues a one-time
code, someone with access to that site's WP admin pastes it into DE Monitoring,
and the site redeems it for its own scoped credential. User-management requests
are signed per request and are **not** authorized by the monitoring license key,
so a leaked license key can never create an account.

Setting it up:

1. Generate the key and restart —
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   into `USER_MGMT_ENC_KEY`. **Back it up**: losing it means re-enrolling every
   site. Without it, teams and staff still work and the feature reports itself
   unconfigured.
2. Let helper plugin **2.6.0** reach each site through the normal update
   mechanism. Settings → WP Users → **Sync status** shows which sites are still
   behind; sites with auto-updates off need someone to press Update there.
3. **Connect each site** — about 30 seconds each. Generate a code on the
   Websites tab, paste it into that site's DE Monitoring → User management.
   This always needs someone with access to the client's WP Admin: user
   management cannot be switched on remotely.
4. That site's administrator decides whether we may **delete users** or **grant
   Administrator**. Both are off by default and only they can turn them on.

Administrator is a permitted team and per-user default — this agency administers
the sites it builds. It stays gated by the per-site `users:admin` scope, which
only that site's own administrator can grant, and by a single confirmation
before each job runs. Role choices are the core five plus every role discovered
on a connected website, so client-specific roles can be selected too.

The roster of teams and staff is seeded by a migration and fully editable
afterwards. Database changes for this feature live in `db/migrations/`, applied
once each at boot by `src/migrate.js` and recorded in `schema_migrations`;
never edit a migration that has already run, add a new one.

See [docs/user-management.md](docs/user-management.md) for the data model, the
API, the safety rules, and the roadmap for the phases that talk to WordPress.

## Tests

```bash
npm test
```

Dependency-free: each suite is a standalone script that exits non-zero on
failure. PHP suites are skipped (not failed) when no `php` binary is on PATH.

```
tests/optimize-images.test.php      image audit: thresholds, chained estimates,
                                    boundaries, truncation disclosure, WebP
                                    sibling detection against real GD-made files
tests/render-image-audit.test.mjs   dashboard renderer: formatting parity with
                                    the PHP side, partial-scan warnings, and
                                    escaping of file names from client sites
tests/usermgmt-policy.test.mjs      user management: the permission model and
                                    grant list, role vocabulary, agency-domain
                                    restriction, and audit redaction
tests/usermgmt-migrations.test.mjs  migration ordering, nothing destructive in
                                    them, and the seeded roster
tests/usermgmt-signing.test.mjs     request signing, credential encryption, the
                                    SSRF guard, capability gating
tests/usermgmt-auth.test.php        the plugin's side of the same signing
                                    contract: tampering, clock window, replay,
                                    scopes, rate limiting
tests/usermgmt-preflight.test.mjs   what the review screen predicts for every
                                    person x website pair, and the two role
                                    elevation tiers
tests/usermgmt-users.test.php       the read routes: scope enforcement, and that
                                    no password hash or unrelated user meta can
                                    leave a client site
tests/usermgmt-write.test.php       every write guard: managed-only, the role
                                    whitelist, admin confirmation, the last
                                    administrator, idempotent replay, and that
                                    no generated password reaches a response
tests/usermgmt-sync.test.mjs        the idempotency key, retry-only-on-transient,
                                    and the bounded concurrency executor
tests/usermgmt-content.test.php     ownership counting incl. custom post types,
                                    reassignment validation, every deletion
                                    refusal, and the stale-UI orphan case
tests/usermgmt-deletion.test.mjs    the ownership summary, per-website
                                    independence, team-delete disposition
```

### Live check against a real WordPress install

`npm test` deliberately needs no database, so it can't cover REST route
registration or the code that actually queries WordPress. This does:

```bash
php scripts/live-check.php D:/laragon/www/wordpresstester
```

Point it at any local WordPress root (a directory containing `wp-load.php`) with
its database running. The plugin does **not** need to be installed in
`wp-content/plugins` — it is loaded straight from this repo, so you always test
the working copy rather than a stale installed copy. It verifies every
`wpmonitor/v1` route is registered and token-guarded, that an unauthenticated
request is refused, and that the audit's collector, cache, and JSON payload
behave against a real media library. Read-only apart from the plugin's own result
cache, which it saves and restores.

Run it after any plugin change, and extend it as new optimizations land.

The user-management API has its own equivalent, covering REST route
registration, the signed-request guards against the real options API, and the
capabilities payload:

```bash
php scripts/live-usermgmt-check.php D:/laragon/www/wordpresstester
```

It refuses to run against any host that isn't local, restores the site's
options afterwards, and creates, changes or deletes no WordPress user.

## Project layout

```
src/
  server.js        Express API + serves the dashboard
  migrate.js       ordered SQL migrations, applied once at boot
  usermgmt/        WordPress user management (framework-free modules)
  routes/          Express routers for the newer features
  scheduler.js     cron sweeps + alert dispatch
  runner.js        runs every check per site, rolls up status
  store.js         config + results persistence
  alerts.js        Slack / email, with change detection
  rateLimit.js     throttling for the unauthenticated endpoints
  cli.js           one-off terminal sweep
  checks/          one module per check
public/index.html  the dashboard UI
public/wpusers.*   the WP Users interface (JS + CSS)
db/migrations/     ordered schema + seed migrations
scripts/           build tooling (plugin zip)
tests/             test suites + runner
config/sites.json  your sites (you create this)
wordpress-plugin/  the helper plugin to install on each site
  digital-elements-helper/   <- the live plugin (the only copy to edit)
  dist/                      <- built zip, generated by npm run build:plugin
```

## Notes

- Script detection reads the homepage HTML. If a tag only loads on inner pages or is injected late by JavaScript, it may read as missing — point the site `url` at a page where the tag is present, or rely on your tag manager's own reporting for those edge cases.
- All checks have timeouts and per-check error handling, so one slow or broken site never blocks the others.
