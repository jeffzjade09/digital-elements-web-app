// Teams — groups of internal agency staff.
//
// Named "teams" rather than "departments" deliberately: Nexus already uses
// "departments" for the client product catalog (web_dev / ppc / seo / social)
// and the two must not collide when this feature is ported.
//
// No Express, no req/res — plain arguments in, plain objects out.

import { query } from "../db.js";
import { assertDefaultRole, normalizeRoleSlug, knownRoleSlugs } from "./roles.js";

function rowToTeam(r) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description || "",
    defaultWpRole: r.default_wp_role,
    memberCount: r.member_count != null ? Number(r.member_count) : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function cleanName(name) {
  const n = String(name || "").trim().replace(/\s+/g, " ");
  if (!n) throw new Error("Team name is required.");
  if (n.length > 60) throw new Error("Team name must be 60 characters or fewer.");
  return n;
}

function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "team";
}

// Slugs are stable identifiers used in URLs and seed data, so a collision gets
// a numeric suffix rather than failing the create.
async function uniqueSlug(base, excludeId = null) {
  let candidate = base;
  for (let n = 2; n < 100; n++) {
    const { rows } = await query(
      "select 1 from teams where slug = $1 and ($2::uuid is null or id <> $2)",
      [candidate, excludeId]
    );
    if (!rows.length) return candidate;
    candidate = `${base}-${n}`;
  }
  throw new Error("Could not generate a unique slug for that team name.");
}

export async function listTeams() {
  const { rows } = await query(
    `select t.*, count(s.id) as member_count
       from teams t
       left join staff_users s on s.team_id = t.id
      group by t.id
      order by t.name asc`
  );
  return rows.map(rowToTeam);
}

export async function getTeam(id) {
  const { rows } = await query(
    `select t.*, (select count(*) from staff_users s where s.team_id = t.id) as member_count
       from teams t where t.id = $1`,
    [id]
  );
  return rows[0] ? rowToTeam(rows[0]) : null;
}

export async function getTeamBySlug(slug) {
  const { rows } = await query("select * from teams where slug = $1", [slug]);
  return rows[0] ? rowToTeam(rows[0]) : null;
}

export async function createTeam({ name, description, defaultWpRole }, createdBy = null) {
  const cleanedName = cleanName(name);
  const role = assertDefaultRole(defaultWpRole || "editor", await knownRoleSlugs());
  const slug = await uniqueSlug(slugify(cleanedName));

  const { rows } = await query(
    `insert into teams (name, slug, description, default_wp_role, created_by)
     values ($1,$2,$3,$4,$5) returning *`,
    [cleanedName, slug, String(description || "").trim() || null, role, createdBy]
  ).catch((err) => {
    // teams_name_lower_idx — a friendlier message than the raw constraint.
    if (err.code === "23505") throw new Error(`A team called "${cleanedName}" already exists.`);
    throw err;
  });
  return rowToTeam(rows[0]);
}

export async function updateTeam(id, { name, description, defaultWpRole }) {
  const current = await getTeam(id);
  if (!current) return null;

  const cleanedName = name === undefined ? current.name : cleanName(name);
  const role = defaultWpRole === undefined
    ? current.defaultWpRole
    : assertDefaultRole(defaultWpRole, await knownRoleSlugs());
  const desc = description === undefined ? current.description : String(description || "").trim();

  // Renaming re-derives the slug only when the name actually changed, so links
  // and seeded slugs stay stable through an unrelated edit.
  const slug = cleanedName === current.name ? current.slug : await uniqueSlug(slugify(cleanedName), id);

  const { rows } = await query(
    `update teams set name=$2, slug=$3, description=$4, default_wp_role=$5, updated_at=now()
      where id=$1 returning *`,
    [id, cleanedName, slug, desc || null, role]
  ).catch((err) => {
    if (err.code === "23505") throw new Error(`A team called "${cleanedName}" already exists.`);
    throw err;
  });
  return rows[0] ? rowToTeam(rows[0]) : null;
}

