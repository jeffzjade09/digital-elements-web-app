<?php
/**
 * Tests for the plugin's de/v2 request authentication (includes/um-auth.php).
 *
 * These endpoints can create and delete real WordPress users on client sites,
 * so the auth path is the most security-sensitive code in the plugin and is
 * worth testing without needing a WordPress install. A minimal WordPress
 * surface is stubbed below — options, transients, WP_Error and the REST request
 * object — which is enough to exercise signature verification, the clock
 * window, replay protection, scope enforcement and rate limiting.
 *
 * The signing vectors are shared with the JavaScript side
 * (tests/fixtures/signing-vectors.json) so the two implementations cannot drift
 * apart: if either one changes how it builds the canonical string, one of these
 * suites fails.
 */

$FAIL = 0;
function ok($label, $cond, $extra = '') {
    global $FAIL;
    echo ($cond ? 'PASS' : 'FAIL') . "  $label" . (!$cond && $extra ? "  ($extra)" : '') . "\n";
    if (!$cond) $FAIL++;
}
function eq($label, $a, $b) {
    ok($label, $a === $b, 'expected ' . var_export($b, true) . ', got ' . var_export($a, true));
}

/* ----------------------------------------------------- WordPress stubs ---- */

define('ABSPATH', __DIR__);
define('DEHELED_VERSION', '2.5.0');
define('DAY_IN_SECONDS', 86400);

$GLOBALS['__options'] = array();
$GLOBALS['__transients'] = array();
$GLOBALS['__rand'] = 2; // never 1, so the amortised sweeps stay out of the way

function get_option($name, $default = false) {
    return array_key_exists($name, $GLOBALS['__options']) ? $GLOBALS['__options'][$name] : $default;
}
function add_option($name, $value, $deprecated = '', $autoload = 'yes') {
    if (array_key_exists($name, $GLOBALS['__options'])) return false;
    $GLOBALS['__options'][$name] = $value;
    return true;
}
function update_option($name, $value, $autoload = null) {
    $GLOBALS['__options'][$name] = $value;
    return true;
}
function delete_option($name) { unset($GLOBALS['__options'][$name]); return true; }
function get_transient($k) { return array_key_exists($k, $GLOBALS['__transients']) ? $GLOBALS['__transients'][$k] : false; }
function set_transient($k, $v, $ttl = 0) { $GLOBALS['__transients'][$k] = $v; return true; }
function wp_rand($min = 0, $max = 1) { return $GLOBALS['__rand']; }

class WP_Error {
    public $code; public $message; public $data;
    public function __construct($code = '', $message = '', $data = array()) {
        $this->code = $code; $this->message = $message; $this->data = $data;
    }
    public function get_error_message() { return $this->message; }
    public function get_error_data() { return $this->data; }
}

/** Just enough of WP_REST_Request for the auth path. */
class FakeRequest {
    private $headers, $method, $route, $query, $body;
    public function __construct($method, $route, $query = array(), $body = '', $headers = array()) {
        $this->method = $method; $this->route = $route; $this->query = $query;
        $this->body = $body; $this->headers = array();
        foreach ($headers as $k => $v) $this->headers[strtolower($k)] = $v;
    }
    public function get_header($name) {
        $name = strtolower($name);
        return isset($this->headers[$name]) ? $this->headers[$name] : '';
    }
    public function set_header($name, $value) { $this->headers[strtolower($name)] = $value; return $this; }
    public function get_method() { return $this->method; }
    public function get_route() { return $this->route; }
    public function get_query_params() { return $this->query; }
    public function get_body() { return $this->body; }
}

require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-auth.php';

/* ------------------------------------------------- shared signing vectors -- */

echo "--- canonical string matches the JavaScript implementation ---\n";
$vectorFile = __DIR__ . '/fixtures/signing-vectors.json';
$vectors = json_decode(file_get_contents($vectorFile), true);
ok('vectors load', is_array($vectors) && count($vectors) >= 8);

foreach ($vectors as $v) {
    $canonical = deheled_um_canonical_string(
        $v['method'], $v['route'], $v['query'],
        $v['timestamp'], $v['nonce'], $v['idempotencyKey'], $v['body'] === null ? '' : $v['body']
    );
    eq('canonical: ' . $v['name'], $canonical, $v['canonical']);
    $sig = base64_encode(hash_hmac('sha256', $canonical, $v['secret'], true));
    eq('signature: ' . $v['name'], $sig, $v['signature']);
}

