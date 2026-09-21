// The API a connected website calls.
//
// Mounted at /api/site/v1 behind verifySiteRequest, so every handler below can
// assume req.site is real and signed for. Note what is absent from every route:
// a website id. Identity comes from the credential, so these handlers can only
// ever act on the caller's own site — a site cannot read or change another's
// data because there is no way for it to name one.
//
// The plugin is a thin client. Nothing here is a second implementation of
// anything: preflight and assignment call the same runPreflight() and
// startAssignment() the dashboard uses, so the guards, the idempotency, the
// audit rows and the set-password email are the same code, not a parallel copy
// that drifts.

import express from "express";

import { requireSiteScope } from "../usermgmt/siteAuth.js";
import { buildSiteRoster, assertStaffSelectable } from "../usermgmt/siteRoster.js";
import { runPreflight } from "../usermgmt/preflight.js";
import { startAssignment, getJob } from "../usermgmt/sync.js";
import { getSiteRoles } from "../usermgmt/roles.js";
import { getCapabilities } from "../usermgmt/capabilities.js";
import { getWebsiteSite, query } from "../db.js";
import { getStaffByEmail } from "../usermgmt/staffUsers.js";
import * as audit from "../usermgmt/audit.js";

export const router = express.Router();

const AGENCY_DOMAIN = "digitalelementsgroup.com";

function fail(res, err, status = 400) {
  const message = err && err.message ? err.message : "Request failed.";
  return res.status(status).json({ ok: false, error: { code: err?.code || "failed", message } });
}
const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("[siteApi]", err.message);
  return fail(res, { message: "Something went wrong. Please try again." }, 500);
});

/**
 * Who the plugin says is acting, checked against the roster.
 *
 * The claimed address is a LABEL FOR THE AUDIT LOG, never authorization —
 * authorization is the signed credential plus the hub's own rules. Resolving it
 * against staff_users limits a compromised site to impersonating a real
 * colleague rather than inventing an actor, which is modest but free.
 */
async function resolveActor(req) {
  const claimed = String(req.body?.actorEmail || "").trim().toLowerCase();
  if (!claimed || !claimed.endsWith(`@${AGENCY_DOMAIN}`)) return null;
  const staff = await getStaffByEmail(claimed);
  if (!staff || staff.status !== "active") return null;
  return { email: staff.email, staffUserId: staff.id };
}

function actorFor(req, actor) {
  return {
    actorUserId: null,          // no dashboard session — this came from a site
    actorEmail: actor?.email || null,
    ip: req.ip,
  };
}

/* ------------------------------------------------------------------ roster */

router.get("/roster", requireSiteScope("users:read"), asyncRoute(async (req, res) => {
  const site = await getWebsiteSite(req.site.id);
  if (!site) return fail(res, { code: "unknown_site", message: "This website is no longer registered." }, 404);

  const [roster, caps] = await Promise.all([
    buildSiteRoster(req.site.id),
    getCapabilities(site),
  ]);
  // Cached; the plugin's Refresh maps to ?refresh=1 on its own transient, and
  // the roles here come from the same cache the dashboard uses.
  const roles = await getSiteRoles(site, { force: req.query.refresh === "1" });

  await audit.record({
    action: "site.roster_read", entityType: "website", entityId: req.site.id,
    websiteId: req.site.id, ip: req.ip,
    after: { members: roster.counts.members, via: "plugin" },
  });

  res.json({
    ok: true,
    site: { name: site.name },
    teams: roster.teams,
    counts: roster.counts,
    // What this site will actually accept, so the plugin can grey out a role
    // rather than offering something that fails at preflight.
    siteRoles: roles.roles.map((r) => ({ slug: r.slug, name: r.name, siteAdmin: r.siteAdmin === true })),
    scopes: req.site.scopes,
    // Whether the DASHBOARD permits this site's plugin to assign staff. The
    // plugin cannot know this on its own — plugin:assign is hub-controlled and
    // deliberately never reported by the plugin — so without it the panel could
    // only discover a revoke by having a submission refused. Reported here so
    // the site renders "not permitted" up front instead of after someone has
    // picked people.
    canAssign: req.site.effectiveScopes.includes("plugin:assign"),
    readiness: caps.readiness,
    generatedAt: new Date().toISOString(),
  });
}));

/* --------------------------------------------------------------- preflight */

