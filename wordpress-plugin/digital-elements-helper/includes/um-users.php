<?php
/**
 * de/v2 read endpoints: roles, users, and the existence lookup.
 *
 * Read-only. Nothing here creates, changes or deletes anything — the write
 * routes arrive in their own phase, with their own scopes.
 *
 * Two rules shape every response in this file:
 *
 * 1. ONLY SAFE FIELDS LEAVE THE SITE. WP_User exposes the password hash, the
 *    activation key, session tokens and every meta value; all of that is a
 *    client's private data and none of it is needed to decide whether an
 *    account exists and what role it has. Each user is therefore rebuilt field
 *    by field into a fixed shape (deheled_um_user_shape) rather than filtered
 *    on the way out, so a future WordPress release adding a property cannot
 *    silently widen what we disclose.
 *
 * 2. `_de_managed` IS THE ONLY USER META THIS FILE READS. Names, capabilities
 *    and everything else come from the user object or the role map, never from
 *    meta — a client's custom meta is their business. `_de_managed` marks the
 *    accounts this tool created or that an administrator deliberately linked.
 *    The write phases refuse to touch anything without it; reporting it here is
 *    what lets the dashboard show "already exists — link?" instead of silently
 *    adopting a client's own account.
 */

if (!defined('ABSPATH')) { exit; }

/** User meta marking an account as managed by Digital Elements. */
define('DEHELED_UM_MANAGED_META', '_de_managed');
/** Did WE create this account, or did we merely adopt one the site already had? */
define('DEHELED_UM_CREATED_META', '_de_created');
/** When this person set their own password. Stamped by WordPress's own hooks. */
define('DEHELED_UM_PASSWORD_SET_META', '_de_password_set_at');

const DEHELED_UM_MAX_PER_PAGE = 100;

add_action('rest_api_init', function () {
    register_rest_route(DEHELED_UM_NAMESPACE, '/roles', array(
        'methods'             => 'GET',
        'permission_callback' => deheled_um_permission('users:read'),
        'callback'            => 'deheled_um_rest_roles',
    ));
    register_rest_route(DEHELED_UM_NAMESPACE, '/users', array(
        'methods'             => 'GET',
        'permission_callback' => deheled_um_permission('users:read'),
        'callback'            => 'deheled_um_rest_users',
    ));
    register_rest_route(DEHELED_UM_NAMESPACE, '/users/lookup', array(
        'methods'             => 'GET',
        'permission_callback' => deheled_um_permission('users:read'),
        'callback'            => 'deheled_um_rest_user_lookup',
    ));
});

/* ---------------------------------------------------------------- roles --- */

/**
 * Capabilities that make a role elevated. Reported in two tiers, because
 * collapsing them into one would make the flag useless.
 *
 * SITE ADMIN — can administer the site, or execute code on it, or escalate into
 * doing either. Assigning one of these always needs an explicit confirmation
 * AND the users:admin scope.
 *
 * The list is deliberately broad: install_plugins alone is arbitrary code
 * execution, and roles carrying it without manage_options are common on real
 * client sites. It is a deny-list rather than an allow-list because an
 * allow-list would classify every plugin-defined role (shop_manager and
 * friends) as elevated, putting a confirmation in front of ordinary work —
 * which is the failure mode this whole two-tier split exists to avoid.
 *
 * CONTENT RISK — unfiltered_html. Not administration, but it allows storing
 * arbitrary script in content, so it is worth surfacing.
 *
 * The distinction matters in practice: stock WordPress grants unfiltered_html
 * to EDITOR as well as administrator. Treating that single capability as
 * "admin-like, confirm before assigning" would put a confirmation in front of
 * the ordinary Editor assignment that is every team's default — and a
 * confirmation that fires on the common case is one people learn to click
 * through, which is worse than not having it.
 *
 * is_admin_like therefore stays the broad classification (either tier), and
 * is_site_admin is the narrower one the confirmation actually keys off.
 */
function deheled_um_site_admin_caps() {
    return array(
        // Administering the site and its users.
        'manage_options', 'promote_users', 'edit_users', 'delete_users', 'create_users',
        'remove_users', 'list_users', 'edit_dashboard',
        // Capabilities that are code execution in practice. A role holding any
        // of these can install or edit PHP that runs on the site, which is a
        // larger grant than "administrator" sounds like — and several of them
        // exist on real client sites in roles that do NOT hold manage_options
        // (membership plugins, LMS plugins, agency "Site Manager" roles).
        'install_plugins', 'activate_plugins', 'edit_plugins', 'delete_plugins', 'update_plugins',
        'install_themes', 'switch_themes', 'edit_themes', 'delete_themes', 'update_themes',
        'edit_theme_options', 'update_core', 'edit_files', 'unfiltered_upload',
        // Bulk data in and out.
        'import', 'export',
        // Multisite.
        'manage_network', 'manage_sites', 'manage_network_options',
        'manage_network_plugins', 'manage_network_themes', 'manage_network_users',
    );
}

