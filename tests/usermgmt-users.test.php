<?php
/**
 * Tests for the de/v2 read endpoints (includes/um-users.php).
 *
 * Two things are worth asserting without a WordPress install:
 *
 * 1. Every route declares the users:read scope, so none of them can be reached
 *    by a credential that wasn't granted it. A route registered without a scope
 *    would be authorized by the signature alone, which is exactly the "holds a
 *    secret" model the whole design avoids.
 *
 * 2. A user leaving this site carries only the fields we chose. WP_User exposes
 *    the password hash, the activation key and every meta value; the shape
 *    function is an allow-list precisely so a future WordPress release can't
 *    widen what we disclose, and that property is what this file pins down.
 *
 * Route registration against a real WordPress install is covered by
 * scripts/live-usermgmt-check.php.
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
$GLOBALS['__routes'] = array();
$GLOBALS['__rand'] = 2;

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
function is_email($e) { return (bool) filter_var($e, FILTER_VALIDATE_EMAIL); }
function translate_user_role($n) { return $n; }
function add_action($hook, $cb, $prio = 10, $args = 1) { $GLOBALS['__actions'][$hook][] = $cb; }
function rest_ensure_response($d) { return $d; }
function get_user_meta($id, $key, $single = false) {
    return isset($GLOBALS['__usermeta'][$id][$key]) ? $GLOBALS['__usermeta'][$id][$key] : '';
}
function register_rest_route($ns, $route, $args) { $GLOBALS['__routes']["$ns$route"] = $args; }

class WP_Error {
    public $code; public $message; public $data;
    public function __construct($c = '', $m = '', $d = array()) { $this->code = $c; $this->message = $m; $this->data = $d; }
    public function get_error_message() { return $this->message; }
    public function get_error_data() { return $this->data; }
}

/** A WP_User carrying the fields a real one does — including the dangerous ones. */
class WP_User {
    public $ID, $user_login, $user_email, $display_name, $roles;
    public $user_pass, $user_activation_key, $user_nicename, $user_url, $user_status, $user_registered;
    public function __construct($over = array()) {
        $this->ID = 7;
        $this->user_login = 'jason';
        $this->user_email = 'jason@digitalelementsgroup.com';
        $this->display_name = 'Jason';
        $this->roles = array('editor');
        $this->user_registered = '2026-01-02 03:04:05';
        // The fields that must never leave the site.
        $this->user_pass = '$P$BsupersecrethashvalueXYZ';
        $this->user_activation_key = 'secret-activation-key-123';
        $this->user_nicename = 'jason';
        $this->user_url = '';
        $this->user_status = 0;
        foreach ($over as $k => $v) $this->$k = $v;
    }
}

$GLOBALS['__users'] = array();
function get_user_by($field, $value) {
    foreach ($GLOBALS['__users'] as $u) {
        if ($field === 'email' && strcasecmp($u->user_email, $value) === 0) return $u;
        if ($field === 'login' && $u->user_login === $value) return $u;
    }
    return false;
}
function get_users($args) { return array(1, 2); } // two administrators

class WP_User_Query {
    private $args;
    public function __construct($args) { $this->args = $args; $GLOBALS['__last_query'] = $args; }
    public function get_results() { return $GLOBALS['__users']; }
    public function get_total() { return count($GLOBALS['__users']); }
}

$GLOBALS['__editable_roles'] = array(
    'administrator' => array('name' => 'Administrator', 'capabilities' => array('manage_options' => true, 'edit_users' => true, 'read' => true)),
    'editor'        => array('name' => 'Editor',        'capabilities' => array('edit_others_posts' => true, 'read' => true)),
    'author'        => array('name' => 'Author',        'capabilities' => array('publish_posts' => true, 'read' => true)),
    'contributor'   => array('name' => 'Contributor',   'capabilities' => array('edit_posts' => true, 'read' => true)),
    'subscriber'    => array('name' => 'Subscriber',    'capabilities' => array('read' => true)),
    'shop_manager'  => array('name' => 'Shop manager',  'capabilities' => array('manage_woocommerce' => true, 'read' => true)),
    'seo_editor'    => array('name' => 'SEO editor',    'capabilities' => array('unfiltered_html' => true, 'read' => true)),
);
function get_editable_roles() { return $GLOBALS['__editable_roles']; }
function wp_roles() { return new class { public function get_names() { return array_keys($GLOBALS['__editable_roles']); } }; }

