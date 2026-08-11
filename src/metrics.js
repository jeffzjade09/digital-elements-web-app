// Outbound-request instrumentation, tracked PER SITE (per host).
//
// Wraps the global fetch so we can count and categorize every outbound HTTP
// request, attributed to the host it targets:
//   - plugin  : calls to a site's WordPress helper plugin (/wpmonitor/…)
//   - core    : the homepage fetch of a monitored WordPress site (fetchSite)
//   - external: Google PageSpeed, ClickUp, Zoho, the analytics Worker, etc.
//
// Counts live in memory as hourly buckets per host and are persisted to
// Postgres (see db.js request_metrics + scheduler.js) so the trend survives
// Railway restarts/redeploys. On boot the recent buckets are seeded back from
// the DB. A short in-memory log of exact request URLs powers the live
// "recent requests" view.
//
// Note: the SSL check uses a raw TLS socket (not fetch), so it is intentionally
// not counted — it isn't an HTTP request to WordPress.

const MAX = 20000;               // ring-buffer cap (~ a day of activity)
const HOUR = 3600000;
const KEEP_MS = 14 * 86400000;   // in-memory bucket window (UI shows ≤7d)
const RECENT_PER_HOST = 60;      // exact-URL log kept per host (in-memory)

const events = [];               // { ts, host, cat }
let total = 0;
let pluginTotal = 0;

const recentByHost = {};         // host -> [ { ts, method, path, cat, status } ]
const hosts = {};                // host -> { [hourStartMs]: { plugin, core, external } }
const dirty = new Set();         // `${host}|${hourMs}` changed since last DB flush

let cycle = null;                // { startedAt, startTotal, startPlugin }
let lastCycle = null;            // { at, requests, pluginRequests, durationMs }

