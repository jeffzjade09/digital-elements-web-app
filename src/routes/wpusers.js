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
import { wpUserManagers, setWpUserManagers } from "../usermgmt/grants.js";
import { requirePerm } from "../auth.js";

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
router.get("/roles", (req, res) => {
  res.json({ ok: true, roles: CORE_ROLES, source: "core" });
});

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
    });
    if (!result) return res.status(404).json({ ok: false, error: "That team no longer exists." });
    await audit.record({
      ...audit.actorFrom(req),
      action: "team.delete", entityType: "team", entityId: req.params.id,
      before: result.team,
      after: { disposition: result.disposition, membersHandled: result.membersHandled, movedToTeamId: result.movedToTeamId },
    });
    res.json({ ok: true, ...result });
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

// --------------------------------------------------------------------- audit
router.get("/audit", asyncRoute(async (req, res) => {
  const entries = await audit.list({
    entityType: String(req.query.entityType || "").trim() || undefined,
    entityId: String(req.query.entityId || "").trim() || undefined,
    websiteId: String(req.query.website || "").trim() || undefined,
    actorEmail: String(req.query.actor || "").trim() || undefined,
    action: String(req.query.action || "").trim() || undefined,
    limit: req.query.limit,
  });
  res.json({ ok: true, entries });
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
