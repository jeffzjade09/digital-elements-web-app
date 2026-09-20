// Per-website user-management credentials.
//
// Why this is separate from the license key: the license key is a single shared
// bearer token that authorizes the read-only monitoring endpoints. That is an
// acceptable trust model for reading update counts, but not for an endpoint
// that can create an Administrator — a leaked key would compromise every
// connected site at once. User-management requests are therefore signed with a
// distinct, scoped, independently rotatable secret.
//
// The secret is stored encrypted at rest and is never returned by any API. Only
// the plugin on the site and this module ever hold the plaintext.

import crypto from "node:crypto";
import { query } from "../db.js";

// Scopes a site is enrolled with by default. Deleting users and assigning
// administrator-like roles are NOT included: a WP admin turns those on in the
// DE Monitoring panel on the site itself, so the site owner keeps a local kill
// switch that no credential leak can flip.
export const DEFAULT_SCOPES = ["users:read", "users:write", "content:reassign"];
export const ALL_SCOPES = [...DEFAULT_SCOPES, "users:delete", "users:admin"];

const ENROLLMENT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CODE_GROUPS = 3;
// Crockford-style alphabet: no I, L, O, U, so a code read aloud or retyped from
// a screenshot can't be ambiguous.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/* ------------------------------------------------------------ encryption */

// 32 raw bytes, base64 or hex. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
function encryptionKey() {
  const raw = process.env.USER_MGMT_ENC_KEY || "";
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("USER_MGMT_ENC_KEY must decode to exactly 32 bytes (base64 or hex).");
  }
  return buf;
}

// User management is optional: without a key the app runs exactly as before and
// the feature reports itself unconfigured rather than crashing at boot.
export function isConfigured() {
  try { return encryptionKey() !== null; } catch { return false; }
}

export function assertConfigured() {
  if (!isConfigured()) {
    throw new Error("User management isn't configured on this server yet — USER_MGMT_ENC_KEY is not set. See docs/user-management.md.");
  }
}

