// Staff users — the roster we synchronize to client WordPress sites.
//
// Separate from app_users (the dashboard sign-in allow-list) because most staff
// need a WordPress account without ever signing in here. app_user_id links the
// two when the same person has both.

import { query } from "../db.js";
import { assertDefaultRole, normalizeRoleSlug } from "./roles.js";

export const AGENCY_DOMAIN = "digitalelementsgroup.com";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rowToStaff(r) {
  return {
    id: r.id,
    email: r.email,
    firstName: r.first_name || "",
    lastName: r.last_name || "",
    displayName: r.display_name || "",
    label: displayLabel(r),
    teamId: r.team_id,
    teamName: r.team_name || null,
    teamSlug: r.team_slug || null,
    teamDefaultWpRole: r.team_default_wp_role || null,
    defaultWpRole: r.default_wp_role || null,
    effectiveWpRole: effectiveRole(r),
    status: r.status,
    appUserId: r.app_user_id,
    domainOverride: r.domain_override,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// We seeded the roster from email addresses alone, so the local part is the
// honest fallback until someone fills in a real name — better than guessing
// "Npappas" from npappas@.
export function displayLabel(r) {
  const full = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
  return r.display_name || full || String(r.email || "").split("@")[0];
}

/**
 * The WordPress role this person should get, before any per-website override:
 * their own default if set, otherwise their team's, otherwise subscriber.
 * Least privilege is the floor — never administrator by inheritance.
 */
export function effectiveRole(r) {
  return normalizeRoleSlug(r.default_wp_role || r.team_default_wp_role || "subscriber");
}

/**
 * WordPress username for a new account: the email local part, sanitized the way
 * sanitize_user() would. Collisions are resolved on the site itself (the plugin
 * appends a numeric suffix), because only the site knows what is already taken.
 */
export function wpUsernameFor(email) {
  const local = String(email || "").split("@")[0].toLowerCase();
  const cleaned = local.replace(/[^a-z0-9_.\-]/g, "").replace(/^[._-]+|[._-]+$/g, "");
  return cleaned.slice(0, 50) || "user";
}

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/**
 * Agency-domain restriction. Outside addresses are refused unless an authorized
 * administrator explicitly overrides — enforced here and again at assignment
 * time, so the check can't be skipped by going straight to a sync call.
 */
export function assertEmailAllowed(email, { overrideDomain = false } = {}) {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) throw new Error("Enter a valid email address.");
  if (e.endsWith(`@${AGENCY_DOMAIN}`)) return e;
  if (!overrideDomain) {
    const err = new Error(`${e} is outside @${AGENCY_DOMAIN}. Confirm the override to add an external address.`);
    err.code = "domain_restricted";
    throw err;
  }
  return e;
}

const SELECT = `
  select s.*, t.name as team_name, t.slug as team_slug, t.default_wp_role as team_default_wp_role
    from staff_users s
    left join teams t on t.id = s.team_id`;

export async function listStaff({ q, teamId, status, role, unassigned } = {}) {
  const where = [];
  const params = [];

  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    where.push(`(s.email ilike ${p} or coalesce(s.display_name,'') ilike ${p} or trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) ilike ${p})`);
  }
  if (teamId) { params.push(teamId); where.push(`s.team_id = $${params.length}`); }
  if (unassigned) where.push("s.team_id is null");
  if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
  // Filtering by role means the *effective* role, so someone inheriting their
  // team's default matches too — otherwise the filter would miss most people.
  if (role) {
    params.push(normalizeRoleSlug(role));
    where.push(`coalesce(s.default_wp_role, t.default_wp_role, 'subscriber') = $${params.length}`);
  }

  let sql = SELECT;
  if (where.length) sql += " where " + where.join(" and ");
  sql += " order by t.name asc nulls last, lower(coalesce(s.display_name, s.email)) asc";

  const { rows } = await query(sql, params);
  return rows.map(rowToStaff);
}

export async function getStaff(id) {
  const { rows } = await query(`${SELECT} where s.id = $1`, [id]);
  return rows[0] ? rowToStaff(rows[0]) : null;
}

