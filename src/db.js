// PostgreSQL data layer (Supabase). Uses a direct connection (DATABASE_URL).
// Enforcement of who-can-do-what lives in the app (see auth.js); this module is
// just typed data access.

import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const { Pool } = pg;

// A readable per-site license key, e.g. DEG-3F9A2-88C1D-4E0BB-7A6F2
export function generateLicenseKey() {
  const raw = crypto.randomBytes(10).toString("hex").toUpperCase();
  return "DEG-" + raw.match(/.{1,5}/g).join("-");
}
// Duration code -> expiry timestamp. "none" means never expires.
export function durationToExpiry(dur) {
  if (dur === "none") return null;
  const months = { "3m": 3, "6m": 6, "1y": 12 }[dur] || 12;
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

let pool = null;

export function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy it from Supabase > Project Settings > Database.");
  }
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }, // Supabase requires SSL
    max: 5,
  });
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

// ---- Row -> runner shape --------------------------------------------------
// The checks/runner expect: { id, name, url, helper:{...}, expect:{...}, clickup:{...} }
function rowToSite(r) {
  const exp = r.license_expires_at ? new Date(r.license_expires_at) : null;
  const derivedEndpoint = r.url ? r.url.replace(/\/+$/, "") + "/wp-json/wpmonitor/v1/status" : undefined;
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    helper: {
      enabled: r.helper_enabled,
      endpoint: r.helper_endpoint || derivedEndpoint,
      token: r.license_key || r.helper_token || undefined, // license key is the auth token
    },
    license: {
      key: r.license_key || null,
      expiresAt: r.license_expires_at || null,
      expired: exp ? exp.getTime() < Date.now() : false,
      daysLeft: exp ? Math.ceil((exp.getTime() - Date.now()) / 86400000) : null,
    },
    expect: {
      cloudflare: r.expect_cloudflare,
      ctm: r.expect_ctm,
      googleTag: r.expect_google_tag,
    },
    clickup: {
      enabled: r.clickup_enabled,
      listIds: r.clickup_list_ids || [],
      folderId: r.clickup_folder_id || undefined,
      spaceId: r.clickup_space_id || undefined,
    },
    zoho: {
      enabled: r.zoho_enabled || false,
      projectIds: r.zoho_project_ids || [],
    },
  };
}

// ---- Websites -------------------------------------------------------------
export async function getWebsites() {
  const { rows } = await query("select * from websites order by name asc");
  return rows.map(rowToSite);
}

export async function getWebsiteRaw(id) {
  const { rows } = await query("select * from websites where id = $1", [id]);
  return rows[0] || null;
}

export async function getWebsiteSite(id) {
  const raw = await getWebsiteRaw(id);
  return raw ? rowToSite(raw) : null;
}

export async function createWebsite(d, userId) {
  const licenseKey = generateLicenseKey();
  const expiresAt = durationToExpiry(d.license_duration || "1y");
  const { rows } = await query(
    `insert into websites
      (name,url,helper_enabled,helper_endpoint,helper_token,
       expect_cloudflare,expect_ctm,expect_google_tag,
       clickup_enabled,clickup_list_ids,clickup_folder_id,clickup_space_id,
       zoho_enabled,zoho_project_ids,created_by,
       license_key,license_expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     returning *`,
    [
      d.name, d.url, !!d.helper_enabled, d.helper_endpoint || null, d.helper_token || null,
      d.expect_cloudflare !== false, d.expect_ctm !== false, d.expect_google_tag !== false,
      !!d.clickup_enabled, d.clickup_list_ids || [], d.clickup_folder_id || null, d.clickup_space_id || null,
      !!d.zoho_enabled, d.zoho_project_ids || [],
      userId || null, licenseKey, expiresAt,
    ]
  );
  return rowToSite(rows[0]);
}

// Issue a fresh key (invalidates the old one) and reset the expiry window.
export async function regenerateLicense(id, duration) {
  const { rows } = await query(
    "update websites set license_key=$2, license_expires_at=$3, updated_at=now() where id=$1 returning *",
    [id, generateLicenseKey(), durationToExpiry(duration || "1y")]
  );
  return rows[0] ? rowToSite(rows[0]) : null;
}
// Extend the expiry without changing the key (client keeps their key).
export async function renewLicense(id, duration) {
  const { rows } = await query(
    "update websites set license_expires_at=$2, updated_at=now() where id=$1 returning *",
    [id, durationToExpiry(duration || "1y")]
  );
  return rows[0] ? rowToSite(rows[0]) : null;
}

