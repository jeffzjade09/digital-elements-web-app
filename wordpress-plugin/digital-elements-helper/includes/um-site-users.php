<?php
/**
 * "Team Members" — adding Digital Elements colleagues to THIS website.
 *
 * For a member of staff already working in a client's WP Admin who needs a
 * colleague on this site and would otherwise switch to the dashboard to do it.
 *
 * WHAT THIS SCREEN IS NOT. It does not create staff records and it does not
 * create, edit or delete teams — the dashboard stays the single source of
 * truth, and this is a view onto it plus one action. It also never creates a
 * WordPress user: every account is created by the hub, through the same de/v2
 * path it has always used, coming back to this site.
 *
 * WHO CAN SEE IT. Four conditions, ALL required, ALL checked in PHP on every
 * entry point rather than by hiding markup:
 *
 *   1. the license is valid and verified;
 *   2. the site is enrolled with users:write, and Digital Elements permits this
 *      site to add staff (plugin:assign);
 *   3. the logged-in user holds edit_users AND promote_users here;
 *   4. the logged-in user is a Digital-Elements-managed account with an
 *      @digitalelementsgroup.com address.
 *
 * Condition 4 is the one that keeps a client's own Administrator out. They hold
 * every capability on their own site, so capabilities alone would let them in;
 * being a managed agency account is what distinguishes "our staff working here"
 * from "the client".
 */

if (!defined('ABSPATH')) { exit; }

define('DEHELED_SITE_USERS_PAGE', 'deheled-team-members');
const DEHELED_AGENCY_DOMAIN = 'digitalelementsgroup.com';

/**
 * True only for an address on EXACTLY the agency domain.
 *
 * Written out rather than left as a substring comparison, because the rule has
 * four separate ways to be got wrong and each one is a way in:
 *
 *   jeff@digitalelementsgroup.com        yes
 *   JEFF@DigitalElementsGroup.com        yes  - case, and surrounding space
 *   jeff@digitalelementsgroup.com.       yes  - a trailing dot is the same host
 *   jeff@wp.digitalelementsgroup.com     NO   - a subdomain is not the domain
 *   jeff@digitalelementsgroup.co         NO   - look-alike
 *   jeff@digital-elementsgroup.com       NO   - look-alike
 *   jeff@digitalelementsgroup.com.evil   NO   - suffix attack
 *   a@b.com@digitalelementsgroup.com     NO   - two @, resolves ambiguously
 *
 * Split on the LAST "@" and compare the whole domain. Nothing here depends on
 * where a substring happens to land.
 */
function deheled_site_users_is_agency_email($email) {
    $raw = strtolower(trim((string) $email));
    if ($raw === '' || strpos($raw, ' ') !== false) return false;

    $at = strrpos($raw, '@');
    if ($at === false || $at === 0 || $at === strlen($raw) - 1) return false;
    if (strpos(substr($raw, 0, $at), '@') !== false) return false;

    $domain = rtrim(substr($raw, $at + 1), '.');
    return $domain === DEHELED_AGENCY_DOMAIN;
}

/* ============================================================== the gate == */

/**
 * Why this screen is or isn't available, as one of eight distinct states.
 *
 * Returns array('state' => ..., 'message' => ..., 'ok' => bool). Distinct
 * because "your license expired", "nobody has connected this site yet" and "you
 * personally can't use this" need completely different actions, and collapsing
 * them into "unavailable" makes the screen useless to whoever hits it.
 */
