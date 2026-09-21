// Schedules background checks and dispatches alerts when statuses change.

import { loadSites, loadResults, saveResults } from "./store.js";
import { runAll, runLandingPages } from "./runner.js";
import { getLandingPages, recordMetricSample, deleteOldMetricSamples, upsertRequestMetrics, getRequestMetrics, pruneRequestMetrics } from "./db.js";
import { diffRuns, dispatchAlerts } from "./alerts.js";
import { markCycleStart, markCycleEnd, getStats, drainDirty, seedBuckets } from "./metrics.js";

const REQUEST_METRICS_KEEP_DAYS = 90;

// Persist any changed request-count buckets to Postgres (durable trend).
export async function persistRequestMetrics() {
  try {
    const rows = drainDirty();
    if (rows.length) await upsertRequestMetrics(rows);
  } catch (err) { console.error("[metrics] persist failed:", err.message); }
}
// Seed in-memory buckets from the DB on boot so history survives restarts.
export async function seedRequestMetrics() {
  try {
    const rows = await getRequestMetrics(Date.now() - 14 * 86400000);
    seedBuckets(rows);
    if (rows.length) console.log(`[metrics] seeded ${rows.length} request-metric bucket(s) from DB.`);
  } catch (err) { console.error("[metrics] seed failed:", err.message); }
}

let isRunning = false;
const lastSample = {}; // websiteId -> ts, throttles metric snapshots
// Record at most one trend sample per site per 5 min. At the (new) hourly sweep
// cadence every sweep records a sample, so Recent Check History matches the
// sweep frequency; the floor only dedupes rapid manual re-runs.
const METRIC_SAMPLE_MS = 5 * 60 * 1000;

// Persist periodic metric samples (feed the trend charts + uptime %).
async function recordHistory(previous, fresh) {
  for (const [id, r] of Object.entries(fresh.sites || {})) {
    if (!lastSample[id] || Date.now() - lastSample[id] >= METRIC_SAMPLE_MS) {
      lastSample[id] = Date.now();
      const c = r.checks || {};
      await recordMetricSample(id, {
        overall: r.overall,
        pagespeed: c.pagespeed && typeof c.pagespeed.score === "number" ? c.pagespeed.score : null,
        sslDays: c.ssl && typeof c.ssl.daysRemaining === "number" ? c.ssl.daysRemaining : null,
        responseMs: c.https && typeof c.https.responseTimeMs === "number" ? c.https.responseTimeMs : null,
      }).catch((e) => console.error("[history] sample:", e.message));
    }
  }
}

// Runs a full sweep, persists it, and alerts on any change vs. the prior run.
export async function runOnce(settings, { alert = false } = {}) {
  if (isRunning) return { skipped: true };
  isRunning = true;
  const startedAt = Date.now();
  markCycleStart();
  try {
    const previous = loadResults();
    const sites = await loadSites();
    const fresh = await runAll(sites, settings);
    try {
      const pages = await getLandingPages();
      fresh.landingPages = await runLandingPages(pages, settings);
    } catch (err) {
      fresh.landingPages = previous.landingPages || {};
      console.error("[scheduler] Landing page checks failed:", err.message);
    }
    markCycleEnd();
    // Attach usage/timing so the dashboard can show requests-per-cycle + totals.
    fresh.sweep = {
      durationMs: Date.now() - startedAt,
      requests: getStats().lastCycle ? getStats().lastCycle.requests : null,
      sites: sites.length,
    };
    fresh.usage = getStats();
    saveResults(fresh);
    recordHistory(previous, fresh).catch((err) => console.error("[history] failed:", err.message));

    if (alert) {
      const lines = diffRuns(previous, fresh);
      await dispatchAlerts(settings, lines);
    }
    console.log(`[scheduler] Sweep done: ${sites.length} sites, ${fresh.sweep.requests ?? "?"} outbound requests, ${Math.round(fresh.sweep.durationMs / 1000)}s`);
    persistRequestMetrics();

    // Ask every ready site who is actually on it.
    //
    // Deliberately here and not only on a button: the accounts that started
    // this were deleted in WP Admin and sat wrong in the dashboard for weeks
    // because nothing ever asked again. Drift is found by looking, and nobody
    // looks on a schedule except this.
    //
    // Never allowed to fail the sweep — monitoring is the sweep's job, and this
    // is a passenger.
    reconcileAfterSweep().catch((err) => console.error("[reconcile] sweep pass failed:", err.message));

    return fresh;
  } finally {
    isRunning = false;
  }
}

export function isCheckRunning() {
  return isRunning;
}

