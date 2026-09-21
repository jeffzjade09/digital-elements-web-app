<?php
/**
 * Tests for the Team Members panel (includes/um-site-users.php and
 * includes/um-hub-client.php).
 *
 * The panel can cause accounts to be created on a client's website, so what is
 * asserted here is mostly what it REFUSES. In particular:
 *
 *   - a client's own Administrator holds every capability on their own site, so
 *     capabilities alone would let them in. Being a Digital-Elements-managed
 *     account with an agency address is what keeps them out, and that is the
 *     single most important assertion in this file.
 *
 *   - a hub that cannot be reached must produce a clear "unavailable" state,
 *     never a half-rendered panel that looks usable.
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
define('DEHELED_VERSION', '2.6.1');
define('DEHELED_PLUGIN_URL', 'http://example.test/wp-content/plugins/de/');
define('DEHELED_HUB_URL', 'https://hub.test');
define('DEHELED_LICENSE_OPTION', 'deheled_license_key');
define('DEHELED_LIC_STATUS', 'deheled_license_status');
define('DAY_IN_SECONDS', 86400);
define('MINUTE_IN_SECONDS', 60);
define('HOUR_IN_SECONDS', 3600);

$GLOBALS['__options'] = array();
$GLOBALS['__transients'] = array();
$GLOBALS['__usermeta'] = array();
$GLOBALS['__actions'] = array();
$GLOBALS['__filters'] = array('wp_mail' => array(), 'pre_wp_mail' => array());
$GLOBALS['__caps'] = array();          // capability => bool for the current user
$GLOBALS['__current_user'] = null;
$GLOBALS['__http'] = null;             // canned response for wp_remote_request
$GLOBALS['__http_calls'] = array();
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
function delete_transient($k) { unset($GLOBALS['__transients'][$k]); return true; }
function wp_rand($a = 0, $b = 1) { return $GLOBALS['__rand']; }
function current_time($t) { return '2026-09-21T00:00:00+00:00'; }
function get_bloginfo($k) { return '6.3.1'; }
function home_url($p = '') { return 'http://client.test' . $p; }
function admin_url($p = '') { return 'http://client.test/wp-admin/' . $p; }
function is_multisite() { return false; }
function sanitize_key($k) { return preg_replace('/[^a-z0-9_\-]/', '', strtolower((string) $k)); }
function sanitize_text_field($v) { return trim(strip_tags((string) $v)); }
function sanitize_email($e) { return trim((string) $e); }
function sanitize_user($u, $s = false) { return preg_replace('/[^A-Za-z0-9_.\-@ ]/', '', (string) $u); }
function is_email($e) { return (bool) filter_var($e, FILTER_VALIDATE_EMAIL); }
function esc_html($v) { return htmlspecialchars((string) $v, ENT_QUOTES); }
function esc_attr($v) { return htmlspecialchars((string) $v, ENT_QUOTES); }
function esc_url($v) { return (string) $v; }
function translate_user_role($n) { return $n; }
function wp_json_encode($v) { return json_encode($v); }
function wp_generate_uuid4() { return sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
    mt_rand(0,0xffff), mt_rand(0,0xffff), mt_rand(0,0xffff),
    mt_rand(0,0x0fff)|0x4000, mt_rand(0,0x3fff)|0x8000,
    mt_rand(0,0xffff), mt_rand(0,0xffff), mt_rand(0,0xffff)); }
function wp_generate_password($l = 12, $s = true, $e = false) { return 'PW'; }
function add_action($h, $cb, $p = 10, $a = 1) { $GLOBALS['__actions'][$h][] = $cb; }
function remove_action($h, $cb, $p = 10) {}
function add_filter($h, $cb, $p = 10, $a = 1) { $GLOBALS['__filters'][$h][] = $cb; }
function remove_filter($h, $cb, $p = 10) {}
function register_rest_route($ns, $r, $args) { $GLOBALS['__routes']["$ns$r"][] = $args; }
function add_submenu_page($parent, $t, $m, $cap, $slug, $cb) { $GLOBALS['__submenus'][$slug] = compact('parent','cap','cb'); return $slug; }
function wp_enqueue_style() {}
function wp_enqueue_script() {}
function wp_localize_script() {}
function get_user_meta($id, $k, $s = false) { return isset($GLOBALS['__usermeta'][$id][$k]) ? $GLOBALS['__usermeta'][$id][$k] : ''; }
function update_user_meta($id, $k, $v) { $GLOBALS['__usermeta'][$id][$k] = $v; return true; }
function delete_user_meta($id, $k) { unset($GLOBALS['__usermeta'][$id][$k]); return true; }

class WP_Error {
    public $code; public $message; public $data;
    public function __construct($c = '', $m = '', $d = array()) { $this->code = $c; $this->message = $m; $this->data = $d; }
    public function get_error_code() { return $this->code; }
    public function get_error_message() { return $this->message; }
    public function get_error_data() { return $this->data; }
}
function is_wp_error($t) { return $t instanceof WP_Error; }

class WP_REST_Response {
    private $d; private $s = 200; private $h = array();
    public function __construct($d, $s = 200) { $this->d = $d; $this->s = $s; }
    public function get_data() { return $this->d; }
    public function set_status($s) { $this->s = $s; }
    public function get_status() { return $this->s; }
    public function header($k, $v) { $this->h[$k] = $v; }
    public function get_headers() { return $this->h; }
}
function rest_ensure_response($d) { return $d instanceof WP_REST_Response ? $d : new WP_REST_Response($d); }

class WP_User {
    public $ID, $user_login, $user_email, $display_name, $roles, $user_pass, $user_registered, $user_activation_key;
    public $allcaps = array();
    public function __construct($a = array()) {
        $this->ID = isset($a['ID']) ? $a['ID'] : 1;
        $this->user_login = isset($a['user_login']) ? $a['user_login'] : 'user';
        $this->user_email = isset($a['user_email']) ? $a['user_email'] : 'user@x.com';
        $this->display_name = isset($a['display_name']) ? $a['display_name'] : $this->user_login;
        $this->roles = isset($a['roles']) ? $a['roles'] : array('subscriber');
        $this->user_pass = 'HASH'; $this->user_activation_key = 'k';
        $this->user_registered = '2026-01-01 00:00:00';
    }
}
function wp_get_current_user() { return $GLOBALS['__current_user']; }
function current_user_can($cap) { return !empty($GLOBALS['__caps'][$cap]); }
function user_can($user, $cap) {
    return $user && !empty($user->allcaps[$cap]);
}
function get_users($args = array()) { return isset($GLOBALS['__users']) ? $GLOBALS['__users'] : array(); }
function get_user_by($f, $v) {
    foreach ((isset($GLOBALS['__users']) ? $GLOBALS['__users'] : array()) as $u) {
        if ($f === 'id' && (int) $u->ID === (int) $v) return $u;
    }
    return false;
}
class WP_User_Query { public function __construct($a) {} public function get_results() { return array(); } public function get_total() { return 0; } }
function wp_insert_user($d) { $GLOBALS['__wp_insert_user_called'] = true; return new WP_Error('nope', 'must never be called'); }
function wp_create_user($l, $p, $e) { $GLOBALS['__wp_create_user_called'] = true; return new WP_Error('nope', 'must never be called'); }
function wp_update_user($d) { return new WP_Error('nope', 'not used'); }
function wp_new_user_notification($id, $x = null, $n = '') {}
function retrieve_password($l) { return true; }
function count_users() { return array('total_users' => 0); }

$GLOBALS['__editable_roles'] = array(
    'administrator' => array('name' => 'Administrator', 'capabilities' => array('manage_options' => true, 'edit_users' => true, 'promote_users' => true, 'install_plugins' => true, 'edit_posts' => true, 'read' => true)),
    'editor'        => array('name' => 'Editor',        'capabilities' => array('edit_others_posts' => true, 'unfiltered_html' => true, 'edit_posts' => true, 'read' => true)),
    'author'        => array('name' => 'Author',        'capabilities' => array('publish_posts' => true, 'edit_posts' => true, 'read' => true)),
    'subscriber'    => array('name' => 'Subscriber',    'capabilities' => array('read' => true)),
);
function get_editable_roles() { return $GLOBALS['__editable_roles']; }
function wp_roles() { return new class { public function get_names() { return array_keys($GLOBALS['__editable_roles']); } }; }

/** Canned HTTP, so the hub client can be driven without a network. */
function wp_remote_request($url, $args = array()) {
    $GLOBALS['__http_calls'][] = array('url' => $url, 'args' => $args);
    $r = $GLOBALS['__http'];
    if ($r instanceof WP_Error) return $r;
    return $r;
}
function wp_remote_retrieve_response_code($r) { return isset($r['response']['code']) ? $r['response']['code'] : 200; }
function wp_remote_retrieve_body($r) { return isset($r['body']) ? $r['body'] : ''; }
function wp_remote_post($url, $args = array()) { return wp_remote_request($url, $args); }
function wp_remote_get($url, $args = array()) { return wp_remote_request($url, $args); }

