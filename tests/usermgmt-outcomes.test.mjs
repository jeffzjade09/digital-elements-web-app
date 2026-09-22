// What a finished job says it did, and the panel's guard against doing it twice.
//
// Two separate failures, both of which showed up as "the screen told me the
// wrong thing about something irreversible":
//
//   * A deletion and an unlink finished with the same status, and the word
//     they shared was the unlink one — so deleting someone's account reported
//     itself as "No longer managed". Refusing to touch an account we don't
//     manage, meanwhile, was filed under failed, which sends whoever ran it
//     looking for a fault that isn't there.
//
//   * The panel had no guard and no watchdog: a second click started a second
//     request, and a request that never answered left the controls disabled
//     with no way back but a reload.
//
// The progress guard is loaded from the plugin's own asset rather than
// reimplemented here — a copy of the logic would pass while the shipped file
// was broken. It is a plain browser script, so it is evaluated against a
// `window` stub, which is why it carries no DOM at all.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describeOutcome } from "../src/usermgmt/sync.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, "..");

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/* ============================================ what a job says it did ====== */

console.log("--- a clean deletion says so, in the deletion's own words ---");
{
  const o = describeOutcome({ counts: { deleted: 1 } });
  eq("names deletion and synchronisation", o.lines[0], "1 of 1 deleted and synchronised");
  eq("state is ok", o.state, "ok");
  ok("never uses the unlink wording", !/no longer managed/i.test(o.summary), o.summary);
}

console.log("\n--- an unlink is not a deletion ---");
{
  const o = describeOutcome({ counts: { removed: 1 } });
  eq("says removed from this website", o.lines[0], "1 of 1 removed from this website");
  ok("does not claim anything was deleted", !/deleted/i.test(o.summary), o.summary);
}

console.log("\n--- deleted in WordPress, not recorded here ---");
{
  const o = describeOutcome({ counts: { deleted: 1 }, warnings: 1 });
  ok("reports the partial explicitly",
     /deleted in WordPress, web app sync failed/i.test(o.summary), o.summary);
  eq("state is partial, not ok", o.state, "partial");
  // The deletion happened and cannot be undone. Calling it a clean success
  // hides a row that now disagrees with the site; calling it a failure invites
  // someone to run it again.
  ok("does not also claim a clean deletion", !/deleted and synchronised/.test(o.summary), o.summary);
}

console.log("\n--- an account we do not manage is skipped, never failed ---");
{
  const o = describeOutcome({ counts: { skipped: 1 }, skippedNotManaged: 1 });
  eq("names the reason", o.lines[0], "1 person skipped — not managed by Digital Elements");
  eq("the guard working is not a fault", o.state, "ok");
  ok("is not reported as a failure", !/failed/i.test(o.summary), o.summary);
}

console.log("\n--- 'nothing to do' and 'we will not touch that' are different sentences ---");
{
  const o = describeOutcome({ counts: { skipped: 2 }, skippedNotManaged: 1 });
  ok("both appear",
     /not managed by Digital Elements/.test(o.summary) && /nothing to do/.test(o.summary), o.summary);
  const plain = describeOutcome({ counts: { skipped: 1 }, skippedNotManaged: 0 });
  ok("no unmanaged claim when none were unmanaged", !/not managed/.test(plain.summary), plain.summary);
}

console.log("\n--- a mixed result counts both sides ---");
{
  const o = describeOutcome({ counts: { deleted: 1, failed: 1 } });
  ok("names what succeeded", /1 of 2 deleted and synchronised/.test(o.summary), o.summary);
  ok("names what did not", /1 of 2 failed/.test(o.summary), o.summary);
  eq("state is partial", o.state, "partial");
}

console.log("\n--- everything failing is not a partial success ---");
eq("state is failed", describeOutcome({ counts: { failed: 2 } }).state, "failed");
eq("an empty job says so", describeOutcome({ counts: {} }).lines[0], "Nothing to do");

/* ================================================= the panel's guard ====== */

// Loaded and evaluated the way a browser would, minus the browser.
const source = fs.readFileSync(
  path.join(ROOT, "wordpress-plugin", "digital-elements-helper", "assets", "um-progress.js"), "utf8");

