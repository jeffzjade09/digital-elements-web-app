// Express server: Google-SSO login, role-based API, and the gated dashboard.
// Websites/users/social live in Supabase (Postgres); check results stay in a
// local file (regenerated each sweep). Runs as a persistent process (pm2/host).

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSettings, loadResults, applyStoredSettings } from "./store.js";
import { runOnce, startScheduler, isCheckRunning } from "./scheduler.js";
import { getClickUpTasks } from "./checks/clickup.js";
import {
  bootstrap, getWebsites, getWebsiteSite, createWebsite, updateWebsite, deleteWebsite,
  regenerateLicense, renewLicense,
  listUsers, createUser, updateUserRole, deleteUser,
  getSocialLinks, addSocialLink, deleteSocialLink,
  getLandingPages, createLandingPage, updateLandingPage, deleteLandingPage,
  getAppSettings, setAppSettings,
} from "./db.js";
import { configureAuth, requireAuth, requirePerm, sameOriginOnly, permsFor } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");
const settings = loadSettings();

// Fail fast with a clear message if the essentials aren't configured.
function requireEnv() {
  const missing = [];
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");
  if (!settings.sessionSecret) missing.push("SESSION_SECRET");
  if (!settings.google.clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!settings.google.clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (missing.length) {
    console.error(`\n[server] Missing required environment variables: ${missing.join(", ")}`);
    console.error("[server] See .env.example and DEPLOY.md for setup.\n");
    process.exit(1);
  }
}
requireEnv();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));

configureAuth(app, settings);      // session + passport + /auth/* routes
app.use(sameOriginOnly);           // block cross-origin mutations

// ---- Public assets & login (no auth) ----
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/login", (req, res) => res.sendFile(path.join(PUBLIC, "login.html")));
app.get("/logo.png", (req, res) => res.sendFile(path.join(PUBLIC, "logo.png")));

// ---- Everything below requires a signed-in user ----
app.get("/", requireAuth, (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: { email: req.user.email, name: req.user.name, role: req.user.role }, perms: permsFor(req.user.role) });
});

app.get("/api/results", requireAuth, (req, res) => {
  const results = loadResults();
  results.running = isCheckRunning();
  res.json(results);
});

app.post("/api/check", requireAuth, (req, res) => {
  if (isCheckRunning()) return res.json({ started: false, running: true });
  res.json({ started: true });
  runOnce(settings, { alert: false }).catch((err) => console.error("[server] On-demand check failed:", err.message));
});

