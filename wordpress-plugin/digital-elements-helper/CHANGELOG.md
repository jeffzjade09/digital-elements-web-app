# Changelog — Digital Elements Helper Plugin

## 2.7.4 — A Team Members page you can actually work in

Nothing about who can use this screen, what it does, or what it sends has
changed. This is the screen itself.

### What you'll see

- **Four counts at the top** — teams, members, how many are already on this
  website, and how many you've selected — read from the roster in front of you.
- **Search and a team filter.** Both work on the list already loaded, so they
  answer as you type and never go back to the dashboard for it. **Refresh** is
  still the only thing that re-reads the roster.
- **Teams as cards**, two across on a wide screen and one on a narrow one, each
  one collapsible. Which ones you collapse is remembered for this website, so
  the page comes back the way you left it.
- **One line per person**, with their initials, their role, and a single badge
  saying where they stand: already here, active, invitation pending, not
  invited by us, or failed. Every badge says it in words, not just colour.
- **A bar along the bottom** once you've selected someone, with the count, a way
  to clear the selection, and Review. It stays out of the way until there is
  something to do with it, and the page doesn't jump when it appears.

**Select all** on a team picks only the people it can actually add — never
someone already on this website, and never someone the current search has
hidden.

### Fixed along the way

- Typing in a search box no longer would have cost you your place: the page
  updates the rows that are already there instead of rebuilding itself, so
  focus and the cursor stay put.
- A colleague who is on two teams now behaves correctly on both rows.
- If a refresh fails, the roster you already had stays on screen with a **Try
  again** button, instead of the screen emptying.

### Unchanged

Every check that decides whether you can see or use this screen, and everything
the plugin tells the dashboard about who is on this website. Accounts are still
created only by Digital Elements, and no password is ever shown or sent here.

## 2.7.3 — Invitations you can see

When Digital Elements adds a colleague to your website, WordPress emails them a
link to set their own password. Until now nothing showed whether that email
arrived or whether anyone used it — an account could sit unusable for weeks with
no sign of it anywhere.

### What you'll see

Team Members now shows, for each colleague already on this website:

- **Waiting for them to set a password** — invited, link not used yet
- **Email couldn't be delivered — resend** — this website couldn't send it
- **Active** — they've set their own password
- **Not invited by us** — an account this website already had

**Resend invitation** appears where it applies. It asks WordPress to email a
fresh link, exactly as the Lost Password form does. Any earlier link stops
working at that moment — that is WordPress's own behaviour, not something added
here. You can resend up to three times an hour per person.

Accounts this website already had don't get a Resend button, and the screen says
why rather than leaving a gap: they can use "Lost your password?" on the login
page, like any other account here.

### About passwords

Nothing changed, and it is worth stating plainly:

- The password set when an account is created is random, used once, and **never
  shown, stored, logged or sent anywhere** — not to Digital Elements, not in any
  report, not even when the email fails.
- The reset link is generated and emailed by **WordPress**, from this website,
  to the person's own address. Digital Elements never sees it.
- Nobody can sign in to a new account before setting their own password, because
  there is no password anyone knows.

### Also

- The plugin now records when someone completes a password reset, so "Active"
  reflects something observed rather than guessed. Where it has to be inferred
  from an older account, the screen says so when you hover.
- Whether a set-password link is outstanding is reported to the dashboard as a
  yes/no. **The link and its key never leave this website.**

## 2.7.2 — Team Members shows what is really on this website

### What was wrong

Team Members took "who is already on this site" from the Digital Elements
dashboard, which records what it did when it last acted. It cannot know that
somebody has since deleted an account in **Users** here.

On one site two accounts were deleted that way. The screen went on listing them
as already present -- and said "everyone is already here" -- while the site
actually had one user. Anyone trying to put those colleagues back could not:
the screen would not offer them.

### What changed

The screen now reads this website's own user list. Whether someone is here,
what role they hold, and whether the account is managed by Digital Elements are
all taken from WordPress, not from the dashboard's records.

- Somebody removed in **Users** is shown as not here, and can be added again.
- If the dashboard had believed otherwise, the screen says so, rather than
  quietly showing a different list than it did last time.
- The correction is sent back to the dashboard, so its own records stop being
  wrong for everyone else too.

**Nothing is created, deleted or re-roled to make the two agree.** If somebody
removed an account on purpose, this notices and reports it -- it does not put
the account back. Adding a colleague is still an explicit action on this screen.

### For site administrators

