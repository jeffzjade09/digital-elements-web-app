// Schedules background checks and dispatches alerts when statuses change.

import { loadSites, loadResults, saveResults } from "./store.js";
import { runAll, runLandingPages } from "./runner.js";
import { getLandingPages } from "./db.js";
import { diffRuns, dispatchAlerts } from "./alerts.js";

let isRunning = false;

// Runs a full sweep, persists it, and alerts on any change vs. the prior run.
export async function runOnce(settings, { alert = false } = {}) {
  if (isRunning) return { skipped: true };
  isRunning = true;
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
    saveResults(fresh);

    if (alert) {
      const lines = diffRuns(previous, fresh);
      await dispatchAlerts(settings, lines);
    }
    return fresh;
  } finally {
    isRunning = false;
  }
}

export function isCheckRunning() {
  return isRunning;
}

// Tick every few seconds and sweep when the configured interval has elapsed.
// Reading the interval live means Settings changes take effect without a restart.
export function startScheduler(settings) {
  let lastSweep = 0;
  setInterval(() => {
    const iv = Math.max(15, settings.sweepIntervalSeconds || 60) * 1000;
    if (Date.now() - lastSweep < iv) return;
    lastSweep = Date.now();
    runOnce(settings, { alert: true }).catch((err) =>
      console.error("[scheduler] Run failed:", err.message)
    );
  }, 5000);
  console.log(`[scheduler] Sweep active (every ${Math.max(15, settings.sweepIntervalSeconds || 60)}s, adjustable from Settings)`);
}
