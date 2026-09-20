// Applying a reviewed plan: planner, bounded executor, per-site results.
//
// The shape of this module is driven by three facts about the job:
//
//   Sites fail independently. One slow or broken site must not stall or fail
//   the rest, so every (person × site) pair is its own operation with its own
//   timeout, status and retry.
//
//   Retries are normal, not exceptional. A bulk run across a dozen client sites
//   will hit a timeout sooner or later. So every operation carries a stable
//   idempotency key and the site replays its stored result rather than applying
//   the change twice — which is what makes "Retry failed" safe to press.
//
//   The process can restart mid-job. Operations therefore live in Postgres, not
//   in memory, and anything left 'processing' is swept to 'interrupted' on boot
//   rather than lying about being in progress forever.

import crypto from "node:crypto";

import { query, getWebsiteSite } from "../db.js";
import { getStaff } from "./staffUsers.js";
import { assertEmailAllowed, wpUsernameFor, AGENCY_DOMAIN } from "./staffUsers.js";
import { getSiteRoles, checkRoleAvailability } from "./roles.js";
import { getCapabilities, READINESS } from "./capabilities.js";
import { callSite, WpError } from "./wpClient.js";
import { resolveRequestedRole, predict, ACTION } from "./preflight.js";
import * as audit from "./audit.js";

// Bounded so a bulk run can't open one connection per site at once. Four is
// enough to keep a dozen sites moving without looking like an attack to any of
// them.
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.USER_SYNC_CONCURRENCY) || 4));
const SITE_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2;           // the initial try, plus one automatic retry
const STALE_PROCESSING_MS = 10 * 60 * 1000;

/**
 * Stable across every retry of the same unit of work.
 *
 * Deliberately derived from the job rather than random: a retry must present
 * the SAME key so the site recognises it and replays, instead of applying the
 * change a second time. Including the action means a later, different operation
 * on the same pair gets its own key.
 */
export function idempotencyKey(jobId, websiteId, staffUserId, action) {
  // JSON rather than a joined string: joining on a separator makes
  // ("a:b", "c") and ("a", "b:c") produce the same key. These are all UUIDs in
  // practice so it could not happen today, but a key that two different
  // operations can share is the one thing this function must never produce.
  return crypto.createHash("sha256")
    .update(JSON.stringify([jobId, websiteId, staffUserId, action]), "utf8")
    .digest("hex");
}

/**
 * Should this failure be retried automatically?
 *
 * Only transport-level problems: a timeout, an unreachable host, a 5xx, or a
 * rate limit. A 4xx is the site telling us the request was wrong — retrying it
 * unchanged just fails again, and for something like
 * role_requires_confirmation it would be retrying past a deliberate guard.
 */
export function isTransient(err) {
  if (!err) return false;
  if (err.retryable === true) return true;
  return ["timeout", "unreachable", "site_error", "rate_limited"].includes(err.code);
}

/* ------------------------------------------------------------- planning --- */

/**
 * Turns a request into concrete operations.
 *
 * Runs the same prediction the review screen showed, so what gets applied is
 * what the administrator agreed to. Pairs the plan can't act on are recorded as
 * finished operations with their blocker, not silently dropped — a person who
 * expected 12 results should see 12 rows.
 */
export async function planAssignment({ staffList, sites, roleOverrides = {}, confirmations = {} }) {
  const ops = [];

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const capabilities = await getCapabilities(site);
    const roleResult = capabilities.readiness === READINESS.READY
      ? await getSiteRoles(site)
      : { roles: [] };

    for (const staff of staffList) {
      const { role: requestedRole, source: roleSource } = resolveRequestedRole(staff, site.id, roleOverrides);
      const roleCheck = checkRoleAvailability(requestedRole, roleResult.roles);

      let existing = { exists: false, user: null };
      if (capabilities.readiness === READINESS.READY) {
        try {
          existing = await callSite(site, { method: "GET", route: "/users/lookup", query: { email: staff.email } });
        } catch (err) {
          existing = { exists: false, user: null, error: err.message, lookupFailed: true };
        }
      }

      const prediction = existing.lookupFailed
        ? { action: ACTION.BLOCKED, blockers: [{ code: "lookup_failed", message: `Couldn't check existing accounts on ${site.name}: ${existing.error}` }], needsAdminConfirmation: false }
        : predict({ staff, site, capabilities, roleCheck, existing, requestedRole });

      ops.push({
        staff, site, requestedRole, roleSource,
        action: prediction.action,
        blockers: prediction.blockers,
        needsAdminConfirmation: prediction.needsAdminConfirmation,
        existing,
        confirmAdmin: confirmations.admin === true,
      });
    }
  }
  return ops;
}

