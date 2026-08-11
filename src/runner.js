// Runs every check for every site and assembles a result document.
// Network-bound checks run in parallel per site; sites run in parallel too.

import { fetchSite } from "./checks/fetchSite.js";
import { checkHttps } from "./checks/https.js";
import { checkSsl } from "./checks/ssl.js";
import { checkCloudflare } from "./checks/cloudflare.js";
import { checkCtm, checkGoogleTag } from "./checks/scripts.js";
import { checkPageSpeed } from "./checks/pagespeed.js";
import { checkPlugins, getDeepSecurity } from "./checks/plugins.js";
import { checkClickUp } from "./checks/clickup.js";
import { checkZoho } from "./checks/zoho.js";
import { combineTaskChecks } from "./checks/tasks.js";
import { checkSecurity, mergeDeepSecurity } from "./checks/security.js";
import { loadPsCache, savePsCache } from "./store.js";

// Worst status wins for the site-level roll-up. "skip"/"info" never lower a site
// (open tasks are informational, not a site-health problem).
const RANK = { ok: 0, skip: 0, info: 0, warn: 1, fail: 2 };

// PageSpeed is slow and rate-limited, so we cache each site's score and only
// re-run it once the last attempt is older than pageSpeed.minIntervalMs. The
// cache is persisted to disk (see store.js) so the interval is honored across
// restarts rather than re-running every site on every boot.
let psCache = null; // url -> { attemptAt, result(last good), lastGoodAt, lastError, lastErrorAt }
function psStore() { if (!psCache) psCache = loadPsCache(); return psCache; }

// Attach run/status metadata so the dashboard can show a real "last run / next
// run" and flag stale or failed scores instead of silently showing an old one.
function annotatePs(entry, ttl, cached) {
  const base = entry.result
    ? { ...entry.result }
    : { status: "warn", label: "No data", detail: entry.lastError || "PageSpeed has not run yet", metrics: {} };
  base.psRanAt = entry.lastGoodAt ? new Date(entry.lastGoodAt).toISOString() : null;
  base.psAttemptAt = entry.attemptAt ? new Date(entry.attemptAt).toISOString() : null;
  base.psNextAt = entry.attemptAt ? new Date(entry.attemptAt + ttl).toISOString() : null;
  base.psCached = !!cached;
  // "Stale" = the most recent attempt failed, so the number shown (if any) is
  // from an earlier successful run.
  const failedLatest = entry.lastErrorAt && (!entry.lastGoodAt || entry.lastErrorAt >= entry.lastGoodAt);
  if (failedLatest) { base.psError = entry.lastError; base.psStale = true; }
  return base;
}

async function getPageSpeedCached(url, settings) {
  const ttl = settings.pageSpeed.minIntervalMs || 120000;
  const cache = psStore();
  const entry = cache[url] || {};
  const now = Date.now();

  if (entry.attemptAt && now - entry.attemptAt < ttl) {
    return annotatePs(entry, ttl, true); // still within the refresh window
  }

  const result = await checkPageSpeed(url, settings.pageSpeed);
  entry.attemptAt = now;
  if (typeof result.score === "number") {
    entry.result = result;         // keep last *good* result
    entry.lastGoodAt = now;
    delete entry.lastError; delete entry.lastErrorAt;
  } else {
    entry.lastError = result.detail || "No data";
    entry.lastErrorAt = now;        // keep the previous good result (if any)
  }
  cache[url] = entry;
  savePsCache(cache);
  return annotatePs(entry, ttl, false);
}

function rollUp(checks) {
  let worst = "ok";
  for (const c of Object.values(checks)) {
    if (RANK[c.status] > RANK[worst]) worst = c.status;
  }
  return worst;
}

async function checkOneSite(site, settings) {
  const expect = site.expect || {};
  const fetchResult = await fetchSite(site.url);

  const licenseExpired = site.helper && site.helper.enabled && site.license && site.license.expired;
  const pluginsPromise = licenseExpired
    ? Promise.resolve({ status: "warn", label: "License expired", detail: "Renew this site's monitoring license to resume update checks." })
    : checkPlugins(site.helper);
  const deepPromise = (site.helper && site.helper.enabled && !licenseExpired)
    ? getDeepSecurity(site.helper).catch(() => null)
    : Promise.resolve(null);

  const [ssl, pagespeed, plugins, clickup, zoho, deep] = await Promise.all([
    checkSsl(site.url, settings.sslWarnDays),
    getPageSpeedCached(fetchResult.finalUrl || site.url, settings),
    pluginsPromise,
    checkClickUp(site.clickup, settings.clickup),
    checkZoho(site.zoho, settings.zoho),
    deepPromise,
  ]);

  const security = checkSecurity(fetchResult);
  if (deep) mergeDeepSecurity(security, deep);

  const checks = {
    https: checkHttps(fetchResult),
    ssl,
    cloudflare: checkCloudflare(fetchResult, expect.cloudflare !== false),
    ctm: checkCtm(fetchResult, expect.ctm !== false),
    googleTag: checkGoogleTag(fetchResult, expect.googleTag !== false),
    pagespeed,
    plugins,
    tasks: combineTaskChecks([{ source: "clickup", check: clickup }, { source: "zoho", check: zoho }]),
    security,
  };

  return {
    id: site.id,
    name: site.name || site.id,
    url: site.url,
    checkedAt: new Date().toISOString(),
    overall: rollUp(checks),
    checks,
  };
}

export async function runAll(sites, settings) {
  const results = await Promise.all(
    sites.map((s) =>
      checkOneSite(s, settings).catch((err) => ({
        id: s.id,
        name: s.name || s.id,
        url: s.url,
        checkedAt: new Date().toISOString(),
        overall: "fail",
        error: err.message,
        checks: {},
      }))
    )
  );

  const byId = {};
  for (const r of results) byId[r.id] = r;
  return { lastRun: new Date().toISOString(), running: false, sites: byId };
}

// Landing pages get the URL-level checks only (no plugin/updates, no tasks).
// Tracking checks are informational here (won't fail a landing page).
async function checkOneLandingPage(lp, settings) {
  const fetchResult = await fetchSite(lp.url);
  const [ssl, pagespeed] = await Promise.all([
    checkSsl(lp.url, settings.sslWarnDays),
    getPageSpeedCached(fetchResult.finalUrl || lp.url, settings),
  ]);
  const checks = {
    https: checkHttps(fetchResult),
    ssl,
    cloudflare: checkCloudflare(fetchResult, false),
    ctm: checkCtm(fetchResult, false),
    googleTag: checkGoogleTag(fetchResult, false),
    pagespeed,
    security: checkSecurity(fetchResult),
  };
  return {
    id: lp.id, websiteId: lp.websiteId, name: lp.name || lp.url, url: lp.url,
    checkedAt: new Date().toISOString(), overall: rollUp(checks), checks,
  };
}

export async function runLandingPages(pages, settings) {
  const results = await Promise.all(
    pages.map((p) =>
      checkOneLandingPage(p, settings).catch((err) => ({
        id: p.id, websiteId: p.websiteId, name: p.name || p.url, url: p.url,
        checkedAt: new Date().toISOString(), overall: "fail", error: err.message, checks: {},
      }))
    )
  );
  const byId = {};
  for (const r of results) byId[r.id] = r;
  return byId;
}