// ---- Host + category helpers ----------------------------------------------
export function normHost(input) {
  let h = String(input || "");
  try { if (/:\/\//.test(h)) h = new URL(h).host; } catch {}
  return h.replace(/:\d+$/, "").replace(/^www\./i, "").toLowerCase();
}
const EXTERNAL_RE = /(?:googleapis\.com|clickup\.com|zoho(?:apis)?\.(?:com|eu|in|com\.au|jp)|zohocloud\.com|workers\.dev|pagespeedonline)$/i;
function categorize(url, host) {
  if (/\/wp-json\/wpmonitor\/|\/wpmonitor\/v1\//i.test(url)) return "plugin";
  if (host && EXTERNAL_RE.test(host)) return "external";
  return "core"; // the monitored WordPress site's own domain (homepage fetch)
}
function pruneMemory() {
  const cutoff = Date.now() - KEEP_MS;
  for (const host of Object.keys(hosts)) {
    const hb = hosts[host];
    for (const k of Object.keys(hb)) if (Number(k) < cutoff) delete hb[k];
    if (!Object.keys(hb).length) delete hosts[host];
  }
}
function pathOf(url) {
  try { const u = new URL(url); return (u.pathname || "/") + (u.search || ""); } catch { return url; }
}

// Returns the recent-log entry so the caller can fill in the response status.
function record(url, method) {
  const host = normHost(url);
  const cat = categorize(url, host);
  total++;
  if (cat === "plugin") pluginTotal++;
  const ts = Date.now();
  events.push({ ts, host, cat });
  if (events.length > MAX) events.splice(0, events.length - MAX);

  const hr = Math.floor(ts / HOUR) * HOUR;
  const hb = hosts[host] || (hosts[host] = {});
  const b = hb[hr] || (hb[hr] = { plugin: 0, core: 0, external: 0 });
  b[cat]++;
  dirty.add(host + "|" + hr);

  const entry = { ts, method: (method || "GET").toUpperCase(), path: pathOf(url), cat, status: null };
  const log = recentByHost[host] || (recentByHost[host] = []);
  log.push(entry);
  if (log.length > RECENT_PER_HOST) log.splice(0, log.length - RECENT_PER_HOST);
  return entry;
}

// Install once. Safe to call multiple times (no double-wrap).
export function installFetchCounter() {
  if (globalThis.__deFetchWrapped) return;
  const orig = globalThis.fetch;
  if (typeof orig !== "function") return;
  globalThis.fetch = function (input, init) {
    let entry = null;
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || (input && input.method) || "GET";
      if (url) entry = record(url, method);
    } catch {}
    const p = orig.call(this, input, init);
    if (entry && p && typeof p.then === "function") {
      p.then((r) => { entry.status = (r && r.status) || null; }, () => { entry.status = 0; });
    }
    return p;
  };
  globalThis.__deFetchWrapped = true;
}

// ---- DB persistence hooks (driven by the scheduler, which owns the pool) ----
// Return only buckets changed since the last flush; caller persists them.
export function drainDirty() {
  const out = [];
  for (const key of dirty) {
    const [host, hrStr] = key.split("|");
    const hr = Number(hrStr);
    const b = hosts[host] && hosts[host][hr];
    if (b) out.push({ host, hour: hr, plugin: b.plugin, core: b.core, external: b.external });
  }
  dirty.clear();
  return out;
}
// Merge DB rows into memory on boot (rows: { host, hour(ms), plugin, core, external }).
export function seedBuckets(rows) {
  for (const r of rows || []) {
    const host = normHost(r.host);
    const hb = hosts[host] || (hosts[host] = {});
    hb[r.hour] = { plugin: r.plugin || 0, core: r.core || 0, external: r.external || 0 };
  }
  pruneMemory();
}

// ---- Sweep markers ---------------------------------------------------------
export function markCycleStart() {
  cycle = { startedAt: Date.now(), startTotal: total, startPlugin: pluginTotal };
}
export function markCycleEnd() {
  if (!cycle) return;
  lastCycle = {
    at: new Date().toISOString(),
    requests: total - cycle.startTotal,
    pluginRequests: pluginTotal - cycle.startPlugin,
    durationMs: Date.now() - cycle.startedAt,
  };
  cycle = null;
}

// ---- Reads: global (Settings usage box) ------------------------------------
function countSince(ms, cat, host) {
  const cutoff = Date.now() - ms;
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].ts < cutoff) break;
    if (cat && events[i].cat !== cat) continue;
    if (host && events[i].host !== host) continue;
    n++;
  }
  return n;
}
export function getStats() {
  return {
    lastHour: countSince(3600000),
    lastDay: countSince(86400000),
    total,
    lastCycle,
    plugin: { lastHour: countSince(3600000, "plugin"), lastDay: countSince(86400000, "plugin"), total: pluginTotal },
    core: { lastHour: countSince(3600000, "core"), lastDay: countSince(86400000, "core") },
    external: { lastHour: countSince(3600000, "external"), lastDay: countSince(86400000, "external") },
    wordpress: { lastHour: countSince(3600000, "plugin") + countSince(3600000, "core"), lastDay: countSince(86400000, "plugin") + countSince(86400000, "core") },
  };
}

// ---- Reads: per site (host) ------------------------------------------------
export function getSiteStats(hostInput) {
  const host = normHost(hostInput);
  return {
    host,
    plugin: { lastHour: countSince(3600000, "plugin", host), lastDay: countSince(86400000, "plugin", host) },
    core: { lastHour: countSince(3600000, "core", host), lastDay: countSince(86400000, "core", host) },
    lastCycle,
  };
}
export function getSiteRequests(hostInput, limit = 50) {
  const host = normHost(hostInput);
  const log = recentByHost[host] || [];
  return log.slice(-limit).reverse().map((e) => ({
    at: new Date(e.ts).toISOString(), method: e.method, path: e.path, cat: e.cat, status: e.status,
  }));
}
// Hourly plugin/core series for one site's host, oldest→newest, zero-filled.
export function getSiteSeries(hostInput, hours = 24) {
  const host = normHost(hostInput);
  const hb = hosts[host] || {};
  const h = Math.max(1, Math.min(336, Math.round(hours)));
  const nowHr = Math.floor(Date.now() / HOUR) * HOUR;
  const out = [];
  for (let i = h - 1; i >= 0; i--) {
    const t = nowHr - i * HOUR;
    const b = hb[t] || {};
    out.push({ t: new Date(t).toISOString(), plugin: b.plugin || 0, core: b.core || 0 });
  }
  return out;
}