/* ------------------------------------------------------------ execution --- */

export async function createJob({ kind, params, actor }) {
  const { rows } = await query(
    `insert into user_sync_jobs (kind, initiated_by, initiated_email, params, status, started_at)
     values ($1,$2,$3,$4,'running', now()) returning id, created_at`,
    [kind, actor?.actorUserId || null, actor?.actorEmail || null, JSON.stringify(params || {})]
  );
  return rows[0];
}

async function recordOperation(jobId, op, action) {
  const key = idempotencyKey(jobId, op.site.id, op.staff.id, action);
  const { rows } = await query(
    `insert into user_sync_operations
       (job_id, website_id, staff_user_id, action, idempotency_key, status, requested_role)
     values ($1,$2,$3,$4,$5,'pending',$6)
     on conflict (idempotency_key) do update set status = 'pending'
     returning id`,
    [jobId, op.site.id, op.staff.id, action, key, op.requestedRole]
  );
  return { id: rows[0].id, key };
}

async function finishOperation(id, { status, result, errorCode, error, warnings, attempt }) {
  await query(
    `update user_sync_operations set
       status = $2, result = $3, error_code = $4, error = $5, warnings = $6,
       attempt = $7, finished_at = now()
     where id = $1`,
    [id, status, result ? JSON.stringify(result) : null, errorCode || null, error || null,
     warnings ? JSON.stringify(warnings) : null, attempt]
  );
}

/**
 * Applies one (person × site) operation.
 *
 * Every branch ends in a recorded status. The one thing that must never happen
 * is a change being applied without a row saying so, which is why the site call
 * and the bookkeeping are adjacent rather than batched.
 */
