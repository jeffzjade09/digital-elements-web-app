<?php
if (!defined('ABSPATH')) { exit; }

/* =========================================================================
 * Self-updates from the Digital Elements dashboard.
 *
 * The dashboard exposes /api/plugin/manifest (version metadata) and
 * /api/plugin/download (the plugin zip). We feed those into WordPress's
 * normal update pipeline, so new versions appear on the Plugins screen with
 * a one-click "Update" — no manual reinstall.
 * ========================================================================= */

// Fetch (and cache for 6h) the update manifest from the dashboard.
function deheled_update_manifest($force = false) {
    $cached = get_site_transient('deheled_update_manifest');
    if (!$force && is_array($cached)) return $cached;
    $res = wp_remote_get(DEHELED_HUB_URL . '/api/plugin/manifest', array('timeout' => 8));
    if (is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200) {
        return is_array($cached) ? $cached : null;
    }
    $m = json_decode(wp_remote_retrieve_body($res), true);
    if (!is_array($m) || empty($m['version']) || empty($m['download_url'])) return null;
    set_site_transient('deheled_update_manifest', $m, 6 * HOUR_IN_SECONDS);
    return $m;
}

// Tell WordPress when the dashboard has a newer version.
add_filter('pre_set_site_transient_update_plugins', function ($transient) {
    if (empty($transient) || !is_object($transient)) return $transient;
    $m = deheled_update_manifest();
    if (!$m) return $transient;
    $item = (object) array(
        'id'           => 'deheled/digital-elements-helper',
        'slug'         => 'digital-elements-helper',
        'plugin'       => DEHELED_BASENAME,
        'new_version'  => $m['version'],
        'url'          => isset($m['homepage']) ? $m['homepage'] : DEHELED_HUB_URL,
        'package'      => $m['download_url'],
        'tested'       => isset($m['tested']) ? $m['tested'] : '',
        'requires'     => isset($m['requires']) ? $m['requires'] : '5.8',
        'requires_php' => isset($m['requires_php']) ? $m['requires_php'] : '7.4',
    );
    if (version_compare($m['version'], DEHELED_VERSION, '>')) {
        $transient->response[DEHELED_BASENAME] = $item;
        unset($transient->no_update[DEHELED_BASENAME]);
    } else {
        $transient->no_update[DEHELED_BASENAME] = $item;
        unset($transient->response[DEHELED_BASENAME]);
    }
    return $transient;
});

// Populate the "View details" modal on the Plugins screen.
add_filter('plugins_api', function ($result, $action, $args) {
    if ($action !== 'plugin_information' || empty($args->slug) || $args->slug !== 'digital-elements-helper') {
        return $result;
    }
    $m = deheled_update_manifest();
    if (!$m) return $result;
    return (object) array(
        'name'          => 'Digital Elements Helper Plugin',
        'slug'          => 'digital-elements-helper',
        'version'       => $m['version'],
        'author'        => '<a href="https://digitalelementsgroup.com/">Digital Elements Group</a>',
        'homepage'      => isset($m['homepage']) ? $m['homepage'] : DEHELED_HUB_URL,
        'requires'      => isset($m['requires']) ? $m['requires'] : '5.8',
        'tested'        => isset($m['tested']) ? $m['tested'] : '',
        'requires_php'  => isset($m['requires_php']) ? $m['requires_php'] : '7.4',
        'last_updated'  => isset($m['last_updated']) ? $m['last_updated'] : '',
        'download_link' => $m['download_url'],
        'sections'      => array(
            'description' => isset($m['description']) ? $m['description'] : 'Connects this site to the Digital Elements monitoring dashboard.',
            'changelog'   => isset($m['changelog']) ? $m['changelog'] : '',
        ),
    );
}, 10, 3);

// After any plugin update completes, drop the cached manifest so the Plugins
// screen reflects the new state immediately.
add_action('upgrader_process_complete', function () {
    delete_site_transient('deheled_update_manifest');
});
