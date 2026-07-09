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
wp_clear_scheduled_hook('deheled_security_scan_event');
