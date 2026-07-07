<?php
if (!defined('ABSPATH')) { exit; }

add_action('rest_api_init', function () {
    register_rest_route('wpmonitor/v1', '/status', array(
        'methods'             => 'GET',
        'permission_callback' => 'deheled_check_token',
        'callback'            => 'deheled_rest_status',
    ));
    register_rest_route('wpmonitor/v1', '/security', array(
        'methods'             => 'GET',
        'permission_callback' => 'deheled_check_token',
        'callback'            => 'deheled_rest_security',
    ));
});

// Returns the last cached deep-scan result. The heavy scan runs on a daily
// WP-cron job (below); the first-ever call runs it inline once. ?fresh=1 forces
// a rescan (used by the admin "Run scan now" button).
function deheled_rest_security($request) {
    $fresh  = $request ? $request->get_param('fresh') : null;
    $result = get_option(DEHELED_SEC_OPTION, null);
    if ($fresh || !is_array($result)) {
        $result = deheled_security_scan();
    }
    return rest_ensure_response($result);
}



function deheled_rest_status() {
    $u = deheled_get_updates();
    return rest_ensure_response(array(
        'generated_at'          => current_time('c'),
        'wp_version'            => get_bloginfo('version'),
        'php_version'           => PHP_VERSION,
        'core_update_available' => $u['core_update_available'],
        'core_new_version'      => $u['core_new_version'],
        'plugin_updates'        => $u['plugin_updates'],
        'theme_updates'         => $u['theme_updates'],
    ));
}
