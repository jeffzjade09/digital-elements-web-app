// Signed HTTP client for the de/v2 user-management API on a client site.
//
// Every call goes through here, so timeouts, the SSRF guard, error mapping and
// signing are applied uniformly rather than remembered at ~15 call sites.
//
// Errors never propagate raw: a client site can put anything in a response
// body, so failures are mapped to a fixed set of codes with messages written
// for an administrator.

import { getSigningCredential, isConfigured } from "./credentials.js";
import { signRequest } from "./signing.js";

export const NAMESPACE = "de/v2";
const DEFAULT_TIMEOUT_MS = 20_000;

// Local WordPress installs are the supported way to test this (see
// docs/user-management.md). They are blocked by default so a misconfigured
// website row can't be used to make the server call its own network.
const ALLOW_LOCAL = process.env.UM_ALLOW_LOCAL_SITES === "1";

const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.(test|local|localhost|internal)$)/i;

export class WpError extends Error {
  constructor(code, message, { status = 0, site = null, retryable = false, detail = null } = {}) {
    super(message);
    this.name = "WpError";
    this.code = code;
    this.status = status;
    this.site = site;
    this.retryable = retryable;
    this.detail = detail;
  }
}

/**
 * Base URL for the de/v2 namespace on a site.
 *
 * Prefers the site's configured helper endpoint, because a site that needed a
 * custom REST base for monitoring needs the same one here; falls back to the
 * conventional /wp-json path.
 */
export function deV2Base(site) {
  const custom = site?.helper?.endpoint || "";
  const m = custom.match(/^(.*\/)wpmonitor\/v1\/[^/]*\/?$/);
  if (m) return m[1] + NAMESPACE;
  const root = String(site?.url || "").replace(/\/+$/, "");
  if (!root) throw new WpError("no_url", "This website has no URL configured.");
  return `${root}/wp-json/${NAMESPACE}`;
}

// Refuses anything that isn't a plain http(s) URL to a public host. Credentials
// embedded in the URL are refused outright rather than silently sent.
export function assertSafeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new WpError("bad_url", "This website's URL isn't valid."); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WpError("bad_url", "This website's URL must be http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new WpError("bad_url", "This website's URL must not contain credentials.");
  }
  if (!ALLOW_LOCAL && PRIVATE_HOST.test(parsed.hostname)) {
    throw new WpError("private_host", "That address is on a private network. Set UM_ALLOW_LOCAL_SITES=1 to allow local test sites.");
  }
  return parsed;
}

/**
 * One signed request to a site.
 *
 * `route` is relative to the namespace ("/users/lookup"); the signature covers
 * the full WordPress route ("/de/v2/users/lookup"), which is what the plugin
 * recomputes on its side.
 */
export async function callSite(site, {
  method = "GET",
  route,
  query,
  body,
  idempotencyKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  credential,          // pre-loaded credential, to avoid a DB read per call in a batch
} = {}) {
  if (!isConfigured()) {
    throw new WpError("not_configured", "User management isn't configured on this server yet.", { site: site?.id });
  }

  const cred = credential || await getSigningCredential(site.id);
  if (!cred) {
    throw new WpError("not_enrolled", `${site.name} isn't set up for user management yet.`, { site: site.id });
  }

  const base = deV2Base(site);
  const fullRoute = `/${NAMESPACE}${route.startsWith("/") ? route : "/" + route}`;
  const payload = body === undefined || body === null ? null : JSON.stringify(body);

  const url = new URL(base + (route.startsWith("/") ? route : "/" + route));
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) v.forEach((one) => url.searchParams.append(k, String(one)));
      else url.searchParams.set(k, String(v));
    }
  }
  assertSafeUrl(url.toString());

  const { headers } = signRequest({
    keyId: cred.keyId,
    secret: cred.secret,
    method,
    route: fullRoute,
    query: url.searchParams,
    body: payload,
    idempotencyKey,
  });

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload,
      redirect: "error", // a redirect would drop the signature and leak headers elsewhere
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    throw new WpError(
      timedOut ? "timeout" : "unreachable",
      timedOut ? `${site.name} took too long to respond.` : `Couldn't reach ${site.name}.`,
      { site: site.id, retryable: true, detail: err.message }
    );
  }

  return interpret(res, site);
}

async function interpret(res, site) {
  const replayed = res.headers.get("x-de-idempotent-replay") === "1";
  let data = null;
  try { data = await res.json(); } catch { /* handled below */ }

  if (res.status === 404 || res.status === 501) {
    throw new WpError("plugin_update_required",
      `${site.name} is running a helper plugin that doesn't support user management yet.`,
      { status: res.status, site: site.id });
  }
  if (res.status === 401 || res.status === 403) {
    // The plugin answers every credential failure the same way on purpose; the
    // code it does return tells us which recovery to offer.
    const code = data?.error?.code;
    const known = ["stale_request", "replay", "scope_denied"].includes(code) ? code : "unauthorized";
    throw new WpError(known, authMessage(known, site), { status: res.status, site: site.id });
  }
  if (res.status === 429) {
    throw new WpError("rate_limited", `${site.name} is rate-limiting us. Try again shortly.`,
      { status: 429, site: site.id, retryable: true });
  }
  if (res.status >= 500) {
    throw new WpError("site_error", `${site.name} returned an error (HTTP ${res.status}).`,
      { status: res.status, site: site.id, retryable: true });
  }
  if (!data || typeof data !== "object") {
    throw new WpError("bad_response", `${site.name} returned something that wasn't valid JSON.`,
      { status: res.status, site: site.id });
  }
  if (data.ok === false) {
    const code = data.error?.code || "failed";
    throw new WpError(code, data.error?.message || `${site.name} refused the request.`,
      { status: res.status, site: site.id });
  }
  if (!res.ok) {
    throw new WpError("failed", `${site.name} returned HTTP ${res.status}.`, { status: res.status, site: site.id });
  }
  return { ...data, replayed };
}

function authMessage(code, site) {
  switch (code) {
    case "stale_request":
      return `${site.name} rejected the request as out of date — check that this server's clock is correct.`;
    case "replay":
      return `${site.name} saw this exact request already and refused to repeat it.`;
    case "scope_denied":
      return `${site.name} hasn't allowed this action. Enable it in that site's DE Monitoring panel.`;
    default:
      return `${site.name} rejected our credentials. Re-enroll the site to issue a new one.`;
  }
}

/**
 * The capabilities probe, which is the one call that also works before a site is
 * enrolled — it accepts the monitoring license key as well as a signature, so
 * the app can tell "needs a plugin update" apart from "needs enrolling".
 */
export async function probeCapabilities(site, { timeoutMs = 10_000 } = {}) {
  const url = `${deV2Base(site)}/capabilities`;
  assertSafeUrl(url);
  const token = site?.helper?.token || "";

  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "X-WPMonitor-Token": token, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    throw new WpError(timedOut ? "timeout" : "unreachable",
      timedOut ? `${site.name} took too long to respond.` : `Couldn't reach ${site.name}.`,
      { site: site.id, retryable: true, detail: err.message });
  }

  if (res.status === 404) {
    throw new WpError("plugin_update_required",
      `${site.name} is running a helper plugin that doesn't support user management yet.`,
      { status: 404, site: site.id });
  }
  return interpret(res, site);
}
