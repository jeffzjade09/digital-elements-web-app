<?php
/**
 * Authentication for the de/v2 user-management API.
 *
 * WHY THIS IS NOT THE LICENSE KEY
 * The monitoring endpoints under wpmonitor/v1 are authorized by a single shared
 * bearer token (the license key). That is fine for reading update counts. It is
 * not fine for endpoints that create, modify or delete WordPress users: one
 * leaked key would mean Administrator creation on every site that uses it.
 *
 * User-management requests therefore carry a separate, scoped credential and are
 * signed per request. The signature covers the method, route, query, timestamp,
 * nonce, idempotency key and body, so a captured request cannot be replayed,
 * pointed at a different route, or edited in flight.
 *
 * WHY current_user_can() IS NOT USED
 * These callbacks run with no logged-in WordPress user, so current_user_can() is
 * always false and cannot authorize anything. Authorization comes from three
 * stacked gates instead, all enforced in PHP:
 *
 *   1. Credential  — the request is signed by the secret this site stored at
 *                    enrollment, within a short time window, with an unused nonce.
 *   2. Scope       — the credential grants the specific scope the route declares.
 *                    users:delete and users:admin are OFF unless an administrator
 *                    of THIS site turns them on in the DE Monitoring panel, which
 *                    is a local kill switch no leaked credential can flip.
 *   3. Guard       — the handler's own rules: managed-only, role whitelist,
 *                    last-administrator protection. Those live in users.php.
 *
 * Deliberately absent: any wp_set_current_user() call. Impersonating an
 * administrator would collapse all three gates back into "holds a secret".
 */

if (!defined('ABSPATH')) { exit; }

/** The de/v2 contract revision implemented here. The dashboard gates on this. */
define('DEHELED_UM_API_VERSION', 1);

define('DEHELED_UM_KEY_ID',   'deheled_um_key_id');
define('DEHELED_UM_SECRET',   'deheled_um_secret');
define('DEHELED_UM_SCOPES',   'deheled_um_scopes');
define('DEHELED_UM_ENROLLED', 'deheled_um_enrolled_at');

define('DEHELED_UM_SIG_VERSION', 'DE1-HMAC-SHA256');
define('DEHELED_UM_MAX_SKEW', 300);      // seconds either side of our clock
define('DEHELED_UM_NONCE_TTL', 600);     // remember nonces for twice the skew
define('DEHELED_UM_RATE_MAX', 60);       // requests ...
define('DEHELED_UM_RATE_WINDOW', 300);   // ... per this many seconds

/** Scopes granted by default at enrollment. */
function deheled_um_default_scopes() {
    return array('users:read', 'users:write', 'content:reassign');
}

/** Scopes a site administrator can additionally switch on locally. */
function deheled_um_optional_scopes() {
    return array(
        'users:delete' => 'Allow the dashboard to delete users from this site',
        'users:admin'  => 'Allow the dashboard to assign the Administrator role',
    );
}

function deheled_um_scopes() {
    $scopes = get_option(DEHELED_UM_SCOPES, array());
    return is_array($scopes) ? $scopes : array();
}

function deheled_um_is_enrolled() {
    $key = get_option(DEHELED_UM_KEY_ID, '');
    $sec = get_option(DEHELED_UM_SECRET, '');
    return is_string($key) && $key !== '' && is_string($sec) && $sec !== '';
}

/**
 * Every failure answers with the same generic message; only the machine-readable
 * code differs, and only for states the dashboard must react to differently
 * (fix your clock, you replayed, that scope is off). Nothing here reveals
 * whether a key id exists, whether a user exists, or which half was wrong.
 */
function deheled_um_error($code, $status = 403, $message = 'Forbidden') {
    return new WP_Error('deheled_um_' . $code, $message, array('status' => $status, 'de_code' => $code));
}

/* -------------------------------------------------------------------------
 * Canonical string — mirrors src/usermgmt/signing.js byte for byte.
 * ---------------------------------------------------------------------- */

function deheled_um_normalize_route($route) {
    $route = preg_replace('#/{2,}#', '/', (string) $route);
    $route = trim($route, '/');
    return '/' . $route;
}

