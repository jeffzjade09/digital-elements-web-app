<?php
if (!defined('ABSPATH')) { exit; }


function deheled_menu_icon() {
    // Company mark, served by the Digital Elements dashboard. Falls back to a
    // monochrome shield if a custom hub URL without a logo is ever used.
    if (defined('DEHELED_HUB_URL') && DEHELED_HUB_URL) {
        return rtrim(DEHELED_HUB_URL, '/') . '/logo.png';
    }
    $svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M10 1l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V4l7-3zm-1 11.4l4.7-4.7-1.1-1.1L9 10.2 7.4 8.6 6.3 9.7 9 12.4z"/></svg>';
    return 'data:image/svg+xml;base64,' . base64_encode($svg);
}

add_action('admin_menu', function () {
    add_menu_page(
        'DE Monitoring',
        'DE Monitoring',
        'manage_options',
        'deheled-monitor',
        'deheled_render_panel',
        deheled_menu_icon(),
        58
    );
});

// Size the logo correctly in the admin sidebar.
add_action('admin_head', function () {
    echo '<style>#toplevel_page_deheled-monitor .wp-menu-image img{width:18px;height:18px;object-fit:contain;padding:7px 0 0;}</style>';
});

// Verify the license key against the Digital Elements dashboard. Stores the
// result (valid/expired/site/expiry) so the panel can show real status.

// Load the panel's stylesheet/script only on our page, passing server data
// (nonce, cached results, last scan) via a localized object instead of inline JS.
add_action('admin_enqueue_scripts', function ($hook) {
    $is_main = $hook === 'toplevel_page_deheled-monitor';
    $is_llms = strpos((string) $hook, 'deheled-llms') !== false;
    if (!$is_main && !$is_llms) return;
    wp_enqueue_style('deheled-admin', DEHELED_PLUGIN_URL . 'assets/admin.css', array(), DEHELED_VERSION);
    if (!$is_main) return; // the panel script expects elements that only exist on the main page
    wp_enqueue_script('deheled-admin', DEHELED_PLUGIN_URL . 'assets/admin.js', array(), DEHELED_VERSION, true);
    $cached = get_transient(DEHELED_CACHE_KEY);
    $sec    = get_option(DEHELED_SEC_OPTION, null);
    wp_localize_script('deheled-admin', 'DEHELED_DATA', array(
        'nonce'  => wp_create_nonce('deheled_run'),
        'cached' => is_array($cached) ? $cached : null,
        'sec'    => is_array($sec) ? $sec : null,
    ));
});

// Save the monitoring license key from the client (nonce-protected).
add_action('admin_post_deheled_save_license', function () {
    if (!current_user_can('manage_options')) wp_die('Forbidden');
    check_admin_referer('deheled_save_license');
    $key = isset($_POST['license_key']) ? sanitize_text_field(wp_unslash($_POST['license_key'])) : '';
    update_option(DEHELED_LICENSE_OPTION, $key);
    deheled_validate_license($key);
    wp_safe_redirect(add_query_arg('saved', '1', admin_url('admin.php?page=deheled-monitor')));
    exit;
});

// Save PageSpeed API key (nonce-protected).
add_action('admin_post_deheled_save_key', function () {
    if (!current_user_can('manage_options')) wp_die('Forbidden');
    check_admin_referer('deheled_save_key');
    $key = isset($_POST['psi_key']) ? sanitize_text_field(wp_unslash($_POST['psi_key'])) : '';
    update_option(DEHELED_PSI_OPTION, $key);
    wp_safe_redirect(add_query_arg('saved', '1', admin_url('admin.php?page=deheled-monitor')));
    exit;
});

// AJAX: run all checks now.
add_action('wp_ajax_deheled_run', function () {
    if (!current_user_can('manage_options')) wp_send_json_error('Forbidden', 403);
    check_ajax_referer('deheled_run');
    wp_send_json_success(deheled_run_all_checks());
});

// AJAX: run the deep security scan now.
add_action('wp_ajax_deheled_scan', function () {
    if (!current_user_can('manage_options')) wp_send_json_error('Forbidden', 403);
    check_ajax_referer('deheled_run');
    wp_send_json_success(deheled_security_scan());
});

