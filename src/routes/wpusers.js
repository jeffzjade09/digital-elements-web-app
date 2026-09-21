// Centralized WordPress user management — HTTP layer.
//
// Deliberately thin: every handler validates input, calls a module in
// src/usermgmt/, writes an audit row, and shapes a response. No business logic
// lives here, so the modules underneath can move to Nexus with a new router
// rather than a rewrite.
//
// Mounting (see server.js) applies requireAuth + requirePerm("manageWpUsers")
// + rate limiting to everything below, so individual routes don't repeat it.

import express from "express";

import * as teams from "../usermgmt/teams.js";
import * as staff from "../usermgmt/staffUsers.js";
import * as audit from "../usermgmt/audit.js";
import { CORE_ROLES } from "../usermgmt/roles.js";
import { getKnownRoles } from "../usermgmt/roles.js";
import { wpUserManagers, setWpUserManagers } from "../usermgmt/grants.js";
import { requirePerm } from "../auth.js";
import * as credentials from "../usermgmt/credentials.js";
import { getCapabilities, getCapabilitiesForAll, REQUIRED_API_VERSION, READINESS } from "../usermgmt/capabilities.js";
import { getSiteRoles } from "../usermgmt/roles.js";
import { runPreflight } from "../usermgmt/preflight.js";
import { startAssignment, startRemoval, startDeletion, getJob, retryJob } from "../usermgmt/sync.js";
import { getContentOwnership, reassignContent, planDeletion } from "../usermgmt/contentOwnership.js";
import { getWebsites, getWebsiteSite, query } from "../db.js";

export const router = express.Router();

// Turns a thrown error into a response. Validation failures raised by the
// modules carry messages written for an administrator, so they are safe to
// show; anything unexpected is logged and reported generically rather than
// leaking database or server detail.
function fail(res, err, fallbackStatus = 400) {
  if (err && err.code === "domain_restricted") {
    return res.status(409).json({ ok: false, code: "domain_restricted", error: err.message });
  }
  // Postgres error codes start with a digit; those are never user-facing.
  if (err && typeof err.code === "string" && /^\d/.test(err.code)) {
    console.error("[wpusers]", err.code, err.message);
    return res.status(500).json({ ok: false, error: "Something went wrong saving that. Please try again." });
  }
  if (!err || !err.message) {
    return res.status(500).json({ ok: false, error: "Unexpected error" });
  }
  return res.status(fallbackStatus).json({ ok: false, error: err.message });
}

const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => fail(res, err, 500));

// ---------------------------------------------------------------- vocabulary
// The role list the UI's dropdowns are built from. Per-website custom roles are
// added by the phase that can ask a site what roles it actually has.
router.get("/roles", asyncRoute(async (req, res) => {
  // The core five plus every role discovered on a connected website, so a
  // client's custom role (seo_editor, shop_manager) can be chosen as a default
  // without a code change. The per-site availability check still runs at
  // preflight — this is what is offerable, not what exists everywhere.
  try {
    const known = await getKnownRoles();
    res.json({ ok: true, roles: known.roles, siteTotal: known.siteTotal, source: "discovered" });
  } catch (err) {
    // The role cache is a convenience. If it can't be read, the dropdowns fall
    // back to the roles every WordPress install has rather than going blank.
    console.error("[wpusers] role discovery failed, falling back to core:", err.message);
    res.json({
      ok: true,
      roles: CORE_ROLES.map((r) => ({ ...r, siteAdmin: r.slug === "administrator", siteCount: 0, core: true })),
      siteTotal: 0, source: "core",
    });
  }
}));

// --------------------------------------------------------------------- teams
router.get("/teams", asyncRoute(async (req, res) => {
  res.json({ ok: true, teams: await teams.listTeams() });
}));

router.post("/teams", asyncRoute(async (req, res) => {
  const b = req.body || {};
  try {
    const team = await teams.createTeam(
      { name: b.name, description: b.description, defaultWpRole: b.defaultWpRole },
      req.user.id
    );
    await audit.record({
      ...audit.actorFrom(req),
      action: "team.create", entityType: "team", entityId: team.id, after: team,
    });
    res.json({ ok: true, team });
  } catch (err) { return fail(res, err); }
}));