$GLOBALS['__json'] = null;
function wp_send_json_success($d = null) { $GLOBALS['__json'] = array('success' => true, 'data' => $d); throw new Exception('__json_exit'); }
function wp_send_json_error($d = null, $code = 200) { $GLOBALS['__json'] = array('success' => false, 'data' => $d, 'code' => $code); throw new Exception('__json_exit'); }
$GLOBALS['__nonce_ok'] = true;
function check_ajax_referer($action = '', $q = false, $die = true) {
    if (!$GLOBALS['__nonce_ok']) { $GLOBALS['__json'] = array('nonce' => 'failed'); throw new Exception('__nonce_exit'); }
    return true;
}
function check_admin_referer($a = '') { return $GLOBALS['__nonce_ok']; }
function wp_create_nonce($a = '') { return 'nonce'; }
function wp_unslash($v) { return $v; }

require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-auth.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-rest.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-users.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-write.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-content.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-hub-client.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-site-users.php';

/* ------------------------------------------------------------- helpers ---- */

function set_staff_user($email = 'jason@digitalelementsgroup.com', $managed = true, $caps = null) {
    $u = new WP_User(array('ID' => 7, 'user_login' => 'jason', 'user_email' => $email, 'roles' => array('administrator')));
    $GLOBALS['__current_user'] = $u;
    $GLOBALS['__users'] = array($u);
    $GLOBALS['__usermeta'] = array();
    if ($managed) $GLOBALS['__usermeta'][7]['_de_managed'] = '1';
    $GLOBALS['__caps'] = $caps === null
        ? array('edit_users' => true, 'promote_users' => true, 'manage_options' => true,
                'install_plugins' => true, 'edit_others_posts' => true, 'unfiltered_html' => true,
                'publish_posts' => true, 'edit_posts' => true, 'read' => true)
        : $caps;
    // The capability-subset rule reads allcaps, deliberately: see the comment on
    // deheled_site_users_can_grant_role(). The stub mirrors the two the same way
    // WordPress does, so a change to one is visible here.
    $u->allcaps = $GLOBALS['__caps'];
    return $u;
}