async function applyOne(jobId, op, actor) {
  // Blocked at plan time: record the blocker and don't call the site at all.
  if (op.action === ACTION.BLOCKED) {
    const { id } = await recordOperation(jobId, op, "blocked");
    const first = op.blockers[0] || { code: "blocked", message: "Blocked." };
    await finishOperation(id, { status: "failed", errorCode: first.code, error: first.message, attempt: 0 });
    return { status: "failed", errorCode: first.code, error: first.message };
  }

  if (op.action === ACTION.SKIP) {
    const { id } = await recordOperation(jobId, op, "skip");
    await finishOperation(id, { status: "skipped", result: { reason: "already correct" }, attempt: 0 });
    await upsertAssignment(op, { state: "skipped", actor });
    return { status: "skipped" };
  }

  // An unmanaged account is reported, never adopted. Linking is a separate,
  // explicit decision the administrator makes on the review screen.
  if (op.action === ACTION.LINK_REQUIRED) {
    const { id } = await recordOperation(jobId, op, "link_required");
    await finishOperation(id, {
      status: "failed", errorCode: "link_required",
      error: `An account already exists on ${op.site.name} and isn't managed by us. Link it first.`,
      result: { existingUser: op.existing?.user || null }, attempt: 0,
    });
    return { status: "failed", errorCode: "link_required" };
  }

  const action = op.action === ACTION.CREATE ? "create" : "update_role";
  const { id, key } = await recordOperation(jobId, op, action);
  await query("update user_sync_operations set status='processing', started_at=now() where id=$1", [id]);

  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      const data = op.action === ACTION.CREATE
        ? await callSite(op.site, {
            method: "POST", route: "/users", idempotencyKey: key, timeoutMs: SITE_TIMEOUT_MS,
            body: {
              email: op.staff.email,
              username: wpUsernameFor(op.staff.email),
              first_name: op.staff.firstName || "",
              last_name: op.staff.lastName || "",
              display_name: op.staff.displayName || "",
              role: op.requestedRole,
              confirm_admin: op.confirmAdmin === true,
            },
          })
        : await callSite(op.site, {
            method: "PATCH", route: `/users/${op.existing.user.id}`, idempotencyKey: key, timeoutMs: SITE_TIMEOUT_MS,
            body: { role: op.requestedRole, confirm_admin: op.confirmAdmin === true },
          });

      const status = data.result === "created" ? "synced" : data.result === "updated" ? "updated" : "skipped";
      await finishOperation(id, { status, result: data, warnings: data.warnings, attempt });
      await upsertAssignment(op, {
        state: status, wpUser: data.user, result: data, actor,
      });

      await audit.record({
        ...actor,
        action: op.action === ACTION.CREATE ? "wpuser.create" : "wpuser.role_change",
        entityType: "staff_user", entityId: op.staff.id,
        websiteId: op.site.id, targetEmail: op.staff.email,
        after: { role: op.requestedRole, result: data.result, replayed: data.replayed === true, wpUserId: data.user?.id },
        result: "ok",
      });

      return { status, warnings: data.warnings || [], replayed: data.replayed === true };
    } catch (err) {
      lastError = err;
      // Only transport problems are retried. A 4xx means the request itself was
      // refused, and retrying it unchanged would just fail again — or, for a
      // confirmation guard, would be retrying past a deliberate refusal.
      if (!isTransient(err) || attempt >= MAX_ATTEMPTS) break;
    }
  }

  const errorCode = lastError instanceof WpError ? lastError.code : "failed";
  await finishOperation(id, {
    status: "failed", errorCode, error: lastError?.message || "Failed.", attempt,
  });
  await upsertAssignment(op, { state: "failed", errorCode, error: lastError?.message, actor });

  await audit.record({
    ...actor,
    action: op.action === ACTION.CREATE ? "wpuser.create" : "wpuser.role_change",
    entityType: "staff_user", entityId: op.staff.id,
    websiteId: op.site.id, targetEmail: op.staff.email,
    after: { role: op.requestedRole, errorCode },
    result: "failed",
  });

  return { status: "failed", errorCode, error: lastError?.message };
}

async function upsertAssignment(op, { state, wpUser, result, errorCode, error, actor, managed }) {
  await query(
    `insert into website_user_assignments
       (staff_user_id, website_id, wp_role, wp_user_id, wp_user_login, state,
        managed, last_result, last_error, last_error_code, last_synced_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $6 = 'failed' then null else now() end, $11)
     on conflict (staff_user_id, website_id) do update set
       wp_role = excluded.wp_role,
       wp_user_id = coalesce(excluded.wp_user_id, website_user_assignments.wp_user_id),
       wp_user_login = coalesce(excluded.wp_user_login, website_user_assignments.wp_user_login),
       state = excluded.state,
       managed = excluded.managed,
       last_result = excluded.last_result,
       last_error = excluded.last_error,
       last_error_code = excluded.last_error_code,
       last_synced_at = coalesce(excluded.last_synced_at, website_user_assignments.last_synced_at),
       updated_at = now()`,
    [
      op.staff.id, op.site.id, op.requestedRole,
      wpUser?.id || null, wpUser?.login || null,
      state,
      managed === undefined ? true : managed,
      result ? JSON.stringify(result) : null,
      error || null, errorCode || null,
      actor?.actorUserId || null,
    ]
  );
}

/**
 * Runs a job's operations with bounded concurrency.
 *
 * Work is pulled from a shared cursor rather than chunked, so a batch
 * containing one very slow site doesn't leave the other workers idle waiting
 * for it.
 */