router.put("/teams/:id", asyncRoute(async (req, res) => {
  const b = req.body || {};
  try {
    const before = await teams.getTeam(req.params.id);
    if (!before) return res.status(404).json({ ok: false, error: "That team no longer exists." });
    const team = await teams.updateTeam(req.params.id, {
      name: b.name, description: b.description, defaultWpRole: b.defaultWpRole,
    });
    await audit.record({
      ...audit.actorFrom(req),
      action: "team.update", entityType: "team", entityId: team.id, before, after: team,
    });
    res.json({ ok: true, team });
  } catch (err) { return fail(res, err); }
}));

/**
 * Deleting a team never deletes anyone's WordPress account. The caller must say
 * what happens to the members — `onUsers` is 'unassign' or 'move' (with
 * `moveToTeamId`) — and the UI asks before sending.
 */
router.delete("/teams/:id", asyncRoute(async (req, res) => {
  const b = req.body || {};
  try {
    const result = await teams.deleteTeam(req.params.id, {
      onUsers: b.onUsers,
      moveToTeamId: b.moveToTeamId,
      onAssignments: b.onAssignments,
    });
    if (!result) return res.status(404).json({ ok: false, error: "That team no longer exists." });

    // 'remove' releases our management of those accounts. It does NOT delete a
    // WordPress account — that is a separate per-site operation with its own
    // content checks, and folding one into the other would be the most
    // dangerous shortcut in this feature.
    let unlinkJob = null;
    if (result.toUnlink.length) {
      const byStaff = new Map();
      for (const { staffUserId, websiteId } of result.toUnlink) {
        if (!byStaff.has(staffUserId)) byStaff.set(staffUserId, []);
        byStaff.get(staffUserId).push(websiteId);
      }
      unlinkJob = await startRemoval({
        staffUserIds: [...byStaff.keys()],
        websiteIds: [...new Set(result.toUnlink.map((u) => u.websiteId))],
      }, audit.actorFrom(req));
    }

    await audit.record({
      ...audit.actorFrom(req),
      action: "team.delete", entityType: "team", entityId: req.params.id,
      before: { team: result.team, assignments: result.assignmentCount },
      after: {
        disposition: result.disposition,
        membersHandled: result.membersHandled,
        movedToTeamId: result.movedToTeamId,
        assignmentDisposition: result.assignmentDisposition,
        unlinked: result.toUnlink.length,
        deletedWordPressAccounts: false,
      },
    });
    res.json({ ok: true, ...result, unlinkJob });
  } catch (err) { return fail(res, err); }
}));

// --------------------------------------------------------------------- users
router.get("/users", asyncRoute(async (req, res) => {
  const users = await staff.listStaff({
    q: String(req.query.q || "").trim() || undefined,
    teamId: req.query.team || undefined,
    unassigned: req.query.team === "none",
    status: ["active", "disabled"].includes(req.query.status) ? req.query.status : undefined,
    role: String(req.query.role || "").trim() || undefined,
  });
  res.json({ ok: true, users });
}));

router.post("/users", asyncRoute(async (req, res) => {
  const b = req.body || {};
  try {
    const user = await staff.createStaff({
      email: b.email, firstName: b.firstName, lastName: b.lastName, displayName: b.displayName,
      teamId: b.teamId, defaultWpRole: b.defaultWpRole, status: b.status,
      overrideDomain: b.overrideDomain === true,
    }, req.user.id);
    await audit.record({
      ...audit.actorFrom(req),
      action: user.domainOverride ? "staff.create.domain_override" : "staff.create",
      entityType: "staff_user", entityId: user.id, targetEmail: user.email, after: user,
    });
    res.json({ ok: true, user });
  } catch (err) { return fail(res, err); }
}));

