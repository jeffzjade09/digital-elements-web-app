// Tests for the preflight decision table and per-site role classification.
//
// predict() is deliberately pure, so the whole matrix of outcomes an
// administrator can see on the review screen is exercised here without a
// database or a WordPress site. The cases that matter most are the ones that
// stop something happening: a client's own account, a role a site doesn't have,
// and a site we couldn't actually ask.

import { predict, resolveRequestedRole, ACTION } from "../src/usermgmt/preflight.js";
import { checkRoleAvailability, isAdminLikeRole, CORE_ROLES } from "../src/usermgmt/roles.js";
import { READINESS } from "../src/usermgmt/capabilities.js";

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/* ------------------------------------------------------------- fixtures --- */

const SITE = { id: "site-1", name: "Blue Star Recovery", url: "https://bluestarrecovery.com" };
const STAFF = {
  id: "staff-1", label: "Jason", email: "jason@digitalelementsgroup.com",
  status: "active", defaultWpRole: null, teamDefaultWpRole: "editor", teamName: "SEO",
};

// Mirrors stock WordPress, including the detail that trips people up: EDITOR
// holds unfiltered_html, so it is adminLike but NOT siteAdmin.
const SITE_ROLES = [
  { slug: "administrator", name: "Administrator", adminLike: true, siteAdmin: true },
  { slug: "editor", name: "Editor", adminLike: true, siteAdmin: false },
  { slug: "author", name: "Author", adminLike: false, siteAdmin: false },
  { slug: "subscriber", name: "Subscriber", adminLike: false, siteAdmin: false },
  { slug: "shop_manager", name: "Shop manager", adminLike: false, siteAdmin: false },
];

const READY = {
  readiness: READINESS.READY, message: "Ready", pluginVersion: "2.6.0",
  requiredApiVersion: 1, capabilities: ["users.read"],
};
const OUTDATED = {
  readiness: READINESS.PLUGIN_UPDATE_REQUIRED,
  message: "Plugin update required (has 2.5.0).", pluginVersion: "2.5.0", requiredApiVersion: 1,
};

const existingUser = (over = {}) => ({
  exists: true, matched: "email",
  user: { id: 7, login: "jason", email: "jason@digitalelementsgroup.com", display_name: "Jason", roles: ["editor"], managed: true, ...over },
});
const notFound = { exists: false, matched: null, user: null };

const run = (over = {}) => predict({
  staff: STAFF, site: SITE, capabilities: READY,
  roleCheck: checkRoleAvailability("editor", SITE_ROLES),
  existing: notFound, requestedRole: "editor",
  ...over,
});

/* -------------------------------------------------------- role resolution - */

console.log("--- requested role resolution ---");
eq("a per-site override wins",
   resolveRequestedRole(STAFF, "site-1", { "site-1": "author" }).role, "author");
eq("...and says so", resolveRequestedRole(STAFF, "site-1", { "site-1": "author" }).source, "override");
eq("the person's own default is next",
   resolveRequestedRole({ ...STAFF, defaultWpRole: "contributor" }, "site-1").role, "contributor");
eq("then the team's default", resolveRequestedRole(STAFF, "site-1").role, "editor");
eq("...credited to the team", resolveRequestedRole(STAFF, "site-1").source, "team");
eq("subscriber is the floor",
   resolveRequestedRole({ ...STAFF, teamDefaultWpRole: null }, "site-1").role, "subscriber");
eq("an override for a different site is ignored",
   resolveRequestedRole(STAFF, "site-1", { "site-2": "author" }).role, "editor");
// Administrator can only ever arrive as an explicit override — never inherited.
eq("administrator is reachable only by override",
   resolveRequestedRole(STAFF, "site-1", { "site-1": "administrator" }).source, "override");

/* ------------------------------------------------- role availability ------ */