export async function runOperations(jobId, ops, actor, { concurrency = CONCURRENCY } = {}) {
  const results = new Array(ops.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, ops.length) }, async () => {
    while (cursor < ops.length) {
      const i = cursor++;
      try {
        results[i] = await applyOne(jobId, ops[i], actor);
      } catch (err) {
        // A bug in our own code must still leave a recorded outcome rather than
        // an operation stuck in 'processing'.
        results[i] = { status: "failed", errorCode: "internal", error: err.message };
        console.error("[sync] operation threw:", err);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function finalizeJob(jobId) {
  const { rows } = await query(
    `select status, count(*)::int n from user_sync_operations where job_id = $1 group by status`,
    [jobId]
  );
  const totals = {};
  for (const r of rows) totals[r.status] = r.n;

  const failed = totals.failed || 0;
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const status = failed === 0 ? "done" : failed === total ? "failed" : "partial";

  await query(
    "update user_sync_jobs set status=$2, totals=$3, finished_at=now() where id=$1",
    [jobId, status, JSON.stringify(totals)]
  );
  return { status, totals, total };
}

/* --------------------------------------------------------------- public --- */

/**
 * Assigns people to websites. Returns as soon as the job exists; the work
 * continues in the background and the UI polls getJob().
 *
 * The domain guard is re-checked HERE, not just where a person was added to the
 * roster: this is the call that actually creates an account on a client site,
 * and it must not be possible to reach it by a path that skipped the check.
 */
export async function startAssignment({ staffUserIds = [], teamId = null, websiteIds = [], roleOverrides = {}, confirmations = {}, overrideDomain = false }, actor) {
  const staffList = await loadStaff(staffUserIds, teamId);
  if (!staffList.length) throw new Error("Select at least one person.");

  const sites = [];
  for (const id of websiteIds) {
    const site = await getWebsiteSite(id);
    if (site) sites.push(site);
  }
  if (!sites.length) throw new Error("Select at least one website.");

  for (const staff of staffList) {
    try {
      assertEmailAllowed(staff.email, { overrideDomain: overrideDomain || staff.domainOverride });
    } catch (err) {
      err.message = `${staff.label}: ${err.message}`;
      throw err;
    }
    if (!staff.email.endsWith(`@${AGENCY_DOMAIN}`)) {
      await audit.record({
        ...actor,
        action: "wpuser.domain_override",
        entityType: "staff_user", entityId: staff.id, targetEmail: staff.email,
        after: { websiteIds, confirmedBy: actor?.actorEmail },
      });
    }
  }

  const job = await createJob({
    kind: "assign",
    params: { staffUserIds: staffList.map((s) => s.id), teamId, websiteIds, roleOverrides, confirmations },
    actor,
  });

  const ops = await planAssignment({ staffList, sites, roleOverrides, confirmations });
  // Rows up front so the progress view has something to show immediately.
  for (const op of ops) {
    await recordOperation(job.id, op, op.action === ACTION.CREATE ? "create" : op.action);
  }

  runOperations(job.id, ops, actor)
    .then(() => finalizeJob(job.id))
    .catch(async (err) => {
      console.error("[sync] job failed:", err);
      await query("update user_sync_jobs set status='failed', finished_at=now() where id=$1", [job.id]);
    });

  return { jobId: job.id, operations: ops.length, sites: sites.length, people: staffList.length };
}

/**
 * Stops managing people on websites.
 *
 * In this phase "remove" means unlink: the WordPress account keeps its role,
 * its content and its access, and we simply stop managing it. DELETING the
 * account is deliberately not available yet — it requires the content-ownership
 * checks that arrive in the next phase, and offering deletion without them is
 * exactly how content gets orphaned.
 */
export async function startRemoval({ staffUserIds = [], teamId = null, websiteIds = [] }, actor) {
  const staffList = await loadStaff(staffUserIds, teamId);
  if (!staffList.length) throw new Error("Select at least one person.");

  const sites = [];
  for (const id of websiteIds) {
    const site = await getWebsiteSite(id);
    if (site) sites.push(site);
  }
  if (!sites.length) throw new Error("Select at least one website.");

  const job = await createJob({
    kind: "remove",
    params: { staffUserIds: staffList.map((s) => s.id), teamId, websiteIds },
    actor,
  });

  const ops = [];
  for (const site of sites) {
    for (const staff of staffList) {
      const { rows } = await query(
        "select wp_user_id, wp_role from website_user_assignments where staff_user_id=$1 and website_id=$2",
        [staff.id, site.id]
      );
      ops.push({ staff, site, requestedRole: rows[0]?.wp_role || "subscriber", wpUserId: rows[0]?.wp_user_id || null });
    }
  }

  runRemovals(job.id, ops, actor)
    .then(() => finalizeJob(job.id))
    .catch(async (err) => {
      console.error("[sync] removal job failed:", err);
      await query("update user_sync_jobs set status='failed', finished_at=now() where id=$1", [job.id]);
    });

  return { jobId: job.id, operations: ops.length, sites: sites.length, people: staffList.length };
}

async function runRemovals(jobId, ops, actor) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, ops.length) }, async () => {
    while (cursor < ops.length) {
      const op = ops[cursor++];
      const { id, key } = await recordOperation(jobId, op, "unlink");
      await query("update user_sync_operations set status='processing', started_at=now() where id=$1", [id]);

      if (!op.wpUserId) {
        await finishOperation(id, { status: "skipped", result: { reason: "no account recorded here" }, attempt: 0 });
        continue;
      }
      try {
        const data = await callSite(op.site, {
          method: "POST", route: `/users/${op.wpUserId}/unlink`,
          idempotencyKey: key, timeoutMs: SITE_TIMEOUT_MS, body: {},
        });
        await finishOperation(id, { status: "removed", result: data, attempt: 1 });
        await query(
          `update website_user_assignments set state='removed', managed=false, updated_at=now()
            where staff_user_id=$1 and website_id=$2`,
          [op.staff.id, op.site.id]
        );
        await audit.record({
          ...actor, action: "wpuser.unlink", entityType: "staff_user", entityId: op.staff.id,
          websiteId: op.site.id, targetEmail: op.staff.email,
          after: { wpUserId: op.wpUserId, note: "account left in place, no longer managed" },
        });
      } catch (err) {
        await finishOperation(id, {
          status: "failed", errorCode: err.code || "failed", error: err.message, attempt: 1,
        });
      }
    }
  });
  await Promise.all(workers);
}