router.put("/users/:id", asyncRoute(async (req, res) => {
  const b = req.body || {};
  try {
    const before = await staff.getStaff(req.params.id);
    if (!before) return res.status(404).json({ ok: false, error: "That person is no longer on the roster." });
    const user = await staff.updateStaff(req.params.id, {
      email: b.email, firstName: b.firstName, lastName: b.lastName, displayName: b.displayName,
      teamId: b.teamId, defaultWpRole: b.defaultWpRole, status: b.status,
      overrideDomain: b.overrideDomain === true,
    });
    await audit.record({
      ...audit.actorFrom(req),
      action: "staff.update", entityType: "staff_user", entityId: user.id,
      targetEmail: user.email, before, after: user,
    });
    res.json({ ok: true, user });
  } catch (err) { return fail(res, err); }
}));

/**
 * Removes someone from the roster only. Their WordPress accounts are untouched
 * — removing those is a separate operation with content-ownership checks, and
 * the UI says so before this is called.
 */
router.delete("/users/:id", asyncRoute(async (req, res) => {
  const user = await staff.deleteStaff(req.params.id);
  if (!user) return res.status(404).json({ ok: false, error: "That person is no longer on the roster." });
  await audit.record({
    ...audit.actorFrom(req),
    action: "staff.delete", entityType: "staff_user", entityId: user.id,
    targetEmail: user.email, before: user,
  });
  res.json({ ok: true, user });
}));

// Bulk team move, used by the Users table's multi-select.
router.post("/users/move-team", asyncRoute(async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: "Select at least one person to move." });
  try {
    const moved = await staff.moveToTeam(ids, b.teamId || null);
    await audit.record({
      ...audit.actorFrom(req),
      action: "staff.move_team", entityType: "staff_user", entityId: moved.join(","),
      after: { teamId: b.teamId || null, count: moved.length },
    });
    res.json({ ok: true, moved: moved.length, users: await staff.listStaff({}) });
  } catch (err) { return fail(res, err); }
}));

// ------------------------------------------------------------------ websites
// Which connected sites can be used for user management, and why not when they
// can't. Every screen that offers a site to select reads this, so "needs a
// plugin update" and "needs enrolling" are shown BEFORE anything is submitted
// rather than discovered as a failure halfway through a bulk run.
router.get("/websites", asyncRoute(async (req, res) => {
  if (!credentials.isConfigured()) {
    return res.json({ ok: true, configured: false, websites: [], requiredApiVersion: REQUIRED_API_VERSION });
  }
  const sites = await getWebsites();
  const force = req.query.refresh === "1";
  const caps = await getCapabilitiesForAll(sites, { force });
  res.json({ ok: true, configured: true, requiredApiVersion: REQUIRED_API_VERSION, websites: caps });
}));

router.get("/websites/:id/capabilities", asyncRoute(async (req, res) => {
  const site = await getWebsiteSite(req.params.id);
  if (!site) return res.status(404).json({ ok: false, error: "Unknown website." });
  res.json({ ok: true, capabilities: await getCapabilities(site, { force: req.query.refresh === "1" }) });
}));

/**
 * Issues a one-time enrollment code for a site.
 *
 * The code is returned once, to be shown to the administrator who will paste it
 * into that site's DE Monitoring panel. Issuing a code grants nothing on its
 * own — the site must also present its own license key to redeem it.
 */
router.post("/websites/:id/enrollment-code", asyncRoute(async (req, res) => {
  const site = await getWebsiteSite(req.params.id);
  if (!site) return res.status(404).json({ ok: false, error: "Unknown website." });
  try {
    const issued = await credentials.issueEnrollmentCode(site.id, req.user.id);
    await audit.record({
      ...audit.actorFrom(req),
      action: "site.enrollment_code_issued", entityType: "website", entityId: site.id,
      websiteId: site.id, after: { expiresAt: issued.expiresAt },
    });
    res.json({ ok: true, site: { id: site.id, name: site.name, url: site.url }, ...issued });
  } catch (err) { return fail(res, err); }
}));

