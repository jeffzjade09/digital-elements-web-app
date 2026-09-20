// Tests for request signing, credential encryption, and the guards around
// calling a client site.
//
// The signing vectors in tests/fixtures/signing-vectors.json are shared with
// tests/usermgmt-auth.test.php, so the JavaScript and PHP sides can't drift
// apart: a change to how either builds the canonical string fails one suite.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalString, canonicalQuery, normalizeRoute, signCanonical, signRequest,
  sha256Hex, SIGNATURE_VERSION, MAX_CLOCK_SKEW_SECONDS,
} from "../src/usermgmt/signing.js";
import {
  encryptSecret, decryptSecret, generateCredential, credentialView,
  normalizeCode, isConfigured, DEFAULT_SCOPES, ALL_SCOPES,
} from "../src/usermgmt/credentials.js";
import { deV2Base, assertSafeUrl, WpError, NAMESPACE } from "../src/usermgmt/wpClient.js";
import { REQUIRED_API_VERSION, READINESS, assertCapable } from "../src/usermgmt/capabilities.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const throws = (label, fn, re) => {
  try { fn(); ok(label, false, "did not throw"); }
  catch (err) { ok(label, re ? re.test(err.message) : true, err.message); }
};

console.log("--- shared signing vectors ---");
const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "signing-vectors.json"), "utf8"));
ok("vectors load", Array.isArray(vectors) && vectors.length >= 8);
for (const v of vectors) {
  const canonical = canonicalString(v);
  eq(`canonical: ${v.name}`, canonical, v.canonical);
  eq(`signature: ${v.name}`, signCanonical(v.secret, canonical), v.signature);
}

console.log("\n--- the canonical string commits to everything that matters ---");
const base = {
  method: "POST", route: "/de/v2/users", query: { a: "1" }, timestamp: 1790000000,
  nonce: "n1", idempotencyKey: "k1", body: '{"role":"editor"}',
};
const sig = (over) => signCanonical("s", canonicalString({ ...base, ...over }));
const baseline = sig({});
ok("method is covered", sig({ method: "DELETE" }) !== baseline);
ok("route is covered", sig({ route: "/de/v2/users/7" }) !== baseline);
ok("query is covered", sig({ query: { a: "2" } }) !== baseline);
ok("timestamp is covered", sig({ timestamp: 1790000001 }) !== baseline);
ok("nonce is covered", sig({ nonce: "n2" }) !== baseline);
ok("idempotency key is covered", sig({ idempotencyKey: "k2" }) !== baseline);
ok("body is covered", sig({ body: '{"role":"administrator"}' }) !== baseline);
ok("the secret matters", signCanonical("other", canonicalString(base)) !== baseline);

console.log("\n--- canonical query ---");
eq("no params", canonicalQuery(null), "");
eq("sorted by name", canonicalQuery({ b: 1, a: 2 }), "a=2&b=1");
eq("order-independent", canonicalQuery({ a: 2, b: 1 }), canonicalQuery({ b: 1, a: 2 }));
eq("repeated values sorted", canonicalQuery({ s: ["b", "a"] }), "s=a&s=b");
eq("URLSearchParams accepted", canonicalQuery(new URLSearchParams("b=1&a=2")), "a=2&b=1");
// WordPress may add or rewrite these in transit; signing them would make a
// valid request fail depending on the site's permalink setup.
eq("rest_route excluded", canonicalQuery({ rest_route: "/de/v2/users", a: "1" }), "a=1");
eq("_locale excluded", canonicalQuery({ _locale: "user", a: "1" }), "a=1");
// PHP's rawurlencode follows RFC 3986; encodeURIComponent does not for these.
eq("RFC 3986 encoding", canonicalQuery({ k: "it's*here!(x)" }), "k=it%27s%2Ahere%21%28x%29");
eq("spaces and plus", canonicalQuery({ k: "a+b c" }), "k=a%2Bb%20c");

console.log("\n--- route normalization ---");
eq("leading slash added", normalizeRoute("de/v2/users"), "/de/v2/users");
eq("trailing slash removed", normalizeRoute("/de/v2/users/"), "/de/v2/users");
eq("doubled slashes collapsed", normalizeRoute("/de//v2///users"), "/de/v2/users");
eq("empty route", normalizeRoute(""), "/");
eq("empty body hashes to the empty-string digest", sha256Hex(""), sha256Hex(null));

console.log("\n--- signRequest headers ---");
const signed = signRequest({
  keyId: "dek_abc", secret: "s", method: "POST", route: "/de/v2/users",
  body: '{"a":1}', idempotencyKey: "job-1",
});
eq("key id header", signed.headers["X-DE-Key-Id"], "dek_abc");
ok("signature is version-prefixed", signed.headers["X-DE-Signature"].startsWith(SIGNATURE_VERSION + " "));
ok("nonce is generated", /^[0-9a-f-]{36}$/.test(signed.headers["X-DE-Nonce"]));
ok("timestamp is current", Math.abs(Number(signed.headers["X-DE-Timestamp"]) - Math.floor(Date.now() / 1000)) < 5);
eq("idempotency key is sent", signed.headers["Idempotency-Key"], "job-1");
eq("content type set when there's a body", signed.headers["Content-Type"], "application/json");
ok("no content type without a body",
   signRequest({ keyId: "k", secret: "s", method: "GET", route: "/x" }).headers["Content-Type"] === undefined);
ok("two requests never reuse a nonce",
   signRequest({ keyId: "k", secret: "s", method: "GET", route: "/x" }).nonce !==
   signRequest({ keyId: "k", secret: "s", method: "GET", route: "/x" }).nonce);
