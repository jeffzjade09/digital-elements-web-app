<?php
/**
 * The de/v2 user-management namespace.
 *
 * A new versioned namespace rather than more routes under wpmonitor/v1: the
 * contract needs to stay stable for the dashboard and, later, for Nexus, and
 * these routes have a completely different auth model from the monitoring ones
 * (see um-auth.php). Keeping them apart means the monitoring endpoints are
 * unaffected by anything here.
 *
 * This file registers the capabilities probe. The user routes arrive with the
 * phases that implement them; each declares the scope it requires.
 */

if (!defined('ABSPATH')) { exit; }

define('DEHELED_UM_NAMESPACE', 'de/v2');

add_action('rest_api_init', function () {
    register_rest_route(DEHELED_UM_NAMESPACE, '/capabilities', array(
        'methods'             => 'GET',
        'permission_callback' => 'deheled_um_capabilities_permission',
        'callback'            => 'deheled_um_rest_capabilities',
    ));
});

/**
 * The capabilities probe is the one route that also accepts the monitoring
 * license key.
 *
 * It has to be answerable BEFORE the site is enrolled — otherwise the dashboard
 * cannot tell "this site needs a plugin update" apart from "this site needs
 * enrolling", and every bulk operation would fail opaquely on both. It returns
 * only version and feature information, nothing about any user, so the weaker
 * credential is proportionate to what it discloses.
 */
function deheled_um_capabilities_permission($request) {
    if ($request->get_header('x-de-signature')) {
        return deheled_um_verify_request($request, null);
    }
    return deheled_check_token($request);
}

function deheled_um_rest_capabilities($request) {
    $enrolled = deheled_um_is_enrolled();

    return rest_ensure_response(array(
        'ok'             => true,
        'plugin_version' => DEHELED_VERSION,
        'api_version'    => DEHELED_UM_API_VERSION,
        'namespace'      => DEHELED_UM_NAMESPACE,
        // What this build can do. The dashboard gates on these rather than on
        // the version string, so a capability can ship without every screen
        // needing to know which release introduced it.
        'capabilities'   => deheled_um_capability_list(),
        'enrolled'       => $enrolled,
        // Reported so the dashboard shows the site's real, locally-configured
        // permissions rather than what it thinks it granted.
        'scopes'         => $enrolled ? array_values(deheled_um_scopes()) : array(),
        // Which website in the dashboard this site's license key belongs to.
        // The commonest enrollment failure by far is a plugin carrying another
        // site's key — usually because the install was cloned from a staging
        // copy — and the refusal the dashboard can safely return says nothing
        // about why. Reporting it here lets the dashboard warn BEFORE a code is
        // issued. It is the site's own name, already shown in its own admin
        // panel, so it discloses nothing new to whoever holds the license key.
        'license_site'   => deheled_um_license_site_name(),
        'multisite'      => is_multisite(),
        'wp_version'     => get_bloginfo('version'),
        'php_version'    => PHP_VERSION,
        'roles'          => count(wp_roles()->get_names()),
        'generated_at'   => current_time('c'),
    ));
}

/**
 * The dashboard website this site's license key is registered to, as the
 * dashboard itself reported at the last license check. Empty when the key is
 * unset or has never validated.
 */
function deheled_um_license_site_name() {
    $status = get_option(DEHELED_LIC_STATUS, array());
    if (!is_array($status) || empty($status['site'])) return '';
    return (string) $status['site'];
}

/**
 * Capabilities this build implements. Entries are added as each phase lands, so
 * a site part-way through a rollout advertises exactly what it can do.
 */
function deheled_um_capability_list() {
    $caps = array();
    if (function_exists('deheled_um_rest_roles'))          $caps[] = 'users.read';
    if (function_exists('deheled_um_rest_create_user'))    $caps[] = 'users.write';
    if (function_exists('deheled_um_rest_delete_user'))    $caps[] = 'users.delete';
    if (function_exists('deheled_um_rest_reassign'))       $caps[] = 'content.reassign';
    if (function_exists('deheled_um_rest_content'))        $caps[] = 'content.read';
    return $caps;
}