/**
 * Rotates a site's credential by revoking the current one and issuing a fresh
 * enrollment code. Deliberately not a silent swap: the site has to store the
 * new secret, so rotation always ends with someone re-connecting it, and the
 * old secret is dead the moment this returns.
 */
router.post("/websites/:id/rotate-credential", asyncRoute(async (req, res) => {
  const site = await getWebsiteSite(req.params.id);
  if (!site) return res.status(404).json({ ok: false, error: "Unknown website." });
  try {
    await credentials.revokeCredential(site.id);
    const issued = await credentials.issueEnrollmentCode(site.id, req.user.id);
    await audit.record({
      ...audit.actorFrom(req),
      action: "site.credential_rotated", entityType: "website", entityId: site.id,
      websiteId: site.id, after: { expiresAt: issued.expiresAt },
    });
    res.json({ ok: true, site: { id: site.id, name: site.name, url: site.url }, ...issued });
  } catch (err) { return fail(res, err); }
}));

/**
 * Grants or revokes what the DASHBOARD permits a site to do — currently whether
 * its plugin may assign staff to itself.
 *
 * Separate from the permissions a site grants us, which are set in that site's
 * own DE Monitoring panel and reported on every probe. This one is ours, and
 * turning it off here stays off: no probe can put it back.
 */
router.put("/websites/:id/hub-scopes", asyncRoute(async (req, res) => {
  const site = await getWebsiteSite(req.params.id);
  if (!site) return res.status(404).json({ ok: false, error: "Unknown website." });
  const b = req.body || {};
  const scopes = [];
  if (b.pluginAssign === true) scopes.push("plugin:assign");

  try {
    const before = await getCapabilities(site);
    const credential = await credentials.setHubScopes(site.id, scopes);
    await audit.record({
      ...audit.actorFrom(req),
      action: "site.hub_scopes_changed", entityType: "website", entityId: site.id, websiteId: site.id,
      before: { hubScopes: before.hubScopes || [] },
      after: { hubScopes: credential?.hubScopes || [] },
    });
    res.json({ ok: true, credential });
  } catch (err) { return fail(res, err); }
}));

// Revokes without reissuing. Monitoring is unaffected; only user management
// stops working for that site.
router.post("/websites/:id/revoke-credential", asyncRoute(async (req, res) => {
  const site = await getWebsiteSite(req.params.id);
  if (!site) return res.status(404).json({ ok: false, error: "Unknown website." });
  await credentials.revokeCredential(site.id);
  await audit.record({
    ...audit.actorFrom(req),
    action: "site.credential_revoked", entityType: "website", entityId: site.id, websiteId: site.id,
  });
  res.json({ ok: true, capabilities: await getCapabilities(site, { force: true }) });
}));

/**
 * The roles this site will actually accept.
 *
 * Read from the site, not assumed: plugins add roles freely and
 * get_editable_roles() is where owners restrict what may be assigned. Served
 * from a cache; `?refresh=1` re-asks the site.
 *
 * A site we can't reach returns its cached list with `stale: true` rather than
 * an error — an unreachable site shouldn't empty a role picker that worked a
 * minute ago.
 */
router.get("/websites/:id/roles", asyncRoute(async (req, res) => {
  const site = await getWebsiteSite(req.params.id);
  if (!site) return res.status(404).json({ ok: false, error: "Unknown website." });
  const result = await getSiteRoles(site, { force: req.query.refresh === "1" });
  res.json({ ok: true, ...result, site: { id: site.id, name: site.name, url: site.url } });
}));

// ----------------------------------------------------------------- preflight
/**
 * What WOULD happen for every (person × website) pair. Writes nothing.
 *
 * This is what the review screen renders, and it is the only thing standing
 * between a bulk assignment and discovering its problems one site at a time
 * half way through. Applying the plan is a separate, explicit call in the next
 * phase — there is deliberately no "preflight and go".
 */
