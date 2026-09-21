<?php
/**
 * Signed outbound calls to the Digital Elements dashboard.
 *
 * The direction that did not exist before 2.7.0. Until now this plugin only
 * ever called the hub with its license key (validation, history, the update
 * manifest), and the hub called us with signed requests. Adding staff from
 * inside a client's WP Admin needs the reverse.
 *
 * THE PLUGIN NEVER CREATES A USER. It asks the hub, and the hub creates the
 * account through the same de/v2 path it has always used — coming back to this
 * very site, with the same guards, the same idempotency, the same audit trail
 * and the same set-password email. This file is a transport, nothing more.
 *
 * Signing reuses the per-site credential stored at enrollment, with the SAME
 * canonical string as inbound requests, but a DIFFERENT version string:
 *
 *     inbound   DE1-HMAC-SHA256        hub  -> this site
 *     outbound  DE1-SITE-HMAC-SHA256   this site -> hub
 *
 * That matters. Both directions share a secret and a canonical string, so
 * without a distinct version a signature captured from one could in principle
 * be presented in the other. Each side compares the version before doing any
 * cryptography, which makes the two separate domains rather than merely
 * differently-routed.
 */

if (!defined('ABSPATH')) { exit; }

/** The version string for requests this site sends TO the hub. */
define('DEHELED_UM_SITE_SIG_VERSION', 'DE1-SITE-HMAC-SHA256');

/** Where the site API lives on the hub. */
define('DEHELED_SITE_API_BASE', '/api/site/v1');

/** Roster cache lifetime. Long enough to be worth having, short enough that a
 *  colleague added in the dashboard shows up without anyone hunting for
 *  Refresh. */
define('DEHELED_ROSTER_TTL', 5 * MINUTE_IN_SECONDS);

/**
 * Cache key for this site's roster.
 *
 * Keyed on the CREDENTIAL, not the site: if the credential is rotated or
 * revoked, the old cache becomes unreachable rather than continuing to serve a
 * roster to a site that has just lost access.
 */
function deheled_hub_roster_cache_key() {
    return 'deheled_roster_' . substr(hash('sha256', (string) get_option(DEHELED_UM_KEY_ID, '')), 0, 20);
}

function deheled_hub_clear_roster_cache() {
    delete_transient(deheled_hub_roster_cache_key());
}

/**
 * One signed request to the hub.
 *
 * Returns the decoded body on success, or a WP_Error whose message is safe to
 * show an administrator. Hub error detail is deliberately NOT passed through
 * verbatim — a failure there should not become markup here.
 */
