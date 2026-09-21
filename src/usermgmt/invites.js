// Whether the person we invited ever actually got in.
//
// Creating an account sends WordPress's own set-password email and then tells
// you nothing more. Whether it was delivered, whether anyone acted on it, and
// whether the account is still sitting there unusable were all invisible — the
// way you found out was a colleague saying they never received anything.
//
// WHAT IS NOT HERE. No password, no hash, no reset key, no reset link, no
// expiry of our own. WordPress generates the link, mails it, and invalidates
// the previous one when a new one is sent (retrieve_password() overwrites
// user_activation_key). Everything below only records what we did and what we
// could observe afterwards.
//
// WHY NOBODY IS LOCKED OUT WAITING. There is no login gate and no forced-reset
// flag, deliberately. A new account cannot be signed into anyway: the password
// we generate is 32 random characters that are never disclosed to anyone, so
// there is nothing to sign in with until the person sets their own. A stale
// flag blocking a colleague who HAS set one would be a worse failure than the
// thing it guards against, and it would guard against nothing.

import { query } from "../db.js";
import { callSite, WpError } from "./wpClient.js";
import * as audit from "./audit.js";

export const INVITE = Object.freeze({
  INVITED: "invited",                   // created, and the site verified the email went out
  DELIVERY_FAILED: "delivery_failed",   // created, but delivery could not be confirmed
  PENDING_SETUP: "pending_setup",       // invited, and the link is still unused
  ACTIVATED: "activated",               // they set their own password
  UNKNOWN: "unknown",                   // linked or pre-existing: we never invited them
});

/** Which mechanism answered "they're active". */
export const SIGNAL = Object.freeze({
  META: "meta",                 // our own hook saw the reset complete
  KEY_CLEARED: "key_cleared",   // inferred: the activation key is gone
});

export const RESEND_ACTION = "wpusers.invite_resent";

// A few per hour, per person per site. Enough for "it didn't arrive, try
// again"; not enough to use the dashboard to bury someone in email.
export const RESEND_MAX = 3;
export const RESEND_WINDOW_MS = 60 * 60 * 1000;

/**
 * What the site's answer means for an account we invited.
 *
 * Pure, so the state machine can be read and tested on its own. `observation`
 * is the user shape from the site, or null when we couldn't look — in which
 * case nothing changes, for the same reason reconciliation never reads a failed
 * lookup as absence.
 */
export function deriveInviteState(assignment, observation) {
  const current = assignment?.invite_state || null;

  // Never invited by us: an account we linked is the website's own, and the
  // reset route refuses it precisely because sending a link into it would be a
  // way into an account that isn't ours. Saying "waiting for them to set a
  // password" about a colleague who has been working on the site for a year
  // would be worse than saying nothing.
  if (observation && observation.created_by_us === false) {
    return { state: INVITE.UNKNOWN, signal: null, passwordSetAt: null };
  }
  if (!observation) return null;

  // Observed, by our own hook.
  if (observation.password_set_at) {
    return {
      state: INVITE.ACTIVATED,
      signal: SIGNAL.META,
      passwordSetAt: new Date(Number(observation.password_set_at) * 1000).toISOString(),
    };
  }

  // Inferred. WordPress clears user_activation_key when a reset completes, so
  // an invited account with no key outstanding has been set up — but this is
  // weaker than the above (a key can also be cleared by other means), which is
  // why the signal travels with the answer instead of being flattened away.
  if (observation.activation_pending === false && current && current !== INVITE.UNKNOWN) {
    return { state: INVITE.ACTIVATED, signal: SIGNAL.KEY_CLEARED, passwordSetAt: null };
  }

  if (observation.activation_pending === true) {
    // delivery_failed is about the EMAIL and outranks "waiting": telling
    // someone to wait for a message that was never sent is the failure this
    // whole feature exists to stop.
    if (current === INVITE.DELIVERY_FAILED) return { state: INVITE.DELIVERY_FAILED, signal: null, passwordSetAt: null };
    return { state: INVITE.PENDING_SETUP, signal: null, passwordSetAt: null };
  }

  return null;
}