router.post("/preflight", asyncRoute(async (req, res) => {
  const b = req.body || {};
  const staffUserIds = Array.isArray(b.staffUserIds) ? b.staffUserIds.filter(Boolean) : [];
  const websiteIds = Array.isArray(b.websiteIds) ? b.websiteIds.filter(Boolean) : [];
  const roleOverrides = b.roleOverrides && typeof b.roleOverrides === "object" ? b.roleOverrides : {};

  if (!staffUserIds.length && !b.teamId) {
    return res.status(400).json({ ok: false, error: "Select at least one person, or a team." });
  }
  if (!websiteIds.length) {
    return res.status(400).json({ ok: false, error: "Select at least one website." });
  }
  // Bounded so one request can't fan out across the whole estate. The cap is on
  // the pair count, which is what actually costs a round trip per site.
  if (staffUserIds.length * websiteIds.length > 500) {
    return res.status(400).json({ ok: false, error: "That's too many combinations to check at once. Narrow the selection." });
  }

  try {
    const result = await runPreflight({ staffUserIds, teamId: b.teamId || null, websiteIds, roleOverrides });
    res.json({ ok: true, ...result });
  } catch (err) { return fail(res, err); }
}));

// ---------------------------------------------------------------- apply ----
/**
 * Applies a reviewed plan. Returns as soon as the job exists; the work
 * continues in the background and the UI polls /jobs/:id.
 *
 * Confirmations are required HERE, not only in the UI. The plugin enforces its
 * own guards independently, so a caller that skips this one still can't assign
 * an administering role — but refusing early gives a clear message instead of a
 * wall of per-site failures.
 */
router.post("/assign", asyncRoute(async (req, res) => {
  const b = req.body || {};
  const staffUserIds = Array.isArray(b.staffUserIds) ? b.staffUserIds.filter(Boolean) : [];
  const websiteIds = Array.isArray(b.websiteIds) ? b.websiteIds.filter(Boolean) : [];

  if (!staffUserIds.length && !b.teamId) {
    return res.status(400).json({ ok: false, error: "Select at least one person, or a team." });
  }
  if (!websiteIds.length) {
    return res.status(400).json({ ok: false, error: "Select at least one website." });
  }

  try {
    const job = await startAssignment({
      staffUserIds,
      teamId: b.teamId || null,
      websiteIds,
      roleOverrides: b.roleOverrides && typeof b.roleOverrides === "object" ? b.roleOverrides : {},
      confirmations: { admin: b.confirmAdmin === true },
      overrideDomain: b.overrideDomain === true,
    }, audit.actorFrom(req));

    await audit.record({
      ...audit.actorFrom(req),
      action: "wpusers.assign_started", entityType: "sync_job", entityId: job.jobId,
      after: {
        people: job.people, sites: job.sites, operations: job.operations,
        confirmAdmin: b.confirmAdmin === true, overrideDomain: b.overrideDomain === true,
      },
    });
    res.json({ ok: true, ...job });
  } catch (err) { return fail(res, err); }
}));

/**
 * Stops managing people on websites.
 *
 * "Remove" means unlink: the WordPress account keeps its role, its content and
 * its access, and we simply stop managing it. Deleting the account needs the
 * content-ownership checks from the next phase, and is deliberately not
 * offered here — that is how content gets orphaned.
 */
router.post("/remove", asyncRoute(async (req, res) => {
  const b = req.body || {};
  const staffUserIds = Array.isArray(b.staffUserIds) ? b.staffUserIds.filter(Boolean) : [];
  const websiteIds = Array.isArray(b.websiteIds) ? b.websiteIds.filter(Boolean) : [];

  if (!staffUserIds.length && !b.teamId) {
    return res.status(400).json({ ok: false, error: "Select at least one person, or a team." });
  }
  if (!websiteIds.length) {
    return res.status(400).json({ ok: false, error: "Select at least one website." });
  }
  if (b.deleteAccounts) {
    return res.status(400).json({
      ok: false, code: "not_supported",
      error: "Deleting WordPress accounts isn't available yet — it needs the content-ownership checks. This removes our management of the account only.",
    });
  }

  try {
    const job = await startRemoval({ staffUserIds, teamId: b.teamId || null, websiteIds }, audit.actorFrom(req));
    await audit.record({
      ...audit.actorFrom(req),
      action: "wpusers.remove_started", entityType: "sync_job", entityId: job.jobId,
      after: { people: job.people, sites: job.sites, operations: job.operations },
    });
    res.json({ ok: true, ...job });
  } catch (err) { return fail(res, err); }
}));

