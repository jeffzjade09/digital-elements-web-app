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
       clickup_enabled,clickup_list_ids,clickup_folder_id,clickup_space_id,created_by,
       license_key,license_expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     returning *`,
    [
      d.name, d.url, !!d.helper_enabled, d.helper_endpoint || null, d.helper_token || null,
      d.expect_cloudflare !== false, d.expect_ctm !== false, d.expect_google_tag !== false,
      !!d.clickup_enabled, d.clickup_list_ids || [], d.clickup_folder_id || null, d.clickup_space_id || null,
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
       updated_at=now()
     where id=$1 returning *`,
    [
      id, d.name, d.url, !!d.helper_enabled, d.helper_endpoint || null, d.helper_token || null,
      d.expect_cloudflare !== false, d.expect_ctm !== false, d.expect_google_tag !== false,
      !!d.clickup_enabled, d.clickup_list_ids || [], d.clickup_folder_id || null, d.clickup_space_id || null,
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
export async function recordStatusEvent(websiteId, from, to) {
  await query("insert into status_events (website_id, from_status, to_status) values ($1,$2,$3)", [websiteId, from || null, to || null]);
}
export async function recordMetricSample(websiteId, m) {
  await query(
    "insert into metric_samples (website_id, overall, pagespeed, ssl_days, response_ms) values ($1,$2,$3,$4,$5)",
    [websiteId, m.overall || null, m.pagespeed ?? null, m.sslDays ?? null, m.responseMs ?? null]
  );
}
export async function getStatusEvents(websiteId, limit = 25) {
  const { rows } = await query(
    "select from_status, to_status, at from status_events where website_id=$1 order by at desc limit $2",
    [websiteId, limit]
  );
  return rows.map((r) => ({ from: r.from_status, to: r.to_status, at: r.at }));
}
export async function getMetricSamples(websiteId, days = 30) {
  const startIso = new Date(Date.now() - days * 86400000).toISOString();
  const { rows } = await query(
    "select overall, pagespeed, ssl_days, response_ms, at from metric_samples where website_id=$1 and at >= $2 order by at asc",
    [websiteId, startIso]
  );
  return rows.map((r) => ({ overall: r.overall, pagespeed: r.pagespeed, sslDays: r.ssl_days, responseMs: r.response_ms, at: r.at }));
}
// Percentage of the window the site was NOT failing, derived from status transitions.
export async function computeUptime(websiteId, days = 30) {
  const now = Date.now();
  const start = now - days * 86400000;
  const startIso = new Date(start).toISOString();
  const before = await query("select to_status from status_events where website_id=$1 and at <= $2 order by at desc limit 1", [websiteId, startIso]);
  const evs = await query("select to_status, extract(epoch from at)*1000 as ms from status_events where website_id=$1 and at > $2 order by at asc", [websiteId, startIso]);
  if (!before.rows.length && !evs.rows.length) return null; // no data yet
  let cur = before.rows[0]?.to_status || "ok";
  let downtime = 0, cursor = start;
  for (const e of evs.rows) {
    const t = Number(e.ms);
    if (cur === "fail") downtime += t - cursor;
    cursor = t; cur = e.to_status;
  }
  if (cur === "fail") downtime += now - cursor;
  return Math.round(Math.max(0, Math.min(100, (1 - downtime / (now - start)) * 100)) * 100) / 100;
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

// Retention: prune trend samples older than N days. status_events are tiny and
// kept indefinitely (they back uptime), so only metric_samples are pruned.
export async function deleteOldMetricSamples(days) {
  const { rowCount } = await query("delete from metric_samples where at < now() - ($1 * interval '1 day')", [days]);
  return rowCount;
}

// ---- Startup: bootstrap admins + migrate sites.json ------------------------
export async function bootstrap() {
  // Ensure schema essentials exist (idempotent) in case SQL wasn't run.
  await query(`create extension if not exists "pgcrypto"`);

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