export async function getStaffByEmail(email) {
  const { rows } = await query(`${SELECT} where lower(s.email) = lower($1)`, [normalizeEmail(email)]);
  return rows[0] ? rowToStaff(rows[0]) : null;
}

export async function createStaff(input, createdBy = null) {
  const d = input || {};
  const overrideDomain = d.overrideDomain === true;
  const email = assertEmailAllowed(d.email, { overrideDomain });
  const isExternal = !email.endsWith(`@${AGENCY_DOMAIN}`);
  const role = d.defaultWpRole ? assertDefaultRole(d.defaultWpRole) : null;

  if (d.teamId) await assertTeamExists(d.teamId);

  const inserted = await query(
    `insert into staff_users
       (email, first_name, last_name, display_name, team_id, default_wp_role,
        status, domain_override, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning id`,
    [
      email,
      trimOrNull(d.firstName), trimOrNull(d.lastName), trimOrNull(d.displayName),
      d.teamId || null, role,
      d.status === "disabled" ? "disabled" : "active",
      isExternal, createdBy,
    ]
  ).catch((err) => {
    if (err.code === "23505") throw new Error(`${email} is already on the roster.`);
    throw err;
  });

  const id = inserted.rows[0].id;
  // Link to a dashboard login if this person already has one.
  await query(
    "update staff_users s set app_user_id = a.id from app_users a where s.id=$1 and lower(a.email)=lower(s.email)",
    [id]
  );
  return getStaff(id);
}

export async function updateStaff(id, input) {
  const current = await getStaff(id);
  if (!current) return null;
  const d = input || {};

  const email = d.email === undefined
    ? current.email
    : assertEmailAllowed(d.email, { overrideDomain: d.overrideDomain === true || current.domainOverride });
  const isExternal = !email.endsWith(`@${AGENCY_DOMAIN}`);

  const role = d.defaultWpRole === undefined
    ? current.defaultWpRole
    : (!d.defaultWpRole ? null : assertDefaultRole(d.defaultWpRole));

  const teamId = d.teamId === undefined ? current.teamId : (d.teamId || null);
  if (teamId && teamId !== current.teamId) await assertTeamExists(teamId);

  const updated = await query(
    `update staff_users set
       email=$2, first_name=$3, last_name=$4, display_name=$5,
       team_id=$6, default_wp_role=$7, status=$8, domain_override=$9, updated_at=now()
     where id=$1 returning id`,
    [
      id, email,
      d.firstName === undefined ? current.firstName || null : trimOrNull(d.firstName),
      d.lastName === undefined ? current.lastName || null : trimOrNull(d.lastName),
      d.displayName === undefined ? current.displayName || null : trimOrNull(d.displayName),
      teamId, role,
      d.status === undefined ? current.status : (d.status === "disabled" ? "disabled" : "active"),
      isExternal,
    ]
  ).catch((err) => {
    if (err.code === "23505") throw new Error(`${email} is already on the roster.`);
    throw err;
  });
  return updated.rows[0] ? getStaff(id) : null;
}

/**
 * Removes someone from the roster. App-side only — this never touches a
 * WordPress account. Removing their WordPress accounts is a separate, explicit
 * operation with its own content-ownership checks.
 */
export async function deleteStaff(id) {
  const staff = await getStaff(id);
  if (!staff) return null;
  await query("delete from staff_users where id=$1", [id]);
  return staff;
}

// Bulk team move — one statement so a partial move can't happen.
export async function moveToTeam(ids, teamId) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return [];
  if (teamId) await assertTeamExists(teamId);
  const { rows } = await query(
    "update staff_users set team_id=$2, updated_at=now() where id = any($1::uuid[]) returning id",
    [list, teamId || null]
  );
  return rows.map((r) => r.id);
}

async function assertTeamExists(teamId) {
  const { rows } = await query("select 1 from teams where id=$1", [teamId]);
  if (!rows.length) throw new Error("That team no longer exists.");
}

function trimOrNull(v) {
  const s = String(v == null ? "" : v).trim();
  return s || null;
}
