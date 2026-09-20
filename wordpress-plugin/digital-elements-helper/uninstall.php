<?php
/**
 * Runs when the plugin is deleted from the Plugins screen.
 *
 * We remove cached/derived data but deliberately KEEP the license key,
 * PageSpeed API key, and llms.txt content (deheled_llms_content /
 * deheled_llms_enabled): agencies routinely delete-and-reinstall this plugin
 * (e.g. replacing an old copy), and wiping the license here would silently
 * disconnect monitoring. Regenerating the key from the dashboard is the
 * correct way to revoke access.
 */
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

delete_transient('deheled_status_cache');
delete_site_transient('deheled_update_manifest');
delete_option('deheled_security_result');
delete_option('deheled_license_status');
delete_option('deheled_images_result');   // cached image audit — derived data
wp_clear_scheduled_hook('deheled_security_scan_event');

/**
 * User-management credential and its bookkeeping.
 *
 * Unlike the license key, this IS removed. The license key is kept because a
 * delete-and-reinstall would otherwise silently disconnect monitoring, which is
 * read-only. This credential can create and change WordPress users, so leaving
 * a live secret behind on a site that deliberately removed the plugin is the
 * wrong default — re-enrolling takes one code and is the safer thing to require.
 */
delete_option('deheled_um_key_id');
delete_option('deheled_um_secret');
delete_option('deheled_um_scopes');
delete_option('deheled_um_enrolled_at');

/**
 * Our markers on WordPress users.
 *
 * These are removed so a site that deletes this plugin is left with ordinary,
 * unmarked accounts — but the ACCOUNTS themselves are untouched. Uninstalling
 * a plugin must never delete a site's users, and nothing here does.
 */
delete_metadata('user', 0, '_de_managed', '', true);
delete_metadata('user', 0, '_de_managed_at', '', true);
delete_metadata('user', 0, '_de_linked', '', true);
delete_metadata('user', 0, '_de_created', '', true);

// Replay-protection nonces and idempotency records are short-lived derived
// data; sweep whatever is still lying around.
global $wpdb;
$wpdb->query(
    $wpdb->prepare(
        "DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
        $wpdb->esc_like('deheled_um_n_') . '%',
        $wpdb->esc_like('deheled_um_i_') . '%'
    )
);
