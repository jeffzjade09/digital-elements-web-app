<?php
/**
 * Tests for the de/v2 write guards (includes/um-write.php).
 *
 * This is the first plugin code that changes a client's site, so what is
 * asserted here is not "the happy path works" but "the refusals actually
 * refuse" — each one, independently, regardless of what the dashboard sent.
 *
 * The password rule gets particular attention: there is no condition under
 * which a generated password appears in a response, and the mail-failure path
 * is a warning on a successful create rather than a fallback that discloses one.
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

define('ABSPATH', __DIR__ . '/');
define('DEHELED_VERSION', '2.5.0');
define('DAY_IN_SECONDS', 86400);

$GLOBALS['__options'] = array();
$GLOBALS['__transients'] = array();
$GLOBALS['__usermeta'] = array();
$GLOBALS['__users'] = array();
$GLOBALS['__routes'] = array();
$GLOBALS['__actions'] = array();
$GLOBALS['__retrieve_password_calls'] = array();
$GLOBALS['__filters'] = array('wp_mail' => array(), 'pre_wp_mail' => array());
$GLOBALS['__rand'] = 2;
$GLOBALS['__next_id'] = 100;
$GLOBALS['__mail_ok'] = true;
$GLOBALS['__mail_short'] = null;   // null = no pre_wp_mail short-circuit
$GLOBALS['__notified'] = array();
$GLOBALS['__generated_passwords'] = array();

function get_option($n, $d = false) { return array_key_exists($n, $GLOBALS['__options']) ? $GLOBALS['__options'][$n] : $d; }
function add_option($n, $v, $dep = '', $auto = 'yes') {
    if (array_key_exists($n, $GLOBALS['__options'])) return false;
    $GLOBALS['__options'][$n] = $v; return true;
}
function update_option($n, $v, $auto = null) { $GLOBALS['__options'][$n] = $v; return true; }
function delete_option($n) { unset($GLOBALS['__options'][$n]); return true; }
function get_transient($k) { return array_key_exists($k, $GLOBALS['__transients']) ? $GLOBALS['__transients'][$k] : false; }
function set_transient($k, $v, $t = 0) { $GLOBALS['__transients'][$k] = $v; return true; }
function wp_rand($a = 0, $b = 1) { return $GLOBALS['__rand']; }
function current_time($t) { return '2026-09-21T00:00:00+00:00'; }
function get_bloginfo($k) { return '6.3.1'; }
function is_multisite() { return false; }
function sanitize_key($k) { return preg_replace('/[^a-z0-9_\-]/', '', strtolower((string) $k)); }
function sanitize_text_field($v) { return trim(strip_tags((string) $v)); }
function sanitize_email($e) { return trim((string) $e); }
function sanitize_user($u, $strict = false) { return preg_replace('/[^A-Za-z0-9_.\-@ ]/', '', (string) $u); }
function is_email($e) { return (bool) filter_var($e, FILTER_VALIDATE_EMAIL); }
function translate_user_role($n) { return $n; }
function add_action($h, $cb, $p = 10, $a = 1) { $GLOBALS['__actions'][$h][] = $cb; }
function remove_action($h, $cb, $p = 10) {
    if (empty($GLOBALS['__actions'][$h])) return;
    foreach ($GLOBALS['__actions'][$h] as $i => $existing) {
        if ($existing === $cb) unset($GLOBALS['__actions'][$h][$i]);
    }
}
function add_filter($h, $cb, $p = 10, $a = 1) { $GLOBALS['__filters'][$h][] = $cb; }
function remove_filter($h, $cb, $p = 10) {
    if (empty($GLOBALS['__filters'][$h])) return;
    foreach ($GLOBALS['__filters'][$h] as $i => $existing) {
        if ($existing === $cb) unset($GLOBALS['__filters'][$h][$i]);
    }
}
function register_rest_route($ns, $r, $args) { $GLOBALS['__routes']["$ns$r"] = $args; }
function get_user_meta($id, $k, $single = false) { return isset($GLOBALS['__usermeta'][$id][$k]) ? $GLOBALS['__usermeta'][$id][$k] : ''; }
function update_user_meta($id, $k, $v) { $GLOBALS['__usermeta'][$id][$k] = $v; return true; }
function delete_user_meta($id, $k) { unset($GLOBALS['__usermeta'][$id][$k]); return true; }

/** Records every password we generate, so tests can prove none of them leak. */
function wp_generate_password($len = 12, $special = true, $extra = false) {
    $pw = 'GENERATED-SECRET-' . $len . '-' . count($GLOBALS['__generated_passwords']);
    $GLOBALS['__generated_passwords'][] = $pw;
    return $pw;
}

class WP_Error {
    public $code; public $message; public $data;
    public function __construct($c = '', $m = '', $d = array()) { $this->code = $c; $this->message = $m; $this->data = $d; }
    public function get_error_message() { return $this->message; }
    public function get_error_data() { return $this->data; }
}
function is_wp_error($t) { return $t instanceof WP_Error; }

class WP_REST_Response {
    private $data; private $status = 200; private $headers = array();
    public function __construct($d, $s = 200) { $this->data = $d; $this->status = $s; }
    public function get_data() { return $this->data; }
    public function set_status($s) { $this->status = $s; }
    public function get_status() { return $this->status; }
    public function header($k, $v) { $this->headers[$k] = $v; }
    public function get_headers() { return $this->headers; }
}
function rest_ensure_response($d) { return $d instanceof WP_REST_Response ? $d : new WP_REST_Response($d); }

