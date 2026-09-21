// Who, on a connected website, may drive the Team Members panel.
//
// The panel's local gate can only ever be a mistake-guard: a WordPress
// account's email address is set by whoever administers that site. So the rule
// that actually means something — you are on the roster, active, and in Web
// Development or Admin — lives here, on the hub, and is asserted here.
//
// The pure half (the exact-domain matcher, the team constant) always runs. The
// half that needs a database — resolving a real staff row, the team refusal,
// and auto-link idempotency — skips cleanly without DATABASE_URL.

import crypto from "node:crypto";

import {
  isAgencyEmail, resolveActingStaff, actorRefusalMessage,
  PANEL_TEAM_SLUGS, ACTOR_REFUSALS,
} from "../src/usermgmt/siteActor.js";

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/* ------------------------------------------------- the exact-domain rule --- */

console.log("--- an address on exactly the agency domain ---");

for (const [email, why] of [
  ["jeff@digitalelementsgroup.com", "the plain form"],
  ["JEFF@DigitalElementsGroup.COM", "any case"],
  ["  jeff@digitalelementsgroup.com  ", "surrounding whitespace"],
  ["jeff@digitalelementsgroup.com.", "a trailing dot, which is the same host"],
  ["first.last+tag@digitalelementsgroup.com", "a local part with dots and a tag"],
]) ok(`accepts ${why}`, isAgencyEmail(email), email);

// Each of these is a way in if the rule is a substring test rather than a
// comparison of the whole domain.
for (const [email, why] of [
  ["jeff@wp.digitalelementsgroup.com", "a subdomain is not the domain"],
  ["jeff@mail.digitalelementsgroup.com", "another subdomain"],
  ["jeff@digitalelementsgroup.co", "a look-alike TLD"],
  ["jeff@digital-elementsgroup.com", "a look-alike with a hyphen"],
  ["jeff@digitalelementsgroupp.com", "a look-alike with a doubled letter"],
  ["jeff@digitalelementsgroup.com.evil.com", "a suffix attack"],
  ["jeff@evildigitalelementsgroup.com", "a prefix attack"],
  ["a@b.com@digitalelementsgroup.com", "two @, which resolves ambiguously"],
  ["jeff@", "no domain"],
  ["@digitalelementsgroup.com", "no local part"],
  ["jeffdigitalelementsgroup.com", "no @ at all"],
  ["jeff@gmail.com", "a personal address"],
  ["", "an empty string"],
  ["   ", "whitespace only"],
  [null, "null"],
  [undefined, "undefined"],
]) ok(`rejects ${why}`, isAgencyEmail(email) === false, JSON.stringify(email));

/* ------------------------------------------------------------ the teams --- */

console.log("\n--- the allowed teams are pinned in one place ---");
eq("exactly two teams may use the panel", PANEL_TEAM_SLUGS.length, 2);
ok("Web Development", PANEL_TEAM_SLUGS.includes("web-development"));
ok("Admin", PANEL_TEAM_SLUGS.includes("admin"));
// Matching on slug rather than name is what stops a rename from silently
// widening or closing the gate.
ok("SEO is not one of them", !PANEL_TEAM_SLUGS.includes("seo"));
ok("Content is not one of them", !PANEL_TEAM_SLUGS.includes("content"));
ok("PPC is not one of them", !PANEL_TEAM_SLUGS.includes("ppc"));
ok("the list cannot be edited at runtime", Object.isFrozen(PANEL_TEAM_SLUGS));

let widened = false;
try { PANEL_TEAM_SLUGS.push("content"); widened = PANEL_TEAM_SLUGS.includes("content"); } catch { /* frozen */ }
ok("...so nothing can append to it", widened === false);

