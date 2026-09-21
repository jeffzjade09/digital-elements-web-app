// Tests for the policy layer of centralized WordPress user management: who may
// use it, which roles may be stored, and which addresses may be added.
//
// Deliberately free of database access — every function under test is pure, so
// this suite runs on a bare checkout exactly like the rest of tests/.

import { permsFor, requireAuth } from "../src/auth.js";
import { _setGrantsForTest, isWpUserManager } from "../src/usermgmt/grants.js";
import {
  CORE_ROLES, isCoreRole, isAdminLikeRole, normalizeRoleSlug, assertDefaultRole, roleName,
} from "../src/usermgmt/roles.js";
import {
  AGENCY_DOMAIN, assertEmailAllowed, wpUsernameFor, effectiveRole, displayLabel, normalizeEmail,
} from "../src/usermgmt/staffUsers.js";
import { redact } from "../src/usermgmt/audit.js";

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

console.log("--- manageWpUsers is its own permission ---");
_setGrantsForTest([]);
ok("admin role holds it", permsFor("admin").manageWpUsers === true);
ok("webdev role does not", permsFor("webdev").manageWpUsers === false);
ok("seo role does not", permsFor("seo").manageWpUsers === false);
ok("unknown role falls back to the least-privileged set", permsFor("nonsense").manageWpUsers === false);
ok("it is distinct from manageUsers", permsFor("webdev").manageUsers === false && permsFor("admin").manageUsers === true);

console.log("\n--- the explicit grant list ---");
_setGrantsForTest(["jeff@digitalelementsgroup.com", "Ryan@DigitalElementsGroup.com"]);
ok("granted address is recognised", isWpUserManager("jeff@digitalelementsgroup.com"));
ok("matching is case-insensitive", isWpUserManager("RYAN@digitalelementsgroup.com"));
ok("ungranted address is not", isWpUserManager("stranger@example.com") === false);
ok("grant lifts a non-admin role", permsFor("webdev", "jeff@digitalelementsgroup.com").manageWpUsers === true);
ok("grant does not lift anything else", permsFor("webdev", "jeff@digitalelementsgroup.com").deleteWebsite === false);
ok("an ungranted user keeps role-only perms", permsFor("seo", "stranger@example.com").manageWpUsers === false);
ok("omitting the email yields role-only perms", permsFor("webdev").manageWpUsers === false);

console.log("\n--- an empty grant list never widens access ---");
_setGrantsForTest([]);
ok("nobody is granted when the list is empty", isWpUserManager("jeff@digitalelementsgroup.com") === false);
ok("admins still hold it by role", permsFor("admin", "someone@digitalelementsgroup.com").manageWpUsers === true);

console.log("\n--- the seeded grant list, per person ---");
// Exactly what migration 002 seeds.
_setGrantsForTest([
  "ryan@digitalelementsgroup.com",
  "danny@digitalelementsgroup.com",
  "jeff@digitalelementsgroup.com",
]);
for (const email of ["ryan@digitalelementsgroup.com", "danny@digitalelementsgroup.com", "jeff@digitalelementsgroup.com"]) {
  ok(`${email} holds manageWpUsers as admin`, permsFor("admin", email).manageWpUsers === true);
}
// jeff is an admin today, but the explicit grant is what guarantees access if
// that ever changes — which is the point of listing him.
ok("jeff keeps the grant even without the admin role", permsFor("webdev", "jeff@digitalelementsgroup.com").manageWpUsers === true);
ok("...without gaining anything else", permsFor("webdev", "jeff@digitalelementsgroup.com").manageUsers === false);
for (const email of ["jason@digitalelementsgroup.com", "ggardner@digitalelementsgroup.com", "regan@digitalelementsgroup.com"]) {
  ok(`${email} does not hold it`, permsFor("seo", email).manageWpUsers === false);
}

console.log("\n--- an expired session on an API route answers with JSON, not a redirect ---");
// requireAuth is mounted both directly on routes and via app.use() on the
// /api/wpusers router, where req.path is relative to the mount point. Both must
// produce a 401 the dashboard's fetch wrappers can act on.
function fakeRes() {
  return {
    statusCode: null, body: null, redirected: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    redirect(to) { this.redirected = to; return this; },
  };
}
const signedOut = { isAuthenticated: () => false };

let res = fakeRes();
requireAuth({ ...signedOut, path: "/api/users", originalUrl: "/api/users" }, res, () => {});
eq("top-level API route still returns 401", res.statusCode, 401);

res = fakeRes();
requireAuth({ ...signedOut, path: "/teams", originalUrl: "/api/wpusers/teams" }, res, () => {});
eq("mounted API route returns 401, not a redirect", res.statusCode, 401);
ok("...and does not redirect", res.redirected === null);

res = fakeRes();
requireAuth({ ...signedOut, path: "/api/users", originalUrl: "/api/users?role=admin" }, res, () => {});
eq("a query string doesn't break the check", res.statusCode, 401);

res = fakeRes();
requireAuth({ ...signedOut, path: "/", originalUrl: "/" }, res, () => {});
eq("a page request still redirects to the login screen", res.redirected, "/login");
ok("...with no status set", res.statusCode === null);

let reached = false;
requireAuth({ isAuthenticated: () => true, path: "/api/users", originalUrl: "/api/users" }, fakeRes(), () => { reached = true; });
ok("a signed-in user passes through", reached);

