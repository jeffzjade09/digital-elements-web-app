# Changelog — Digital Elements Helper Plugin

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
