// Signed HTTP client for the de/v2 user-management API on a client site.
//
// Every call goes through here, so timeouts, the SSRF guard, error mapping and
// signing are applied uniformly rather than remembered at ~15 call sites.
//
// Errors never propagate raw: a client site can put anything in a response
// body, so failures are mapped to a fixed set of codes with messages written
// for an administrator.

import net from "node:net";
import dns from "node:dns/promises";

import { getSigningCredential, isConfigured } from "./credentials.js";
import { signRequest } from "./signing.js";

export const NAMESPACE = "de/v2";
const DEFAULT_TIMEOUT_MS = 20_000;

// Local WordPress installs are the supported way to test this (see
// docs/user-management.md). They are blocked by default so a website row —
// which a user with only manageWebsites can edit — can't be used to make this
// server reach into its own network.
const ALLOW_LOCAL = process.env.UM_ALLOW_LOCAL_SITES === "1";

// Hostnames that always mean "this machine" regardless of what DNS says.
const LOCAL_NAMES = /^(localhost|.*\.(localhost|local|test|internal|intranet|home\.arpa))$/i;

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
  if (custom) {
    // Matched against the parsed pathname, not the raw string: a greedy match
    // over the whole URL would happily treat a query string as the base path.
    let parsed = null;
    try { parsed = new URL(custom); } catch { parsed = null; }
    const m = parsed && parsed.pathname.match(/^(.*\/)wpmonitor\/v1\/[^/]*\/?$/);
    if (m) return `${parsed.origin}${m[1]}${NAMESPACE}`;
  }
  const root = String(site?.url || "").replace(/\/+$/, "");
  if (!root) throw new WpError("no_url", "This website has no URL configured.");
  return `${root}/wp-json/${NAMESPACE}`;
}

/**
 * Is this literal IP address one we must never connect to?
 *
 * Matching on the hostname string misses the forms that matter: WHATWG
 * normalizes `::ffff:127.0.0.1` to `::ffff:7f00:1`, and IPv6 unique-local,
 * link-local and CGNAT ranges look nothing like their IPv4 equivalents. So the
 * address is parsed and range-checked instead of pattern-matched.
 */
export function isBlockedAddress(address) {
  const ip = String(address || "").replace(/^\[|\]$/g, "").toLowerCase();
  const family = net.isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true; // not an IP literal; names are resolved and checked separately
}

function isBlockedV4(ip) {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  return (
    a === 0 ||                               // "this network"
    a === 10 ||                              // RFC 1918
    a === 127 ||                             // loopback
    (a === 100 && b >= 64 && b <= 127) ||    // RFC 6598 CGNAT
    (a === 169 && b === 254) ||              // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||     // RFC 1918
    (a === 192 && b === 168) ||              // RFC 1918
    (a === 192 && b === 0) ||                // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224                                 // multicast, reserved, broadcast
  );
}

function isBlockedV6(ip) {
  // An IPv4-mapped address is really an IPv4 destination, so judge it by the
  // IPv4 rules rather than letting it through as "some IPv6 address".
  const dotted = ip.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedV4(dotted[1]);
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return isBlockedV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
  }
  return (
    ip === "::" || ip === "::1" || // unspecified, loopback
    /^f[cd]/.test(ip) ||           // fc00::/7 unique local
    /^fe[89ab]/.test(ip) ||        // fe80::/10 link-local
    /^ff/.test(ip)                 // multicast
  );
}

/**
 * Refuses anything that isn't a plain http(s) URL to a public host.
 *
 * Synchronous, so it only judges what the URL says. A hostname that RESOLVES to
 * a private address is caught by assertResolvesPublicly() — both run before any
 * request goes out.
 */
export function assertSafeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new WpError("bad_url", "This website's URL isn't valid."); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WpError("bad_url", "This website's URL must be http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new WpError("bad_url", "This website's URL must not contain credentials.");
  }
  if (ALLOW_LOCAL) return parsed;

  const host = parsed.hostname;
  if (LOCAL_NAMES.test(host)) {
    throw new WpError("private_host", privateHostMessage(host));
  }
  if (net.isIP(host.replace(/^\[|\]$/g, "")) && isBlockedAddress(host)) {
    throw new WpError("private_host", privateHostMessage(host));
  }
  return parsed;
}

/**
 * Resolves a hostname and refuses it if any answer is a private address.
 *
 * A name is only as trustworthy as what it resolves to: `localtest.me` is a
 * perfectly ordinary public name that points at 127.0.0.1, and nothing about
 * the string gives that away.
 *
 * Every returned address must be public, not just the first — a name with both
 * a public and a private record must not get through on the strength of the
 * public one. Resolution failure is not treated as a block: an unresolvable
 * host simply fails as unreachable when the request is attempted.
 *
 * This narrows the window rather than closing it: the name is resolved again by
 * the HTTP client when it connects, so a record that changes in between is
 * still theoretically possible. Closing that completely means pinning the
 * connection to the validated address, which needs a custom dispatcher; the
 * URLs here are only settable by signed-in staff, so the residual risk is
 * small and stated rather than papered over.
 */
export async function assertResolvesPublicly(url) {
  if (ALLOW_LOCAL) return true;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return true; // already range-checked by assertSafeUrl

  let answers;
  try {
    answers = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return true; // unresolvable: let the request itself fail as unreachable
  }
  for (const { address } of answers) {
    if (isBlockedAddress(address)) {
      throw new WpError("private_host", privateHostMessage(host));
    }
  }
  return true;
}

function privateHostMessage(host) {
  return `${host} resolves to a private network address. Set UM_ALLOW_LOCAL_SITES=1 only if this is a local test site.`;
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
  await assertResolvesPublicly(url.toString());

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
  // This request carries the site's monitoring license key as a bearer token,
  // so where it goes matters as much as what it asks for.
  await assertResolvesPublicly(url);
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