function set_connected() {
    $GLOBALS['__options'][DEHELED_LICENSE_OPTION] = 'DEG-AAAAA-BBBBB-CCCCC-DDDDD';
    $GLOBALS['__options'][DEHELED_LIC_STATUS] = array('valid' => true, 'expired' => false, 'checked_at' => time());
    $GLOBALS['__options'][DEHELED_UM_KEY_ID] = 'dek_abc123';
    $GLOBALS['__options'][DEHELED_UM_SECRET] = 'site-secret';
    $GLOBALS['__options'][DEHELED_UM_SCOPES] = deheled_um_default_scopes();
}

function hub_json($body, $code = 200) {
    return array('response' => array('code' => $code), 'body' => json_encode($body));
}

function roster_body($can_assign = true, $members = 1) {
    $list = array();
    for ($i = 0; $i < $members; $i++) {
        $list[] = array(
            'staffUserId' => "u$i", 'label' => "Person $i", 'email' => "p$i@digitalelementsgroup.com",
            'defaultWpRole' => 'editor', 'roleSource' => 'team',
            'onThisSite' => array('present' => false),
        );
    }
    return array(
        'ok' => true, 'site' => array('name' => 'Client'),
        'teams' => array(array('id' => 't1', 'name' => 'SEO', 'defaultWpRole' => 'editor', 'members' => $list)),
        'siteRoles' => array(array('slug' => 'editor', 'name' => 'Editor', 'siteAdmin' => false)),
        'scopes' => deheled_um_default_scopes(),
        'canAssign' => $can_assign,
    );
}

function reset_all() {
    $GLOBALS['__options'] = array();
    $GLOBALS['__transients'] = array();
    $GLOBALS['__http'] = null;
    $GLOBALS['__http_calls'] = array();
    $GLOBALS['__nonce_ok'] = true;
    $GLOBALS['__json'] = null;
    unset($GLOBALS['__wp_insert_user_called'], $GLOBALS['__wp_create_user_called']);
}

/* ================================================== the eight gate states == */

echo "--- every unavailable state is distinct ---\n";

reset_all(); set_staff_user();
eq('no license', deheled_site_users_gate()['state'], 'license_missing');

reset_all(); set_staff_user(); set_connected();
$GLOBALS['__options'][DEHELED_LIC_STATUS] = array('expired' => true, 'valid' => false, 'checked_at' => time());
eq('expired license', deheled_site_users_gate()['state'], 'license_expired');

reset_all(); set_staff_user(); set_connected();
$GLOBALS['__options'][DEHELED_LIC_STATUS] = array('valid' => false, 'expired' => false, 'checked_at' => time());
eq('unrecognised license', deheled_site_users_gate()['state'], 'license_invalid');

reset_all(); set_staff_user(); set_connected();
delete_option(DEHELED_UM_KEY_ID); delete_option(DEHELED_UM_SECRET);
eq('not enrolled', deheled_site_users_gate()['state'], 'not_enrolled');

reset_all(); set_staff_user(); set_connected();
$GLOBALS['__options'][DEHELED_UM_SCOPES] = array('users:read');
eq('users:write not granted by the site', deheled_site_users_gate()['state'], 'write_not_granted');

reset_all(); set_staff_user(); set_connected();
eq('everything local passes', deheled_site_users_gate()['state'], 'available');

reset_all(); set_staff_user(); set_connected();
eq('hub says plugin:assign is not granted',
   deheled_site_users_gate(roster_body(false))['state'], 'plugin_assign_not_granted');