/* ---------------------------------------------------------- job reading --- */

export async function getJob(jobId) {
  const { rows: jobs } = await query("select * from user_sync_jobs where id = $1", [jobId]);
  if (!jobs[0]) return null;
  const job = jobs[0];

  const { rows: ops } = await query(
    `select o.id, o.website_id, o.staff_user_id, o.action, o.status, o.attempt,
            o.requested_role, o.error_code, o.error, o.warnings, o.result,
            o.started_at, o.finished_at,
            w.name as website_name, s.email as staff_email,
            coalesce(s.display_name, s.email) as staff_label
       from user_sync_operations o
       left join websites w on w.id = o.website_id
       left join staff_users s on s.id = o.staff_user_id
      where o.job_id = $1
      order by w.name asc nulls last, s.email asc`,
    [jobId]
  );

  const counts = {};
  for (const o of ops) counts[o.status] = (counts[o.status] || 0) + 1;

  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    initiatedEmail: job.initiated_email,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    totals: job.totals,
    counts,
    done: ["done", "partial", "failed", "interrupted"].includes(job.status),
    operations: ops.map((o) => ({
      id: o.id,
      websiteId: o.website_id,
      websiteName: o.website_name,
      staffUserId: o.staff_user_id,
      staffEmail: o.staff_email,
      staffLabel: o.staff_label,
      action: o.action,
      status: o.status,
      attempt: o.attempt,
      requestedRole: o.requested_role,
      errorCode: o.error_code,
      error: o.error,
      warnings: o.warnings || [],
      replayed: o.result?.replayed === true,
      startedAt: o.started_at,
      finishedAt: o.finished_at,
    })),
  };
}

