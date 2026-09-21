// Making the dashboard's picture of a site agree with the site.
//
// The bug: two accounts were deleted directly in WP Admin and the assignment
// rows still said "synced", so the Team Members panel reported "everyone is
// already here" while the site had one user. The rows were a belief nothing
// ever re-verified.
//
// Most of what is asserted here is what reconciliation must NOT do. It sees
// that someone removed an account and it must not put them back; it sees a role
// it did not set and it must not set it back; it fails to reach a site and it
// must not conclude the site is empty. It is allowed to change hub rows and
// write audit entries, and nothing else.

import crypto from "node:crypto";

import { decide, DRIFT, RECONCILE_ACTIONS } from "../src/usermgmt/reconcile.js";
import { normalizeWebsiteUrl } from "../src/db.js";

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const row = (over = {}) => ({
  id: "a1", staff_user_id: "s1", website_id: "w1",
  wp_role: "editor", wp_user_id: 21, wp_user_login: "ggardner",
  state: "synced", managed: true, drift: null, last_reconciled_at: null,
  email: "ggardner@digitalelementsgroup.com",
  ...over,
});
const here = (over = {}) => ({ present: true, roles: ["editor"], managed: true, wpUserId: 21, ...over });

/* ------------------------------------------------------------- transitions */

console.log("--- present, unchanged ---");
const same = decide(row(), here());
ok("nothing to record", same.noop === true);
eq("no state change", same.state, undefined);
eq("no drift", same.drift, undefined);
ok("but it is marked as looked at", same.lastReconciledAt === true);

console.log("\n--- present, role changed on the site ---");
const rolled = decide(row(), here({ roles: ["administrator"] }));
eq("drift is recorded", rolled.drift, DRIFT.ROLE_CHANGED);
eq("...and the site's role is adopted", rolled.wpRole, "administrator");
// The distinction this release turns on: `state` says how the last OPERATION
// went, and someone else changing a role is not a failed operation.
eq("state is left alone", rolled.state, undefined);
eq("it is audited", rolled.audit, RECONCILE_ACTIONS.ROLE_CHANGED);
eq("...naming both roles", `${rolled.detail.from}->${rolled.detail.to}`, "editor->administrator");

console.log("\n--- absent: the bug ---");
const gone = decide(row(), { present: false });
eq("the row becomes removed_externally", gone.state, "removed_externally");
eq("it is audited", gone.audit, RECONCILE_ACTIONS.REMOVED);
eq("...remembering what it was", gone.detail.was, "synced");
// The two things it must never do.
ok("no role is written", gone.wpRole === undefined);
ok("nothing asks for the account back", !("recreate" in gone));

const goneAgain = decide(row({ state: "removed_externally" }), { present: false });
ok("a second pass says nothing new", goneAgain.noop === true);
ok("...and writes no second audit row", goneAgain.audit === undefined);

console.log("\n--- we could not ask ---");
// The one that would be catastrophic to get wrong: a site down for an hour must
// not read as a site with nobody on it.
eq("a failed lookup is not an observation", decide(row(), null), null);
eq("...nor is undefined", decide(row(), undefined), null);

console.log("\n--- the account came back ---");
const back = decide(row({ state: "removed_externally" }), here());
eq("it returns to synced", back.state, "synced");
ok("...with the drift cleared", back.drift === null);
ok("...and is not audited as a change we made", back.audit === undefined);

const backDifferent = decide(row({ state: "removed_externally" }), here({ roles: ["author"] }));
eq("back with a different role is still present", backDifferent.state, "synced");
eq("...and the role difference is drift", backDifferent.drift, DRIFT.ROLE_CHANGED);

console.log("\n--- the site no longer marks it as ours ---");
const unmanaged = decide(row(), here({ managed: false }));
eq("recorded as drift", unmanaged.drift, DRIFT.UNMANAGED);
eq("...and audited", unmanaged.audit, RECONCILE_ACTIONS.UNMANAGED);
ok("the row is not marked removed", unmanaged.state === undefined);
ok("repeating it says nothing new", decide(row({ drift: DRIFT.UNMANAGED }), here({ managed: false })).noop === true);

