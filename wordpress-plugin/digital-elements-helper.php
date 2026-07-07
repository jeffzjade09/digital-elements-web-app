<?php
/**
 * Plugin Name: Digital Elements Helper Plugin
 * Description: Connects this site to the Digital Elements monitoring dashboard. Adds an admin panel showing HTTPS, SSL, Cloudflare, CTM, Google Tag, PageSpeed, and update status, plus a secure, read-only endpoint the central dashboard reads. It cannot modify the site, access content, or run updates.
 * Version:     1.5
 * Author:      Digital Elements Group
 * Author URI:  https://digitalelementsgroup.com/
 * Plugin URI:  https://digitalelementsgroup.com/
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SETUP (client-friendly)
 *
 * 1) In the Digital Elements dashboard, add this website. A unique license key
 *    is generated for it (format DEG-XXXXX-XXXXX-XXXXX-XXXXX).
 * 2) Install & activate this plugin, then go to WP Admin → DE Monitoring and
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

define('DEHELED_VERSION', '1.5');
define('DEHELED_CACHE_KEY', 'deheled_status_cache');
define('DEHELED_PSI_OPTION', 'deheled_psi_key');
define('DEHELED_LICENSE_OPTION', 'deheled_license_key');
define('DEHELED_SEC_OPTION', 'deheled_security_result');
define('DEHELED_SEC_CRON', 'deheled_security_scan_event');
define('DEHELED_LIC_STATUS', 'deheled_license_status');
// Central dashboard used to verify the license key. Override by defining
// DEHELED_HUB_URL in wp-config.php if the dashboard ever moves.
if (!defined('DEHELED_HUB_URL')) {
    define('DEHELED_HUB_URL', 'https://digital-elements-web-app-production.up.railway.app');
}

/* =========================================================================
 * 1. REST endpoint for the central dashboard (kept lean: updates only)
 * ========================================================================= */

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

// Run the deep scan daily in the background so the REST call stays instant.
add_action('init', function () {
    if (!wp_next_scheduled(DEHELED_SEC_CRON)) {
        wp_schedule_event(time() + 300, 'daily', DEHELED_SEC_CRON);
    }
});
add_action(DEHELED_SEC_CRON, 'deheled_security_scan');
register_deactivation_hook(__FILE__, function () {
    wp_clear_scheduled_hook(DEHELED_SEC_CRON);
});


