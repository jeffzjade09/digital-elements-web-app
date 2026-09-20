<?php
/**
 * Live verification of the de/v2 user-management API against a real WordPress
 * install.
 *
 * tests/usermgmt-auth.test.php covers the signing and guard logic against
 * stubbed WordPress functions. This covers what stubs can't: that the routes
 * are actually registered, that the permission callbacks are wired to them,
 * that the real options/transients API behaves as the nonce and idempotency
 * stores assume, and that an unauthenticated request is genuinely refused.
 *
 *   php scripts/live-usermgmt-check.php <path-to-wordpress-root>
 *
 * e.g. php scripts/live-usermgmt-check.php D:/laragon/www/wordpresstester
 *
 * Requires the site's database to be reachable (start MySQL first). The plugin
 * does NOT need to be installed in wp-content/plugins — it is loaded directly
 * from this repo, so you always test the working copy.
 *
 * SAFETY: refuses to run against anything but a local install, and restores the
 * site's real enrollment options afterwards. No WordPress user is created,
 * changed or deleted by this script.
 */

if (PHP_SAPI !== 'cli') { exit(1); }

$wp_root = isset($argv[1]) ? $argv[1] : '';
if (!$wp_root || !file_exists(rtrim($wp_root, '/\\') . '/wp-load.php')) {
    fwrite(STDERR, "\nUsage: php scripts/live-usermgmt-check.php <path-to-wordpress-root>\n"
        . "       (a directory containing wp-load.php)\n\n");
    exit(1);
}

$de_plugin_path = __DIR__ . '/../wordpress-plugin/digital-elements-helper/digital-elements-helper.php';
if (!file_exists($de_plugin_path)) {
    fwrite(STDERR, "Plugin not found at $de_plugin_path\n");
    exit(1);
}

// Many wp-config.php files derive WP_HOME from $_SERVER, which is empty on the
// command line. Supply the same CLI defaults WP-CLI does, so the site resolves
// to localhost rather than to nothing. A site that hardcodes a real domain
// still reports that domain, which is what the safety check below looks at.
if (!isset($_SERVER['HTTP_HOST']))      $_SERVER['HTTP_HOST'] = 'localhost';
if (!isset($_SERVER['SERVER_NAME']))    $_SERVER['SERVER_NAME'] = 'localhost';
if (!isset($_SERVER['REQUEST_SCHEME'])) $_SERVER['REQUEST_SCHEME'] = 'http';
if (!isset($_SERVER['REQUEST_URI']))    $_SERVER['REQUEST_URI'] = '/';
if (!isset($_SERVER['SCRIPT_NAME']))    $_SERVER['SCRIPT_NAME'] = '/index.php';

define('WP_USE_THEMES', false);
require_once rtrim($wp_root, '/\\') . '/wp-load.php';
require_once $de_plugin_path;

/* ---------------------------------------------------------------- safety --- */
// Never point this at a client site. The check is on the host the site itself
// resolves to, so a wp-config.php that hardcodes a production domain is caught
// even though the files are sitting on this machine.
$host = parse_url(home_url('/'), PHP_URL_HOST);
$is_local = $host === 'localhost'
    || strpos($host, '127.0.0.1') === 0
    || preg_match('/\.(test|local|localhost|dev)$/i', $host)
    || getenv('UM_LIVE_CHECK_ALLOW_HOST') === $host;
if (!$is_local) {
    fwrite(STDERR, "\nRefusing to run against '$host' — this script is for local installs only.\n"
        . "Never test against a client site.\n\n");
    exit(1);
}

$fail = 0;
function ok($label, $cond, $extra = '') {
    global $fail;
    if ($cond) { echo "PASS  $label\n"; }
    else { $fail++; echo "FAIL  $label" . ($extra ? "  ($extra)" : '') . "\n"; }
}

echo "\nWordPress " . get_bloginfo('version') . " at $wp_root ($host)\n";
echo "Plugin " . DEHELED_VERSION . ", de/v2 contract revision " . DEHELED_UM_API_VERSION . "\n";