function deheled_um_content_risk_caps() {
    return array('unfiltered_html');
}

function deheled_um_admin_like_caps() {
    return array_merge(deheled_um_site_admin_caps(), deheled_um_content_risk_caps());
}

function deheled_um_caps_intersect($caps, $wanted) {
    if (!is_array($caps)) return array();
    $found = array();
    foreach ($wanted as $cap) {
        if (!empty($caps[$cap])) $found[] = $cap;
    }
    return $found;
}

function deheled_um_role_is_admin_like($caps) {
    return count(deheled_um_caps_intersect($caps, deheled_um_admin_like_caps())) > 0;
}

function deheled_um_role_is_site_admin($caps) {
    return count(deheled_um_caps_intersect($caps, deheled_um_site_admin_caps())) > 0;
}

/**
 * Roles this site will accept, straight from get_editable_roles().
 *
 * Read from the site rather than assumed, because plugins add roles freely —
 * WooCommerce alone adds two. get_editable_roles() is also the filter point
 * site owners use to restrict what may be assigned, so honouring it means a
 * site that has already limited its own roles is limited for us too.
 */
function deheled_um_editable_roles() {
    if (!function_exists('get_editable_roles')) {
        require_once ABSPATH . 'wp-admin/includes/user.php';
    }
    return get_editable_roles();
}

function deheled_um_rest_roles($request) {
    $roles = array();
    foreach (deheled_um_editable_roles() as $slug => $role) {
        $caps = isset($role['capabilities']) && is_array($role['capabilities']) ? $role['capabilities'] : array();
        $granted = array();
        foreach ($caps as $cap => $on) {
            if ($on) $granted[] = (string) $cap;
        }
        $roles[] = array(
            'slug'             => (string) $slug,
            'name'             => isset($role['name']) ? (string) translate_user_role($role['name']) : (string) $slug,
            'is_admin_like'    => deheled_um_role_is_admin_like($caps),
            'is_site_admin'    => deheled_um_role_is_site_admin($caps),
            'capability_count' => count($granted),
            // Named so the dashboard can explain WHY a role is elevated, rather
            // than just asserting that it is.
            'admin_like_caps'  => deheled_um_caps_intersect($caps, deheled_um_admin_like_caps()),
        );
    }

    usort($roles, function ($a, $b) { return strcmp($a['slug'], $b['slug']); });

    return rest_ensure_response(array(
        'ok'           => true,
        'roles'        => $roles,
        'default_role' => (string) get_option('default_role', 'subscriber'),
        'generated_at' => current_time('c'),
    ));
}

/* ---------------------------------------------------------------- users --- */

/**
 * The only shape a user ever leaves this site in.
 *
 * Built field by field on purpose. Taking WP_User and removing what we don't
 * want would mean every future WordPress release could add a property we then
 * disclose by default; an allow-list cannot fail that way.
 */
function deheled_um_user_shape($user) {
    if (!($user instanceof WP_User)) return null;
    return array(
        'id'           => (int) $user->ID,
        'login'        => (string) $user->user_login,
        'email'        => (string) $user->user_email,
        'display_name' => (string) $user->display_name,
        'roles'         => array_values(array_map('strval', (array) $user->roles)),
        'managed'       => deheled_um_user_is_managed($user->ID),
        'registered'    => (string) $user->user_registered,
        // Derived from the account's roles, not from meta: _de_managed is the
        // only user meta this endpoint reads or reports.
        'is_admin_like' => deheled_um_user_has_role_matching($user, 'deheled_um_role_is_admin_like'),
        // Lets the dashboard warn before demoting the last administrator,
        // without disclosing who the other administrators are.
        'is_site_admin' => deheled_um_user_has_role_matching($user, 'deheled_um_role_is_site_admin'),

        // ---- invitation status (2.7.3) -----------------------------------
        //
        // This shape used to say "_de_managed is the only user meta this
        // endpoint reads or reports", and first_name/last_name were removed to
        // make that true. Widening it is deliberate and limited to what answers
        // one question: did the person we invited ever get in?
        //
        // Three things, and nothing else:
        'created_by_us'      => deheled_um_user_was_created_by_us($user->ID),
        'password_set_at'    => deheled_um_password_set_at($user->ID),
        // A BOOLEAN derived from user_activation_key. The key itself never
        // leaves this site: it is the credential that would let anyone reset
        // this account's password, and the dashboard has no use for it that
        // could justify the risk of holding a copy.
        'activation_pending' => deheled_um_activation_pending($user),
    );
}

/** When this person set their own password, or null if we never saw it happen. */
function deheled_um_password_set_at($user_id) {
    $at = get_user_meta((int) $user_id, DEHELED_UM_PASSWORD_SET_META, true);
    return $at ? (int) $at : null;
}

