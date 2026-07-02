<?php
/**
 * Plugin Name: Digital Elements Helper Plugin
 * Description: Connects this site to the Digital Elements Site Monitor. Adds an admin panel showing HTTPS, SSL, Cloudflare, CTM, Google Tag, PageSpeed, and update status, plus a secure, read-only endpoint the central dashboard reads. It cannot modify the site, access content, or run updates.
 * Version:     1.2
 * Author:      Digital Elements Group
 * Author URI:  https://digitalelementsgroup.com/
 * Plugin URI:  https://digitalelementsgroup.com/
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SETUP (client-friendly)
 *
 * 1) In the Digital Elements dashboard, add this website. A unique license key
 *    is generated for it (format DEG-XXXXX-XXXXX-XXXXX-XXXXX).
 * 2) Install & activate this plugin, then go to WP Admin → Site Monitor and
 *    paste the license key into the "Monitoring license" field. That's it —
 *    no wp-config.php editing required.
 *
 * The license key is the shared secret the dashboard uses to read this site's
 * status. Its expiry is managed from the dashboard; a defined WPMONITOR_TOKEN /
 * WPMONITOR_TOKEN_HASH in wp-config.php still works for older installs.
 *
 * PageSpeed API key (optional): paste it on the admin panel, or define
 * WPMONITOR_PSI_KEY in wp-config.php.
 * ──────────────────────────────────────────────────────────────────────────
 */

if (!defined('ABSPATH')) {
    exit;
}

define('DEHELED_VERSION', '1.2');
define('DEHELED_CACHE_KEY', 'deheled_status_cache');
define('DEHELED_PSI_OPTION', 'deheled_psi_key');
define('DEHELED_LICENSE_OPTION', 'deheled_license_key');

/* =========================================================================
 * 1. REST endpoint for the central dashboard (kept lean: updates only)
 * ========================================================================= */

add_action('rest_api_init', function () {
    register_rest_route('wpmonitor/v1', '/status', array(
        'methods'             => 'GET',
        'permission_callback' => 'deheled_check_token',
        'callback'            => 'deheled_rest_status',
    ));
});

function deheled_validate_token($provided) {
    if (!is_string($provided) || $provided === '') {
        return false;
    }
    // Preferred: the license key entered in Site Monitor settings (no wp-config needed).
    $license = get_option(DEHELED_LICENSE_OPTION, '');
    if (is_string($license) && $license !== '' && hash_equals((string) $license, $provided)) {
        return true;
    }
    // Backward compatible: token/hash defined in wp-config.php.
    if (defined('WPMONITOR_TOKEN_HASH') && WPMONITOR_TOKEN_HASH !== '') {
        return hash_equals(strtolower((string) WPMONITOR_TOKEN_HASH), hash('sha256', $provided));
    }
    if (defined('WPMONITOR_TOKEN') && WPMONITOR_TOKEN !== '') {
        return hash_equals((string) WPMONITOR_TOKEN, $provided);
    }
    return false; // fail closed
}

