// Teams — groups of internal agency staff.
//
// Named "teams" rather than "departments" deliberately: Nexus already uses
// "departments" for the client product catalog (web_dev / ppc / seo / social)
// and the two must not collide when this feature is ported.
//
// No Express, no req/res — plain arguments in, plain objects out.

import { query } from "../db.js";
import { assertDefaultRole, normalizeRoleSlug } from "./roles.js";

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
  const role = assertDefaultRole(defaultWpRole || "editor");
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
    : assertDefaultRole(defaultWpRole);
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

/**
 * Deletes a team. Never implicit about its members.
 *
 * `onUsers` must be given explicitly whenever the team has members:
 *   'unassign' — members stay, with no team
 *   'move'     — members move to `moveToTeamId`
 *
 * Deleting a team never touches any WordPress account. Website assignments are
 * handled from the phase that introduces them; until then there are none, and
 * this function states that rather than pretending to decide it.
 */
export async function deleteTeam(id, { onUsers, moveToTeamId } = {}) {
  const team = await getTeam(id);
  if (!team) return null;

  if (team.memberCount > 0) {
    if (onUsers !== "unassign" && onUsers !== "move") {
      throw new Error(`"${team.name}" still has ${team.memberCount} member(s). Choose what happens to them before deleting the team.`);
    }
    if (onUsers === "move") {
      if (!moveToTeamId || moveToTeamId === id) {
        throw new Error("Choose a different team to move the members into.");
      }
      const target = await getTeam(moveToTeamId);
      if (!target) throw new Error("The team you chose to move members into no longer exists.");
      await query("update staff_users set team_id=$2, updated_at=now() where team_id=$1", [id, moveToTeamId]);
    } else {
      await query("update staff_users set team_id=null, updated_at=now() where team_id=$1", [id]);
    }
  }

  await query("delete from teams where id=$1", [id]);
  return {
    team,
    membersHandled: team.memberCount,
    disposition: team.memberCount > 0 ? onUsers : "none",
    movedToTeamId: onUsers === "move" ? moveToTeamId : null,
  };
}

// The role a member of this team gets by default, before any per-user or
// per-website override. Exposed so the assignment planner has one definition.
export function effectiveTeamRole(team) {
  return normalizeRoleSlug(team?.defaultWpRole || "subscriber");
}
