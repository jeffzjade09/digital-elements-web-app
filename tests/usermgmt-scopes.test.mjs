// Regression tests for persisting a site's granted scopes.
//
// THE BUG: a successful probe patched the site's live scopes into the returned
// object but never wrote them to websites.um_scopes. The immediate answer was
// therefore right and every cached read afterwards was wrong — so a site whose
// administrator had ticked "allow Administrator" was still refused, with a
// message saying they hadn't.
//
// Two layers are covered here. The decision about what to persist is pure and
// always runs. The round trip — probe, store, read back from cache, and what
// preflight then decides — needs a database, and skips cleanly without one the
// same way the PHP suites skip without php.

import { scopesToPersist, READINESS } from "../src/usermgmt/capabilities.js";
import { predict, ACTION } from "../src/usermgmt/preflight.js";
import { checkRoleAvailability } from "../src/usermgmt/roles.js";

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/* ------------------------------------------- what a probe should persist --- */

console.log("--- only a real answer from the site is persisted ---");
eq("an array is persisted",
   JSON.stringify(scopesToPersist({ scopes: ["users:read", "users:admin"] })),
   JSON.stringify(["users:read", "users:admin"]));

// "I grant nothing" is a real answer and must narrow what we believe, which is
// the revocation half of the client's kill switch.
eq("an EMPTY array is persisted, not ignored",
   JSON.stringify(scopesToPersist({ scopes: [] })), JSON.stringify([]));

// An older plugin doesn't report scopes at all. Keeping what we had is right;
// inventing scopes it never claimed would be worse than being stale.
eq("a plugin that doesn't report scopes leaves them alone", scopesToPersist({}), null);
eq("...and so does a null", scopesToPersist({ scopes: null }), null);
eq("...or a non-array", scopesToPersist({ scopes: "users:admin" }), null);
eq("...or no response at all", scopesToPersist(undefined), null);

/* ----------------------------------- what preflight does with those scopes -- */

const SITE = { id: "site-1", name: "Blue Star Recovery", url: "https://x.test" };
const STAFF = { id: "s1", label: "Jason", email: "jason@digitalelementsgroup.com", status: "active",
                defaultWpRole: null, teamDefaultWpRole: "administrator", teamName: "SEO" };
const SITE_ROLES = [
  { slug: "administrator", name: "Administrator", adminLike: true, siteAdmin: true },
  { slug: "editor", name: "Editor", adminLike: true, siteAdmin: false },
];
const caps = (scopes) => ({
  readiness: READINESS.READY, message: "Ready", pluginVersion: "2.6.1",
  requiredApiVersion: 1, capabilities: ["users.read", "users.write"], scopes,
});
const run = (scopes) => predict({
  staff: STAFF, site: SITE, capabilities: caps(scopes),
  roleCheck: checkRoleAvailability("administrator", SITE_ROLES),
  existing: { exists: false, user: null }, requestedRole: "administrator",
});

console.log("\n--- the scopes preflight reads decide the outcome ---");
const granted = run(["users:read", "users:write", "users:admin", "content:reassign"]);
eq("with users:admin granted, an administering role proceeds", granted.action, ACTION.CREATE);

// This is the exact shape of the bug: enrollment-time defaults, which never
// contain users:admin, persisted forever.
const stale = run(["users:read", "users:write", "content:reassign"]);
eq("without it, the assignment is blocked", stale.action, ACTION.BLOCKED);
eq("...with the scope code", stale.blockers[0].code, "admin_scope_denied");

console.log(fail ? `\n${fail} assertion(s) failed` : "");

/* ------------------------------------------------------- the round trip ---- */

if (!process.env.DATABASE_URL) {
  console.log("\nSKIP  the probe -> store -> cached-read round trip (no DATABASE_URL)");
  console.log(fail ? `${fail} assertion(s) failed` : "All assertions passed");
  process.exit(fail ? 1 : 0);
}

const db = await import("../src/db.js");
const capsMod = await import("../src/usermgmt/capabilities.js");
const wpClient = await import("../src/usermgmt/wpClient.js");

// Stand in for the site, so the scenarios are exact rather than approximate.
let PROBE = null;
const realProbe = wpClient.probeCapabilities;
capsMod.__setProbeForTest(async () => {
  if (PROBE instanceof Error) throw PROBE;
  return PROBE;
});

