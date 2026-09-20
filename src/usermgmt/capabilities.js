// What each site's helper plugin can actually do.
//
// New endpoints mean a plugin update rolled out to every client site, and that
// rollout is never instant. Rather than letting a bulk operation discover a
// stale site as an opaque 404 halfway through, every site is probed first and
// the UI says plainly which ones need updating or enrolling.
//
// Sites are gated on the *capability* they report, not on the plugin's version
// string, so the monitoring version can be released on its own schedule.

import { query } from "../db.js";
import { probeCapabilities, WpError } from "./wpClient.js";

// The de/v2 contract revision this app speaks. The plugin reports the revision
// it implements; a lower number means the site needs updating.
export const REQUIRED_API_VERSION = 1;

// Re-probing on every page load would mean one request per site per view. Ten
// minutes is short enough that a just-updated site shows up promptly.
const CACHE_TTL_MS = 10 * 60 * 1000;

export const READINESS = {
  READY: "ready",
  NEEDS_ENROLLMENT: "needs_enrollment",
  PLUGIN_UPDATE_REQUIRED: "plugin_update_required",
  UNREACHABLE: "unreachable",
  HELPER_DISABLED: "helper_disabled",
  UNKNOWN: "unknown",
};

function cacheIsFresh(row, maxAgeMs) {
  if (!row?.um_caps_checked_at) return false;
  return Date.now() - new Date(row.um_caps_checked_at).getTime() < maxAgeMs;
}

async function writeCache(websiteId, { pluginVersion, apiVersion, caps, error }) {
  await query(
    `update websites set
       um_plugin_version = $2, um_api_version = $3, um_caps = $4,
       um_caps_error = $5, um_caps_checked_at = now()
     where id = $1`,
    [websiteId, pluginVersion || null, apiVersion || null, caps || [], error || null]
  );
}

/**
 * Probes a site (or returns the cached answer) and records the result.
 *
 * Never throws for a site-side problem — an unreachable or outdated site is an
 * ordinary, displayable state, not an exception. A programming error still
 * throws.
 */
export async function getCapabilities(site, { force = false, maxAgeMs = CACHE_TTL_MS } = {}) {
  const { rows } = await query(
    `select um_key_id, um_scopes, um_enrolled_at, um_plugin_version, um_api_version,
            um_caps, um_caps_error, um_caps_checked_at
       from websites where id = $1`,
    [site.id]
  );
  const row = rows[0] || {};

  if (!site.helper?.enabled) {
    return shape(site, row, { readiness: READINESS.HELPER_DISABLED, error: "The helper plugin isn't enabled for this website." });
  }

  if (!force && cacheIsFresh(row, maxAgeMs)) {
    return shape(site, row, {});
  }

  try {
    const data = await probeCapabilities(site);
    const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
    const apiVersion = Number(data.api_version) || 0;
    await writeCache(site.id, { pluginVersion: data.plugin_version, apiVersion, caps, error: null });
    return shape(site, {
      ...row,
      um_plugin_version: data.plugin_version,
      um_api_version: apiVersion,
      um_caps: caps,
      um_caps_error: null,
      um_caps_checked_at: new Date().toISOString(),
      // The site is the authority on what it has actually enabled.
      um_scopes: Array.isArray(data.scopes) ? data.scopes : row.um_scopes,
    }, {
      siteEnrolled: data.enrolled === true,
      multisite: data.multisite === true,
      wpVersion: data.wp_version,
      licenseSite: typeof data.license_site === "string" ? data.license_site : null,
    });
  } catch (err) {
    if (!(err instanceof WpError)) throw err;
    await writeCache(site.id, {
      pluginVersion: err.code === "plugin_update_required" ? row.um_plugin_version : null,
      apiVersion: err.code === "plugin_update_required" ? 0 : null,
      caps: [],
      error: err.message,
    });
    return shape(site, { ...row, um_caps: [], um_api_version: err.code === "plugin_update_required" ? 0 : null, um_caps_error: err.message, um_caps_checked_at: new Date().toISOString() },
      { readiness: err.code === "plugin_update_required" ? READINESS.PLUGIN_UPDATE_REQUIRED : READINESS.UNREACHABLE, error: err.message });
  }
}

function shape(site, row, { readiness, error, siteEnrolled, multisite, wpVersion, licenseSite } = {}) {
  const apiVersion = row.um_api_version;
  const caps = row.um_caps || [];
  const enrolledHere = !!row.um_key_id;

  let state = readiness;
  if (!state) {
    if (apiVersion == null && !row.um_caps_checked_at) state = READINESS.UNKNOWN;
    else if (!apiVersion || apiVersion < REQUIRED_API_VERSION) state = READINESS.PLUGIN_UPDATE_REQUIRED;
    else if (!enrolledHere || siteEnrolled === false) state = READINESS.NEEDS_ENROLLMENT;
    else state = READINESS.READY;
  }

  return {
    websiteId: site.id,
    name: site.name,
    url: site.url,
    readiness: state,
    ready: state === READINESS.READY,
    pluginVersion: row.um_plugin_version || null,
    apiVersion: apiVersion ?? null,
    requiredApiVersion: REQUIRED_API_VERSION,
    capabilities: caps,
    scopes: row.um_scopes || [],
    enrolled: enrolledHere,
    enrolledAt: row.um_enrolled_at || null,
    multisite: multisite === true,
    wpVersion: wpVersion || null,
    // Which dashboard website this site's plugin believes it belongs to. A
    // mismatch is the commonest reason an enrollment code is refused, and it is
    // knowable before one is issued.
    licenseSite: licenseSite || null,
    licenseMismatch: !!(licenseSite && site.name && licenseSite !== site.name),
    checkedAt: row.um_caps_checked_at || null,
    error: error || row.um_caps_error || null,
    message: readinessMessage(state, row, site),
  };
}

// One place that decides the wording, so every screen says the same thing.
function readinessMessage(state, row, site) {
  switch (state) {
    case READINESS.READY: return "Ready";
    case READINESS.NEEDS_ENROLLMENT: return "Needs enrolling — generate a code and paste it into this site's DE Monitoring panel.";
    case READINESS.PLUGIN_UPDATE_REQUIRED:
      return row.um_plugin_version
        ? `Plugin update required (has ${row.um_plugin_version}).`
        : "Plugin update required — this site's helper doesn't support user management yet.";
    case READINESS.HELPER_DISABLED: return "The helper plugin isn't enabled for this website.";
    case READINESS.UNREACHABLE: return row.um_caps_error || `Couldn't reach ${site.name}.`;
    default: return "Not checked yet.";
  }
}

/**
 * Probes many sites at once, bounded so a bulk view can't open one connection
 * per site. Failures come back as states, never as a rejected promise.
 */
export async function getCapabilitiesForAll(sites, { force = false, concurrency = 4 } = {}) {
  const out = new Array(sites.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, sites.length) }, async () => {
    while (cursor < sites.length) {
      const i = cursor++;
      try {
        out[i] = await getCapabilities(sites[i], { force });
      } catch (err) {
        out[i] = shape(sites[i], {}, { readiness: READINESS.UNREACHABLE, error: err.message });
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Guard used before any user operation: refuses a site that can't do the job,
 * with a message that says what to do about it.
 */
export function assertCapable(caps, capability) {
  if (caps.readiness !== READINESS.READY) {
    throw new WpError(caps.readiness, caps.message, { site: caps.websiteId });
  }
  if (capability && !caps.capabilities.includes(capability)) {
    throw new WpError("capability_missing",
      `${caps.name} doesn't support this action (${capability}).`, { site: caps.websiteId });
  }
  return true;
}
