// Syncing users without running the monitoring sweep.
//
// "Run checks" was the only reliable way to refresh user sync status, and it
// re-checks uptime, SSL, Cloudflare, tags, PageSpeed, updates and the security
// scan across every site — an enormous amount of work to answer "has this
// person been removed?".
//
// What these assert is mostly what a user sync must NOT do. It must not touch
// monitoring. It must not write to WordPress. Syncing one person must not go
// asking about everyone else. And a site that refused to answer — rate-limited,
// unreachable — must never be read as a site with nobody on it, which is the
// one mistake that would mark a whole estate removed.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { reconcileSite, reconcileAll, reconcileStaff, decide } from "../src/usermgmt/reconcile.js";
import { WpError } from "../src/usermgmt/wpClient.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const site = (id, over = {}) => ({ id, name: `site-${id}`, archived: false, ...over });

const assignment = (over = {}) => ({
  id: `a-${over.staff_user_id || "s1"}-${over.website_id || "w1"}`,
  staff_user_id: "s1", website_id: "w1",
  wp_role: "editor", wp_user_id: 21, wp_user_login: "x",
  state: "synced", managed: true, drift: null, last_reconciled_at: null,
  email: "x@digitalelementsgroup.com", display_name: "X",
  ...over,
});

/**
 * A rig that records every outbound call and every write, so what happened can
 * be asserted rather than assumed.
 */
function rig({ rows = [], answer = () => ({ exists: true, user: { id: 21, roles: ["editor"], managed: true } }) } = {}) {
  const calls = [];
  const writes = [];
  const loaded = [];
  return {
    calls, writes, loaded,
    deps: {
      assignmentsFor: async (websiteId, opts = {}) => {
        loaded.push({ websiteId, staffUserIds: opts.staffUserIds || null });
        const all = rows.filter((r) => r.website_id === websiteId);
        const ids = opts.staffUserIds;
        return Array.isArray(ids) && ids.length ? all.filter((r) => ids.includes(r.staff_user_id)) : all;
      },
      callSite: async (s, req) => { calls.push({ site: s.id, ...req }); return answer(s, req); },
      apply: async (s, a, decision) => { writes.push({ site: s.id, assignment: a.id, decision }); },
      applyInvite: async () => {},
    },
  };
}

/* ============================================ no monitoring, no writes ==== */

console.log("--- a user sync asks one question and writes nothing to WordPress ---");
{
  const r = rig({ rows: [assignment(), assignment({ staff_user_id: "s2", email: "y@digitalelementsgroup.com" })] });
  await reconcileSite(site("w1"), { deps: r.deps });

  eq("one lookup per assignment", r.calls.length, 2);
  ok("every call is a GET", r.calls.every((c) => c.method === "GET"), JSON.stringify(r.calls.map((c) => c.method)));
  ok("every call is the lookup route", r.calls.every((c) => c.route === "/users/lookup"),
     JSON.stringify(r.calls.map((c) => c.route)));
  // The de/v2 write routes. If a sync ever reaches one of these, it is no
  // longer read-only toward WordPress and the whole premise is gone.
  const forbidden = /\/users\/\d+$|\/unlink|\/link|\/reset|\/users$/;
  ok("no de/v2 write route is touched", !r.calls.some((c) => forbidden.test(c.route || "")),
     JSON.stringify(r.calls.map((c) => c.route)));
  ok("no create, update or delete method", !r.calls.some((c) => ["POST", "PUT", "PATCH", "DELETE"].includes(c.method)));
  // Monitoring is a different subsystem entirely; a sync must never reach it.
  ok("nothing resembling a monitoring probe",
     !r.calls.some((c) => /pagespeed|ssl|uptime|security|status|updates/i.test(c.route || "")),
     JSON.stringify(r.calls.map((c) => c.route)));
}

/* ================================================ per-person narrowing ==== */

