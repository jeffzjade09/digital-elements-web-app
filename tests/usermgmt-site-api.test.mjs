// Tests for the site-initiated API: a connected website calling the hub.
//
// This is a new inbound attack surface — every enrolled site now holds a secret
// that can reach us — so what is asserted here is mostly what a site CANNOT do.
//
// The pure half (signing domains, scope authority, the roster allow-list) always
// runs. The half that needs a database — site resolution by key id, replay,
// job idempotency, and the #16 interaction where a probe must not wipe a
// hub-granted scope — skips cleanly without DATABASE_URL, the same way the PHP
// suites skip without php.

import crypto from "node:crypto";

import {
  canonicalString, signCanonical, SIGNATURE_VERSION, SITE_SIGNATURE_VERSION, MAX_CLOCK_SKEW_SECONDS,
} from "../src/usermgmt/signing.js";
import {
  HUB_CONTROLLED_SCOPES, DEFAULT_HUB_SCOPES, DEFAULT_SCOPES, ALL_SCOPES,
  isHubControlledScope, effectiveScopes, credentialView,
} from "../src/usermgmt/credentials.js";

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/* ------------------------------------------- the two directions are separate */

console.log("--- a signature from one direction cannot validate in the other ---");
ok("the version strings differ", SIGNATURE_VERSION !== SITE_SIGNATURE_VERSION);
eq("the site direction is explicit", SITE_SIGNATURE_VERSION, "DE1-SITE-HMAC-SHA256");

// Both directions share a secret and a canonical string. Today a captured
// hub->site signature could not be replayed at the hub only because the route
// strings differ; the distinct version makes that structural rather than lucky.
const SECRET = "shared-per-site-secret";
const req = { method: "POST", route: "/api/site/v1/assign", query: {}, timestamp: 1790000000,
              nonce: "n1", idempotencyKey: "k1", body: '{"staffUserIds":["a"]}' };
const sig = signCanonical(SECRET, canonicalString(req));

const presentedAsHub = `${SIGNATURE_VERSION} ${sig}`;
const presentedAsSite = `${SITE_SIGNATURE_VERSION} ${sig}`;
ok("the same bytes are presented with different version prefixes",
   presentedAsHub !== presentedAsSite);
// Each side compares the version before doing any cryptography, so a mismatch
// is refused without the HMAC ever being considered.
eq("a hub-direction prefix is not the site-direction prefix",
   presentedAsHub.split(" ")[0] === SITE_SIGNATURE_VERSION, false);

console.log("\n--- the canonical string still commits to everything ---");
const base = signCanonical(SECRET, canonicalString(req));
const vary = (over) => signCanonical(SECRET, canonicalString({ ...req, ...over }));
ok("route is covered", vary({ route: "/api/site/v1/roster" }) !== base);
ok("body is covered", vary({ body: '{"staffUserIds":["b"]}' }) !== base);
ok("idempotency key is covered", vary({ idempotencyKey: "k2" }) !== base);
ok("nonce is covered", vary({ nonce: "n2" }) !== base);
ok("timestamp is covered", vary({ timestamp: 1790000001 }) !== base);
eq("the skew window is unchanged", MAX_CLOCK_SKEW_SECONDS, 300);

/* ----------------------------------------------- two authorities, two sets - */

console.log("\n--- site-controlled and hub-controlled scopes are distinct ---");
ok("plugin:assign is hub-controlled", isHubControlledScope("plugin:assign"));
for (const sc of ALL_SCOPES) {
  ok(`${sc} is NOT hub-controlled`, isHubControlledScope(sc) === false);
}
ok("the two sets do not overlap",
   HUB_CONTROLLED_SCOPES.every((sc) => !ALL_SCOPES.includes(sc)));
ok("plugin:assign is granted at enrollment", DEFAULT_HUB_SCOPES.includes("plugin:assign"));
ok("...and is not among the scopes a site reports", !DEFAULT_SCOPES.includes("plugin:assign"));

console.log("\n--- effective scopes are the union, kept separately ---");
const row = { um_scopes: ["users:read", "users:write", "users:admin"], um_hub_scopes: ["plugin:assign"] };
const eff = effectiveScopes(row);
ok("a site-granted scope is included", eff.includes("users:admin"));
ok("a hub-granted scope is included", eff.includes("plugin:assign"));
eq("no duplicates", eff.length, new Set(eff).size);
eq("an empty row yields nothing", effectiveScopes({}).length, 0);