echo "\n--- route normalization ---\n";
eq('adds a leading slash', deheled_um_normalize_route('de/v2/users'), '/de/v2/users');
eq('strips a trailing slash', deheled_um_normalize_route('/de/v2/users/'), '/de/v2/users');
eq('collapses doubled slashes', deheled_um_normalize_route('/de//v2///users'), '/de/v2/users');

echo "\n--- canonical query ---\n";
eq('empty query', deheled_um_canonical_query(array()), '');
eq('sorted by name', deheled_um_canonical_query(array('b' => '1', 'a' => '2')), 'a=2&b=1');
eq('unsigned params dropped', deheled_um_canonical_query(array('rest_route' => '/x', '_locale' => 'user', 'a' => '1')), 'a=1');
eq('repeated values sorted', deheled_um_canonical_query(array('s' => array('b', 'a'))), 's=a&s=b');

/* ------------------------------------------------------------ verification - */

$SECRET = 'plugin-side-secret-value';
$KEY_ID = 'dek_0123456789abcdef';

function enroll_site($scopes = null) {
    global $SECRET, $KEY_ID;
    $GLOBALS['__options'][DEHELED_UM_KEY_ID] = $KEY_ID;
    $GLOBALS['__options'][DEHELED_UM_SECRET] = $SECRET;
    $GLOBALS['__options'][DEHELED_UM_SCOPES] = $scopes === null ? deheled_um_default_scopes() : $scopes;
}

/** Builds a correctly signed request, then lets a test bend one part of it. */
function signed_request($opts = array()) {
    global $SECRET, $KEY_ID;
    $method = isset($opts['method']) ? $opts['method'] : 'GET';
    $route  = isset($opts['route']) ? $opts['route'] : '/de/v2/users';
    $query  = isset($opts['query']) ? $opts['query'] : array();
    $body   = isset($opts['body']) ? $opts['body'] : '';
    $ts     = isset($opts['timestamp']) ? $opts['timestamp'] : time();
    $nonce  = isset($opts['nonce']) ? $opts['nonce'] : 'nonce-' . wp_generate_uuid();
    $idem   = isset($opts['idempotency']) ? $opts['idempotency'] : '';
    $secret = isset($opts['secret']) ? $opts['secret'] : $SECRET;
    $keyId  = isset($opts['keyId']) ? $opts['keyId'] : $KEY_ID;

    $canonical = deheled_um_canonical_string($method, $route, $query, $ts, $nonce, $idem, $body);
    $sig = base64_encode(hash_hmac('sha256', $canonical, $secret, true));

    $headers = array(
        'x-de-key-id'    => $keyId,
        'x-de-timestamp' => (string) $ts,
        'x-de-nonce'     => $nonce,
        'x-de-signature' => DEHELED_UM_SIG_VERSION . ' ' . $sig,
    );
    if ($idem !== '') $headers['idempotency-key'] = $idem;
    if (isset($opts['headers'])) $headers = array_merge($headers, $opts['headers']);

    return new FakeRequest($method, $route, $query, $body, $headers);
}

$uuid_n = 0;
function wp_generate_uuid() { global $uuid_n; return 'u' . (++$uuid_n) . '-' . mt_rand(); }

function err_code($result) {
    if (!($result instanceof WP_Error)) return null;
    $data = $result->get_error_data();
    return isset($data['de_code']) ? $data['de_code'] : null;
}

echo "\n--- fails closed before enrollment ---\n";
$GLOBALS['__options'] = array();
eq('unenrolled site refuses everything', err_code(deheled_um_verify_request(signed_request())), 'not_enrolled');

echo "\n--- a correctly signed request is accepted ---\n";
enroll_site();
ok('valid signature passes', deheled_um_verify_request(signed_request(), 'users:read') === true);

echo "\n--- signature tampering ---\n";
eq('wrong secret rejected', err_code(deheled_um_verify_request(signed_request(array('secret' => 'not-the-secret')))), 'unauthorized');
eq('unknown key id rejected', err_code(deheled_um_verify_request(signed_request(array('keyId' => 'dek_wrong')))), 'unauthorized');

// Signed for one route, presented at another: the signature must not travel.
$req = signed_request(array('route' => '/de/v2/users'));
$moved = new FakeRequest('GET', '/de/v2/users/7', array(), '', array(
    'x-de-key-id' => $req->get_header('x-de-key-id'),
    'x-de-timestamp' => $req->get_header('x-de-timestamp'),
    'x-de-nonce' => $req->get_header('x-de-nonce'),
    'x-de-signature' => $req->get_header('x-de-signature'),
));
eq('signature cannot be moved to another route', err_code(deheled_um_verify_request($moved)), 'unauthorized');

