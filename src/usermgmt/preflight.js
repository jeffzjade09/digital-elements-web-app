// Preflight: what WOULD happen, for every (person × website) pair.
//
// This is the contract behind the review screen. It writes nothing, on either
// side — it reads each site's roles and looks each person up, then predicts an
// action and lists whatever is blocking it.
//
// It exists because the alternative is discovering problems one site at a time,
// half way through a bulk run: a site on an old plugin, a role that doesn't
// exist there, or — the important one — an account that already belongs to the
// client and must not be silently adopted. All of that is surfaced before an
// administrator commits to anything.
//
// The predicted actions are deliberately the same vocabulary the sync phase
// reports back, so the review screen and the results screen line up.

import { getStaff } from "./staffUsers.js";
import { getSiteRoles, checkRoleAvailability, normalizeRoleSlug, isAdminLikeRole } from "./roles.js";
import { getCapabilities, READINESS } from "./capabilities.js";
import { callSite, WpError } from "./wpClient.js";
import { getWebsiteSite, query } from "../db.js";

export const ACTION = {
  CREATE: "create",             // no such account here — we would make one
  UPDATE: "update",             // managed account exists, role differs
  LINK_REQUIRED: "link_required", // account exists but isn't ours to touch
  SKIP: "skip",                 // already correct, nothing to do
  BLOCKED: "blocked",           // can't proceed; see blockers[]
};

/**
 * Resolves the role a person should get on one site.
 *
 * Precedence: an explicit per-site override, then the person's own default,
 * then their team's, then subscriber. Administrator is never reached by
 * inheritance — it can only arrive here as an explicit override, and even then
 * it still has to clear the confirmation the write phase requires.
 */
export function resolveRequestedRole(staff, websiteId, roleOverrides = {}) {
  const override = roleOverrides[websiteId] || roleOverrides[String(websiteId)];
  if (override) return { role: normalizeRoleSlug(override), source: "override" };
  if (staff.defaultWpRole) return { role: normalizeRoleSlug(staff.defaultWpRole), source: "user" };
  if (staff.teamDefaultWpRole) return { role: normalizeRoleSlug(staff.teamDefaultWpRole), source: "team" };
  return { role: "subscriber", source: "fallback" };
}

/**
 * Predicts one pair's outcome from facts already gathered.
 *
 * Pure, so the decision table is testable without a database or a site. Every
 * branch that stops the operation adds a blocker with a code the UI can group
 * on and a message an administrator can act on.
 */