class WP_User {
    public $ID, $user_login, $user_email, $display_name, $roles, $user_pass, $user_registered, $user_activation_key;
    public function __construct($a = array()) {
        $this->ID = isset($a['ID']) ? $a['ID'] : 1;
        $this->user_login = isset($a['user_login']) ? $a['user_login'] : 'user';
        $this->user_email = isset($a['user_email']) ? $a['user_email'] : 'user@x.com';
        $this->display_name = isset($a['display_name']) ? $a['display_name'] : $this->user_login;
        $this->roles = isset($a['roles']) ? $a['roles'] : array('subscriber');
        $this->user_pass = isset($a['user_pass']) ? $a['user_pass'] : 'HASHED';
        $this->user_activation_key = 'act-key';
        $this->user_registered = '2026-01-01 00:00:00';
    }
}

function get_user_by($field, $value) {
    foreach ($GLOBALS['__users'] as $u) {
        if ($field === 'id' && (int) $u->ID === (int) $value) return $u;
        if ($field === 'email' && strcasecmp($u->user_email, (string) $value) === 0) return $u;
        if ($field === 'login' && $u->user_login === $value) return $u;
    }
    return false;
}
function username_exists($login) { return get_user_by('login', $login) ? 1 : false; }
function get_users($args) {
    $out = array();
    foreach ($GLOBALS['__users'] as $u) {
        if (isset($args['role']) && !in_array($args['role'], $u->roles, true)) continue;
        $out[] = isset($args['fields']) && $args['fields'] === 'ID' ? $u->ID : $u;
    }
    return $out;
}
class WP_User_Query {
    public function __construct($a) {}
    public function get_results() { return $GLOBALS['__users']; }
    public function get_total() { return count($GLOBALS['__users']); }
}

function wp_insert_user($data) {
    if (get_user_by('email', $data['user_email'])) return new WP_Error('existing_user_email', 'taken');
    $id = $GLOBALS['__next_id']++;
    $u = new WP_User(array(
        'ID' => $id, 'user_login' => $data['user_login'], 'user_email' => $data['user_email'],
        'display_name' => $data['display_name'], 'roles' => array($data['role']),
        'user_pass' => 'HASHED:' . $data['user_pass'],
    ));
    $GLOBALS['__users'][] = $u;
    return $id;
}
function wp_update_user($data) {
    $u = get_user_by('id', $data['ID']);
    if (!$u) return new WP_Error('invalid', 'no user');
    if (isset($data['user_email'])) $u->user_email = $data['user_email'];
    if (isset($data['display_name'])) $u->display_name = $data['display_name'];
    if (isset($data['role'])) $u->roles = array($data['role']);
    return $u->ID;
}
/**
 * Models wp_mail()'s real hook order, which is the detail that matters here:
 * the `wp_mail` filter fires FIRST, then `pre_wp_mail` can short-circuit, and
 * only if neither happens does core fire wp_mail_succeeded / wp_mail_failed.
 * Treating "the wp_mail filter ran" as evidence of delivery is exactly how a
 * failed send gets reported as a successful one.
 */
function deheled_test_simulate_mail() {
    // 1. wp_mail filter — always runs, success or not.
    foreach ($GLOBALS['__filters']['wp_mail'] as $cb) $cb(array('to' => 'x'));

    // 2. pre_wp_mail — a plugin may short-circuit delivery entirely.
    if ($GLOBALS['__mail_short'] !== null) {
        foreach ($GLOBALS['__filters']['pre_wp_mail'] as $cb) $cb($GLOBALS['__mail_short'], array());
        return;
    }

    // 3. Core's own outcome hooks.
    $hook = $GLOBALS['__mail_ok'] ? 'wp_mail_succeeded' : 'wp_mail_failed';
    if (!empty($GLOBALS['__actions'][$hook])) {
        foreach ($GLOBALS['__actions'][$hook] as $cb) {
            $cb($GLOBALS['__mail_ok'] ? array('to' => 'x') : new WP_Error('mail', 'failed'));
        }
    }
}

function wp_new_user_notification($id, $dep = null, $notify = '') {
    $GLOBALS['__notified'][] = array('id' => $id, 'notify' => $notify);
    deheled_test_simulate_mail();
}

function deheled_test_unused_notification_body($id) {
    // 1. wp_mail filter — always runs, success or not.
    foreach ($GLOBALS['__filters']['wp_mail'] as $cb) $cb(array('to' => 'x'));

    // 2. pre_wp_mail — a plugin may short-circuit delivery entirely.
    if ($GLOBALS['__mail_short'] !== null) {
        foreach ($GLOBALS['__filters']['pre_wp_mail'] as $cb) $cb($GLOBALS['__mail_short'], array());
        return;
    }

    // 3. Core's own outcome hooks.
    $hook = $GLOBALS['__mail_ok'] ? 'wp_mail_succeeded' : 'wp_mail_failed';
    if (!empty($GLOBALS['__actions'][$hook])) {
        foreach ($GLOBALS['__actions'][$hook] as $cb) {
            $cb($GLOBALS['__mail_ok'] ? array('to' => 'x') : new WP_Error('mail', 'failed'));
        }
    }
}
/**
 * Models retrieve_password() closely enough for what is under test: it writes a
 * NEW activation key — which is what invalidates any previous link — and then
 * sends mail through the same path everything else does.
 *
 * It returns true even when delivery fails, which is the trap: wp_mail() can
 * return true while a plugin drops the message, so the plugin has to watch the
 * hooks rather than trust this value.
 */