class FakeRequest {
    private $params, $headers, $method, $route, $body;
    public function __construct($params = array(), $method = 'GET', $route = '/de/v2/users', $headers = array(), $body = '') {
        $this->params = $params; $this->method = $method; $this->route = $route; $this->body = $body;
        $this->headers = array();
        foreach ($headers as $k => $v) $this->headers[strtolower($k)] = $v;
    }
    public function get_param($k) { return isset($this->params[$k]) ? $this->params[$k] : null; }
    public function get_header($k) { $k = strtolower($k); return isset($this->headers[$k]) ? $this->headers[$k] : ''; }
    public function set_header($k, $v) { $this->headers[strtolower($k)] = $v; return $this; }
    public function get_method() { return $this->method; }
    public function get_route() { return $this->route; }
    public function get_query_params() { return $this->params; }
    public function get_body() { return $this->body; }
}

require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-auth.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-rest.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-users.php';

// Run the rest_api_init callbacks the plugin registered.
foreach ($GLOBALS['__actions']['rest_api_init'] as $cb) $cb();

/* ------------------------------------------------- scope enforcement ------ */

echo "--- every read route requires the users:read scope ---\n";
$expected = array('de/v2/roles', 'de/v2/users', 'de/v2/users/lookup');
foreach ($expected as $route) {
    ok("$route is registered", isset($GLOBALS['__routes'][$route]));
}

// The permission callbacks are closures built by deheled_um_permission($scope).
// Rather than reach inside them, drive each one with a credential that has
// every scope except users:read and assert it is refused.
$SECRET = 'read-path-secret';
$KEY = 'dek_readpath01';
$GLOBALS['__options'][DEHELED_UM_KEY_ID] = $KEY;
$GLOBALS['__options'][DEHELED_UM_SECRET] = $SECRET;

function signed($route, $params = array(), $method = 'GET') {
    global $SECRET, $KEY;
    $ts = time();
    $nonce = 'n-' . mt_rand() . '-' . microtime(true);
    $canonical = deheled_um_canonical_string($method, $route, $params, $ts, $nonce, '', '');
    $sig = base64_encode(hash_hmac('sha256', $canonical, $SECRET, true));
    return new FakeRequest($params, $method, $route, array(
        'x-de-key-id' => $KEY,
        'x-de-timestamp' => (string) $ts,
        'x-de-nonce' => $nonce,
        'x-de-signature' => DEHELED_UM_SIG_VERSION . ' ' . $sig,
    ));
}
function err_code($r) {
    if (!($r instanceof WP_Error)) return null;
    $d = $r->get_error_data();
    return isset($d['de_code']) ? $d['de_code'] : null;
}

foreach ($expected as $route) {
    $cb = $GLOBALS['__routes'][$route]['permission_callback'];
    ok("$route has a callable permission callback", is_callable($cb));

    // Granted everything except users:read.
    $GLOBALS['__options'][DEHELED_UM_SCOPES] = array('users:write', 'users:delete', 'users:admin', 'content:reassign');
    eq("$route refuses a credential without users:read",
        err_code($cb(signed('/' . $route))), 'scope_denied');

    // Granted users:read only.
    $GLOBALS['__options'][DEHELED_UM_SCOPES] = array('users:read');
    ok("$route accepts a credential with users:read", $cb(signed('/' . $route)) === true);
}

$GLOBALS['__options'][DEHELED_UM_SCOPES] = deheled_um_default_scopes();
ok("users:read is granted by default at enrollment",
   in_array('users:read', deheled_um_default_scopes(), true));

/* ------------------------------------------------------ the user shape ---- */

echo "\n--- a user never leaves the site with sensitive fields ---\n";
$GLOBALS['__users'] = array(new WP_User());
$GLOBALS['__usermeta'][7] = array('_de_managed' => '1', 'first_name' => 'Jason', 'last_name' => 'R');

$shape = deheled_um_user_shape($GLOBALS['__users'][0]);
$json = json_encode($shape);

eq("exactly the intended fields, and no others",
   implode(',', array_keys($shape)),
   'id,login,email,display_name,roles,managed,registered,is_admin_like,is_site_admin');