function deheled_validate_token($provided) {
    if (!is_string($provided) || $provided === '') {
        return false;
    }
    // Preferred: the license key entered in DE Monitoring settings (no wp-config needed).
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
 * 2b. Deep security scan (server-side; daily cron + on-demand)
 *
 * Read-only. Never modifies files. Bounded by a time budget and file caps so
 * it can't hang or exhaust memory on large/shared hosts. It looks for the
 * high-signal fingerprints of a compromise: PHP in uploads, obfuscated code
 * signatures, modified WordPress core files, and newly-created admin accounts.
 * ========================================================================= */

// Signature list. HIGH = strong backdoor/injection indicators. We deliberately
// do NOT flag lone base64_decode()/eval() — legitimate plugins use them — only
// the combinations and user-input sinks that malware actually uses.
// NOTE: web-shell names are assembled via concatenation so this file never
// contains them literally (otherwise the scanner would flag itself).
function deheled_sec_patterns() {
    $shells = implode('|', array(
        'c99' . 'shell', 'r57' . 'shell', 'b37' . '4k', 'files' . 'man',
        'wso' . 'shell', 'php' . 'spy', 'wee' . 'vely',
    ));
    return array(
        'high' => array(
            '/eval\s*\(\s*(?:gzinflate|gzuncompress|str_rot13)?\s*\(?\s*base64_decode\s*\(/i' => 'eval() of a base64/gzip payload (backdoor)',
            '/\bpreg_replace\s*\(\s*([\'"])([^a-zA-Z0-9\s]).*?\2[imsxuADSUXJ]*e[imsxuADSUXJ]*\1/is' => 'preg_replace() with /e modifier (code execution)',
            '/\b(?:' . $shells . ')\b/i'                                                      => 'Known web-shell signature',
            '/\beval\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE|SERVER)/i'                          => 'eval() of user input (remote code execution)',
            '/\b(?:system|shell_exec|passthru|proc_open|popen)\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/i' => 'Shell command built from user input',
            '/\bassert\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/i'                               => 'assert() of user input (code execution)',
            '/\bmove_uploaded_file\s*\([^;]*\.php/i'                                          => 'Uploader writing a .php file',
        ),
        'med' => array(
            '/\bgzinflate\s*\(\s*base64_decode\s*\(/i'          => 'gzinflate + base64 obfuscation chain',
            '/\bstr_rot13\s*\(\s*base64_decode\s*\(/i'          => 'str_rot13 + base64 obfuscation chain',
            '/\$\{\s*[\'"]\w+[\'"]\s*\}\s*\(/'                  => 'Dynamic variable-function call (obfuscation)',
            '/\bcreate_function\s*\(/i'                          => 'create_function usage (removed in PHP 8; common in malware)',
        ),
    );
}

function deheled_sec_rel($path) {
    $abs = wp_normalize_path(ABSPATH);
    $p   = wp_normalize_path($path);
    return (strpos($p, $abs) === 0) ? substr($p, strlen($abs)) : basename($p);
}

// Match the strongest signature in a blob of code. Returns null or {sev,msg}.
function deheled_sec_match($code, $patterns) {
    foreach ($patterns['high'] as $re => $msg) {
        if (preg_match($re, $code)) return array('sev' => 'high', 'msg' => $msg);
    }
    foreach ($patterns['med'] as $re => $msg) {
        if (preg_match($re, $code)) return array('sev' => 'med', 'msg' => $msg);
    }
    return null;
}

// Walk a directory for .php files, invoking $cb($fullpath) for each, honoring
// the shared time budget. Returns true if it stopped early (budget/error).
function deheled_sec_walk($dir, $cb, $start, $budget) {
    if (!is_dir($dir) || !is_readable($dir)) return false;
    try {
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS | FilesystemIterator::FOLLOW_SYMLINKS),
            RecursiveIteratorIterator::LEAVES_ONLY
        );
        foreach ($it as $file) {
            if ((microtime(true) - $start) > $budget) return true;
            if (!$file->isFile()) continue;
            if (strtolower($file->getExtension()) !== 'php') continue;
            $cb($file->getPathname());
        }
    } catch (Exception $e) {
        return true;
    }
    return false;
}

// Benign "guard" files: plugins (Yoast, WooCommerce, …) drop empty index.php
// files into uploads subfolders to block directory listing. Only PHP open tag,
// comments, whitespace, and at most a lone exit/die — no real code.
function deheled_sec_is_guard_file($file) {
    $size = @filesize($file);
    if ($size === false || $size > 4096) return false;
    $code = @file_get_contents($file);
    if ($code === false) return false;
    $stripped = preg_replace('/\/\*.*?\*\//s', '', $code);          // block comments
    $stripped = preg_replace('/(?:\/\/|#)[^\r\n]*/', '', $stripped); // line comments
    $stripped = preg_replace('/<\?(?:php)?|\?>/i', '', $stripped);   // php tags
    $stripped = preg_replace('/\b(?:exit|die)\s*(?:\(\s*\))?\s*;?/i', '', $stripped);
    return trim($stripped) === '';
}