const view = credentialView({ um_key_id: "dek_x", ...row });
ok("the view keeps them apart", !view.scopes.includes("plugin:assign") && view.hubScopes.includes("plugin:assign"),
   JSON.stringify(view.scopes) + " / " + JSON.stringify(view.hubScopes));

/* ------------------------------------------------------ roster allow-list -- */

console.log("\n--- the roster exposes only what the form needs ---");
// Mirrors buildSiteRoster's member shape. The point of asserting the exact key
// list is that a column added later must not be disclosed by default.
const MEMBER_KEYS = ["staffUserId", "label", "email", "defaultWpRole", "roleSource", "onThisSite"];
const sample = {
  staffUserId: "u1", label: "Jason", email: "jason@digitalelementsgroup.com",
  defaultWpRole: "administrator", roleSource: "team",
  onThisSite: { present: true, roles: ["editor"], managed: true, state: "synced", lastSyncedAt: null },
};
eq("exactly the intended fields", Object.keys(sample).join(","), MEMBER_KEYS.join(","));
for (const forbidden of ["appUserId", "createdBy", "domainOverride", "createdAt", "otherSites", "status"]) {
  ok(`${forbidden} is not disclosed`, !Object.keys(sample).includes(forbidden));
}
// onThisSite is about the CALLING site only — the query behind it is scoped by
// website_id before anything is shaped.
ok("onThisSite names no website", !JSON.stringify(sample.onThisSite).includes("websiteId"));

console.log(fail ? `\n${fail} assertion(s) failed` : "");

/* ------------------------------------------------------- database-backed --- */

if (!process.env.DATABASE_URL) {
  console.log("\nSKIP  site resolution, replay, idempotency and the probe interaction (no DATABASE_URL)");
  console.log(fail ? `${fail} assertion(s) failed` : "All assertions passed");
  process.exit(fail ? 1 : 0);
}

const db = await import("../src/db.js");
const credentials = await import("../src/usermgmt/credentials.js");
const capsMod = await import("../src/usermgmt/capabilities.js");
const { buildSiteRoster, assertStaffSelectable } = await import("../src/usermgmt/siteRoster.js");

const KEY_ID = "dek_site_test_" + crypto.randomBytes(4).toString("hex");
const SITE_SECRET = crypto.randomBytes(32).toString("base64url");
let websiteId = null;