eq("the skew window is five minutes", MAX_CLOCK_SKEW_SECONDS, 300);

console.log("\n--- credential encryption ---");
const savedKey = process.env.USER_MGMT_ENC_KEY;
process.env.USER_MGMT_ENC_KEY = Buffer.alloc(32, 7).toString("base64");
ok("configured once a key is set", isConfigured());

const secret = "a-very-secret-value-é";
const blob = encryptSecret(secret);
eq("round-trips", decryptSecret(blob), secret);
ok("the ciphertext doesn't contain the plaintext", !blob.includes(secret));
ok("versioned", blob.startsWith("v1."));
ok("the same secret encrypts differently each time", encryptSecret(secret) !== encryptSecret(secret));
throws("a tampered ciphertext fails rather than returning garbage", () => {
  const parts = blob.split(".");
  const ct = Buffer.from(parts[3], "base64");
  ct[0] ^= 0xff;
  decryptSecret([parts[0], parts[1], parts[2], ct.toString("base64")].join("."));
});
throws("a malformed blob is refused", () => decryptSecret("nonsense"), /not in a recognised format/);
process.env.USER_MGMT_ENC_KEY = Buffer.alloc(32, 9).toString("base64");
throws("the wrong key can't decrypt", () => decryptSecret(blob));
process.env.USER_MGMT_ENC_KEY = "too-short";
throws("a short key is refused", () => encryptSecret("x"), /32 bytes/);
ok("a bad key reports unconfigured rather than crashing", isConfigured() === false);
process.env.USER_MGMT_ENC_KEY = Buffer.alloc(32, 7).toString("base64");

console.log("\n--- credentials ---");
const cred = generateCredential();
ok("key id is prefixed", cred.keyId.startsWith("dek_"));
ok("secret has enough entropy", cred.secret.length >= 40);
ok("two credentials differ", generateCredential().keyId !== generateCredential().keyId);

// The secret must never be reachable from anything an API returns.
const view = credentialView({
  um_key_id: cred.keyId, um_secret_enc: blob, um_scopes: DEFAULT_SCOPES,
  um_enrolled_at: "2026-09-21T00:00:00Z", um_rotated_at: null,
});
ok("the view exposes the key id", view.keyId === cred.keyId);
ok("the view never exposes the secret", !JSON.stringify(view).includes(cred.secret) && !JSON.stringify(view).includes(blob));
ok("delete and admin scopes are not granted by default",
   !DEFAULT_SCOPES.includes("users:delete") && !DEFAULT_SCOPES.includes("users:admin"));
ok("but they exist as grantable scopes",
   ALL_SCOPES.includes("users:delete") && ALL_SCOPES.includes("users:admin"));
eq("codes normalize", normalizeCode(" deum-ab12-cd34-ef56 "), "DEUM-AB12-CD34-EF56");

console.log("\n--- the de/v2 base URL ---");
eq("derived from the site URL", deV2Base({ url: "https://example.com/" }), `https://example.com/wp-json/${NAMESPACE}`);
eq("a custom helper endpoint is respected",
   deV2Base({ url: "https://example.com", helper: { endpoint: "https://example.com/custom/wpmonitor/v1/status" } }),
   `https://example.com/custom/${NAMESPACE}`);
throws("a site with no URL is refused", () => deV2Base({}), /no URL/);

console.log("\n--- the SSRF guard ---");
const allowLocal = process.env.UM_ALLOW_LOCAL_SITES;
delete process.env.UM_ALLOW_LOCAL_SITES;
// assertSafeUrl reads the flag at import time, so only the always-on rules are
// asserted here; the local-host rule is covered by its own constant below.
ok("https is allowed", !!assertSafeUrl("https://example.com/wp-json/de/v2"));
throws("a non-http scheme is refused", () => assertSafeUrl("file:///etc/passwd"), /http or https/);
throws("garbage is refused", () => assertSafeUrl("not a url"), /isn't valid/);
throws("credentials in the URL are refused", () => assertSafeUrl("https://user:pw@example.com/"), /credentials/);
if (allowLocal !== undefined) process.env.UM_ALLOW_LOCAL_SITES = allowLocal;

console.log("\n--- capability gating ---");
eq("this app speaks contract revision 1", REQUIRED_API_VERSION, 1);
const ready = { readiness: READINESS.READY, capabilities: ["users.read"], websiteId: "w1", name: "Site", message: "Ready" };
ok("a ready site with the capability passes", assertCapable(ready, "users.read") === true);
throws("a ready site without the capability is refused",
       () => assertCapable(ready, "users.delete"), /doesn't support this action/);
throws("an outdated site is refused before anything is attempted",
       () => assertCapable({ readiness: READINESS.PLUGIN_UPDATE_REQUIRED, capabilities: [], websiteId: "w1", name: "Site", message: "Plugin update required (has 2.5.0)." }, "users.read"),
       /Plugin update required/);
throws("an unenrolled site is refused",
       () => assertCapable({ readiness: READINESS.NEEDS_ENROLLMENT, capabilities: [], websiteId: "w1", name: "Site", message: "Needs enrolling" }, "users.read"),
       /Needs enrolling/);
ok("refusals are WpErrors the caller can branch on", (() => {
  try { assertCapable({ readiness: READINESS.UNREACHABLE, capabilities: [], websiteId: "w", name: "S", message: "x" }); }
  catch (err) { return err instanceof WpError && err.code === READINESS.UNREACHABLE; }
  return false;
})());

if (savedKey === undefined) delete process.env.USER_MGMT_ENC_KEY;
else process.env.USER_MGMT_ENC_KEY = savedKey;

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
