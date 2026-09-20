# Changelog — Digital Elements Helper Plugin

## Unreleased — user management (de/v2)

Not yet released. The version header deliberately stays at 2.5.0 while this is
built, so `/api/plugin/manifest` never offers client sites an update to a
half-finished feature. It is bumped once, in the final phase, when the whole
feature ships.

- New `de/v2` REST namespace for centralized user management, separate from
  `wpmonitor/v1`. Monitoring is untouched: sites that never update keep working
  exactly as they do today.
- New `de/v2/capabilities` endpoint reporting the plugin version, the contract
  revision, which features this build implements, and whether the site is
  connected. The dashboard probes this before any user operation, so a site on
  an older plugin is shown as "update required" instead of failing opaquely
  part-way through a bulk run.
- User-management requests are NOT authorized by the license key. Each site
  gets a separate, scoped credential and every request is signed (HMAC-SHA256
  over the method, route, query, timestamp, nonce, idempotency key and body),
  so a captured request can't be replayed, retargeted or edited in flight.
- DE Monitoring gains a "User management" section: connect the site by pasting
  a one-time code, choose locally whether the dashboard may delete users or
  grant Administrator (both OFF by default), and disconnect at any time. The
  site always initiates the connection — user management cannot be switched on
  remotely.
- Deleting the plugin now removes the user-management credential, unlike the
  license key which is deliberately kept.

## 2.5.0
- Scan images now keeps a short history of past scans (totals and counts only —
  no per-file data), so the dashboard can show what changed since last time.
  The response carries the previous scan as `previous`, or null on a first run.
- Fix: samples showed only the file's basename, so two different attachments in
  different upload folders rendered as identical rows. They now show the
  uploads-relative path (e.g. `2023/08/slide2.png`).
- Fix: an image barely over the width threshold (e.g. 2580px, ~290 B
  recoverable) could occupy a "worst offenders" slot that a multi-megabyte file
  should have had. Samples now need a minimum estimated saving of 100 KB,
  filterable via `deheled_images_sample_min_saving`. If nothing clears the bar,
  the single largest is still shown rather than none.

## 2.4.0
- New optimization: "Scan images" — audits the media library and reports images
  stored far wider than they are ever rendered, files over 500 KB, and JPEG/PNGs
  with no WebP version, along with an estimated recoverable size for each.
  READ-ONLY: no file is resized, re-encoded, converted, or deleted. Savings are
  estimates from pixel area and typical WebP ratios, not measured re-encodes.
  The scan is bounded by both an item cap (5,000) and a 12-second budget, and
  says so explicitly when either one cuts it short rather than silently
  reporting a partial library as complete. Results are cached for 12 hours;
  `?fresh=1` forces a rescan. Thresholds are filterable
  (`deheled_images_large_bytes`, `deheled_images_max_items`,
  `deheled_images_budget_ms`, `deheled_images_cache_ttl`).

## 2.3.2
- New optimization: "Remove transients" — clears all transients (not just
  expired) and sweeps orphaned timeout rows from the options table, freeing
  database bloat. Safe: transients are regenerable temporary data. Reports the
  verified count removed.

## 2.3.1
- Clear cache now verifies its work: it measures WP Rocket's cache folder
  before and after purging and reports the actual file count removed, and uses
  the object cache's real flush result. The dashboard shows a per-layer
  verified/cleared status with details instead of a plain list.

## 2.3.0
- New: website optimization actions triggered from the Digital Elements
  dashboard. Phase 1 adds "Clear cache" — a token-authenticated endpoint that
  flushes the object cache, expired cache transients, and any active caching
  plugin (WP Rocket, W3 Total Cache, WP Super Cache, LiteSpeed, Cloudflare,
  Autoptimize, SiteGround) and reports exactly what was cleared. Only clears
  regenerable caches; never touches content, settings, or files.

## 2.2.2
- llms.txt is now written as a PHYSICAL file in the WordPress root (next to
  robots.txt) when enabled, and removed when disabled. Required on hosts like
  WP Engine whose web server answers .txt URLs directly from disk (the
  dynamic route never ran, so /llms.txt returned the server's 404).
- Dynamic serving remains as an automatic fallback when the root isn't
  writable, with a clear warning shown in the editor.
- Never deletes or silently replaces an llms.txt file the plugin didn't
  write — a differing existing file triggers an overwrite warning first.

## 2.2.1
- Fix: llms.txt starter template no longer shows HTML entities (e.g. "&amp;amp;")
  in the site title/tagline — decoded to plain text.
- "Check again" on Dashboard → Updates now bypasses the plugin's 6-hour update
  cache so new releases appear immediately.

## 2.2.0
- New: editable llms.txt. A new "llms.txt" page under DE Monitoring lets you
  write and publish an llms.txt file (https://llmstxt.org/) that helps AI
  assistants understand and cite the site. Served dynamically at /llms.txt —
  the same way WordPress serves robots.txt, with nothing written to disk —
  so it works with any permalink setup and survives core updates.
- A starter template is generated automatically from the site's pages.
- Warns if a physical llms.txt file in the WordPress root would override it.

## 2.1.0
- New: lightweight page-view analytics. A tiny (<400 byte) inline beacon fires
  after each front-end page finishes loading (navigator.sendBeacon — zero
  impact on site speed; no cookies, no external scripts, no PII stored).
  Powers "Most visited pages" and "Real-time views" in the dashboard.
- The analytics endpoint is configured automatically via license validation —
  nothing to set up on the site. Opt out with
  `add_filter('deheled_analytics_enabled', '__return_false');`
- Logged-in users, previews and feeds are never tracked.

## 2.0.1
- Show the running plugin version on the DE Monitoring panel.
- First release delivered through the built-in updater (test release).

## 2.0.0
- Restructured into a standard WordPress plugin layout (includes/ + assets/).
- Panel CSS/JS moved to properly enqueued asset files.
- Added self-updates from the Digital Elements dashboard: new versions appear
  on the Plugins screen with one-click Update.
- Added uninstall cleanup (keeps the license key so reinstalls reconnect).

## 1.5
- History & trends section in the admin panel (uptime, PageSpeed, response
  time, SSL charts) fetched from the dashboard.

## 1.4
- License verification against the dashboard with live status and locked
  field once confirmed.

## 1.3
- Deep security scan: PHP-in-uploads, backdoor signatures, core checksums,
  new admin accounts. Daily cron + Run scan now.

## 1.2
- License-key authentication (no wp-config edits) and admin panel checks.