console.log("\n--- WordPress role vocabulary ---");
eq("five core roles", CORE_ROLES.length, 5);
ok("administrator is admin-like", isAdminLikeRole("administrator"));
ok("editor is not", isAdminLikeRole("editor") === false);
ok("slugs normalize", normalizeRoleSlug("  Editor ") === "editor");
ok("junk is stripped from slugs", normalizeRoleSlug("edi<tor>") === "editor");
ok("unknown slug is not a core role", isCoreRole("shop_manager") === false);
eq("role names are readable", roleName("contributor"), "Contributor");

console.log("\n--- default roles ---");
eq("editor is accepted", assertDefaultRole("editor"), "editor");
eq("mixed case is accepted", assertDefaultRole("Subscriber"), "subscriber");

// POLICY: Administrator may be a team or per-user default. This agency
// administers the sites it builds, so it is the ordinary working role. What
// protects a client is not its absence from this list — it is the per-site
// users:admin scope (which the dashboard cannot grant) and the confirmation
// before a job runs. Both are asserted elsewhere in this suite and in
// usermgmt-preflight.
eq("administrator is accepted as a default", assertDefaultRole("administrator"), "administrator");

throws("an unrecognised role is still refused", () => assertDefaultRole("shop_manager"), /isn't a WordPress role we've seen/i);
throws("an empty role is still refused", () => assertDefaultRole(""), /isn't a WordPress role we've seen/i);

// A role discovered on a connected site can be stored as a default; one we
// have never seen anywhere cannot, so a typo still can't reach the database.
const discovered = new Set(["administrator", "editor", "author", "contributor", "subscriber", "seo_editor", "seo_manager"]);
eq("a discovered custom role is accepted", assertDefaultRole("seo_editor", discovered), "seo_editor");
eq("...and another", assertDefaultRole("seo_manager", discovered), "seo_manager");
throws("a role nobody has is still refused", () => assertDefaultRole("wizard", discovered), /isn't a WordPress role we've seen/i);
eq("core roles remain valid alongside discovered ones", assertDefaultRole("editor", discovered), "editor");

console.log("\n--- agency-domain restriction ---");
eq("agency address passes", assertEmailAllowed("Jeff@DigitalElementsGroup.com"), "jeff@digitalelementsgroup.com");
throws("outside address is refused by default", () => assertEmailAllowed("someone@gmail.com"), /outside @digitalelementsgroup\.com/);
eq("outside address passes with an explicit override",
   assertEmailAllowed("someone@gmail.com", { overrideDomain: true }), "someone@gmail.com");
throws("a malformed address is refused even with the override",
       () => assertEmailAllowed("not-an-email", { overrideDomain: true }), /valid email/i);
try {
  assertEmailAllowed("someone@gmail.com");
} catch (err) {
  eq("the refusal carries a code the UI can act on", err.code, "domain_restricted");
}
// A lookalike domain must not slip through on a suffix match.
throws("a lookalike domain is refused", () => assertEmailAllowed("me@notdigitalelementsgroup.com"), /outside/);
eq("the agency domain constant is what we expect", AGENCY_DOMAIN, "digitalelementsgroup.com");

console.log("\n--- WordPress usernames ---");
eq("local part is used", wpUsernameFor("npappas@digitalelementsgroup.com"), "npappas");
eq("case is normalized", wpUsernameFor("Jeff@digitalelementsgroup.com"), "jeff");
eq("dots and dashes survive", wpUsernameFor("first.last-x@a.com"), "first.last-x");
eq("illegal characters are stripped", wpUsernameFor("we+ird!name@a.com"), "weirdname");
eq("leading/trailing punctuation is trimmed", wpUsernameFor("._bob_.@a.com"), "bob");
eq("an empty local part still yields something usable", wpUsernameFor("@a.com"), "user");
ok("length is bounded", wpUsernameFor("x".repeat(80) + "@a.com").length === 50);

console.log("\n--- effective role resolution ---");
eq("own default wins", effectiveRole({ default_wp_role: "author", team_default_wp_role: "editor" }), "author");
eq("team default is inherited", effectiveRole({ default_wp_role: null, team_default_wp_role: "editor" }), "editor");
eq("no team, no default -> subscriber", effectiveRole({ default_wp_role: null, team_default_wp_role: null }), "subscriber");

console.log("\n--- display labels ---");
eq("display name wins", displayLabel({ display_name: "Jay", first_name: "Jason", email: "j@a.com" }), "Jay");
eq("first + last is next", displayLabel({ first_name: "Jason", last_name: "Doe", email: "j@a.com" }), "Jason Doe");
eq("email local part is the honest fallback", displayLabel({ email: "npappas@digitalelementsgroup.com" }), "npappas");
eq("emails normalize", normalizeEmail("  JEFF@A.com "), "jeff@a.com");

console.log("\n--- the audit log never stores secrets ---");
const red = redact({
  email: "a@b.com",
  secret: "super-secret",
  credential: { um_secret: "nested", key_id: "dek_123" },
  list: [{ password: "hunter2", role: "editor" }],
});
eq("plain fields survive", red.email, "a@b.com");
eq("a top-level secret is removed", red.secret, "[redacted]");
eq("a nested secret is removed", red.credential.um_secret, "[redacted]");
eq("a non-secret sibling survives", red.credential.key_id, "dek_123");
eq("secrets inside arrays are removed", red.list[0].password, "[redacted]");
eq("non-secrets inside arrays survive", red.list[0].role, "editor");
ok("null is handled", redact(null) === null);
ok("deep recursion is bounded", typeof redact({ a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }) === "object");

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