/**
 * Is there still an unused password-setup link outstanding?
 *
 * WordPress writes user_activation_key when it sends a set-password or reset
 * email, and clears it when the reset completes. So a key that is still there
 * means nobody has acted on the invitation yet — which for an account we
 * created means the person has never signed in, because the password we
 * generated was never disclosed to anyone.
 */
function deheled_um_activation_pending($user) {
    if (!($user instanceof WP_User)) return false;
    return isset($user->user_activation_key) && $user->user_activation_key !== '';
}

function deheled_um_user_is_managed($user_id) {
    return get_user_meta((int) $user_id, DEHELED_UM_MANAGED_META, true) === '1';
}

/**
 * Did we create this account?
 *
 * A stronger claim than "managed", and deliberately never cleared: an account
 * we merely linked is the website's own, which is why the reset route refuses
 * it. See um-write.php.
 */
function deheled_um_user_was_created_by_us($user_id) {
    return get_user_meta((int) $user_id, DEHELED_UM_CREATED_META, true) === '1';
}

function deheled_um_user_has_role_matching($user, $predicate) {
    $editable = deheled_um_editable_roles();
    foreach ((array) $user->roles as $slug) {
        if (isset($editable[$slug]) && call_user_func($predicate, $editable[$slug]['capabilities'])) {
            return true;
        }
    }
    return false;
}

/** How many administrators this site has. The write phases guard on this. */
function deheled_um_administrator_count() {
    $ids = get_users(array('role' => 'administrator', 'fields' => 'ID', 'number' => 100));
    return count($ids);
}

function deheled_um_rest_users($request) {
    $page     = max(1, (int) $request->get_param('page'));
    $per_page = (int) $request->get_param('per_page');
    $per_page = $per_page > 0 ? min(DEHELED_UM_MAX_PER_PAGE, $per_page) : 50;
    $search   = trim((string) $request->get_param('search'));
    $role     = sanitize_key((string) $request->get_param('role'));

    $args = array(
        'number'  => $per_page,
        'paged'   => $page,
        'orderby' => 'ID',
        'order'   => 'ASC',
        'fields'  => 'all',
    );
    if ($search !== '') {
        // Bounded to the columns worth searching; wildcards on both sides so a
        // partial address matches, which is what the dashboard's search does.
        $args['search']         = '*' . $search . '*';
        $args['search_columns'] = array('user_login', 'user_email', 'user_nicename', 'display_name');
    }
    // Only a role this site actually has — an unknown slug would otherwise be
    // passed through to the query and silently return everything.
    if ($role !== '' && array_key_exists($role, deheled_um_editable_roles())) {
        $args['role'] = $role;
    }
    if ($request->get_param('managed_only')) {
        $args['meta_key']   = DEHELED_UM_MANAGED_META;
        $args['meta_value'] = '1';
    }

    $query = new WP_User_Query($args);
    $users = array();
    foreach ($query->get_results() as $user) {
        $users[] = deheled_um_user_shape($user);
    }

    $total = (int) $query->get_total();
    return rest_ensure_response(array(
        'ok'           => true,
        'users'        => $users,
        'page'         => $page,
        'per_page'     => $per_page,
        'total'        => $total,
        'total_pages'  => $per_page > 0 ? (int) ceil($total / $per_page) : 0,
        'administrators' => deheled_um_administrator_count(),
        'generated_at' => current_time('c'),
    ));
}

/**
 * Does an account exist here?
 *
 * Email first, case-insensitively, then username. Email is the identity the
 * dashboard's roster is keyed on, and WordPress already enforces it as unique;
 * matching on it first means an account created by hand with an unrelated
 * username is still recognised as the same person rather than duplicated.
 *
 * get_user_by('email') is already case-insensitive (the column collation is
 * case-insensitive), so no lowercasing dance is needed or wanted — doing it
 * manually would break addresses that legitimately differ in case elsewhere.
 */
function deheled_um_rest_user_lookup($request) {
    $email = trim((string) $request->get_param('email'));
    $login = trim((string) $request->get_param('login'));

    if ($email === '' && $login === '') {
        return new WP_Error('deheled_um_bad_request', 'Provide an email address or a username.', array('status' => 400));
    }

    $user = false;
    $matched = null;

    if ($email !== '' && is_email($email)) {
        $user = get_user_by('email', $email);
        if ($user) $matched = 'email';
    }
    if (!$user && $login !== '') {
        $user = get_user_by('login', $login);
        if ($user) $matched = 'login';
    }

    return rest_ensure_response(array(
        'ok'      => true,
        'exists'  => (bool) $user,
        'matched' => $matched,          // 'email' | 'login' | null
        'user'    => $user ? deheled_um_user_shape($user) : null,
        'queried' => array('email' => $email, 'login' => $login),
    ));
}