function loadGuardModule() {
  const sandbox = { window: {}, module: undefined, Date, Math, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.DEHELED_TM_PROGRESS;
}

const PROGRESS = loadGuardModule();
ok("the plugin asset exposes the guard", !!PROGRESS && typeof PROGRESS.createGuard === "function");

/** A guard whose clock this test drives, so nothing here waits in real time. */
function fakeClockGuard(timeoutMs = 1000) {
  let seq = 0;
  const timers = new Map();
  const guard = PROGRESS.createGuard({
    timeoutMs,
    setTimeout: (fn) => { timers.set(++seq, fn); return seq; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  return {
    guard,
    pending: () => timers.size,
    fire: () => { const all = [...timers.values()]; timers.clear(); all.forEach((fn) => fn()); },
  };
}

console.log("\n--- one operation at a time ---");
{
  const { guard } = fakeClockGuard();
  ok("idle to start with", guard.canStart() && !guard.isRunning());
  ok("the first begin is accepted", guard.begin("assign") === true);
  ok("...and it is now running", guard.isRunning());
  // The whole point: a second click must not become a second request.
  ok("a second begin is refused", guard.begin("assign") === false);
  ok("a different operation is refused too", guard.begin("refresh") === false);
  eq("the running operation is unchanged", guard.current(), "assign");
  guard.succeed();
  ok("a begin is accepted again once it ended", guard.begin("refresh") === true);
}

console.log("\n--- the watchdog fires when nothing else ends it ---");
{
  const { guard, fire, pending } = fakeClockGuard();
  const seen = [];
  guard.on((e) => seen.push(e.type));
  guard.begin("assign");
  eq("a watchdog was armed", pending(), 1);
  fire();
  ok("it reported a timeout", seen.includes("timeout"), seen.join(","));
  ok("and the guard is idle again", !guard.isRunning());
  // This is the property that matters: after a timeout the screen can be used.
  ok("so another operation may start", guard.canStart());
}

console.log("\n--- the watchdog is cleared on BOTH endings ---");
{
  const s = fakeClockGuard();
  s.guard.begin("assign");
  s.guard.succeed();
  eq("cleared on success", s.pending(), 0);

  const f = fakeClockGuard();
  f.guard.begin("assign");
  f.guard.fail();
  eq("cleared on failure", f.pending(), 0);

  const c = fakeClockGuard();
  c.guard.begin("assign");
  c.guard.cancel();
  eq("cleared on cancel", c.pending(), 0);
}

console.log("\n--- a settled operation cannot time out afterwards ---");
{
  const { guard, fire } = fakeClockGuard();
  const seen = [];
  guard.on((e) => seen.push(e.type));
  guard.begin("assign");
  guard.succeed();
  fire();  // a stray timer that was never cleared would land here
  eq("exactly one ending was reported", seen.filter((t) => t !== "begin").length, 1);
  ok("and it was the success", seen.includes("succeed") && !seen.includes("timeout"), seen.join(","));
}

console.log("\n--- a long job that keeps answering is not cut off ---");
{
  const { guard, fire, pending } = fakeClockGuard();
  const seen = [];
  guard.on((e) => seen.push(e.type));
  guard.begin("assign");
  // Each poll that comes back is evidence the job is alive.
  ok("touch re-arms while running", guard.touch() === true);
  eq("still exactly one watchdog", pending(), 1);
  ok("still running", guard.isRunning());
  ok("no ending was reported", !seen.includes("timeout"));
  // ...but a poll that stops answering stops touching, and it does fire.
  fire();
  ok("a silent job still times out eventually", seen.includes("timeout"), seen.join(","));
  ok("touch does nothing once idle", guard.touch() === false);
}

console.log("\n--- counted progress, only where there is something to count ---");
{
  const { guard } = fakeClockGuard();
  eq("nothing to count", guard.progress([]), null);
  eq("nothing to count when absent", guard.progress(undefined), null);

  const ops = [
    { status: "synced" }, { status: "processing" }, { status: "pending" },
    { status: "failed" }, { status: "pending" },
  ];
  const p = guard.progress(ops);
  // Counted from what has FINISHED: a row still in flight has not been
  // processed, and counting it would show progress that hasn't happened.
  eq("two are finished", p.done, 2);
  eq("out of five", p.total, 5);
  eq("and it says so", p.text, "Processing 3 of 5");

  const allDone = guard.progress([{ status: "synced" }, { status: "deleted" }]);
  eq("a finished job counts them all", allDone.done, 2);
  eq("and switches wording", allDone.finishedText, "2 of 2 done");
}

console.log("\n--- each operation is named, not called 'working' ---");
{
  const { guard } = fakeClockGuard();
  eq("adding", guard.label("assign"), "Adding users");
  eq("updating roles", guard.label("roles"), "Updating roles");
  eq("synchronising", guard.label("sync"), "Synchronising with the web app");
  ok("an unknown kind still says something", guard.label("nope").length > 0);
}

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
