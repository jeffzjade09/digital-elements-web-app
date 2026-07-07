<?php
if (!defined('ABSPATH')) { exit; }

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