function deheled_site_users_gate($roster = null) {
    $unavailable = function ($state, $message) {
        return array('ok' => false, 'state' => $state, 'message' => $message);
    };

    // 1. License.
    $license = (string) get_option(DEHELED_LICENSE_OPTION, '');
    if ($license === '') {
        return $unavailable('license_missing',
            'This website isn\'t connected to Digital Elements yet. Add its monitoring license key under DE Monitoring.');
    }
    $status = get_option(DEHELED_LIC_STATUS, array());
    if (is_array($status) && !empty($status['expired'])) {
        return $unavailable('license_expired',
            'This website\'s Digital Elements license has expired. Renew it, then reload this page.');
    }
    // Only treat it as invalid once the hub has actually answered; an
    // unreachable dashboard is a different state, below.
    if (is_array($status) && isset($status['valid']) && empty($status['valid']) && empty($status['unreachable'])) {
        return $unavailable('license_invalid',
            'This website\'s license key isn\'t recognised by Digital Elements. Check it under DE Monitoring.');
    }

    // 2. Enrollment and what each side permits.
    if (!deheled_um_is_enrolled()) {
        return $unavailable('not_enrolled',
            'User management hasn\'t been set up for this website. Connect it under DE Monitoring → User management.');
    }
    if (!in_array('users:write', deheled_um_scopes(), true)) {
        return $unavailable('write_not_granted',
            'This website hasn\'t allowed Digital Elements to create or update accounts.');
    }

    // 3. WordPress capability. Deliberately both: editing users is not the same
    // as being able to give someone a role.
    if (!current_user_can('edit_users') || !current_user_can('promote_users')) {
        return $unavailable('no_permission',
            'You don\'t have permission to manage users on this website.');
    }

    // 4. An agency address, on exactly the agency domain.
    //
    // NOT the _de_managed flag, which this check used to require. That flag
    // only exists on an account the dashboard created or linked, so every
    // colleague whose account predates this tool — most of them, on most of the
    // forty-odd sites — was refused by name while being on the roster and
    // administering the site. Linking each person on each site by hand was
    // never realistic. The hub now decides instead (5 below), and adopts the
    // account on the way through.
    //
    // A WordPress account's email is set by whoever administers this site, so
    // this is a MISTAKE-GUARD AND A VISIBILITY CONTROL, not a boundary against
    // a malicious site administrator: they could mint an account claiming any
    // address here. What actually bounds the damage is the hub's, unchanged —
    // roster-only assignment, the agency domain, the users:admin scope, the
    // last-administrator guard — plus the hub's team restriction, which caps
    // what a spoofed actor could achieve at what a Web Development or Admin
    // colleague could already do ON THIS ONE SITE.
    $user = wp_get_current_user();
    if (!$user || !$user->ID) {
        return $unavailable('no_permission', 'You don\'t have permission to manage users on this website.');
    }
    if (!deheled_site_users_is_agency_email($user->user_email)) {
        return $unavailable('no_permission',
            'This section is for @' . DEHELED_AGENCY_DOMAIN . ' accounts.');
    }

    // 5. Whether the hub is reachable, and whether IT permits this. Only
    // knowable by asking, so it comes last and only when a roster was supplied.
    if ($roster !== null) {
        if (is_wp_error($roster)) {
            $code = $roster->get_error_code();
            if ($code === 'scope_denied') {
                return $unavailable('plugin_assign_not_granted',
                    'Digital Elements hasn\'t permitted this website to add staff from here. Ask them to enable it for this site.');
            }
            // The hub's verdict on the PERSON, which only it can give: the
            // roster lives there, and so does the team. Each is a different
            // thing to do about it, so each keeps its own state.
            if ($code === 'actor_not_on_roster') {
                return $unavailable('not_on_roster', $roster->get_error_message());
            }
            if ($code === 'actor_team_not_allowed') {
                return $unavailable('team_not_allowed', $roster->get_error_message());
            }
            if ($code === 'actor_inactive') {
                return $unavailable('not_on_roster', $roster->get_error_message());
            }
            if ($code === 'plugin_update_required') {
                return $unavailable('plugin_outdated', $roster->get_error_message());
            }
            if ($code === 'actor_not_agency') {
                return $unavailable('no_permission', $roster->get_error_message());
            }
            return $unavailable('hub_unreachable', $roster->get_error_message());
        }
        if (empty($roster['canAssign'])) {
            return $unavailable('plugin_assign_not_granted',
                'Digital Elements hasn\'t permitted this website to add staff from here. Ask them to enable it for this site.');
        }
        $teams = isset($roster['teams']) && is_array($roster['teams']) ? $roster['teams'] : array();
        $members = 0;
        foreach ($teams as $t) $members += isset($t['members']) ? count($t['members']) : 0;
        if ($members === 0) {
            return $unavailable('roster_empty',
                'There are no team members to add yet. They\'re created in the Digital Elements dashboard.');
        }
    }

    return array('ok' => true, 'state' => 'available', 'message' => '');
}

