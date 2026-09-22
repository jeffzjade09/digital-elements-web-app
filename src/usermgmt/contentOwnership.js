// Content ownership, reassignment, and guarded deletion.
//
// The flow this module enforces, per website:
//
//   1. count what the account owns
//   2. if anything, an administrator picks a recipient and we reassign
//   3. re-count and show 0 remaining as PROOF, not as an assurance
//   4. only then is deleting offered
//
// Step 4 is where the real guarantee lives, and it isn't here: the plugin
// re-counts ownership inside the delete request itself and refuses if anything
// is left. This module exists so an administrator is never *asked* to do
// something that would be refused, and so the numbers they act on are real.
//
// Every check is per website. A person removed from five sites gets five
// independent ownership checks, five recipients, five verifications — because
// they own different things on each, and a single "looks empty" answer from one
// site says nothing about the other four.

import { callSite, WpError } from "./wpClient.js";
import { getCapabilities, READINESS } from "./capabilities.js";
import { getWebsiteSite, query } from "../db.js";
import { getStaff } from "./staffUsers.js";

/**
 * What an account owns on one site, plus who could receive it.
 *
 * Returns a shape the UI can render directly, including a human summary
 * ("18 posts, 4 pages, 31 media, 2 scheduled") — built here rather than in the
 * browser so the wording is the same everywhere it appears.
 */
export async function getContentOwnership(staffUserId, websiteId) {
  const { staff, site, assignment } = await resolveTriple(staffUserId, websiteId);

  const caps = await getCapabilities(site);
  if (caps.readiness !== READINESS.READY) {
    throw new WpError(caps.readiness, caps.message, { site: site.id });
  }
  if (!assignment?.wp_user_id) {
    return {
      staffUserId, websiteId,
      websiteName: site.name,
      hasAccount: false,
      message: `${staff.label} has no account recorded on ${site.name}.`,
    };
  }

  const data = await callSite(site, {
    method: "GET",
    route: `/users/${assignment.wp_user_id}/content`,
  });

  return shapeOwnership({ staff, site, assignment, data });
}

function shapeOwnership({ staff, site, assignment, data }) {
  const content = data.content || {};
  return {
    staffUserId: staff.id,
    staffLabel: staff.label,
    staffEmail: staff.email,
    websiteId: site.id,
    websiteName: site.name,
    hasAccount: true,
    wpUserId: assignment.wp_user_id,
    wpUser: data.user || null,
    total: content.total || 0,
    comments: content.comments || 0,
    ownsContent: (content.total || 0) > 0 || (content.comments || 0) > 0,
    byType: content.by_type || [],
    byStatus: content.by_status || {},
    isAdminEmail: content.is_admin_email === true,
    summary: describeOwnership(content),
    targets: data.eligible_reassign_targets || [],
    administrators: data.administrators ?? null,
  };
}

/**
 * "18 posts, 4 pages, 31 media, 2 scheduled".
 *
 * Scheduled content is called out separately because it is the category most
 * easily forgotten — nothing on the site shows it yet, and deleting its author
 * is how a launch quietly fails to happen.
 */
