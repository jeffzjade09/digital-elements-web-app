// WordPress role vocabulary.
//
// Scope in this phase: the five roles WordPress ships with, used to validate
// team and per-user *default* roles. Sites can define custom roles through
// plugins, but we can only know those by asking the site — so the per-website
// role cache and custom-role support arrive with the phase that makes plugin
// calls. Until then a default role must be one of the core five, which keeps a
// typo from being stored as a team's default and silently failing on every
// site later.

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
