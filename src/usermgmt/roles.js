// WordPress roles — the fixed vocabulary, and what each site actually has.
//
// Two layers, and the difference matters:
//
//   CORE_ROLES is the five roles WordPress ships with. It validates team and
//   per-user *default* roles, which are stored before we know which sites they
//   will be applied to, so they must be roles every WordPress install has.
//
//   getSiteRoles() is what a specific site will accept. Plugins add roles
//   freely, and get_editable_roles() is where site owners restrict what may be
//   assigned, so the only correct answer comes from the site itself. Cached in
//   wp_role_cache so opening a role picker doesn't re-ask every site.

import { query, getPool } from "../db.js";
import { callSite } from "./wpClient.js";

export const CORE_ROLES = [
  { slug: "administrator", name: "Administrator", adminLike: true },
  { slug: "editor",        name: "Editor",        adminLike: false },
  { slug: "author",        name: "Author",        adminLike: false },
  { slug: "contributor",   name: "Contributor",   adminLike: false },
  { slug: "subscriber",    name: "Subscriber",    adminLike: false },
];

const BY_SLUG = new Map(CORE_ROLES.map((r) => [r.slug, r]));

// WordPress role slugs are lowercase keys; normalizing here means the UI can be
// forgiving without the storage layer being.
export function normalizeRoleSlug(slug) {
  return String(slug || "").trim().toLowerCase().replace(/[^a-z0-9_\-]/g, "");
}

export function isCoreRole(slug) {
  return BY_SLUG.has(normalizeRoleSlug(slug));
}

export function roleName(slug) {
  return BY_SLUG.get(normalizeRoleSlug(slug))?.name || slug;
}

// Roles that can administer a site. Assigning one is always an explicit,
// confirmed action — never a default and never inherited from a team.
export function isAdminLikeRole(slug) {
  return BY_SLUG.get(normalizeRoleSlug(slug))?.adminLike === true;
}

/**
 * Validates a role being stored as a team or user *default*.
 * Throws a message safe to show an administrator.
 */
export function assertDefaultRole(slug) {
  const s = normalizeRoleSlug(slug);
  if (!isCoreRole(s)) {
    throw new Error(`"${slug}" is not a valid WordPress role. Choose one of: ${CORE_ROLES.map((r) => r.slug).join(", ")}.`);
  }
  if (isAdminLikeRole(s)) {
    throw new Error("Administrator can't be a default role. Grant it per website, with confirmation, when it's actually needed.");
  }
  return s;
}

/* ------------------------------------------------------ per-website roles -- */

// Long enough that opening the role picker doesn't re-ask every site, short
// enough that a newly installed plugin's roles show up the same day.
const ROLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function rowToRole(r) {
  return {
    slug: r.slug,
    name: r.name,
    // Two tiers. adminLike is the broad classification (site administration OR
    // unfiltered_html); siteAdmin is the narrow one a confirmation keys off.
    // Stock WordPress grants unfiltered_html to Editor — every team's default
    // role — so confirming on the broad flag would fire on the common case.
    adminLike: r.is_admin_like,
    siteAdmin: r.is_site_admin,
    capabilityCount: r.capability_count,
    fetchedAt: r.fetched_at,
  };
}

/** Cached roles for one site, oldest-fetched first. Empty if never fetched. */
export async function getCachedRoles(websiteId) {
  const { rows } = await query(
    `select slug, name, is_admin_like, is_site_admin, capability_count, fetched_at
       from wp_role_cache where website_id = $1 order by slug asc`,
    [websiteId]
  );
  return rows.map(rowToRole);
}

async function cacheAgeMs(websiteId) {
  const { rows } = await query("select um_roles_fetched_at from websites where id = $1", [websiteId]);
  const at = rows[0]?.um_roles_fetched_at;
  return at ? Date.now() - new Date(at).getTime() : Infinity;
}

/**
 * Replaces a site's cached roles with what the site just reported.
 *
 * Deletes the slugs that disappeared rather than merging, so a role removed by
 * deactivating a plugin stops being offered. Done in one transaction so the
 * picker never reads a half-updated list.
 */