// Body edited after signing.
$req = signed_request(array('method' => 'POST', 'body' => '{"role":"editor"}'));
$tampered = new FakeRequest('POST', '/de/v2/users', array(), '{"role":"administrator"}', array(
    'x-de-key-id' => $req->get_header('x-de-key-id'),
    'x-de-timestamp' => $req->get_header('x-de-timestamp'),
    'x-de-nonce' => $req->get_header('x-de-nonce'),
    'x-de-signature' => $req->get_header('x-de-signature'),
));
eq('edited body rejected', err_code(deheled_um_verify_request($tampered)), 'unauthorized');

// An unsigned idempotency key could turn a safe retry into a second write.
$req = signed_request(array('method' => 'POST', 'body' => '{}', 'idempotency' => 'key-a'));
$req->set_header('idempotency-key', 'key-b');
eq('swapped idempotency key rejected', err_code(deheled_um_verify_request($req)), 'unauthorized');

echo "\n--- missing or malformed credentials ---\n";
eq('no headers at all', err_code(deheled_um_verify_request(new FakeRequest('GET', '/de/v2/users'))), 'missing_signature');
$req = signed_request();
$req->set_header('x-de-signature', 'NOT-OUR-SCHEME abc');
eq('unknown signature scheme', err_code(deheled_um_verify_request($req)), 'malformed');
$req = signed_request();
$req->set_header('x-de-timestamp', 'not-a-number');
eq('non-numeric timestamp', err_code(deheled_um_verify_request($req)), 'malformed');
$req = signed_request();
$req->set_header('x-de-nonce', str_repeat('n', 200));
eq('oversized nonce', err_code(deheled_um_verify_request($req)), 'malformed');

echo "\n--- the clock window ---\n";
eq('too old', err_code(deheled_um_verify_request(signed_request(array('timestamp' => time() - 600)))), 'stale_request');
eq('too far in the future', err_code(deheled_um_verify_request(signed_request(array('timestamp' => time() + 600)))), 'stale_request');
ok('inside the window passes', deheled_um_verify_request(signed_request(array('timestamp' => time() - 120))) === true);

echo "\n--- replay protection ---\n";
$req = signed_request(array('nonce' => 'replay-me'));
ok('first use passes', deheled_um_verify_request($req) === true);
eq('exact replay rejected', err_code(deheled_um_verify_request($req)), 'replay');

// A rejected signature must not burn the nonce, or anyone could lock out a
// legitimate request by guessing its nonce with a junk signature.
$bad = signed_request(array('nonce' => 'not-burned', 'secret' => 'wrong'));
deheled_um_verify_request($bad);
ok('a failed signature does not consume the nonce',
   deheled_um_verify_request(signed_request(array('nonce' => 'not-burned'))) === true);

echo "\n--- scopes ---\n";
enroll_site(array('users:read'));
ok('granted scope passes', deheled_um_verify_request(signed_request(), 'users:read') === true);
eq('ungranted scope refused', err_code(deheled_um_verify_request(signed_request(), 'users:delete')), 'scope_denied');
eq('admin scope refused by default', err_code(deheled_um_verify_request(signed_request(), 'users:admin')), 'scope_denied');

enroll_site();
eq('users:delete is not granted by default',
   in_array('users:delete', deheled_um_default_scopes(), true), false);
eq('users:admin is not granted by default',
   in_array('users:admin', deheled_um_default_scopes(), true), false);
ok('the optional scopes are exactly those two',
   array_keys(deheled_um_optional_scopes()) === array('users:delete', 'users:admin'));

echo "\n--- rate limiting ---\n";
$GLOBALS['__transients'] = array();
enroll_site();
$limited = false;
for ($i = 0; $i < DEHELED_UM_RATE_MAX + 5; $i++) {
    $r = deheled_um_verify_request(signed_request());
    if (err_code($r) === 'rate_limited') { $limited = true; break; }
}
ok('a flood is rate-limited', $limited);

echo "\n--- idempotency store ---\n";
$GLOBALS['__options'] = array();
enroll_site();
ok('nothing stored yet', deheled_um_idempotent_replay('job-1') === null);
ok('an empty key never replays', deheled_um_idempotent_replay('') === null);

echo "\n";
echo $FAIL ? "$FAIL assertion(s) failed\n" : "All assertions passed\n";
exit($FAIL ? 1 : 0);
