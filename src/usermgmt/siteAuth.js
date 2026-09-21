// Verifying a request that came FROM a connected website.
//
// This is a new inbound attack surface: every enrolled site holds a secret that
// can now reach the hub. The design limits what that secret is worth.
//
// THE IDENTITY RULE. A site is identified by the credential that signed the
// request, never by anything in the request. There is no website_id parameter
// anywhere in the site API, so a compromised site cannot name another site's id
// and be believed — it can only ever act as itself. That is a structural
// property, not a check that could be forgotten on one route.
//
// Everything else — the timestamp window, the nonce, the rate limit, the
// canonical string — mirrors what the plugin has enforced on inbound requests
// since 2.6.0, so the two directions behave the same way and a reader only has
// to learn the scheme once.

import crypto from "node:crypto";

import { query } from "../db.js";
import { getSiteByKeyId, decryptSecret, isConfigured, effectiveScopes } from "./credentials.js";
import { canonicalString, signCanonical, SITE_SIGNATURE_VERSION, MAX_CLOCK_SKEW_SECONDS } from "./signing.js";
import * as audit from "./audit.js";

// Long enough to survive ordinary clock drift and a slow request, short enough
// that a captured signature is useless by the time anyone could reuse it — and
// the nonce makes reuse inside the window fail anyway.
const NONCE_RETENTION_MS = 10 * 60 * 1000;

export class SiteAuthError extends Error {
  constructor(code, status = 403, detail = null) {
    super(code);
    this.name = "SiteAuthError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Claims a nonce, or reports that it has been seen.
 *
 * The primary key is the mechanism: a conflicting insert means a replay, and
 * two concurrent replays cannot both win because only one insert can succeed.
 */
async function claimNonce(keyId, nonce) {
  const { rowCount } = await query(
    `insert into site_request_nonces (key_id, nonce) values ($1, $2)
     on conflict (key_id, nonce) do nothing`,
    [keyId, nonce]
  );
  return rowCount === 1;
}

let lastSweep = 0;
async function sweepNonces() {
  // Amortised rather than scheduled: this runs on a request that has already
  // paid for a round trip, and never more than once a minute.
  if (Date.now() - lastSweep < 60_000) return;
  lastSweep = Date.now();
  try {
    await query(
      "delete from site_request_nonces where seen_at < now() - ($1::bigint * interval '1 millisecond')",
      [NONCE_RETENTION_MS]
    );
  } catch (err) {
    console.error("[siteAuth] nonce sweep failed:", err.message);
  }
}

/**
 * The route a signature covers.
 *
 * Built from the mount point plus the path within it, so it matches what the
 * plugin signed regardless of how Express happens to split the two. The query
 * is signed separately, so it is excluded here.
 */
export function signedRoute(req) {
  return `${req.baseUrl || ""}${req.path || ""}`;
}

/**
 * Verifies an inbound site request and attaches `req.site`.
 *
 * Every failure answers the same way: one generic 403 with a machine code.
 * Naming which check failed would tell a prober whether a key id exists,
 * whether a site is enrolled, or whether its license is current.
 */
export async function verifySiteRequest(req, res, next) {
  const refuse = async (code, detail) => {
    // Recorded so a site that cannot connect is diagnosable from the dashboard
    // — the same reasoning as the enrollment refusals. The response stays
    // generic; the diagnosis lives where only staff can see it.
    await audit.record({
      action: "site.request_refused",
      entityType: "website",
      entityId: req.__siteId || null,
      websiteId: req.__siteId || null,
      ip: req.ip,
      result: "refused",
      after: { code, route: signedRoute(req), detail: detail || null },
    });
    return res.status(403).json({ ok: false, error: { code: "forbidden", message: "Request refused." } });
  };

  if (!isConfigured()) {
    return res.status(503).json({ ok: false, error: { code: "not_configured", message: "Unavailable." } });
  }

  try {
    const keyId = String(req.get("x-de-key-id") || "");
    const timestamp = String(req.get("x-de-timestamp") || "");
    const nonce = String(req.get("x-de-nonce") || "");
    const signature = String(req.get("x-de-signature") || "");
    const idempotencyKey = String(req.get("idempotency-key") || "");

    if (!keyId || !timestamp || !nonce || !signature) return refuse("missing_signature");
    // Bounded so an oversized header can't be used to burn memory or grow the
    // nonce table.
    if (keyId.length > 128 || nonce.length > 128 || signature.length > 200 || idempotencyKey.length > 200) {
      return refuse("malformed");
    }
    if (!/^\d{1,12}$/.test(timestamp)) return refuse("malformed");
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
      return refuse("stale_request");
    }

    const [version, provided] = signature.split(" ", 2);
    // The version check comes before any cryptography: a hub->site signature
    // must not even be considered here.
    if (version !== SITE_SIGNATURE_VERSION || !provided) return refuse("malformed");

    const site = await getSiteByKeyId(keyId);
    if (!site) return refuse("unknown_key");
    req.__siteId = site.id;

    let secret;
    try { secret = decryptSecret(site.um_secret_enc); }
    catch { return refuse("credential_unreadable"); }

    const canonical = canonicalString({
      method: req.method,
      route: signedRoute(req),
      query: req.query,
      timestamp,
      nonce,
      idempotencyKey,
      // req.rawBody is captured by the JSON parser (see server.js): the
      // signature covers the bytes that arrived, not a re-serialisation of the
      // parsed object, which would not reproduce them.
      body: req.rawBody || "",
    });

    const expected = Buffer.from(signCanonical(secret, canonical), "utf8");
    const got = Buffer.from(provided, "utf8");
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
      return refuse("bad_signature");
    }

    // Only after the signature verifies. Otherwise anyone could burn a nonce —
    // locking out a legitimate request — or grow the table, with unsigned junk.
    if (!(await claimNonce(keyId, nonce))) return refuse("replay");
    sweepNonces();

    // A site whose license lapsed keeps its credential but loses access, the
    // same way monitoring does.
    if (!site.license_key) return refuse("no_license");
    if (site.license_expires_at && new Date(site.license_expires_at).getTime() < Date.now()) {
      return refuse("license_expired");
    }

    req.site = {
      id: site.id,
      name: site.name,
      url: site.url,
      keyId,
      scopes: site.um_scopes || [],
      hubScopes: site.um_hub_scopes || [],
      effectiveScopes: effectiveScopes(site),
      idempotencyKey,
    };
    return next();
  } catch (err) {
    console.error("[siteAuth] verification failed:", err.message);
    return res.status(500).json({ ok: false, error: { code: "failed", message: "Request could not be processed." } });
  }
}

