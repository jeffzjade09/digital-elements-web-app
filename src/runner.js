// Runs every check for every site and assembles a result document.
// Network-bound checks run in parallel per site; sites run in parallel too.

import { fetchSite } from "./checks/fetchSite.js";
import { checkHttps } from "./checks/https.js";
import { checkSsl } from "./checks/ssl.js";
import { checkCloudflare } from "./checks/cloudflare.js";
import { checkCtm, checkGoogleTag } from "./checks/scripts.js";
import { checkPageSpeed } from "./checks/pagespeed.js";
import { checkPlugins } from "./checks/plugins.js";
import { checkClickUp } from "./checks/clickup.js";

// Worst status wins for the site-level roll-up. "skip"/"info" never lower a site
// (open tasks are informational, not a site-health problem).
const RANK = { ok: 0, skip: 0, info: 0, warn: 1, fail: 2 };

// PageSpeed is slow and rate-limited, so we cache each site's score and only
// re-run it once its result is older than pageSpeed.minIntervalMs (default 2 min).
// This lets the rest of the sweep run frequently for a near-live dashboard.
const psCache = new Map(); // url -> { result, ts }

async function getPageSpeedCached(url, settings) {
  const ttl = settings.pageSpeed.minIntervalMs || 120000;
  const hit = psCache.get(url);
  if (hit && Date.now() - hit.ts < ttl) {
    return { ...hit.result, detail: hit.result.detail, cached: true };
  }
  const result = await checkPageSpeed(url, settings.pageSpeed);
  psCache.set(url, { result, ts: Date.now() });
  return result;
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

  const [ssl, pagespeed, plugins, clickup] = await Promise.all([
    checkSsl(site.url, settings.sslWarnDays),
    getPageSpeedCached(fetchResult.finalUrl || site.url, settings),
    pluginsPromise,
    checkClickUp(site.clickup, settings.clickup),
  ]);

  const checks = {
    https: checkHttps(fetchResult),
    ssl,
    cloudflare: checkCloudflare(fetchResult, expect.cloudflare !== false),
    ctm: checkCtm(fetchResult, expect.ctm !== false),
    googleTag: checkGoogleTag(fetchResult, expect.googleTag !== false),
    pagespeed,
    plugins,
    clickup,
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
