// Tests for the policy layer of centralized WordPress user management: who may
// use it, which roles may be stored, and which addresses may be added.
//
// Deliberately free of database access — every function under test is pure, so
// this suite runs on a bare checkout exactly like the rest of tests/.

import { permsFor } from "../src/auth.js";
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

console.log("\n--- WordPress role vocabulary ---");
eq("five core roles", CORE_ROLES.length, 5);
ok("administrator is admin-like", isAdminLikeRole("administrator"));
ok("editor is not", isAdminLikeRole("editor") === false);
ok("slugs normalize", normalizeRoleSlug("  Editor ") === "editor");
ok("junk is stripped from slugs", normalizeRoleSlug("edi<tor>") === "editor");
ok("unknown slug is not a core role", isCoreRole("shop_manager") === false);
eq("role names are readable", roleName("contributor"), "Contributor");

console.log("\n--- default roles are least-privilege by construction ---");
eq("editor is accepted", assertDefaultRole("editor"), "editor");
eq("mixed case is accepted", assertDefaultRole("Subscriber"), "subscriber");
throws("administrator is refused as a default", () => assertDefaultRole("administrator"), /per website/i);
throws("an unknown role is refused", () => assertDefaultRole("shop_manager"), /not a valid WordPress role/i);
throws("an empty role is refused", () => assertDefaultRole(""), /not a valid WordPress role/i);

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