console.log("\n--- drift that has gone away ---");
// Only drift the SITE resolved. Marking an account managed again is something
// the site did, so it clears.
const healed = decide(row({ drift: DRIFT.UNMANAGED }), here());
ok("the drift is cleared", healed.drift === null);
ok("...and it says so", healed.resolved === true);

// A recorded role change is NOT cleared by a matching observation. We adopted
// the site's role when we noticed, so every later look matches by construction
// - clearing on a match would erase "somebody changed this" on the next pass,
// before anyone saw it. It clears when the dashboard next sets the role, which
// is the moment the difference actually stops being true.
const stickyRole = decide(row({ wp_role: "author", drift: DRIFT.ROLE_CHANGED }), here({ roles: ["author"] }));
ok("a recorded role change survives a matching observation", stickyRole.noop === true);
ok("...and is not cleared", stickyRole.drift === undefined);

console.log("\n--- roles are compared case-insensitively ---");
ok("Editor is editor", decide(row(), here({ roles: ["Editor"] })).noop === true);
ok("ADMINISTRATOR is not editor", decide(row(), here({ roles: ["ADMINISTRATOR"] })).drift === DRIFT.ROLE_CHANGED);

console.log("\n--- a row with no role recorded ---");
// Nothing to compare against, so nothing is drift: adopting a role we never set
// would invent a change that didn't happen.
ok("no stored role means no role drift", decide(row({ wp_role: null }), here()).noop === true);

/* ----------------------------------------------------- one URL, one website */

console.log("\n--- what counts as the same URL ---");
const pairs = [
  ["https://digitalelementsgroup.com/", "http://digitalelementsgroup.com", "scheme and trailing slash"],
  ["https://WWW.Example.com/", "https://example.com", "www and case"],
  ["https://example.com/?utm=x", "https://example.com", "a query string"],
  ["https://example.com/#top", "https://example.com/", "a fragment"],
  ["  https://example.com/  ", "https://example.com", "surrounding whitespace"],
];
for (const [a, b, why] of pairs) {
  eq(`the same, ignoring ${why}`, normalizeWebsiteUrl(a), normalizeWebsiteUrl(b));
}
const different = [
  ["https://example.com", "https://example.org", "a different TLD"],
  ["https://example.com", "https://staging.example.com", "a subdomain"],
  ["https://example.com/blog", "https://example.com/news", "a different path"],
];
for (const [a, b, why] of different) {
  ok(`not the same: ${why}`, normalizeWebsiteUrl(a) !== normalizeWebsiteUrl(b));
}
eq("the production duplicate normalises to one thing",
   normalizeWebsiteUrl("https://digitalelementsgroup.com/"), "digitalelementsgroup.com");

/* ------------------------------------------------------- database-backed --- */

if (!process.env.DATABASE_URL) {
  console.log("\nSKIP  applying transitions, the audit rows, archiving and the unique index (no DATABASE_URL)");
  console.log(fail ? `${fail} assertion(s) failed` : "All assertions passed");
  process.exit(fail ? 1 : 0);
}

const db = await import("../src/db.js");
const { reconcileFromObserved, reconcileSite, driftSummary } = await import("../src/usermgmt/reconcile.js");

const tag = crypto.randomBytes(3).toString("hex");
const made = { staff: [], websites: [] };