reset_all(); set_staff_user(); set_connected();
eq('hub scope_denied maps to the same state',
   deheled_site_users_gate(new WP_Error('scope_denied', 'nope'))['state'], 'plugin_assign_not_granted');

reset_all(); set_staff_user(); set_connected();
eq('an unreachable hub is its own state',
   deheled_site_users_gate(new WP_Error('hub_unreachable', 'Couldn\'t reach the dashboard.'))['state'], 'hub_unreachable');

reset_all(); set_staff_user(); set_connected();
eq('an empty roster is its own state',
   deheled_site_users_gate(roster_body(true, 0))['state'], 'roster_empty');

echo "\n--- every state has its own title and message ---\n";
$states = array('license_missing','license_invalid','license_expired','not_enrolled','write_not_granted',
                'plugin_assign_not_granted','hub_unreachable','roster_empty','no_permission');
$titles = array();
foreach ($states as $st) { $titles[] = deheled_site_users_state_title($st); }
eq('nine distinct titles', count(array_unique($titles)), 9);
ok('none falls back to "Unavailable"', !in_array('Unavailable', $titles, true));

/* ======================================== who can and cannot use the screen */

echo "\n--- a client's own Administrator is refused ---\n";
// THE assertion this file exists for. They hold every capability on their own
// site, so capabilities alone would admit them.
reset_all(); set_connected();
set_staff_user('owner@theclient.com', false);
$gate = deheled_site_users_gate();
eq('the client\'s own administrator is refused', $gate['state'], 'no_permission');
ok('...and told the rule that excluded them',
   strpos($gate['message'], DEHELED_AGENCY_DOMAIN) !== false, $gate['message']);

reset_all(); set_connected();
set_staff_user('owner@theclient.com', true);   // managed, but not an agency address
eq('a managed account on another domain is still refused', deheled_site_users_gate()['state'], 'no_permission');

reset_all(); set_connected();
set_staff_user('jason@digitalelementsgroup.com.evil.com', true);
eq('a suffix attack is refused', deheled_site_users_gate()['state'], 'no_permission');

// The regression this release exists for: an agency colleague whose WordPress
// account predates the dashboard has no _de_managed flag, and used to be
// refused by name. Whether they may act is the hub's call now, so the local
// gate lets them through to ask.
reset_all(); set_connected();
set_staff_user('jeff@digitalelementsgroup.com', false);
eq('an agency address that was never linked is NOT refused locally',
   deheled_site_users_gate()['state'], 'available');

echo "\n--- WordPress capability is required too ---\n";
reset_all(); set_connected();
set_staff_user('jason@digitalelementsgroup.com', true, array('edit_users' => true));   // no promote_users
eq('edit_users alone is not enough', deheled_site_users_gate()['state'], 'no_permission');

reset_all(); set_connected();
set_staff_user('jason@digitalelementsgroup.com', true, array('promote_users' => true)); // no edit_users
eq('promote_users alone is not enough', deheled_site_users_gate()['state'], 'no_permission');

reset_all(); set_connected();
set_staff_user('jason@digitalelementsgroup.com', true, array('edit_users' => true, 'promote_users' => true));
eq('both together pass', deheled_site_users_gate()['state'], 'available');

/* ============================================== the capability-subset rule = */

echo "\n--- a role above your own level is refused (a mistake-guard) ---\n";
reset_all(); set_connected();
// An editor-level agency user: can edit users, but holds none of the
// administrator-only capabilities.
set_staff_user('jason@digitalelementsgroup.com', true, array(
    'edit_users' => true, 'promote_users' => true,
    'edit_others_posts' => true, 'unfiltered_html' => true, 'publish_posts' => true,
    'edit_posts' => true, 'read' => true,
));
ok('they can grant Editor', deheled_site_users_can_grant_role('editor'));
ok('they can grant Author', deheled_site_users_can_grant_role('author'));
ok('they can grant Subscriber', deheled_site_users_can_grant_role('subscriber'));
ok('they CANNOT grant Administrator', deheled_site_users_can_grant_role('administrator') === false);
ok('an unknown role is refused', deheled_site_users_can_grant_role('wizard') === false);

$grantable = deheled_site_users_grantable_roles();
ok('administrator is not offered to them', !isset($grantable['administrator']), implode(',', array_keys($grantable)));
ok('editor is offered', isset($grantable['editor']));

// A full administrator can grant anything, including administrator.
set_staff_user('jason@digitalelementsgroup.com', true);
ok('a full administrator can grant Administrator', deheled_site_users_can_grant_role('administrator'));
ok('...and it is flagged as administering the site',
   deheled_site_users_grantable_roles()['administrator']['site_admin'] === true);