console.log("\n--- every refusal says something the person can act on ---");
const messages = Object.values(ACTOR_REFUSALS).map((r) => actorRefusalMessage(r));
eq("one message per refusal", new Set(messages).size, Object.values(ACTOR_REFUSALS).length);
ok("a missing actor names the version to update to",
   actorRefusalMessage(ACTOR_REFUSALS.MISSING).includes("2.7.1"),
   actorRefusalMessage(ACTOR_REFUSALS.MISSING));
ok("a disallowed team names the teams that may",
   actorRefusalMessage(ACTOR_REFUSALS.TEAM_NOT_ALLOWED).includes("Web Development"));
ok("not being on the roster says where to fix it",
   actorRefusalMessage(ACTOR_REFUSALS.NOT_ON_ROSTER).toLowerCase().includes("roster"));
// None of them should hint at a credential problem: that is a different fault
// with a different fix, and conflating them is what made the first rollout
// confusing.
ok("none blames the credential",
   !messages.some((m) => /credential|signature|key/i.test(m)), messages.join(" | "));

/* ------------------------------------------------------- database-backed --- */

if (!process.env.DATABASE_URL) {
  console.log("\nSKIP  roster resolution, the team gate and auto-link idempotency (no DATABASE_URL)");
  console.log(fail ? `${fail} assertion(s) failed` : "All assertions passed");
  process.exit(fail ? 1 : 0);
}

const db = await import("../src/db.js");
const { autoLinkActingUser, AUTO_LINK_ACTION } = await import("../src/usermgmt/autoLink.js");

const tag = crypto.randomBytes(3).toString("hex");
const made = { staff: [], websites: [] };

async function teamIdBySlug(slug) {
  const { rows } = await db.query("select id from teams where slug = $1", [slug]);
  return rows[0]?.id || null;
}
async function addStaff(email, slug, status = "active") {
  const { rows } = await db.query(
    "insert into staff_users (email, team_id, status) values ($1,$2,$3) returning id",
    [email, slug ? await teamIdBySlug(slug) : null, status]
  );
  made.staff.push(rows[0].id);
  return rows[0].id;
}

