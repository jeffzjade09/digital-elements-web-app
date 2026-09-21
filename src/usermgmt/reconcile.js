// Checking what we believe about a site against what is actually there.
//
// THE BUG THIS EXISTS FOR. An assignment row was written when we acted and then
// never read back. Two accounts were deleted directly in WP Admin and the rows
// still said "synced", so the Team Members panel reported "everyone is already
// here" while the site had one user. The dashboard's picture of a site was a
// belief nothing ever re-verified.
//
// THE RULE. The site is the authority on who exists there. This module's only
// job is to make our rows agree with what the site says — the same principle
// #16 applied to scopes, applied to people.
//
// READ-ONLY WITH RESPECT TO WORDPRESS. Observing drift may update hub rows and
// write audit entries, and NOTHING ELSE. It never creates a user, never deletes
// one, never changes a role, never links or unlinks. Two reasons:
//
//   - someone removed that account on purpose, and a dashboard that quietly put
//     it back would be fighting the person who did it;
//   - a reconcile runs unattended, on a schedule, across every site. Anything
//     it can do to a client site, it can do to forty of them at 3am with nobody
//     watching.
//
// So the only call it makes is GET /users/lookup, and a test asserts that a
// full pass issues no write of any kind.

import { query } from "../db.js";
import { callSite, WpError } from "./wpClient.js";
import * as audit from "./audit.js";
import { deriveInviteState, applyInviteState } from "./invites.js";

/** What reconciliation found, per row. */
export const DRIFT = Object.freeze({
  ROLE_CHANGED: "role_changed_externally",
  UNMANAGED: "unmanaged_externally",
});

export const RECONCILE_ACTIONS = Object.freeze({
  REMOVED: "wpusers.detected_removed_externally",
  ROLE_CHANGED: "wpusers.detected_role_changed_externally",
  UNMANAGED: "wpusers.detected_unmanaged_externally",
});

const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.USER_SYNC_CONCURRENCY) || 4));

/** The rows we hold for a site, with the person attached. */
async function assignmentsFor(websiteId) {
  const { rows } = await query(
    `select a.id, a.staff_user_id, a.website_id, a.wp_role, a.wp_user_id, a.wp_user_login,
            a.state, a.managed, a.drift, a.last_reconciled_at,
            a.invite_state, a.invited_at, a.password_set_at, a.activation_signal,
            s.email, s.display_name, s.first_name, s.last_name
       from website_user_assignments a
       join staff_users s on s.id = a.staff_user_id
      where a.website_id = $1
        and a.state <> 'removed'`,
    [websiteId]
  );
  return rows;
}

/**
 * One row, decided against one observation.
 *
 * Pure: it takes what we believe and what the site said, and returns what
 * should change. Kept separate from the writing so the transitions can be
 * tested without a database, a site, or a network.
 *
 * `observation` is { present, roles[], managed, wpUserId } or
 * { present: false }. A LOOKUP THAT FAILED IS NOT AN OBSERVATION — pass null
 * and this returns no change at all. Treating "we couldn't ask" as "they're
 * gone" would mark a whole site removed the moment it went down for an hour.
 */
export function decide(assignment, observation) {
  if (!observation) return null;          // we didn't manage to look

  const now = { lastReconciledAt: true };

  if (observation.present === false) {
    // Already known gone: nothing to record, and nothing to say again.
    if (assignment.state === "removed_externally") return { ...now, noop: true };
    return {
      ...now,
      state: "removed_externally",
      drift: null,
      audit: RECONCILE_ACTIONS.REMOVED,
      detail: { was: assignment.state, wpUserId: assignment.wp_user_id, wpRole: assignment.wp_role },
    };
  }

  const roles = (observation.roles || []).map((r) => String(r).toLowerCase());
  const observedRole = roles[0] || null;
  const stored = assignment.wp_role ? String(assignment.wp_role).toLowerCase() : null;

  // Back after having been gone — recreated by hand, or restored from a backup.
  const returning = assignment.state === "removed_externally";

  if (observedRole && stored && observedRole !== stored) {
    return {
      ...now,
      // Present and working, so `state` stays what it always meant: how the
      // last operation went. The difference is drift, recorded separately.
      state: returning ? "synced" : undefined,
      wpRole: observedRole,
      wpUserId: observation.wpUserId ?? assignment.wp_user_id,
      drift: DRIFT.ROLE_CHANGED,
      audit: RECONCILE_ACTIONS.ROLE_CHANGED,
      detail: { from: stored, to: observedRole, roles },
    };
  }

  // We think we manage this account; the site says we don't. Someone cleared
  // the flag, or the account was rebuilt. Worth seeing, not worth acting on.
  if (assignment.managed === true && observation.managed === false) {
    if (assignment.drift === DRIFT.UNMANAGED) return { ...now, noop: true };
    return {
      ...now,
      state: returning ? "synced" : undefined,
      wpUserId: observation.wpUserId ?? assignment.wp_user_id,
      drift: DRIFT.UNMANAGED,
      audit: RECONCILE_ACTIONS.UNMANAGED,
      detail: { wpUserId: observation.wpUserId ?? assignment.wp_user_id },
    };
  }

  // Present, right role, still ours.
  //
  // A recorded ROLE CHANGE is deliberately NOT cleared here. We adopted the
  // site's role when we saw the difference, so every later observation matches
  // by construction — clearing on a match would erase "somebody changed this"
  // on the very next pass, before anyone had a chance to see it. It is cleared
  // when the dashboard next sets that person's role, which is the moment the
  // difference actually stops being true. See sync.js.
  if (assignment.drift === DRIFT.ROLE_CHANGED && !returning) {
    return { ...now, noop: true };
  }

  // Drift that has genuinely gone: the account is back, or the site marks it
  // as ours again. Both are things the site did, not things we did.
  const wasDrifting = assignment.drift !== null && assignment.drift !== undefined;
  if (returning || wasDrifting) {
    return {
      ...now,
      state: "synced",
      wpUserId: observation.wpUserId ?? assignment.wp_user_id,
      drift: null,
      resolved: true,
      detail: { was: assignment.state, wasDrift: assignment.drift || null },
    };
  }
  return { ...now, noop: true };
}