// A regression the stubs alone would never have shown, and the live check did.
// Stock WordPress declares manage_links and unfiltered_upload on the Editor and
// Administrator roles but denies both in map_meta_cap -- the Links Manager is
// off by default and unfiltered_upload is granted to nobody. Judged by
// current_user_can(), no one on a default install could grant either role.
$GLOBALS['__editable_roles']['editor']['capabilities']['manage_links'] = true;
$GLOBALS['__editable_roles']['administrator']['capabilities']['manage_links'] = true;
$GLOBALS['__editable_roles']['administrator']['capabilities']['unfiltered_upload'] = true;

set_staff_user('jason@digitalelementsgroup.com', true);
// Assigned by the role, and denied at runtime to everybody -- exactly what
// WordPress does with these two.
$GLOBALS['__current_user']->allcaps['manage_links'] = true;
$GLOBALS['__current_user']->allcaps['unfiltered_upload'] = true;
unset($GLOBALS['__caps']['manage_links'], $GLOBALS['__caps']['unfiltered_upload']);

ok('a capability WordPress denies everyone does not block Editor',
   deheled_site_users_can_grant_role('editor'));
ok('...nor Administrator', deheled_site_users_can_grant_role('administrator'));

// ...but a capability the user genuinely does not have still blocks the role.
unset($GLOBALS['__current_user']->allcaps['manage_links']);
ok('a capability they really lack still blocks it',
   deheled_site_users_can_grant_role('editor') === false);

unset($GLOBALS['__editable_roles']['editor']['capabilities']['manage_links']);
unset($GLOBALS['__editable_roles']['administrator']['capabilities']['manage_links']);
unset($GLOBALS['__editable_roles']['administrator']['capabilities']['unfiltered_upload']);

/* ============================================= non-agency roster members == */

echo "\n--- non-agency roster members are refused entirely ---\n";
ok('an agency address is allowed',
   deheled_site_users_member_allowed(array('email' => 'jason@digitalelementsgroup.com')));
ok('an outside address is refused',
   deheled_site_users_member_allowed(array('email' => 'freelancer@gmail.com')) === false);
ok('a lookalike domain is refused',
   deheled_site_users_member_allowed(array('email' => 'x@notdigitalelementsgroup.com')) === false);
ok('a missing address is refused', deheled_site_users_member_allowed(array()) === false);

$mixed = roster_body(true, 1);
$mixed['teams'][0]['members'][] = array(
    'staffUserId' => 'ext', 'label' => 'Freelancer', 'email' => 'freelancer@gmail.com',
    'defaultWpRole' => 'editor', 'roleSource' => 'team', 'onThisSite' => array('present' => false),
);
$public = deheled_site_users_public_roster($mixed);
$emails = array();
foreach ($public['teams'] as $t) foreach ($t['members'] as $m) $emails[] = $m['email'];
ok('an external member never reaches the page', !in_array('freelancer@gmail.com', $emails, true), implode(',', $emails));
eq('...while the agency member does', count($emails), 1);

/* ======================================================= the hub client === */

echo "\n--- outbound requests are signed for the site direction ---\n";
reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = hub_json(roster_body());
deheled_hub_get_roster(true);
$call = $GLOBALS['__http_calls'][0];
$h = $call['args']['headers'];

ok('goes to the site API', strpos($call['url'], '/api/site/v1/roster') !== false, $call['url']);
eq('as a POST, so the acting person is inside the signature', $call['args']['method'], 'POST');
ok('carries the key id', $h['X-DE-Key-Id'] === 'dek_abc123');
ok('uses the SITE signature version', strpos($h['X-DE-Signature'], 'DE1-SITE-HMAC-SHA256 ') === 0, $h['X-DE-Signature']);
// The direction that must not be reusable in the other.
ok('...which is not the inbound version', strpos($h['X-DE-Signature'], DEHELED_UM_SIG_VERSION . ' ') !== 0);
ok('carries a timestamp', preg_match('/^\d{9,}$/', $h['X-DE-Timestamp']) === 1);
ok('carries a nonce', strlen($h['X-DE-Nonce']) > 20);
ok('sends no query string at all', strpos($call['url'], '?') === false, $call['url']);

// The signature must actually verify against the canonical string.
$expected = base64_encode(hash_hmac('sha256',
    deheled_um_canonical_string('POST', '/api/site/v1/roster', array(),
        $h['X-DE-Timestamp'], $h['X-DE-Nonce'], '', $call['args']['body']),
    'site-secret', true));
eq('the signature matches the canonical string', $h['X-DE-Signature'], 'DE1-SITE-HMAC-SHA256 ' . $expected);

echo "\n--- who is acting travels in the signed body ---\n";
$sent = json_decode($call['args']['body'], true);
eq('the acting address is sent', $sent['actorEmail'], 'jason@digitalelementsgroup.com');
eq('...with their WordPress id, so the hub can adopt the account', $sent['actorWpUserId'], 7);
eq('...and whether this site already manages it', $sent['actorManaged'], true);

