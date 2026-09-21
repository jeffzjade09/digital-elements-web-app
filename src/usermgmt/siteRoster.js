// The roster, as one website is allowed to see it.
//
// This is the main new disclosure in the site API: agency staff names and email
// addresses become readable by any connected site, and therefore by any site
// that gets compromised. So the shape is an ALLOW-LIST built field by field —
// the same discipline as deheled_um_user_shape() on the plugin side, and for
// the same reason. Filtering a full record on the way out means every column
// added later is disclosed by default; an allow-list cannot fail that way.
//
// What a site gets: the people it could add, their teams, the role each would
// get, and whether they are already here.
//
// What it never gets: which OTHER sites anyone is on, dashboard account links,
// audit history, who created a record, or anything about teams beyond name and
// default role.

import { query } from "../db.js";

/**
 * One member, exactly as a site may see them.
 *
 * `onThisSite` is the only per-site fact included, and it is about the calling
 * site only — the assignment query is scoped by website_id before it gets here.
 */
function memberView(row, assignment) {
  return {
    staffUserId: row.id,
    label: row.display_name || [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || row.email.split("@")[0],
    email: row.email,
    defaultWpRole: row.effective_role,
    roleSource: row.default_wp_role ? "user" : (row.team_default_wp_role ? "team" : "fallback"),
    onThisSite: assignment
      ? {
          present: true,
          roles: assignment.wp_role ? [assignment.wp_role] : [],
          managed: assignment.managed === true,
          state: assignment.state,
          lastSyncedAt: assignment.last_synced_at,
        }
      : { present: false },
  };
}

/**
 * Teams and members for one website.
 *
 * Active staff only: someone disabled on the roster is not a person this site
 * should be offered, and including them would only produce a blocked row at
 * preflight.
 */
export async function buildSiteRoster(websiteId) {
  const { rows: staff } = await query(
    `select s.id, s.email, s.first_name, s.last_name, s.display_name,
            s.default_wp_role, s.status, s.domain_override,
            t.id as team_id, t.name as team_name, t.slug as team_slug,
            t.default_wp_role as team_default_wp_role,
            coalesce(s.default_wp_role, t.default_wp_role, 'subscriber') as effective_role
       from staff_users s
       left join teams t on t.id = s.team_id
      where s.status = 'active'
      order by t.name asc nulls last, lower(coalesce(s.display_name, s.email)) asc`
  );

  // Scoped to this website before anything is shaped, so there is no path by
  // which another site's assignment could reach the response.
  const { rows: assignments } = await query(
    `select staff_user_id, wp_role, state, managed, last_synced_at
       from website_user_assignments
      where website_id = $1 and state <> 'removed'`,
    [websiteId]
  );
  const byStaff = new Map(assignments.map((a) => [a.staff_user_id, a]));

  const teams = new Map();
  let unassigned = null;

  for (const row of staff) {
    // A non-agency address is refused by the plugin flow entirely — the domain
    // override is a deliberate dashboard action with its own audit trail, and
    // reproducing it inside a client's WP Admin would weaken it. Excluded here
    // so it cannot be offered in the first place.
    if (row.domain_override) continue;

    const member = memberView(row, byStaff.get(row.id));
    if (!row.team_id) {
      unassigned = unassigned || { id: null, name: "No team", slug: null, defaultWpRole: null, members: [] };
      unassigned.members.push(member);
      continue;
    }
    if (!teams.has(row.team_id)) {
      teams.set(row.team_id, {
        id: row.team_id,
        name: row.team_name,
        slug: row.team_slug,
        defaultWpRole: row.team_default_wp_role,
        members: [],
      });
    }
    teams.get(row.team_id).members.push(member);
  }

  const out = [...teams.values()];
  if (unassigned) out.push(unassigned);

  return {
    teams: out,
    counts: {
      teams: out.length,
      members: out.reduce((n, t) => n + t.members.length, 0),
      alreadyHere: out.reduce((n, t) => n + t.members.filter((m) => m.onThisSite.present).length, 0),
    },
  };
}

/**
 * The staff ids a site is allowed to name, for validating a request.
 *
 * A site could send any uuid; only these are real, active, agency-domain staff.
 * Anything else is refused rather than quietly dropped, so a typo or a tampered
 * request is visible instead of silently assigning fewer people than asked.
 */
export async function assertStaffSelectable(staffUserIds) {
  const ids = [...new Set((staffUserIds || []).filter(Boolean).map(String))];
  if (!ids.length) throw new Error("Select at least one person.");
  if (ids.length > 100) throw new Error("That's too many people in one request.");

  const { rows } = await query(
    `select id, email, status, domain_override from staff_users where id = any($1::uuid[])`,
    [ids]
  );
  const found = new Map(rows.map((r) => [r.id, r]));

  const problems = [];
  for (const id of ids) {
    const row = found.get(id);
    if (!row) problems.push("one or more of those people are no longer on the roster");
    else if (row.status !== "active") problems.push(`${row.email} is disabled on the roster`);
    else if (row.domain_override) problems.push(`${row.email} is outside the agency domain and can only be assigned from the dashboard`);
  }
  if (problems.length) throw new Error([...new Set(problems)].join("; ") + ".");

  return ids;
}