/**
 * Invitation status, refreshed from the same observation.
 *
 * Folded into reconciliation rather than polled: the question "has this person
 * set a password yet" is answered by the same lookup that answers "are they
 * still here", so asking it separately would double the traffic to every site
 * to learn something we already had in hand.
 *
 * Only for accounts still present. Someone who was deleted has no invitation
 * status worth updating, and their row already says removed_externally.
 */
async function applyInvite(assignment, observation) {
  if (!observation || observation.present === false) return;
  // An older plugin reports neither field. Leaving the state alone is the
  // honest answer: we did not learn anything.
  if (observation.activation_pending === undefined && !observation.password_set_at
      && observation.created_by_us === undefined) return;

  const derived = deriveInviteState(assignment, observation);
  if (!derived) return;
  if (derived.state === assignment.invite_state
      && derived.signal === (assignment.activation_signal || null)) return;
  await applyInviteState(assignment.id, derived);
}

/** Applies one decision. Hub rows and audit only — never a call to the site. */
async function apply(site, assignment, decision, actor) {
  const sets = ["last_reconciled_at = now()"];
  const params = [assignment.id];
  const push = (frag, value) => { params.push(value); sets.push(`${frag} = $${params.length}`); };

  if (decision.state !== undefined) push("state", decision.state);
  if (decision.wpRole !== undefined) push("wp_role", decision.wpRole);
  if (decision.wpUserId !== undefined && decision.wpUserId !== null) push("wp_user_id", decision.wpUserId);
  if (decision.drift !== undefined) {
    push("drift", decision.drift);
    push("drift_detail", decision.drift ? JSON.stringify(decision.detail || {}) : null);
  }
  if (sets.length > 1) sets.push("updated_at = now()");

  await query(`update website_user_assignments set ${sets.join(", ")} where id = $1`, params);

  if (decision.audit) {
    await audit.record({
      actorUserId: actor?.actorUserId || null,
      actorEmail: actor?.actorEmail || null,
      action: decision.audit,
      entityType: "staff_user",
      entityId: assignment.staff_user_id,
      websiteId: site.id,
      targetEmail: assignment.email,
      result: "ok",
      after: {
        site: site.name,
        email: assignment.email,
        via: actor?.via || "reconcile",
        ...decision.detail,
        // Said in words, because whoever reads the Activity Log is trying to
        // find out what happened to an account, not to decode a state name.
        explanation: decision.audit === RECONCILE_ACTIONS.REMOVED
          ? "This account no longer exists on the website. It was removed outside the dashboard; nothing was recreated."
          : decision.audit === RECONCILE_ACTIONS.ROLE_CHANGED
            ? "This account's role was changed on the website, outside the dashboard. The dashboard now records the role the site actually has."
            : "The website no longer marks this account as managed by Digital Elements.",
      },
    });
  }
}

function summarize() {
  return { checked: 0, unchanged: 0, removedExternally: 0, roleChanged: 0, unmanaged: 0, resolved: 0, skipped: 0 };
}

/**
 * Reconcile from what a plugin told us it can see.
 *
 * `observed` is the plugin's report: one entry per roster member it looked up
 * in the site's own user table. Free — the site had to look anyway to render
 * its panel — and it covers every assignment without a single extra request.
 *
 * Unknown emails are ignored rather than treated as absent: the plugin reports
 * what it was asked about, and silence is not evidence.
 */