try {
  console.log("\n--- resolving the acting person against the roster ---");

  const webDevEmail = `autolink-webdev-${tag}@digitalelementsgroup.com`;
  const contentEmail = `autolink-content-${tag}@digitalelementsgroup.com`;
  const adminEmail = `autolink-admin-${tag}@digitalelementsgroup.com`;
  const goneEmail = `autolink-gone-${tag}@digitalelementsgroup.com`;
  const strangerEmail = `autolink-stranger-${tag}@digitalelementsgroup.com`;

  const webDevId = await addStaff(webDevEmail, "web-development");
  await addStaff(contentEmail, "content");
  await addStaff(adminEmail, "admin");
  await addStaff(goneEmail, "web-development", "disabled");

  const webDev = await resolveActingStaff(webDevEmail);
  ok("a Web Development member is allowed", webDev.ok === true, webDev.reason);
  eq("...resolved to their staff row", webDev.staffUserId, webDevId);
  eq("...carrying their team", webDev.teamSlug, "web-development");

  const admin = await resolveActingStaff(adminEmail);
  ok("an Admin member is allowed", admin.ok === true, admin.reason);

  // The refusal this rule exists for.
  const content = await resolveActingStaff(contentEmail);
  ok("a Content member is refused", content.ok === false);
  eq("...for the team, not for anything else", content.reason, ACTOR_REFUSALS.TEAM_NOT_ALLOWED);
  eq("...and their team is named for the audit row", content.teamSlug, "content");

  const gone = await resolveActingStaff(goneEmail);
  ok("someone disabled on the roster is refused", gone.ok === false);
  eq("...as inactive, not as a stranger", gone.reason, ACTOR_REFUSALS.INACTIVE);

  const stranger = await resolveActingStaff(strangerEmail);
  ok("an agency address that is not on the roster is refused", stranger.ok === false);
  eq("...as not on the roster", stranger.reason, ACTOR_REFUSALS.NOT_ON_ROSTER);

  // Case and whitespace must not be a way past the roster check either.
  const shouty = await resolveActingStaff(`  ${webDevEmail.toUpperCase()} `);
  ok("the same person in any case and spacing", shouty.ok === true, shouty.reason);

  const missing = await resolveActingStaff("");
  eq("an omitted actor is its own refusal, never 'allowed'", missing.reason, ACTOR_REFUSALS.MISSING);
  const outside = await resolveActingStaff("someone@gmail.com");
  eq("an outside address never reaches the roster query", outside.reason, ACTOR_REFUSALS.NOT_AGENCY);

  console.log("\n--- auto-link is attempted once, and only once ---");

  const site = await db.query(
    "insert into websites (name, url, helper_enabled, license_key) values ($1,$2,true,$3) returning id, name, url",
    [`Auto-link Test ${tag}`, `https://autolink-${tag}.test`, `DEG-AUTO1-${tag.toUpperCase()}-AUTO3-AUTO4`]
  );
  made.websites.push(site.rows[0].id);
  const siteRow = site.rows[0];

  const auditCount = async () => {
    const { rows } = await db.query(
      "select count(*)::int as n from audit_log where action = $1 and entity_id = $2",
      [AUTO_LINK_ACTION, webDevId]
    );
    return rows[0].n;
  };

  // The site isn't enrolled, so callSite refuses before any network call. What
  // matters here is the SHAPE: the failure is caught, audited with its reason,
  // and returned rather than thrown at the panel.
  const first = await autoLinkActingUser({
    site: siteRow, actor: webDev, wpUserId: 42, ip: "127.0.0.1",
  });
  ok("a link that can't proceed is reported, not thrown", typeof first === "object");
  eq("...as attempted", first.attempted, true);
  eq("...and not linked", first.linked, false);
  eq("one audit row explains it", await auditCount(), 1);

  const { rows: auditRows } = await db.query(
    "select result, after from audit_log where action = $1 and entity_id = $2 order by at desc limit 1",
    [AUTO_LINK_ACTION, webDevId]
  );
  eq("recorded as a refusal", auditRows[0].result, "refused");
  ok("...naming the reason", typeof auditRows[0].after?.reason === "string", JSON.stringify(auditRows[0].after));
  ok("...and the team, so the log explains who was asking",
     auditRows[0].after?.team !== undefined);
  ok("...and says it came from the plugin", auditRows[0].after?.via === "plugin");

  // Now pretend the link succeeded, which is what the hub records.
  await db.query(
    `insert into website_user_assignments (staff_user_id, website_id, wp_role, wp_user_id, state, managed)
     values ($1,$2,'administrator',42,'linked',true)
     on conflict (staff_user_id, website_id) do update set managed = true`,
    [webDevId, siteRow.id]
  );

  const second = await autoLinkActingUser({
    site: siteRow, actor: webDev, wpUserId: 42, ip: "127.0.0.1",
  });
  eq("a second visit does not try again", second.attempted, false);
  eq("...recognising it is already linked", second.reason, "already_linked");
  eq("...and writes no second audit row", await auditCount(), 1);

  // An unlinked row must not be mistaken for a linked one.
  await db.query(
    "update website_user_assignments set managed = false where staff_user_id = $1 and website_id = $2",
    [webDevId, siteRow.id]
  );
  const afterUnlink = await autoLinkActingUser({
    site: siteRow, actor: webDev, wpUserId: 42, ip: "127.0.0.1",
  });
  eq("an account we unlinked is adoptable again", afterUnlink.attempted, true);

  console.log("\n--- every route refuses a disallowed team, signature or no ---");

  // Mounted with req.site pre-filled, which is exactly the state the router is
  // in AFTER verifySiteRequest has accepted a valid signature. So this asks the
  // question that matters: a site whose credential is perfectly good, acting
  // for someone who may not use the panel.
  const express = (await import("express")).default;
  const { router } = await import("../src/routes/siteApi.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.site = {
      id: siteRow.id, name: siteRow.name,
      scopes: ["users:read", "users:write"],
      effectiveScopes: ["users:read", "users:write", "plugin:assign"],
      idempotencyKey: req.get("idempotency-key") || null,
    };
    next();
  });
  app.use("/api/site/v1", router);

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/site/v1`;

  const post = async (path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    for (const [path, extraBody] of [
      ["/roster", {}],
      ["/preflight", { staffUserIds: [webDevId] }],
      ["/assign", { staffUserIds: [webDevId], role: "editor" }],
    ]) {
      const headers = path === "/assign" ? { "idempotency-key": `team-test-${tag}` } : {};

      const refused = await post(path, { actorEmail: contentEmail, ...extraBody }, headers);
      eq(`${path} refuses a Content member`, refused.status, 403);
      eq(`${path} says which rule refused them`, refused.body.error?.code, ACTOR_REFUSALS.TEAM_NOT_ALLOWED);
      ok(`${path} names the teams that may`, refused.body.error?.message.includes("Web Development"));

      // Omitting the field must not be a way past the rule.
      const omitted = await post(path, { ...extraBody }, headers);
      eq(`${path} refuses a request with no actor at all`, omitted.status, 403);
      eq(`${path} tells the site to update`, omitted.body.error?.code, "plugin_update_required");
      ok(`${path} names the version`, omitted.body.error?.message.includes("2.7.1"));

      // Nor is claiming someone who does not exist.
      const invented = await post(path, { actorEmail: strangerEmail, ...extraBody }, headers);
      eq(`${path} refuses an invented colleague`, invented.status, 403);
      eq(`${path} as not on the roster`, invented.body.error?.code, ACTOR_REFUSALS.NOT_ON_ROSTER);

      const outsider = await post(path, { actorEmail: "someone@gmail.com", ...extraBody }, headers);
      eq(`${path} refuses an outside address`, outsider.status, 403);

      // A look-alike domain must not resolve either, even with a good signature.
      const lookalike = await post(path, { actorEmail: `x@digitalelementsgroup.co`, ...extraBody }, headers);
      eq(`${path} refuses a look-alike domain`, lookalike.status, 403);
    }

    // Each refusal is recorded, so a site quietly trying addresses is visible.
    const { rows: refusals } = await db.query(
      "select count(*)::int as n from audit_log where action = $1 and website_id = $2",
      ["site.actor_refused", siteRow.id]
    );
    ok("every refusal is audited", refusals[0].n >= 15, `${refusals[0].n} rows`);

    console.log("\n--- the 2.7.0 roster route answers with an instruction ---");
    const old = await fetch(`${base}/roster`);
    eq("GET /roster is refused", old.status, 403);
    const oldBody = await old.json();
    eq("...as an out-of-date plugin", oldBody.error?.code, "plugin_update_required");
    ok("...naming the version to update to", oldBody.error?.message.includes("2.7.1"));
  } finally {
    await new Promise((r) => server.close(r));
    await db.query("delete from audit_log where website_id = $1", [siteRow.id]);
  }

  console.log("\n--- a link is never attempted without a WordPress user id ---");
  const noId = await autoLinkActingUser({ site: siteRow, actor: webDev, wpUserId: null });
  eq("nothing is attempted", noId.attempted, false);
  eq("...and it says why", noId.reason, "no_wp_user_id");
  for (const bad of [0, -1, "abc", 1.5]) {
    const r = await autoLinkActingUser({ site: siteRow, actor: webDev, wpUserId: bad });
    ok(`${JSON.stringify(bad)} is not a user id`, r.attempted === false, r.reason);
  }
} finally {
  for (const id of made.staff) {
    await db.query("delete from audit_log where entity_id = $1", [id]);
    await db.query("delete from staff_users where id = $1", [id]);
  }
  for (const id of made.websites) await db.query("delete from websites where id = $1", [id]);
  await db.close?.();
}

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