// "v1.<iv>.<tag>.<ciphertext>", all base64. Versioned so the scheme can change
// later without guessing at what an existing value was encrypted with.
export function encryptSecret(plaintext) {
  const key = encryptionKey();
  if (!key) throw new Error("USER_MGMT_ENC_KEY is not set.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(blob) {
  const key = encryptionKey();
  if (!key) throw new Error("USER_MGMT_ENC_KEY is not set.");
  const parts = String(blob || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Stored credential is not in a recognised format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64"));
  // A wrong key or tampered value fails here rather than returning garbage.
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
}

/* ----------------------------------------------------------- credentials */

export function generateCredential() {
  return {
    keyId: "dek_" + crypto.randomBytes(8).toString("hex"),
    secret: crypto.randomBytes(32).toString("base64url"),
  };
}

// Everything about a site's credential that is safe to show. Note the absence
// of the secret — it is never returned, not even to an administrator.
export function credentialView(row) {
  if (!row) return null;
  return {
    enrolled: !!row.um_key_id,
    keyId: row.um_key_id || null,
    scopes: row.um_scopes || [],
    enrolledAt: row.um_enrolled_at || null,
    rotatedAt: row.um_rotated_at || null,
  };
}

// Plaintext secret for signing. Internal use only — never goes near a response.
export async function getSigningCredential(websiteId) {
  const { rows } = await query(
    "select um_key_id, um_secret_enc, um_scopes from websites where id = $1",
    [websiteId]
  );
  const row = rows[0];
  if (!row || !row.um_key_id || !row.um_secret_enc) return null;
  return { keyId: row.um_key_id, secret: decryptSecret(row.um_secret_enc), scopes: row.um_scopes || [] };
}

// Issues a fresh credential for a site, replacing any existing one. The old
// secret stops working the moment the site stores the new one, so rotation is
// always paired with re-enrollment.
export async function storeCredential(websiteId, { keyId, secret, scopes }, { rotation = false } = {}) {
  assertConfigured();
  const { rows } = await query(
    `update websites set
       um_key_id = $2,
       um_secret_enc = $3,
       um_scopes = $4,
       um_enrolled_at = coalesce(um_enrolled_at, now()),
       um_rotated_at = case when $5 then now() else um_rotated_at end,
       updated_at = now()
     where id = $1
     returning um_key_id, um_scopes, um_enrolled_at, um_rotated_at`,
    [websiteId, keyId, encryptSecret(secret), scopes || DEFAULT_SCOPES, rotation]
  );
  return rows[0] ? credentialView(rows[0]) : null;
}

// Revokes a site's credential entirely. The plugin's stored secret becomes
// useless; monitoring is unaffected.
export async function revokeCredential(websiteId) {
  const { rows } = await query(
    `update websites set um_key_id = null, um_secret_enc = null, um_scopes = '{}',
            um_enrolled_at = null, um_rotated_at = null, updated_at = now()
      where id = $1 returning id`,
    [websiteId]
  );
  return rows.length > 0;
}

/* ------------------------------------------------------ enrollment codes */

function randomCode() {
  const groups = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let out = "";
    // randomInt is rejection-sampled, so every character is uniformly drawn.
    for (let i = 0; i < 4; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    groups.push(out);
  }
  return "DEUM-" + groups.join("-");
}

export function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().replace(/\s+/g, "");
}

function hashCode(code) {
  return crypto.createHash("sha256").update(normalizeCode(code), "utf8").digest("hex");
}

/**
 * Issues a short-lived, single-use enrollment code for a site.
 *
 * The plaintext code is returned exactly once, to be shown to the administrator
 * who will paste it into the site's DE Monitoring panel. Only its hash is
 * stored, so reading this table gives an attacker nothing usable.
 */
export async function issueEnrollmentCode(websiteId, createdBy = null) {
  assertConfigured();
  // Outstanding codes for this site are invalidated, so only the newest one
  // shown to an administrator can ever be redeemed.
  await query("delete from um_enrollment_codes where website_id = $1 and redeemed_at is null", [websiteId]);

  const code = randomCode();
  const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
  await query(
    "insert into um_enrollment_codes (website_id, code_hash, expires_at, created_by) values ($1,$2,$3,$4)",
    [websiteId, hashCode(code), expiresAt.toISOString(), createdBy]
  );
  return { code, expiresAt: expiresAt.toISOString(), expiresInSeconds: Math.round(ENROLLMENT_TTL_MS / 1000) };
}

/**
 * Redeems a code and returns the site's new credential. Called by the plugin,
 * not by a browser.
 *
 * Two independent secrets must be presented: the enrollment code AND the site's
 * license key. A code intercepted on its own is useless, and a leaked license
 * key alone cannot enroll anything.
 *
 * Returns `{ ok: false, reason }` rather than throwing, so the caller can map
 * every failure to the same generic response and avoid telling a prober which
 * half was wrong.
 */
export async function redeemEnrollmentCode({ code, licenseKey, ip }) {
  assertConfigured();
  const { rows } = await query(
    `select c.id, c.website_id, c.expires_at, c.redeemed_at, w.license_key, w.license_expires_at, w.name
       from um_enrollment_codes c
       join websites w on w.id = c.website_id
      where c.code_hash = $1`,
    [hashCode(code)]
  );
  const row = rows[0];
  // The reason is for OUR log, not for the caller. The HTTP response stays a
  // single generic refusal either way — see /api/plugin/enroll — so this can
  // name the real cause without becoming an oracle for valid codes or keys.
  if (!row) return { ok: false, reason: "unknown_code" };
  const site = { websiteId: row.website_id, siteName: row.name };
  if (row.redeemed_at) return { ok: false, reason: "already_redeemed", ...site };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired", ...site };

  // Constant-time compare so this can't be used as a license-key oracle.
  const provided = Buffer.from(String(licenseKey || ""), "utf8");
  const expected = Buffer.from(String(row.license_key || ""), "utf8");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "license_mismatch", ...site };
  }
  if (row.license_expires_at && new Date(row.license_expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "license_expired", ...site };
  }

  // Mark redeemed first, and only if it is still unredeemed, so two concurrent
  // redemptions can't both succeed.
  const claim = await query(
    "update um_enrollment_codes set redeemed_at = now(), redeemed_ip = $2 where id = $1 and redeemed_at is null returning id",
    [row.id, ip || null]
  );
  if (!claim.rows.length) return { ok: false, reason: "already_redeemed", ...site };

  const credential = generateCredential();
  await storeCredential(row.website_id, { ...credential, scopes: DEFAULT_SCOPES });
  return {
    ok: true,
    websiteId: row.website_id,
    siteName: row.name,
    keyId: credential.keyId,
    secret: credential.secret,
    scopes: DEFAULT_SCOPES,
  };
}

/**
 * What each refusal means, in words an administrator can act on.
 *
 * Kept here so the activity log and the dashboard say the same thing, and so
 * the generic HTTP response stays the only thing the outside world sees.
 */
export const ENROLLMENT_FAILURES = {
  unknown_code: "The code wasn't recognised. It may have been mistyped, already used, or superseded by a newer one.",
  already_redeemed: "That code had already been used. Generate a fresh one.",
  expired: "The code had expired — they last 15 minutes. Generate a fresh one.",
  license_mismatch: "The plugin on that site is using a different website's license key, so the code was refused. Check which website that site's DE Monitoring panel is linked to.",
  license_expired: "That website's monitoring license has expired, so enrollment was refused. Renew it first.",
  not_configured: "User management isn't configured on this dashboard yet.",
};

export function describeEnrollmentFailure(reason) {
  return ENROLLMENT_FAILURES[reason] || "The code was refused.";
}

// Housekeeping: expired, unredeemed codes are dead weight.
export async function pruneEnrollmentCodes() {
  const { rowCount } = await query(
    "delete from um_enrollment_codes where redeemed_at is null and expires_at < now() - interval '1 day'"
  );
  return rowCount;
}