/**
 * Requires a scope, from either authority.
 *
 * users:read and users:write are the site's own grants, reported by its plugin.
 * plugin:assign is the hub's, and the site has no say in it — which is why the
 * two live in separate columns.
 */
export function requireSiteScope(scope) {
  return (req, res, next) => {
    if (!req.site) return res.status(403).json({ ok: false, error: { code: "forbidden", message: "Request refused." } });
    if (!req.site.effectiveScopes.includes(scope)) {
      return res.status(403).json({
        ok: false,
        error: {
          code: "scope_denied",
          // Actionable, and discloses nothing: the site already knows its own
          // permissions, and plugin:assign is visible in the dashboard.
          message: `This website isn't permitted to do that (${scope}).`,
        },
      });
    }
    return next();
  };
}

/**
 * Per-site rate limiting, keyed on the credential rather than the IP.
 *
 * A site behind a shared host must not be throttled by a neighbour, and a site
 * that changes address must not escape its limit. In-process, matching how
 * rateLimit.js and the sweep lock already assume a single instance.
 */
const buckets = new Map();
export function rateLimitPerSite({ windowMs = 60_000, max = 120 } = {}) {
  return function siteRateLimit(req, res, next) {
    const keyId = String(req.get("x-de-key-id") || "").slice(0, 128);
    if (!keyId) return next(); // unsigned: verifySiteRequest will refuse it anyway
    const now = Date.now();
    let bucket = buckets.get(keyId);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(keyId, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: { code: "rate_limited", message: "Too many requests." } });
    }
    return next();
  };
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000);
sweeper.unref();
