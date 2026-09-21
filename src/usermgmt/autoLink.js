// Adopting an agency colleague's pre-existing WordPress account.
//
// THE PROBLEM THIS SOLVES. Staff who were given accounts on client sites before
// this tool existed carry no _de_managed flag, because nothing here created or
// linked them. They are on the roster, they administer the site, and yet the
// Team Members panel used to refuse them by name. At roughly forty sites,
// linking every person on every site by hand was never going to happen.
//
// WHAT IT DOES. The first time such a person opens the panel, the hub links
// their account through the EXISTING de/v2 /link route — the same one the
// dashboard uses, with the same guards. Nothing here is a second implementation
// of linking, and nothing here relaxes it.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not bypass the site's users:admin
// scope. That scope is the site's own kill switch over its administrator
// accounts, and an agency colleague being the one asking does not make it ours
// to switch off. So on a site that hasn't granted it, linking an
// administrator-capable account is REFUSED — and the panel still opens, because
// access is the gate, not the link. The refusal is audited with its reason, so
// an account that can use the panel while showing as unmanaged has an
// explanation in the Activity Log rather than looking like a bug.

import { query } from "../db.js";
import { callSite, WpError } from "./wpClient.js";
import * as audit from "./audit.js";

export const AUTO_LINK_ACTION = "wpusers.auto_linked_via_plugin";

/**
 * Has this person already been linked on this site?
 *
 * The plugin reports whether the acting account carries _de_managed, which is
 * the truth on the site itself. This is the hub's own record, checked as well
 * so that a plugin that reports wrongly — or a request replayed later — cannot
 * produce a second link and a second audit row.
 */
async function alreadyLinked(staffUserId, websiteId) {
  const { rows } = await query(
    `select managed, wp_user_id from website_user_assignments
      where staff_user_id = $1 and website_id = $2`,
    [staffUserId, websiteId]
  );
  return rows.length > 0 && rows[0].managed === true;
}

/**
 * Records the assignment the link established.
 *
 * Written as the state the site is actually in, not as an intention: the
 * account exists, we now manage it, and it holds whatever role it already had.
 */
async function recordAssignment({ staffUserId, websiteId, wpUserId, wpUserLogin, wpRole }) {
  await query(
    `insert into website_user_assignments
       (staff_user_id, website_id, wp_role, wp_user_id, wp_user_login, state, managed, last_synced_at)
     values ($1,$2,$3,$4,$5,'linked',true,now())
     on conflict (staff_user_id, website_id) do update
        set managed = true,
            state = 'linked',
            wp_user_id = excluded.wp_user_id,
            wp_user_login = excluded.wp_user_login,
            wp_role = excluded.wp_role,
            last_synced_at = now(),
            updated_at = now()`,
    [staffUserId, websiteId, wpRole || "unknown", wpUserId || null, wpUserLogin || null]
  );
}

/**
 * Links the acting person's own WordPress account on the site they are using.
 *
 * Returns a plain result rather than throwing: the caller opens the panel
 * either way, so a failure here must not become a failure there.
 *
 *   { attempted, linked, reason }
 */
export async function autoLinkActingUser({ site, actor, wpUserId, ip }) {
  const websiteId = site.id;

  if (!wpUserId || !Number.isInteger(Number(wpUserId)) || Number(wpUserId) <= 0) {
    return { attempted: false, linked: false, reason: "no_wp_user_id" };
  }
  if (await alreadyLinked(actor.staffUserId, websiteId)) {
    return { attempted: false, linked: false, reason: "already_linked" };
  }

  const base = {
    actorUserId: null,
    actorEmail: actor.email,
    action: AUTO_LINK_ACTION,
    entityType: "staff_user",
    entityId: actor.staffUserId,
    websiteId,
    targetEmail: actor.email,
    ip: ip || null,
  };

  let response;
  try {
    response = await callSite(site, {
      method: "POST",
      route: `/users/${Number(wpUserId)}/link`,
      // Confirmed on their behalf, and only for their OWN account: this is a
      // colleague adopting the account they are signed in as, which is the one
      // case where the dashboard's "are you sure you want to adopt a stranger's
      // account" question has an obvious answer. confirm_admin is sent for the
      // same reason — but it does not, and must not, substitute for the site's
      // users:admin scope, which the plugin still checks.
      body: { confirm_link: true, confirm_admin: true },
      idempotencyKey: `autolink:${websiteId}:${actor.staffUserId}:${Number(wpUserId)}`,
    });
  } catch (err) {
    const code = err instanceof WpError ? err.code : "site_error";
    // The one refusal that is a policy decision rather than a fault, and the
    // reason an account may keep using the panel while showing as unmanaged.
    const reason = code === "scope_denied" ? "users_admin_not_granted" : code;
    await audit.record({
      ...base,
      result: "refused",
      after: {
        linked: false, reason, via: "plugin",
        team: actor.team, teamSlug: actor.teamSlug,
        wpUserId: Number(wpUserId),
        explanation: reason === "users_admin_not_granted"
          ? "This website hasn't allowed the dashboard to manage administrator accounts, so the account stays unlinked. The panel still works; assignments are unaffected."
          : "The website refused the link.",
      },
    });
    return { attempted: true, linked: false, reason };
  }

  // callSite throws on every refusal, so reaching here means the site accepted
  // it and `response` IS the de/v2 envelope.
  const body = response || {};

  // "skipped" means the site says it was already managed — the plugin's report
  // was stale. Record the assignment so the hub agrees with the site, but don't
  // claim a link that didn't happen.
  const linked = body.result === "linked";
  const user = body.user || {};

  await recordAssignment({
    staffUserId: actor.staffUserId,
    websiteId,
    wpUserId: Number(wpUserId),
    wpUserLogin: user.user_login || user.username || null,
    wpRole: Array.isArray(user.roles) ? user.roles[0] : null,
  });

  await audit.record({
    ...base,
    result: "ok",
    after: {
      linked, reason: linked ? "linked" : (body.result || "skipped"), via: "plugin",
      team: actor.team, teamSlug: actor.teamSlug,
      wpUserId: Number(wpUserId),
      wpRoles: Array.isArray(user.roles) ? user.roles : [],
      explanation: linked
        ? "An existing Digital Elements account on this website was adopted automatically the first time its owner opened Team Members."
        : "The account was already managed on the website.",
    },
  });

  return { attempted: true, linked, reason: linked ? "linked" : (body.result || "skipped") };
}