console.log("\n--- role availability on a specific site ---");
const avail = checkRoleAvailability("editor", SITE_ROLES);
ok("a role the site has is available", avail.available && avail.known);
const missing = checkRoleAvailability("contributor", SITE_ROLES);
ok("a role the site lacks is unavailable", missing.known && !missing.available);
ok("...and alternatives are offered", missing.alternatives.length > 0);
ok("...never a site-administering alternative",
   missing.alternatives.every((a) => a.slug !== "administrator"),
   missing.alternatives.map((a) => a.slug).join(","));
// Editor is adminLike (unfiltered_html) but not siteAdmin, so it stays
// offerable — excluding it would leave almost nothing to suggest.
ok("...but Editor is still offered", missing.alternatives.some((a) => a.slug === "editor"));
ok("a custom plugin role is honoured", checkRoleAvailability("shop_manager", SITE_ROLES).available);

// "Never asked" and "asked, not there" must not collapse into one answer.
const unknown = checkRoleAvailability("editor", []);
ok("with no cached roles, availability is unknown", unknown.known === false);
ok("...and not reported as available", unknown.available === false);

console.log("\n--- the two elevation tiers ---");
// The core vocabulary only knows administrator is elevated; a site's real role
// map is what distinguishes the tiers.
ok("administrator is admin-like in the core vocabulary", isAdminLikeRole("administrator"));
for (const r of ["editor", "author", "contributor", "subscriber"]) {
  ok(`${r} is not, in the core vocabulary`, isAdminLikeRole(r) === false);
}
eq("core vocabulary is unchanged", CORE_ROLES.length, 5);

const editorCheck = checkRoleAvailability("editor", SITE_ROLES);
ok("on a real site, Editor is admin-like (it holds unfiltered_html)", editorCheck.adminLike === true);
ok("...but is NOT a site administrator", editorCheck.siteAdmin === false);
const adminCheck = checkRoleAvailability("administrator", SITE_ROLES);
ok("Administrator is both", adminCheck.adminLike === true && adminCheck.siteAdmin === true);
ok("the site's own flags are trusted over the core list",
   checkRoleAvailability("shop_manager", [{ slug: "shop_manager", name: "Shop manager", adminLike: true, siteAdmin: true }]).siteAdmin === true);
// Never asked: err toward requiring the confirmation rather than skipping it.
const unknownRole = checkRoleAvailability("administrator", []);
ok("an unknown role still reports the elevation it's known to have", unknownRole.siteAdmin === true);

/* ---------------------------------------------------------- predictions --- */

console.log("\n--- predicted actions ---");
eq("no account anywhere -> create", run().action, ACTION.CREATE);
eq("managed account, different role -> update",
   run({ existing: existingUser({ roles: ["author"] }) }).action, ACTION.UPDATE);
eq("managed account, same role -> skip",
   run({ existing: existingUser({ roles: ["editor"] }) }).action, ACTION.SKIP);
eq("managed account with extra roles is not a skip",
   run({ existing: existingUser({ roles: ["editor", "shop_manager"] }) }).action, ACTION.UPDATE);