// AJAX: fetch this site's monitoring history from the dashboard (proxied
// server-side so the license key never reaches the browser).
add_action('wp_ajax_deheled_history', function () {
    if (!current_user_can('manage_options')) wp_send_json_error('Forbidden', 403);
    check_ajax_referer('deheled_run');
    $key = get_option(DEHELED_LICENSE_OPTION, '');
    if (!$key) wp_send_json_error('No license key saved', 400);
    $days = isset($_POST['days']) ? max(1, min(90, intval($_POST['days']))) : 30;
    $res = wp_remote_get(
        DEHELED_HUB_URL . '/api/plugin/history?key=' . rawurlencode($key) . '&days=' . $days,
        array('timeout' => 10)
    );
    if (is_wp_error($res)) wp_send_json_error('Could not reach the dashboard', 502);
    $code = wp_remote_retrieve_response_code($res);
    $body = json_decode(wp_remote_retrieve_body($res), true);
    if ($code !== 200 || empty($body['ok'])) {
        wp_send_json_error(isset($body['error']) ? $body['error'] : 'History unavailable', 502);
    }
    wp_send_json_success($body);
});

function deheled_render_panel() {
    $cached  = get_transient(DEHELED_CACHE_KEY);
    $nonce   = wp_create_nonce('deheled_run');
    $key_set = (defined('WPMONITOR_PSI_KEY') && WPMONITOR_PSI_KEY) || get_option(DEHELED_PSI_OPTION, '');
    ?>
    <div class="wrap deheled">
      <h1 class="deheled-title">
        <img class="deheled-logo" src="<?php echo esc_url(rtrim(DEHELED_HUB_URL, '/') . '/logo.png'); ?>" alt="Digital Elements" onerror="this.style.display='none'" />
        <span>DE Monitoring</span>
        <button class="button button-primary" id="deheled-run">Run checks now</button>
      </h1>
      <p class="deheled-sub">Digital Elements Group &middot; Helper v<?php echo esc_html(DEHELED_VERSION); ?> &middot; Health of <strong><?php echo esc_html(home_url()); ?></strong>.
        <span id="deheled-checked"><?php echo $cached ? 'Last checked ' . esc_html(date_i18n('M j, Y g:i a', strtotime($cached['checked_at']))) : 'No checks run yet.'; ?></span>
      </p>

      <div id="deheled-grid" class="deheled-grid"></div>

      <?php $sec = get_option(DEHELED_SEC_OPTION, null); ?>
      <div class="deheled-security" id="deheled-sec-wrap">
        <h2 style="display:flex;align-items:center;gap:14px;">Security scan
          <button class="button" id="deheled-scan">Run scan now</button>
          <span id="deheled-sec-when" class="description" style="font-weight:400;">
            <?php echo (is_array($sec) && !empty($sec['scanned_at'])) ? 'Last scan ' . esc_html(date_i18n('M j, Y g:i a', strtotime($sec['scanned_at']))) : 'Not scanned yet — runs automatically each day.'; ?>
          </span>
        </h2>
        <p class="description">Read-only server-side scan for injected code, PHP in uploads, modified core files, and new admin accounts. Findings also appear in your Digital Elements dashboard.</p>
        <div id="deheled-sec-body"></div>
      </div>

      <div class="deheled-history" id="deheled-hist-wrap">
        <h2 style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">History &amp; trends
          <span class="deheled-ranges">
            <button class="button deheled-range" data-days="7">7d</button>
            <button class="button deheled-range is-on" data-days="30">30d</button>
            <button class="button deheled-range" data-days="90">90d</button>
          </span>
          <span id="deheled-hist-up" class="deheled-uptime"></span>
        </h2>
        <p class="description">Uptime, PageSpeed, response time and SSL trends recorded by the Digital Elements dashboard.</p>
        <div id="deheled-hist-charts" class="deheled-hcharts"></div>
        <ul id="deheled-hist-events" class="deheled-hevents"></ul>
        <p id="deheled-hist-msg" class="description" style="display:none"></p>
      </div>

      <?php
        $license_key = get_option(DEHELED_LICENSE_OPTION, '');
        $license_set = (bool) $license_key;
        $lic = get_option(DEHELED_LIC_STATUS, null);
        // Re-verify quietly if the last check is older than 12 hours.
        if ($license_set && (!is_array($lic) || (time() - intval($lic['checked_at'] ?? 0)) > 12 * HOUR_IN_SECONDS)) {
            $lic = deheled_validate_license($license_key);
        }
        $lic_valid   = is_array($lic) && !empty($lic['valid']);
        $lic_expired = is_array($lic) && !empty($lic['expired']);
        $lic_checked = is_array($lic) && intval($lic['checked_at'] ?? 0) > 0 && isset($lic['valid']);
        $lic_unreach = is_array($lic) && !empty($lic['unreachable']) && !$lic_checked;
        $box_class = $lic_valid ? 'ok' : ($license_set ? ($lic_checked ? 'bad' : 'warn') : 'warn');
        $title = 'Monitoring license';
        if ($lic_valid) $title .= ' · active ✓';
        elseif ($lic_expired) $title .= ' · expired';
        elseif ($license_set && $lic_checked) $title .= ' · not recognized';
        elseif ($license_set) $title .= ' · saved (not verified)';
        else $title .= ' · not connected';
        $lock = $lic_valid; // lock the field once the dashboard confirms the key
      ?>
      <div class="deheled-license <?php echo esc_attr($box_class); ?>">
        <h2><?php echo esc_html($title); ?></h2>
        <?php if ($lic_valid): ?>
          <p class="deheled-lic-status good">
            &#10003; Verified with the Digital Elements dashboard
            <?php if (!empty($lic['site'])): ?> &middot; linked to <strong><?php echo esc_html($lic['site']); ?></strong><?php endif; ?>
            <?php if (!empty($lic['expires_at'])): ?> &middot; expires <?php echo esc_html(date_i18n('M j, Y', strtotime($lic['expires_at']))); ?><?php if (isset($lic['days_left']) && $lic['days_left'] !== null): ?> (<?php echo intval($lic['days_left']); ?> days left)<?php endif; ?>
            <?php else: ?> &middot; no expiry<?php endif; ?>
          </p>
        <?php elseif ($lic_expired): ?>
          <p class="deheled-lic-status bad">This license has expired<?php if (!empty($lic['expires_at'])): ?> on <?php echo esc_html(date_i18n('M j, Y', strtotime($lic['expires_at']))); ?><?php endif; ?>. Renew it from the Digital Elements dashboard, then save again.</p>
        <?php elseif ($license_set && $lic_checked): ?>
          <p class="deheled-lic-status bad">This key isn't recognized by the dashboard. Check for typos, or regenerate the key in the dashboard and paste the new one.</p>
        <?php elseif ($license_set && $lic_unreach): ?>
          <p class="deheled-lic-status dim">Couldn't reach the dashboard to verify — will retry automatically.</p>
        <?php else: ?>
          <p class="description">Paste the license key from your Digital Elements dashboard. That's all this plugin needs — no <code>wp-config.php</code> changes.</p>
        <?php endif; ?>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
          <?php wp_nonce_field('deheled_save_license'); ?>
          <input type="hidden" name="action" value="deheled_save_license" />
          <input type="text" name="license_key" id="deheled-lic-input" class="regular-text code" placeholder="DEG-XXXXX-XXXXX-XXXXX-XXXXX"
                 value="<?php echo esc_attr($license_key); ?>" <?php echo $lock ? 'readonly' : ''; ?> />
          <?php if ($lock): ?>
            <button type="button" class="button" id="deheled-lic-change">Change</button>
            <button class="button button-primary" id="deheled-lic-save" style="display:none">Save license</button>
          <?php else: ?>
            <button class="button button-primary">Save license</button>
          <?php endif; ?>
        </form>
      </div>

      <details class="deheled-settings">
        <summary>PageSpeed API key <?php echo $key_set ? '· set ✓' : '· not set'; ?></summary>
        <?php if (defined('WPMONITOR_PSI_KEY') && WPMONITOR_PSI_KEY): ?>
          <p>Key is defined in <code>wp-config.php</code>.</p>
        <?php else: ?>
          <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <?php wp_nonce_field('deheled_save_key'); ?>
            <input type="hidden" name="action" value="deheled_save_key" />
            <input type="text" name="psi_key" class="regular-text" placeholder="Google PageSpeed API key"
                   value="<?php echo esc_attr(get_option(DEHELED_PSI_OPTION, '')); ?>" />
            <button class="button">Save key</button>
            <p class="description">Optional. Improves the PageSpeed card and avoids rate limits.</p>
          </form>
        <?php endif; ?>
      </details>
    </div>

    <?php
}
