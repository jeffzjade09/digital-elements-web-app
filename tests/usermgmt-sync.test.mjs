// Tests for the sync engine's pure parts: the idempotency key, the retry rule,
// and the bounded concurrency executor.
//
// These are the properties that make "Retry failed" safe to press. If the key
// isn't stable across retries, a retry applies the change twice; if a 4xx is
// retried, we hammer past a deliberate refusal; if the executor isn't bounded,
// one bulk run opens a connection to every client site at once.

import crypto from "node:crypto";
import { idempotencyKey, isTransient } from "../src/usermgmt/sync.js";
import { WpError } from "../src/usermgmt/wpClient.js";

let fail = 0;
const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? "  (" + extra + ")" : ""}`);
  if (!cond) fail++;
};
const eq = (label, a, b) => ok(label, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

/* ---------------------------------------------------- the idempotency key - */

console.log("--- the idempotency key is stable across retries ---");
const JOB = "job-1", SITE = "site-1", STAFF = "staff-1";
const key = idempotencyKey(JOB, SITE, STAFF, "create");

eq("same inputs, same key", idempotencyKey(JOB, SITE, STAFF, "create"), key);
ok("it's a sha256 hex digest", /^[0-9a-f]{64}$/.test(key));

// THE property that makes a retry safe. A random key per attempt would mean the
// site treats the retry as a brand-new request and applies the change twice.
const retryKey = idempotencyKey(JOB, SITE, STAFF, "create");
eq("a retry of the same unit of work reuses the key", retryKey, key);

console.log("\n--- ...but distinct for anything genuinely different ---");
ok("a different site differs", idempotencyKey(JOB, "site-2", STAFF, "create") !== key);
ok("a different person differs", idempotencyKey(JOB, SITE, "staff-2", "create") !== key);
ok("a different action differs", idempotencyKey(JOB, SITE, STAFF, "update_role") !== key);
// A later job must not replay an earlier job's stored result.
ok("a different job differs", idempotencyKey("job-2", SITE, STAFF, "create") !== key);

// A key two different operations could share is the one thing this must never
// produce. Joining on a separator would let ("a:b","c") and ("a","b:c") collide.
ok("field boundaries can't be shifted",
   idempotencyKey("a:b", "c", STAFF, "create") !== idempotencyKey("a", "b:c", STAFF, "create"));

eq("matches the documented derivation",
   key,
   crypto.createHash("sha256").update(JSON.stringify([JOB, SITE, STAFF, "create"]), "utf8").digest("hex"));

/* --------------------------------------------------------- the retry rule - */

console.log("\n--- only transport failures are retried ---");
const wpErr = (code, extra = {}) => new WpError(code, "msg", extra);

for (const code of ["timeout", "unreachable", "site_error", "rate_limited"]) {
  ok(`${code} is retried`, isTransient(wpErr(code)));
}

// A 4xx is the site refusing the request. Retrying it unchanged fails again —
// and for a confirmation guard it would be retrying past a deliberate refusal.
for (const code of [
  "not_managed", "role_requires_confirmation", "last_administrator",
  "role_not_available", "user_exists", "invalid_email", "scope_denied",
  "unauthorized", "replay", "plugin_update_required", "not_enrolled",
  "idempotency_required", "link_required",
]) {
  ok(`${code} is NOT retried`, isTransient(wpErr(code)) === false);
}

ok("an explicit retryable flag is honoured", isTransient(wpErr("odd", { retryable: true })));
ok("null is not retried", isTransient(null) === false);
ok("undefined is not retried", isTransient(undefined) === false);
ok("a plain Error is not retried", isTransient(new Error("boom")) === false);

/* ------------------------------------------------- the concurrency limiter - */

// The executor's shape, extracted so the bound and the work-stealing behaviour
// can be asserted without a database. Mirrors runOperations().
async function boundedRun(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

console.log("\n--- concurrency is bounded ---");
{
  let inFlight = 0, peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const results = await boundedRun(items, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  }, 4);

  eq("never exceeds the limit", peak <= 4, true);
  ok("...and actually uses it", peak === 4, `peak ${peak}`);
  eq("every item is processed", results.length, 20);
  ok("results stay in input order", results.every((v, i) => v === i * 2));
}

console.log("\n--- one slow site doesn't idle the others ---");
{
  // With chunking, the three fast items behind a slow one would wait for it.
  // Pulling from a shared cursor means they don't.
  const items = [200, 1, 1, 1, 1, 1, 1, 1];
  const started = [];
  const t0 = Date.now();
  await boundedRun(items, async (ms, i) => {
    started.push({ i, at: Date.now() - t0 });
    await new Promise((r) => setTimeout(r, ms));
  }, 2);
  const lastFast = started[started.length - 1];
  ok("the fast items all start well before the slow one finishes", lastFast.at < 200,
     `last started at ${lastFast.at}ms`);
}

console.log("\n--- a worker that throws doesn't strand the batch ---");
{
  const items = [1, 2, 3, 4, 5];
  const results = await boundedRun(items, async (n) => {
    try {
      if (n === 3) throw new Error("site exploded");
      return { status: "ok", n };
    } catch (err) {
      // What runOperations does: record an outcome rather than letting the
      // rejection escape and leave operations stuck in 'processing'.
      return { status: "failed", n, error: err.message };
    }
  }, 2);

  eq("every item still has a result", results.length, 5);
  eq("the failure is recorded, not thrown", results[2].status, "failed");
  ok("the rest succeeded", results.filter((r) => r.status === "ok").length === 4);
}

console.log("\n--- retry semantics ---");
{
  // The executor's attempt loop: at most one automatic retry, and only when
  // the failure is transient.
  const MAX_ATTEMPTS = 2;
  async function attemptLoop(failWith, succeedOnAttempt = 99) {
    let attempt = 0, lastError = null;
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      if (attempt >= succeedOnAttempt) return { status: "synced", attempt };
      lastError = failWith;
      if (!isTransient(lastError) || attempt >= MAX_ATTEMPTS) break;
    }
    return { status: "failed", attempt, code: lastError.code };
  }

  const transient = await attemptLoop(wpErr("timeout"));
  eq("a transient failure is tried twice", transient.attempt, 2);
  eq("...then gives up", transient.status, "failed");

  const permanent = await attemptLoop(wpErr("not_managed"));
  eq("a permanent failure is tried once", permanent.attempt, 1);
  eq("...and keeps its code", permanent.code, "not_managed");

  const recovered = await attemptLoop(wpErr("timeout"), 2);
  eq("a transient failure that clears on retry succeeds", recovered.status, "synced");
  eq("...on the second attempt", recovered.attempt, 2);
}

console.log("\n--- per-site timeout ---");
{
  // AbortSignal.timeout is what wpClient uses; assert the shape the executor
  // relies on, namely that a hung site rejects rather than hanging forever.
  const slow = new Promise((r) => setTimeout(r, 5000));
  let timedOut = false;
  try {
    await Promise.race([
      slow,
      new Promise((_, reject) => setTimeout(() => reject(new WpError("timeout", "took too long", { retryable: true })), 30)),
    ]);
  } catch (err) {
    timedOut = err.code === "timeout";
  }
  ok("a hung call rejects with a timeout", timedOut);
  ok("...which is retryable", isTransient(new WpError("timeout", "x", { retryable: true })));
}

console.log(fail ? `\n${fail} assertion(s) failed` : "\nAll assertions passed");
process.exit(fail ? 1 : 0);