/** Gate + nonce for every AJAX handler. Refuses rather than rendering. */
function deheled_site_users_require($nonce_action = 'deheled_site_users') {
    check_ajax_referer($nonce_action);
    $gate = deheled_site_users_gate();
    if (empty($gate['ok'])) {
        wp_send_json_error(array('state' => $gate['state'], 'message' => $gate['message']), 403);
    }
    return true;
}

/* ================================================== role-level protection == */

/**
 * Can the person using this screen hand out this role HERE?
 *
 * Defined as capability subset: every capability the target role grants must be
 * one the acting user already holds. WordPress has no ordering of roles, so
 * this is the only definition that means anything.
 *
 * A MISTAKE-GUARD, NOT A SECURITY BOUNDARY. It can only be enforced here,
 * because only this site knows the acting user's capabilities — the hub sees a
 * site credential, not a WordPress session. A compromised site could bypass it,
 * but a compromised site can already call wp_create_user() directly on itself,
 * so nothing is lost. The boundaries that ARE real are the hub's: the role
 * whitelist, the users:admin scope, the agency-domain rule and the
 * last-administrator guard.
 */
function deheled_site_users_can_grant_role($role_slug) {
    $editable = deheled_um_editable_roles();
    $role_slug = sanitize_key($role_slug);
    if (!isset($editable[$role_slug])) return false;

    $user = wp_get_current_user();
    if (!$user || !$user->ID) return false;

    // Compared against the user's ASSIGNED capabilities, not current_user_can().
    // Both sides then come from the same place: what a role declares, and what
    // this user has been given. current_user_can() would instead run each
    // capability through map_meta_cap, which denies some outright regardless of
    // role -- manage_links unless the Links Manager is switched back on, and
    // unfiltered_upload, which stock WordPress grants to nobody. Both are
    // declared by the Editor and Administrator roles, so comparing that way
    // would mean NO ONE could ever grant Editor or Administrator, including a
    // full administrator. (Found by the live check against WordPress 6.3.1 --
    // stubs cannot show it, because the denial lives in map_meta_cap.)
    $mine = isset($user->allcaps) && is_array($user->allcaps) ? $user->allcaps : array();
    $caps = isset($editable[$role_slug]['capabilities']) ? $editable[$role_slug]['capabilities'] : array();
    foreach ($caps as $cap => $granted) {
        if (!$granted) continue;
        if (empty($mine[$cap])) return false;
    }
    return true;
}

/** Roles this user may offer, in the order the site defines them. */
function deheled_site_users_grantable_roles() {
    $out = array();
    foreach (deheled_um_editable_roles() as $slug => $role) {
        if (!deheled_site_users_can_grant_role($slug)) continue;
        $out[$slug] = array(
            'name'       => translate_user_role($role['name']),
            'site_admin' => deheled_um_role_is_site_admin($role['capabilities']),
        );
    }
    return $out;
}

/** A roster member we are allowed to act on. */
function deheled_site_users_member_allowed($member) {
    if (empty($member['email'])) return false;
    $email = strtolower((string) $member['email']);
    // Non-agency addresses are refused outright. Adding one is a deliberate
    // dashboard action with its own confirmation and audit trail; reproducing
    // that inside a client's WP Admin would weaken it.
    return substr($email, -strlen('@' . DEHELED_AGENCY_DOMAIN)) === '@' . DEHELED_AGENCY_DOMAIN;
}

/* ========================================================== the admin page = */

add_action('admin_menu', function () {
    // The submenu is registered for everyone and the CALLBACK enforces the
    // gate, rather than hiding the menu and trusting that. Hiding markup is
    // presentation; the callback is the control.
    add_submenu_page(
        'deheled-monitor',
        'Team Members',
        'Team Members',
        'read',
        DEHELED_SITE_USERS_PAGE,
        'deheled_site_users_render'
    );
}, 20);