async function storeRoles(websiteId, roles, defaultRole) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const slugs = roles.map((r) => r.slug);
    await client.query(
      "delete from wp_role_cache where website_id = $1 and not (slug = any($2::text[]))",
      [websiteId, slugs]
    );
    for (const r of roles) {
      await client.query(
        `insert into wp_role_cache (website_id, slug, name, is_admin_like, is_site_admin, capability_count, fetched_at)
         values ($1,$2,$3,$4,$5,$6, now())
         on conflict (website_id, slug) do update set
           name = excluded.name,
           is_admin_like = excluded.is_admin_like,
           is_site_admin = excluded.is_site_admin,
           capability_count = excluded.capability_count,
           fetched_at = now()`,
        [websiteId, r.slug, r.name, r.adminLike, r.siteAdmin, r.capabilityCount]
      );
    }
    await client.query(
      "update websites set um_default_role = $2, um_roles_fetched_at = now() where id = $1",
      [websiteId, defaultRole || null]
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The roles a site will accept.
 *
 * Returns the cache unless it is stale or `force` is set. A failed refresh
 * falls back to the cached list with `stale: true` rather than throwing — an
 * unreachable site should not empty a role picker that was working a minute
 * ago. Only a site we have never reached returns no roles at all.
 */
export async function getSiteRoles(site, { force = false } = {}) {
  const cached = await getCachedRoles(site.id);
  const age = await cacheAgeMs(site.id);

  if (!force && cached.length && age < ROLE_CACHE_TTL_MS) {
    const { rows } = await query("select um_default_role from websites where id = $1", [site.id]);
    return { websiteId: site.id, roles: cached, defaultRole: rows[0]?.um_default_role || null, stale: false, fromCache: true, error: null };
  }

  try {
    const data = await callSite(site, { method: "GET", route: "/roles" });
    const roles = (Array.isArray(data.roles) ? data.roles : []).map((r) => ({
      slug: normalizeRoleSlug(r.slug),
      name: String(r.name || r.slug),
      adminLike: r.is_admin_like === true,
      // A plugin older than this contract won't send is_site_admin. Falling
      // back to the broad flag errs toward asking for a confirmation rather
      // than silently skipping one.
      siteAdmin: r.is_site_admin === undefined ? r.is_admin_like === true : r.is_site_admin === true,
      capabilityCount: Number(r.capability_count) || 0,
      adminLikeCaps: Array.isArray(r.admin_like_caps) ? r.admin_like_caps : [],
    })).filter((r) => r.slug);

    await storeRoles(site.id, roles, data.default_role);
    return {
      websiteId: site.id,
      roles: roles.map(({ adminLikeCaps, ...r }) => ({ ...r, adminLikeCaps })),
      defaultRole: data.default_role || null,
      stale: false, fromCache: false, error: null,
    };
  } catch (err) {
    return {
      websiteId: site.id,
      roles: cached,
      defaultRole: null,
      stale: true,
      fromCache: cached.length > 0,
      error: err.message,
    };
  }
}

/**
 * Is `roleSlug` assignable on this site?
 *
 * `known: false` means we have never successfully read this site's roles, which
 * is different from knowing the role is absent — the caller must say
 * "couldn't check", not "not available".
 */
export function checkRoleAvailability(roleSlug, siteRoles) {
  const slug = normalizeRoleSlug(roleSlug);
  if (!siteRoles || !siteRoles.length) {
    return {
      role: slug, known: false, available: false,
      adminLike: isAdminLikeRole(slug), siteAdmin: isAdminLikeRole(slug),
      alternatives: [],
    };
  }
  const match = siteRoles.find((r) => r.slug === slug);
  return {
    role: slug,
    known: true,
    available: !!match,
    adminLike: match ? match.adminLike : isAdminLikeRole(slug),
    siteAdmin: match ? match.siteAdmin === true : isAdminLikeRole(slug),
    name: match ? match.name : roleName(slug),
    // What to offer instead when the requested role isn't there. A role that
    // can administer the site is never suggested — a missing Editor must not
    // quietly become Administrator.
    alternatives: match ? [] : siteRoles.filter((r) => !r.siteAdmin).map((r) => ({ slug: r.slug, name: r.name })),
  };
}

/** Roles for many sites at once, bounded so a picker can't fan out unbounded. */
export async function getRolesForSites(sites, { force = false, concurrency = 4 } = {}) {
  const out = new Array(sites.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, sites.length) }, async () => {
    while (cursor < sites.length) {
      const i = cursor++;
      try {
        out[i] = await getSiteRoles(sites[i], { force });
      } catch (err) {
        out[i] = { websiteId: sites[i].id, roles: [], defaultRole: null, stale: true, fromCache: false, error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
