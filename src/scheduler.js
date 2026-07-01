// Schedules background checks and dispatches alerts when statuses change.

import { loadSites, loadResults, saveResults } from "./store.js";
import { runAll } from "./runner.js";
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

export function startScheduler(settings) {
  const secs = Math.max(15, settings.sweepIntervalSeconds || 60);
  const psSecs = Math.round((settings.pageSpeed.minIntervalMs || 120000) / 1000);
  setInterval(() => {
    runOnce(settings, { alert: true }).catch((err) =>
      console.error("[scheduler] Run failed:", err.message)
    );
  }, secs * 1000);
  console.log(`[scheduler] Sweeping every ${secs}s · PageSpeed refreshed at most every ${psSecs}s · alerts on change`);
}