add_action('admin_enqueue_scripts', function ($hook) {
    if (strpos((string) $hook, DEHELED_SITE_USERS_PAGE) === false) return;
    wp_enqueue_style('deheled-admin', DEHELED_PLUGIN_URL . 'assets/admin.css', array(), DEHELED_VERSION);
    wp_enqueue_style('deheled-team-members', DEHELED_PLUGIN_URL . 'assets/um-site-users.css', array('deheled-admin'), DEHELED_VERSION);
    wp_enqueue_script('deheled-team-members', DEHELED_PLUGIN_URL . 'assets/um-site-users.js', array(), DEHELED_VERSION, true);
    wp_localize_script('deheled-team-members', 'DEHELED_TM', array(
        'ajaxUrl' => admin_url('admin-ajax.php'),
        'nonce'   => wp_create_nonce('deheled_site_users'),
        // Identifies THIS website in the browser's own storage, so remembering
        // which team cards are collapsed doesn't leak across the forty-odd
        // sites a colleague works on. A display preference and nothing else.
        'siteKey' => md5(home_url()),
        'strings' => array(
            'genericError' => 'Something went wrong. Please try again.',
            'loading'      => 'Loading the roster…',
            'refreshing'   => 'Refreshing the roster…',
            'loaded'       => 'Roster updated.',
            'kept'         => 'Couldn\'t refresh. Showing what was already loaded.',
        ),
    ));
});

function deheled_site_users_render() {
    // The gate runs here too, not only in the handlers: reaching this URL
    // directly must not render the screen.
    $gate = deheled_site_users_gate();
    $roster = null;
    if (!empty($gate['ok'])) {
        $roster = deheled_hub_get_roster(false);
        $gate = deheled_site_users_gate($roster);
    }

    // The header is printed here rather than by the script so that it is also
    // there for the unavailable states below, which never reach the panel.
    // Its right-hand slot is filled in by the script once a roster exists;
    // empty is the correct state for it when one doesn't.
    echo '<div class="wrap deheled deheled-tm">';
    echo '<div class="deheled-tm-header">';
    echo '<div class="deheled-tm-header-text">';
    echo '<h1 class="deheled-tm-h1">Team Members</h1>';
    echo '<p class="deheled-tm-lede">Add Digital Elements colleagues to <strong>' . esc_html(home_url()) . '</strong>. '
       . 'Accounts are created by Digital Elements, not by this plugin.</p>';
    echo '</div>';
    echo '<div class="deheled-tm-header-actions" id="deheled-tm-header-actions"></div>';
    echo '</div>';

    if (empty($gate['ok'])) {
        echo '<div class="deheled-license warn deheled-tm-unavailable">';
        echo '<h2>' . esc_html(deheled_site_users_state_title($gate['state'])) . '</h2>';
        echo '<p class="description">' . esc_html($gate['message']) . '</p>';
        echo '</div></div>';
        return;
    }

    $roles = deheled_site_users_grantable_roles();
    echo '<div id="deheled-tm-root"'
       . ' data-roster="' . esc_attr(wp_json_encode(deheled_site_users_public_roster($roster))) . '"'
       . ' data-roles="' . esc_attr(wp_json_encode($roles)) . '"'
       . ' data-others="' . esc_attr(wp_json_encode(deheled_site_users_other_users())) . '">'
       . '<p class="description">Loading…</p></div>';
    echo '</div>';
}

function deheled_site_users_state_title($state) {
    $titles = array(
        'license_missing'           => 'Not connected to Digital Elements',
        'license_invalid'           => 'License not recognised',
        'license_expired'           => 'License expired',
        'not_enrolled'              => 'User management not set up',
        'write_not_granted'         => 'Not permitted on this website',
        'plugin_assign_not_granted' => 'Not permitted from here',
        'hub_unreachable'           => 'Can\'t reach Digital Elements',
        'roster_empty'              => 'No team members yet',
        'no_permission'             => 'You don\'t have access to this',
        'not_on_roster'             => 'Not on the Digital Elements roster',
        'team_not_allowed'          => 'Not available to your team',
        'plugin_outdated'           => 'This plugin needs updating',
    );
    return isset($titles[$state]) ? $titles[$state] : 'Unavailable';
}

