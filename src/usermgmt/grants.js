// Who may manage WordPress users, beyond the dashboard role.
//
// `manageWpUsers` is granted two ways: by holding the 'admin' dashboard role,
// and by appearing on an explicit allow-list. The list exists so the grant is
// visible and editable rather than implied — an administrator can see exactly
// who can create accounts on client sites without reading the permission map.
//
// permsFor() in auth.js is synchronous and runs on every request, so the list
// is held in memory and refreshed in the background. A cold or failed load
// leaves the list empty, which degrades to role-only access rather than
// granting anything by accident.

import { query } from "../db.js";

export const GRANT_SETTING_KEY = "wp_user_managers";
const REFRESH_MS = 5 * 60 * 1000;

let managers = new Set();
let loadedAt = 0;
let timer = null;

function normalize(email) {
  return String(email || "").trim().toLowerCase();
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map(normalize)
    .filter(Boolean);
}

// Reads the allow-list from app_settings into the in-memory cache.
export async function loadGrants() {
  try {
    const { rows } = await query("select value from app_settings where key = $1", [GRANT_SETTING_KEY]);
    managers = new Set(parseList(rows[0]?.value));
    loadedAt = Date.now();
  } catch (err) {
    // Keep whatever we had; an empty set just means role-only access.
    console.error("[grants] Could not load the WP user-manager list:", err.message);
  }
  return [...managers];
}

export function wpUserManagers() {
  return [...managers].sort();
}

export function grantsLoadedAt() {
  return loadedAt;
}

export function isWpUserManager(email) {
  return managers.has(normalize(email));
}

// Replaces the allow-list. Returns the stored list. Rejects anything that
// isn't an email address so a typo can't silently widen or narrow access.
export async function setWpUserManagers(emails) {
  const list = (Array.isArray(emails) ? emails : parseList(emails)).map(normalize).filter(Boolean);
  const bad = list.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (bad.length) throw new Error(`Not valid email addresses: ${bad.join(", ")}`);
  const unique = [...new Set(list)];
  await query(
    `insert into app_settings (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [GRANT_SETTING_KEY, unique.join(",")]
  );
  managers = new Set(unique);
  loadedAt = Date.now();
  return unique;
}

// Background refresh so a change made on another instance (or straight in the
// database) is picked up without a restart. unref()'d so it never holds the
// process open during shutdown, matching rateLimit.js.
export function startGrantRefresh(intervalMs = REFRESH_MS) {
  if (timer) return timer;
  timer = setInterval(() => { loadGrants().catch(() => {}); }, intervalMs);
  timer.unref();
  return timer;
}

export function stopGrantRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Test seam: set the cache without touching the database.
export function _setGrantsForTest(emails) {
  managers = new Set((emails || []).map(normalize));
  loadedAt = Date.now();
}