/**
 * Query parameters are sorted by name then value and RFC 3986 encoded, so the
 * signature does not depend on the order they arrived in. Parameters WordPress
 * itself may add or rewrite are excluded — signing them would make a valid
 * request fail depending on the site's permalink configuration.
 */
function deheled_um_canonical_query($params) {
    $skip = array('rest_route' => 1, '_locale' => 1, '_envelope' => 1, '_method' => 1, '_wpnonce' => 1);
    $pairs = array();
    if (is_array($params)) {
        foreach ($params as $key => $value) {
            if (isset($skip[$key])) continue;
            if (is_array($value)) {
                foreach ($value as $one) {
                    if (is_scalar($one) || $one === null) $pairs[] = array((string) $key, (string) $one);
                }
            } elseif (is_scalar($value) || $value === null) {
                $pairs[] = array((string) $key, (string) $value);
            }
        }
    }
    usort($pairs, function ($a, $b) {
        $c = strcmp($a[0], $b[0]);
        return $c !== 0 ? $c : strcmp($a[1], $b[1]);
    });
    $out = array();
    foreach ($pairs as $p) $out[] = rawurlencode($p[0]) . '=' . rawurlencode($p[1]);
    return implode('&', $out);
}

function deheled_um_canonical_string($method, $route, $query, $timestamp, $nonce, $idempotency_key, $body) {
    return implode("\n", array(
        strtoupper((string) $method),
        deheled_um_normalize_route($route),
        deheled_um_canonical_query($query),
        (string) $timestamp,
        (string) $nonce,
        (string) $idempotency_key,
        hash('sha256', (string) $body),
    ));
}

/* -------------------------------------------------------------------------
 * Replay protection and rate limiting
 * ---------------------------------------------------------------------- */

/**
 * True the first time a nonce is seen, false on every repeat.
 *
 * add_option() is used rather than set_transient() because it fails when the row
 * already exists, which makes claiming a nonce atomic: two concurrent replays
 * cannot both win the race. Autoload is off so these never load on a page view.
 */
function deheled_um_claim_nonce($nonce) {
    $key = 'deheled_um_n_' . hash('sha256', (string) $nonce);
    // Option names are capped at 191 characters; ours is well inside that.
    $claimed = add_option($key, time(), '', 'no');
    if (!$claimed) {
        // Either a genuine replay, or a stale entry we can reclaim once expired.
        $seen = (int) get_option($key, 0);
        if ($seen && (time() - $seen) > DEHELED_UM_NONCE_TTL) {
            update_option($key, time(), 'no');
            return true;
        }
        return false;
    }
    deheled_um_sweep_nonces();
    return true;
}

/**
 * Drops expired nonce rows. Runs on roughly one request in twenty so the work
 * is amortised instead of adding a query to every call.
 */
function deheled_um_sweep_nonces() {
    if (wp_rand(1, 20) !== 1) return;
    global $wpdb;
    $cutoff = time() - DEHELED_UM_NONCE_TTL;
    $names = $wpdb->get_col($wpdb->prepare(
        "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s AND option_value < %d LIMIT 200",
        $wpdb->esc_like('deheled_um_n_') . '%',
        $cutoff
    ));
    foreach ((array) $names as $name) delete_option($name);
}

/** Fixed-window limiter, per key id. Write endpoints are the ones worth capping. */
function deheled_um_rate_ok($key_id) {
    $bucket = 'deheled_um_rate_' . hash('sha256', (string) $key_id);
    $state = get_transient($bucket);
    if (!is_array($state) || !isset($state['n'])) $state = array('n' => 0);
    $state['n']++;
    set_transient($bucket, $state, DEHELED_UM_RATE_WINDOW);
    return $state['n'] <= DEHELED_UM_RATE_MAX;
}

/* -------------------------------------------------------------------------
 * The permission callback
 * ---------------------------------------------------------------------- */

/**
 * Verifies one signed request. Returns true, or a WP_Error that REST turns into
 * the response. Fails closed at every step.
 */