/**
 * The roster as it reaches the page.
 *
 * Re-shaped rather than passed through: the hub already limits what it sends,
 * but what ends up in markup is this plugin's decision. Non-agency members are
 * dropped here as well as at the hub.
 */
/**
 * Whether one roster member actually has an account on THIS site, right now.
 *
 * Looked up in the WordPress user table rather than taken from the dashboard's
 * answer. The dashboard records what it did when it acted; it cannot know that
 * somebody deleted the account in WP Admin afterwards. Two accounts were
 * deleted exactly that way and the panel went on saying "everyone is already
 * here" while the site had one user.
 *
 * The site is the authority on who exists on the site. Matching is by email,
 * case-insensitively, which is what get_user_by('email') already does.
 */
function deheled_site_users_observe($email) {
    $user = is_email($email) ? get_user_by('email', $email) : false;
    if (!$user) {
        return array('present' => false, 'roles' => array(), 'managed' => false, 'wpUserId' => 0,
                     'createdByUs' => false, 'passwordSetAt' => null, 'activationPending' => false);
    }
    return array(
        'present'  => true,
        'roles'    => array_values(array_map('strval', (array) $user->roles)),
        'managed'  => deheled_um_user_is_managed($user->ID),
        'wpUserId' => (int) $user->ID,
        // Whether the invitation we sent was ever acted on. Three facts, the
        // same three the de/v2 user shape reports, and nothing about the
        // password or the activation key itself.
        'createdByUs'       => deheled_um_user_was_created_by_us($user->ID),
        'passwordSetAt'     => deheled_um_password_set_at($user->ID),
        'activationPending' => deheled_um_activation_pending($user),
    );
}

/**
 * What this site can see about every roster member, for the hub to reconcile.
 *
 * Costs nothing to produce — the panel had to look these up to render itself —
 * and it covers every assignment at once, so the hub never has to ask the site
 * person by person just to discover it is out of date. Sent back only when at
 * least one entry disagrees with what the hub just said; see
 * deheled_hub_get_roster().
 */
function deheled_site_users_observed($roster) {
    $out = array();
    if (!is_array($roster)) return $out;
    foreach ((isset($roster['teams']) ? $roster['teams'] : array()) as $team) {
        foreach ((isset($team['members']) ? $team['members'] : array()) as $m) {
            if (empty($m['email'])) continue;
            $seen = deheled_site_users_observe($m['email']);
            $thought = !empty($m['onThisSite']['present']);
            $thought_roles = isset($m['onThisSite']['roles']) ? array_map('strval', (array) $m['onThisSite']['roles']) : array();

            // Whether this one disagrees with what the dashboard believes, so
            // the caller can decide whether the correction is worth a request
            // without working it out a second time.
            $seen['drifted'] = ($seen['present'] !== $thought)
                || ($seen['present'] && $thought_roles && array_slice($seen['roles'], 0, 1) !== array_slice($thought_roles, 0, 1));

            $out[] = array_merge(array('email' => (string) $m['email']), $seen);
        }
    }
    return $out;
}

function deheled_site_users_public_roster($roster) {
    if (!is_array($roster)) return array('teams' => array(), 'siteRoles' => array());

    $teams = array();
    foreach ((isset($roster['teams']) ? $roster['teams'] : array()) as $team) {
        $members = array();
        foreach ((isset($team['members']) ? $team['members'] : array()) as $m) {
            if (!deheled_site_users_member_allowed($m)) continue;
            // GROUND TRUTH, not the dashboard's belief. See above.
            $seen = deheled_site_users_observe($m['email']);
            $members[] = array(
                'id'      => (string) $m['staffUserId'],
                'label'   => (string) $m['label'],
                'email'   => (string) $m['email'],
                'role'    => (string) $m['defaultWpRole'],
                'present' => $seen['present'],
                'roles'   => $seen['roles'],
                'managed' => $seen['managed'],
                // Invitation status for THIS site, computed here rather than
                // taken from the hub: the answer lives in this site's user
                // table, which is the same reason presence is computed here.
                'invite'  => deheled_site_users_invite_view($seen),
                // Kept so the panel can say "the dashboard thought this person
                // was here" rather than silently showing a different list.
                'hubThought' => !empty($m['onThisSite']['present']),
            );
        }
        if (!$members) continue;
        $teams[] = array(
            'id'      => isset($team['id']) ? (string) $team['id'] : '',
            'name'    => (string) $team['name'],
            'role'    => isset($team['defaultWpRole']) ? (string) $team['defaultWpRole'] : '',
            'members' => $members,
        );
    }

    return array(
        'teams'     => $teams,
        'siteRoles' => isset($roster['siteRoles']) ? $roster['siteRoles'] : array(),
    );
}