export async function updateWebsite(id, d) {
  const { rows } = await query(
    `update websites set
       name=$2,url=$3,helper_enabled=$4,helper_endpoint=$5,helper_token=$6,
       expect_cloudflare=$7,expect_ctm=$8,expect_google_tag=$9,
       clickup_enabled=$10,clickup_list_ids=$11,clickup_folder_id=$12,clickup_space_id=$13,
       zoho_enabled=$14,zoho_project_ids=$15,
       updated_at=now()
     where id=$1 returning *`,
    [
      id, d.name, d.url, !!d.helper_enabled, d.helper_endpoint || null, d.helper_token || null,
      d.expect_cloudflare !== false, d.expect_ctm !== false, d.expect_google_tag !== false,
      !!d.clickup_enabled, d.clickup_list_ids || [], d.clickup_folder_id || null, d.clickup_space_id || null,
      !!d.zoho_enabled, d.zoho_project_ids || [],
    ]
  );
  return rows[0] ? rowToSite(rows[0]) : null;
}

export async function deleteWebsite(id) {
  await query("delete from websites where id = $1", [id]);
}

// ---- Users ----------------------------------------------------------------
export async function listUsers() {
  const { rows } = await query("select id,email,name,role,created_at,last_login from app_users order by email");
  return rows;
}
export async function getUserByEmail(email) {
  const { rows } = await query("select * from app_users where lower(email)=lower($1)", [email]);
  return rows[0] || null;
}
export async function getUserById(id) {
  const { rows } = await query("select * from app_users where id = $1", [id]);
  return rows[0] || null;
}
export async function createUser(email, role, name) {
  const { rows } = await query(
    "insert into app_users (email,role,name) values ($1,$2,$3) on conflict (email) do update set role=excluded.role returning *",
    [email.trim().toLowerCase(), role, name || null]
  );
  return rows[0];
}
export async function updateUserRole(id, role) {
  const { rows } = await query("update app_users set role=$2 where id=$1 returning *", [id, role]);
  return rows[0] || null;
}
export async function deleteUser(id) {
  await query("delete from app_users where id = $1", [id]);
}
export async function touchLogin(id, name) {
  await query("update app_users set last_login=now(), name=coalesce($2,name) where id=$1", [id, name || null]);
}
// Per-user preference: 'dark' | 'light' | 'system' (validated in the API layer).
export async function updateUserTheme(id, theme) {
  await query("update app_users set theme=$2 where id=$1", [id, theme]);
}

// ---- Social links ---------------------------------------------------------
export async function getSocialLinks(websiteId) {
  const { rows } = await query("select id,platform,url from social_links where website_id=$1 order by platform", [websiteId]);
  return rows;
}
export async function addSocialLink(websiteId, platform, url, userId) {
  const { rows } = await query(
    "insert into social_links (website_id,platform,url,created_by) values ($1,$2,$3,$4) returning id,platform,url",
    [websiteId, platform, url, userId || null]
  );
  return rows[0];
}
export async function deleteSocialLink(id) {
  await query("delete from social_links where id = $1", [id]);
}