reset_all(); set_connected();
set_staff_user('jeff@digitalelementsgroup.com', false);
$GLOBALS['__http'] = hub_json(roster_body());
deheled_hub_get_roster(true);
$unmanaged = json_decode($GLOBALS['__http_calls'][0]['args']['body'], true);
eq('an unlinked account says so, which is what triggers the adoption',
   $unmanaged['actorManaged'], false);

echo "\n--- preflight and assign name the actor too ---\n";
reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = hub_json(array('ok' => true, 'rows' => array(), 'summary' => array()));
deheled_hub_preflight(array('u1'), 'editor');
$pre_body = json_decode($GLOBALS['__http_calls'][0]['args']['body'], true);
eq('preflight sends the actor', $pre_body['actorEmail'], 'jason@digitalelementsgroup.com');
ok('...alongside the people chosen', $pre_body['staffUserIds'] === array('u1'));

ok('the secret is never sent', strpos(json_encode($h), 'site-secret') === false);
ok('the license key is never sent', strpos(json_encode($call['args']), 'DEG-AAAAA') === false);

echo "\n--- the idempotency key is sent and signed ---\n";
reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = hub_json(array('ok' => true, 'jobId' => 'j1'));
deheled_hub_assign(array('u1'), 'editor', 'req-123', false);
$call = $GLOBALS['__http_calls'][0];
eq('the header is set', $call['args']['headers']['Idempotency-Key'], 'req-123');
$body = $call['args']['body'];
$sig = base64_encode(hash_hmac('sha256',
    deheled_um_canonical_string('POST', '/api/site/v1/assign', array(),
        $call['args']['headers']['X-DE-Timestamp'], $call['args']['headers']['X-DE-Nonce'], 'req-123', $body),
    'site-secret', true));
eq('...and covered by the signature', $call['args']['headers']['X-DE-Signature'], 'DE1-SITE-HMAC-SHA256 ' . $sig);
ok('the acting user is named for the audit trail', strpos($body, 'jason@digitalelementsgroup.com') !== false);

echo "\n--- the roster cache is keyed on the credential ---\n";
reset_all(); set_staff_user(); set_connected();
$key_a = deheled_hub_roster_cache_key();
$GLOBALS['__options'][DEHELED_UM_KEY_ID] = 'dek_rotated';
$key_b = deheled_hub_roster_cache_key();
ok('a rotated credential cannot read the old cache', $key_a !== $key_b, "$key_a / $key_b");

$GLOBALS['__options'][DEHELED_UM_KEY_ID] = 'dek_abc123';
$GLOBALS['__http'] = hub_json(roster_body());
deheled_hub_get_roster(true);
eq('one call for a cold cache', count($GLOBALS['__http_calls']), 1);
deheled_hub_get_roster(false);
eq('a warm cache makes no call', count($GLOBALS['__http_calls']), 1);
deheled_hub_get_roster(true);
eq('a forced refresh does', count($GLOBALS['__http_calls']), 2);
deheled_hub_clear_roster_cache();
deheled_hub_get_roster(false);
eq('clearing the cache makes the next read fetch', count($GLOBALS['__http_calls']), 3);

echo "\n--- hub failures never become a half-rendered panel ---\n";
reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = new WP_Error('http_request_failed', 'connection refused');
$r = deheled_hub_get_roster(true);
ok('a transport failure is an error', is_wp_error($r));
eq('...with the hub_unreachable code', $r->get_error_code(), 'hub_unreachable');
eq('...which the gate turns into a clear state', deheled_site_users_gate($r)['state'], 'hub_unreachable');
ok('the underlying detail is not passed through',
   strpos($r->get_error_message(), 'connection refused') === false, $r->get_error_message());

reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = hub_json(array('ok' => false, 'error' => array('code' => 'scope_denied')), 403);
$r = deheled_hub_get_roster(true);
eq('a scope refusal is distinguished', $r->get_error_code(), 'scope_denied');

reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = hub_json(array('ok' => false, 'error' => array('code' => 'forbidden')), 403);
eq('any other 403 is generic', deheled_hub_get_roster(true)->get_error_code(), 'forbidden');

reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = array('response' => array('code' => 500), 'body' => 'Internal Server Error');
eq('a 5xx is its own code', deheled_hub_get_roster(true)->get_error_code(), 'hub_error');

reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = array('response' => array('code' => 200), 'body' => '<html>not json</html>');
eq('a non-JSON reply is caught', deheled_hub_get_roster(true)->get_error_code(), 'hub_bad_response');

reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = hub_json(array('ok' => false, 'error' => array('code' => 'rate_limited')), 429);
eq('rate limiting is its own code', deheled_hub_get_roster(true)->get_error_code(), 'rate_limited');

reset_all(); set_staff_user();
$GLOBALS['__http'] = hub_json(roster_body());
eq('an unenrolled site never calls out at all', deheled_hub_get_roster(true)->get_error_code(), 'not_enrolled');
eq('...and made no request', count($GLOBALS['__http_calls']), 0);

/* ===================================================== the AJAX handlers == */