/**
 * What to say about one member's invitation, and whether Resend is offered.
 *
 * The same five states and the same sentences the dashboard uses, because two
 * screens describing the same account differently is how someone ends up
 * resending an invitation that already worked.
 *
 * `signal` is reported so an ACTIVATED that was inferred from a cleared
 * activation key can be told apart from one our own hook observed. They mean
 * different degrees of certainty and whoever is debugging a specific account
 * needs to know which they are looking at.
 */
function deheled_site_users_invite_view($seen) {
    if (empty($seen['present'])) {
        return array('state' => null, 'label' => '', 'canResend' => false, 'why' => '', 'signal' => null);
    }
    if (empty($seen['createdByUs'])) {
        return array(
            'state' => 'unknown',
            'label' => 'Not invited by us',
            'canResend' => false,
            // Said out loud: an absent button reads as a bug, and this names
            // the thing they can actually do instead.
            'why' => 'This account wasn\'t created by Digital Elements; they can use "Lost your password?" on the site\'s login page.',
            'signal' => null,
        );
    }
    if (!empty($seen['passwordSetAt'])) {
        return array('state' => 'activated', 'label' => 'Active', 'canResend' => false,
                     'why' => '', 'signal' => 'meta');
    }
    if (empty($seen['activationPending'])) {
        return array('state' => 'activated', 'label' => 'Active', 'canResend' => false,
                     'why' => '', 'signal' => 'key_cleared');
    }
    return array(
        'state' => 'pending_setup',
        'label' => 'Waiting for them to set a password',
        'canResend' => true,
        'why' => '',
        'signal' => null,
    );
}

/**
 * This site's own users, for context only (D3).
 *
 * Read-only and actionless. Shown because a colleague who already has an
 * unmanaged account here will otherwise look like "not on site", and the
 * preflight will answer "already exists — link?" at review. Seeing why up front
 * is better than meeting it at the end.
 *
 * Discloses nothing new: the gate already requires edit_users, so whoever is
 * reading this can open WordPress's own Users screen.
 */
function deheled_site_users_other_users() {
    $out = array();
    $users = get_users(array('number' => 100, 'orderby' => 'display_name', 'fields' => 'all'));
    foreach ($users as $u) {
        if (deheled_um_user_is_managed($u->ID)) continue;
        $out[] = array(
            'label' => (string) $u->display_name,
            'email' => (string) $u->user_email,
            'roles' => array_values(array_map('strval', (array) $u->roles)),
        );
    }
    return $out;
}

/* ================================================================ handlers = */

add_action('wp_ajax_deheled_tm_roster', function () {
    deheled_site_users_require();
    if (!empty($_POST['refresh'])) deheled_hub_clear_roster_cache();

    $roster = deheled_hub_get_roster(!empty($_POST['refresh']));
    $gate = deheled_site_users_gate($roster);
    if (empty($gate['ok'])) {
        wp_send_json_error(array(
            'state'   => $gate['state'],
            'title'   => deheled_site_users_state_title($gate['state']),
            'message' => $gate['message'],
        ), 200);
    }
    wp_send_json_success(array(
        'roster' => deheled_site_users_public_roster($roster),
        'roles'  => deheled_site_users_grantable_roles(),
        'others' => deheled_site_users_other_users(),
    ));
});