const site = { id: null, name: "Round Trip", url: "https://roundtrip.test", helper: { enabled: true, token: "x" } };

try {
  const created = await db.query(
    "insert into websites (name, url, helper_enabled) values ($1,$2,true) returning id",
    ["Round Trip " + Date.now(), site.url]
  );
  site.id = created.rows[0].id;
  // Enrolled with the defaults, exactly as a real site starts out.
  await db.query(
    "update websites set um_key_id='dek_test', um_secret_enc='v1.x.y.z', um_scopes=$2, um_enrolled_at=now() where id=$1",
    [site.id, ["users:read", "users:write", "content:reassign"]]
  );

  const storedScopes = async () =>
    (await db.query("select um_scopes from websites where id=$1", [site.id])).rows[0].um_scopes;

  console.log("\n--- 1. granting users:admin survives into the cached read ---");
  PROBE = {
    ok: true, plugin_version: "2.6.1", api_version: 1, enrolled: true,
    capabilities: ["users.read", "users.write"],
    scopes: ["users:read", "users:write", "users:admin", "content:reassign"],
  };
  const fresh = await capsMod.getCapabilities(site, { force: true });
  ok("the probe reports users:admin", fresh.scopes.includes("users:admin"), fresh.scopes.join(","));
  ok("...and it reaches the database", (await storedScopes()).includes("users:admin"));

  // The path that was broken: no force, so this is served from the cache.
  const cached = await capsMod.getCapabilities(site);
  ok("a CACHED read still reports users:admin", cached.scopes.includes("users:admin"), cached.scopes.join(","));
  eq("...and preflight lets an administering role through",
     predict({ staff: STAFF, site, capabilities: cached,
               roleCheck: checkRoleAvailability("administrator", SITE_ROLES),
               existing: { exists: false, user: null }, requestedRole: "administrator" }).action,
     ACTION.CREATE);

  console.log("\n--- 2. revoking it in the plugin blocks again (both directions) ---");
  PROBE = { ...PROBE, scopes: ["users:read", "users:write", "content:reassign"] };
  const revoked = await capsMod.getCapabilities(site, { force: true });
  ok("the probe no longer reports it", !revoked.scopes.includes("users:admin"), revoked.scopes.join(","));
  ok("...and the database drops it", !(await storedScopes()).includes("users:admin"));
  const afterRevoke = await capsMod.getCapabilities(site);
  eq("...and preflight blocks again",
     predict({ staff: STAFF, site, capabilities: afterRevoke,
               roleCheck: checkRoleAvailability("administrator", SITE_ROLES),
               existing: { exists: false, user: null }, requestedRole: "administrator" }).action,
     ACTION.BLOCKED);

  console.log("\n--- 3. a failed probe never changes what we believe ---");
  PROBE = { ...PROBE, scopes: ["users:read", "users:write", "users:admin", "content:reassign"] };
  await capsMod.getCapabilities(site, { force: true });
  ok("granted again", (await storedScopes()).includes("users:admin"));

  const before = await storedScopes();
  PROBE = new wpClient.WpError("timeout", "took too long", { retryable: true });
  const failed = await capsMod.getCapabilities(site, { force: true });
  eq("the site reads as unreachable", failed.readiness, READINESS.UNREACHABLE);
  eq("...and the stored scopes are untouched",
     JSON.stringify(await storedScopes()), JSON.stringify(before));
  ok("...so a slow site doesn't silently revoke a client's grant",
     (await storedScopes()).includes("users:admin"));

  console.log("\n--- an older plugin that reports no scopes leaves them alone ---");
  PROBE = { ok: true, plugin_version: "2.6.0", api_version: 1, enrolled: true, capabilities: ["users.read"] };
  await capsMod.getCapabilities(site, { force: true });
  ok("still granted", (await storedScopes()).includes("users:admin"));

  console.log("\n--- an empty array really does mean nothing granted ---");
  PROBE = { ok: true, plugin_version: "2.6.1", api_version: 1, enrolled: true, capabilities: [], scopes: [] };
  await capsMod.getCapabilities(site, { force: true });
  eq("stored scopes are emptied", (await storedScopes()).length, 0);
} finally {
  capsMod.__setProbeForTest(realProbe);
  if (site.id) await db.query("delete from websites where id=$1", [site.id]);
  await db.getPool().end();
}

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