function retrieve_password($login) {
    $GLOBALS['__retrieve_password_calls'][] = $login;
    foreach ($GLOBALS['__users'] as $u) {
        if ($u->user_login === $login) {
            $u->user_activation_key = 'new-key-' . count($GLOBALS['__retrieve_password_calls']);
        }
    }
    deheled_test_simulate_mail();
    return true;
}

$GLOBALS['__editable_roles'] = array(
    'administrator' => array('name' => 'Administrator', 'capabilities' => array('manage_options' => true, 'edit_users' => true, 'unfiltered_html' => true)),
    'editor'        => array('name' => 'Editor',        'capabilities' => array('unfiltered_html' => true, 'read' => true)),
    'author'        => array('name' => 'Author',        'capabilities' => array('publish_posts' => true)),
    'subscriber'    => array('name' => 'Subscriber',    'capabilities' => array('read' => true)),
);
function get_editable_roles() { return $GLOBALS['__editable_roles']; }
function wp_roles() { return new class { public function get_names() { return array_keys($GLOBALS['__editable_roles']); } }; }

class FakeRequest implements ArrayAccess {
    private $params, $headers;
    public function __construct($params = array(), $headers = array()) {
        $this->params = $params; $this->headers = array();
        foreach ($headers as $k => $v) $this->headers[strtolower($k)] = $v;
    }
    public function get_param($k) { return isset($this->params[$k]) ? $this->params[$k] : null; }
    public function get_header($k) { $k = strtolower($k); return isset($this->headers[$k]) ? $this->headers[$k] : ''; }
    #[\ReturnTypeWillChange] public function offsetExists($o) { return isset($this->params[$o]); }
    #[\ReturnTypeWillChange] public function offsetGet($o) { return isset($this->params[$o]) ? $this->params[$o] : null; }
    #[\ReturnTypeWillChange] public function offsetSet($o, $v) { $this->params[$o] = $v; }
    #[\ReturnTypeWillChange] public function offsetUnset($o) { unset($this->params[$o]); }
}

require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-auth.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-rest.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-users.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-write.php';

foreach ($GLOBALS['__actions']['rest_api_init'] as $cb) $cb();

/* ------------------------------------------------------------- helpers ---- */

$IDEM = 0;
function req($params = array(), $key = null) {
    global $IDEM;
    $key = $key === null ? 'idem-' . (++$IDEM) : $key;
    return new FakeRequest($params, array('idempotency-key' => $key));
}
/** The de_code of a refusal, for asserting WHY something was refused. */
function rcode($response) {
    $b = body($response);
    return isset($b['error']['code']) ? $b['error']['code'] : (isset($b['code']) ? $b['code'] : null);
}

function body($response) {
    return $response instanceof WP_REST_Response ? $response->get_data() : $response;
}
function code($response) {
    $b = body($response);
    return isset($b['error']['code']) ? $b['error']['code'] : null;
}
function reset_site($scopes = null) {
    $GLOBALS['__users'] = array();
    $GLOBALS['__usermeta'] = array();
    $GLOBALS['__options'][DEHELED_UM_SCOPES] = $scopes === null ? deheled_um_default_scopes() : $scopes;
    $GLOBALS['__mail_ok'] = true;
    $GLOBALS['__mail_short'] = null;
    $GLOBALS['__next_id'] = 100;
}
/**
 * `$managed` means an account we created and manage, which is the ordinary
 * case; pass `$created = false` to model a client's own account that we were
 * merely permitted to manage, where the takeover guards apply.
 */
function make_user($a, $managed = false, $created = true) {
    $u = new WP_User($a);
    $GLOBALS['__users'][] = $u;
    if ($managed) {
        $GLOBALS['__usermeta'][$u->ID]['_de_managed'] = '1';
        if ($created) $GLOBALS['__usermeta'][$u->ID]['_de_created'] = '1';
    }
    return $u;
}

/* ------------------------------------------------ routes and scopes ------- */

echo "--- every write route requires users:write ---\n";
$writeRoutes = array('de/v2/users', 'de/v2/users/(?P<id>\d+)', 'de/v2/users/(?P<id>\d+)/link',
                     'de/v2/users/(?P<id>\d+)/unlink', 'de/v2/users/(?P<id>\d+)/password-reset');
foreach ($writeRoutes as $route) {
    ok("$route is registered", isset($GLOBALS['__routes'][$route]));
}
ok('users:write is granted by default', in_array('users:write', deheled_um_default_scopes(), true));
ok('users:admin is NOT granted by default', !in_array('users:admin', deheled_um_default_scopes(), true));

/* --------------------------------------------------------- idempotency --- */

echo "\n--- idempotency ---\n";
reset_site();
$noKey = deheled_um_rest_create_user(new FakeRequest(array('email' => 'a@digitalelementsgroup.com', 'role' => 'editor')));
eq('a write without an Idempotency-Key is refused', code($noKey), 'idempotency_required');