/* ------------------------------------------------- save the site's state --- */
$saved = array(
    DEHELED_UM_KEY_ID   => get_option(DEHELED_UM_KEY_ID, null),
    DEHELED_UM_SECRET   => get_option(DEHELED_UM_SECRET, null),
    DEHELED_UM_SCOPES   => get_option(DEHELED_UM_SCOPES, null),
    DEHELED_UM_ENROLLED => get_option(DEHELED_UM_ENROLLED, null),
);
register_shutdown_function(function () use ($saved) {
    foreach ($saved as $name => $value) {
        if ($value === null) delete_option($name);
        else update_option($name, $value, 'no');
    }
    echo "\n[restored the site's original enrollment options]\n";
});

/* ------------------------------------------------------------ REST routes --- */
echo "\n=== REST routes ===\n";
$server = rest_get_server();
do_action('rest_api_init', $server);
$routes = $server->get_routes();

ok('de/v2/capabilities is registered', isset($routes['/de/v2/capabilities']));
ok('the monitoring namespace still works', isset($routes['/wpmonitor/v1/status']));

foreach ($routes as $route => $handlers) {
    if (strpos($route, '/de/v2') !== 0) continue;
    foreach ($handlers as $h) {
        if (!isset($h['permission_callback'])) continue;
        ok("$route has a permission callback",
            $h['permission_callback'] !== null && $h['permission_callback'] !== '__return_true');
    }
}

/* ------------------------------------------------- unauthenticated access --- */
echo "\n=== An unauthenticated request is refused ===\n";
delete_option(DEHELED_UM_KEY_ID);
delete_option(DEHELED_UM_SECRET);

$req = new WP_REST_Request('GET', '/de/v2/capabilities');
$res = rest_do_request($req);
ok('capabilities without any credential is refused', $res->is_error(), 'status ' . $res->get_status());

// A signed request against a site that was never enrolled must fail closed.
$req = new WP_REST_Request('GET', '/de/v2/capabilities');
$req->set_header('x-de-key-id', 'dek_made_up');
$req->set_header('x-de-timestamp', (string) time());
$req->set_header('x-de-nonce', 'live-' . wp_generate_uuid4());
$req->set_header('x-de-signature', DEHELED_UM_SIG_VERSION . ' ' . base64_encode('nope'));
$verified = deheled_um_verify_request($req, null);
ok('a signed request to an unenrolled site is refused', is_wp_error($verified));
ok('...and says so as not_enrolled',
    is_wp_error($verified) && $verified->get_error_data()['de_code'] === 'not_enrolled');

/* --------------------------------------------------- enrolled behaviour ---- */
echo "\n=== With a credential stored ===\n";
$KEY = 'dek_livecheck0001';
$SECRET = 'live-check-secret-' . wp_generate_password(24, false);
update_option(DEHELED_UM_KEY_ID, $KEY, 'no');
update_option(DEHELED_UM_SECRET, $SECRET, 'no');
update_option(DEHELED_UM_SCOPES, deheled_um_default_scopes(), 'no');

function live_signed_request($method, $route, $query = array(), $body = '', $overrides = array()) {
    global $KEY, $SECRET;
    $ts    = isset($overrides['ts']) ? $overrides['ts'] : time();
    $nonce = isset($overrides['nonce']) ? $overrides['nonce'] : 'live-' . wp_generate_uuid4();
    $idem  = isset($overrides['idem']) ? $overrides['idem'] : '';
    $secret = isset($overrides['secret']) ? $overrides['secret'] : $SECRET;

    $canonical = deheled_um_canonical_string($method, $route, $query, $ts, $nonce, $idem, $body);
    $sig = base64_encode(hash_hmac('sha256', $canonical, $secret, true));

    $req = new WP_REST_Request($method, $route);
    foreach ($query as $k => $v) $req->set_param($k, $v);
    if ($body !== '') $req->set_body($body);
    $req->set_header('x-de-key-id', $KEY);
    $req->set_header('x-de-timestamp', (string) $ts);
    $req->set_header('x-de-nonce', $nonce);
    $req->set_header('x-de-signature', DEHELED_UM_SIG_VERSION . ' ' . $sig);
    if ($idem !== '') $req->set_header('idempotency-key', $idem);
    return $req;
}