function deheled_hub_request($method, $path, $args = array()) {
    if (!deheled_um_is_enrolled()) {
        return new WP_Error('not_enrolled', 'This website isn\'t connected to Digital Elements yet.');
    }

    $key_id = (string) get_option(DEHELED_UM_KEY_ID, '');
    $secret = (string) get_option(DEHELED_UM_SECRET, '');
    if ($key_id === '' || $secret === '') {
        return new WP_Error('not_enrolled', 'This website isn\'t connected to Digital Elements yet.');
    }

    $route = DEHELED_SITE_API_BASE . $path;
    $body  = isset($args['body']) ? wp_json_encode($args['body']) : '';
    $idem  = isset($args['idempotency_key']) ? (string) $args['idempotency_key'] : '';
    $ts    = (string) time();
    $nonce = wp_generate_uuid4();

    // No query parameters anywhere in this client, on purpose: the roster cache
    // lives here, so "refresh" is a local concern and never needs to reach the
    // hub. One less thing that has to be canonicalised identically on both
    // sides to produce a matching signature.
    $canonical = deheled_um_canonical_string($method, $route, array(), $ts, $nonce, $idem, $body);
    $signature = base64_encode(hash_hmac('sha256', $canonical, $secret, true));

    $headers = array(
        'X-DE-Key-Id'    => $key_id,
        'X-DE-Timestamp' => $ts,
        'X-DE-Nonce'     => $nonce,
        'X-DE-Signature' => DEHELED_UM_SITE_SIG_VERSION . ' ' . $signature,
        'Accept'         => 'application/json',
    );
    if ($body !== '') $headers['Content-Type'] = 'application/json';
    if ($idem !== '') $headers['Idempotency-Key'] = $idem;

    $response = wp_remote_request(DEHELED_HUB_URL . $route, array(
        'method'  => $method,
        'timeout' => isset($args['timeout']) ? (int) $args['timeout'] : 20,
        'headers' => $headers,
        'body'    => $body !== '' ? $body : null,
    ));

    if (is_wp_error($response)) {
        return new WP_Error('hub_unreachable', 'Couldn\'t reach the Digital Elements dashboard.');
    }

    $code    = (int) wp_remote_retrieve_response_code($response);
    $decoded = json_decode(wp_remote_retrieve_body($response), true);

    if ($code === 429) {
        return new WP_Error('rate_limited', 'The dashboard is rate-limiting this website. Try again shortly.');
    }
    if ($code === 403) {
        // The hub answers every credential failure identically on purpose, so
        // there is nothing more specific to say — except for the one case it
        // does distinguish, which an administrator can act on.
        $hub_code = isset($decoded['error']['code']) ? (string) $decoded['error']['code'] : '';
        if ($hub_code === 'scope_denied') {
            return new WP_Error('scope_denied', 'Digital Elements hasn\'t permitted this website to add staff from here.');
        }
        return new WP_Error('forbidden', 'The dashboard refused this website\'s request. Try reconnecting under DE Monitoring.');
    }
    if ($code >= 500) {
        return new WP_Error('hub_error', 'The dashboard had a problem handling that. Try again shortly.');
    }
    if (!is_array($decoded)) {
        return new WP_Error('hub_bad_response', 'The dashboard returned something unexpected.');
    }
    if (empty($decoded['ok'])) {
        // A 4xx with a message written for an administrator — a role that
        // doesn't exist here, a person no longer on the roster. Safe to show.
        $message = isset($decoded['error']['message']) ? (string) $decoded['error']['message'] : 'The dashboard refused that request.';
        $code_s  = isset($decoded['error']['code']) ? (string) $decoded['error']['code'] : 'failed';
        return new WP_Error($code_s, $message);
    }

    return $decoded;
}

/**
 * The roster, cached locally.
 *
 * Cached rather than fetched per page load because this panel is opened and
 * re-opened while someone works through a list, and the roster changes rarely.
 */
function deheled_hub_get_roster($force = false) {
    $key = deheled_hub_roster_cache_key();
    if (!$force) {
        $cached = get_transient($key);
        if (is_array($cached)) return $cached;
    }

    $roster = deheled_hub_request('GET', '/roster', array('timeout' => 15));
    if (is_wp_error($roster)) return $roster;

    set_transient($key, $roster, DEHELED_ROSTER_TTL);
    return $roster;
}

function deheled_hub_preflight($staff_ids, $role = '') {
    $body = array('staffUserIds' => array_values($staff_ids));
    if ($role !== '') $body['role'] = $role;
    return deheled_hub_request('POST', '/preflight', array('body' => $body, 'timeout' => 30));
}

/**
 * Asks the hub to assign people to this site.
 *
 * The idempotency key is generated once per submission and reused on every
 * retry, which is what makes Retry safe: the hub returns the SAME job rather
 * than starting a second one that adds everybody twice.
 */
function deheled_hub_assign($staff_ids, $role, $idempotency_key, $confirm_admin = false) {
    $body = array(
        'staffUserIds' => array_values($staff_ids),
        'actorEmail'   => wp_get_current_user()->user_email,
        'confirmAdmin' => (bool) $confirm_admin,
    );
    if ($role !== '') $body['role'] = $role;

    return deheled_hub_request('POST', '/assign', array(
        'body'            => $body,
        'idempotency_key' => $idempotency_key,
        'timeout'         => 30,
    ));
}

function deheled_hub_job($job_id) {
    $job_id = preg_replace('/[^a-zA-Z0-9\-]/', '', (string) $job_id);
    if ($job_id === '') return new WP_Error('bad_request', 'No job to check.');
    return deheled_hub_request('GET', '/jobs/' . $job_id, array('timeout' => 15));
}