console.log("\n--- syncing one person touches only that person's rows ---");
{
  const rows = [
    assignment({ staff_user_id: "s1", website_id: "w1", email: "a@digitalelementsgroup.com" }),
    assignment({ staff_user_id: "s2", website_id: "w1", email: "b@digitalelementsgroup.com" }),
    assignment({ staff_user_id: "s3", website_id: "w1", email: "c@digitalelementsgroup.com" }),
  ];
  const r = rig({ rows });
  await reconcileSite(site("w1"), { staffUserIds: ["s2"], deps: r.deps });

  eq("only one lookup was made", r.calls.length, 1);
  eq("and it was for that person", r.calls[0].query.email, "b@digitalelementsgroup.com");
  eq("the narrowing reached the query", JSON.stringify(r.loaded[0].staffUserIds), JSON.stringify(["s2"]));
}

console.log("\n--- a person is only looked for on sites they are actually on ---");
{
  // s1 is on w1 only. Syncing them must not open a conversation with w2 and w3.
  const rows = [assignment({ staff_user_id: "s1", website_id: "w1" })];
  const r = rig({ rows });
  const sites = [site("w1"), site("w2"), site("w3")];

  // reconcileStaff reads the distinct site list from the database; here the
  // narrowing is asserted through reconcileAll, which is what it delegates to.
  await reconcileAll(sites, { staffUserIds: ["s1"], isReady: (s) => s.id === "w1", deps: r.deps });
  eq("only the site they are on was contacted", r.calls.length, 1);
  eq("and it was the right one", r.calls[0].site, "w1");
}

console.log("\n--- an unready or archived site is never contacted ---");
{
  const rows = [assignment({ website_id: "w1" }), assignment({ website_id: "w2", staff_user_id: "s2" })];
  const r = rig({ rows });
  await reconcileAll([site("w1"), site("w2", { archived: true })], { isReady: () => true, deps: r.deps });
  ok("the archived site was skipped", !r.calls.some((c) => c.site === "w2"), JSON.stringify(r.calls));

  const r2 = rig({ rows });
  await reconcileAll([site("w1"), site("w2")], { isReady: (s) => s.id === "w1", deps: r2.deps });
  ok("an unready site was skipped", !r2.calls.some((c) => c.site === "w2"), JSON.stringify(r2.calls));
}

/* ============================================ refusals are not absence ==== */

console.log("\n--- a rate-limited site is skipped, never read as empty ---");
{
  const rows = [assignment(), assignment({ staff_user_id: "s2", email: "y@digitalelementsgroup.com" })];
  const r = rig({
    rows,
    answer: () => { throw new WpError("rate_limited", "Slow down.", { status: 429 }); },
  });
  const summary = await reconcileSite(site("w1"), { deps: r.deps });

  eq("both rows were skipped", summary.skipped, 2);
  eq("nothing was checked", summary.checked, 0);
  // THE mistake this guards against: a site that wouldn't answer being recorded
  // as a site with nobody on it.
  eq("nobody was marked removed", summary.removedExternally, 0);
  eq("and nothing was written at all", r.writes.length, 0);
}

console.log("\n--- an unreachable site is treated the same way ---");
{
  const r = rig({
    rows: [assignment()],
    answer: () => { throw new WpError("unreachable", "No answer.", { status: 0 }); },
  });
  const summary = await reconcileSite(site("w1"), { deps: r.deps });
  eq("skipped", summary.skipped, 1);
  eq("not removed", summary.removedExternally, 0);
  eq("no write", r.writes.length, 0);
}

console.log("\n--- one site failing does not stop the others ---");
{
  const rows = [assignment({ website_id: "w1" }), assignment({ website_id: "w2", staff_user_id: "s2" })];
  const r = rig({
    rows,
    answer: (s) => {
      if (s.id === "w1") throw new WpError("unreachable", "No answer.", {});
      return { exists: true, user: { id: 9, roles: ["editor"], managed: true } };
    },
  });
  const { perSite } = await reconcileAll([site("w1"), site("w2")], { isReady: () => true, deps: r.deps });
  eq("both sites were attempted", perSite.length, 2);
  ok("the healthy one still answered", r.calls.some((c) => c.site === "w2"));
}

/* ====================================================== absence itself ==== */

console.log("\n--- a site that DOES answer 'not here' is believed ---");
{
  const r = rig({ rows: [assignment()], answer: () => ({ exists: false }) });
  const summary = await reconcileSite(site("w1"), { deps: r.deps });
  eq("checked", summary.checked, 1);
  eq("and recorded as removed outside the dashboard", summary.removedExternally, 1);
  eq("exactly one row was written", r.writes.length, 1);
  eq("with the right state", r.writes[0].decision.state, "removed_externally");
}