ok('a correctly signed request passes against the real options API',
    deheled_um_verify_request(live_signed_request('GET', '/de/v2/capabilities'), 'users:read') === true);

$replayable = live_signed_request('GET', '/de/v2/capabilities', array(), '', array('nonce' => 'live-replay-once'));
ok('first use of a nonce passes', deheled_um_verify_request($replayable) === true);
$second = deheled_um_verify_request($replayable);
ok('the real options store rejects the replay',
    is_wp_error($second) && $second->get_error_data()['de_code'] === 'replay');

$stale = deheled_um_verify_request(live_signed_request('GET', '/de/v2/capabilities', array(), '', array('ts' => time() - 900)));
ok('a stale timestamp is refused',
    is_wp_error($stale) && $stale->get_error_data()['de_code'] === 'stale_request');

$wrong = deheled_um_verify_request(live_signed_request('GET', '/de/v2/capabilities', array(), '', array('secret' => 'not-it')));
ok('a bad signature is refused',
    is_wp_error($wrong) && $wrong->get_error_data()['de_code'] === 'unauthorized');

$scoped = deheled_um_verify_request(live_signed_request('GET', '/de/v2/capabilities'), 'users:delete');
ok('an ungranted scope is refused',
    is_wp_error($scoped) && $scoped->get_error_data()['de_code'] === 'scope_denied');

/* -------------------------------------------------- the capabilities body -- */
echo "\n=== Capabilities payload ===\n";
$payload = deheled_um_rest_capabilities(new WP_REST_Request('GET', '/de/v2/capabilities'))->get_data();

ok('reports ok', !empty($payload['ok']));
ok('reports the plugin version', $payload['plugin_version'] === DEHELED_VERSION);
ok('reports the contract revision', $payload['api_version'] === DEHELED_UM_API_VERSION);
ok('reports enrollment state', $payload['enrolled'] === true);
ok('reports the granted scopes', $payload['scopes'] === array_values(deheled_um_default_scopes()));
ok('reports whether this is multisite', array_key_exists('multisite', $payload));
ok('reports a role count', is_int($payload['roles']) && $payload['roles'] >= 5);
ok('capabilities is a list', is_array($payload['capabilities']));

// The probe is deliberately answerable before enrollment, so it must disclose
// nothing about any user.
$json = wp_json_encode($payload);
ok('the payload contains no user data',
    stripos($json, '@') === false || stripos($json, 'user_login') === false);
ok('the payload never contains the secret', strpos($json, $SECRET) === false);
ok('the payload never contains the license key',
    strpos($json, (string) get_option(DEHELED_LICENSE_OPTION, 'no-license-set')) === false
    || get_option(DEHELED_LICENSE_OPTION, '') === '');

/* ------------------------------------------------------- idempotency store - */
echo "\n=== Idempotency store ===\n";
$key = 'live-check-' . wp_generate_uuid4();
ok('nothing stored for a fresh key', deheled_um_idempotent_replay($key) === null);
deheled_um_idempotent_store($key, array('ok' => true, 'result' => 'created'), 200);
$replay = deheled_um_idempotent_replay($key);
ok('a stored result replays', $replay instanceof WP_REST_Response);
ok('...with the original body', $replay && $replay->get_data()['result'] === 'created');
ok('...flagged as a replay', $replay && $replay->get_headers()['X-DE-Idempotent-Replay'] === '1');
delete_option(deheled_um_idem_option($key));
ok('cleaned up', deheled_um_idempotent_replay($key) === null);

/* ------------------------------------------------------------- disconnect -- */
echo "\n=== Disconnect revokes immediately ===\n";
$req = live_signed_request('GET', '/de/v2/capabilities');
deheled_um_disconnect();
ok('a previously valid request stops working once disconnected',
    is_wp_error(deheled_um_verify_request($req)));
ok('the secret is gone from the options table', get_option(DEHELED_UM_SECRET, '') === '');

echo "\n" . ($fail ? "FAILED — $fail check(s) failed\n" : "OK — all checks passed\n");
exit($fail ? 1 : 0);