export function describeOwnership(content) {
  if (!content || (!content.total && !content.comments)) return "No content";

  const parts = (content.by_type || [])
    .filter((t) => t.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((t) => `${t.total} ${pluralize(t.label || t.type, t.total)}`);

  const scheduled = content.by_status?.future || 0;
  if (scheduled) parts.push(`${scheduled} scheduled`);
  const trashed = content.by_status?.trash || 0;
  if (trashed) parts.push(`${trashed} in the trash`);
  if (content.comments) parts.push(`${content.comments} comment${content.comments === 1 ? "" : "s"}`);

  return parts.join(", ");
}

function pluralize(label, n) {
  const l = String(label || "item").toLowerCase();
  if (n === 1) return l.replace(/s$/, "");
  return /s$/.test(l) ? l : `${l}s`;
}

/**
 * Moves everything to another user and verifies the result.
 *
 * The site re-counts after the move and reports what is left; that verified
 * number is what comes back, not "we asked it to move things". A non-zero
 * remaining count is returned as a normal outcome rather than an error — the UI
 * needs to show it, and the delete stays locked either way.
 */
export async function reassignContent(staffUserId, websiteId, targetId, actor) {
  const { staff, site, assignment } = await resolveTriple(staffUserId, websiteId);
  if (!assignment?.wp_user_id) throw new Error(`${staff.label} has no account on ${site.name}.`);
  if (!targetId) throw new Error("Choose a user to receive this content.");

  const before = await callSite(site, { method: "GET", route: `/users/${assignment.wp_user_id}/content` });

  const data = await callSite(site, {
    method: "POST",
    route: `/users/${assignment.wp_user_id}/reassign`,
    // Stable per (person, site, target): a retry after a timeout replays rather
    // than moving a second batch that arrived in between.
    idempotencyKey: reassignKey(staffUserId, websiteId, targetId),
    timeoutMs: 60_000, // a large media library can take a while to re-own
    body: { target_id: Number(targetId) },
  });

  return {
    staffUserId, websiteId, websiteName: site.name,
    target: data.target || null,
    moved: data.moved || {},
    before: describeOwnership(before.content || {}),
    remaining: data.remaining?.total || 0,
    remainingComments: data.remaining?.comments || 0,
    // The site's own verification. The delete route checks independently too.
    verified: data.verified === true,
    summary: describeOwnership(data.remaining || {}),
  };
}

function reassignKey(staffUserId, websiteId, targetId) {
  return `reassign:${JSON.stringify([staffUserId, websiteId, String(targetId)])}`;
}

/**
 * Pre-flight for a deletion across one or more sites.
 *
 * Checks every site independently and says, per site, whether deleting is
 * currently possible and what stands in the way. Nothing is deleted or moved.
 */
export async function planDeletion(staffUserId, websiteIds, { concurrency = 4 } = {}) {
  const rows = new Array(websiteIds.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, websiteIds.length) }, async () => {
    while (cursor < websiteIds.length) {
      const i = cursor++;
      const websiteId = websiteIds[i];
      try {
        const own = await getContentOwnership(staffUserId, websiteId);
        rows[i] = {
          ...own,
          // Deletable only when there is genuinely nothing left. "Probably
          // fine" is not a state this flow has.
          canDelete: own.hasAccount && !own.ownsContent,
          blocker: !own.hasAccount
            ? "No account here."
            : own.ownsContent
              ? `Owns ${own.summary}. Reassign before deleting.`
              : null,
        };
      } catch (err) {
        const site = await getWebsiteSite(websiteId);
        rows[i] = {
          staffUserId, websiteId,
          websiteName: site?.name || websiteId,
          hasAccount: false, canDelete: false,
          error: err.message,
          blocker: err.message,
        };
      }
    }
  });
  await Promise.all(workers);

  const deletable = rows.filter((r) => r.canDelete).length;
  const needReassign = rows.filter((r) => r.ownsContent).length;
  return {
    rows,
    summary: {
      sites: rows.length,
      deletable,
      needReassign,
      blocked: rows.length - deletable,
    },
  };
}

/**
 * Deletes an account on one site.
 *
 * Deliberately thin. The app has already shown the administrator a verified
 * zero, but this call does not rely on that: the plugin re-counts inside the
 * delete request, and a `has_content` refusal here means something was created
 * between the check and the click. That refusal is the design working, not a
 * bug, so it is surfaced as a clear outcome rather than swallowed.
 */
export async function deleteOnSite(staffUserId, websiteId, { reassignTarget, idempotencyKey } = {}) {
  const { staff, site, assignment } = await resolveTriple(staffUserId, websiteId);
  if (!assignment?.wp_user_id) {
    return { status: "skipped", reason: "no account recorded here" };
  }

  const data = await callSite(site, {
    method: "DELETE",
    route: `/users/${assignment.wp_user_id}`,
    idempotencyKey,
    timeoutMs: 45_000,
    body: { confirm: true, reassign_target: reassignTarget ? Number(reassignTarget) : null },
  });

  // The account is gone from WordPress at this point and nothing can undo that.
  // If our own bookkeeping then fails, the honest report is "deleted, not
  // recorded" — NOT a failed deletion, which would invite someone to run it
  // again, and not a clean success, which would hide a row that now disagrees
  // with the site. The caller turns this into the partial outcome.
  let hubSynced = true;
  try {
    await query(
      `update website_user_assignments
          set state='removed', managed=false, wp_user_id=null, wp_user_login=null,
              last_result=$3, last_error=null, last_error_code=null, updated_at=now()
        where staff_user_id=$1 and website_id=$2`,
      [staffUserId, websiteId, JSON.stringify({ deleted: true, at: new Date().toISOString() })]
    );
  } catch (err) {
    console.error("[usermgmt] deleted on site but could not record it:", err.message);
    hubSynced = false;
  }

  return { status: "deleted", hubSynced, result: data, staff, site };
}

async function resolveTriple(staffUserId, websiteId) {
  const staff = await getStaff(staffUserId);
  if (!staff) throw new Error("That person is no longer on the roster.");
  const site = await getWebsiteSite(websiteId);
  if (!site) throw new Error("That website no longer exists.");
  const { rows } = await query(
    "select wp_user_id, wp_role, state, managed from website_user_assignments where staff_user_id=$1 and website_id=$2",
    [staffUserId, websiteId]
  );
  return { staff, site, assignment: rows[0] || null };
}