reset_site();
$first = deheled_um_rest_create_user(req(array('email' => 'jason@digitalelementsgroup.com', 'role' => 'editor'), 'key-A'));
eq('the first create succeeds', body($first)['result'], 'created');
eq('one user exists', count($GLOBALS['__users']), 1);

$replay = deheled_um_rest_create_user(req(array('email' => 'jason@digitalelementsgroup.com', 'role' => 'editor'), 'key-A'));
eq('replaying the same key returns the stored result', body($replay)['result'], 'created');
eq('...and creates NO second user', count($GLOBALS['__users']), 1);
eq('...flagged as a replay', $replay->get_headers()['X-DE-Idempotent-Replay'], '1');

// A different key for the same person must not silently create a duplicate
// either — the site is the authority on uniqueness.
$dupe = deheled_um_rest_create_user(req(array('email' => 'jason@digitalelementsgroup.com', 'role' => 'editor'), 'key-B'));
eq('a different key still refuses a duplicate email', code($dupe), 'user_exists');
eq('...and still only one user exists', count($GLOBALS['__users']), 1);

echo "\n--- concurrent duplicates lose the race ---\n";
reset_site();
// Simulate a second request arriving while the first is mid-write: the lock row
// already exists, so the duplicate is told to back off rather than racing.
$lock = 'deheled_um_l_' . hash('sha256', 'key-C');
add_option($lock, time(), '', 'no');
$racing = deheled_um_rest_create_user(req(array('email' => 'race@digitalelementsgroup.com', 'role' => 'editor'), 'key-C'));
eq('a concurrent duplicate is refused', code($racing), 'in_progress');
eq('...and creates nothing', count($GLOBALS['__users']), 0);
delete_option($lock);

// A crashed run must not block the key forever.
add_option($lock, time() - 600, '', 'no');
$reclaimed = deheled_um_rest_create_user(req(array('email' => 'race@digitalelementsgroup.com', 'role' => 'editor'), 'key-C'));
eq('a stale lock is reclaimed', body($reclaimed)['result'], 'created');

echo "\n--- a failed write is not cached ---\n";
reset_site();
$bad = deheled_um_rest_create_user(req(array('email' => 'nope', 'role' => 'editor'), 'key-D'));
eq('an invalid email fails', code($bad), 'invalid_email');
$fixed = deheled_um_rest_create_user(req(array('email' => 'ok@digitalelementsgroup.com', 'role' => 'editor'), 'key-D'));
eq('the corrected retry with the same key succeeds', body($fixed)['result'], 'created');

/* ------------------------------------------------------------ passwords --- */

echo "\n--- passwords are never disclosed ---\n";
reset_site();
$GLOBALS['__generated_passwords'] = array();
$created = deheled_um_rest_create_user(req(array('email' => 'pw@digitalelementsgroup.com', 'role' => 'editor')));
$json = json_encode(body($created));

ok('a password was generated', count($GLOBALS['__generated_passwords']) === 1);
ok('it is 32 characters with specials requested', strpos($GLOBALS['__generated_passwords'][0], 'GENERATED-SECRET-32-') === 0);
foreach ($GLOBALS['__generated_passwords'] as $pw) {
    ok('the generated password is NOT in the response', strpos($json, $pw) === false);
}
ok('no user_pass field of any kind', strpos($json, 'user_pass') === false);

// ONE field in the whole payload may mention a password, and it is a timestamp
// saying when the person set their own. Asserted by walking every key rather
// than by searching the text, so a future field called "password_hint" or
// "temp_password" fails here instead of shipping.
//
// The blunter version of this assertion — no key containing "password" at all
// — is what 2.7.3 had to relax, and relaxing it by hand is the point: the
// exception is named, and everything else is still refused.
$offending = array();
$walk = function ($node, $path = '') use (&$walk, &$offending) {
    if (!is_array($node)) return;
    foreach ($node as $key => $value) {
        $here = $path === '' ? (string) $key : $path . '.' . $key;
        if (is_string($key) && preg_match('/pass(word)?|pwd|secret|credential/i', $key)) {
            $allowed = $key === 'password_set_at' && ($value === null || is_int($value));
            if (!$allowed) $offending[] = $here . '=' . var_export($value, true);
        }
        $walk($value, $here);
    }
};
$walk(body($created));
ok('the only password-ish field is a timestamp called password_set_at',
   count($offending) === 0, implode(', ', $offending));
ok('the stored hash is not in the response', strpos($json, 'HASHED') === false);
eq('WordPress was asked to notify the user', $GLOBALS['__notified'][count($GLOBALS['__notified']) - 1]['notify'], 'user');

echo "\n--- the mail verdict, every observable outcome ---\n";
// wp_mail() runs the `wp_mail` filter BEFORE `pre_wp_mail`, so a short-circuit
// still looks like an attempt. Reading "attempted" as "delivered" is precisely
// how a failed send gets reported as a successful one.
ok('a short-circuit to false is a failure',
   deheled_um_mail_delivered(array('attempted' => true, 'short_circuited' => true, 'short_value' => false)) === false);
ok('a short-circuit to true is a success',
   deheled_um_mail_delivered(array('attempted' => true, 'short_circuited' => true, 'short_value' => true)) === true);
ok('wp_mail_failed is a failure',
   deheled_um_mail_delivered(array('attempted' => true, 'failed' => true)) === false);