// Polled by the progress view. Cheap enough for a 1.5s cadence: one row per
// operation, already indexed by job.
router.get("/jobs/:id", asyncRoute(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "That job no longer exists." });
  res.json({ ok: true, job });
}));

/**
 * Retries a job's failed operations, and only those.
 *
 * Successful ones are never re-run, and each retry reuses its original
 * idempotency key, so anything that did apply before the failure is replayed by
 * the site rather than applied twice.
 */
router.post("/jobs/:id/retry", asyncRoute(async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "That job no longer exists." });
  try {
    const result = await retryJob(req.params.id, audit.actorFrom(req));
    if (!result.retried) {
      return res.status(400).json({ ok: false, error: "Nothing in this job failed, so there's nothing to retry." });
    }
    await audit.record({
      ...audit.actorFrom(req),
      action: "wpusers.retry", entityType: "sync_job", entityId: req.params.id,
      after: { retried: result.retried },
    });
    res.json({ ok: true, ...result });
  } catch (err) { return fail(res, err); }
}));

// ------------------------------------------------------ content ownership --
/**
 * What an account owns on ONE website, and who could receive it.
 *
 * Per website on purpose: a person owns different things on each site, and one
 * site reporting "nothing here" says nothing about the other four.
 */
router.get("/content/:staffUserId/:websiteId", asyncRoute(async (req, res) => {
  try {
    const ownership = await getContentOwnership(req.params.staffUserId, req.params.websiteId);
    res.json({ ok: true, ownership });
  } catch (err) { return fail(res, err); }
}));

/**
 * Moves everything to another user on that site, then re-counts.
 *
 * The response carries the VERIFIED remaining count, not a claim that the move
 * ran. A non-zero remainder is a normal outcome the UI shows — the delete stays
 * locked either way.
 */
router.post("/content/:staffUserId/:websiteId/reassign", asyncRoute(async (req, res) => {
  const b = req.body || {};
  if (!b.targetId) return res.status(400).json({ ok: false, error: "Choose a user to receive this content." });
  try {
    const before = await getContentOwnership(req.params.staffUserId, req.params.websiteId);
    const result = await reassignContent(req.params.staffUserId, req.params.websiteId, b.targetId, audit.actorFrom(req));

    await audit.record({
      ...audit.actorFrom(req),
      action: "wpuser.content_reassigned",
      entityType: "staff_user", entityId: req.params.staffUserId,
      websiteId: req.params.websiteId, targetEmail: before.staffEmail,
      before: { owned: before.summary, total: before.total, comments: before.comments },
      after: { movedTo: result.target?.email || b.targetId, moved: result.moved, remaining: result.remaining, verified: result.verified },
      result: result.verified ? "ok" : "partial",
    });
    res.json({ ok: true, result });
  } catch (err) { return fail(res, err); }
}));

/**
 * Checks every selected website independently before any deletion is offered.
 * Writes nothing.
 */
router.post("/deletion-plan", asyncRoute(async (req, res) => {
  const b = req.body || {};
  const websiteIds = Array.isArray(b.websiteIds) ? b.websiteIds.filter(Boolean) : [];
  if (!b.staffUserId) return res.status(400).json({ ok: false, error: "Select a person." });
  if (!websiteIds.length) return res.status(400).json({ ok: false, error: "Select at least one website." });
  try {
    const plan = await planDeletion(b.staffUserId, websiteIds);
    res.json({ ok: true, ...plan });
  } catch (err) { return fail(res, err); }
}));

