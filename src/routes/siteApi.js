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
import { resolveActingStaff, actorRefusalMessage, ACTOR_REFUSALS } from "../usermgmt/siteActor.js";
import { autoLinkActingUser } from "../usermgmt/autoLink.js";
import * as audit from "../usermgmt/audit.js";

export const router = express.Router();

function fail(res, err, status = 400) {
  const message = err && err.message ? err.message : "Request failed.";
  return res.status(status).json({ ok: false, error: { code: err?.code || "failed", message } });
}
const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("[siteApi]", err.message);
  return fail(res, { message: "Something went wrong. Please try again." }, 500);
});

/**
 * Who the plugin says is acting, resolved against the roster AND their team.
 *
 * Required on every route. A site that omits it is refused rather than treated
 * as anonymous — otherwise the team restriction below could be sidestepped by
 * leaving a field out, which is not a rule at all.
 *
 * The claimed address is set by whoever administers the WordPress site, so this
 * is a mistake-guard and a visibility control, not a boundary against a
 * malicious site administrator. src/usermgmt/siteActor.js says what does bound
 * the damage, and why the team restriction is the useful part.
 *
 * Refuses by calling res itself and returning null, so each route reads as one
 * line: get the actor, or stop.
 */
async function requireActor(req, res) {
  const result = await resolveActingStaff(req.body?.actorEmail);
  if (result.ok) return result;

  await audit.record({
    action: "site.actor_refused", entityType: "website", entityId: req.site.id,
    websiteId: req.site.id, ip: req.ip, result: "refused",
    targetEmail: result.email || null,
    after: {
      reason: result.reason, via: "plugin", route: req.path,
      team: result.team || null, site: req.site.name,
    },
  });

  // A missing actor means an out-of-date plugin, which is a different fix from
  // "you aren't allowed", so it gets its own code and its own message.
  const code = result.reason === ACTOR_REFUSALS.MISSING
    ? "plugin_update_required"
    : result.reason;
  fail(res, { code, message: actorRefusalMessage(result.reason) }, 403);
  return null;
}

function actorFor(req, actor) {
  return {
    actorUserId: null,          // no dashboard session — this came from a site
    actorEmail: actor?.email || null,
    ip: req.ip,
  };
}

/* ------------------------------------------------------------------ roster */

// POST, not GET, for two reasons: the acting person travels in the body, where
// the signature already covers it byte for byte (a query string would have to
// canonicalise identically in PHP and JS to produce a matching signature), and
// this call now has a deliberate side effect — the first visit adopts the
// caller's own account.
//
// GET is kept below, answering only "your plugin is out of date", so a site on
// 2.7.0 gets an instruction instead of a 404.
router.post("/roster", requireSiteScope("users:read"), asyncRoute(async (req, res) => {
  const actor = await requireActor(req, res);
  if (!actor) return;

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
    websiteId: req.site.id, ip: req.ip, actorEmail: actor.email,
    after: { members: roster.counts.members, via: "plugin", team: actor.team },
  });

  // Adopt the caller's own pre-existing account, once. Deliberately after the
  // roster is built and never allowed to fail the request: access is the gate,
  // and a link that the site refuses — because it hasn't granted users:admin —
  // must not close a panel the person is entitled to use.
  let autoLink = null;
  if (req.body?.actorManaged === false) {
    autoLink = await autoLinkActingUser({
      site, actor, wpUserId: req.body?.actorWpUserId, ip: req.ip,
    });
  }

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
    // Echoed so the panel can name the person and their team, and say whether
    // their account was adopted on this visit.
    actor: {
      email: actor.email, team: actor.team, teamSlug: actor.teamSlug,
      linked: autoLink ? autoLink.linked : null,
      linkReason: autoLink ? autoLink.reason : null,
    },
    generatedAt: new Date().toISOString(),
  });
}));

/**
 * The 2.7.0 shape of this route.
 *
 * Answered explicitly rather than left to 404, because "your plugin is out of
 * date" and "this route doesn't exist" look identical to a site otherwise, and
 * only one of them has an action attached.
 */
router.get("/roster", asyncRoute(async (req, res) => {
  return fail(res, {
    code: "plugin_update_required",
    message: "This website's Digital Elements plugin is out of date. Update it to 2.7.1 or later.",
  }, 403);
}));

/* --------------------------------------------------------------- preflight */

router.post("/preflight", requireSiteScope("users:read"), asyncRoute(async (req, res) => {
  const actor = await requireActor(req, res);
  if (!actor) return;

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

  const actor = await requireActor(req, res);
  if (!actor) return;

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
        actingTeam: actor.team,
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
// Left as a GET with no actor: it reports only on a job this site already
// started, the check below scopes it to that, and polling it is not an action.
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