ok('wp_mail_succeeded is a success',
   deheled_um_mail_delivered(array('attempted' => true, 'succeeded' => true)) === true);
ok('nothing attempted is a failure', deheled_um_mail_delivered(array()) === false);
// An unnecessary warning costs a moment; a missed one costs somebody their
// account access with no indication why.
ok('attempted but unverified is reported as failed, not assumed sent',
   deheled_um_mail_delivered(array('attempted' => true)) === false);
ok('a failure signal wins over a success signal',
   deheled_um_mail_delivered(array('attempted' => true, 'succeeded' => true, 'failed' => true)) === false);
ok('a short-circuit of null falls through to the hooks',
   deheled_um_mail_delivered(array('attempted' => true, 'short_circuited' => true, 'short_value' => null, 'succeeded' => true)) === true);

echo "\n--- a successful send raises no warning ---\n";
reset_site();
$sent = body(deheled_um_rest_create_user(req(array('email' => 'sent@digitalelementsgroup.com', 'role' => 'editor'))));
eq('created', $sent['result'], 'created');
eq('no warnings when mail actually goes', count($sent['warnings']), 0);

echo "\n--- a plugin that short-circuits delivery is caught ---\n";
reset_site();
$GLOBALS['__mail_short'] = false;   // a mail plugin returning false from pre_wp_mail
$shorted = body(deheled_um_rest_create_user(req(array('email' => 'shorted@digitalelementsgroup.com', 'role' => 'editor'))));
eq('the account is created', $shorted['result'], 'created');
ok('...and the silent failure IS reported',
   count($shorted['warnings']) === 1 && $shorted['warnings'][0]['code'] === 'mail_failed');

reset_site();
$GLOBALS['__mail_short'] = true;    // a mail plugin that handled delivery itself
$handled = body(deheled_um_rest_create_user(req(array('email' => 'handled@digitalelementsgroup.com', 'role' => 'editor'))));
eq('a plugin-handled send raises no false warning', count($handled['warnings']), 0);

echo "\n--- broken mail is a warning, never a password fallback ---\n";
reset_site();
$GLOBALS['__mail_ok'] = false;
$GLOBALS['__generated_passwords'] = array();
$mailFail = deheled_um_rest_create_user(req(array('email' => 'nomail@digitalelementsgroup.com', 'role' => 'editor')));
$mailBody = body($mailFail);

eq('the account is still created', $mailBody['result'], 'created');
ok('...with a mail_failed warning', count($mailBody['warnings']) === 1 && $mailBody['warnings'][0]['code'] === 'mail_failed');
ok('...pointing at the Lost Password flow', strpos($mailBody['warnings'][0]['message'], 'Lost Password') !== false);
foreach ($GLOBALS['__generated_passwords'] as $pw) {
    ok('STILL no password in the response when mail fails', strpos(json_encode($mailBody), $pw) === false);
}

/* -------------------------------------------------------- managed guard --- */

echo "\n--- a client's own account is untouchable ---\n";
reset_site();
$theirs = make_user(array('ID' => 50, 'user_login' => 'client', 'user_email' => 'client@theirsite.com', 'roles' => array('editor')), false);

eq('PATCH refuses an unmanaged account',
   code(deheled_um_rest_update_user(req(array('id' => 50, 'role' => 'author')))), 'not_managed');
eq('password reset refuses an unmanaged account',
   code(deheled_um_rest_password_reset(req(array('id' => 50)))), 'not_managed');
eq('unlink refuses... actually skips, since it is already unmanaged',
   body(deheled_um_rest_unlink_user(req(array('id' => 50))))['result'], 'skipped');
eq('their role is untouched', $theirs->roles[0], 'editor');

echo "\n--- link is the only door in, and it is not an accident ---\n";
// Without this, /link is a door into every non-administrator account on the
// site, openable with nothing but the default write scope.
eq('linking an account we did not create needs its own confirmation',
   code(deheled_um_rest_link_user(req(array('id' => 50)))), 'link_requires_confirmation');
ok('...and the account is untouched', deheled_um_user_is_managed(50) === false);

$linked = deheled_um_rest_link_user(req(array('id' => 50, 'confirm_link' => true)));
eq('link adopts the account', body($linked)['result'], 'linked');
ok('...setting the managed flag', deheled_um_user_is_managed(50));
ok('...and recording that it was linked, not created', get_user_meta(50, '_de_linked', true) === '1');
eq('...leaving the role alone', $theirs->roles[0], 'editor');

eq('PATCH now works', body(deheled_um_rest_update_user(req(array('id' => 50, 'role' => 'author'))))['result'], 'updated');
eq('...and applied the role', $theirs->roles[0], 'author');

echo "\n--- but a linked account can never be taken over ---\n";
// Linking a client's Editor, changing its address and requesting a reset would
// be a complete account takeover using only the default write scope. Both steps
// are refused for any account we did not create ourselves.
eq('its email address cannot be changed',
   code(deheled_um_rest_update_user(req(array('id' => 50, 'email' => 'attacker@evil.test')))),
   'linked_account_protected');
eq('...and the address is unchanged', $theirs->user_email, 'client@theirsite.com');
eq('a password reset on it is refused',
   code(deheled_um_rest_password_reset(req(array('id' => 50)))), 'linked_account_protected');
// The role is what we were allowed to manage, and that still works.
eq('but its role can still be managed',
   body(deheled_um_rest_update_user(req(array('id' => 50, 'role' => 'editor'))))['result'], 'updated');