/** Records the outcome of an invitation we just sent. */
export async function recordInvite({ staffUserId, websiteId, delivered, error = null, resend = false }) {
  const state = delivered ? INVITE.INVITED : INVITE.DELIVERY_FAILED;
  await query(
    `update website_user_assignments
        set invite_state = $3,
            invited_at = now(),
            invite_error = $4,
            invite_count = invite_count + 1,
            -- A fresh link means they have not used THIS one yet, whatever they
            -- did with the last.
            password_set_at = null,
            activation_signal = null,
            updated_at = now()
      where staff_user_id = $1 and website_id = $2`,
    [staffUserId, websiteId, state, error]
  );
  return { state, resend };
}

/** Applies a derived state. Hub rows only; the site is never written to. */
export async function applyInviteState(assignmentId, derived) {
  if (!derived) return;
  await query(
    `update website_user_assignments
        set invite_state = $2, activation_signal = $3,
            password_set_at = coalesce($4::timestamptz, password_set_at),
            updated_at = now()
      where id = $1`,
    [assignmentId, derived.state, derived.signal, derived.passwordSetAt]
  );
}

/**
 * Has this person been sent too many invitations for this site lately?
 *
 * Counted from the audit rows, which are the honest record of what was actually
 * sent and already exist. A cumulative column could not answer "in the last
 * hour" without a second column to reset, and a reset is one more thing to get
 * wrong; a window over the log needs neither and cleans itself up.
 *
 * Only successful sends count. Refusing to resend because three earlier
 * attempts failed would lock someone out of the fix for the problem they are
 * trying to fix.
 */
export async function resendAllowed(staffUserId, websiteId) {
  const { rows } = await query(
    `select count(*)::int as n, max(at) as last_at
       from audit_log
      where action = $1 and entity_id = $2 and website_id = $3
        and result = 'ok'
        and at > now() - ($4::int * interval '1 millisecond')`,
    [RESEND_ACTION, staffUserId, websiteId, RESEND_WINDOW_MS]
  );
  const used = rows[0]?.n || 0;
  if (used < RESEND_MAX) return { allowed: true, remaining: RESEND_MAX - used };

  const oldest = rows[0]?.last_at ? new Date(rows[0].last_at).getTime() : Date.now();
  return {
    allowed: false,
    remaining: 0,
    retryAfterMs: Math.max(0, RESEND_WINDOW_MS - (Date.now() - oldest)),
  };
}

/** One assignment, with the person and the site attached. */
export async function getAssignment(staffUserId, websiteId) {
  const { rows } = await query(
    `select a.*, s.email, s.display_name, w.name as site_name, w.url as site_url
       from website_user_assignments a
       join staff_users s on s.id = a.staff_user_id
       join websites w on w.id = a.website_id
      where a.staff_user_id = $1 and a.website_id = $2`,
    [staffUserId, websiteId]
  );
  return rows[0] || null;
}

/**
 * Sends a fresh set-password link, through WordPress.
 *
 * Calls the plugin's existing /users/{id}/password-reset, which calls
 * retrieve_password(). That is the whole mechanism: WordPress writes a new
 * activation key — invalidating the previous link in the process — and mails it
 * to the address on the account. Nothing comes back here but "was it sent",
 * and there is no branch anywhere that would return the link or a password.
 */