console.log("\n--- a client's own account is never adopted ---");
const unmanaged = run({ existing: existingUser({ managed: false }) });
eq("existing but unmanaged -> link_required", unmanaged.action, ACTION.LINK_REQUIRED);
ok("...and explains why", /isn't managed by us/.test(unmanaged.note || ""));
// Even when the role already matches, an unmanaged account must not be a
// silent skip — the administrator has to decide to link it.
eq("...even when the role already matches",
   run({ existing: existingUser({ managed: false, roles: ["editor"] }) }).action, ACTION.LINK_REQUIRED);

console.log("\n--- blockers ---");
const outdated = run({ capabilities: OUTDATED });
eq("an outdated plugin blocks", outdated.action, ACTION.BLOCKED);
eq("...with the readiness code", outdated.blockers[0].code, READINESS.PLUGIN_UPDATE_REQUIRED);
ok("...naming the version it has", /2\.5\.0/.test(outdated.blockers[0].message));

const unenrolled = run({ capabilities: { readiness: READINESS.NEEDS_ENROLLMENT, message: "Needs enrolling — generate a code." } });
eq("an unenrolled site blocks", unenrolled.action, ACTION.BLOCKED);

const badRole = run({ roleCheck: checkRoleAvailability("contributor", SITE_ROLES), requestedRole: "contributor" });
eq("a role the site lacks blocks", badRole.action, ACTION.BLOCKED);
eq("...with a code the UI can group on", badRole.blockers[0].code, "role_not_available");
ok("...and carries alternatives for the picker", badRole.blockers[0].alternatives.length > 0);

const rolesUnknown = run({ roleCheck: checkRoleAvailability("editor", []) });
eq("roles we couldn't read block", rolesUnknown.action, ACTION.BLOCKED);
eq("...distinctly from 'not available'", rolesUnknown.blockers[0].code, "roles_unknown");

const disabled = run({ staff: { ...STAFF, status: "disabled" } });
eq("a disabled person blocks", disabled.action, ACTION.BLOCKED);
eq("...with its own code", disabled.blockers[0].code, "user_disabled");

// A blocked pair must stay blocked regardless of what else is true — in
// particular it must never be reported as a create.
const manyProblems = predict({
  staff: { ...STAFF, status: "disabled" }, site: SITE, capabilities: OUTDATED,
  roleCheck: checkRoleAvailability("contributor", SITE_ROLES),
  existing: notFound, requestedRole: "contributor",
});
eq("several problems still just block", manyProblems.action, ACTION.BLOCKED);
eq("...listing every one", manyProblems.blockers.length, 3);

console.log("\n--- administrator needs confirmation, and is never silently applied ---");
const adminRole = run({
  roleCheck: checkRoleAvailability("administrator", SITE_ROLES),
  requestedRole: "administrator",
});
ok("assigning administrator is flagged", adminRole.needsAdminConfirmation === true);
eq("...but is still a normal create", adminRole.action, ACTION.CREATE);

// THE CASE THAT MAKES THE TIERS NECESSARY. Editor holds unfiltered_html on
// stock WordPress and is every team's default role. If the confirmation keyed
// on adminLike, it would fire on the single most common assignment there is —
// and a confirmation that fires on the common case is one people click through.
const editorRun = run();
ok("the ordinary Editor assignment does NOT demand a confirmation",
   editorRun.needsAdminConfirmation === false);
ok("...but its content risk is still surfaced", editorRun.contentRisk === true);

const authorRun = run({ roleCheck: checkRoleAvailability("author", SITE_ROLES), requestedRole: "author" });
ok("a plain role raises neither", authorRun.needsAdminConfirmation === false && authorRun.contentRisk === false);
ok("administrator is not merely a content risk", adminRole.contentRisk === false);

// A site-defined role that can administer must be flagged too.
ok("a custom site-administering role is flagged",
   run({ roleCheck: checkRoleAvailability("shop_manager", [{ slug: "shop_manager", name: "Shop manager", adminLike: true, siteAdmin: true }]), requestedRole: "shop_manager" })
     .needsAdminConfirmation === true);
// Blocked pairs still report the flag, so the confirmation UI is consistent
// once the blocker is cleared.
ok("a blocked admin assignment still reports the flag",
   run({ capabilities: OUTDATED, roleCheck: checkRoleAvailability("administrator", SITE_ROLES), requestedRole: "administrator" })
     .needsAdminConfirmation === true);

console.log("\n--- a failed lookup never predicts 'create' ---");
// If we couldn't ask whether the account exists, predicting create would risk a
// duplicate. inspectSite() downgrades the site's readiness on lookup failure,
// which lands here as a blocker.
const lookupFailed = run({
  capabilities: { readiness: READINESS.UNREACHABLE, message: "Couldn't check existing accounts on Blue Star Recovery: timeout" },
  existing: { exists: false, user: null, error: "timeout" },
});
eq("it blocks instead", lookupFailed.action, ACTION.BLOCKED);
ok("...saying it couldn't check", /Couldn't check existing accounts/.test(lookupFailed.blockers[0].message));

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