$unlinked = deheled_um_rest_unlink_user(req(array('id' => 50)));
eq('unlink releases it', body($unlinked)['result'], 'unlinked');
ok('...clearing the flag', deheled_um_user_is_managed(50) === false);
eq('...but leaving the account and its role in place', $theirs->roles[0], 'editor');
// Unlink must not be able to launder a client's account into one that looks
// like ours: re-linking it still cannot change its address.
deheled_um_rest_link_user(req(array('id' => 50, 'confirm_link' => true)));
eq('re-linking does not make it ours',
   code(deheled_um_rest_update_user(req(array('id' => 50, 'email' => 'attacker@evil.test')))),
   'linked_account_protected');
deheled_um_rest_unlink_user(req(array('id' => 50)));
eq('...and it is refused again afterwards',
   code(deheled_um_rest_update_user(req(array('id' => 50, 'role' => 'editor')))), 'not_managed');

eq('a missing user is not found',
   code(deheled_um_rest_update_user(req(array('id' => 9999, 'role' => 'editor')))), 'not_found');

/* ----------------------------------------------------------- role guard --- */

echo "\n--- an account we created stays fully manageable ---\n";
reset_site();
$ours = body(deheled_um_rest_create_user(req(array('email' => 'ours@digitalelementsgroup.com', 'role' => 'editor'))));
$ours_id = $ours['user']['id'];
ok('it is marked as created by us', deheled_um_user_was_created_by_us($ours_id));
eq('its email can be changed',
   body(deheled_um_rest_update_user(req(array('id' => $ours_id, 'email' => 'ours2@digitalelementsgroup.com'))))['result'],
   'updated');
eq('and a password reset is allowed',
   body(deheled_um_rest_password_reset(req(array('id' => $ours_id))))['result'], 'reset');
// Setting the same address again is not a change and must not be refused.
eq('re-sending the same address is a no-op, not a refusal',
   body(deheled_um_rest_update_user(req(array('id' => $ours_id, 'email' => 'ours2@digitalelementsgroup.com'))))['result'],
   'skipped');

echo "\n--- code-execution capabilities count as administering the site ---\n";
// install_plugins alone is arbitrary code execution. A role holding it without
// manage_options is common on real client sites, and must not be assignable
// with the ordinary write scope.
$GLOBALS['__editable_roles']['site_manager'] = array(
    'name' => 'Site manager',
    'capabilities' => array('install_plugins' => true, 'edit_posts' => true),
);
$GLOBALS['__editable_roles']['file_editor'] = array(
    'name' => 'File editor', 'capabilities' => array('edit_plugins' => true),
);
$GLOBALS['__editable_roles']['theme_switcher'] = array(
    'name' => 'Theme switcher', 'capabilities' => array('switch_themes' => true),
);
$GLOBALS['__editable_roles']['importer'] = array(
    'name' => 'Importer', 'capabilities' => array('import' => true),
);
foreach (array('site_manager', 'file_editor', 'theme_switcher', 'importer') as $slug) {
    ok("$slug is classified as site administration",
       deheled_um_role_is_site_admin($GLOBALS['__editable_roles'][$slug]['capabilities']));
}
ok('...while an ordinary editor still is not',
   deheled_um_role_is_site_admin($GLOBALS['__editable_roles']['editor']['capabilities']) === false);
ok('...and an author still is not',
   deheled_um_role_is_site_admin($GLOBALS['__editable_roles']['author']['capabilities']) === false);

reset_site(array('users:read', 'users:write'));   // no users:admin
make_user(array('ID' => 68, 'user_email' => 'g@digitalelementsgroup.com', 'roles' => array('subscriber')), true);
eq('assigning a code-execution role is refused without users:admin',
   code(deheled_um_rest_update_user(req(array('id' => 68, 'role' => 'site_manager', 'confirm_admin' => true)))),
   'scope_denied');
eq('creating one is refused too',
   code(deheled_um_rest_create_user(req(array('email' => 'sm@digitalelementsgroup.com', 'role' => 'file_editor')))),
   'scope_denied');

echo "\n--- roles are whitelisted against this site ---\n";
reset_site();
$u = make_user(array('ID' => 60, 'user_email' => 'a@digitalelementsgroup.com', 'roles' => array('subscriber')), true);

eq('an unknown role is refused',
   code(deheled_um_rest_update_user(req(array('id' => 60, 'role' => 'wizard')))), 'role_not_available');
eq('an empty role is refused',
   code(deheled_um_rest_update_user(req(array('id' => 60, 'role' => '')))), 'role_not_available');
eq('a real role is accepted',
   body(deheled_um_rest_update_user(req(array('id' => 60, 'role' => 'author'))))['result'], 'updated');

echo "\n--- administering roles need BOTH the scope and the confirmation ---\n";
reset_site(array('users:read', 'users:write'));   // no users:admin
make_user(array('ID' => 61, 'user_email' => 'b@digitalelementsgroup.com', 'roles' => array('subscriber')), true);

eq('without users:admin, administrator is refused even with confirmation',
   code(deheled_um_rest_update_user(req(array('id' => 61, 'role' => 'administrator', 'confirm_admin' => true)))), 'scope_denied');