function deheled_um_verify_request($request, $required_scope = null) {
    if (!deheled_um_is_enrolled()) {
        return deheled_um_error('not_enrolled', 403);
    }

    $key_id    = (string) $request->get_header('x-de-key-id');
    $timestamp = (string) $request->get_header('x-de-timestamp');
    $nonce     = (string) $request->get_header('x-de-nonce');
    $signature = (string) $request->get_header('x-de-signature');
    $idem      = (string) $request->get_header('idempotency-key');

    if ($key_id === '' || $timestamp === '' || $nonce === '' || $signature === '') {
        return deheled_um_error('missing_signature', 401);
    }
    // Bounded so a huge header can't be used to burn memory or fill the options
    // table through the nonce store.
    if (strlen($nonce) > 128 || strlen($key_id) > 128 || strlen($idem) > 200 || strlen($signature) > 200) {
        return deheled_um_error('malformed', 401);
    }

    $expected_key = (string) get_option(DEHELED_UM_KEY_ID, '');
    if (!hash_equals($expected_key, $key_id)) {
        return deheled_um_error('unauthorized', 403);
    }

    if (!preg_match('/^-?\d{1,12}$/', $timestamp)) {
        return deheled_um_error('malformed', 401);
    }
    if (abs(time() - (int) $timestamp) > DEHELED_UM_MAX_SKEW) {
        return deheled_um_error('stale_request', 401);
    }

    // Rate limiting is checked before the (cheap, but not free) HMAC so a flood
    // of unsigned junk can't force constant hashing.
    if (!deheled_um_rate_ok($key_id)) {
        return deheled_um_error('rate_limited', 429, 'Too many requests');
    }

    $parts = explode(' ', $signature, 2);
    if (count($parts) !== 2 || !hash_equals(DEHELED_UM_SIG_VERSION, $parts[0])) {
        return deheled_um_error('malformed', 401);
    }

    $secret = (string) get_option(DEHELED_UM_SECRET, '');
    $canonical = deheled_um_canonical_string(
        $request->get_method(),
        $request->get_route(),
        $request->get_query_params(),
        $timestamp,
        $nonce,
        $idem,
        deheled_um_raw_body($request)
    );
    $expected = base64_encode(hash_hmac('sha256', $canonical, $secret, true));

    if (!hash_equals($expected, $parts[1])) {
        return deheled_um_error('unauthorized', 403);
    }

    // Only after the signature verifies — an attacker must not be able to burn
    // nonces (or fill the options table) with unsigned requests.
    if (!deheled_um_claim_nonce($nonce)) {
        return deheled_um_error('replay', 401);
    }

    if ($required_scope !== null && !in_array($required_scope, deheled_um_scopes(), true)) {
        return deheled_um_error('scope_denied', 403);
    }

    return true;
}

/**
 * The body exactly as it arrived. get_body() is used rather than the parsed
 * parameters because the signature is over the bytes on the wire — re-encoding
 * parsed JSON would not reproduce them.
 */
function deheled_um_raw_body($request) {
    $body = $request->get_body();
    return is_string($body) ? $body : '';
}

/** Builds a permission_callback that requires a given scope. */
function deheled_um_permission($scope) {
    return function ($request) use ($scope) {
        return deheled_um_verify_request($request, $scope);
    };
}

/* -------------------------------------------------------------------------
 * Idempotency
 * ---------------------------------------------------------------------- */

/**
 * Replays the stored result for an idempotency key, if we have one.
 *
 * Retries are expected — a bulk run across many sites will hit timeouts — and a
 * retry must never apply a change twice. The first response for a key is stored
 * and returned verbatim on every repeat, with a header so the dashboard can
 * show "already applied" rather than counting it again.
 */
function deheled_um_idempotent_replay($key) {
    if ($key === '') return null;
    $stored = get_option(deheled_um_idem_option($key), null);
    if (!is_array($stored) || !isset($stored['body'])) return null;
    $response = rest_ensure_response($stored['body']);
    $response->set_status(isset($stored['status']) ? (int) $stored['status'] : 200);
    $response->header('X-DE-Idempotent-Replay', '1');
    return $response;
}