echo "\n--- every handler checks the nonce and the gate ---\n";
function run_handler($hook, $post) {
    $_POST = $post;
    $GLOBALS['__json'] = null;
    foreach ($GLOBALS['__actions'][$hook] as $cb) {
        try { $cb(); } catch (Exception $e) { /* wp_send_json_* */ }
    }
    return $GLOBALS['__json'];
}

$handlers = array('wp_ajax_deheled_tm_roster', 'wp_ajax_deheled_tm_preflight',
                  'wp_ajax_deheled_tm_assign', 'wp_ajax_deheled_tm_job');
foreach ($handlers as $hook) {
    ok("$hook is registered", !empty($GLOBALS['__actions'][$hook]));
}

foreach ($handlers as $hook) {
    reset_all(); set_staff_user(); set_connected();
    $GLOBALS['__nonce_ok'] = false;
    $out = run_handler($hook, array('ids' => array('u1')));
    ok("$hook refuses a bad nonce", isset($out['nonce']) && $out['nonce'] === 'failed');
}

foreach ($handlers as $hook) {
    reset_all(); set_connected();
    set_staff_user('owner@theclient.com', false);   // the client's own admin
    $GLOBALS['__http'] = hub_json(roster_body());
    $out = run_handler($hook, array('ids' => array('u1')));
    ok("$hook refuses an unmanaged administrator",
       isset($out['success']) && $out['success'] === false && isset($out['code']) && $out['code'] === 403);
}

echo "\n--- a role above your level is refused by the handlers too ---\n";
reset_all(); set_connected();
set_staff_user('jason@digitalelementsgroup.com', true, array(
    'edit_users' => true, 'promote_users' => true, 'edit_posts' => true, 'read' => true,
));
$GLOBALS['__http'] = hub_json(array('ok' => true, 'rows' => array(), 'summary' => array()));
$out = run_handler('wp_ajax_deheled_tm_preflight', array('ids' => array('u1'), 'role' => 'administrator'));
ok('preflight refuses it', $out['success'] === false && strpos($out['data']['message'], 'more access') !== false);
eq('...and never called the hub', count($GLOBALS['__http_calls']), 0);

$out = run_handler('wp_ajax_deheled_tm_assign', array('ids' => array('u1'), 'role' => 'administrator', 'requestId' => 'r1'));
ok('assign refuses it too', $out['success'] === false && strpos($out['data']['message'], 'more access') !== false);
eq('...and never called the hub', count($GLOBALS['__http_calls']), 0);

echo "\n--- assign requires a request id ---\n";
reset_all(); set_connected(); set_staff_user();
$GLOBALS['__http'] = hub_json(array('ok' => true, 'jobId' => 'j1'));
$out = run_handler('wp_ajax_deheled_tm_assign', array('ids' => array('u1'), 'role' => 'editor'));
ok('a missing request id is refused', $out['success'] === false, json_encode($out));
eq('...and nothing was sent', count($GLOBALS['__http_calls']), 0);

echo "\n--- the plugin never creates a user itself ---\n";
reset_all(); set_connected(); set_staff_user();
$GLOBALS['__http'] = hub_json(array('ok' => true, 'jobId' => 'j1'));
run_handler('wp_ajax_deheled_tm_assign', array('ids' => array('u1'), 'role' => 'editor', 'requestId' => 'r2'));
ok('wp_insert_user was never called', empty($GLOBALS['__wp_insert_user_called']));
ok('wp_create_user was never called', empty($GLOBALS['__wp_create_user_called']));
ok('the request went to the hub instead', count($GLOBALS['__http_calls']) === 1);

echo "\n--- the exact-domain matcher ---\n";
// One address per way of getting this wrong. Each line is a way in if the rule
// is written as a substring test instead of a comparison of the whole domain.
$accept = array(
    'jeff@digitalelementsgroup.com'        => 'the plain form',
    'JEFF@DigitalElementsGroup.COM'        => 'any case',
    '  jeff@digitalelementsgroup.com  '    => 'surrounding whitespace',
    'jeff@digitalelementsgroup.com.'       => 'a trailing dot, which is the same host',
    'first.last+tag@digitalelementsgroup.com' => 'a local part with dots and a tag',
);
foreach ($accept as $email => $why) {
    ok("accepts $why", deheled_site_users_is_agency_email($email), $email);
}

