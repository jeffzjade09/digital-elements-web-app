// Who, on a connected website, is allowed to drive the Team Members panel.
//
// Split out from the router on purpose: like every other module in this folder
// it never touches req/res, so the rules below are testable without a server
// and portable to Nexus as-is.

import { getStaffByEmail, AGENCY_DOMAIN } from "./staffUsers.js";

/* =========================================================== the actor ==== */

/**
 * The only teams whose members may drive the plugin's Team Members panel.
 *
 * ONE definition, by SLUG. Slugs are derived once when a team is created and
 * left alone when it is renamed, so "Web Development" becoming "Web Team"
 * cannot silently close the gate — and, more importantly, a new team called
 * "Admin" cannot silently open it. Matching on name would do both.
 *
 * Everything that decides who may use the panel reads this constant. Adding a
 * team here is a deliberate, reviewable edit in one place.
 */
export const PANEL_TEAM_SLUGS = Object.freeze(["web-development", "admin"]);

export const ACTOR_REFUSALS = Object.freeze({
  MISSING: "actor_missing",
  NOT_AGENCY: "actor_not_agency",
  NOT_ON_ROSTER: "actor_not_on_roster",
  INACTIVE: "actor_inactive",
  TEAM_NOT_ALLOWED: "actor_team_not_allowed",
});

/**
 * An email address that is EXACTLY on the agency domain.
 *
 * Not `endsWith("@" + domain)` alone: that is already correct for subdomains
 * (jeff@x.digitalelementsgroup.com does not end with "@digitalelementsgroup.com")
 * but says nothing about a trailing dot, surrounding whitespace, case, or an
 * address carrying more than one "@". Splitting on the LAST "@" and comparing
 * the whole domain makes the rule explicit and testable instead of implied by a
 * string operation.
 */
export function isAgencyEmail(email) {
  const raw = String(email == null ? "" : email).trim().toLowerCase();
  if (!raw || raw.includes(" ")) return false;

  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return false;
  if (raw.slice(0, at).includes("@")) return false;   // more than one @

  // A trailing dot is a legal, fully-qualified form of the same domain.
  const domain = raw.slice(at + 1).replace(/\.$/, "");
  return domain === AGENCY_DOMAIN;
}

/**
 * Who the plugin says is acting, resolved against the roster and their team.
 *
 * WHAT THIS IS. A WordPress account's email address is set by whoever
 * administers that WordPress site. So a site that has been compromised, or an
 * administrator acting in bad faith, can create an account claiming any agency
 * address. This check is therefore a MISTAKE-GUARD AND A VISIBILITY CONTROL,
 * not a security boundary: it keeps the panel away from people who should not
 * be using it, and puts a real name in the audit log.
 *
 * WHAT ACTUALLY BOUNDS THE DAMAGE is unchanged and lives here on the hub:
 * assignment only to existing roster members, the agency-domain rule, the
 * site's own users:admin scope, the last-administrator guard — and now the team
 * restriction, which caps what a spoofed actor could achieve at what a Web
 * Development or Admin colleague could already do ON THAT ONE SITE. A site can
 * still only ever act as itself.
 */
export async function resolveActingStaff(claimedEmail) {
  const claimed = String(claimedEmail == null ? "" : claimedEmail).trim().toLowerCase();
  if (!claimed) return { ok: false, reason: ACTOR_REFUSALS.MISSING };
  if (!isAgencyEmail(claimed)) return { ok: false, reason: ACTOR_REFUSALS.NOT_AGENCY };

  const staff = await getStaffByEmail(claimed);
  if (!staff) return { ok: false, reason: ACTOR_REFUSALS.NOT_ON_ROSTER, email: claimed };
  if (staff.status !== "active") {
    return { ok: false, reason: ACTOR_REFUSALS.INACTIVE, email: staff.email };
  }
  if (!staff.teamSlug || !PANEL_TEAM_SLUGS.includes(staff.teamSlug)) {
    return {
      ok: false,
      reason: ACTOR_REFUSALS.TEAM_NOT_ALLOWED,
      email: staff.email,
      team: staff.teamName || null,
      teamSlug: staff.teamSlug || null,
    };
  }

  return {
    ok: true,
    email: staff.email,
    staffUserId: staff.id,
    team: staff.teamName || null,
    teamSlug: staff.teamSlug,
  };
}

/** What a refused actor is told. Actionable, and discloses nothing new. */
export function actorRefusalMessage(reason) {
  switch (reason) {
    case ACTOR_REFUSALS.MISSING:
      return "This website's Digital Elements plugin is out of date. Update it to 2.7.1 or later.";
    case ACTOR_REFUSALS.NOT_AGENCY:
      return "Only @digitalelementsgroup.com accounts can manage users from a website.";
    case ACTOR_REFUSALS.NOT_ON_ROSTER:
      return "That account isn't on the Digital Elements roster. Ask Digital Elements to add it.";
    case ACTOR_REFUSALS.INACTIVE:
      return "That account is disabled on the Digital Elements roster.";
    case ACTOR_REFUSALS.TEAM_NOT_ALLOWED:
      return "Only Web Development and Admin team members can manage users from here.";
    default:
      return "That request was refused.";
  }
}