/**
 * Deletes accounts on selected websites, through the job system.
 *
 * Three independent guards stand between this call and a lost post: the plan
 * above, the re-check inside the job, and the plugin's own re-count at delete
 * time. Any one of them refusing stops the deletion.
 */
router.post("/delete-accounts", asyncRoute(async (req, res) => {
  const b = req.body || {};
  const staffUserIds = Array.isArray(b.staffUserIds) ? b.staffUserIds.filter(Boolean) : [];
  const websiteIds = Array.isArray(b.websiteIds) ? b.websiteIds.filter(Boolean) : [];

  if (!staffUserIds.length) return res.status(400).json({ ok: false, error: "Select at least one person." });
  if (!websiteIds.length) return res.status(400).json({ ok: false, error: "Select at least one website." });
  if (b.confirm !== "DELETE") {
    return res.status(400).json({ ok: false, error: "Type DELETE to confirm removing these accounts." });
  }
  if (websiteIds.length > 1 && b.confirmMultipleSites !== true) {
    return res.status(400).json({
      ok: false, code: "confirm_multiple_sites",
      error: `This deletes accounts on ${websiteIds.length} websites. Confirm that explicitly.`,
    });
  }

  try {
    const job = await startDeletion({
      staffUserIds, websiteIds,
      reassignTargets: b.reassignTargets && typeof b.reassignTargets === "object" ? b.reassignTargets : {},
      confirmed: true,
    }, audit.actorFrom(req));

    await audit.record({
      ...audit.actorFrom(req),
      action: "wpusers.delete_started", entityType: "sync_job", entityId: job.jobId,
      after: { people: job.people, sites: job.sites, operations: job.operations },
    });
    res.json({ ok: true, ...job });
  } catch (err) { return fail(res, err); }
}));

// --------------------------------------------------------------------- audit
/**
 * The activity log, filterable by entity, website, actor and action.
 *
 * Rows are passed through the redaction helper a SECOND time on the way out.
 * They were redacted when written, but an entry written by an earlier version —
 * or by a future caller that forgets — must still never render a secret, a
 * signature or an idempotency key in a browser.
 */
router.get("/audit", asyncRoute(async (req, res) => {
  const entries = await audit.list({
    entityType: String(req.query.entityType || "").trim() || undefined,
    entityId: String(req.query.entityId || "").trim() || undefined,
    websiteId: String(req.query.website || "").trim() || undefined,
    actorEmail: String(req.query.actor || "").trim() || undefined,
    action: String(req.query.action || "").trim() || undefined,
    limit: req.query.limit,
  });

  const safe = entries.map((e) => ({
    ...e,
    before: audit.redact(e.before),
    after: audit.redact(e.after),
  }));

  // Built from what is actually in the log rather than a hardcoded list, so a
  // new action type appears in the filter the first time it happens.
  const facets = await audit.facets();
  res.json({ ok: true, entries: safe, facets });
}));

/**
 * Every website assignment, flat.
 *
 * One small query rather than one request per person: the Users table needs to
 * filter and summarise by website and sync state, and doing that per row would
 * mean N requests to render one screen.
 */
router.get("/assignments", asyncRoute(async (req, res) => {
  const { rows } = await query(
    `select a.staff_user_id, a.website_id, a.wp_role, a.state, a.managed,
            a.last_error_code, a.last_synced_at, w.name as website_name
       from website_user_assignments a
       left join websites w on w.id = a.website_id
      order by w.name asc nulls last`
  );
  res.json({
    ok: true,
    assignments: rows.map((r) => ({
      staffUserId: r.staff_user_id,
      websiteId: r.website_id,
      websiteName: r.website_name,
      role: r.wp_role,
      state: r.state,
      managed: r.managed,
      errorCode: r.last_error_code,
      lastSyncedAt: r.last_synced_at,
    })),
  });
}));

// ---------------------------------------------------------------- sync status
/**
 * One view of where every connected site stands: readiness, plugin version,
 * scopes the site has granted, recent job outcomes, and anything left
 * interrupted by a restart.
 *
 * Assembled server-side so the UI makes one request instead of N, and so the
 * "needs updating" judgement is made in one place.
 */