// The distinction, stated on the pure function: no observation is not absence.
console.log("\n--- 'we could not ask' and 'they are not there' stay different ---");
eq("a failed lookup decides nothing", decide(assignment(), null), null);
eq("an answered lookup decides removal",
   decide(assignment(), { present: false }).state, "removed_externally");

/* ========================================================== freshness ==== */

console.log("\n--- every checked row records when it was verified ---");
{
  const r = rig({ rows: [assignment()], answer: () => ({ exists: false }) });
  await reconcileSite(site("w1"), { deps: r.deps });
  ok("the write carries lastReconciledAt", r.writes[0].decision.lastReconciledAt === true,
     JSON.stringify(r.writes[0].decision));
}

console.log("\n--- a row that has not changed still records that we looked ---");
{
  // Nothing to correct, but "verified just now" has to become true anyway —
  // otherwise a healthy estate would look permanently unverified.
  const d = decide(assignment(), { present: true, roles: ["editor"], managed: true });
  ok("it is a no-op", d.noop === true);
  ok("...that still stamps the time", d.lastReconciledAt === true);
}

console.log("\n--- nothing to do is not an error ---");
{
  const r = rig({ rows: [] });
  const summary = await reconcileSite(site("w1"), { deps: r.deps });
  eq("no calls", r.calls.length, 0);
  eq("no writes", r.writes.length, 0);
  eq("and nothing checked", summary.checked, 0);
}

console.log("\n--- syncing nobody asks nothing ---");
{
  const empty = await reconcileStaff([], [site("w1")], {});
  eq("no sites were visited", empty.perSite.length, 0);
  eq("and nothing was checked", empty.totals.checked, 0);
}

/* ============================================ the dashboard's guard ====== */

// Loaded from the file the dashboard actually serves. A reimplementation here
// would pass while the shipped one was broken.
function loadGuard() {
  const sandbox = { window: {}, module: undefined, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "public", "opguard.js"), "utf8"), sandbox);
  return sandbox.window.WPU_GUARD;
}

const GUARD = loadGuard();
ok("the dashboard serves a guard", !!GUARD && typeof GUARD.createGuard === "function");

/** A guard whose clock this test drives, so nothing waits in real time. */
function clocked(timeoutMs = 1000) {
  let seq = 0;
  const timers = new Map();
  const events = [];
  const guard = GUARD.createGuard({
    timeoutMs,
    onChange: (e) => events.push(e.type),
    setTimeout: (fn) => { timers.set(++seq, fn); return seq; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  return {
    guard, events,
    pending: () => timers.size,
    fire: () => { const all = [...timers.values()]; timers.clear(); all.forEach((fn) => fn()); },
  };
}

console.log("\n--- a second click does not start a second sync ---");
{
  const { guard } = clocked();
  ok("the first begins", guard.begin("all") === true);
  ok("the second is refused", guard.begin("all") === false);
  ok("a different scope is refused too", guard.begin("person") === false);
  eq("the running scope is unchanged", guard.current(), "all");
  guard.end();
  ok("and it can start again afterwards", guard.begin("person") === true);
}

console.log("\n--- the sync guard always gives the screen back ---");
{
  const { guard, events, fire, pending } = clocked();
  guard.begin("all");
  eq("a watchdog is armed", pending(), 1);
  fire();
  ok("it reports a timeout", events.includes("timeout"), events.join(","));
  ok("and the guard is idle", !guard.isRunning());
  ok("so another sync may start", guard.canStart());
}

console.log("\n--- the watchdog is cleared on every ending ---");
{
  const a = clocked(); a.guard.begin("all"); a.guard.end("ok");
  eq("cleared on success", a.pending(), 0);
  const b = clocked(); b.guard.begin("all"); b.guard.end("fail");
  eq("cleared on failure", b.pending(), 0);

  const c = clocked();
  c.guard.begin("all");
  c.guard.end("ok");
  c.fire();   // a stray timer that was never cleared would land here
  eq("a settled sync cannot time out afterwards",
     c.events.filter((t) => t === "timeout").length, 0);
  ok("end is idempotent", c.guard.end() === false);
}

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);