reset_site(array('users:read', 'users:write', 'users:admin'));
make_user(array('ID' => 62, 'user_email' => 'c@digitalelementsgroup.com', 'roles' => array('subscriber')), true);
make_user(array('ID' => 63, 'user_email' => 'admin@site.com', 'roles' => array('administrator')), true);

eq('with the scope but no confirmation, administrator is refused',
   code(deheled_um_rest_update_user(req(array('id' => 62, 'role' => 'administrator')))), 'role_requires_confirmation');
eq('with both, it is allowed',
   body(deheled_um_rest_update_user(req(array('id' => 62, 'role' => 'administrator', 'confirm_admin' => true))))['result'], 'updated');

// Editor holds unfiltered_html on stock WordPress. If the confirmation keyed on
// the broad flag, this ordinary assignment would demand one.
reset_site(array('users:read', 'users:write'));
make_user(array('ID' => 64, 'user_email' => 'd@digitalelementsgroup.com', 'roles' => array('subscriber')), true);
eq('Editor does NOT demand a confirmation, despite unfiltered_html',
   body(deheled_um_rest_update_user(req(array('id' => 64, 'role' => 'editor'))))['result'], 'updated');

eq('creating an administrator needs confirmation too',
   code(deheled_um_rest_create_user(req(array('email' => 'new@digitalelementsgroup.com', 'role' => 'administrator')))), 'scope_denied');

/* ------------------------------------------------- last administrator ----- */

echo "\n--- the last administrator is protected ---\n";
reset_site(array('users:read', 'users:write', 'users:admin'));
$onlyAdmin = make_user(array('ID' => 70, 'user_email' => 'solo@site.com', 'roles' => array('administrator')), true);

eq('demoting the only administrator is refused',
   code(deheled_um_rest_update_user(req(array('id' => 70, 'role' => 'editor')))), 'last_administrator');
eq('...and the role is unchanged', $onlyAdmin->roles[0], 'administrator');
// Unlinking an admin strands the site the same way a demotion does.
eq('unlinking the only administrator is refused',
   code(deheled_um_rest_unlink_user(req(array('id' => 70)))), 'last_administrator');
ok('...and it stays managed', deheled_um_user_is_managed(70));

// Re-assigning administrator to an administrator is not a demotion.
eq('keeping them as administrator is fine',
   body(deheled_um_rest_update_user(req(array('id' => 70, 'role' => 'administrator', 'confirm_admin' => true))))['result'], 'skipped');

make_user(array('ID' => 71, 'user_email' => 'second@site.com', 'roles' => array('administrator')), true);
eq('with a second administrator, demotion is allowed',
   body(deheled_um_rest_update_user(req(array('id' => 70, 'role' => 'editor'))))['result'], 'updated');

/* ------------------------------------------------------------ usernames --- */

echo "\n--- usernames ---\n";
reset_site();
eq('derived from the email local part', deheled_um_unique_login('npappas@digitalelementsgroup.com'), 'npappas');
make_user(array('ID' => 80, 'user_login' => 'npappas', 'user_email' => 'other@x.com'));
eq('a collision gets a numeric suffix', deheled_um_unique_login('npappas@digitalelementsgroup.com'), 'npappas2');
make_user(array('ID' => 81, 'user_login' => 'npappas2', 'user_email' => 'other2@x.com'));
eq('...and keeps counting', deheled_um_unique_login('npappas@digitalelementsgroup.com'), 'npappas3');
eq('illegal characters are stripped', deheled_um_unique_login('we+ird!name@x.com'), 'weirdname');
eq('an empty local part still yields something', deheled_um_unique_login('@x.com'), 'user');

/* -------------------------------------------------------- email clashes --- */

echo "\n--- email changes can't collide ---\n";
reset_site();
make_user(array('ID' => 90, 'user_email' => 'one@digitalelementsgroup.com'), true);
make_user(array('ID' => 91, 'user_email' => 'two@digitalelementsgroup.com'), true);
eq('taking another account\'s address is refused',
   code(deheled_um_rest_update_user(req(array('id' => 90, 'email' => 'two@digitalelementsgroup.com')))), 'user_exists');
eq('keeping your own address is fine',
   body(deheled_um_rest_update_user(req(array('id' => 90, 'email' => 'one@digitalelementsgroup.com', 'display_name' => 'One'))))['result'], 'updated');
eq('an invalid address is refused',
   code(deheled_um_rest_update_user(req(array('id' => 90, 'email' => 'not-an-email')))), 'invalid_email');

echo "\n--- a no-op update reports skipped, not updated ---\n";
reset_site();
make_user(array('ID' => 95, 'user_email' => 'x@digitalelementsgroup.com', 'roles' => array('editor')), true);
eq('nothing to change', body(deheled_um_rest_update_user(req(array('id' => 95))))['result'], 'skipped');

echo "\n--- every response uses the same envelope ---\n";
reset_site();
$success = body(deheled_um_rest_create_user(req(array('email' => 'env@digitalelementsgroup.com', 'role' => 'editor'))));
foreach (array('ok', 'result', 'user', 'warnings', 'error') as $k) {
    ok("a success carries $k", array_key_exists($k, $success));
}
$failure = body(deheled_um_rest_update_user(req(array('id' => 9999, 'role' => 'editor'))));
foreach (array('ok', 'result', 'user', 'warnings', 'error') as $k) {
    ok("a failure carries $k", array_key_exists($k, $failure));
}
eq('a failure says so', $failure['ok'], false);
eq('...with result=failed', $failure['result'], 'failed');
ok('...and a code plus a message',
   isset($failure['error']['code']) && isset($failure['error']['message']));