app.get("/api/tasks/:siteId", requireAuth, async (req, res) => {
  try {
    const site = await getWebsiteSite(req.params.siteId);
    if (!site) return res.status(404).json({ ok: false, error: "Unknown site" });
    res.json(await getClickUpTasks(site.clickup, settings.clickup));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Websites (view: all; add/edit: manageWebsites; delete: deleteWebsite) ----
app.get("/api/websites", requireAuth, async (req, res) => {
  try {
    const websites = await getWebsites();
    // Only users who manage websites see the raw license key.
    if (!permsFor(req.user.role).manageWebsites) {
      websites.forEach((w) => { if (w.license) w.license = { ...w.license, key: null }; });
    }
    res.json({ ok: true, websites });
  }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

function normalizeWebsite(b) {
  let listIds = b.clickup_list_ids ?? b.clickupListIds ?? [];
  if (typeof listIds === "string") listIds = listIds.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return {
    name: (b.name || "").trim(),
    url: (b.url || "").trim(),
    helper_enabled: !!b.helper_enabled,
    helper_endpoint: b.helper_endpoint || null,
    helper_token: b.helper_token || null,
    expect_cloudflare: b.expect_cloudflare !== false,
    expect_ctm: b.expect_ctm !== false,
    expect_google_tag: b.expect_google_tag !== false,
    clickup_enabled: !!b.clickup_enabled,
    clickup_list_ids: listIds,
    clickup_folder_id: b.clickup_folder_id || null,
    clickup_space_id: b.clickup_space_id || null,
    license_duration: b.license_duration || "1y",
  };
}

app.post("/api/websites", requireAuth, requirePerm("manageWebsites"), async (req, res) => {
  const d = normalizeWebsite(req.body);
  if (!d.name || !d.url) return res.status(400).json({ ok: false, error: "Name and URL are required" });
  try {
    const website = await createWebsite(d, req.user.id);
    console.log(`[websites] created "${website.name}" (${website.id})`);
    res.json({ ok: true, website });
  }
  catch (err) { console.error("[websites] create failed:", err.message); res.status(500).json({ ok: false, error: err.message }); }
});

app.put("/api/websites/:id", requireAuth, requirePerm("manageWebsites"), async (req, res) => {
  const d = normalizeWebsite(req.body);
  if (!d.name || !d.url) return res.status(400).json({ ok: false, error: "Name and URL are required" });
  try {
    const w = await updateWebsite(req.params.id, d);
    if (!w) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, website: w });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete("/api/websites/:id", requireAuth, requirePerm("deleteWebsite"), async (req, res) => {
  try { await deleteWebsite(req.params.id); console.log(`[websites] deleted ${req.params.id}`); res.json({ ok: true }); }
  catch (err) { console.error("[websites] delete failed:", err.message); res.status(500).json({ ok: false, error: err.message }); }
});

// Regenerate (new key) or renew (extend expiry) a site's monitoring license.
app.post("/api/websites/:id/license", requireAuth, requirePerm("manageWebsites"), async (req, res) => {
  const { action, duration } = req.body;
  try {
    const website = action === "regenerate"
      ? await regenerateLicense(req.params.id, duration)
      : await renewLicense(req.params.id, duration);
    if (!website) return res.status(404).json({ ok: false, error: "Not found" });
    console.log(`[websites] license ${action} for ${req.params.id}`);
    res.json({ ok: true, website });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ---- Users (admin only) ----
app.get("/api/users", requireAuth, requirePerm("manageUsers"), async (req, res) => {
  try { res.json({ ok: true, users: await listUsers() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

const ROLES = ["admin", "webdev", "seo", "publisher", "social"];
app.post("/api/users", requireAuth, requirePerm("manageUsers"), async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const role = req.body.role;
  if (!email || !ROLES.includes(role)) return res.status(400).json({ ok: false, error: "Valid email and role required" });
  try { res.json({ ok: true, user: await createUser(email, role, req.body.name) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.put("/api/users/:id", requireAuth, requirePerm("manageUsers"), async (req, res) => {
  if (!ROLES.includes(req.body.role)) return res.status(400).json({ ok: false, error: "Invalid role" });
  if (req.params.id === req.user.id && req.body.role !== "admin") {
    return res.status(400).json({ ok: false, error: "You can't remove your own admin role" });
  }
  try {
    const u = await updateUserRole(req.params.id, req.body.role);
    if (!u) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, user: u });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete("/api/users/:id", requireAuth, requirePerm("manageUsers"), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ ok: false, error: "You can't delete yourself" });
  try { await deleteUser(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ---- Social links (view: all; add/delete: editSocial) ----
app.get("/api/websites/:id/social", requireAuth, async (req, res) => {
  try { res.json({ ok: true, links: await getSocialLinks(req.params.id) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/api/websites/:id/social", requireAuth, requirePerm("editSocial"), async (req, res) => {
  const platform = (req.body.platform || "").trim();
  const url = (req.body.url || "").trim();
  if (!platform || !url) return res.status(400).json({ ok: false, error: "Platform and URL required" });
  try { res.json({ ok: true, link: await addSocialLink(req.params.id, platform, url, req.user.id) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.delete("/api/social/:id", requireAuth, requirePerm("editSocial"), async (req, res) => {
  try { await deleteSocialLink(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ---- Landing pages (view: all; add/edit/delete: manageWebsites) ----
app.get("/api/landing", requireAuth, async (req, res) => {
  try { res.json({ ok: true, pages: await getLandingPages() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/api/landing", requireAuth, requirePerm("manageWebsites"), async (req, res) => {
  const websiteId = req.body.website_id;
  const name = (req.body.name || "").trim();
  const url = (req.body.url || "").trim();
  if (!websiteId || !name || !url) return res.status(400).json({ ok: false, error: "Website, name and URL are required" });
  try { res.json({ ok: true, page: await createLandingPage(websiteId, name, url, req.user.id) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.put("/api/landing/:id", requireAuth, requirePerm("manageWebsites"), async (req, res) => {
  const name = (req.body.name || "").trim();
  const url = (req.body.url || "").trim();
  if (!name || !url) return res.status(400).json({ ok: false, error: "Name and URL are required" });
  try {
    const page = await updateLandingPage(req.params.id, name, url);
    if (!page) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, page });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.delete("/api/landing/:id", requireAuth, requirePerm("manageWebsites"), async (req, res) => {
  try { await deleteLandingPage(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ---- Settings (admin only) ----
function settingsView() {
  return {
    pagespeedIntervalSeconds: Math.round((settings.pageSpeed.minIntervalMs || 120000) / 1000),
    sweepIntervalSeconds: settings.sweepIntervalSeconds || 60,
    sslWarnDays: settings.sslWarnDays || 14,
  };
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));

app.get("/api/settings", requireAuth, requirePerm("manageSettings"), (req, res) => {
  res.json({ ok: true, settings: settingsView() });
});
app.put("/api/settings", requireAuth, requirePerm("manageSettings"), async (req, res) => {
  const b = req.body || {};
  const toStore = {};
  if (b.pagespeedIntervalSeconds != null) toStore.pagespeed_interval_seconds = String(clamp(b.pagespeedIntervalSeconds, 60, 86400));
  if (b.sweepIntervalSeconds != null) toStore.sweep_interval_seconds = String(clamp(b.sweepIntervalSeconds, 15, 3600));
  if (b.sslWarnDays != null) toStore.ssl_warn_days = String(clamp(b.sslWarnDays, 1, 90));
  try {
    await setAppSettings(toStore);
    applyStoredSettings(settings, toStore); // takes effect on the next sweep/tick
    console.log("[settings] updated:", toStore);
    res.json({ ok: true, settings: settingsView() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ---- Start ----
bootstrap()
  .then(async () => {
    try { applyStoredSettings(settings, await getAppSettings()); } catch (err) { console.error("[server] Could not load stored settings:", err.message); }
    app.listen(settings.port, () => {
      console.log(`\n  Digital Elements Site Monitor at ${settings.publicUrl}\n`);
      startScheduler(settings);
      if (settings.checkOnStart) {
        console.log("[server] Running initial check on startup…");
        runOnce(settings, { alert: false }).catch((err) => console.error("[server] Startup check failed:", err.message));
      }
    });
  })
  .catch((err) => {
    console.error("[server] Database bootstrap failed:", err.message);
    process.exit(1);
  });