function deheled_security_scan() {
    @set_time_limit(60);
    if (function_exists('wp_raise_memory_limit')) wp_raise_memory_limit('admin');

    $start    = microtime(true);
    $budget   = 15.0;                 // hard wall-clock budget (seconds)
    $maxBytes = 2 * 1024 * 1024;      // skip files larger than 2 MB
    $patterns = deheled_sec_patterns();

    $findings = array();
    $scanned = 0; $skippedBig = 0; $phpInUploads = 0; $partial = false;

    // 1) PHP files inside uploads — should never exist (empty guard index.php
    //    files that plugins create to block directory listing are exempt).
    $up  = wp_upload_dir();
    $upl = isset($up['basedir']) ? $up['basedir'] : WP_CONTENT_DIR . '/uploads';
    $partial = deheled_sec_walk($upl, function ($file) use (&$findings, &$phpInUploads, $patterns, $maxBytes) {
        if ($phpInUploads >= 25) return;
        if (deheled_sec_is_guard_file($file)) return;
        $phpInUploads++;
        $msg = 'PHP file in uploads directory';
        $size = @filesize($file);
        if ($size !== false && $size <= $maxBytes) {
            $code = @file_get_contents($file);
            if ($code !== false) {
                $hit = deheled_sec_match($code, $patterns);
                if ($hit) $msg .= ' (' . $hit['msg'] . ')';
            }
        }
        $findings[] = array('sev' => 'high', 'msg' => $msg, 'file' => deheled_sec_rel($file));
    }, $start, $budget) || $partial;

    // 2) Obfuscated / injected code in themes, plugins and mu-plugins.
    //    Our own plugin folder is skipped — it contains the signature list.
    $own = wp_normalize_path(plugin_dir_path(__FILE__));
    $dirs = array(get_theme_root(), defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR : WP_CONTENT_DIR . '/plugins');
    if (defined('WPMU_PLUGIN_DIR') && is_dir(WPMU_PLUGIN_DIR)) $dirs[] = WPMU_PLUGIN_DIR;
    foreach (array_unique($dirs) as $dir) {
        $stop = deheled_sec_walk($dir, function ($file) use (&$findings, &$scanned, &$skippedBig, $patterns, $maxBytes, $own) {
            if (count($findings) >= 80) return;
            if ($own && strpos(wp_normalize_path($file), $own) === 0) return;
            $size = @filesize($file);
            if ($size === false) return;
            if ($size > $maxBytes) { $skippedBig++; return; }
            $code = @file_get_contents($file);
            if ($code === false) return;
            $scanned++;
            $hit = deheled_sec_match($code, $patterns);
            if ($hit) $findings[] = array('sev' => $hit['sev'], 'msg' => $hit['msg'], 'file' => deheled_sec_rel($file));
        }, $start, $budget);
        if ($stop) { $partial = true; break; }
    }

    // 3) Modified WordPress core files (checksum verification against WordPress.org).
    if ((microtime(true) - $start) < $budget) {
        if (!function_exists('get_core_checksums')) {
            @require_once ABSPATH . 'wp-admin/includes/update.php';
        }
        if (function_exists('get_core_checksums')) {
            $sums = @get_core_checksums(get_bloginfo('version'), 'en_US');
            if (is_array($sums)) {
                $badCore = 0;
                foreach ($sums as $rel => $md5) {
                    if ((microtime(true) - $start) > $budget) { $partial = true; break; }
                    if (strpos($rel, 'wp-content/') === 0) continue;   // themes/plugins change legitimately
                    $path = ABSPATH . $rel;
                    if (!file_exists($path)) continue;
                    if (@md5_file($path) !== $md5) {
                        $findings[] = array('sev' => 'high', 'msg' => 'Modified WordPress core file', 'file' => $rel);
                        if (++$badCore >= 15) { break; }
                    }
                }
            }
        }
    }

    // 4) Admin accounts created recently (surface for review — not proof of compromise).
    $newAdmins = array();
    $admins = get_users(array('role' => 'administrator', 'number' => 50, 'fields' => array('user_login', 'user_registered')));
    $cutoff = time() - 30 * DAY_IN_SECONDS;
    foreach ($admins as $ua) {
        $reg = strtotime($ua->user_registered);
        if ($reg && $reg >= $cutoff) $newAdmins[] = $ua->user_login;
    }
    if (!empty($newAdmins)) {
        $findings[] = array('sev' => 'med', 'msg' => 'Admin account(s) created in last 30 days: ' . implode(', ', array_slice($newAdmins, 0, 5)));
    }

    $result = array(
        'scanned_at'     => current_time('c'),
        'files_scanned'  => $scanned,
        'skipped_large'  => $skippedBig,
        'php_in_uploads' => $phpInUploads,
        'admin_count'    => is_array($admins) ? count($admins) : null,
        'partial'        => $partial,
        'findings'       => array_slice($findings, 0, 80),
    );
    update_option(DEHELED_SEC_OPTION, $result, false);
    return $result;
}