export function predict({ staff, site, capabilities, roleCheck, existing, requestedRole }) {
  const blockers = [];

  if (staff.status === "disabled") {
    blockers.push({
      code: "user_disabled",
      message: `${staff.label} is disabled on the roster, so they aren't assigned to websites.`,
    });
  }

  if (capabilities.readiness !== READINESS.READY) {
    blockers.push({
      code: capabilities.readiness,
      message: capabilities.message,
    });
  }

  // Never checked vs. checked-and-absent are different answers, and saying
  // "not available" when we simply couldn't ask would be a lie.
  if (!roleCheck.known) {
    blockers.push({
      code: "roles_unknown",
      message: `Couldn't read the roles on ${site.name}, so we can't confirm "${requestedRole}" exists there.`,
    });
  } else if (!roleCheck.available) {
    blockers.push({
      code: "role_not_available",
      message: `"${requestedRole}" isn't a role on ${site.name}. Choose a different role for this website.`,
      alternatives: roleCheck.alternatives,
    });
  }

  // The confirmation keys on siteAdmin (manage_options and friends), NOT on the
  // broader adminLike. Stock WordPress gives Editor unfiltered_html, so
  // confirming on adminLike would put a modal in front of ordinary work — and a
  // confirmation that fires on the common case is one people learn to click
  // through.
  const needsAdminConfirmation = roleCheck.siteAdmin === true || isAdminLikeRole(requestedRole);
  // Surfaced as a notice rather than a gate: worth knowing, not worth stopping.
  const contentRisk = roleCheck.adminLike === true && roleCheck.siteAdmin !== true;

  // THE gate that survived the policy change. Administrator may now be a team
  // or per-user default, so an administering role will reach far more sites
  // than before — which makes it more important, not less, that a site only
  // accepts one if its OWN administrator granted users:admin. This dashboard
  // cannot grant that scope, and a job must not discover the refusal one site
  // at a time, so it is a blocker here rather than a per-site failure later.
  if (needsAdminConfirmation && capabilities.readiness === READINESS.READY) {
    const scopes = capabilities.scopes || [];
    if (!scopes.includes("users:admin")) {
      blockers.push({
        code: "admin_scope_denied",
        message: `${site.name} hasn't allowed Administrator to be granted from here. Someone with access to that site's WP Admin can enable it under DE Monitoring → User management.`,
      });
    }
  }

  if (blockers.length) {
    return { action: ACTION.BLOCKED, blockers, needsAdminConfirmation, contentRisk };
  }

  if (!existing || !existing.exists) {
    return { action: ACTION.CREATE, blockers, needsAdminConfirmation, contentRisk };
  }

  const user = existing.user || {};
  const currentRoles = Array.isArray(user.roles) ? user.roles : [];

  // The guard that keeps clients' own accounts untouchable: an account we
  // didn't create and nobody linked is reported, never adopted.
  if (!user.managed) {
    return {
      action: ACTION.LINK_REQUIRED,
      blockers,
      needsAdminConfirmation,
      contentRisk,
      note: `An account for this address already exists on ${site.name} and isn't managed by us. Link it before making any change.`,
    };
  }

  if (currentRoles.length === 1 && currentRoles[0] === requestedRole) {
    return { action: ACTION.SKIP, blockers, needsAdminConfirmation, contentRisk, note: "Already has this role." };
  }

  return { action: ACTION.UPDATE, blockers, needsAdminConfirmation, contentRisk };
}

/**
 * Runs the whole preflight.
 *
 * Sites are probed concurrently but bounded — one row of the review table per
 * pair, and a slow site holds up only itself. Nothing here writes to a site or
 * to our own tables beyond the role cache.
 */
export async function runPreflight({ staffUserIds = [], teamId = null, websiteIds = [], roleOverrides = {} } = {}, { concurrency = 4 } = {}) {
  const staffList = await loadStaff(staffUserIds, teamId);
  if (!staffList.length) throw new Error("Select at least one person.");
  if (!websiteIds.length) throw new Error("Select at least one website.");

  const sites = [];
  for (const id of websiteIds) {
    const site = await getWebsiteSite(id);
    if (site) sites.push(site);
  }
  if (!sites.length) throw new Error("None of the selected websites exist any more.");

  // Per-site work is done once, not once per person: capabilities, the role
  // list, and one lookup per person on that site.
  const perSite = new Array(sites.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, sites.length) }, async () => {
    while (cursor < sites.length) {
      const i = cursor++;
      perSite[i] = await inspectSite(sites[i], staffList);
    }
  });
  await Promise.all(workers);

  const rows = [];
  for (const staff of staffList) {
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];
      const info = perSite[i];
      const { role: requestedRole, source: roleSource } = resolveRequestedRole(staff, site.id, roleOverrides);
      const roleCheck = checkRoleAvailability(requestedRole, info.roles);
      const existing = info.lookups.get(staff.id) || { exists: false, user: null, error: info.lookupError };

      const prediction = predict({
        staff, site, capabilities: info.capabilities, roleCheck, existing, requestedRole,
      });

      rows.push({
        staffUserId: staff.id,
        staffLabel: staff.label,
        staffEmail: staff.email,
        teamName: staff.teamName,
        websiteId: site.id,
        websiteName: site.name,
        websiteUrl: site.url,

        exists: !!(existing && existing.exists),
        matchedOn: existing?.matched || null,
        currentRoles: existing?.user?.roles || [],
        managed: existing?.user?.managed === true,
        existingUser: existing?.user ? publicUser(existing.user) : null,

        requestedRole,
        roleSource,
        roleAvailable: roleCheck.available,
        roleKnown: roleCheck.known,
        roleAlternatives: roleCheck.alternatives,

        pluginSupported: info.capabilities.readiness === READINESS.READY,
        pluginVersion: info.capabilities.pluginVersion,
        requiredApiVersion: info.capabilities.requiredApiVersion,
        readiness: info.capabilities.readiness,

        action: prediction.action,
        blockers: prediction.blockers,
        needsAdminConfirmation: prediction.needsAdminConfirmation,
        contentRisk: prediction.contentRisk === true,
        note: prediction.note || null,
      });
    }
  }

  return { rows, summary: summarize(rows), sites: sites.map((s) => ({ id: s.id, name: s.name, url: s.url })) };
}