router.get("/sync-status", asyncRoute(async (req, res) => {
  if (!credentials.isConfigured()) {
    return res.json({ ok: true, configured: false, sites: [], jobs: [], interrupted: 0 });
  }
  const sites = await getWebsites();
  const caps = await getCapabilitiesForAll(sites, { force: req.query.refresh === "1" });

  const { rows: assignmentRows } = await query(
    `select website_id, state, count(*)::int n
       from website_user_assignments group by website_id, state`
  );
  const byWebsite = new Map();
  for (const r of assignmentRows) {
    if (!byWebsite.has(r.website_id)) byWebsite.set(r.website_id, {});
    byWebsite.get(r.website_id)[r.state] = r.n;
  }

  const { rows: jobs } = await query(
    `select id, kind, status, initiated_email, totals, created_at, finished_at
       from user_sync_jobs order by created_at desc limit 20`
  );
  const { rows: stuck } = await query(
    `select count(*)::int n from user_sync_operations where status = 'interrupted'`
  );

  // Refused enrollments, surfaced here because a site that won't connect is
  // exactly the thing someone is looking at this page to diagnose — and the
  // plugin deliberately tells the site nothing useful.
  const { rows: refusals } = await query(
    `select website_id, after, at, ip
       from audit_log
      where action = 'site.enroll_refused' and at > now() - interval '7 days'
      order by at desc limit 20`
  );

  const withCounts = caps.map((c) => ({
    ...c,
    assignments: byWebsite.get(c.websiteId) || {},
    // Distinguishes "hasn't updated yet" from "can't be reached to find out",
    // which need completely different follow-up.
    needsPluginUpdate: c.readiness === READINESS.PLUGIN_UPDATE_REQUIRED,
    needsEnrollment: c.readiness === READINESS.NEEDS_ENROLLMENT,
  }));

  res.json({
    ok: true,
    configured: true,
    requiredApiVersion: REQUIRED_API_VERSION,
    sites: withCounts,
    jobs: jobs.map((j) => ({
      id: j.id, kind: j.kind, status: j.status,
      initiatedEmail: j.initiated_email, totals: j.totals,
      createdAt: j.created_at, finishedAt: j.finished_at,
    })),
    interrupted: stuck[0]?.n || 0,
    enrollmentFailures: refusals.map((r) => ({
      websiteId: r.website_id,
      reason: r.after?.reason || "unknown",
      explanation: r.after?.explanation || null,
      site: r.after?.site || null,
      reportedSiteUrl: r.after?.reportedSiteUrl || null,
      at: r.at,
    })),
    summary: {
      total: withCounts.length,
      ready: withCounts.filter((c) => c.ready).length,
      needsUpdate: withCounts.filter((c) => c.needsPluginUpdate).length,
      needsEnrollment: withCounts.filter((c) => c.needsEnrollment).length,
      unreachable: withCounts.filter((c) => c.readiness === READINESS.UNREACHABLE).length,
    },
  });
}));

// -------------------------------------------------------------------- grants
// Who holds manageWpUsers beyond the 'admin' dashboard role. Editing the list
// requires manageUsers (admin only) on purpose: a grantee must not be able to
// widen the grant to themselves or anyone else.
router.get("/grants", requirePerm("manageUsers"), (req, res) => {
  res.json({ ok: true, managers: wpUserManagers() });
});

router.put("/grants", requirePerm("manageUsers"), asyncRoute(async (req, res) => {
  const b = req.body || {};
  try {
    const before = wpUserManagers();
    const managers = await setWpUserManagers(b.managers);
    await audit.record({
      ...audit.actorFrom(req),
      action: "grants.update", entityType: "app_setting", entityId: "wp_user_managers",
      before: { managers: before }, after: { managers },
    });
    res.json({ ok: true, managers });
  } catch (err) { return fail(res, err); }
}));

export default router;