/** How many website assignments this team's members currently hold. */
export async function teamAssignmentCount(id) {
  const { rows } = await query(
    `select count(*)::int n
       from website_user_assignments a
       join staff_users s on s.id = a.staff_user_id
      where s.team_id = $1 and a.state <> 'removed'`,
    [id]
  );
  return rows[0]?.n || 0;
}

/**
 * Deletes a team. Never implicit about its members or their websites.
 *
 * Two dispositions, both required when they apply, because the alternative is
 * guessing:
 *
 *   onUsers       'unassign' (members stay, with no team) or 'move' to another.
 *   onAssignments 'keep' (website accounts continue untouched) or 'remove'.
 *
 * "remove" means UNLINK — we stop managing those accounts. It does NOT delete
 * anyone's WordPress account. Deleting a team is an organisational change in
 * this app; destroying accounts on client sites is a separate, per-site
 * operation with its own content checks, and quietly folding one into the other
 * would be the most dangerous shortcut in the whole feature.
 *
 * Returns the unlink work for the caller to run as a job, rather than doing it
 * here: those are per-site calls that can fail individually and need the same
 * progress and retry handling as any other bulk operation.
 */
export async function deleteTeam(id, { onUsers, moveToTeamId, onAssignments } = {}) {
  const team = await getTeam(id);
  if (!team) return null;

  const assignments = await teamAssignmentCount(id);
  let memberIds = [];

  if (team.memberCount > 0) {
    if (onUsers !== "unassign" && onUsers !== "move") {
      throw new Error(`"${team.name}" still has ${team.memberCount} member(s). Choose what happens to them before deleting the team.`);
    }
    if (assignments > 0 && onAssignments !== "keep" && onAssignments !== "remove") {
      throw new Error(`Members of "${team.name}" have ${assignments} website assignment(s). Choose whether to keep or release them before deleting the team.`);
    }
    if (onUsers === "move") {
      if (!moveToTeamId || moveToTeamId === id) {
        throw new Error("Choose a different team to move the members into.");
      }
      const target = await getTeam(moveToTeamId);
      if (!target) throw new Error("The team you chose to move members into no longer exists.");
    }

    const { rows } = await query("select id from staff_users where team_id = $1", [id]);
    memberIds = rows.map((r) => r.id);

    if (onUsers === "move") {
      await query("update staff_users set team_id=$2, updated_at=now() where team_id=$1", [id, moveToTeamId]);
    } else {
      await query("update staff_users set team_id=null, updated_at=now() where team_id=$1", [id]);
    }
  }

  // Which website assignments the caller should now release, if any.
  let toUnlink = [];
  if (onAssignments === "remove" && memberIds.length) {
    const { rows } = await query(
      `select staff_user_id, website_id from website_user_assignments
        where staff_user_id = any($1::uuid[]) and state <> 'removed'`,
      [memberIds]
    );
    toUnlink = rows.map((r) => ({ staffUserId: r.staff_user_id, websiteId: r.website_id }));
  }

  await query("delete from teams where id=$1", [id]);

  return {
    team,
    membersHandled: team.memberCount,
    memberIds,
    disposition: team.memberCount > 0 ? onUsers : "none",
    movedToTeamId: onUsers === "move" ? moveToTeamId : null,
    assignmentCount: assignments,
    assignmentDisposition: assignments > 0 ? (onAssignments || "keep") : "none",
    // Never account deletions — unlinks. Stated in the return value so a caller
    // cannot mistake one for the other.
    toUnlink,
    deletesWordPressAccounts: false,
  };
}

// The role a member of this team gets by default, before any per-user or
// per-website override. Exposed so the assignment planner has one definition.
export function effectiveTeamRole(team) {
  return normalizeRoleSlug(team?.defaultWpRole || "subscriber");
}
