# Changelog — Digital Elements Helper Plugin

## 2.6.0 — user management (de/v2)

Adds centralized user management, controlled entirely from the Digital Elements
dashboard. **Installing this update changes nothing on your site by itself.**
The feature stays dormant until an administrator of this site connects it from
DE Monitoring, and stays limited to what that administrator allows.

What it can never do, regardless of what the dashboard asks:

- touch an account it did not create, unless you deliberately link that account
- change the email address of, or send a password reset to, an account it did
  not create — linking lets it manage that account's **role**, nothing more
- delete a user, or grant Administrator or any role that can install plugins or
  edit files, unless you switch those on here
- delete a user who still owns any content — ownership is re-counted at the
  moment of deletion, so nothing is ever orphaned
- remove your site's last administrator

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
- Read endpoints, all requiring the `users:read` scope:
  `GET de/v2/roles` (from `get_editable_roles()`, so plugin-defined and
  owner-restricted roles are honoured), `GET de/v2/users` (paged) and
  `GET de/v2/users/lookup` (email first, case-insensitively, then username).
- A user leaves this site in a fixed shape built field by field — never the
  WP_User object with fields removed — so a future WordPress release cannot
  silently widen what is disclosed. No password hash, no activation key, no
  session tokens, and `_de_managed` is the only user meta read or reported.
- Write endpoints, all requiring the `users:write` scope: `POST de/v2/users`,
  `PATCH de/v2/users/{id}`, `POST de/v2/users/{id}/link`, `/unlink` and
  `/password-reset`. Every guard is enforced in PHP regardless of what the
  dashboard sent:
  - accounts without `_de_managed` are refused (`not_managed`); `/link` is the
    single route allowed to touch one, and is an explicit action;
  - target roles are whitelisted against `get_editable_roles()`;
  - a role that can administer the site needs the `users:admin` scope AND an
    explicit `confirm_admin` — neither substitutes for the other;
  - the site's last administrator can never be demoted or unlinked.
- Passwords are generated with `wp_generate_password(32, true, true)`, handed to
  WordPress and never referenced again: not returned, not logged, not stored by
  us. If the set-password email fails, that is a WARNING on a successful create.
  There is no condition under which a password is disclosed instead.
- Mail delivery is now judged from `pre_wp_mail`, `wp_mail_succeeded` and
  `wp_mail_failed` rather than from whether the `wp_mail` filter ran. wp_mail()
  applies that filter BEFORE `pre_wp_mail` can short-circuit, so a plugin that
  silently drops the message previously looked like a successful send.
- Every write requires an `Idempotency-Key`. The first result for a key is
  stored and replayed verbatim with `X-DE-Idempotent-Replay: 1`; an in-flight
  claim via `add_option()` means two concurrent duplicates can't both win. Only
  successful results are cached, so a corrected retry of a rejected request
  still works.
- Reassignment and deletion both refuse an account this plugin did not create
  or that you did not link. Reassignment rewrites authorship and overwrites
  comment author details in place, so it cannot be undone by running it
  backwards, and is guarded exactly like deletion.
- Linking an existing account requires an explicit confirmation of its own, and
  an account that was linked rather than created can never have its email
  changed or a password reset sent from the dashboard.
- Content ownership and guarded deletion: `GET de/v2/users/{id}/content`
  (`users:read`), `POST de/v2/users/{id}/reassign` (`content:reassign`) and
  `DELETE de/v2/users/{id}` (`users:delete`, which is OFF unless this site's own
  administrator enables it).
- Ownership is counted across EVERY registered post type, public and private,
  including attachments and plugin-defined types, broken down by status with
  scheduled content called out. Authored comments are counted too. Revisions are
  excluded — they follow their parent.
- Deletion re-counts ownership INSIDE the delete request and refuses with
  `has_content` if anything is left. A dashboard can show a correct "0 remaining"
  and then sit on screen while a post is published or a scheduled post goes
  live; deleting on the strength of that earlier count would silently destroy
  content.
- `wp_delete_user()` is called with no reassignment argument, deliberately.
  WordPress's own argument moves only posts and links and silently deletes
  everything else the account owns, so reassignment is a separate, verified step
  and there is nothing left to pass by the time deletion runs.
- Reassignment moves every post type and rewrites comment authorship (user id,
  display name and email), clears the affected caches, then re-counts and
  returns the verified remainder rather than a claim that the move ran.
- Roles report two elevation tiers. `is_site_admin` covers administering the
  site or executing code on it — manage_options, promote_users, edit_users,
  delete_users, install_plugins, activate_plugins, edit_plugins, edit_themes,
  switch_themes, edit_files, update_core, import/export and the multisite
  equivalents. The broader `is_admin_like` also counts `unfiltered_html`. WordPress grants unfiltered_html to
  Editor, so keeping them separate stops a confirmation firing on the most
  ordinary assignment there is.

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