Nothing about what this website allows has changed. The plugin reads your user
list, which it could already do, and writes nothing without you asking.

## 2.7.1 — Team Members: who it lets in

A fix to 2.7.0, released the same day. **Update to this version if you have
2.7.0** — the panel needs it to work at all.

### What was wrong

Team Members only recognised a Digital Elements colleague if their WordPress
account had been created, or explicitly linked, by the Digital Elements
dashboard. Colleagues whose account on a site predates that — most of them, on
most sites — were turned away with "your account isn't managed by Digital
Elements", even though the dashboard knows exactly who they are.

### What changed

Who may use the screen is now decided by the Digital Elements dashboard, which
holds the staff list, rather than by a flag on the WordPress account:

1. the logged-in user can edit users **and** assign roles on this site;
2. their email is on exactly the digitalelementsgroup.com domain — not a
   subdomain, and not a look-alike;
3. the dashboard recognises that address as active staff in the **Web
   Development** or **Admin** team;
4. this site's Digital Elements license is present, verified and unexpired;
5. user management is connected here, this site has allowed account changes, and
   Digital Elements permits this site to add staff.

Only Web Development and Admin may use it. Everyone else is told so, by name of
team, rather than being refused without explanation.

**Your own administrators still never see this screen.** Nothing here widens who
can reach it — a site's own administrator is not on the Digital Elements staff
list, and that is what is checked.

### Adopting an existing account

The first time a recognised colleague opens the screen, the dashboard adopts the
WordPress account they are signed in as, so it can be managed from then on. It
uses the same linking step the dashboard has always used, and records it in the
activity log.

**It cannot adopt an administrator account unless this site has allowed Digital
Elements to manage administrator accounts** (DE Monitoring → User management).
That switch is yours, and this does not go around it: if it is off, the account
stays unlinked, the refusal is recorded with its reason, and the screen still
works.

### Also

- Clearer messages when the screen isn't available: not on the staff list, in a
  team that can't use it, or this plugin needing an update are now three
  different answers instead of one.
- The plugin tells the dashboard who is acting on every request, so the activity
  log names a person rather than just a website.

## 2.7.0 — Team Members

Adds **DE Monitoring → Team Members**, so a member of Digital Elements staff
already working in your WP Admin can add a colleague to this site without
anyone switching to the Digital Elements dashboard.

**Installing this update changes nothing on your site by itself.** The screen is
dormant until every condition below is met, and it is invisible to your own
administrators.

### Who can see it

All four, checked on the server every time — not by hiding a menu:

1. this site's Digital Elements license is present, verified and unexpired;
2. user management is connected here, this site has allowed account changes,
   and Digital Elements permits this site to add staff;
3. the logged-in user can edit users **and** assign roles on this site;
4. the logged-in user is a Digital Elements account (created by Digital
   Elements, on the digitalelementsgroup.com domain).

Condition 4 is why **your own administrators never see this screen**, even
though they hold every capability on the site. It is for our staff working
here, not for the site's owners, and it is not something the site can turn on
for itself.

If any condition isn't met the screen says which one, and offers nothing else.
If the Digital Elements dashboard can't be reached, the screen says so rather
than half-working.

### What it does, and doesn't

Adds existing Digital Elements staff to **this** site, with the role Digital
Elements has set for them, which can be lowered but never raised above the
level of whoever is using the screen.

The plugin does **not** create the account itself. It asks the Digital Elements
dashboard, which creates it through exactly the same path it has always used —
the same checks, the same activity log, and the same "set your password" email
WordPress sends. Passwords are never displayed, stored, logged or transmitted.

It cannot edit or delete anyone, cannot change roles in bulk, cannot see or
touch any other website, and never acts on an account Digital Elements didn't
create.

Retrying a failed run is safe: it resumes the same job rather than adding
everybody a second time.

### For site administrators

Nothing here changes what this site has already allowed under **DE Monitoring →
User management**. Turning off user management there, or disconnecting the
site, removes this screen too.

## 2.6.1

- The capabilities endpoint now reports which website in the Digital Elements
  dashboard this site's license key is registered to.

  A plugin carrying another site's key — usually because the install was cloned
  from a staging copy — is the commonest reason an enrollment code is refused,
  and the refusal the dashboard can safely return deliberately says nothing
  about why. Reporting the linked website lets the dashboard warn before a code
  is issued and someone walks over to paste it in. It is the site's own name,
  already shown in this plugin's own admin panel, so nothing new is disclosed.

- No behaviour change on the site itself.

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