export async function resendInvite({ site, assignment, actor }) {
  const base = {
    actorUserId: actor?.actorUserId || null,
    actorEmail: actor?.actorEmail || null,
    action: RESEND_ACTION,
    entityType: "staff_user",
    entityId: assignment.staff_user_id,
    websiteId: site.id,
    targetEmail: assignment.email,
    ip: actor?.ip || null,
  };

  if (assignment.managed !== true) {
    await audit.record({ ...base, result: "refused", after: { reason: "not_managed", site: site.name } });
    throw Object.assign(new Error("That account isn't managed by Digital Elements."), { code: "not_managed" });
  }
  if (!assignment.wp_user_id) {
    await audit.record({ ...base, result: "refused", after: { reason: "no_wp_user", site: site.name } });
    throw Object.assign(new Error("We don't have a WordPress account on file for them on this site."), { code: "no_wp_user" });
  }

  const gate = await resendAllowed(assignment.staff_user_id, site.id);
  if (!gate.allowed) {
    await audit.record({ ...base, result: "refused", after: { reason: "rate_limited", site: site.name, inviteCount: assignment.invite_count } });
    throw Object.assign(
      new Error(`That's ${RESEND_MAX} invitations to ${assignment.email} for this website within the hour. Try again later.`),
      { code: "rate_limited", retryAfterMs: gate.retryAfterMs }
    );
  }

  let delivered = false;
  let failureCode = null;
  try {
    const res = await callSite(site, {
      method: "POST",
      route: `/users/${Number(assignment.wp_user_id)}/password-reset`,
      idempotencyKey: `resend:${site.id}:${assignment.staff_user_id}:${Date.now()}`,
    });
    const warnings = Array.isArray(res?.warnings) ? res.warnings : [];
    // The site judges delivery the same way it does for a new account — by
    // watching the mail hooks, not by trusting a return value.
    delivered = !warnings.some((w) => w.code === "mail_failed");
    failureCode = delivered ? null : "mail_failed";
  } catch (err) {
    const code = err instanceof WpError ? err.code : "site_error";
    await audit.record({ ...base, result: "failed", after: { reason: code, site: site.name } });
    throw Object.assign(new Error(messageFor(code, assignment)), { code });
  }

  const recorded = await recordInvite({
    staffUserId: assignment.staff_user_id,
    websiteId: site.id,
    delivered,
    error: failureCode,
    resend: true,
  });

  await audit.record({
    ...base,
    result: delivered ? "ok" : "failed",
    after: {
      site: site.name,
      email: assignment.email,
      state: recorded.state,
      delivered,
      inviteCount: Number(assignment.invite_count || 0) + 1,
      via: actor?.via || "dashboard",
      explanation: delivered
        ? "A new set-password link was emailed by the website. Any earlier link stopped working."
        : "The website couldn't confirm the email was sent. Any earlier link stopped working regardless.",
    },
  });

  return { state: recorded.state, delivered };
}

function messageFor(code, assignment) {
  switch (code) {
    case "linked_account_protected":
      return `${assignment.email} wasn't created by Digital Elements, so we can't send them a link. They can use "Lost your password?" on the site's login page.`;
    case "not_managed":
      return "That account isn't managed by Digital Elements.";
    case "unreachable":
    case "timeout":
      return "Couldn't reach the website to send it. Try again shortly.";
    case "rate_limited":
      return "The website is rate-limiting us. Try again shortly.";
    default:
      return "The website refused to send the invitation.";
  }
}

/** Per-site invitation counts, for Sync status. */
export async function inviteSummary() {
  const { rows } = await query(
    `select website_id,
            count(*) filter (where invite_state = 'delivery_failed')::int as delivery_failed,
            count(*) filter (where invite_state = 'pending_setup')::int as pending_setup,
            count(*) filter (where invite_state = 'invited')::int as invited,
            count(*) filter (where invite_state = 'activated')::int as activated
       from website_user_assignments
      group by website_id`
  );
  const byWebsite = new Map();
  for (const r of rows) {
    byWebsite.set(r.website_id, {
      deliveryFailed: r.delivery_failed,
      pendingSetup: r.pending_setup,
      invited: r.invited,
      activated: r.activated,
    });
  }
  return byWebsite;
}

/** One sentence per state, used by both UIs so they cannot drift apart. */
export function inviteLabel(state) {
  switch (state) {
    case INVITE.INVITED: return "Invitation sent";
    case INVITE.PENDING_SETUP: return "Waiting for them to set a password";
    case INVITE.DELIVERY_FAILED: return "Email couldn't be delivered — resend";
    case INVITE.ACTIVATED: return "Active";
    case INVITE.UNKNOWN: return "Not invited by us";
    default: return "";
  }
}

/**
 * Why Resend isn't offered, when it isn't.
 *
 * An absent button reads as a bug. This is the sentence that stops someone
 * filing one — and it names the thing they can actually do instead.
 */
export function noResendReason(state) {
  if (state !== INVITE.UNKNOWN) return null;
  return "This account wasn't created by Digital Elements; they can use \"Lost your password?\" on the site's login page.";
}