/** Everything one site can tell us, gathered once for all the selected people. */
async function inspectSite(site, staffList) {
  const capabilities = await getCapabilities(site);
  const info = { capabilities, roles: [], lookups: new Map(), lookupError: null };

  if (capabilities.readiness !== READINESS.READY) return info;

  const roleResult = await getSiteRoles(site);
  info.roles = roleResult.roles;

  for (const staff of staffList) {
    try {
      const found = await callSite(site, {
        method: "GET",
        route: "/users/lookup",
        query: { email: staff.email },
      });
      info.lookups.set(staff.id, found);
    } catch (err) {
      // A failed lookup must not be read as "doesn't exist" — that would
      // predict "create" and risk a duplicate. Record it as a blocker instead.
      info.lookupError = err instanceof WpError ? err.message : String(err.message || err);
      info.lookups.set(staff.id, { exists: false, user: null, error: info.lookupError });
      info.capabilities = {
        ...capabilities,
        readiness: READINESS.UNREACHABLE,
        message: `Couldn't check existing accounts on ${site.name}: ${info.lookupError}`,
      };
    }
  }
  return info;
}

async function loadStaff(staffUserIds, teamId) {
  if (teamId) {
    const { rows } = await query("select id from staff_users where team_id = $1 order by email", [teamId]);
    staffUserIds = [...new Set([...(staffUserIds || []), ...rows.map((r) => r.id)])];
  }
  const out = [];
  for (const id of staffUserIds || []) {
    const s = await getStaff(id);
    if (s) out.push(s);
  }
  return out;
}

// Only the fields the review screen shows. The plugin already limits what it
// sends, but the app decides for itself what reaches a browser.
function publicUser(user) {
  return {
    id: user.id,
    login: user.login,
    email: user.email,
    displayName: user.display_name,
    roles: user.roles || [],
    managed: user.managed === true,
    registered: user.registered || null,
    isAdminLike: user.is_admin_like === true,
    isSiteAdmin: user.is_site_admin === true,
  };
}

function summarize(rows) {
  const counts = { create: 0, update: 0, link_required: 0, skip: 0, blocked: 0 };
  let needsAdminConfirmation = 0;
  let contentRisk = 0;
  // Counted as distinct WEBSITES, not rows: "grants Administrator on 7
  // websites" is the sentence someone can actually weigh. "on 34 assignments"
  // is not.
  const adminSites = new Set();
  const adminBlockedSites = new Set();
  for (const r of rows) {
    counts[r.action] = (counts[r.action] || 0) + 1;
    if (r.needsAdminConfirmation) {
      needsAdminConfirmation++;
      if (r.action !== ACTION.BLOCKED) adminSites.add(r.websiteId);
    }
    if (r.contentRisk) contentRisk++;
    if (r.blockers.some((b) => b.code === "admin_scope_denied")) adminBlockedSites.add(r.websiteId);
  }
  return {
    total: rows.length,
    ...counts,
    needsAdminConfirmation,
    // What the single, once-per-job confirmation is about.
    adminSiteCount: adminSites.size,
    adminSiteIds: [...adminSites],
    adminBlockedSiteCount: adminBlockedSites.size,
    contentRisk,
    actionable: counts.create + counts.update,
    sites: new Set(rows.map((r) => r.websiteId)).size,
    people: new Set(rows.map((r) => r.staffUserId)).size,
  };
}