function deheled_um_idempotent_store($key, $body, $status = 200) {
    if ($key === '') return;
    $name = deheled_um_idem_option($key);
    $value = array('body' => $body, 'status' => $status, 'at' => time());
    if (!add_option($name, $value, '', 'no')) update_option($name, $value, 'no');
    deheled_um_sweep_idempotency();
}

function deheled_um_idem_option($key) {
    return 'deheled_um_i_' . hash('sha256', (string) $key);
}

/** Idempotency records are kept for a day, then swept like the nonces. */
function deheled_um_sweep_idempotency() {
    if (wp_rand(1, 50) !== 1) return;
    global $wpdb;
    $names = $wpdb->get_col($wpdb->prepare(
        "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s LIMIT 200",
        $wpdb->esc_like('deheled_um_i_') . '%'
    ));
    foreach ((array) $names as $name) {
        $row = get_option($name, null);
        if (!is_array($row) || !isset($row['at']) || (time() - (int) $row['at']) > DAY_IN_SECONDS) {
            delete_option($name);
        }
    }
}

/* -------------------------------------------------------------------------
 * Enrollment — the site asks the dashboard for its credential
 * ---------------------------------------------------------------------- */

/**
 * Redeems a one-time enrollment code with the dashboard and stores the returned
 * credential.
 *
 * The site initiates this, over TLS, presenting both the code an administrator
 * pasted in and its own license key. The dashboard never pushes a credential to
 * a site, so user management cannot be switched on remotely — it always takes a
 * deliberate action by someone with access to this site's admin.
 */
function deheled_um_enroll($code) {
    $code = strtoupper(trim((string) $code));
    if ($code === '') {
        return new WP_Error('deheled_um_no_code', 'Enter the enrollment code from the Digital Elements dashboard.');
    }
    $license = (string) get_option(DEHELED_LICENSE_OPTION, '');
    if ($license === '') {
        return new WP_Error('deheled_um_no_license', 'Add this site\'s monitoring license key first.');
    }

    $res = wp_remote_post(DEHELED_HUB_URL . '/api/plugin/enroll', array(
        'timeout' => 15,
        'headers' => array('Content-Type' => 'application/json', 'Accept' => 'application/json'),
        'body'    => wp_json_encode(array(
            'code'        => $code,
            'license_key' => $license,
            'site_url'    => home_url('/'),
            'plugin_version' => DEHELED_VERSION,
            'api_version' => DEHELED_UM_API_VERSION,
        )),
    ));

    if (is_wp_error($res)) {
        return new WP_Error('deheled_um_unreachable', 'Could not reach the Digital Elements dashboard. Check this site can make outbound requests.');
    }
    $code_status = wp_remote_retrieve_response_code($res);
    $body = json_decode(wp_remote_retrieve_body($res), true);

    if ($code_status !== 200 || !is_array($body) || empty($body['ok'])) {
        $reason = is_array($body) && isset($body['error']) ? (string) $body['error'] : 'The code was not accepted.';
        return new WP_Error('deheled_um_rejected', $reason);
    }
    if (empty($body['key_id']) || empty($body['secret'])) {
        return new WP_Error('deheled_um_rejected', 'The dashboard did not return a usable credential.');
    }

    $scopes = isset($body['scopes']) && is_array($body['scopes'])
        ? array_values(array_intersect($body['scopes'], deheled_um_default_scopes()))
        : deheled_um_default_scopes();

    // autoload 'no': the secret must never be loaded into memory on front-end
    // page views, only on the requests that actually need it.
    update_option(DEHELED_UM_KEY_ID, (string) $body['key_id'], 'no');
    update_option(DEHELED_UM_SECRET, (string) $body['secret'], 'no');
    update_option(DEHELED_UM_SCOPES, $scopes, 'no');
    update_option(DEHELED_UM_ENROLLED, time(), 'no');

    return true;
}

/** Local opt-out. The dashboard's credential stops working immediately. */
function deheled_um_disconnect() {
    delete_option(DEHELED_UM_KEY_ID);
    delete_option(DEHELED_UM_SECRET);
    delete_option(DEHELED_UM_SCOPES);
    delete_option(DEHELED_UM_ENROLLED);
}
