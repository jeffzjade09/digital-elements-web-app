// Audit trail for administrative actions.
//
// Framework-free on purpose (plain arguments in, plain objects out) so this
// module moves to Nexus unchanged. Route handlers pass `req` through
// actorFrom() rather than this module knowing anything about Express.

import { query } from "../db.js";

// Keys whose values must never reach the audit table. Matched case-insensitively
// against the key name at any depth, so a nested { credential: { secret } } is
// caught as surely as a top-level one.
const REDACT = /secret|password|passwd|token|signature|idempotency|license|authorization|cookie|api[_-]?key/i;

export function redact(value, depth = 0) {
  if (value == null || depth > 6) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

// Pulls the acting identity out of an Express request, including the client IP.
// Kept here so every caller records the actor the same way.
export function actorFrom(req) {
  return {
    actorUserId: req?.user?.id || null,
    actorEmail: req?.user?.email || null,
    ip: req?.ip || null,
  };
}

/**
 * Writes one audit row.
 *
 * Deliberately best-effort: a failed audit write is logged loudly but does not
 * throw. These calls happen *after* the action has already been applied — often
 * on a client's WordPress site — and failing the request at that point would
 * report a false failure for work that actually succeeded, which is worse than
 * a gap in the log that the error log still captures.
 */
export async function record(entry) {
  const e = entry || {};
  try {
    const { rows } = await query(
      `insert into audit_log
         (actor_user_id, actor_email, action, entity_type, entity_id,
          website_id, target_email, before, after, result, ip)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       returning id, at`,
      [
        e.actorUserId || null,
        e.actorEmail || null,
        e.action,
        e.entityType || null,
        e.entityId != null ? String(e.entityId) : null,
        e.websiteId || null,
        e.targetEmail ? String(e.targetEmail).toLowerCase() : null,
        e.before ? JSON.stringify(redact(e.before)) : null,
        e.after ? JSON.stringify(redact(e.after)) : null,
        e.result || "ok",
        e.ip || null,
      ]
    );
    return rows[0] || null;
  } catch (err) {
    console.error(`[audit] Failed to record "${e.action}":`, err.message);
    return null;
  }
}

/**
 * Distinct values worth filtering on, taken from the log itself.
 *
 * Built from what has actually happened rather than a hardcoded list, so a new
 * action type appears in the filter the first time it occurs instead of the
 * next time someone remembers to add it.
 */
export async function facets() {
  const [actions, actors, entityTypes] = await Promise.all([
    query("select distinct action from audit_log order by action"),
    query("select distinct actor_email from audit_log where actor_email is not null order by actor_email"),
    query("select distinct entity_type from audit_log where entity_type is not null order by entity_type"),
  ]);
  return {
    actions: actions.rows.map((r) => r.action),
    actors: actors.rows.map((r) => r.actor_email),
    entityTypes: entityTypes.rows.map((r) => r.entity_type),
  };
}

// Newest first. Every filter is optional; `limit` is clamped so a caller can't
// ask for the whole table.
export async function list({ entityType, entityId, websiteId, actorEmail, action, limit = 100 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace("$?", `$${params.length}`)); };

  if (entityType) add("entity_type = $?", entityType);
  if (entityId) add("entity_id = $?", String(entityId));
  if (websiteId) add("website_id = $?", websiteId);
  if (actorEmail) add("lower(actor_email) = $?", String(actorEmail).toLowerCase());
  if (action) add("action = $?", action);

  params.push(Math.min(500, Math.max(1, Math.round(Number(limit) || 100))));
  const { rows } = await query(
    `select id, actor_user_id, actor_email, action, entity_type, entity_id,
            website_id, target_email, before, after, result, at
       from audit_log
      ${where.length ? "where " + where.join(" and ") : ""}
      order by at desc
      limit $${params.length}`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    actorEmail: r.actor_email,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    websiteId: r.website_id,
    targetEmail: r.target_email,
    before: r.before,
    after: r.after,
    result: r.result,
    at: r.at,
  }));
}