router.post("/preflight", requireSiteScope("users:read"), asyncRoute(async (req, res) => {
  const b = req.body || {};
  let staffUserIds;
  try { staffUserIds = await assertStaffSelectable(b.staffUserIds); }
  catch (err) { return fail(res, err); }

  const roleOverrides = {};
  // Keyed by website id in the shared planner; the site can only ever mean
  // itself, so its own id is filled in here rather than accepted from the body.
  if (b.role) roleOverrides[req.site.id] = String(b.role);

  try {
    const result = await runPreflight({ staffUserIds, websiteIds: [req.site.id], roleOverrides });
    res.json({ ok: true, rows: result.rows, summary: result.summary });
  } catch (err) { return fail(res, err); }
}));

/* ------------------------------------------------------------------ assign */

router.post("/assign", requireSiteScope("plugin:assign"), asyncRoute(async (req, res) => {
  const b = req.body || {};

  // Required, and signed: an unsigned key could be stripped in transit, turning
  // a safe retry into a second job that assigns everybody twice.
  if (!req.site.idempotencyKey) {
    return fail(res, { code: "idempotency_required", message: "This request needs an Idempotency-Key header." });
  }
  if (!req.site.effectiveScopes.includes("users:write")) {
    return fail(res, { code: "scope_denied", message: "This website hasn't allowed accounts to be created from the dashboard." }, 403);
  }

  const actor = await resolveActor(req);
  if (!actor) {
    return fail(res, { code: "unknown_actor", message: "The person making this request isn't on the Digital Elements roster." }, 403);
  }

  let staffUserIds;
  try { staffUserIds = await assertStaffSelectable(b.staffUserIds); }
  catch (err) { return fail(res, err); }

  const roleOverrides = {};
  if (b.role) roleOverrides[req.site.id] = String(b.role);

  // Namespaced by site so two sites cannot collide on a client-chosen id, and
  // so one site can never replay another's job.
  const idempotencyKey = `site:${req.site.id}:${req.site.idempotencyKey}`;

  try {
    const job = await startAssignment({
      staffUserIds,
      websiteIds: [req.site.id],
      roleOverrides,
      confirmations: { admin: b.confirmAdmin === true },
      // Never from a site. The agency-domain rule is a deliberate dashboard
      // decision with its own audit trail, and assertStaffSelectable has
      // already excluded external addresses from the roster entirely.
      overrideDomain: false,
      idempotencyKey,
      originWebsiteId: req.site.id,
    }, actorFor(req, actor));

    await audit.record({
      ...actorFor(req, actor),
      action: "wpusers.assign_started",
      entityType: "sync_job", entityId: job.jobId, websiteId: req.site.id,
      after: {
        via: "plugin",
        site: req.site.name,
        actingWpUser: actor.email,
        members: staffUserIds.length,
        role: b.role || null,
        confirmAdmin: b.confirmAdmin === true,
        replayed: job.replayed === true,
      },
    });

    res.json({ ok: true, jobId: job.jobId, operations: job.operations, replayed: job.replayed === true });
  } catch (err) { return fail(res, err); }
}));

/* -------------------------------------------------------------------- jobs */

/**
 * Progress for a job this site started.
 *
 * Scoped by origin_website_id, and a job belonging to anyone else is reported
 * as NOT FOUND rather than forbidden — a site should not be able to learn that
 * another site's job exists.
 */
router.get("/jobs/:id", requireSiteScope("users:read"), asyncRoute(async (req, res) => {
  const { rows } = await query(
    "select id from user_sync_jobs where id = $1 and origin_website_id = $2",
    [req.params.id, req.site.id]
  );
  if (!rows.length) return fail(res, { code: "not_found", message: "No such job." }, 404);

  const job = await getJob(req.params.id);
  if (!job) return fail(res, { code: "not_found", message: "No such job." }, 404);

  res.json({
    ok: true,
    job: {
      id: job.id, status: job.status, done: job.done, counts: job.counts,
      createdAt: job.createdAt, finishedAt: job.finishedAt,
      // Only this site's operations, and only the fields the plugin renders.
      operations: job.operations
        .filter((o) => o.websiteId === req.site.id)
        .map((o) => ({
          staffEmail: o.staffEmail, staffLabel: o.staffLabel,
          action: o.action, status: o.status, attempt: o.attempt,
          requestedRole: o.requestedRole,
          errorCode: o.errorCode, error: o.error,
          warnings: o.warnings, replayed: o.replayed,
        })),
    },
  });
}));

export default router;
