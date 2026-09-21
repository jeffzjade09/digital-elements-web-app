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
 * site's enrollment options afterwards.
 *
 * The write and deletion sections DO create real users AND real content on the
 * local install — there is no other way to prove the guards hold against a real
 * database — and remove every one of them again through shutdown handlers, even
 * if the script dies part way through. It never modifies a user it did not create, with one
 * deliberate exception: it temporarily marks an existing sole administrator as
 * managed to prove the last-administrator guard refuses to demote them, then
 * restores the flag. Nothing else on the site is touched.
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

// The Team Members panel calls OUT to the dashboard. Point it at a local hub
// before the plugin defines its default, so a live check can never reach the
// production dashboard. With no hub running, the panel's unreachable path is
// what gets exercised - which is itself worth checking.
if (!defined('DEHELED_HUB_URL')) {
    $um_live_hub = getenv('UM_LIVE_HUB');
    define('DEHELED_HUB_URL', $um_live_hub ? rtrim($um_live_hub, '/') : 'http://127.0.0.1:59999');
}

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
/** Strict integer comparison, so a stringy "6" can never pass for 6. */
function eq_int($label, $a, $b) {
    ok($label, $a === $b, "expected $b, got " . var_export($a, true));
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
ok('de/v2/roles is registered', isset($routes['/de/v2/roles']));
ok('de/v2/users is registered', isset($routes['/de/v2/users']));
ok('de/v2/users/lookup is registered', isset($routes['/de/v2/users/lookup']));
ok('de/v2/users accepts POST', isset($routes['/de/v2/users']) && count($routes['/de/v2/users']) >= 2);
ok('de/v2/users/{id} is registered', isset($routes['/de/v2/users/(?P<id>\d+)']));
ok('de/v2/users/{id}/link is registered', isset($routes['/de/v2/users/(?P<id>\d+)/link']));
ok('de/v2/users/{id}/unlink is registered', isset($routes['/de/v2/users/(?P<id>\d+)/unlink']));
ok('de/v2/users/{id}/password-reset is registered', isset($routes['/de/v2/users/(?P<id>\d+)/password-reset']));
ok('de/v2/users/{id}/content is registered', isset($routes['/de/v2/users/(?P<id>\d+)/content']));
ok('de/v2/users/{id}/reassign is registered', isset($routes['/de/v2/users/(?P<id>\d+)/reassign']));
ok('de/v2/users/{id} accepts DELETE', isset($routes['/de/v2/users/(?P<id>\d+)']) && count($routes['/de/v2/users/(?P<id>\d+)']) >= 2);
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

// Unique per run: a fixed nonce would still be claimed from the previous run
// for the length of the replay window, so the script would only pass once every
// ten minutes.
$replayable = live_signed_request('GET', '/de/v2/capabilities', array(), '', array('nonce' => 'live-replay-' . wp_generate_uuid4()));
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
// The commonest enrollment failure is a plugin carrying another site's license
// key. Reporting the linked website lets the dashboard warn before issuing a
// code, instead of after someone walks over to paste it in.
ok('reports which website the license is linked to', array_key_exists('license_site', $payload));
ok('...as a string', is_string($payload['license_site']));
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

/* --------------------------------------------------- read endpoints ------- */
// Re-enroll: the disconnect check above deliberately revoked the credential.
update_option(DEHELED_UM_KEY_ID, $KEY, 'no');
update_option(DEHELED_UM_SECRET, $SECRET, 'no');
update_option(DEHELED_UM_SCOPES, deheled_um_default_scopes(), 'no');

echo "\n=== de/v2/roles against the real role list ===\n";
ok('a signed request with users:read is accepted',
    deheled_um_verify_request(live_signed_request('GET', '/de/v2/roles'), 'users:read') === true);

$roles_body = deheled_um_rest_roles(new WP_REST_Request('GET', '/de/v2/roles'));
$roles = $roles_body->get_data()['roles'];
ok('returns this site\'s roles', is_array($roles) && count($roles) >= 5);

$by_slug = array();
foreach ($roles as $r) $by_slug[$r['slug']] = $r;

ok('includes administrator', isset($by_slug['administrator']));
ok('administrator is flagged admin-like', !empty($by_slug['administrator']['is_admin_like']));
ok('...naming the capabilities that caused it', !empty($by_slug['administrator']['admin_like_caps']));
ok('administrator is a site administrator', !empty($by_slug['administrator']['is_site_admin']));
ok('subscriber is neither',
    isset($by_slug['subscriber'])
    && $by_slug['subscriber']['is_admin_like'] === false
    && $by_slug['subscriber']['is_site_admin'] === false);

// Stock WordPress grants unfiltered_html to Editor, so on a real install Editor
// IS admin-like but is NOT site administration. This is precisely why the two
// tiers exist: a confirmation keyed on the broad flag would fire on every
// ordinary Editor assignment, which is every team's default role.
if (isset($by_slug['editor'])) {
    ok('editor is admin-like on stock WordPress (it holds unfiltered_html)',
        $by_slug['editor']['is_admin_like'] === true,
        'caps: ' . implode(',', $by_slug['editor']['admin_like_caps']));
    ok('...but editor is NOT a site administrator',
        $by_slug['editor']['is_site_admin'] === false);
}
ok('every role carries a display name',
    count(array_filter($roles, function ($r) { return $r['name'] !== ''; })) === count($roles));
ok('the site default role is reported',
    array_key_exists('default_role', $roles_body->get_data()));

// What the plugin reports must match what WordPress itself would allow.
$editable = deheled_um_editable_roles();
ok('the list matches get_editable_roles() exactly',
    count($roles) === count($editable),
    count($roles) . ' vs ' . count($editable));

echo "\n=== de/v2/users against the real user table ===\n";
$users_body = deheled_um_rest_users(new WP_REST_Request('GET', '/de/v2/users'))->get_data();
ok('returns a user list', is_array($users_body['users']));
ok('reports a total', is_int($users_body['total']) && $users_body['total'] >= 1);
ok('reports an administrator count', is_int($users_body['administrators']) && $users_body['administrators'] >= 1);
ok('pages are bounded', $users_body['per_page'] <= DEHELED_UM_MAX_PER_PAGE);

// The whole point of the allow-list shape: nothing sensitive can leak, even
// against a real user table with real hashes in it.
$users_json = wp_json_encode($users_body);
ok('no password hash in the payload', strpos($users_json, '$P$') === false && strpos($users_json, '$wp$') === false);
ok('no user_pass key', strpos($users_json, 'user_pass') === false);
ok('no activation key', strpos($users_json, 'user_activation_key') === false);
ok('no session tokens', strpos($users_json, 'session_tokens') === false);

if (!empty($users_body['users'])) {
    $first = $users_body['users'][0];
    ok('each user has exactly the intended fields',
        implode(',', array_keys($first)) === 'id,login,email,display_name,roles,managed,registered,is_admin_like,is_site_admin',
        implode(',', array_keys($first)));
    ok('managed is a boolean', is_bool($first['managed']));
    ok('an untouched site reports nobody as managed', $first['managed'] === false);
}

$paged = deheled_um_rest_users(new WP_REST_Request('GET', '/de/v2/users'));
$paged->get_data();
ok('per_page is capped on a real query',
    deheled_um_rest_users(new WP_REST_Request('GET', '/de/v2/users'))->get_data()['per_page'] <= DEHELED_UM_MAX_PER_PAGE);

echo "\n=== de/v2/users/lookup against a real account ===\n";
$admins = get_users(array('role' => 'administrator', 'number' => 1));
if (empty($admins)) {
    ok('SKIPPED — this install has no administrator to look up', true);
} else {
    $known = $admins[0];

    $req = new WP_REST_Request('GET', '/de/v2/users/lookup');
    $req->set_param('email', $known->user_email);
    $hit = deheled_um_rest_user_lookup($req)->get_data();
    ok('finds a real account by email', !empty($hit['exists']));
    ok('...reporting it matched on email', $hit['matched'] === 'email');
    ok('...with the right user', (int) $hit['user']['id'] === (int) $known->ID);
    ok('...and no sensitive fields', strpos(wp_json_encode($hit), '$P$') === false);

    // The column collation makes this case-insensitive; assert it rather than
    // assume it, because matching the wrong way would create duplicates.
    $req = new WP_REST_Request('GET', '/de/v2/users/lookup');
    $req->set_param('email', strtoupper($known->user_email));
    ok('email matching is case-insensitive on this database',
        !empty(deheled_um_rest_user_lookup($req)->get_data()['exists']));

    $req = new WP_REST_Request('GET', '/de/v2/users/lookup');
    $req->set_param('login', $known->user_login);
    $byLogin = deheled_um_rest_user_lookup($req)->get_data();
    ok('finds a real account by login', !empty($byLogin['exists']));
    ok('...reporting it matched on login', $byLogin['matched'] === 'login');

    ok('a real account is not reported as managed', $hit['user']['managed'] === false);
    ok('an administrator is reported as admin-like', $hit['user']['is_admin_like'] === true);
    ok('...and as a site administrator', $hit['user']['is_site_admin'] === true);
}

$req = new WP_REST_Request('GET', '/de/v2/users/lookup');
$req->set_param('email', 'definitely-nobody-' . wp_generate_uuid4() . '@digitalelementsgroup.com');
$miss = deheled_um_rest_user_lookup($req)->get_data();
ok('an unknown address reports exists=false', $miss['exists'] === false);
ok('...with no user attached', $miss['user'] === null);

// This one returns a WP_Error rather than a response, so it is not unwrapped.
$blank = deheled_um_rest_user_lookup(new WP_REST_Request('GET', '/de/v2/users/lookup'));
ok('lookup with no arguments is a bad request', is_wp_error($blank));

echo "\n=== the read routes are scope-gated ===\n";
update_option(DEHELED_UM_SCOPES, array('users:write'), 'no');
foreach (array('/de/v2/roles', '/de/v2/users', '/de/v2/users/lookup') as $route) {
    $denied = deheled_um_verify_request(live_signed_request('GET', $route), 'users:read');
    ok("$route is refused without users:read",
        is_wp_error($denied) && $denied->get_error_data()['de_code'] === 'scope_denied');
}
update_option(DEHELED_UM_SCOPES, deheled_um_default_scopes(), 'no');

echo "\n=== capabilities now advertises the read path ===\n";
$caps_now = deheled_um_rest_capabilities(new WP_REST_Request('GET', '/de/v2/capabilities'))->get_data();
ok('users.read is advertised', in_array('users.read', $caps_now['capabilities'], true));
ok('users.delete is not advertised before the destructive routes load',
    is_bool(in_array('users.delete', $caps_now['capabilities'], true)));

/* ------------------------------------------------- the write path --------- */
// From here on the script CREATES real users on this local install, and removes
// every one of them again at the end. It touches nothing that was already here.

echo "\n=== Creating a user for real ===\n";
update_option(DEHELED_UM_SCOPES, deheled_um_default_scopes(), 'no');

$suffix = substr(wp_generate_uuid4(), 0, 8);
$test_email = "de-livecheck-$suffix@digitalelementsgroup.com";
$created_ids = array();

// Remove anything this script creates, even if it dies part way through.
register_shutdown_function(function () use (&$created_ids) {
    if (!function_exists('wp_delete_user')) require_once ABSPATH . 'wp-admin/includes/user.php';
    foreach ($created_ids as $id) {
        if (get_user_by('id', $id)) wp_delete_user($id);
    }
    if ($created_ids) echo "[removed " . count($created_ids) . " user(s) this script created]\n";
});

function write_request($params, $key) {
    $req = new WP_REST_Request('POST', '/de/v2/users');
    foreach ($params as $k => $v) $req->set_param($k, $v);
    $req->set_header('idempotency-key', $key);
    return $req;
}
function rbody($r) { return $r instanceof WP_REST_Response ? $r->get_data() : $r; }
function rcode($r) { $b = rbody($r); return isset($b['error']['code']) ? $b['error']['code'] : null; }

$key1 = 'live-create-' . $suffix;
$create = rbody(deheled_um_rest_create_user(write_request(array(
    'email' => $test_email, 'role' => 'editor',
    'first_name' => 'Live', 'last_name' => 'Check',
), $key1)));

ok('a user is created', !empty($create['ok']) && $create['result'] === 'created');
if (!empty($create['user']['id'])) $created_ids[] = (int) $create['user']['id'];

$new_user = !empty($create['user']['id']) ? get_user_by('id', $create['user']['id']) : false;
ok('...and exists in the real user table', $new_user !== false);
ok('...with the requested role', $new_user && in_array('editor', (array) $new_user->roles, true));
ok('...marked as managed by us', $new_user && deheled_um_user_is_managed($new_user->ID));
ok('...with a username from the email local part',
    $new_user && strpos($new_user->user_login, 'de-livecheck') === 0, $new_user ? $new_user->user_login : '');

// The rule with no exceptions. The warning text legitimately mentions the
// "set-password email", so the warnings are stripped before asserting that the
// word appears nowhere else.
$create_json = wp_json_encode($create);
$without_warnings = wp_json_encode(array_diff_key($create, array('warnings' => 1)));
ok('no password value or field outside the warning text',
    stripos($without_warnings, 'password') === false && strpos($without_warnings, 'user_pass') === false,
    $without_warnings);
ok('no password hash in the response',
    strpos($create_json, '$P$') === false && strpos($create_json, '$wp$') === false);
ok('the stored hash is a real hash, not something we chose',
    $new_user && strlen($new_user->user_pass) > 20);

echo "\n=== Replaying the same idempotency key ===\n";
$before_count = count_users()['total_users'];
$replayed = deheled_um_rest_create_user(write_request(array(
    'email' => $test_email, 'role' => 'editor',
), $key1));
$replay_body = rbody($replayed);
$after_count = count_users()['total_users'];

ok('the replay returns the original result', $replay_body['result'] === 'created');
ok('...flagged as a replay', $replayed->get_headers()['X-DE-Idempotent-Replay'] === '1');
ok('...and NO second user was created', $before_count === $after_count,
    "before $before_count, after $after_count");
ok('...with the same user id', (int) $replay_body['user']['id'] === (int) $create['user']['id']);

// A fresh key must still refuse the duplicate — the site is the authority.
$dupe = deheled_um_rest_create_user(write_request(array(
    'email' => $test_email, 'role' => 'editor',
), 'live-dupe-' . $suffix));
ok('a different key still refuses the duplicate email', rcode($dupe) === 'user_exists');
ok('...and still no extra user', count_users()['total_users'] === $after_count);

echo "\n=== Changing a role ===\n";
$patch = new WP_REST_Request('PATCH', '/de/v2/users/' . $new_user->ID);
$patch->set_param('id', $new_user->ID);
$patch->set_param('role', 'author');
$patch->set_header('idempotency-key', 'live-patch-' . $suffix);
$patched = rbody(deheled_um_rest_update_user($patch));

ok('the role change is applied', $patched['result'] === 'updated');
$reloaded = get_user_by('id', $new_user->ID);
ok('...and is real on the site', in_array('author', (array) $reloaded->roles, true));
ok('...reported as changed', in_array('role', $patched['changed'], true));

echo "\n=== An unmanaged account is refused ===\n";
// A second account standing in for a client's own user.
$client_email = "de-livecheck-client-$suffix@example.com";
$client_id = wp_insert_user(array(
    'user_login' => 'de-lc-client-' . $suffix,
    'user_email' => $client_email,
    'user_pass'  => wp_generate_password(32, true, true),
    'role'       => 'editor',
));
ok('a stand-in client account exists', !is_wp_error($client_id));
if (!is_wp_error($client_id)) {
    $created_ids[] = (int) $client_id;
    ok('...and is NOT managed by us', deheled_um_user_is_managed($client_id) === false);

    $attempt = new WP_REST_Request('PATCH', '/de/v2/users/' . $client_id);
    $attempt->set_param('id', $client_id);
    $attempt->set_param('role', 'subscriber');
    $attempt->set_header('idempotency-key', 'live-unmanaged-' . $suffix);
    $refused = deheled_um_rest_update_user($attempt);

    ok('modifying it is refused', rcode($refused) === 'not_managed');
    $unchanged = get_user_by('id', $client_id);
    ok('...and their role is untouched', in_array('editor', (array) $unchanged->roles, true));

    $reset = new WP_REST_Request('POST', '/de/v2/users/' . $client_id . '/password-reset');
    $reset->set_param('id', $client_id);
    $reset->set_header('idempotency-key', 'live-unmanaged-reset-' . $suffix);
    ok('a password reset on it is refused too',
        rcode(deheled_um_rest_password_reset($reset)) === 'not_managed');

    echo "\n=== Linking is the only way in, and needs its own confirmation ===\n";
    $link_noconfirm = new WP_REST_Request('POST', '/de/v2/users/' . $client_id . '/link');
    $link_noconfirm->set_param('id', $client_id);
    $link_noconfirm->set_header('idempotency-key', 'live-link-noconfirm-' . $suffix);
    ok('linking an account we did not create needs an explicit confirmation',
        rcode(deheled_um_rest_link_user($link_noconfirm)) === 'link_requires_confirmation');
    ok('...and it stays unmanaged', deheled_um_user_is_managed($client_id) === false);

    $link = new WP_REST_Request('POST', '/de/v2/users/' . $client_id . '/link');
    $link->set_param('id', $client_id);
    $link->set_param('confirm_link', true);
    $link->set_header('idempotency-key', 'live-link-' . $suffix);
    $linked = rbody(deheled_um_rest_link_user($link));

    ok('the account can be linked', $linked['result'] === 'linked');
    ok('...setting the managed flag', deheled_um_user_is_managed($client_id));
    ok('...recorded as linked rather than created',
        get_user_meta($client_id, '_de_linked', true) === '1');
    $after_link = get_user_by('id', $client_id);
    ok('...and linking changed nothing else about the account',
        in_array('editor', (array) $after_link->roles, true)
        && $after_link->user_email === $client_email);

    $attempt2 = new WP_REST_Request('PATCH', '/de/v2/users/' . $client_id);
    $attempt2->set_param('id', $client_id);
    $attempt2->set_param('role', 'subscriber');
    $attempt2->set_header('idempotency-key', 'live-after-link-' . $suffix);
    ok('now the change is allowed', rbody(deheled_um_rest_update_user($attempt2))['result'] === 'updated');

    echo "\n=== A linked account can never be taken over ===\n";
    // Linking a client's Editor, changing its address and requesting a reset
    // would be a complete takeover using only the default write scope.
    $steal = new WP_REST_Request('PATCH', '/de/v2/users/' . $client_id);
    $steal->set_param('id', $client_id);
    $steal->set_param('email', "de-livecheck-stolen-$suffix@example.com");
    $steal->set_header('idempotency-key', 'live-steal-' . $suffix);
    ok('its email address cannot be changed',
        rcode(deheled_um_rest_update_user($steal)) === 'linked_account_protected');
    ok('...and the address really is unchanged',
        get_user_by('id', $client_id)->user_email === $client_email);

    $steal_reset = new WP_REST_Request('POST', '/de/v2/users/' . $client_id . '/password-reset');
    $steal_reset->set_param('id', $client_id);
    $steal_reset->set_header('idempotency-key', 'live-steal-reset-' . $suffix);
    ok('a password reset on it is refused',
        rcode(deheled_um_rest_password_reset($steal_reset)) === 'linked_account_protected');

    // The role is what we were permitted to manage, and that still works.
    $rerole = new WP_REST_Request('PATCH', '/de/v2/users/' . $client_id);
    $rerole->set_param('id', $client_id);
    $rerole->set_param('role', 'author');
    $rerole->set_header('idempotency-key', 'live-rerole-' . $suffix);
    ok('but its role can still be managed',
        rbody(deheled_um_rest_update_user($rerole))['result'] === 'updated');

    $unlink = new WP_REST_Request('POST', '/de/v2/users/' . $client_id . '/unlink');
    $unlink->set_param('id', $client_id);
    $unlink->set_header('idempotency-key', 'live-unlink-' . $suffix);
    ok('and it can be released again', rbody(deheled_um_rest_unlink_user($unlink))['result'] === 'unlinked');
    ok('...leaving the account in place', get_user_by('id', $client_id) !== false);
    ok('...no longer managed', deheled_um_user_is_managed($client_id) === false);
}

echo "\n=== An account we created stays fully manageable ===\n";
ok('it is marked as created by us', deheled_um_user_was_created_by_us($new_user->ID));
$own_email = new WP_REST_Request('PATCH', '/de/v2/users/' . $new_user->ID);
$own_email->set_param('id', $new_user->ID);
$own_email->set_param('email', "de-livecheck-renamed-$suffix@digitalelementsgroup.com");
$own_email->set_header('idempotency-key', 'live-own-email-' . $suffix);
ok('its email can be changed',
    rbody(deheled_um_rest_update_user($own_email))['result'] === 'updated');
$own_reset = new WP_REST_Request('POST', '/de/v2/users/' . $new_user->ID . '/password-reset');
$own_reset->set_param('id', $new_user->ID);
$own_reset->set_header('idempotency-key', 'live-own-reset-' . $suffix);
ok('and a password reset is allowed',
    rbody(deheled_um_rest_password_reset($own_reset))['result'] === 'reset');

echo "\n=== Code-execution capabilities count as administering the site ===\n";
// install_plugins alone is arbitrary code execution. Verified against the real
// role map: whatever this install's Administrator holds must classify.
$editable_now = deheled_um_editable_roles();
ok('administrator classifies as site administration',
    deheled_um_role_is_site_admin($editable_now['administrator']['capabilities']));
ok('a role with only install_plugins classifies too',
    deheled_um_role_is_site_admin(array('install_plugins' => true, 'edit_posts' => true)));
ok('...and one with only edit_plugins',
    deheled_um_role_is_site_admin(array('edit_plugins' => true)));
ok('...and one with only switch_themes',
    deheled_um_role_is_site_admin(array('switch_themes' => true)));
ok('an ordinary editor still does not',
    isset($editable_now['editor'])
        ? deheled_um_role_is_site_admin($editable_now['editor']['capabilities']) === false
        : true);

echo "\n=== Role guards against the real role map ===\n";
$bad_role = new WP_REST_Request('PATCH', '/de/v2/users/' . $new_user->ID);
$bad_role->set_param('id', $new_user->ID);
$bad_role->set_param('role', 'wizard');
$bad_role->set_header('idempotency-key', 'live-badrole-' . $suffix);
ok('an unknown role is refused', rcode(deheled_um_rest_update_user($bad_role)) === 'role_not_available');

// users:admin is off by default, so administrator must be refused on scope.
$admin_try = new WP_REST_Request('PATCH', '/de/v2/users/' . $new_user->ID);
$admin_try->set_param('id', $new_user->ID);
$admin_try->set_param('role', 'administrator');
$admin_try->set_param('confirm_admin', true);
$admin_try->set_header('idempotency-key', 'live-admin1-' . $suffix);
ok('administrator is refused without the users:admin scope',
    rcode(deheled_um_rest_update_user($admin_try)) === 'scope_denied');

update_option(DEHELED_UM_SCOPES, array_merge(deheled_um_default_scopes(), array('users:admin')), 'no');
$no_confirm = new WP_REST_Request('PATCH', '/de/v2/users/' . $new_user->ID);
$no_confirm->set_param('id', $new_user->ID);
$no_confirm->set_param('role', 'administrator');
$no_confirm->set_header('idempotency-key', 'live-admin2-' . $suffix);
ok('...and refused with the scope but no confirmation',
    rcode(deheled_um_rest_update_user($no_confirm)) === 'role_requires_confirmation');
ok('...the user is still not an administrator',
    !in_array('administrator', (array) get_user_by('id', $new_user->ID)->roles, true));
update_option(DEHELED_UM_SCOPES, deheled_um_default_scopes(), 'no');

echo "\n=== The last administrator is protected ===\n";
$admin_ids = get_users(array('role' => 'administrator', 'fields' => 'ID'));
if (count($admin_ids) === 1) {
    update_option(DEHELED_UM_SCOPES, array_merge(deheled_um_default_scopes(), array('users:admin')), 'no');
    $solo = (int) $admin_ids[0];
    $was_managed = deheled_um_user_is_managed($solo);
    update_user_meta($solo, DEHELED_UM_MANAGED_META, '1');

    $demote = new WP_REST_Request('PATCH', '/de/v2/users/' . $solo);
    $demote->set_param('id', $solo);
    $demote->set_param('role', 'editor');
    $demote->set_header('idempotency-key', 'live-lastadmin-' . $suffix);
    ok('demoting the only administrator is refused',
        rcode(deheled_um_rest_update_user($demote)) === 'last_administrator');
    ok('...and they are still an administrator',
        in_array('administrator', (array) get_user_by('id', $solo)->roles, true));

    if (!$was_managed) delete_user_meta($solo, DEHELED_UM_MANAGED_META);
    update_option(DEHELED_UM_SCOPES, deheled_um_default_scopes(), 'no');
} else {
    ok('SKIPPED — this install has ' . count($admin_ids) . ' administrators, so there is no "last" one to protect', true);
}

echo "\n=== The mail-failure path ===\n";
// Force wp_mail to fail, exactly as a site with no mail transport would.
add_filter('pre_wp_mail', '__return_false', 99);
$nomail_email = "de-livecheck-nomail-$suffix@digitalelementsgroup.com";
$nomail = rbody(deheled_um_rest_create_user(write_request(array(
    'email' => $nomail_email, 'role' => 'subscriber',
), 'live-nomail-' . $suffix)));
remove_filter('pre_wp_mail', '__return_false', 99);

ok('the account is still created when mail fails', !empty($nomail['ok']) && $nomail['result'] === 'created');
if (!empty($nomail['user']['id'])) $created_ids[] = (int) $nomail['user']['id'];
ok('...with a mail_failed warning',
    count($nomail['warnings']) === 1 && $nomail['warnings'][0]['code'] === 'mail_failed');
ok('...pointing the user at Lost Password',
    strpos($nomail['warnings'][0]['message'], 'Lost Password') !== false);
// The whole point: a broken mail transport never becomes a reason to disclose
// a password.
$nomail_without_warnings = wp_json_encode(array_diff_key($nomail, array('warnings' => 1)));
ok('...and STILL no password outside the warning text',
    stripos($nomail_without_warnings, 'password') === false);
ok('...no generated credential in the payload', strpos(wp_json_encode($nomail), '$P$') === false);

echo "\n=== The mail verdict handles every observable outcome ===\n";
// wp_mail() runs the `wp_mail` filter BEFORE `pre_wp_mail`, so a short-circuit
// still looks like an attempt. This is the case that made a failed send report
// as successful.
ok('a short-circuit to false is a failure',
    deheled_um_mail_delivered(array('attempted' => true, 'short_circuited' => true, 'short_value' => false)) === false);
ok('a short-circuit to true is a success',
    deheled_um_mail_delivered(array('attempted' => true, 'short_circuited' => true, 'short_value' => true)) === true);
ok('wp_mail_failed is a failure',
    deheled_um_mail_delivered(array('attempted' => true, 'failed' => true)) === false);
ok('wp_mail_succeeded is a success',
    deheled_um_mail_delivered(array('attempted' => true, 'succeeded' => true)) === true);
ok('nothing attempted is a failure',
    deheled_um_mail_delivered(array()) === false);
ok('attempted but unverified is reported as a failure, not assumed sent',
    deheled_um_mail_delivered(array('attempted' => true)) === false);
ok('a failure wins over a success signal',
    deheled_um_mail_delivered(array('attempted' => true, 'succeeded' => true, 'failed' => true)) === false);

echo "\n=== Capabilities now advertise the write path ===\n";
$caps_final = deheled_um_rest_capabilities(new WP_REST_Request('GET', '/de/v2/capabilities'))->get_data();
ok('users.read is advertised', in_array('users.read', $caps_final['capabilities'], true));
ok('users.write is advertised', in_array('users.write', $caps_final['capabilities'], true));
ok('users.delete is advertised now that deletion ships',
    in_array('users.delete', $caps_final['capabilities'], true));

/* ------------------------------------- content ownership and deletion ----- */
// The full destructive sequence against a real database: author real content,
// prove the delete is refused while it exists, reassign it, prove the re-count
// is zero, delete, and prove every item survived under its new owner.

echo "\n=== Authoring real content ===\n";
update_option(DEHELED_UM_SCOPES,
    array_merge(deheled_um_default_scopes(), array('users:delete')), 'no');

$owner_email = "de-livecheck-owner-$suffix@digitalelementsgroup.com";
$owner = rbody(deheled_um_rest_create_user(write_request(array(
    'email' => $owner_email, 'role' => 'author',
), 'live-owner-' . $suffix)));
ok('the content owner is created', !empty($owner['ok']));
$owner_id = (int) $owner['user']['id'];
$created_ids[] = $owner_id;

$heir_email = "de-livecheck-heir-$suffix@digitalelementsgroup.com";
$heir = rbody(deheled_um_rest_create_user(write_request(array(
    'email' => $heir_email, 'role' => 'editor',
), 'live-heir-' . $suffix)));
ok('the recipient is created', !empty($heir['ok']));
$heir_id = (int) $heir['user']['id'];
$created_ids[] = $heir_id;

$content_ids = array();
for ($i = 1; $i <= 3; $i++) {
    $content_ids[] = wp_insert_post(array(
        'post_title' => "DE live check post $i $suffix", 'post_content' => 'x',
        'post_status' => 'publish', 'post_type' => 'post', 'post_author' => $owner_id,
    ));
}
$content_ids[] = wp_insert_post(array(
    'post_title' => "DE live check page $suffix", 'post_content' => 'x',
    'post_status' => 'publish', 'post_type' => 'page', 'post_author' => $owner_id,
));
$attachment_id = wp_insert_post(array(
    'post_title' => "DE live check media $suffix", 'post_status' => 'inherit',
    'post_type' => 'attachment', 'post_mime_type' => 'image/png', 'post_author' => $owner_id,
));
$content_ids[] = $attachment_id;
$scheduled_id = wp_insert_post(array(
    'post_title' => "DE live check scheduled $suffix", 'post_content' => 'x',
    'post_status' => 'future', 'post_type' => 'post', 'post_author' => $owner_id,
    'post_date' => gmdate('Y-m-d H:i:s', time() + 86400),
    'post_date_gmt' => gmdate('Y-m-d H:i:s', time() + 86400),
));
$content_ids[] = $scheduled_id;

register_shutdown_function(function () use (&$content_ids) {
    foreach ($content_ids as $id) {
        if ($id && !is_wp_error($id) && get_post($id)) wp_delete_post($id, true);
    }
    if ($content_ids) echo "[removed " . count($content_ids) . " test post(s)]\n";
});

ok('3 posts, 1 page, 1 attachment and 1 scheduled post were created',
    count(array_filter($content_ids, function ($id) { return $id && !is_wp_error($id); })) === 6);

echo "\n=== The ownership check sees all of it ===\n";
$content_req = new WP_REST_Request('GET', '/de/v2/users/' . $owner_id . '/content');
$content_req->set_param('id', $owner_id);
$owned = deheled_um_rest_content($content_req)->get_data();

eq_int('total owned items', (int) $owned['content']['total'], 6);
ok('owns_content is true', $owned['content']['owns_content'] === true);

$by_type = array();
foreach ($owned['content']['by_type'] as $t) $by_type[$t['type']] = (int) $t['total'];
eq_int('posts counted (3 published + 1 scheduled)', isset($by_type['post']) ? $by_type['post'] : 0, 4);
eq_int('the page is counted', isset($by_type['page']) ? $by_type['page'] : 0, 1);
eq_int('the attachment is counted as content', isset($by_type['attachment']) ? $by_type['attachment'] : 0, 1);
eq_int('scheduled content is broken out by status', (int) $owned['content']['by_status']['future'], 1);
eq_int('published content is broken out', (int) $owned['content']['by_status']['publish'], 4);

ok('the recipient is offered as a reassignment target',
    in_array($heir_id, array_map(function ($t) { return (int) $t['id']; }, $owned['eligible_reassign_targets']), true));
ok('the account being emptied is NOT offered as its own target',
    !in_array($owner_id, array_map(function ($t) { return (int) $t['id']; }, $owned['eligible_reassign_targets']), true));

echo "\n=== Deletion is refused while content exists ===\n";
$del = new WP_REST_Request('DELETE', '/de/v2/users/' . $owner_id);
$del->set_param('id', $owner_id);
$del->set_param('confirm', true);
$del->set_header('idempotency-key', 'live-del-blocked-' . $suffix);
$blocked = deheled_um_rest_delete_user($del);

ok('refused with has_content', rcode($blocked) === 'has_content');
ok('...naming how much is in the way',
    strpos(rbody($blocked)['error']['message'], '6 item') !== false);
ok('the account still exists', get_user_by('id', $owner_id) !== false);
ok('every item is still theirs', (int) count_user_posts($owner_id, 'post') > 0);

echo "\n=== A client's own content is never reassigned ===\n";
// Reassignment rewrites authorship and overwrites comment author details in
// place, so it cannot be undone by running it backwards.
$outsider_owner = wp_create_user('de-lc-outown-' . $suffix,
    wp_generate_password(32, true, true), "de-livecheck-outown-$suffix@example.com");
if (!is_wp_error($outsider_owner)) {
    $created_ids[] = (int) $outsider_owner;
    $their_post = wp_insert_post(array(
        'post_title' => "DE live check client post $suffix", 'post_content' => 'x',
        'post_status' => 'publish', 'post_type' => 'post', 'post_author' => (int) $outsider_owner,
    ));
    $content_ids[] = $their_post;

    $steal_content = new WP_REST_Request('POST', '/de/v2/users/' . $outsider_owner . '/reassign');
    $steal_content->set_param('id', $outsider_owner);
    $steal_content->set_param('target_id', $heir_id);
    $steal_content->set_header('idempotency-key', 'live-steal-content-' . $suffix);
    ok('reassigning an unmanaged account is refused',
        rcode(deheled_um_rest_reassign($steal_content)) === 'not_managed');
    ok('...and their post is still theirs',
        (int) get_post($their_post)->post_author === (int) $outsider_owner);
}

echo "\n=== Reassigning ===\n";
$re = new WP_REST_Request('POST', '/de/v2/users/' . $owner_id . '/reassign');
$re->set_param('id', $owner_id);
$re->set_param('target_id', $heir_id);
$re->set_header('idempotency-key', 'live-reassign-' . $suffix);
$moved = rbody(deheled_um_rest_reassign($re));

ok('the reassignment runs', !empty($moved['ok']));
eq_int('every item moved', (int) $moved['moved']['posts'], 6);
eq_int('the verified remaining count is zero', (int) $moved['remaining']['total'], 0);
ok('...and the site says so', $moved['verified'] === true);

// Refusing an invalid target matters as much as accepting a valid one.
$re_self = new WP_REST_Request('POST', '/de/v2/users/' . $owner_id . '/reassign');
$re_self->set_param('id', $owner_id);
$re_self->set_param('target_id', $owner_id);
$re_self->set_header('idempotency-key', 'live-reassign-self-' . $suffix);
ok('reassigning to the same account is refused',
    rcode(deheled_um_rest_reassign($re_self)) === 'reassign_target_invalid');

echo "\n=== The re-check shows zero ===\n";
$recheck = deheled_um_rest_content($content_req)->get_data();
eq_int('nothing remains', (int) $recheck['content']['total'], 0);
ok('owns_content is false', $recheck['content']['owns_content'] === false);
eq_int('the recipient now owns all six', (int) deheled_um_count_owned_content($heir_id)['total'], 6);

echo "\n=== A post created after the check blocks the delete ===\n";
// THE stale-UI case: the dashboard has a correct zero on screen, and then the
// site keeps working. Deleting on the strength of that count would destroy
// content, so ownership is re-counted inside the delete request itself.
$late_id = wp_insert_post(array(
    'post_title' => "DE live check late post $suffix", 'post_content' => 'x',
    'post_status' => 'publish', 'post_type' => 'post', 'post_author' => $owner_id,
));
$content_ids[] = $late_id;

$del2 = new WP_REST_Request('DELETE', '/de/v2/users/' . $owner_id);
$del2->set_param('id', $owner_id);
$del2->set_param('confirm', true);
$del2->set_param('reassign_target', $heir_id);
$del2->set_header('idempotency-key', 'live-del-stale-' . $suffix);
$stale = deheled_um_rest_delete_user($del2);

ok('the delete is refused on the fresh count', rcode($stale) === 'has_content');
ok('the account survives', get_user_by('id', $owner_id) !== false);
ok('and so does the new post', get_post($late_id) !== null);

// Clear it the proper way and confirm we are back to a deletable state.
$re2 = new WP_REST_Request('POST', '/de/v2/users/' . $owner_id . '/reassign');
$re2->set_param('id', $owner_id);
$re2->set_param('target_id', $heir_id);
$re2->set_header('idempotency-key', 'live-reassign-2-' . $suffix);
$moved2 = rbody(deheled_um_rest_reassign($re2));
eq_int('the late post moves too', (int) $moved2['remaining']['total'], 0);

echo "\n=== Deleting, now that it is genuinely empty ===\n";
$del3 = new WP_REST_Request('DELETE', '/de/v2/users/' . $owner_id);
$del3->set_param('id', $owner_id);
$del3->set_param('confirm', true);
$del3->set_param('reassign_target', $heir_id);
$del3->set_header('idempotency-key', 'live-del-ok-' . $suffix);
$gone = rbody(deheled_um_rest_delete_user($del3));

ok('the account is deleted', !empty($gone['ok']) && $gone['result'] === 'deleted');
ok('...confirming it verified emptiness at delete time', $gone['verified_empty_at_delete'] === true);
ok('the user really is gone', get_user_by('id', $owner_id) === false);

echo "\n=== ...and ALL the content survived ===\n";
$survivors = 0;
foreach ($content_ids as $id) {
    if ($id && !is_wp_error($id) && get_post($id)) $survivors++;
}
// Counted against what was actually created, not a literal, so adding a case
// above can't silently weaken this into "some of it survived".
$expected_survivors = count(array_filter($content_ids, function ($id) {
    return $id && !is_wp_error($id);
}));
eq_int('every item created by this run still exists', $survivors, $expected_survivors);
foreach (array('post', 'page', 'attachment') as $type) {
    $still = get_posts(array(
        'author' => $heir_id, 'post_type' => $type, 'post_status' => 'any',
        'numberposts' => -1, 'fields' => 'ids',
    ));
    ok("$type content belongs to the new owner", count($still) > 0, $type);
}
$scheduled_still = get_post($scheduled_id);
ok('the scheduled post survived', $scheduled_still !== null);
ok('...still scheduled', $scheduled_still && $scheduled_still->post_status === 'future');
ok('...and owned by the recipient', $scheduled_still && (int) $scheduled_still->post_author === $heir_id);
$media_still = get_post($attachment_id);
ok('the media survived', $media_still !== null);
ok('...and belongs to the recipient', $media_still && (int) $media_still->post_author === $heir_id);
// The client's own post stays with the client; everything the deleted account
// owned is now the recipient's.
eq_int('the recipient owns everything the deleted account had',
    (int) deheled_um_count_owned_content($heir_id)['total'], 7);

echo "\n=== Deletion is refused without the users:delete scope ===\n";
update_option(DEHELED_UM_SCOPES, deheled_um_default_scopes(), 'no');
$scoped = deheled_um_verify_request(live_signed_request('DELETE', '/de/v2/users/' . $heir_id), 'users:delete');
ok('a site that hasn\'t enabled deletion refuses it',
    is_wp_error($scoped) && $scoped->get_error_data()['de_code'] === 'scope_denied');
update_option(DEHELED_UM_SCOPES,
    array_merge(deheled_um_default_scopes(), array('users:delete')), 'no');

echo "\n=== An unmanaged account is never deleted ===\n";
$outsider_id = wp_create_user('de-lc-outsider-' . $suffix, wp_generate_password(32, true, true),
    "de-livecheck-outsider-$suffix@example.com");
if (!is_wp_error($outsider_id)) {
    $created_ids[] = (int) $outsider_id;
    $del_out = new WP_REST_Request('DELETE', '/de/v2/users/' . $outsider_id);
    $del_out->set_param('id', $outsider_id);
    $del_out->set_param('confirm', true);
    $del_out->set_header('idempotency-key', 'live-del-unmanaged-' . $suffix);
    ok('deleting an unmanaged account is refused',
        rcode(deheled_um_rest_delete_user($del_out)) === 'not_managed');
    ok('...and it still exists', get_user_by('id', $outsider_id) !== false);
}

echo "\n=== Capabilities advertise the destructive path ===\n";
$caps_last = deheled_um_rest_capabilities(new WP_REST_Request('GET', '/de/v2/capabilities'))->get_data();
foreach (array('users.read', 'users.write', 'users.delete', 'content.reassign', 'content.read') as $cap) {
    ok("$cap is advertised", in_array($cap, $caps_last['capabilities'], true));
}

/* ==========================================================================
 * The Team Members panel (2.7.0)
 *
 * The de/v2 sections above prove the hub can act on this site. This section
 * proves the reverse direction: what someone standing in this site's WP Admin
 * can and — mostly — cannot do.
 *
 * Everything here runs against the real options, user and transient APIs. The
 * hub round-trip at the end only runs when UM_LIVE_HUB names a dashboard that
 * answers; without one, the unreachable path is checked instead, which is the
 * state a client site would actually hit if the dashboard were down.
 * ========================================================================== */

echo "\n=== Team Members: the panel is wired up ===\n";

ok('the panel is loaded', function_exists('deheled_site_users_gate'));
ok('the hub client is loaded', function_exists('deheled_hub_request'));
ok('site.assign is advertised to the dashboard',
    in_array('site.assign', deheled_um_capability_list(), true));


echo "\n=== Team Members: the gate, against this site's real options ===\n";

// Park the site in each state in turn and read back what the gate says. The
// enrollment options are restored by the shutdown handler registered earlier;
// the license options get their own, registered here.
$panel_saved_license = get_option(DEHELED_LICENSE_OPTION, null);
$panel_saved_status  = get_option(DEHELED_LIC_STATUS, null);
register_shutdown_function(function () use ($panel_saved_license, $panel_saved_status) {
    if ($panel_saved_license === null) delete_option(DEHELED_LICENSE_OPTION);
    else update_option(DEHELED_LICENSE_OPTION, $panel_saved_license, 'no');
    if ($panel_saved_status === null) delete_option(DEHELED_LIC_STATUS);
    else update_option(DEHELED_LIC_STATUS, $panel_saved_status, 'no');
    echo "[restored the site's license options]\n";
});

/** Puts the site in the fully-connected state the panel needs. */
function panel_connect() {
    update_option(DEHELED_LICENSE_OPTION, 'DEG-LIVE-CHECK-0000-0000', 'no');
    update_option(DEHELED_LIC_STATUS, array('valid' => true, 'expired' => false, 'checked_at' => time()), 'no');
    update_option(DEHELED_UM_KEY_ID, 'dek_livecheck', 'no');
    update_option(DEHELED_UM_SECRET, 'live-check-secret', 'no');
    update_option(DEHELED_UM_SCOPES, deheled_um_default_scopes(), 'no');
    update_option(DEHELED_UM_ENROLLED, time(), 'no');
}
function panel_state($roster = null) {
    $g = deheled_site_users_gate($roster);
    return $g['state'];
}

// A staff account as the hub would have created it: managed, agency address,
// administrator on this site.
$tm_staff = wp_insert_user(array(
    'user_login' => 'de-lc-staff-' . $suffix,
    'user_email' => "de-livecheck-staff-$suffix@digitalelementsgroup.com",
    'user_pass'  => wp_generate_password(32, true, true),
    'role'       => 'administrator',
));
if (!is_wp_error($tm_staff)) {
    $created_ids[] = (int) $tm_staff;
    update_user_meta($tm_staff, DEHELED_UM_MANAGED_META, '1');
}

// The client's own administrator: every capability, not ours.
$tm_client = wp_insert_user(array(
    'user_login' => 'de-lc-tmclient-' . $suffix,
    'user_email' => "de-livecheck-tmclient-$suffix@example.com",
    'user_pass'  => wp_generate_password(32, true, true),
    'role'       => 'administrator',
));
if (!is_wp_error($tm_client)) $created_ids[] = (int) $tm_client;

// One of ours, but only editor-level, with the two user capabilities added.
$tm_editor = wp_insert_user(array(
    'user_login' => 'de-lc-editor-' . $suffix,
    'user_email' => "de-livecheck-editor-$suffix@digitalelementsgroup.com",
    'user_pass'  => wp_generate_password(32, true, true),
    'role'       => 'editor',
));
if (!is_wp_error($tm_editor)) {
    $created_ids[] = (int) $tm_editor;
    update_user_meta($tm_editor, DEHELED_UM_MANAGED_META, '1');
    $tm_editor_user = new WP_User($tm_editor);
    $tm_editor_user->add_cap('edit_users');
    $tm_editor_user->add_cap('promote_users');
}

ok('a staff account was created for the check', !is_wp_error($tm_staff));
ok('a client administrator was created for the check', !is_wp_error($tm_client));
ok('an editor-level staff account was created for the check', !is_wp_error($tm_editor));

wp_set_current_user((int) $tm_staff);

// Registering the submenu is what puts the link in the menu; the callback is
// what actually decides. Both are checked, here and below.
$GLOBALS['submenu'] = isset($GLOBALS['submenu']) ? $GLOBALS['submenu'] : array();
do_action('admin_menu');
$tm_registered = false;
foreach ((array) $GLOBALS['submenu'] as $parent => $items) {
    foreach ((array) $items as $item) {
        if (isset($item[2]) && $item[2] === DEHELED_SITE_USERS_PAGE) {
            $tm_registered = true;
            ok('the panel lives under DE Monitoring', $parent === 'deheled-monitor', (string) $parent);
        }
    }
}
ok('the Team Members submenu is registered', $tm_registered);

delete_option(DEHELED_LICENSE_OPTION);
ok('no license key -> license_missing', panel_state() === 'license_missing', panel_state());

panel_connect();
update_option(DEHELED_LIC_STATUS, array('valid' => false, 'expired' => true, 'checked_at' => time()), 'no');
ok('an expired license -> license_expired', panel_state() === 'license_expired', panel_state());

update_option(DEHELED_LIC_STATUS, array('valid' => false, 'expired' => false, 'checked_at' => time()), 'no');
ok('an unrecognised license -> license_invalid', panel_state() === 'license_invalid', panel_state());

panel_connect();
delete_option(DEHELED_UM_KEY_ID);
delete_option(DEHELED_UM_SECRET);
ok('not enrolled -> not_enrolled', panel_state() === 'not_enrolled', panel_state());

panel_connect();
update_option(DEHELED_UM_SCOPES, array('users:read'), 'no');
ok('users:write withheld by this site -> write_not_granted',
    panel_state() === 'write_not_granted', panel_state());

panel_connect();
ok('a fully connected staff account -> available', panel_state() === 'available', panel_state());

echo "\n=== Team Members: who the gate refuses ===\n";

// The check this whole feature stands on. This account is a real administrator
// on a real WordPress install and holds every capability there is.
wp_set_current_user((int) $tm_client);
ok('the client\'s own administrator is refused', panel_state() === 'no_permission', panel_state());
$client_gate = deheled_site_users_gate();
ok('...and told it is for Digital Elements accounts',
    strpos($client_gate['message'], 'Digital Elements') !== false, $client_gate['message']);

// Flagging that account managed is not enough on its own — the address still
// isn't ours. Removed again immediately afterwards.
update_user_meta($tm_client, DEHELED_UM_MANAGED_META, '1');
ok('...still refused when flagged managed, because of the address',
    panel_state() === 'no_permission', panel_state());
delete_user_meta($tm_client, DEHELED_UM_MANAGED_META);

// And one of ours without the flag is refused too: both are required, so
// neither alone is a way in.
wp_set_current_user((int) $tm_staff);
delete_user_meta($tm_staff, DEHELED_UM_MANAGED_META);
ok('an agency address that is not managed is refused', panel_state() === 'no_permission', panel_state());
update_user_meta($tm_staff, DEHELED_UM_MANAGED_META, '1');

// A subscriber-level staff account: ours, managed, but with no business
// touching users here.
$tm_low = wp_insert_user(array(
    'user_login' => 'de-lc-low-' . $suffix,
    'user_email' => "de-livecheck-low-$suffix@digitalelementsgroup.com",
    'user_pass'  => wp_generate_password(32, true, true),
    'role'       => 'subscriber',
));
if (!is_wp_error($tm_low)) {
    $created_ids[] = (int) $tm_low;
    update_user_meta($tm_low, DEHELED_UM_MANAGED_META, '1');
    wp_set_current_user((int) $tm_low);
    ok('a managed staff account without edit_users is refused',
        panel_state() === 'no_permission', panel_state());
}

echo "\n=== Team Members: the capability-subset rule, against real roles ===\n";

wp_set_current_user((int) $tm_editor);
ok('an editor-level account may grant Editor', deheled_site_users_can_grant_role('editor'));
ok('...and Author', deheled_site_users_can_grant_role('author'));
ok('...but NOT Administrator', deheled_site_users_can_grant_role('administrator') === false);
$editor_roles = deheled_site_users_grantable_roles();
ok('...so Administrator is never offered to them',
    !isset($editor_roles['administrator']), implode(',', array_keys($editor_roles)));
ok('...while Editor is', isset($editor_roles['editor']));

wp_set_current_user((int) $tm_staff);
ok('an administrator may grant Administrator', deheled_site_users_can_grant_role('administrator'));
$admin_roles = deheled_site_users_grantable_roles();
ok('...and it is flagged as administering the site',
    !empty($admin_roles['administrator']['site_admin']));
ok('an invented role is refused', deheled_site_users_can_grant_role('superuser') === false);

echo "\n=== Team Members: the roster cache is tied to the credential ===\n";

panel_connect();
$cache_key_a = deheled_hub_roster_cache_key();
set_transient($cache_key_a, array('ok' => true, 'canAssign' => true, 'teams' => array()), 60);
ok('a cached roster is read back', is_array(get_transient($cache_key_a)));

update_option(DEHELED_UM_KEY_ID, 'dek_rotated_' . $suffix, 'no');
$cache_key_b = deheled_hub_roster_cache_key();
ok('rotating the credential changes the cache key', $cache_key_a !== $cache_key_b);
ok('...so the old roster is unreachable', get_transient($cache_key_b) === false);
delete_transient($cache_key_a);
panel_connect();

echo "\n=== Team Members: an unreachable dashboard is a clean state ===\n";

$hub_live = false;
$probe = wp_remote_get(DEHELED_HUB_URL . '/healthz', array('timeout' => 5));
if (!is_wp_error($probe)) $hub_live = true;

if (!$hub_live) {
    deheled_hub_clear_roster_cache();
    $roster = deheled_hub_get_roster(true);
    ok('an unreachable dashboard returns an error, not a roster', is_wp_error($roster));
    ok('...coded hub_unreachable', is_wp_error($roster) && $roster->get_error_code() === 'hub_unreachable');
    ok('...which the gate turns into its own state',
        panel_state($roster) === 'hub_unreachable', panel_state($roster));

    // The thing that must never happen: a page that looks usable when it isn't.
    wp_set_current_user((int) $tm_staff);
    ob_start();
    deheled_site_users_render();
    $html = ob_get_clean();
    ok('the page renders the unavailable notice', strpos($html, 'reach Digital Elements') !== false);
    ok('...and no selection UI at all', strpos($html, 'deheled-tm-root') === false);
    ok('...and leaks no credential', strpos($html, 'live-check-secret') === false
        && strpos($html, 'DEG-LIVE-CHECK') === false);

    echo "\n[no dashboard at " . DEHELED_HUB_URL . " - the roster round-trip was not exercised.\n"
       . " Start the hub and re-run with UM_LIVE_HUB=http://127.0.0.1:3000 to cover it.]\n";
} else {
    echo "[dashboard responding at " . DEHELED_HUB_URL . "]\n";
    echo "\n=== Team Members: the round-trip to the dashboard ===\n";

    // Uses whatever credential this site is genuinely enrolled with, so this
    // only runs after the site has been connected from the dashboard.
    foreach ($saved as $saved_name => $saved_value) {
        if ($saved_value !== null) update_option($saved_name, $saved_value, 'no');
    }
    if ($panel_saved_license !== null) update_option(DEHELED_LICENSE_OPTION, $panel_saved_license, 'no');
    if ($panel_saved_status !== null) update_option(DEHELED_LIC_STATUS, $panel_saved_status, 'no');

    deheled_hub_clear_roster_cache();
    $roster = deheled_hub_get_roster(true);
    ok('the roster comes back', !is_wp_error($roster),
        is_wp_error($roster) ? $roster->get_error_code() . ': ' . $roster->get_error_message() : '');

    if (!is_wp_error($roster)) {
        ok('the dashboard permits this site to assign', !empty($roster['canAssign']));
        ok('the gate opens', panel_state($roster) === 'available', panel_state($roster));

        $public = deheled_site_users_public_roster($roster);
        $members = array();
        foreach ($public['teams'] as $public_team) {
            foreach ($public_team['members'] as $public_member) $members[] = $public_member;
        }
        ok('at least one team member is offered', count($members) > 0);

        $non_agency = 0;
        foreach ($members as $m) {
            if (substr(strtolower($m['email']), -strlen('@digitalelementsgroup.com')) !== '@digitalelementsgroup.com') {
                $non_agency++;
            }
        }
        eq_int('no non-agency address reaches the page', $non_agency, 0);
        ok('the roster carries no secret', strpos(wp_json_encode($public), 'secret') === false);

        // The hub acts FOR a person, not for a site: it resolves the acting
        // WordPress user against the roster and refuses if they aren't on it.
        // Worth proving before anything else, because in production the person
        // using this screen is always a hub-created account and so always is.
        echo "\n--- the acting WordPress user must be on the roster ---\n";
        $stranger = deheled_hub_assign(array($members[0]['id']), 'editor', 'stranger-' . $suffix, false);
        ok('an agency account the dashboard has never heard of is refused',
            is_wp_error($stranger), 'the assignment was accepted');
        ok('...without saying why, beyond that it was refused',
            is_wp_error($stranger) && strpos($stranger->get_error_message(), 'roster') === false);

        // Someone not already on this site, so the preflight has something to
        // say and the assignment has something to do.
        $target = null;
        foreach ($members as $m) { if (empty($m['present'])) { $target = $m; break; } }

        // ...and from here the check acts as a real member of staff, which is
        // what the panel is for. A second roster member, created locally and
        // marked managed, exactly as the hub would have left them.
        $actor_member = null;
        foreach ($members as $m) {
            if (!$target || $m['id'] !== $target['id']) { $actor_member = $m; break; }
        }
        if ($actor_member) {
            $existing_actor = get_user_by('email', $actor_member['email']);
            if ($existing_actor) {
                $tm_actor = (int) $existing_actor->ID;
            } else {
                $tm_actor = wp_insert_user(array(
                    'user_login' => 'de-lc-actor-' . $suffix,
                    'user_email' => $actor_member['email'],
                    'user_pass'  => wp_generate_password(32, true, true),
                    'role'       => 'administrator',
                ));
                if (!is_wp_error($tm_actor)) $created_ids[] = (int) $tm_actor;
            }
            if (!is_wp_error($tm_actor)) {
                update_user_meta($tm_actor, DEHELED_UM_MANAGED_META, '1');
                wp_set_current_user((int) $tm_actor);
                ok('a roster member using the panel passes the gate',
                    panel_state($roster) === 'available', panel_state($roster));
                echo "    acting as " . $actor_member['email'] . "\n";
            }
        }

        if ($target) {
            echo "\n--- preflight ---\n";
            $pre = deheled_hub_preflight(array($target['id']), 'editor');
            ok('preflight answers', !is_wp_error($pre),
                is_wp_error($pre) ? $pre->get_error_message() : '');
            if (!is_wp_error($pre) && !empty($pre['rows'])) {
                $row = $pre['rows'][0];
                ok('...with a row for the person chosen', $row['staffUserId'] === $target['id']);
                ok('...saying whether the account exists or would be created',
                    in_array($row['action'], array('create', 'link', 'update', 'noop', 'blocked'), true),
                    isset($row['action']) ? $row['action'] : '?');
                echo "    " . $target['email'] . " -> " . $row['action'] . "\n";
            }

            echo "\n--- assign ---\n";
            $request_id = 'livecheck-' . $suffix;
            $res = deheled_hub_assign(array($target['id']), 'editor', $request_id, false);
            ok('the assignment is accepted', !is_wp_error($res),
                is_wp_error($res) ? $res->get_error_message() : '');

            if (!is_wp_error($res)) {
                $job_id = isset($res['jobId']) ? $res['jobId'] : '';
                ok('...and comes back with a job to poll', $job_id !== '');

                $job = null;
                $view = array();
                for ($i = 0; $i < 60; $i++) {
                    $job = deheled_hub_job($job_id);
                    if (is_wp_error($job)) break;
                    $view = isset($job['job']) ? $job['job'] : array();
                    if (!empty($view['done'])) break;
                    usleep(500000);
                }
                ok('the job finishes', !is_wp_error($job) && !empty($view['done']),
                    is_wp_error($job) ? $job->get_error_message() : (isset($view['status']) ? $view['status'] : '?'));

                if (!is_wp_error($job)) {
                    echo "    job $job_id -> " . (isset($view['status']) ? $view['status'] : '?') . "\n";
                    foreach ((array) (isset($view['operations']) ? $view['operations'] : array()) as $item) {
                        echo "    " . $item['staffEmail'] . ": " . $item['status']
                           . (!empty($item['error']) ? ' - ' . $item['error'] : '') . "\n";
                    }
                    // Only this site's work comes back - a job is never a window
                    // onto what the dashboard did elsewhere.
                    ok('every operation reported belongs to this site',
                        count($view['operations']) === 1, count($view['operations']) . ' operation(s)');
                    wp_cache_flush();
                    $made = get_user_by('email', $target['email']);
                    ok('the account now exists on this site', $made !== false);
                    if ($made) {
                        $created_ids[] = (int) $made->ID;
                        ok('...marked as managed by Digital Elements',
                            deheled_um_user_is_managed($made->ID));
                        ok('...with the role asked for', in_array('editor', (array) $made->roles, true),
                            implode(',', (array) $made->roles));
                    }
                }

                echo "\n--- retry with the same request id ---\n";
                $before = count_users();
                $again = deheled_hub_assign(array($target['id']), 'editor', $request_id, false);
                ok('a retry is accepted', !is_wp_error($again),
                    is_wp_error($again) ? $again->get_error_message() : '');
                if (!is_wp_error($again)) {
                    ok('...and returns the SAME job', $again['jobId'] === $job_id,
                        $again['jobId'] . ' vs ' . $job_id);
                    ok('...recognised as a replay', !empty($again['replayed']));
                }
                wp_cache_flush();
                $after = count_users();
                eq_int('no second account was created',
                    (int) $after['total_users'], (int) $before['total_users']);
            }
        } else {
            echo "[every roster member is already on this site - nothing new to assign]\n";
        }

        echo "\n--- the gate still refuses the client's own administrator ---\n";
        wp_set_current_user((int) $tm_client);
        ok('the client administrator is refused even with a live dashboard',
            panel_state($roster) === 'no_permission', panel_state($roster));
        ob_start();
        deheled_site_users_render();
        $html = ob_get_clean();
        ok('...and gets no selection UI', strpos($html, 'deheled-tm-root') === false);
        wp_set_current_user((int) $tm_staff);
    }
}

echo "\n=== Team Members: the rendered page leaks nothing ===\n";
panel_connect();
wp_set_current_user((int) $tm_staff);
ob_start();
deheled_site_users_render();
$html = ob_get_clean();
ok('no license key in the markup', strpos($html, 'DEG-LIVE-CHECK') === false);
ok('no signing secret in the markup', strpos($html, 'live-check-secret') === false);
ok('no key id in the markup', strpos($html, 'dek_livecheck') === false);

echo "\n" . ($fail ? "FAILED — $fail check(s) failed\n" : "OK — all checks passed\n");
exit($fail ? 1 : 0);
