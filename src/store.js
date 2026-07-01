// Loads runtime config from environment + <CONFIG_DIR>/sites.json, and persists
// the most recent check results to <DATA_DIR>/results.json so the dashboard has
// data on load and the scheduler can detect status changes.
//
// CONFIG_DIR / DATA_DIR default to the project's own config/ and data/ folders,
// but can be overridden — e.g. on Railway, pointed at a mounted persistent
// volume so sites.json and results.json survive redeploys.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWebsites } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(ROOT, "config");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");

const SITES_PATH = null; // sites now live in the database (see db.js)
const RESULTS_PATH = path.join(DATA_DIR, "results.json");

// Websites now live in the database (see db.js). Returns the runner-ready shape.
export async function loadSites() {
  return getWebsites();
}

export function loadSettings() {
  const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
  const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === "true");
  return {
    port: num(process.env.PORT, 4000),
    pageSpeed: {
      apiKey: process.env.PAGESPEED_API_KEY || "",
      strategy: process.env.PAGESPEED_STRATEGY || "mobile",
      warn: num(process.env.PAGESPEED_WARN, 90),
      fail: num(process.env.PAGESPEED_FAIL, 50),
      minIntervalMs: num(process.env.PAGESPEED_MIN_INTERVAL_SECONDS, 120) * 1000,
    },
    sweepIntervalSeconds: num(process.env.SWEEP_INTERVAL_SECONDS, 60),
    sslWarnDays: num(process.env.SSL_WARN_DAYS, 14),
    publicUrl: (process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 4000)}`).replace(/\/$/, ""),
    sessionSecret: process.env.SESSION_SECRET || "",
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    },
    clickup: {
      token: process.env.CLICKUP_API_TOKEN || "",
      teamId: process.env.CLICKUP_TEAM_ID || "",
    },
    cron: process.env.CHECK_CRON || "0 */6 * * *",
    checkOnStart: bool(process.env.CHECK_ON_START, true),
    slackWebhook: process.env.SLACK_WEBHOOK_URL || "",
    smtp: {
      host: process.env.SMTP_HOST || "",
      port: num(process.env.SMTP_PORT, 587),
      secure: bool(process.env.SMTP_SECURE, false),
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
      from: process.env.ALERT_EMAIL_FROM || "",
      to: process.env.ALERT_EMAIL_TO || "",
    },
  };
}

export function loadResults() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
  } catch {
    return { lastRun: null, running: false, sites: {} };
  }
}

export function saveResults(results) {
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
}