/* =========================================================================
 * 3. Admin menu + panel
 * ========================================================================= */

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
// Fail-soft: if the dashboard is unreachable we keep the last known status.
function deheled_validate_license($key) {
    $key = trim((string) $key);
    if ($key === '') {
        delete_option(DEHELED_LIC_STATUS);
        return null;
    }
    $res = wp_remote_get(
        DEHELED_HUB_URL . '/api/license/validate?key=' . rawurlencode($key),
        array('timeout' => 8)
    );
    $status = array('checked_at' => time());
    if (is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200) {
        $prev = get_option(DEHELED_LIC_STATUS, array());
        $status = is_array($prev) ? $prev : array();
        $status['checked_at'] = isset($status['checked_at']) ? $status['checked_at'] : 0;
        $status['unreachable'] = time();
        update_option(DEHELED_LIC_STATUS, $status, false);
        return $status;
    }
    $body = json_decode(wp_remote_retrieve_body($res), true);
    $status['unreachable'] = 0;
    $status['valid']      = !empty($body['valid']);
    $status['expired']    = !empty($body['expired']);
    $status['site']       = isset($body['site']) ? (string) $body['site'] : '';
    $status['expires_at'] = isset($body['expiresAt']) ? (string) $body['expiresAt'] : '';
    $status['days_left']  = isset($body['daysLeft']) ? $body['daysLeft'] : null;
    update_option(DEHELED_LIC_STATUS, $status, false);
    return $status;
}

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
      <p class="deheled-sub">Digital Elements Group &middot; Health of <strong><?php echo esc_html(home_url()); ?></strong>.
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

    <style>
      .deheled-title { display:flex; align-items:center; gap:16px; }
      .deheled-logo { height:36px; width:36px; object-fit:contain; border-radius:9px; background:#1d2327; padding:5px; box-sizing:border-box; }
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
      .deheled-license.bad { border-left-color:#ef4444; }
      .deheled-lic-status { margin:4px 0 10px; font-size:13px; }
      .deheled-lic-status.good { color:#137333; }
      .deheled-lic-status.bad { color:#b91c1c; }
      .deheled-lic-status.dim { color:#646970; }
      #deheled-lic-input[readonly] { background:#f0f0f1; color:#50575e; }
      .deheled-license h2 { margin:0 0 4px; font-size:15px; }
      .deheled-license form { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; }
      .deheled-settings summary { cursor:pointer; color:#2271b1; }
      #deheled-run.busy, #deheled-scan.busy { opacity:.7; pointer-events:none; }
      .deheled-security { margin-top:26px; max-width:860px; background:#fff; border:1px solid #dcdcde; border-radius:8px; padding:16px 18px; }
      .deheled-security h2 { margin:0 0 4px; font-size:15px; }
      .deheled-sec-list { margin:12px 0 0; padding:0; list-style:none; }
      .deheled-sec-list li { display:flex; align-items:flex-start; gap:9px; padding:7px 0; border-top:1px solid #f0f0f1; font-size:13px; }
      .deheled-sec-list li:first-child { border-top:0; }
      .deheled-sec-sev { flex:0 0 auto; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; padding:2px 7px; border-radius:20px; margin-top:1px; }
      .deheled-sec-sev.high { background:#fde8e8; color:#b91c1c; }
      .deheled-sec-sev.med  { background:#fef3cd; color:#92660a; }
      .deheled-sec-file { color:#646970; font-family:Menlo,Consolas,monospace; font-size:12px; }
      .deheled-sec-clean { color:#137333; font-weight:600; padding:10px 0; }
      .deheled-history { margin-top:26px; max-width:860px; background:#fff; border:1px solid #dcdcde; border-radius:8px; padding:16px 18px; }
      .deheled-history h2 { margin:0 0 4px; font-size:15px; }
      .deheled-ranges .deheled-range.is-on { border-color:#2271b1; color:#2271b1; font-weight:600; }
      .deheled-uptime { margin-left:auto; font-weight:700; font-size:15px; color:#1d2327; }
      .deheled-hcharts { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; margin:14px 0 4px; }
      .deheled-hchart { border:1px solid #e2e4e7; border-radius:8px; padding:10px 12px; background:#fafafa; }
      .deheled-hchart-head { display:flex; justify-content:space-between; align-items:baseline; font-size:11px; color:#646970; text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }
      .deheled-hchart-head strong { color:#1d2327; font-size:13px; }
      .deheled-hevents { margin:10px 0 0; padding:0; list-style:none; }
      .deheled-hevents li { display:flex; align-items:center; gap:8px; font-size:12.5px; padding:6px 0; border-top:1px solid #f0f0f1; }
      .deheled-hevents li:first-child { border-top:0; }
      .deheled-hdot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
      .deheled-hwhen { margin-left:auto; color:#8c8f94; font-size:11px; }
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

      // ---- Security scan ----
      var secBtn  = document.getElementById("deheled-scan");
      var secBody = document.getElementById("deheled-sec-body");
      var secWhen = document.getElementById("deheled-sec-when");
      var secData = <?php echo is_array($sec) ? wp_json_encode($sec) : 'null'; ?>;

      function renderSec(d){
        if(!d){ secBody.innerHTML = ""; return; }
        var f = d.findings || [];
        if(!f.length){
          secBody.innerHTML = '<div class="deheled-sec-clean">&#10003; No threats found &middot; '
            + (d.files_scanned||0) + ' files scanned'
            + (d.partial ? ' (scan hit its time limit; large sites may need a rescan)' : '') + '</div>';
          return;
        }
        secBody.innerHTML = '<ul class="deheled-sec-list">' + f.map(function(x){
          return '<li><span class="deheled-sec-sev '+(x.sev==="high"?"high":"med")+'">'+(x.sev==="high"?"High":"Review")+'</span>'
            + '<span>'+esc(x.msg)+(x.file?' <span class="deheled-sec-file">'+esc(x.file)+'</span>':'')+'</span></li>';
        }).join("") + '</ul>';
      }
      function scan(){
        secBtn.classList.add("busy"); secBtn.textContent = "Scanning\u2026";
        var body = new URLSearchParams({ action:"deheled_scan", _ajax_nonce:"<?php echo esc_js($nonce); ?>" });
        fetch(ajaxurl, { method:"POST", credentials:"same-origin", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: body })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if(j && j.success){ renderSec(j.data); secWhen.textContent = "Last scan just now"; }
            secBtn.classList.remove("busy"); secBtn.textContent = "Run scan now";
          })
          .catch(function(){ secBtn.classList.remove("busy"); secBtn.textContent = "Run scan now"; });
      }
      secBtn.addEventListener("click", scan);
      renderSec(secData);

      // ---- History & trends ----
      var histDays = 30;
      function downsample(vals, target){
        if(vals.length <= target) return vals;
        var out = [], b = vals.length / target;
        for(var i=0;i<target;i++){
          var s = vals.slice(Math.floor(i*b), Math.floor((i+1)*b) || Math.floor(i*b)+1);
          out.push(s.reduce(function(a,x){return a+x;},0)/s.length);
        }
        return out;
      }
      function lineSvg(raw, color, zeroBase){
        var vals = downsample(raw, 120);
        if(vals.length < 2) return "";
        var W=260,H=46,pad=4;
        var min=Math.min.apply(null,vals), max=Math.max.apply(null,vals);
        if(zeroBase) min=Math.min(min,0);
        if(min===max){min-=1;max+=1;}
        var step=(W-pad*2)/(vals.length-1);
        var pts=vals.map(function(v,i){return (pad+i*step).toFixed(1)+","+(pad+(1-(v-min)/(max-min))*(H-pad*2)).toFixed(1);}).join(" ");
        return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" width="100%" height="'+H+'"><polyline fill="none" stroke="'+color+'" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" points="'+pts+'"/></svg>';
      }
      function relTime(iso){
        var s=(Date.now()-new Date(iso).getTime())/1000;
        if(s<60) return "just now";
        if(s<3600) return Math.floor(s/60)+"m ago";
        if(s<86400) return Math.floor(s/3600)+"h ago";
        var d=Math.floor(s/86400);
        return d<30 ? d+"d ago" : new Date(iso).toLocaleDateString();
      }
      var HLBL = { ok:["#22c55e","Operational"], warn:["#f59e0b","Warning"], fail:["#ef4444","Failing"], skip:["#8c8f94","Pending"] };
      function renderHist(d){
        var up = document.getElementById("deheled-hist-up");
        up.textContent = (d.uptime==null ? "\u2014" : d.uptime+"%") + " uptime \u00b7 " + d.days + " days";
        var S = d.samples || [];
        var pick = function(k){ return S.filter(function(s){return typeof s[k]==="number";}).map(function(s){return s[k];}); };
        var ps = pick("pagespeed"), rt = pick("responseMs"), ssl = pick("sslDays");
        var psColor = ps.length ? (ps[ps.length-1]>=90 ? "#22c55e" : ps[ps.length-1]>=50 ? "#f59e0b" : "#ef4444") : "#2271b1";
        function card(label, vals, color, zero, fmt){
          if(vals.length < 2) return "";
          return '<div class="deheled-hchart"><div class="deheled-hchart-head"><span>'+label+'</span><strong>'+fmt(vals[vals.length-1])+'</strong></div>'+lineSvg(vals,color,zero)+'</div>';
        }
        var charts =
          card("PageSpeed", ps, psColor, false, function(v){return Math.round(v);}) +
          card("Response time", rt, "#2271b1", true, function(v){return Math.round(v)+"ms";}) +
          card("SSL days left", ssl, "#6366f1", true, function(v){return Math.round(v)+"d";});
        document.getElementById("deheled-hist-charts").innerHTML =
          charts || '<p class="description">Trends appear once the dashboard has collected a few samples.</p>';
        var ev = (d.events||[]).slice(0,6).map(function(e){
          var to=HLBL[e.to]||HLBL.skip, from=e.from?(HLBL[e.from]||HLBL.skip)[1]:"New";
          return '<li><span class="deheled-hdot" style="background:'+to[0]+'"></span>'+esc(from)+' \u2192 '+esc(to[1])+'<span class="deheled-hwhen">'+relTime(e.at)+'</span></li>';
        }).join("");
        document.getElementById("deheled-hist-events").innerHTML = ev;
      }
      function loadHist(days){
        histDays = days;
        var msg = document.getElementById("deheled-hist-msg");
        msg.style.display = "none";
        document.querySelectorAll(".deheled-range").forEach(function(b){ b.classList.toggle("is-on", parseInt(b.dataset.days,10)===days); });
        var body = new URLSearchParams({ action:"deheled_history", days:String(days), _ajax_nonce:"<?php echo esc_js($nonce); ?>" });
        fetch(ajaxurl, { method:"POST", credentials:"same-origin", headers:{ "Content-Type":"application/x-www-form-urlencoded" }, body: body })
          .then(function(r){ return r.json(); })
          .then(function(j){
            if(j && j.success){ renderHist(j.data); }
            else { msg.textContent = (j && j.data ? j.data : "History unavailable") + " \u2014 make sure the monitoring license is active."; msg.style.display = ""; }
          })
          .catch(function(){ msg.textContent = "Could not load history."; msg.style.display = ""; });
      }
      document.querySelectorAll(".deheled-range").forEach(function(b){
        b.addEventListener("click", function(){ loadHist(parseInt(b.dataset.days,10)); });
      });
      loadHist(30);

      // ---- License field lock/unlock ----
      var licChange = document.getElementById("deheled-lic-change");
      if (licChange) {
        licChange.addEventListener("click", function () {
          var input = document.getElementById("deheled-lic-input");
          input.removeAttribute("readonly");
          input.focus();
          input.select();
          licChange.style.display = "none";
          document.getElementById("deheled-lic-save").style.display = "";
        });
      }
    })();
    </script>
    <?php
}