try {
  console.log("\n--- SQL and JS agree on what the same URL means ---");
  // Asserted rather than assumed: the unique index uses the SQL function and
  // every insert path uses the JS one. If they ever disagree, the index stops
  // meaning what the code thinks it means.
  const samples = [
    "https://digitalelementsgroup.com/", "http://WWW.Example.com", "https://example.com/blog/",
    "https://example.com/?a=1#b", "  https://Example.COM/  ", "example.com",
  ];
  for (const u of samples) {
    const { rows } = await db.query("select de_normalize_url($1) as n", [u]);
    eq(`SQL matches JS for ${JSON.stringify(u)}`, rows[0].n, normalizeWebsiteUrl(u));
  }

  console.log("\n--- two live websites cannot share a URL ---");
  const first = await db.query(
    "insert into websites (name, url, helper_enabled) values ($1,$2,true) returning id",
    [`Dup A ${tag}`, `https://dup-${tag}.test/`]
  );
  made.websites.push(first.rows[0].id);

  let refused = false;
  try {
    const second = await db.query(
      "insert into websites (name, url, helper_enabled) values ($1,$2,true) returning id",
      [`Dup B ${tag}`, `http://www.dup-${tag}.test`]   // same site, written differently
    );
    made.websites.push(second.rows[0].id);
  } catch (err) {
    refused = /websites_normalized_url_uniq|duplicate key/i.test(err.message);
  }
  ok("a second row with the same normalised URL is refused", refused);

  // ...but an archived row may keep the URL it was created with, which is what
  // lets the existing duplicate be parked instead of edited or deleted.
  await db.query("update websites set archived = true, archived_at = now() where id = $1", [first.rows[0].id]);
  const revived = await db.query(
    "insert into websites (name, url, helper_enabled) values ($1,$2,true) returning id",
    [`Dup C ${tag}`, `https://dup-${tag}.test/`]
  );
  made.websites.push(revived.rows[0].id);
  ok("...unless the other one is archived", true);

  console.log("\n--- an archived site is excluded everywhere ---");
  const listed = await db.getWebsites();
  ok("it is not in the website list", !listed.some((s) => s.id === first.rows[0].id));
  ok("...while the live one is", listed.some((s) => s.id === revived.rows[0].id));

  const all = await db.getAllWebsitesIncludingArchived();
  ok("it is still there when asked for explicitly", all.some((s) => s.id === first.rows[0].id));

  // The one that matters most: an archived site must not be able to call the
  // site API, even though archiving deletes nothing and leaves its credential.
  const credentials = await import("../src/usermgmt/credentials.js");
  if (credentials.isConfigured()) {
    const keyId = `dek_arch_${tag}`;
    await credentials.storeCredential(first.rows[0].id, { keyId, secret: crypto.randomBytes(32).toString("base64url") });
    await db.query("update websites set archived = true where id = $1", [first.rows[0].id]);
    const resolved = await credentials.getSiteByKeyId(keyId);
    ok("an archived site's credential resolves to nothing", resolved === null);
  } else {
    console.log("SKIP  archived-site credential resolution (USER_MGMT_ENC_KEY not set)");
  }

  console.log("\n--- applying what a plugin observed ---");
  const site = await db.query(
    "insert into websites (name, url, helper_enabled, license_key) values ($1,$2,true,$3) returning id, name, url",
    [`Reconcile ${tag}`, `https://reconcile-${tag}.test`, `DEG-RECON-${tag.toUpperCase()}-AAAA-BBBB`]
  );
  made.websites.push(site.rows[0].id);
  const siteRow = site.rows[0];

  const mkStaff = async (email) => {
    const { rows } = await db.query(
      "insert into staff_users (email) values ($1) returning id", [email]);
    made.staff.push(rows[0].id);
    return rows[0].id;
  };
  const goneId = await mkStaff(`recon-gone-${tag}@digitalelementsgroup.com`);
  const rolledId = await mkStaff(`recon-rolled-${tag}@digitalelementsgroup.com`);
  const fineId = await mkStaff(`recon-fine-${tag}@digitalelementsgroup.com`);

  for (const [id, role, wpid] of [[goneId, "administrator", 21], [rolledId, "editor", 22], [fineId, "editor", 23]]) {
    await db.query(
      `insert into website_user_assignments (staff_user_id, website_id, wp_role, wp_user_id, state, managed)
       values ($1,$2,$3,$4,'synced',true)`,
      [id, siteRow.id, role, wpid]
    );
  }

  const observed = [
    { email: `recon-gone-${tag}@digitalelementsgroup.com`, present: false },
    { email: `recon-rolled-${tag}@digitalelementsgroup.com`, present: true, roles: ["author"], managed: true, wpUserId: 22 },
    { email: `recon-fine-${tag}@digitalelementsgroup.com`, present: true, roles: ["editor"], managed: true, wpUserId: 23 },
  ];

  const summary = await reconcileFromObserved(siteRow, observed, { actorEmail: "jeff@digitalelementsgroup.com" });
  eq("all three were checked", summary.checked, 3);
  eq("one was removed outside the dashboard", summary.removedExternally, 1);
  eq("one had its role changed", summary.roleChanged, 1);
  eq("one was already right", summary.unchanged, 1);

  const after = async (staffId) => {
    const { rows } = await db.query(
      "select state, wp_role, drift, last_reconciled_at from website_user_assignments where staff_user_id=$1 and website_id=$2",
      [staffId, siteRow.id]);
    return rows[0];
  };

  const goneRow = await after(goneId);
  eq("the deleted account's row says removed_externally", goneRow.state, "removed_externally");
  ok("...and the row still exists", goneRow !== undefined);
  ok("...and was stamped as checked", goneRow.last_reconciled_at !== null);

  const rolledRow = await after(rolledId);
  eq("the changed role is adopted", rolledRow.wp_role, "author");
  eq("...recorded as drift", rolledRow.drift, DRIFT.ROLE_CHANGED);
  eq("...with the state left as it was", rolledRow.state, "synced");

  console.log("\n--- the audit log explains it in words ---");
  const { rows: auditRows } = await db.query(
    "select action, target_email, after from audit_log where website_id=$1 order by at", [siteRow.id]);
  eq("two rows, one per change", auditRows.length, 2);
  const removedAudit = auditRows.find((r) => r.action === RECONCILE_ACTIONS.REMOVED);
  ok("the removal is audited", !!removedAudit);
  ok("...naming the site", removedAudit.after?.site === siteRow.name);
  ok("...and the person", removedAudit.target_email === `recon-gone-${tag}@digitalelementsgroup.com`);
  ok("...and saying nothing was recreated",
     /nothing was recreated/i.test(removedAudit.after?.explanation || ""), removedAudit.after?.explanation);

  console.log("\n--- running it again changes nothing ---");
  const second = await reconcileFromObserved(siteRow, observed, {});
  eq("nothing moves", second.removedExternally + second.roleChanged, 0);
  eq("everything reads as unchanged", second.unchanged, 3);
  const { rows: auditAgain } = await db.query(
    "select count(*)::int n from audit_log where website_id=$1", [siteRow.id]);
  eq("and no new audit rows", auditAgain[0].n, 2);

  console.log("\n--- drift is surfaced, not just corrected ---");
  const drift = await driftSummary();
  const d = drift.get(siteRow.id);
  eq("the removal is counted", d.removedExternally, 1);
  eq("the role change is counted", d.roleChanged, 1);
  ok("with a time it was last checked", d.lastReconciledAt !== null);

  console.log("\n--- reconciliation never writes to WordPress ---");
  // The guarantee the whole design rests on: this runs unattended, across every
  // site, on a schedule. Anything it could do to a client site it could do to
  // forty of them at 3am.
  // Asserted two ways, because one alone would be weak.
  //
  // First behaviourally: drive a full pass against a site that cannot be
  // reached and confirm nothing moves. An unreachable site is the case most
  // likely to tempt an implementation into concluding "nobody is there".
  const unreachable = { id: siteRow.id, name: siteRow.name, url: "https://127.0.0.1:1/", helper: {}, license: {} };
  const before = await after(fineId);
  const failedPass = await reconcileSite(unreachable, {});
  eq("every lookup is skipped", failedPass.checked, 0);
  eq("nothing is marked removed", failedPass.removedExternally, 0);
  const unchangedRow = await after(fineId);
  eq("the row is untouched", unchangedRow.state, before.state);
  eq("...including its role", unchangedRow.wp_role, before.wp_role);

  // Then structurally: the module cannot write to a site, because it contains
  // no call that could. A behavioural test only covers the paths it happens to
  // walk; this covers the ones nobody thought to walk.
  const src = (await import("node:fs")).readFileSync(new URL("../src/usermgmt/reconcile.js", import.meta.url), "utf8");
  const writeCalls = src.match(/method:\s*"(POST|PATCH|PUT|DELETE)"/g) || [];
  eq("no write verb appears anywhere in reconcile.js", writeCalls.length, 0);
  ok("the only site route it names is the lookup",
     (src.match(/route:\s*"([^"]+)"/g) || []).every((r) => r.includes("/users/lookup")),
     (src.match(/route:\s*"([^"]+)"/g) || []).join(", "));
} finally {
  for (const id of made.staff) {
    await db.query("delete from audit_log where entity_id = $1", [id]);
    await db.query("delete from staff_users where id = $1", [id]);
  }
  for (const id of made.websites) {
    await db.query("delete from audit_log where website_id = $1", [id]);
    await db.query("delete from websites where id = $1", [id]);
  }
}

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