add_action('wp_ajax_deheled_tm_preflight', function () {
    deheled_site_users_require();
    $ids  = deheled_site_users_posted_ids();
    $role = isset($_POST['role']) ? sanitize_key(wp_unslash($_POST['role'])) : '';

    if (!$ids) wp_send_json_error(array('message' => 'Choose at least one person.'), 200);
    if ($role !== '' && !deheled_site_users_can_grant_role($role)) {
        wp_send_json_error(array('message' => 'You can\'t assign a role with more access than your own.'), 200);
    }

    $result = deheled_hub_preflight($ids, $role);
    if (is_wp_error($result)) {
        wp_send_json_error(array('message' => $result->get_error_message()), 200);
    }
    wp_send_json_success(array('rows' => $result['rows'], 'summary' => $result['summary']));
});

add_action('wp_ajax_deheled_tm_assign', function () {
    deheled_site_users_require();
    $ids  = deheled_site_users_posted_ids();
    $role = isset($_POST['role']) ? sanitize_key(wp_unslash($_POST['role'])) : '';
    // Generated by the browser once per submission and sent back unchanged on
    // Retry, which is what makes a retry safe: the hub returns the same job
    // rather than assigning everyone a second time.
    $request_id = isset($_POST['requestId']) ? preg_replace('/[^a-zA-Z0-9\-]/', '', wp_unslash($_POST['requestId'])) : '';
    $confirm_admin = !empty($_POST['confirmAdmin']);

    if (!$ids) wp_send_json_error(array('message' => 'Choose at least one person.'), 200);
    if ($request_id === '') wp_send_json_error(array('message' => 'Missing request id.'), 200);
    if ($role !== '' && !deheled_site_users_can_grant_role($role)) {
        wp_send_json_error(array('message' => 'You can\'t assign a role with more access than your own.'), 200);
    }

    $result = deheled_hub_assign($ids, $role, $request_id, $confirm_admin);
    if (is_wp_error($result)) {
        wp_send_json_error(array('message' => $result->get_error_message()), 200);
    }
    wp_send_json_success(array('jobId' => $result['jobId'], 'replayed' => !empty($result['replayed'])));
});

/**
 * Resend the set-password email to one colleague, for this site.
 *
 * Gated exactly as the rest of the panel is — deheled_site_users_require()
 * checks the nonce and then all five conditions — and the work itself is done
 * by the dashboard, which calls this site's own password-reset route. So the
 * link is generated and mailed by WordPress, here, and nothing about it passes
 * through this handler.
 */
add_action('wp_ajax_deheled_tm_resend', function () {
    deheled_site_users_require();
    $staff_id = isset($_POST['staffId']) ? sanitize_text_field(wp_unslash($_POST['staffId'])) : '';
    if ($staff_id === '') wp_send_json_error(array('message' => 'Choose someone to resend to.'), 200);

    $result = deheled_hub_resend_invite($staff_id);
    if (is_wp_error($result)) {
        wp_send_json_error(array('message' => $result->get_error_message()), 200);
    }

    // The roster carries invitation state, so it has to be re-read for the
    // panel to show the new one.
    deheled_hub_clear_roster_cache();
    wp_send_json_success(array(
        'delivered' => !empty($result['delivered']),
        'state'     => isset($result['state']) ? $result['state'] : '',
        'message'   => !empty($result['delivered'])
            ? 'A new set-password email has been sent. Any earlier link has stopped working.'
            : 'This website couldn\'t confirm the email was sent. They can use "Lost your password?" on the login page.',
    ));
});

add_action('wp_ajax_deheled_tm_job', function () {
    deheled_site_users_require();
    $job = deheled_hub_job(isset($_POST['jobId']) ? wp_unslash($_POST['jobId']) : '');
    if (is_wp_error($job)) {
        wp_send_json_error(array('message' => $job->get_error_message()), 200);
    }
    wp_send_json_success(array('job' => $job['job']));
});

/** Staff ids from the request, sanitised and bounded. */
function deheled_site_users_posted_ids() {
    $raw = isset($_POST['ids']) ? wp_unslash($_POST['ids']) : array();
    if (!is_array($raw)) return array();
    $ids = array();
    foreach ($raw as $id) {
        $id = preg_replace('/[^a-zA-Z0-9\-]/', '', (string) $id);
        if ($id !== '') $ids[$id] = true;
    }
    return array_slice(array_keys($ids), 0, 100);
}
