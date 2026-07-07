<?php
/**
 * Plugin Name: Digital Elements Helper Plugin
 * Description: Connects this site to the Digital Elements monitoring dashboard. Adds a DE Monitoring admin panel showing HTTPS, SSL, Cloudflare, CTM, Google Tag, PageSpeed, update status, security scan and history, plus a secure, read-only endpoint the central dashboard reads. It cannot modify the site, access content, or run updates.
 * Version:     2.0.1
 * Author:      Digital Elements Group
 * Author URI:  https://digitalelementsgroup.com/
 * Plugin URI:  https://digitalelementsgroup.com/
 * Update URI:  deheled/digital-elements-helper
 * License:     Proprietary
 * Requires at least: 5.8
 * Requires PHP: 7.4
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SETUP
 * 1) In the Digital Elements dashboard, add this website. A unique license key
 *    is generated for it automatically.
 * 2) Install & activate this plugin, then go to WP Admin → DE Monitoring and
 *    paste the license key into the "Monitoring license" field. That's it —
 *    no wp-config.php changes are needed.
 *
 * The license key is the shared secret the dashboard uses to read this site's
 * update status and security scan. Regenerating the key in the dashboard
 * immediately revokes the old one.
 *
 * UPDATES
 * The plugin checks the Digital Elements dashboard for new versions and
 * updates through the normal WordPress Plugins screen — no manual reinstall.
 * ──────────────────────────────────────────────────────────────────────────
 */

if (!defined('ABSPATH')) {
    exit;
}

define('DEHELED_VERSION', '2.0.1');
define('DEHELED_PLUGIN_FILE', __FILE__);
define('DEHELED_BASENAME', plugin_basename(__FILE__));
define('DEHELED_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('DEHELED_PLUGIN_URL', plugin_dir_url(__FILE__));

define('DEHELED_CACHE_KEY', 'deheled_status_cache');
define('DEHELED_PSI_OPTION', 'deheled_psi_key');
define('DEHELED_LICENSE_OPTION', 'deheled_license_key');
define('DEHELED_SEC_OPTION', 'deheled_security_result');
define('DEHELED_SEC_CRON', 'deheled_security_scan_event');
define('DEHELED_LIC_STATUS', 'deheled_license_status');

// Central dashboard used to verify the license, fetch history, and check for
// plugin updates. Override by defining DEHELED_HUB_URL in wp-config.php if
// the dashboard ever moves.
if (!defined('DEHELED_HUB_URL')) {
    define('DEHELED_HUB_URL', 'https://digital-elements-web-app-production.up.railway.app');
}

require_once DEHELED_PLUGIN_DIR . 'includes/auth.php';
require_once DEHELED_PLUGIN_DIR . 'includes/checks.php';
require_once DEHELED_PLUGIN_DIR . 'includes/security-scan.php';
require_once DEHELED_PLUGIN_DIR . 'includes/rest.php';
require_once DEHELED_PLUGIN_DIR . 'includes/license.php';
require_once DEHELED_PLUGIN_DIR . 'includes/updater.php';
require_once DEHELED_PLUGIN_DIR . 'includes/admin.php';

// Clean up the daily security-scan cron when the plugin is deactivated.
register_deactivation_hook(__FILE__, function () {
    wp_clear_scheduled_hook(DEHELED_SEC_CRON);
});