// ---- Landing pages (monitored URLs under a website; no plugin needed) ------
export async function getLandingPages() {
  const { rows } = await query("select id, website_id, name, url from landing_pages order by name asc");
  return rows.map((r) => ({ id: r.id, websiteId: r.website_id, name: r.name, url: r.url }));
}
export async function createLandingPage(websiteId, name, url, userId) {
  const { rows } = await query(
    "insert into landing_pages (website_id,name,url,created_by) values ($1,$2,$3,$4) returning id, website_id, name, url",
    [websiteId, name, url, userId || null]
  );
  const r = rows[0];
  return { id: r.id, websiteId: r.website_id, name: r.name, url: r.url };
}
export async function updateLandingPage(id, name, url) {
  const { rows } = await query(
    "update landing_pages set name=$2, url=$3 where id=$1 returning id, website_id, name, url",
    [id, name, url]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return { id: r.id, websiteId: r.website_id, name: r.name, url: r.url };
}
export async function deleteLandingPage(id) {
  await query("delete from landing_pages where id = $1", [id]);
}

// ---- App settings (dashboard-configurable, key/value) ----------------------
export async function getAppSettings() {
  const { rows } = await query("select key, value from app_settings");
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
export async function setAppSettings(obj) {
  for (const key of Object.keys(obj)) {
    await query(
      "insert into app_settings (key,value,updated_at) values ($1,$2,now()) on conflict (key) do update set value=excluded.value, updated_at=now()",
      [key, String(obj[key])]
    );
  }
}

// ---- History: status transitions + periodic metric samples ----------------
export async function recordMetricSample(websiteId, m) {
  await query(
    "insert into metric_samples (website_id, overall, pagespeed, ssl_days, response_ms) values ($1,$2,$3,$4,$5)",
    [websiteId, m.overall || null, m.pagespeed ?? null, m.sslDays ?? null, m.responseMs ?? null]
  );
}
export async function getMetricSamples(websiteId, days = 30) {
  const startIso = new Date(Date.now() - days * 86400000).toISOString();
  const { rows } = await query(
    "select overall, pagespeed, ssl_days, response_ms, at from metric_samples where website_id=$1 and at >= $2 order by at asc",
    [websiteId, startIso]
  );
  return rows.map((r) => ({ overall: r.overall, pagespeed: r.pagespeed, sslDays: r.ssl_days, responseMs: r.response_ms, at: r.at }));
}
// Percentage of the window the site was NOT failing, derived from the recorded
// metric samples (share of samples whose overall status wasn't "fail").
export async function computeUptime(websiteId, days = 30) {
  const startIso = new Date(Date.now() - days * 86400000).toISOString();
  const { rows } = await query(
    "select count(*)::int total, count(*) filter (where overall = 'fail')::int failed from metric_samples where website_id=$1 and at >= $2",
    [websiteId, startIso]
  );
  const total = rows[0]?.total || 0;
  if (!total) return null; // no samples yet
  const failed = rows[0]?.failed || 0;
  return Math.round(((total - failed) / total) * 10000) / 100;
}
// License validation lookup (used by the helper plugin's public check).
export async function getWebsiteByLicense(key) {
  const { rows } = await query("select id, name, license_expires_at from websites where license_key = $1", [key]);
  if (!rows[0]) return null;
  const exp = rows[0].license_expires_at ? new Date(rows[0].license_expires_at) : null;
  const expired = exp ? exp.getTime() < Date.now() : false;
  const daysLeft = exp ? Math.ceil((exp.getTime() - Date.now()) / 86400000) : null;
  return { id: rows[0].id, name: rows[0].name, expiresAt: exp ? exp.toISOString() : null, expired, daysLeft };
}

// Retention: prune trend samples older than N days (they back the trend charts
// and uptime %). status_events are no longer recorded or read.
export async function deleteOldMetricSamples(days) {
  const { rowCount } = await query("delete from metric_samples where at < now() - ($1 * interval '1 day')", [days]);
  return rowCount;
}

// ---- Request metrics (per host per hour) ----------------------------------
// Upsert absolute hourly counts. Buckets only ever increase within an hour, so
// last-writer-wins with the current value is correct and idempotent.
export async function upsertRequestMetrics(entries) {
  if (!entries || !entries.length) return 0;
  let n = 0;
  for (const e of entries) {
    await query(
      `insert into request_metrics (host, hour, plugin, core, external)
       values ($1, to_timestamp($2/1000.0), $3, $4, $5)
       on conflict (host, hour) do update set
         plugin = excluded.plugin, core = excluded.core, external = excluded.external`,
      [e.host, e.hour, e.plugin || 0, e.core || 0, e.external || 0]
    );
    n++;
  }
  return n;
}
// Recent rows (for seeding the in-memory buckets on boot).
export async function getRequestMetrics(sinceMs) {
  const { rows } = await query(
    "select host, (extract(epoch from hour)*1000)::bigint ms, plugin, core, external from request_metrics where hour >= to_timestamp($1/1000.0)",
    [sinceMs]
  );
  return rows.map((r) => ({ host: r.host, hour: Number(r.ms), plugin: r.plugin, core: r.core, external: r.external }));
}
export async function pruneRequestMetrics(days) {
  const { rowCount } = await query("delete from request_metrics where hour < now() - ($1 * interval '1 day')", [days]);
  return rowCount;
}

// Durable "have we ever completed a sweep?" signal. Used instead of the
// ephemeral results.json so a Railway redeploy doesn't look like a cold start
// (which would force a full startup sweep on every deploy).
export async function hasMetricHistory() {
  const { rows } = await query("select 1 from metric_samples limit 1");
  return rows.length > 0;
}

// ---- Startup: bootstrap admins + migrate sites.json ------------------------
export async function bootstrap() {
  // Ensure schema essentials exist (idempotent) in case SQL wasn't run.
  await query(`create extension if not exists "pgcrypto"`);

  // Self-migrate: per-user theme preference.
  await query(`alter table app_users add column if not exists theme text not null default 'dark'`);

  // Self-migrate: per-site Zoho Projects link (tasks can come from ClickUp, Zoho, or both).
  await query(`alter table websites add column if not exists zoho_enabled boolean not null default false`);
  await query(`alter table websites add column if not exists zoho_project_ids text[] not null default '{}'`);

  // Self-migrate: add per-site license columns if this DB predates them.
  await query(`alter table websites add column if not exists license_key text`);
  await query(`alter table websites add column if not exists license_expires_at timestamptz`);
  await query(`create unique index if not exists websites_license_key_idx on websites(license_key)`);
  const missing = await query("select id from websites where license_key is null");
  for (const row of missing.rows) {
    await query(
      "update websites set license_key=$2, license_expires_at=coalesce(license_expires_at,$3) where id=$1",
      [row.id, generateLicenseKey(), durationToExpiry("1y")]
    );
  }
  if (missing.rows.length) console.log(`[db] Issued license keys for ${missing.rows.length} existing site(s).`);

  // Self-migrate: landing pages + settings tables.
  await query(`create table if not exists landing_pages (
    id uuid primary key default gen_random_uuid(),
    website_id uuid not null references websites(id) on delete cascade,
    name text not null, url text not null,
    created_by uuid references app_users(id) on delete set null,
    created_at timestamptz not null default now())`);
  await query(`create index if not exists landing_pages_website_idx on landing_pages(website_id)`);
  await query(`create table if not exists app_settings (
    key text primary key, value text, updated_at timestamptz not null default now())`);

  await query(`create table if not exists status_events (
    id uuid primary key default gen_random_uuid(),
    website_id uuid not null references websites(id) on delete cascade,
    from_status text, to_status text,
    at timestamptz not null default now())`);
  await query(`create index if not exists status_events_site_at_idx on status_events(website_id, at)`);
  await query(`create table if not exists metric_samples (
    id uuid primary key default gen_random_uuid(),
    website_id uuid not null references websites(id) on delete cascade,
    overall text, pagespeed int, ssl_days int, response_ms int,
    at timestamptz not null default now())`);
  await query(`create index if not exists metric_samples_site_at_idx on metric_samples(website_id, at)`);

  // Per-host outbound request counts, one row per host per hour (durable trend).
  await query(`create table if not exists request_metrics (
    host text not null, hour timestamptz not null,
    plugin int not null default 0, core int not null default 0, external int not null default 0,
    primary key (host, hour))`);
  await query(`create index if not exists request_metrics_hour_idx on request_metrics(hour)`);

  // Seed admin emails from env so someone can log in the first time.
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  for (const email of admins) {
    await query(
      "insert into app_users (email,role) values ($1,'admin') on conflict (email) do update set role='admin'",
      [email]
    );
  }

  // One-time import of an existing config/sites.json into the websites table.
  const { rows } = await query("select count(*)::int as n from websites");
  if (rows[0].n === 0) {
    const p = path.join(ROOT, "config", "sites.json");
    if (fs.existsSync(p)) {
      try {
        const { sites = [] } = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const s of sites) {
          await createWebsite({
            name: s.name || s.id,
            url: s.url,
            helper_enabled: s.helper?.enabled,
            helper_endpoint: s.helper?.endpoint,
            helper_token: s.helper?.token,
            expect_cloudflare: s.expect?.cloudflare,
            expect_ctm: s.expect?.ctm,
            expect_google_tag: s.expect?.googleTag,
            clickup_enabled: s.clickup?.enabled,
            clickup_list_ids: s.clickup?.listIds || [],
            clickup_folder_id: s.clickup?.folderId,
            clickup_space_id: s.clickup?.spaceId,
          }, null);
        }
        console.log(`[db] Imported ${sites.length} site(s) from config/sites.json into the database.`);
      } catch (err) {
        console.error("[db] sites.json import skipped:", err.message);
      }
    }
  }
}