$reject = array(
    'jeff@wp.digitalelementsgroup.com'     => 'a subdomain is not the domain',
    'jeff@mail.digitalelementsgroup.com'   => 'another subdomain',
    'jeff@digitalelementsgroup.co'         => 'a look-alike TLD',
    'jeff@digital-elementsgroup.com'       => 'a look-alike with a hyphen',
    'jeff@digitalelementsgroupp.com'       => 'a look-alike with a doubled letter',
    'jeff@digitalelementsgroup.com.evil.com' => 'a suffix attack',
    'jeff@evildigitalelementsgroup.com'    => 'a prefix attack',
    'a@b.com@digitalelementsgroup.com'     => 'two @, which resolves ambiguously',
    'jeff@'                                => 'no domain',
    '@digitalelementsgroup.com'            => 'no local part',
    'jeffdigitalelementsgroup.com'         => 'no @ at all',
    'jeff@gmail.com'                       => 'a personal address',
    ''                                     => 'an empty string',
    '   '                                  => 'whitespace only',
);
foreach ($reject as $email => $why) {
    ok("rejects $why", deheled_site_users_is_agency_email($email) === false, var_export($email, true));
}
ok('rejects null', deheled_site_users_is_agency_email(null) === false);

echo "\n--- the hub\'s verdict on the person gets its own state ---\n";
// The hub owns the roster and the team, so only it can answer these. Each is a
// different thing to do about it, so each keeps a distinct state and message
// rather than collapsing into "unavailable".
reset_all(); set_staff_user(); set_connected();
eq('not on the roster',
   deheled_site_users_gate(new WP_Error('actor_not_on_roster', 'That account isn\'t on the Digital Elements roster.'))['state'],
   'not_on_roster');

eq('on the roster, in a team that may not use this',
   deheled_site_users_gate(new WP_Error('actor_team_not_allowed', 'Only Web Development and Admin team members can manage users from here.'))['state'],
   'team_not_allowed');

$team_gate = deheled_site_users_gate(new WP_Error('actor_team_not_allowed', 'Only Web Development and Admin team members can manage users from here.'));
ok('...and told which teams may', strpos($team_gate['message'], 'Web Development') !== false, $team_gate['message']);

eq('disabled on the roster reads as not on it',
   deheled_site_users_gate(new WP_Error('actor_inactive', 'That account is disabled on the Digital Elements roster.'))['state'],
   'not_on_roster');

$stale = deheled_site_users_gate(new WP_Error('plugin_update_required', 'This website\'s Digital Elements plugin is out of date. Update it to 2.7.1 or later.'));
eq('a hub that wants a newer plugin says so', $stale['state'], 'plugin_outdated');
ok('...naming the version to update to', strpos($stale['message'], '2.7.1') !== false, $stale['message']);

// Still distinct from everything else, and still never "Unavailable".
$all_states = array('license_missing','license_invalid','license_expired','not_enrolled','write_not_granted',
                    'plugin_assign_not_granted','hub_unreachable','roster_empty','no_permission',
                    'not_on_roster','team_not_allowed','plugin_outdated');
$all_titles = array();
foreach ($all_states as $st) $all_titles[] = deheled_site_users_state_title($st);
eq('twelve distinct titles', count(array_unique($all_titles)), 12);
ok('none falls back to "Unavailable"', !in_array('Unavailable', $all_titles, true));

echo "\n--- the hub\'s refusal reaches the person, not a generic 403 ---\n";
reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = hub_json(array('ok' => false, 'error' => array(
    'code' => 'actor_team_not_allowed',
    'message' => 'Only Web Development and Admin team members can manage users from here.')), 403);
$r = deheled_hub_get_roster(true);
eq('the code survives the transport', $r->get_error_code(), 'actor_team_not_allowed');
ok('...and so does the sentence', strpos($r->get_error_message(), 'Web Development') !== false);

reset_all(); set_staff_user(); set_connected();
$GLOBALS['__http'] = hub_json(array('ok' => false, 'error' => array('code' => 'forbidden')), 403);
eq('an ordinary credential refusal stays generic', deheled_hub_get_roster(true)->get_error_code(), 'forbidden');

echo "\n--- a linked account is not cached as linked ---\n";
// Caching "we just adopted you" for five minutes would make the next visit look
// like a second adoption, and hide the account's new state from the panel.
reset_all(); set_connected();
set_staff_user('jeff@digitalelementsgroup.com', false);
$linked = roster_body();
$linked['actor'] = array('email' => 'jeff@digitalelementsgroup.com', 'team' => 'Web Development', 'linked' => true);
$GLOBALS['__http'] = hub_json($linked);
deheled_hub_get_roster(true);
ok('the adopting response is not cached', get_transient(deheled_hub_roster_cache_key()) === false);

reset_all(); set_staff_user(); set_connected();
$ordinary = roster_body();
$ordinary['actor'] = array('email' => 'jason@digitalelementsgroup.com', 'team' => 'SEO', 'linked' => false);
$GLOBALS['__http'] = hub_json($ordinary);
deheled_hub_get_roster(true);
ok('an ordinary response still is', is_array(get_transient(deheled_hub_roster_cache_key())));

echo "\n--- the panel advertises itself to the dashboard ---\n";
ok('site.assign is a reported capability', in_array('site.assign', deheled_um_capability_list(), true),
   implode(',', deheled_um_capability_list()));

echo "\n";
echo $FAIL ? "$FAIL assertion(s) failed\n" : "All assertions passed\n";
exit($FAIL ? 1 : 0);