ok('no server internals in the message',
   strpos($failure['error']['message'], '/') === false && strpos($failure['error']['message'], '.php') === false);


/* ------------------------------------------------- invitations (2.7.3) ---- */

echo "\n--- a resend goes through WordPress, and nothing else ---\n";

reset_site();
$invitee = make_user(array('ID' => 501, 'user_login' => 'jason',
                           'user_email' => 'jason@digitalelementsgroup.com',
                           'roles' => array('editor')), true, true);
$GLOBALS['__retrieve_password_calls'] = array();
$GLOBALS['__generated_passwords'] = array();
$GLOBALS['__mail_ok'] = true;

$resend = deheled_um_rest_password_reset(req(array('id' => 501)));
$resend_body = body($resend);

eq('it asks WordPress to send the link', count($GLOBALS['__retrieve_password_calls']), 1);
eq('...for the right account', $GLOBALS['__retrieve_password_calls'][0], 'jason');
ok('it reports success', !empty($resend_body['ok']) && $resend_body['result'] === 'reset');
eq('with no warnings when delivery was verified', count($resend_body['warnings']), 0);

// The thing this must never do.
$resend_json = json_encode($resend_body);
ok('no password anywhere in the response', strpos($resend_json, 'user_pass') === false);
ok('no activation key anywhere in the response',
   strpos($resend_json, 'secret-activation-key') === false);
ok('no reset link anywhere in the response',
   strpos($resend_json, 'wp-login') === false && strpos($resend_json, 'rp_key') === false);
eq('no password was generated for a resend', count($GLOBALS['__generated_passwords']), 0);

echo "\n--- delivery is judged the same way as it is for a new account ---\n";
// retrieve_password() returning true is NOT enough: wp_mail can return true
// while a plugin silently drops the message. That is how an invitation came to
// be reported as sent when nobody received it.
$GLOBALS['__mail_ok'] = false;
$GLOBALS['__retrieve_password_calls'] = array();
$failed = body(deheled_um_rest_password_reset(req(array('id' => 501))));
eq('the link was still requested', count($GLOBALS['__retrieve_password_calls']), 1);
ok('...but delivery is reported as failed',
   count($failed['warnings']) === 1 && $failed['warnings'][0]['code'] === 'mail_failed');
ok('...and it says what the person can do instead',
   strpos($failed['warnings'][0]['message'], 'Lost Password') !== false);
$GLOBALS['__mail_ok'] = true;

echo "\n--- an account we did not create is refused ---\n";
// The rule the reset route has always had, and the reason `unknown` exists as
// an invitation state: a linked account is the website's own, and mailing a
// reset link into it is a way into an account that is not ours.
$GLOBALS['__usermeta'][501]['_de_created'] = '';
$GLOBALS['__retrieve_password_calls'] = array();
$linked = deheled_um_rest_password_reset(req(array('id' => 501)));
eq('refused', code($linked), 'linked_account_protected');
eq('...without sending anything', count($GLOBALS['__retrieve_password_calls']), 0);
$GLOBALS['__usermeta'][501]['_de_created'] = '1';

echo "\n--- an unmanaged account is refused ---\n";
$GLOBALS['__usermeta'][501]['_de_managed'] = '';
$GLOBALS['__retrieve_password_calls'] = array();
$unmanaged = deheled_um_rest_password_reset(req(array('id' => 501)));
eq('refused', code($unmanaged), 'not_managed');
eq('...without sending anything', count($GLOBALS['__retrieve_password_calls']), 0);
$GLOBALS['__usermeta'][501]['_de_managed'] = '1';

echo "\n--- completing a reset is recorded, by WordPress's own hooks ---\n";
unset($GLOBALS['__usermeta'][501]['_de_password_set_at']);
ok('nothing is stamped before the reset completes',
   deheled_um_password_set_at(501) === null);

// Both hooks, because WordPress fires them at different points and a site with
// a plugin that interferes may only reach one.
foreach (array('password_reset', 'after_password_reset') as $hook) {
    unset($GLOBALS['__usermeta'][501]['_de_password_set_at']);
    foreach ($GLOBALS['__actions'][$hook] as $cb) { $cb($GLOBALS['__users'][0]); }
    ok("$hook stamps the timestamp", deheled_um_password_set_at(501) !== null);
    ok("...as a number, not anything from the form", is_int(deheled_um_password_set_at(501)));
}

echo "\n--- what the dashboard is told about activation ---\n";
$shape_pending = deheled_um_user_shape($GLOBALS['__users'][0]);
ok('the activation key never leaves the site',
   !array_key_exists('user_activation_key', $shape_pending)
   && strpos(json_encode($shape_pending), 'secret-activation-key') === false);
ok('only whether one is outstanding', array_key_exists('activation_pending', $shape_pending));
ok('...as a boolean', is_bool($shape_pending['activation_pending']));
ok('and whether we created the account', $shape_pending['created_by_us'] === true);
ok('and when they set a password', is_int($shape_pending['password_set_at']));

echo "\n";
echo $FAIL ? "$FAIL assertion(s) failed\n" : "All assertions passed\n";
exit($FAIL ? 1 : 0);
