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
        // The hub answers every CREDENTIAL failure identically on purpose, so
        // for those there is nothing more specific to say. The refusals below
        // are different: they are about the person or this plugin's version,
        // the hub writes them for an administrator to read, and each has a
        // different thing to do about it. Passing them through is what stops
        // "you aren't on the roster" and "the credential is wrong" from looking
        // the same to whoever is standing at the screen.
        $hub_code = isset($decoded['error']['code']) ? (string) $decoded['error']['code'] : '';
        $hub_message = isset($decoded['error']['message']) ? (string) $decoded['error']['message'] : '';
        $passthrough = array('scope_denied', 'actor_not_on_roster', 'actor_team_not_allowed',
                             'actor_inactive', 'actor_not_agency', 'plugin_update_required');
        if ($hub_code === 'scope_denied') {
            return new WP_Error('scope_denied', 'Digital Elements hasn\'t permitted this website to add staff from here.');
        }
        if (in_array($hub_code, $passthrough, true) && $hub_message !== '') {
            return new WP_Error($hub_code, $hub_message);
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
/**
 * Who the hub should treat as acting, and what it needs to know about them.
 *
 * Sent on every call, in the BODY, so the signature covers it byte for byte.
 * The hub refuses a request that omits it rather than treating it as anonymous:
 * a rule that can be skipped by leaving a field out is not a rule.
 *
 * `actorManaged` is what lets the hub adopt a colleague's pre-existing account
 * exactly once — it asks only when the site says the account isn't ours yet.
 */
function deheled_hub_actor_fields() {
    $user = wp_get_current_user();
    if (!$user || !$user->ID) return array();
    return array(
        'actorEmail'    => (string) $user->user_email,
        'actorWpUserId' => (int) $user->ID,
        'actorManaged'  => deheled_um_user_is_managed($user->ID),
    );
}

/**
 * The roster, cached locally.
 *
 * POST rather than GET since 2.7.1: the acting person travels in the body,
 * where the signature already covers the exact bytes. A query string would have
 * to canonicalise identically in PHP and JS to produce a matching signature,
 * and there is nothing to gain by taking that risk.
 */
function deheled_hub_get_roster($force = false) {
    $key = deheled_hub_roster_cache_key();
    if (!$force) {
        $cached = get_transient($key);
        if (is_array($cached)) return $cached;
    }

    // 25s rather than 15: this one call now makes the dashboard probe this
    // site's capabilities, read its roles, and — on a first visit — adopt the
    // caller's account, each of which is a round trip back here. It is the
    // slowest request this plugin makes, and timing it out shows the panel as
    // "can't reach Digital Elements" when the dashboard was simply working.
    $roster = deheled_hub_request('POST', '/roster', array(
        'body'    => deheled_hub_actor_fields(),
        'timeout' => 25,
    ));
    if (is_wp_error($roster)) return $roster;

    // Tell the dashboard who is ACTUALLY on this site -- but only when what we
    // can see differs from what it just told us.
    //
    // The panel itself never needed this: it reads the WordPress user table
    // directly, so it is right on the first load either way. This is for the
    // DASHBOARD's rows, which is where the wrong answer lived. Sending it costs
    // a second request, so it is sent only when there is something to correct,
    // which on a site in step is never.
    $observed = deheled_site_users_observed($roster);
    $drifted = false;
    foreach ($observed as $o) {
        if (!empty($o['drifted'])) { $drifted = true; break; }
    }
    if ($drifted) {
        $reconciled = deheled_hub_request('POST', '/roster', array(
            'body'    => array_merge(deheled_hub_actor_fields(), array('observed' => $observed)),
            'timeout' => 20,
        ));
        if (!is_wp_error($reconciled)) $roster = $reconciled;
    }

    // Not cached when the hub has just adopted this account: the very next
    // request should report the account as managed, and a five-minute cache of
    // "we linked you" would make a second visit look like a second link.
    $linked = isset($roster['actor']['linked']) && $roster['actor']['linked'] === true;
    if (!$linked) set_transient($key, $roster, DEHELED_ROSTER_TTL);
    return $roster;
}

function deheled_hub_preflight($staff_ids, $role = '') {
    $body = array_merge(deheled_hub_actor_fields(), array('staffUserIds' => array_values($staff_ids)));
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
    $body = array_merge(deheled_hub_actor_fields(), array(
        'staffUserIds' => array_values($staff_ids),
        'confirmAdmin' => (bool) $confirm_admin,
    ));
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