export async function reconcileFromObserved(site, observed, actor = {}) {
  const summary = summarize();
  if (!Array.isArray(observed) || !observed.length) return summary;

  const byEmail = new Map();
  for (const o of observed) {
    const email = String(o?.email || "").trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, {
      present: o.present === true,
      roles: Array.isArray(o.roles) ? o.roles : [],
      managed: o.managed === true,
      wpUserId: Number(o.wpUserId) > 0 ? Number(o.wpUserId) : null,
      // Invitation status, when the plugin is new enough to report it. Absent
      // on an older plugin, which leaves the state alone rather than guessing.
      created_by_us: typeof o.createdByUs === "boolean" ? o.createdByUs : undefined,
      password_set_at: o.passwordSetAt || null,
      activation_pending: typeof o.activationPending === "boolean" ? o.activationPending : undefined,
    });
  }

  for (const assignment of await assignmentsFor(site.id)) {
    const observation = byEmail.get(String(assignment.email).toLowerCase());
    if (!observation) { summary.skipped++; continue; }

    summary.checked++;
    const decision = decide(assignment, observation);
    if (!decision) { summary.skipped++; continue; }
    await apply(site, assignment, decision, { ...actor, via: actor.via || "plugin" });
    await applyInvite(assignment, observation);
    tally(summary, decision);
  }
  return summary;
}

function tally(summary, decision) {
  if (decision.noop) summary.unchanged++;
  else if (decision.audit === RECONCILE_ACTIONS.REMOVED) summary.removedExternally++;
  else if (decision.audit === RECONCILE_ACTIONS.ROLE_CHANGED) summary.roleChanged++;
  else if (decision.audit === RECONCILE_ACTIONS.UNMANAGED) summary.unmanaged++;
  else if (decision.resolved) summary.resolved++;
  else summary.unchanged++;
}

/**
 * Reconcile by asking the site ourselves.
 *
 * For sites whose plugin doesn't report observations, and for the scheduled
 * pass that must not wait for someone to open a panel. One signed GET per
 * assigned person — /users/lookup takes a single address, so there is no batch
 * to use — under the same concurrency bound as a sync.
 */
export async function reconcileSite(site, { actor = {}, credential = null } = {}) {
  const summary = summarize();
  const assignments = await assignmentsFor(site.id);
  if (!assignments.length) return summary;

  let cursor = 0;
  const worker = async () => {
    while (cursor < assignments.length) {
      const assignment = assignments[cursor++];
      let observation = null;
      try {
        const res = await callSite(site, {
          method: "GET",
          route: "/users/lookup",
          query: { email: assignment.email },
          credential,
        });
        observation = res.exists
          ? {
              present: true,
              roles: res.user?.roles || [],
              managed: res.user?.managed === true,
              wpUserId: Number(res.user?.id) || null,
              created_by_us: typeof res.user?.created_by_us === "boolean" ? res.user.created_by_us : undefined,
              password_set_at: res.user?.password_set_at || null,
              activation_pending: typeof res.user?.activation_pending === "boolean"
                ? res.user.activation_pending : undefined,
            }
          : { present: false };
      } catch (err) {
        // A site that is down, slow, or not enrolled tells us nothing about who
        // exists on it. Skipped, never read as absence.
        summary.skipped++;
        if (!(err instanceof WpError)) throw err;
        continue;
      }

      summary.checked++;
      const decision = decide(assignment, observation);
      if (!decision) { summary.skipped++; continue; }
      await apply(site, assignment, decision, { ...actor, via: actor.via || "recheck" });
      await applyInvite(assignment, observation);
      tally(summary, decision);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, assignments.length) }, worker));
  return summary;
}

/**
 * Reconcile every site that is in a state to answer.
 *
 * Used by "Re-check all" and by the scheduled sweep. One site's failure never
 * stops the rest: a site being unreachable is the normal case this has to
 * survive, not an exception.
 */
export async function reconcileAll(sites, { actor = {}, isReady = () => true } = {}) {
  const totals = summarize();
  const perSite = [];

  for (const site of sites) {
    if (site.archived) continue;
    if (!isReady(site)) continue;
    try {
      const summary = await reconcileSite(site, { actor });
      perSite.push({ websiteId: site.id, name: site.name, ...summary });
      for (const k of Object.keys(totals)) totals[k] += summary[k];
    } catch (err) {
      console.error(`[reconcile] ${site.name}: ${err.message}`);
      perSite.push({ websiteId: site.id, name: site.name, error: err.message });
    }
  }
  return { totals, perSite };
}

/** Drift counts per site, for Sync status. */
export async function driftSummary() {
  const { rows } = await query(
    `select website_id,
            count(*) filter (where state = 'removed_externally')::int as removed_externally,
            count(*) filter (where drift = 'role_changed_externally')::int as role_changed,
            count(*) filter (where drift = 'unmanaged_externally')::int as unmanaged,
            max(last_reconciled_at) as last_reconciled_at
       from website_user_assignments
      group by website_id`
  );
  const byWebsite = new Map();
  for (const r of rows) {
    byWebsite.set(r.website_id, {
      removedExternally: r.removed_externally,
      roleChanged: r.role_changed,
      unmanaged: r.unmanaged,
      lastReconciledAt: r.last_reconciled_at,
    });
  }
  return byWebsite;
}