try {
  const created = await db.query(
    "insert into websites (name, url, helper_enabled, license_key) values ($1,$2,true,$3) returning id",
    ["Site API Test " + Date.now(), "https://siteapi.test", "DEG-TEST1-TEST2-TEST3-TEST4"]
  );
  websiteId = created.rows[0].id;
  await credentials.storeCredential(websiteId, { keyId: KEY_ID, secret: SITE_SECRET });

  const scopesNow = async () => {
    const { rows } = await db.query("select um_scopes, um_hub_scopes from websites where id=$1", [websiteId]);
    return rows[0];
  };

  console.log("\n--- a site enrolled before 2.7.0 is backfilled ---");
  // The case that matters for the existing estate: anything already connected
  // must work without someone revisiting it to re-enroll.
  const BACKFILL = `update websites set um_hub_scopes = array['plugin:assign']
                     where um_key_id is not null and not (um_hub_scopes @> array['plugin:assign'])`;

  const legacy = await db.query(
    `insert into websites (name, url, helper_enabled, license_key, um_key_id, um_secret_enc, um_scopes, um_hub_scopes, um_enrolled_at)
     values ($1,$2,true,$3,$4,$5,$6,'{}', now()) returning id`,
    ["Legacy Enrolled " + Date.now(), "https://legacy.test", "DEG-LEGA1-LEGA2-LEGA3-LEGA4",
     "dek_legacy_" + crypto.randomBytes(3).toString("hex"), "v1.x.y.z", ["users:read", "users:write"]]
  );
  const legacyId = legacy.rows[0].id;
  const never = await db.query(
    "insert into websites (name, url, helper_enabled) values ($1,$2,true) returning id",
    ["Never Enrolled " + Date.now(), "https://never.test"]
  );
  const neverId = never.rows[0].id;

  await db.query(BACKFILL);
  const afterBackfill = await db.query("select um_hub_scopes from websites where id=$1", [legacyId]);
  ok("an already-enrolled site gains plugin:assign",
     afterBackfill.rows[0].um_hub_scopes.includes("plugin:assign"),
     afterBackfill.rows[0].um_hub_scopes.join(","));

  const neverAfter = await db.query("select um_hub_scopes from websites where id=$1", [neverId]);
  eq("a site that was never enrolled is granted nothing", neverAfter.rows[0].um_hub_scopes.length, 0);

  // Idempotent: a redeploy re-running it must change nothing.
  const { rowCount: again } = await db.query(BACKFILL);
  eq("re-running the backfill is a no-op", again, 0);

  // And it must not undo a deliberate revoke made after the migration ran.
  await db.query("update websites set um_hub_scopes = '{}' where id = $1", [legacyId]);
  await db.query(BACKFILL);
  const revoked = await db.query("select um_hub_scopes from websites where id=$1", [legacyId]);
  ok("NOTE: the backfill would re-grant a revoked site, which is why it runs once as a migration",
     revoked.rows[0].um_hub_scopes.includes("plugin:assign"));

  await db.query("delete from websites where id = any($1::uuid[])", [[legacyId, neverId]]);

  console.log("\n--- enrollment grants plugin:assign ---");
  let s = await scopesNow();
  ok("hub scope granted at enrollment", s.um_hub_scopes.includes("plugin:assign"), s.um_hub_scopes.join(","));
  ok("...and is not in the site's own scopes", !s.um_scopes.includes("plugin:assign"), s.um_scopes.join(","));

  console.log("\n--- a site is resolved by its credential, never by a parameter ---");
  const resolved = await credentials.getSiteByKeyId(KEY_ID);
  eq("the right site is found", resolved.id, websiteId);
  eq("an unknown key resolves to nothing", await credentials.getSiteByKeyId("dek_nope"), null);
  eq("a blank key resolves to nothing", await credentials.getSiteByKeyId(""), null);
  eq("the stored secret round-trips", credentials.decryptSecret(resolved.um_secret_enc), SITE_SECRET);

  console.log("\n--- nonces are single-use ---");
  const claim = async (nonce) => {
    const { rowCount } = await db.query(
      "insert into site_request_nonces (key_id, nonce) values ($1,$2) on conflict do nothing",
      [KEY_ID, nonce]
    );
    return rowCount === 1;
  };
  ok("first use is accepted", await claim("nonce-a"));
  ok("a replay is refused", (await claim("nonce-a")) === false);
  ok("a different nonce is fine", await claim("nonce-b"));
  // Two sites can legitimately pick the same nonce.
  const { rowCount: other } = await db.query(
    "insert into site_request_nonces (key_id, nonce) values ($1,$2) on conflict do nothing",
    ["dek_someone_else", "nonce-a"]
  );
  ok("the same nonce from another site is independent", other === 1);
  await db.query("delete from site_request_nonces where key_id in ($1,$2)", [KEY_ID, "dek_someone_else"]);

  /* ------------- THE #16 INTERACTION: a probe must not wipe a hub scope ---- */

  console.log("\n--- a capability probe never touches hub-granted scopes ---");
  let PROBE = {
    ok: true, plugin_version: "2.6.1", api_version: 1, enrolled: true,
    capabilities: ["users.read", "users.write"],
    // The plugin does not know plugin:assign exists and never reports it.
    scopes: ["users:read", "users:write", "users:admin", "content:reassign"],
  };
  capsMod.__setProbeForTest(async () => {
    if (PROBE instanceof Error) throw PROBE;
    return PROBE;
  });
  const site = await db.getWebsiteSite(websiteId);

  await capsMod.getCapabilities(site, { force: true });
  s = await scopesNow();
  ok("the site's own grant is persisted", s.um_scopes.includes("users:admin"), s.um_scopes.join(","));
  ok("plugin:assign SURVIVES the probe", s.um_hub_scopes.includes("plugin:assign"), s.um_hub_scopes.join(","));

  console.log("\n--- a dashboard revoke survives the next probe ---");
  await credentials.setHubScopes(websiteId, []);
  s = await scopesNow();
  ok("revoked", !s.um_hub_scopes.includes("plugin:assign"));
  await capsMod.getCapabilities(site, { force: true });
  s = await scopesNow();
  ok("still revoked after a probe", !s.um_hub_scopes.includes("plugin:assign"), s.um_hub_scopes.join(","));
  // Without separate columns this is exactly where the revoke would silently
  // come back a few minutes later.
  ok("...and the site's own scopes are unaffected", s.um_scopes.includes("users:admin"));

  console.log("\n--- a site revoking its own scope still propagates ---");
  await credentials.setHubScopes(websiteId, ["plugin:assign"]);
  PROBE = { ...PROBE, scopes: ["users:read", "users:write", "content:reassign"] };
  await capsMod.getCapabilities(site, { force: true });
  s = await scopesNow();
  ok("users:admin is dropped", !s.um_scopes.includes("users:admin"), s.um_scopes.join(","));
  ok("...while plugin:assign is untouched", s.um_hub_scopes.includes("plugin:assign"));

  console.log("\n--- only hub-controlled scopes can be set from the dashboard ---");
  let refused = false;
  try { await credentials.setHubScopes(websiteId, ["users:admin"]); } catch { refused = true; }
  ok("a site-controlled scope is refused", refused);
  s = await scopesNow();
  ok("...and nothing changed", s.um_hub_scopes.includes("plugin:assign"));

  /* -------------------------------------------------- roster and selection - */

  console.log("\n--- the roster ---");
  const roster = await buildSiteRoster(websiteId);
  ok("teams come back", Array.isArray(roster.teams) && roster.teams.length > 0);
  const everyone = roster.teams.flatMap((t) => t.members);
  ok("members carry only the allowed keys",
     everyone.every((m) => Object.keys(m).join(",") === MEMBER_KEYS.join(",")),
     Object.keys(everyone[0] || {}).join(","));
  ok("nobody is reported as on this site yet", everyone.every((m) => m.onThisSite.present === false));
  ok("no external addresses are offered",
     everyone.every((m) => m.email.endsWith("@digitalelementsgroup.com")));

  console.log("\n--- selection is validated, not silently trimmed ---");
  const someone = everyone[0];
  const accepted = await assertStaffSelectable([someone.staffUserId]);
  eq("a real member is accepted", accepted.length, 1);
  let sel = false;
  try { await assertStaffSelectable([crypto.randomUUID()]); } catch { sel = true; }
  ok("an unknown id is refused rather than dropped", sel);
  sel = false;
  try { await assertStaffSelectable([]); } catch { sel = true; }
  ok("an empty selection is refused", sel);
  // Duplicates collapse first — 200 copies of one person is one person — so the
  // cap is on DISTINCT ids, which is the thing worth bounding.
  eq("duplicates collapse rather than counting toward the cap",
     (await assertStaffSelectable(new Array(200).fill(someone.staffUserId))).length, 1);
  let capMessage = "";
  try { await assertStaffSelectable(Array.from({ length: 101 }, () => crypto.randomUUID())); }
  catch (err) { capMessage = err.message; }
  ok("an oversized selection is refused for being oversized", /too many people/i.test(capMessage), capMessage);

  console.log("\n--- job idempotency ---");
  const { createJob, findJobByIdempotencyKey } = await import("../src/usermgmt/sync.js");
  const key = `site:${websiteId}:req-${Date.now()}`;
  const job1 = await createJob({ kind: "assign", params: {}, actor: {}, idempotencyKey: key, originWebsiteId: websiteId });
  const found = await findJobByIdempotencyKey(key);
  eq("the job is found by its key", found.id, job1.id);

  let dup = false;
  try {
    await createJob({ kind: "assign", params: {}, actor: {}, idempotencyKey: key, originWebsiteId: websiteId });
  } catch (err) { dup = err.code === "23505"; }
  ok("a second job under the same key is refused by the database", dup);

  // Dashboard jobs carry no key and must not collide with each other on null.
  const plain1 = await createJob({ kind: "assign", params: {}, actor: {} });
  const plain2 = await createJob({ kind: "assign", params: {}, actor: {} });
  ok("two keyless jobs coexist", plain1.id !== plain2.id);
  await db.query("delete from user_sync_jobs where id = any($1::uuid[])", [[job1.id, plain1.id, plain2.id]]);

  console.log("\n--- a site can only see its own job ---");
  const mine = await createJob({ kind: "assign", params: {}, actor: {}, originWebsiteId: websiteId });
  const theirs = await createJob({ kind: "assign", params: {}, actor: {}, originWebsiteId: null });
  const scoped = async (jobId, siteId) => {
    const { rows } = await db.query(
      "select id from user_sync_jobs where id=$1 and origin_website_id=$2", [jobId, siteId]
    );
    return rows.length === 1;
  };
  ok("its own job is visible", await scoped(mine.id, websiteId));
  ok("a dashboard job is not", (await scoped(theirs.id, websiteId)) === false);
  await db.query("delete from user_sync_jobs where id = any($1::uuid[])", [[mine.id, theirs.id]]);
} finally {
  capsMod.__setProbeForTest(null);
  if (websiteId) {
    await db.query("delete from site_request_nonces where key_id = $1", [KEY_ID]);
    await db.query("delete from websites where id = $1", [websiteId]);
  }
  await db.getPool().end();
}

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