foreach (array('user_pass', 'user_activation_key', 'user_status', 'user_nicename', 'user_url') as $forbidden) {
    ok("$forbidden is absent", !array_key_exists($forbidden, $shape));
}
ok("the password hash is nowhere in the payload", strpos($json, 'supersecrethash') === false);
ok("the activation key is nowhere in the payload", strpos($json, 'secret-activation-key') === false);

eq("id is an int", $shape['id'], 7);
eq("login", $shape['login'], 'jason');
eq("email", $shape['email'], 'jason@digitalelementsgroup.com');
eq("roles is a list", implode(',', $shape['roles']), 'editor');
eq("managed reflects the meta flag", $shape['managed'], true);
eq("registered is reported", $shape['registered'], '2026-01-02 03:04:05');

// _de_managed is the ONLY user meta this endpoint reads, so nothing else in
// the meta table can reach a response — not even innocuous fields.
$GLOBALS['__usermeta'][7]['session_tokens'] = 'a:1:{s:4:"tok";}';
$GLOBALS['__usermeta'][7]['secret_client_note'] = 'do not share';
$GLOBALS['__usermeta'][7]['first_name'] = 'Jason';
$json2 = json_encode(deheled_um_user_shape($GLOBALS['__users'][0]));
ok("unrelated meta is not disclosed", strpos($json2, 'do not share') === false);
ok("session tokens are not disclosed", strpos($json2, 'session_tokens') === false);
ok("not even name meta is disclosed", strpos($json2, 'Jason') === false || strpos($json2, 'first_name') === false);
ok("no meta key other than the managed flag is read", strpos($json2, 'first_name') === false);

echo "\n--- the managed flag ---\n";
ok("a flagged user reads as managed", deheled_um_user_is_managed(7));
$GLOBALS['__usermeta'][7]['_de_managed'] = '';
ok("an unflagged user does not", deheled_um_user_is_managed(7) === false);
$GLOBALS['__usermeta'][8] = array();
ok("a user with no meta at all does not", deheled_um_user_is_managed(8) === false);
// Only the exact string '1' counts — a stray truthy value must not adopt a
// client's account.
$GLOBALS['__usermeta'][9] = array('_de_managed' => 'yes');
ok("a non-'1' value does not count as managed", deheled_um_user_is_managed(9) === false);
$GLOBALS['__usermeta'][7]['_de_managed'] = '1';

/* ------------------------------------------------------------- roles ------ */

echo "\n--- roles come from the site, with admin-like classification ---\n";
$roles = deheled_um_rest_roles(new FakeRequest())['roles'];
$bySlug = array();
foreach ($roles as $r) $bySlug[$r['slug']] = $r;

eq("every editable role is reported", count($roles), 7);
ok("a plugin-defined role is included", isset($bySlug['shop_manager']));
ok("administrator is admin-like", $bySlug['administrator']['is_admin_like']);
ok("administrator is a site administrator", $bySlug['administrator']['is_site_admin']);
foreach (array('author', 'contributor', 'subscriber', 'shop_manager') as $r) {
    ok("$r is not admin-like", $bySlug[$r]['is_admin_like'] === false);
    ok("$r is not a site administrator", $bySlug[$r]['is_site_admin'] === false);
}

// The distinction that matters: unfiltered_html is an escalation path, so it
// counts as admin-like — but it is NOT site administration, and stock
// WordPress grants it to Editor, which is every team's default role.
ok("a role with only unfiltered_html is admin-like", $bySlug['seo_editor']['is_admin_like']);
ok("...but is NOT a site administrator", $bySlug['seo_editor']['is_site_admin'] === false);
eq("...and says which capability caused it",
   implode(',', $bySlug['seo_editor']['admin_like_caps']), 'unfiltered_html');
eq("administrator names its capabilities",
   implode(',', $bySlug['administrator']['admin_like_caps']), 'manage_options,edit_users');

foreach (deheled_um_admin_like_caps() as $cap) {
    ok("a role holding $cap alone is admin-like",
       deheled_um_role_is_admin_like(array($cap => true, 'read' => true)));
}
foreach (deheled_um_site_admin_caps() as $cap) {
    ok("a role holding $cap alone is a site administrator",
       deheled_um_role_is_site_admin(array($cap => true, 'read' => true)));
}
ok("unfiltered_html alone is not site administration",
   deheled_um_role_is_site_admin(array('unfiltered_html' => true)) === false);
ok("an empty capability map is neither",
   deheled_um_role_is_admin_like(array()) === false && deheled_um_role_is_site_admin(array()) === false);