/**
 * Retries a job's failed operations, and only those.
 *
 * A successful operation is never re-run — that is the whole point of recording
 * them. The retry reuses each operation's original idempotency key, so anything
 * that actually did apply before the failure is replayed rather than repeated.
 */
export async function retryJob(jobId, actor) {
  const { rows } = await query(
    `select o.*, w.id as site_exists from user_sync_operations o
       left join websites w on w.id = o.website_id
      where o.job_id = $1 and o.status in ('failed','interrupted')`,
    [jobId]
  );
  if (!rows.length) return { retried: 0 };

  const ops = [];
  for (const row of rows) {
    const staff = await getStaff(row.staff_user_id);
    const site = row.website_id ? await getWebsiteSite(row.website_id) : null;
    if (!staff || !site) continue;
    ops.push({ row, staff, site });
  }

  await query("update user_sync_jobs set status='running', finished_at=null where id=$1", [jobId]);

  // Re-plan rather than replaying the old decision: the site may have been
  // updated, enrolled or had its roles changed since the failure, which is
  // usually WHY the retry is being pressed.
  const staffList = [...new Map(ops.map((o) => [o.staff.id, o.staff])).values()];
  const sites = [...new Map(ops.map((o) => [o.site.id, o.site])).values()];
  const job = await query("select params from user_sync_jobs where id=$1", [jobId]);
  const params = job.rows[0]?.params || {};

  const planned = await planAssignment({
    staffList, sites,
    roleOverrides: params.roleOverrides || {},
    confirmations: params.confirmations || {},
  });
  // Only the pairs that actually failed.
  const wanted = new Set(ops.map((o) => `${o.site.id}:${o.staff.id}`));
  const toRun = planned.filter((p) => wanted.has(`${p.site.id}:${p.staff.id}`));

  runOperations(jobId, toRun, actor)
    .then(() => finalizeJob(jobId))
    .catch((err) => console.error("[sync] retry failed:", err));

  return { retried: toRun.length };
}

/**
 * Boot-time recovery.
 *
 * An operation still 'processing' long after the process that owned it died is
 * not in progress — it is a casualty of a restart. Marking it 'interrupted'
 * makes that visible and retryable, instead of leaving a job that never
 * finishes and a spinner that never stops.
 */
export async function sweepInterruptedOperations({ olderThanMs = STALE_PROCESSING_MS } = {}) {
  const { rowCount } = await query(
    `update user_sync_operations
        set status = 'interrupted',
            error_code = 'interrupted',
            error = 'The server restarted while this was running. It is safe to retry.',
            finished_at = now()
      where status = 'processing'
        and coalesce(started_at, now()) < now() - ($1::bigint * interval '1 millisecond')`,
    [Math.round(olderThanMs)]
  );
  if (rowCount) {
    await query(
      `update user_sync_jobs set status = 'interrupted', finished_at = coalesce(finished_at, now())
        where status = 'running'
          and not exists (select 1 from user_sync_operations o
                           where o.job_id = user_sync_jobs.id and o.status in ('pending','processing'))`
    );
    console.log(`[sync] marked ${rowCount} interrupted operation(s) from a previous run as retryable`);
  }
  return rowCount;
}

async function loadStaff(staffUserIds, teamId) {
  let ids = [...(staffUserIds || [])];
  if (teamId) {
    const { rows } = await query("select id from staff_users where team_id = $1 and status = 'active' order by email", [teamId]);
    ids = [...new Set([...ids, ...rows.map((r) => r.id)])];
  }
  const out = [];
  for (const id of ids) {
    const s = await getStaff(id);
    // Disabled people are excluded here as well as blocked at prediction time:
    // a team assignment shouldn't quietly include someone who was switched off.
    if (s && s.status === "active") out.push(s);
  }
  return out;
}
