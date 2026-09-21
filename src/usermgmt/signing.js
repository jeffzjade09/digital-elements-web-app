// HMAC request signing for the de/v2 user-management API.
//
// A shared bearer token proves only that the caller once saw the token. These
// requests can create and delete real accounts, so each one is signed instead:
// the signature covers the method, route, query, a timestamp, a nonce and the
// body, which means a captured request can't be replayed, retargeted at a
// different route, or have its body edited in flight.
//
// The canonical string below is the contract with the plugin. It is mirrored
// byte-for-byte in wordpress-plugin/digital-elements-helper/includes/um-auth.php
// and both sides are checked against the same vectors in
// tests/usermgmt-signing.test.mjs and tests/usermgmt-auth.test.php.

import crypto from "node:crypto";

export const SIGNATURE_VERSION = "DE1-HMAC-SHA256";

/**
 * The reverse direction: a connected website calling the hub.
 *
 * A DIFFERENT version string, deliberately. Both directions share a secret and
 * a canonical string, so without this a signature captured from a hub->site
 * request could in principle be presented to the hub. Today that is prevented
 * only incidentally, because the route strings differ; a distinct version makes
 * it structural — each side compares the version with hash_equals before doing
 * anything else, so a signature from one direction cannot validate in the other.
 */
export const SITE_SIGNATURE_VERSION = "DE1-SITE-HMAC-SHA256";
// How far apart the two clocks may be. Long enough to survive ordinary drift
// and a slow request, short enough that a captured signature is useless by the
// time anyone could reuse it — and the nonce makes reuse inside the window fail
// anyway.
export const MAX_CLOCK_SKEW_SECONDS = 300;

// Query parameters WordPress itself may add or rewrite in transit. Signing them
// would make a valid request fail depending on the site's permalink setup.
const UNSIGNED_QUERY_PARAMS = new Set(["rest_route", "_locale", "_envelope", "_method", "_wpnonce"]);

export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input == null ? "" : input, "utf8").digest("hex");
}

/**
 * Canonical query string: signed parameters sorted by name, then by value, each
 * percent-encoded. Sorting means the signature doesn't depend on the order the
 * caller happened to serialize them in.
 */
export function canonicalQuery(params) {
  const pairs = [];
  const push = (k, v) => {
    if (UNSIGNED_QUERY_PARAMS.has(k)) return;
    pairs.push([String(k), v == null ? "" : String(v)]);
  };

  if (params instanceof URLSearchParams) {
    for (const [k, v] of params) push(k, v);
  } else if (Array.isArray(params)) {
    for (const [k, v] of params) push(k, v);
  } else if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((one) => push(k, one));
      else push(k, v);
    }
  }

  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
}

// encodeURIComponent leaves !'()* alone; RFC 3986 does not. PHP's rawurlencode
// follows RFC 3986, so match it or the two sides disagree on those characters.
function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * The exact bytes that get signed.
 *
 * `route` is the WordPress REST route ("/de/v2/users"), NOT the full URL path:
 * a site may serve REST at /wp-json/... or at ?rest_route=..., and the route is
 * the one thing both forms agree on.
 */
export function canonicalString({ method, route, query, timestamp, nonce, idempotencyKey, body }) {
  return [
    String(method || "GET").toUpperCase(),
    normalizeRoute(route),
    canonicalQuery(query),
    String(timestamp),
    String(nonce),
    // Signed, not just sent: an unsigned idempotency key could be stripped or
    // swapped in flight, which would turn a safe retry into a second write.
    String(idempotencyKey || ""),
    sha256Hex(body == null ? "" : body),
  ].join("\n");
}

// Leading slash, no trailing slash, no doubled slashes — so "/de/v2/users/" and
// "de/v2/users" can't produce two different signatures for one request.
export function normalizeRoute(route) {
  const r = "/" + String(route || "").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  return r === "/" ? "/" : r;
}

export function signCanonical(secret, canonical) {
  return crypto.createHmac("sha256", String(secret)).update(canonical, "utf8").digest("base64");
}

export function newNonce() {
  return crypto.randomUUID();
}

/**
 * Builds the headers for one signed request. `body` must be the exact string
 * that will be sent — sign what goes on the wire, not an object that might
 * serialize differently later.
 */
export function signRequest({ keyId, secret, method, route, query, body, timestamp, nonce, idempotencyKey }) {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const n = nonce || newNonce();
  const canonical = canonicalString({ method, route, query, timestamp: ts, nonce: n, idempotencyKey, body });

  const headers = {
    "X-DE-Key-Id": keyId,
    "X-DE-Timestamp": String(ts),
    "X-DE-Nonce": n,
    "X-DE-Signature": `${SIGNATURE_VERSION} ${signCanonical(secret, canonical)}`,
    Accept: "application/json",
  };
  if (body != null) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  return { headers, canonical, timestamp: ts, nonce: n };
}