ok("a capability set to false doesn't count",
   deheled_um_role_is_admin_like(array('manage_options' => false)) === false);
ok("roles come back sorted", $roles[0]['slug'] === 'administrator');

/* ------------------------------------------------------------ lookup ------ */

echo "\n--- lookup matches email first, then login ---\n";
$found = deheled_um_rest_user_lookup(new FakeRequest(array('email' => 'jason@digitalelementsgroup.com')));
ok("finds by email", $found['exists']);
eq("...and says how", $found['matched'], 'email');
eq("...returning the safe shape", implode(',', array_keys($found['user'])),
   'id,login,email,display_name,roles,managed,registered,is_admin_like,is_site_admin');

$upper = deheled_um_rest_user_lookup(new FakeRequest(array('email' => 'JASON@DigitalElementsGroup.com')));
ok("email matching is case-insensitive", $upper['exists']);

$byLogin = deheled_um_rest_user_lookup(new FakeRequest(array('login' => 'jason')));
ok("finds by login when email is absent", $byLogin['exists']);
eq("...and says how", $byLogin['matched'], 'login');

// Email wins when both are given and they point at different accounts.
$GLOBALS['__users'][] = new WP_User(array('ID' => 8, 'user_login' => 'other', 'user_email' => 'other@x.com'));
$both = deheled_um_rest_user_lookup(new FakeRequest(array('email' => 'jason@digitalelementsgroup.com', 'login' => 'other')));
eq("email takes precedence over login", $both['user']['id'], 7);

$none = deheled_um_rest_user_lookup(new FakeRequest(array('email' => 'nobody@digitalelementsgroup.com')));
ok("a miss reports exists=false", $none['exists'] === false);
ok("...with no user", $none['user'] === null);
ok("...and no match kind", $none['matched'] === null);

$empty = deheled_um_rest_user_lookup(new FakeRequest(array()));
ok("neither email nor login is a bad request", $empty instanceof WP_Error);
eq("...with a 400", $empty->get_error_data()['status'], 400);

// A malformed address must not fall through to a login match on the raw string.
$GLOBALS['__users'][] = new WP_User(array('ID' => 9, 'user_login' => 'not-an-email', 'user_email' => 'nine@x.com'));
$bad = deheled_um_rest_user_lookup(new FakeRequest(array('email' => 'not-an-email')));
ok("a malformed email is not used as a login", $bad['exists'] === false);

/* ------------------------------------------------------------- users ------ */

echo "\n--- the user list ---\n";
$GLOBALS['__users'] = array(new WP_User());
$list = deheled_um_rest_users(new FakeRequest(array()));
ok("returns a list", is_array($list['users']));
eq("default page size", $list['per_page'], 50);
eq("reports the total", $list['total'], 1);
eq("reports the administrator count", $list['administrators'], 2);
ok("no password hash anywhere in the payload",
   strpos(json_encode($list), 'supersecrethash') === false);

$capped = deheled_um_rest_users(new FakeRequest(array('per_page' => 5000)));
eq("page size is capped", $capped['per_page'], DEHELED_UM_MAX_PER_PAGE);
$floored = deheled_um_rest_users(new FakeRequest(array('page' => -3)));
eq("page is floored at 1", $floored['page'], 1);

deheled_um_rest_users(new FakeRequest(array('role' => 'editor')));
eq("a real role is passed to the query", $GLOBALS['__last_query']['role'], 'editor');
// An unknown slug passed through would be ignored by WP_User_Query and quietly
// return everything, which is not what the caller asked for.
deheled_um_rest_users(new FakeRequest(array('role' => 'not_a_role')));
ok("an unknown role is dropped rather than passed through",
   !isset($GLOBALS['__last_query']['role']));

deheled_um_rest_users(new FakeRequest(array('search' => 'jason')));
eq("search is wildcarded", $GLOBALS['__last_query']['search'], '*jason*');
eq("...over bounded columns",
   implode(',', $GLOBALS['__last_query']['search_columns']),
   'user_login,user_email,user_nicename,display_name');

deheled_um_rest_users(new FakeRequest(array('managed_only' => '1')));
eq("managed_only filters on the flag", $GLOBALS['__last_query']['meta_key'], '_de_managed');

echo "\n";
echo $FAIL ? "$FAIL assertion(s) failed\n" : "All assertions passed\n";
exit($FAIL ? 1 : 0);