/**
 * The scheduled reconciliation pass.
 *
 * Imported lazily so the scheduler keeps working on a dashboard where user
 * management isn't configured — there, getCapabilitiesForAll has nothing to
 * say and this does nothing at all.
 */
async function reconcileAfterSweep() {
  const credentials = await import("./usermgmt/credentials.js");
  if (!credentials.isConfigured()) return;

  const { getWebsites } = await import("./db.js");
  const { getCapabilitiesForAll, READINESS } = await import("./usermgmt/capabilities.js");
  const { reconcileAll } = await import("./usermgmt/reconcile.js");

  const sites = await getWebsites();
  // Cached readiness: this runs right after a sweep, and re-probing every site
  // again would double the outbound traffic for nothing.
  const caps = await getCapabilitiesForAll(sites, { force: false });
  const ready = new Set(caps.filter((c) => c.readiness === READINESS.READY).map((c) => c.websiteId));
  if (!ready.size) return;

  const { totals } = await reconcileAll(sites, {
    actor: { actorEmail: null, via: "sweep" },
    isReady: (site) => ready.has(site.id),
  });

  // Logged only when something moved, so a quiet estate stays quiet in the log.
  if (totals.removedExternally || totals.roleChanged || totals.unmanaged || totals.resolved) {
    console.log(`[reconcile] ${totals.checked} checked: ${totals.removedExternally} removed outside the dashboard, `
      + `${totals.roleChanged} role changed, ${totals.unmanaged} no longer managed, ${totals.resolved} back in step`);
  }
}

// Check a single site (used when a site is added/edited) and merge the result
// into the stored sweep — so editing one site doesn't re-check all of them.
export async function runSingle(siteId, settings) {
  const previous = loadResults();
  const sites = await loadSites();
  const site = sites.find((s) => String(s.id) === String(siteId));
  if (!site) return { ok: false, error: "Unknown site" };
  markCycleStart();
  const fresh = await runAll([site], settings);
  markCycleEnd();
  const merged = {
    ...previous,
    sites: { ...(previous.sites || {}), ...fresh.sites },
    lastRun: new Date().toISOString(),
    usage: getStats(),
  };
  saveResults(merged);
  recordHistory(previous, fresh).catch((err) => console.error("[history] failed:", err.message));
  persistRequestMetrics();
  return { ok: true };
}

// Tick every few seconds and sweep when the configured interval has elapsed.
// Reading the interval live means Settings changes take effect without a restart.
let tickTimer = null;

export function startScheduler(settings) {
  // Start the clock at boot so the first automatic sweep waits a full interval.
  // (A genuine first-ever run is handled by the cold-start check in server.js.)
  // This stops every restart/redeploy from forcing an immediate full sweep.
  let lastSweep = Date.now();
  let lastCleanup = 0;
  let lastMetricsFlush = 0;
  tickTimer = setInterval(() => {
    // Backstop: persist request-metric buckets to the DB every ~5 min.
    if (Date.now() - lastMetricsFlush >= 300000) {
      lastMetricsFlush = Date.now();
      persistRequestMetrics();
    }
    // Daily retention prune (0 = keep forever). Runs on the first tick after boot.
    if (Date.now() - lastCleanup >= 86400000) {
      lastCleanup = Date.now();
      const days = settings.historyRetentionDays;
      if (days && days > 0) {
        deleteOldMetricSamples(days)
          .then((n) => { if (n) console.log(`[retention] pruned ${n} metric sample(s) older than ${days}d`); })
          .catch((err) => console.error("[retention] prune failed:", err.message));
      }
      pruneRequestMetrics(REQUEST_METRICS_KEEP_DAYS)
        .then((n) => { if (n) console.log(`[retention] pruned ${n} request-metric row(s) older than ${REQUEST_METRICS_KEEP_DAYS}d`); })
        .catch((err) => console.error("[retention] request-metric prune failed:", err.message));
    }
    // Automatic checks can be turned off (Settings → Manual only): then outbound
    // sweeps run ONLY when a user clicks Run Checks.
    if (settings.autoChecks === false) return;
    const iv = Math.max(15, settings.sweepIntervalSeconds || 60) * 1000;
    if (Date.now() - lastSweep < iv) return;
    lastSweep = Date.now();
    runOnce(settings, { alert: true }).catch((err) =>
      console.error("[scheduler] Run failed:", err.message)
    );
  }, 5000);
  console.log(`[scheduler] Tick active (auto checks ${settings.autoChecks === false ? "OFF — manual only" : "every " + Math.max(15, settings.sweepIntervalSeconds || 60) + "s"})`);
}

// Stop scheduling new sweeps. An in-flight sweep keeps running — callers should
// poll isCheckRunning() before exiting so its results.json write completes.
export function stopScheduler() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}