function deheled_check_token($request) {
    $provided = '';
    $auth = $request->get_header('authorization');
    if ($auth && stripos($auth, 'Bearer ') === 0) {
        $provided = trim(substr($auth, 7));
    }
    if ($provided === '') {
        $provided = (string) $request->get_header('x-wpmonitor-token');
    }
    if (deheled_validate_token($provided)) {
        return true;
    }
    return new WP_Error('deheled_forbidden', 'Forbidden', array('status' => 403));
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

/* =========================================================================
 * 2. The seven checks (run in PHP, on this site)
 * ========================================================================= */

function deheled_get_updates() {
    require_once ABSPATH . 'wp-admin/includes/update.php';
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    require_once ABSPATH . 'wp-admin/includes/theme.php';
    wp_update_plugins();
    wp_update_themes();
    wp_version_check();

    $plugin_updates = array();
    if (function_exists('get_plugin_updates')) {
        foreach (get_plugin_updates() as $file => $data) {
            $plugin_updates[] = array(
                'name'        => isset($data->Name) ? $data->Name : $file,
                'current'     => isset($data->Version) ? $data->Version : null,
                'new_version' => isset($data->update->new_version) ? $data->update->new_version : null,
            );
        }
    }
    $theme_updates = array();
    if (function_exists('get_theme_updates')) {
        foreach (get_theme_updates() as $stylesheet => $theme) {
            $theme_updates[] = array(
                'name'        => $theme->get('Name'),
                'current'     => $theme->get('Version'),
                'new_version' => isset($theme->update['new_version']) ? $theme->update['new_version'] : null,
            );
        }
    }
    $core_update_available = false;
    $core_new_version = null;
    if (function_exists('get_preferred_from_update_core')) {
        $core = get_preferred_from_update_core();
        if (is_object($core) && isset($core->response) && $core->response === 'upgrade') {
            $core_update_available = true;
            $core_new_version = isset($core->current) ? $core->current : null;
        }
    }
    return compact('plugin_updates', 'theme_updates', 'core_update_available', 'core_new_version');
}

// Fetches the homepage once; HTTPS, Cloudflare, CTM and Google Tag derive from it.
function deheled_fetch_home() {
    $start = microtime(true);
    $resp = wp_remote_get(home_url('/'), array(
        'timeout'     => 20,
        'redirection' => 5,
        'sslverify'   => true,
        'user-agent'  => 'DigitalElementsHelper/' . DEHELED_VERSION,
    ));
    $ms = (int) round((microtime(true) - $start) * 1000);
    if (is_wp_error($resp)) {
        return array('error' => $resp->get_error_message(), 'ms' => $ms);
    }
    return array(
        'code'    => wp_remote_retrieve_response_code($resp),
        'headers' => wp_remote_retrieve_headers($resp),
        'body'    => wp_remote_retrieve_body($resp),
        'ms'      => $ms,
    );
}

function deheled_check_https($home) {
    if (isset($home['error'])) {
        return array('status' => 'fail', 'label' => 'Unreachable', 'detail' => $home['error']);
    }
    $code = (int) $home['code'];
    $is_https = (stripos(home_url(), 'https://') === 0);
    if ($code >= 500) return array('status' => 'fail', 'label' => "HTTP $code", 'detail' => 'Server error');
    if ($code >= 400) return array('status' => 'fail', 'label' => "HTTP $code", 'detail' => 'Client error');
    if (!$is_https)   return array('status' => 'fail', 'label' => 'Not secure', 'detail' => 'Site URL is not HTTPS');
    return array('status' => 'ok', 'label' => "$code · {$home['ms']}ms", 'detail' => 'Reachable over HTTPS');
}

function deheled_check_ssl() {
    if (!function_exists('openssl_x509_parse')) {
        return array('status' => 'skip', 'label' => 'No OpenSSL', 'detail' => 'OpenSSL not available on this server');
    }
    $host = parse_url(home_url(), PHP_URL_HOST);
    if (!$host) return array('status' => 'warn', 'label' => 'Bad URL', 'detail' => 'Could not parse host');

    $ctx = stream_context_create(array('ssl' => array(
        'capture_peer_cert' => true, 'verify_peer' => false, 'verify_peer_name' => false,
    )));
    $client = @stream_socket_client("ssl://{$host}:443", $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $ctx);
    if (!$client) {
        return array('status' => 'fail', 'label' => 'TLS error', 'detail' => $errstr ?: 'Could not connect');
    }
    $params = stream_context_get_params($client);
    fclose($client);
    if (empty($params['options']['ssl']['peer_certificate'])) {
        return array('status' => 'warn', 'label' => 'No cert', 'detail' => 'No certificate returned');
    }
    $cert = openssl_x509_parse($params['options']['ssl']['peer_certificate']);
    $valid_to = isset($cert['validTo_time_t']) ? (int) $cert['validTo_time_t'] : 0;
    $days = (int) floor(($valid_to - time()) / 86400);
    $issuer = isset($cert['issuer']['O']) ? $cert['issuer']['O'] : 'Unknown CA';
    $detail = 'Expires ' . gmdate('Y-m-d', $valid_to) . ' · ' . $issuer;
    if ($days < 0)  return array('status' => 'fail', 'label' => 'Expired', 'detail' => $detail);
    if ($days < 14) return array('status' => 'warn', 'label' => "{$days}d left", 'detail' => $detail);
    return array('status' => 'ok', 'label' => "{$days}d left", 'detail' => $detail);
}

function deheled_check_cloudflare($home) {
    if (isset($home['error'])) return array('status' => 'warn', 'label' => 'Unknown', 'detail' => 'Site unreachable');
    $headers = $home['headers'];
    $server  = strtolower((string) (is_object($headers) && isset($headers['server']) ? $headers['server'] : ''));
    $cf_ray  = (is_object($headers) && isset($headers['cf-ray'])) ? $headers['cf-ray'] : '';
    if ($cf_ray || strpos($server, 'cloudflare') !== false) {
        $detail = $cf_ray ? ('ray ' . explode('-', $cf_ray)[0]) : 'Cloudflare headers present';
        return array('status' => 'ok', 'label' => 'Active', 'detail' => $detail);
    }
    return array('status' => 'warn', 'label' => 'Not detected', 'detail' => 'No Cloudflare headers in response');
}

function deheled_check_ctm($home) {
    if (isset($home['error'])) return array('status' => 'warn', 'label' => 'Unknown', 'detail' => 'Site unreachable');
    $html = $home['body'];
    if (preg_match('/\.tctm\.co|calltrackingmetrics\.com|__ctm\b|\b_ctm\b/i', $html)) {
        $m = array();
        $detail = preg_match('#//(\d+)\.tctm\.co#i', $html, $m) ? ('Account ' . $m[1]) : 'CTM script detected';
        return array('status' => 'ok', 'label' => 'Detected', 'detail' => $detail);
    }
    return array('status' => 'fail', 'label' => 'Missing', 'detail' => 'No CallTrackingMetrics script found');
}

function deheled_check_google_tag($home) {
    if (isset($home['error'])) return array('status' => 'warn', 'label' => 'Unknown', 'detail' => 'Site unreachable');
    $html = $home['body'];
    $ids = array();
    if (preg_match_all('/GTM-[A-Z0-9]+|\bG-[A-Z0-9]{6,}\b|UA-\d{4,}-\d+/', $html, $m)) {
        $ids = array_values(array_unique($m[0]));
    }
    $has = $ids || preg_match('#googletagmanager\.com/(gtm|gtag)#i', $html) || preg_match('/gtag\(/i', $html);
    if ($has) {
        return array('status' => 'ok', 'label' => 'Detected', 'detail' => $ids ? implode(', ', $ids) : 'Google Tag detected');
    }
    return array('status' => 'fail', 'label' => 'Missing', 'detail' => 'No Google Tag / GTM script found');
}

function deheled_check_pagespeed() {
    $key = defined('WPMONITOR_PSI_KEY') ? WPMONITOR_PSI_KEY : get_option(DEHELED_PSI_OPTION, '');
    $args = array(
        'url'      => home_url('/'),
        'strategy' => 'mobile',
        'category' => 'performance',
    );
    if ($key) $args['key'] = $key;
    $endpoint = add_query_arg($args, 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed');

    $resp = wp_remote_get($endpoint, array('timeout' => 60));
    if (is_wp_error($resp)) {
        return array('status' => 'warn', 'label' => 'No data', 'detail' => $resp->get_error_message());
    }
    $code = wp_remote_retrieve_response_code($resp);
    if ($code !== 200) {
        $reason = ($code === 429) ? 'Rate limited (add an API key)' : "HTTP $code";
        return array('status' => 'warn', 'label' => 'No data', 'detail' => $reason);
    }
    $data = json_decode(wp_remote_retrieve_body($resp), true);
    $score_raw = isset($data['lighthouseResult']['categories']['performance']['score'])
        ? $data['lighthouseResult']['categories']['performance']['score'] : null;
    if ($score_raw === null) {
        return array('status' => 'warn', 'label' => 'No data', 'detail' => 'No performance score returned');
    }
    $score = (int) round($score_raw * 100);
    $audits = isset($data['lighthouseResult']['audits']) ? $data['lighthouseResult']['audits'] : array();
    $lcp = isset($audits['largest-contentful-paint']['displayValue']) ? $audits['largest-contentful-paint']['displayValue'] : '';
    $cls = isset($audits['cumulative-layout-shift']['displayValue']) ? $audits['cumulative-layout-shift']['displayValue'] : '';
    $detail = trim('mobile · ' . trim(($lcp ? "LCP $lcp" : '') . ($cls ? " · CLS $cls" : ''), ' ·'));
    $status = ($score < 50) ? 'fail' : (($score < 90) ? 'warn' : 'ok');
    return array('status' => $status, 'label' => (string) $score, 'detail' => $detail);
}

function deheled_check_updates_card() {
    $u = deheled_get_updates();
    $total = count($u['plugin_updates']) + count($u['theme_updates']) + ($u['core_update_available'] ? 1 : 0);
    if ($total === 0) {
        return array('status' => 'ok', 'label' => 'Up to date', 'detail' => 'WP ' . get_bloginfo('version') . ' · PHP ' . PHP_VERSION, 'meta' => $u);
    }
    $parts = array();
    if (count($u['plugin_updates'])) $parts[] = count($u['plugin_updates']) . ' plugin' . (count($u['plugin_updates']) > 1 ? 's' : '');
    if (count($u['theme_updates']))  $parts[] = count($u['theme_updates']) . ' theme' . (count($u['theme_updates']) > 1 ? 's' : '');
    if ($u['core_update_available']) $parts[] = 'core';
    return array('status' => 'warn', 'label' => $total . ' update' . ($total > 1 ? 's' : ''), 'detail' => implode(', ', $parts), 'meta' => $u);
}

// Runs every check and caches the result.
function deheled_run_all_checks() {
    @set_time_limit(120);
    $home = deheled_fetch_home();
    $checks = array(
        'https'      => deheled_check_https($home),
        'ssl'        => deheled_check_ssl(),
        'cloudflare' => deheled_check_cloudflare($home),
        'ctm'        => deheled_check_ctm($home),
        'googleTag'  => deheled_check_google_tag($home),
        'pagespeed'  => deheled_check_pagespeed(),
        'plugins'    => deheled_check_updates_card(),
    );
    $rank = array('ok' => 0, 'skip' => 0, 'warn' => 1, 'fail' => 2);
    $overall = 'ok';
    foreach ($checks as $c) {
        if ($rank[$c['status']] > $rank[$overall]) $overall = $c['status'];
    }
    $result = array('checked_at' => current_time('c'), 'overall' => $overall, 'checks' => $checks);
    set_transient(DEHELED_CACHE_KEY, $result, 6 * HOUR_IN_SECONDS);
    return $result;
}

/* =========================================================================
 * 3. Admin menu + panel
 * ========================================================================= */

function deheled_menu_icon() {
    // Monochrome shield with a check; WordPress tints it for the admin menu.
    $svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M10 1l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V4l7-3zm-1 11.4l4.7-4.7-1.1-1.1L9 10.2 7.4 8.6 6.3 9.7 9 12.4z"/></svg>';
    return 'data:image/svg+xml;base64,' . base64_encode($svg);
}

add_action('admin_menu', function () {
    add_menu_page(
        'Site Monitor',
        'Site Monitor',
        'manage_options',
        'deheled-monitor',
        'deheled_render_panel',
        deheled_menu_icon(),
        58
    );
});

// Save the monitoring license key from the client (nonce-protected).
add_action('admin_post_deheled_save_license', function () {
    if (!current_user_can('manage_options')) wp_die('Forbidden');
    check_admin_referer('deheled_save_license');
    $key = isset($_POST['license_key']) ? sanitize_text_field(wp_unslash($_POST['license_key'])) : '';
    update_option(DEHELED_LICENSE_OPTION, $key);
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

function deheled_render_panel() {
    $cached  = get_transient(DEHELED_CACHE_KEY);
    $nonce   = wp_create_nonce('deheled_run');
    $key_set = (defined('WPMONITOR_PSI_KEY') && WPMONITOR_PSI_KEY) || get_option(DEHELED_PSI_OPTION, '');
    ?>
    <div class="wrap deheled">
      <h1 class="deheled-title">Site Monitor
        <button class="button button-primary" id="deheled-run">Run checks now</button>
      </h1>
      <p class="deheled-sub">Health of <strong><?php echo esc_html(home_url()); ?></strong>.
        <span id="deheled-checked"><?php echo $cached ? 'Last checked ' . esc_html(date_i18n('M j, Y g:i a', strtotime($cached['checked_at']))) : 'No checks run yet.'; ?></span>
      </p>

      <div id="deheled-grid" class="deheled-grid"></div>

      <?php $license_set = (bool) get_option(DEHELED_LICENSE_OPTION, ''); ?>
      <div class="deheled-license <?php echo $license_set ? 'ok' : 'warn'; ?>">
        <h2>Monitoring license <?php echo $license_set ? '· connected ✓' : '· not connected'; ?></h2>
        <p class="description">Paste the license key from your Digital Elements dashboard. That's all this plugin needs — no <code>wp-config.php</code> changes.</p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
          <?php wp_nonce_field('deheled_save_license'); ?>
          <input type="hidden" name="action" value="deheled_save_license" />
          <input type="text" name="license_key" class="regular-text code" placeholder="DEG-XXXXX-XXXXX-XXXXX-XXXXX"
                 value="<?php echo esc_attr(get_option(DEHELED_LICENSE_OPTION, '')); ?>" />
          <button class="button button-primary">Save license</button>
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

    <style>
      .deheled-title { display:flex; align-items:center; gap:16px; }
      .deheled-sub { color:#646970; margin-top:-4px; }
      .deheled-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:14px; margin-top:18px; }
      .deheled-card { background:#fff; border:1px solid #dcdcde; border-left-width:4px; border-radius:8px; padding:14px 16px; }
      .deheled-card.ok   { border-left-color:#22c55e; }
      .deheled-card.warn { border-left-color:#f5b945; }
      .deheled-card.fail { border-left-color:#ef4444; }
      .deheled-card.skip { border-left-color:#9ca3af; }
      .deheled-card h3 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:#646970; display:flex; align-items:center; gap:8px; }
      .deheled-dot { width:9px; height:9px; border-radius:50%; display:inline-block; }
      .deheled-dot.ok{background:#22c55e}.deheled-dot.warn{background:#f5b945}.deheled-dot.fail{background:#ef4444}.deheled-dot.skip{background:#9ca3af}
      .deheled-card .v { font-size:18px; font-weight:600; }
      .deheled-card .d { font-size:12px; color:#646970; margin-top:3px; }
      .deheled-card ul { margin:8px 0 0; padding:0; list-style:none; }
      .deheled-card li { font-size:12px; border-top:1px solid #f0f0f1; padding:3px 0; display:flex; justify-content:space-between; gap:8px; }
      .deheled-card li .ver { color:#b8860b; }
      .deheled-empty { color:#646970; padding:30px 0; }
      .deheled-settings { margin-top:26px; max-width:640px; }
      .deheled-license { margin-top:24px; max-width:640px; background:#fff; border:1px solid #dcdcde; border-left-width:4px; border-radius:8px; padding:16px 18px; }
      .deheled-license.ok { border-left-color:#22c55e; }
      .deheled-license.warn { border-left-color:#f5b945; }
      .deheled-license h2 { margin:0 0 4px; font-size:15px; }
      .deheled-license form { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; }
      .deheled-settings summary { cursor:pointer; color:#2271b1; }
      #deheled-run.busy { opacity:.7; pointer-events:none; }
    </style>

    <script>
    (function(){
      var LABELS = { https:"HTTPS", ssl:"SSL", cloudflare:"Cloudflare", ctm:"CTM", googleTag:"Google Tag", pagespeed:"PageSpeed", plugins:"Updates" };
      var ORDER = ["https","ssl","cloudflare","ctm","googleTag","pagespeed","plugins"];
      var grid = document.getElementById("deheled-grid");
      var btn  = document.getElementById("deheled-run");
      var cached = <?php echo $cached ? wp_json_encode($cached) : 'null'; ?>;
      var esc = function(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); };

      function card(key, c){
        var extra = "";
        if (key === "plugins" && c.meta){
          var u = c.meta.plugin_updates||[], t = c.meta.theme_updates||[];
          if (c.meta.core_update_available) extra += '<div class="d">WordPress core &#8594; '+esc(c.meta.core_new_version||"update")+'</div>';
          if (u.length) extra += '<ul>'+u.map(function(p){return '<li><span>'+esc(p.name)+'</span><span class="ver">'+esc(p.current||"?")+' &#8594; '+esc(p.new_version||"?")+'</span></li>';}).join("")+'</ul>';
          if (t.length) extra += '<ul>'+t.map(function(p){return '<li><span>'+esc(p.name)+' (theme)</span><span class="ver">'+esc(p.current||"?")+' &#8594; '+esc(p.new_version||"?")+'</span></li>';}).join("")+'</ul>';
        }
        return '<div class="deheled-card '+c.status+'">'
          + '<h3><span class="deheled-dot '+c.status+'"></span>'+LABELS[key]+'</h3>'
          + '<div class="v">'+esc(c.label||"\u2014")+'</div>'
          + '<div class="d">'+esc(c.detail||"")+'</div>'+extra+'</div>';
      }
      function render(data){
        if(!data || !data.checks){ grid.innerHTML = '<div class="deheled-empty">No data yet &mdash; click <strong>Run checks now</strong>.</div>'; return; }
        grid.innerHTML = ORDER.map(function(k){ return card(k, data.checks[k]||{status:"skip",label:"\u2014"}); }).join("");
      }
      function run(){
        btn.classList.add("busy"); btn.textContent = "Running\u2026";
        var body = new URLSearchParams({ action:"deheled_run", _ajax_nonce:"<?php echo esc_js($nonce); ?>" });
        fetch(ajaxurl, { method:"POST", credentials:"same-origin", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: body })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if(j && j.success){ render(j.data); document.getElementById("deheled-checked").textContent = "Last checked just now"; }
            btn.classList.remove("busy"); btn.textContent = "Run checks now";
          })
          .catch(function(){ btn.classList.remove("busy"); btn.textContent = "Run checks now"; });
      }
      btn.addEventListener("click", run);
      render(cached);
    })();
    </script>
    <?php
}
