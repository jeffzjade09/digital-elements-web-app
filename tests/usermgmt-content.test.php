<?php
/**
 * Tests for content ownership, reassignment and guarded deletion
 * (includes/um-content.php).
 *
 * This is the one place in the plugin that can destroy something a client
 * cannot get back, so the assertions are about refusals, and above all about
 * the case a careless implementation gets wrong:
 *
 *   THE STALE UI. A dashboard can show a correct "0 remaining", then sit on
 *   screen while someone publishes a post or a scheduled post goes live.
 *   Deleting on the strength of that earlier count would silently destroy
 *   content, so ownership is re-counted inside the delete request itself. The
 *   test for that is the most important one in this file.
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

$GLOBALS['__options'] = array('admin_email' => 'owner@client.com');
$GLOBALS['__transients'] = array();
$GLOBALS['__usermeta'] = array();
$GLOBALS['__users'] = array();
$GLOBALS['__posts'] = array();        // [id => ['author'=>, 'type'=>, 'status'=>]]
$GLOBALS['__comments'] = array();     // [id => ['user_id'=>]]
$GLOBALS['__routes'] = array();
$GLOBALS['__actions'] = array();
$GLOBALS['__filters'] = array('wp_mail' => array(), 'pre_wp_mail' => array());
$GLOBALS['__rand'] = 2;
$GLOBALS['__next_id'] = 100;
$GLOBALS['__deleted_users'] = array();
$GLOBALS['__mail_ok'] = true;
$GLOBALS['__mail_short'] = null;
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
function sanitize_user($u, $s = false) { return preg_replace('/[^A-Za-z0-9_.\-@ ]/', '', (string) $u); }
function is_email($e) { return (bool) filter_var($e, FILTER_VALIDATE_EMAIL); }
function translate_user_role($n) { return $n; }
function add_action($h, $cb, $p = 10, $a = 1) { $GLOBALS['__actions'][$h][] = $cb; }
function remove_action($h, $cb, $p = 10) {}
function add_filter($h, $cb, $p = 10, $a = 1) { $GLOBALS['__filters'][$h][] = $cb; }
function remove_filter($h, $cb, $p = 10) {}
function register_rest_route($ns, $r, $args) { $GLOBALS['__routes']["$ns$r"][] = $args; }
function get_user_meta($id, $k, $s = false) { return isset($GLOBALS['__usermeta'][$id][$k]) ? $GLOBALS['__usermeta'][$id][$k] : ''; }
function update_user_meta($id, $k, $v) { $GLOBALS['__usermeta'][$id][$k] = $v; return true; }
function delete_user_meta($id, $k) { unset($GLOBALS['__usermeta'][$id][$k]); return true; }
function wp_generate_password($l = 12, $s = true, $e = false) { return 'PW'; }
function clean_user_cache($id) {}
function wp_cache_flush() {}
function wp_cache_flush_group($g) {}

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
        $this->roles = isset($a['roles']) ? $a['roles'] : array('author');
        $this->user_pass = 'HASHED'; $this->user_activation_key = 'k';
        $this->user_registered = '2026-01-01 00:00:00';
    }
}

function get_user_by($f, $v) {
    foreach ($GLOBALS['__users'] as $u) {
        if ($f === 'id' && (int) $u->ID === (int) $v) return $u;
        if ($f === 'email' && strcasecmp($u->user_email, (string) $v) === 0) return $u;
        if ($f === 'login' && $u->user_login === $v) return $u;
    }
    return false;
}
function username_exists($l) { return get_user_by('login', $l) ? 1 : false; }
function get_users($args = array()) {
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
function wp_insert_user($d) { return new WP_Error('nope', 'not used here'); }
function wp_update_user($d) { return new WP_Error('nope', 'not used here'); }
function wp_new_user_notification($id, $x = null, $n = '') {}
function retrieve_password($l) { return true; }

/** Only these roles can author, which is what reassignment eligibility means. */
function user_can($user, $cap) {
    if ($cap !== 'edit_posts') return false;
    foreach ((array) $user->roles as $r) {
        if (in_array($r, array('administrator', 'editor', 'author', 'contributor'), true)) return true;
    }
    return false;
}

$GLOBALS['__editable_roles'] = array(
    'administrator' => array('name' => 'Administrator', 'capabilities' => array('manage_options' => true, 'edit_users' => true)),
    'editor'        => array('name' => 'Editor',        'capabilities' => array('unfiltered_html' => true)),
    'author'        => array('name' => 'Author',        'capabilities' => array('publish_posts' => true)),
    'subscriber'    => array('name' => 'Subscriber',    'capabilities' => array('read' => true)),
);
function get_editable_roles() { return $GLOBALS['__editable_roles']; }
function wp_roles() { return new class { public function get_names() { return array_keys($GLOBALS['__editable_roles']); } }; }

/** Every registered post type, including custom ones — that is the point. */
function get_post_types($args = array(), $output = 'names') {
    $types = array(
        'post'       => 'Posts',
        'page'       => 'Pages',
        'attachment' => 'Media',
        'location'   => 'Locations',   // a custom post type
        'revision'   => 'Revisions',
    );
    if ($output === 'objects') {
        $out = array();
        foreach ($types as $slug => $label) {
            $out[$slug] = (object) array('labels' => (object) array('name' => $label));
        }
        return $out;
    }
    return array_keys($types);
}

function wp_delete_user($id, $reassign = null) {
    if (!get_user_by('id', $id)) return false;
    $GLOBALS['__deleted_users'][] = array('id' => $id, 'reassign' => $reassign);
    foreach ($GLOBALS['__users'] as $i => $u) {
        if ((int) $u->ID === (int) $id) unset($GLOBALS['__users'][$i]);
    }
    $GLOBALS['__users'] = array_values($GLOBALS['__users']);
    return true;
}

/** A $wpdb that answers the two queries um-content.php actually makes. */
class FakeWpdb {
    public $posts = 'wp_posts';
    public $comments = 'wp_comments';
    public function prepare($sql, ...$args) {
        foreach ($args as $a) {
            $sql = preg_replace('/%d|%s/', is_numeric($a) ? (string) (int) $a : "'" . $a . "'", $sql, 1);
        }
        return $sql;
    }
    public function get_results($sql) {
        preg_match('/post_author = (\d+)/', $sql, $m);
        $author = isset($m[1]) ? (int) $m[1] : 0;
        $grouped = array();
        foreach ($GLOBALS['__posts'] as $p) {
            if ((int) $p['author'] !== $author) continue;
            $k = $p['type'] . '|' . $p['status'];
            $grouped[$k] = isset($grouped[$k]) ? $grouped[$k] + 1 : 1;
        }
        $rows = array();
        foreach ($grouped as $k => $n) {
            list($type, $status) = explode('|', $k);
            $rows[] = (object) array('post_type' => $type, 'post_status' => $status, 'n' => $n);
        }
        return $rows;
    }
    public function get_var($sql) {
        preg_match('/user_id = (\d+)/', $sql, $m);
        $uid = isset($m[1]) ? (int) $m[1] : 0;
        $n = 0;
        foreach ($GLOBALS['__comments'] as $c) if ((int) $c['user_id'] === $uid) $n++;
        return $n;
    }
    public function query($sql) {
        if (strpos($sql, 'wp_posts') !== false) {
            preg_match('/post_author = (\d+) WHERE post_author = (\d+)/', $sql, $m);
            if (!$m) return 0;
            $to = (int) $m[1]; $from = (int) $m[2];
            $n = 0;
            foreach ($GLOBALS['__posts'] as $id => $p) {
                if ((int) $p['author'] === $from && $p['type'] !== 'revision') {
                    $GLOBALS['__posts'][$id]['author'] = $to; $n++;
                }
            }
            return $n;
        }
        preg_match('/user_id = (\d+),.*WHERE user_id = (\d+)/s', $sql, $m);
        if (!$m) return 0;
        $to = (int) $m[1]; $from = (int) $m[2];
        $n = 0;
        foreach ($GLOBALS['__comments'] as $id => $c) {
            if ((int) $c['user_id'] === $from) { $GLOBALS['__comments'][$id]['user_id'] = $to; $n++; }
        }
        return $n;
    }
}
$GLOBALS['wpdb'] = new FakeWpdb();

class FakeRequest implements ArrayAccess {
    private $params, $headers, $method, $route, $body;
    public function __construct($params = array(), $headers = array(), $method = 'POST', $route = '/de/v2/users/1', $body = '') {
        $this->params = $params; $this->method = $method; $this->route = $route; $this->body = $body;
        $this->headers = array();
        foreach ($headers as $k => $v) $this->headers[strtolower($k)] = $v;
    }
    public function get_param($k) { return isset($this->params[$k]) ? $this->params[$k] : null; }
    public function get_header($k) { $k = strtolower($k); return isset($this->headers[$k]) ? $this->headers[$k] : ''; }
    public function get_method() { return $this->method; }
    public function get_route() { return $this->route; }
    public function get_query_params() { return $this->params; }
    public function get_body() { return $this->body; }
    #[\ReturnTypeWillChange] public function offsetExists($o) { return isset($this->params[$o]); }
    #[\ReturnTypeWillChange] public function offsetGet($o) { return isset($this->params[$o]) ? $this->params[$o] : null; }
    #[\ReturnTypeWillChange] public function offsetSet($o, $v) { $this->params[$o] = $v; }
    #[\ReturnTypeWillChange] public function offsetUnset($o) { unset($this->params[$o]); }
}

require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-auth.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-rest.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-users.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-write.php';
require_once __DIR__ . '/../wordpress-plugin/digital-elements-helper/includes/um-content.php';

foreach ($GLOBALS['__actions']['rest_api_init'] as $cb) $cb();

/* ------------------------------------------------------------- helpers ---- */

$IDEM = 0;
function req($params = array(), $key = null) {
    global $IDEM;
    return new FakeRequest($params, array('idempotency-key' => $key === null ? 'k' . (++$IDEM) : $key));
}
function body($r) { return $r instanceof WP_REST_Response ? $r->get_data() : $r; }
function code($r) { $b = body($r); return isset($b['error']['code']) ? $b['error']['code'] : null; }

function mkuser($id, $roles = array('author'), $managed = true, $email = null) {
    $u = new WP_User(array('ID' => $id, 'user_login' => "u$id", 'user_email' => $email ?: "u$id@x.com", 'roles' => $roles));
    $GLOBALS['__users'][] = $u;
    if ($managed) $GLOBALS['__usermeta'][$id]['_de_managed'] = '1';
    return $u;
}
function mkpost($id, $author, $type = 'post', $status = 'publish') {
    $GLOBALS['__posts'][$id] = array('author' => $author, 'type' => $type, 'status' => $status);
}
function reset_all($scopes = null) {
    $GLOBALS['__users'] = array();
    $GLOBALS['__usermeta'] = array();
    $GLOBALS['__posts'] = array();
    $GLOBALS['__comments'] = array();
    $GLOBALS['__deleted_users'] = array();
    $GLOBALS['__options'] = array('admin_email' => 'owner@client.com');
    $GLOBALS['__options'][DEHELED_UM_KEY_ID] = 'dek';
    $GLOBALS['__options'][DEHELED_UM_SECRET] = 'sec';
    $GLOBALS['__options'][DEHELED_UM_SCOPES] = $scopes === null
        ? array_merge(deheled_um_default_scopes(), array('users:delete'))
        : $scopes;
}

/* ------------------------------------------------------ scope enforcement - */

echo "--- users:delete is OFF by default ---\n";
ok('users:delete is not a default scope', !in_array('users:delete', deheled_um_default_scopes(), true));
ok('it is one of the switches a site admin controls',
   array_key_exists('users:delete', deheled_um_optional_scopes()));
ok('content:reassign IS a default scope', in_array('content:reassign', deheled_um_default_scopes(), true));

reset_all(deheled_um_default_scopes());   // no users:delete
mkuser(10);
$deleteRoute = $GLOBALS['__routes']['de/v2/users/(?P<id>\d+)'];
$deleteCb = null;
foreach ($deleteRoute as $reg) {
    if ($reg['methods'] === 'DELETE') $deleteCb = $reg['permission_callback'];
}
ok('the DELETE route is registered', $deleteCb !== null);

// Drive the real permission callback with a correctly signed request.
function signed_for($route, $method = 'DELETE') {
    $ts = time(); $nonce = 'n' . mt_rand() . microtime(true);
    $canonical = deheled_um_canonical_string($method, $route, array(), $ts, $nonce, '', '');
    $sig = base64_encode(hash_hmac('sha256', $canonical, 'sec', true));
    return new FakeRequest(array(), array(
        'x-de-key-id' => 'dek', 'x-de-timestamp' => (string) $ts,
        'x-de-nonce' => $nonce, 'x-de-signature' => DEHELED_UM_SIG_VERSION . ' ' . $sig,
    ), $method, $route);
}
$denied = $deleteCb(signed_for('/de/v2/users/10'));
ok('deletion is refused when the site hasn\'t enabled users:delete',
   is_wp_error($denied) && $denied->get_error_data()['de_code'] === 'scope_denied');

$GLOBALS['__options'][DEHELED_UM_SCOPES] = array_merge(deheled_um_default_scopes(), array('users:delete'));
ok('...and allowed once the site enables it', $deleteCb(signed_for('/de/v2/users/10')) === true);

/* ---------------------------------------------------- ownership counting -- */

echo "\n--- ownership counts every registered post type ---\n";
reset_all();
mkuser(20);
mkpost(1, 20, 'post', 'publish');
mkpost(2, 20, 'post', 'publish');
mkpost(3, 20, 'post', 'draft');
mkpost(4, 20, 'page', 'publish');
mkpost(5, 20, 'attachment', 'inherit');
mkpost(6, 20, 'location', 'publish');     // custom post type
mkpost(7, 20, 'post', 'future');          // scheduled
mkpost(8, 20, 'post', 'trash');
mkpost(9, 20, 'revision', 'inherit');     // not content in its own right
mkpost(10, 99, 'post', 'publish');        // somebody else's
$GLOBALS['__comments'][1] = array('user_id' => 20);
$GLOBALS['__comments'][2] = array('user_id' => 99);

$counts = deheled_um_count_owned_content(20);
eq('total excludes revisions and other people\'s content', $counts['total'], 8);
ok('owns_content is the single question the delete turns on', $counts['owns_content'] === true);
eq('comments are counted', $counts['comments'], 1);

$byType = array();
foreach ($counts['by_type'] as $t) $byType[$t['type']] = $t['total'];
eq('posts', $byType['post'], 5);
eq('pages', $byType['page'], 1);
eq('media is counted as content', $byType['attachment'], 1);
ok('a CUSTOM post type is counted', isset($byType['location']) && $byType['location'] === 1);
ok('revisions are excluded', !isset($byType['revision']));

eq('scheduled content is broken out', $counts['by_status']['future'], 1);
eq('drafts are broken out', $counts['by_status']['draft'], 1);
eq('trashed content is broken out', $counts['by_status']['trash'], 1);
eq('published', $counts['by_status']['publish'], 4);

echo "\n--- an empty account reports empty ---\n";
reset_all();
mkuser(21);
$empty = deheled_um_count_owned_content(21);
eq('total zero', $empty['total'], 0);
ok('owns nothing', $empty['owns_content'] === false);

echo "\n--- the site's admin_email is flagged ---\n";
reset_all();
mkuser(22, array('author'), true, 'owner@client.com');
ok('deleting the admin_email owner is flagged', deheled_um_count_owned_content(22)['is_admin_email']);
reset_all();
mkuser(23);
ok('...and an ordinary account is not', deheled_um_count_owned_content(23)['is_admin_email'] === false);

/* ------------------------------------------------- reassignment targets --- */

echo "\n--- reassignment targets must be able to author ---\n";
reset_all();
mkuser(30, array('author'));
mkuser(31, array('editor'));
mkuser(32, array('subscriber'));
mkuser(33, array('administrator'));

$targets = deheled_um_reassign_targets(30);
$ids = array_map(function ($t) { return $t['id']; }, $targets);
ok('an editor is offered', in_array(31, $ids, true));
ok('an administrator is offered', in_array(33, $ids, true));
ok('a subscriber is NOT offered', !in_array(32, $ids, true));
ok('the account being emptied is excluded', !in_array(30, $ids, true));

eq('the same user is refused',
   code(deheled_um_require_reassign_target(30, 30)), 'reassign_target_invalid');
eq('a missing target is refused',
   code(deheled_um_require_reassign_target(0, 30)), 'reassign_target_required');
eq('a non-existent user is refused',
   code(deheled_um_require_reassign_target(9999, 30)), 'reassign_target_invalid');
eq('a user who cannot author is refused',
   code(deheled_um_require_reassign_target(32, 30)), 'reassign_target_invalid');
ok('a valid target passes', deheled_um_require_reassign_target(31, 30) instanceof WP_User);

/* ----------------------------------------------------------- reassigning -- */

echo "\n--- a client's own content is never reassigned ---\n";
// Reassignment rewrites authorship of every post the account owns AND
// overwrites the stored name and email on its comments in place, so it cannot
// be undone by running it backwards. It is guarded exactly like deleting.
reset_all();
mkuser(38, array('author'), false);      // a client's own account
mkuser(39, array('editor'));
mkpost(1, 38, 'post', 'publish');
eq('refused as not_managed',
   code(deheled_um_rest_reassign(req(array('id' => 38, 'target_id' => 39)))), 'not_managed');
eq('...and their content is untouched', $GLOBALS['__posts'][1]['author'], 38);
eq('...the recipient gained nothing', deheled_um_count_owned_content(39)['total'], 0);

echo "\n--- reassignment moves everything and verifies ---\n";
reset_all();
mkuser(40); mkuser(41, array('editor'));
mkpost(1, 40, 'post', 'publish');
mkpost(2, 40, 'page', 'draft');
mkpost(3, 40, 'attachment', 'inherit');
mkpost(4, 40, 'location', 'future');
$GLOBALS['__comments'][1] = array('user_id' => 40);

$re = body(deheled_um_rest_reassign(req(array('id' => 40, 'target_id' => 41))));
eq('reports reassigned', $re['result'], 'reassigned');
eq('moved every post type', $re['moved']['posts'], 4);
eq('moved the comment', $re['moved']['comments'], 1);
eq('nothing remains', $re['remaining']['total'], 0);
eq('no comments remain', $re['remaining']['comments'], 0);
ok('and says so as verified', $re['verified'] === true);
eq('the recipient now owns it', deheled_um_count_owned_content(41)['total'], 4);
ok('the before-state is reported for the audit trail', $re['before']['total'] === 4);

/* ------------------------------------------------------ guarded deletion -- */

echo "\n--- deletion is refused while content remains ---\n";
reset_all();
mkuser(50);
mkpost(1, 50, 'post', 'publish');
$refused = deheled_um_rest_delete_user(req(array('id' => 50, 'confirm' => true)));
eq('refused with has_content', code($refused), 'has_content');
ok('...naming what is in the way', strpos(body($refused)['error']['message'], '1 item') !== false);
ok('...and carrying the breakdown', isset(body($refused)['error']['content']['by_type']));
ok('the user still exists', get_user_by('id', 50) !== false);
eq('wp_delete_user was never called', count($GLOBALS['__deleted_users']), 0);

echo "\n--- comments alone also block deletion ---\n";
reset_all();
mkuser(51);
$GLOBALS['__comments'][1] = array('user_id' => 51);
eq('refused', code(deheled_um_rest_delete_user(req(array('id' => 51, 'confirm' => true)))), 'has_content');
ok('the user still exists', get_user_by('id', 51) !== false);

echo "\n--- deletion needs an explicit confirmation ---\n";
reset_all();
mkuser(52);
eq('no confirm flag is refused',
   code(deheled_um_rest_delete_user(req(array('id' => 52)))), 'confirmation_required');
ok('the user still exists', get_user_by('id', 52) !== false);

echo "\n--- a client's own account is never deleted ---\n";
reset_all();
mkuser(53, array('author'), false);   // unmanaged
eq('refused as not_managed',
   code(deheled_um_rest_delete_user(req(array('id' => 53, 'confirm' => true)))), 'not_managed');
ok('the account survives', get_user_by('id', 53) !== false);

echo "\n--- the last administrator is never deleted ---\n";
reset_all();
mkuser(54, array('administrator'));
eq('refused', code(deheled_um_rest_delete_user(req(array('id' => 54, 'confirm' => true)))), 'last_administrator');
ok('they still exist', get_user_by('id', 54) !== false);
mkuser(55, array('administrator'));
ok('with a second administrator, deletion proceeds',
   body(deheled_um_rest_delete_user(req(array('id' => 54, 'confirm' => true))))['result'] === 'deleted');

echo "\n--- an emptied account CAN be deleted ---\n";
reset_all();
mkuser(60); mkuser(61, array('editor'));
mkpost(1, 60, 'post', 'publish');
mkpost(2, 60, 'location', 'future');
deheled_um_rest_reassign(req(array('id' => 60, 'target_id' => 61)));
$deleted = body(deheled_um_rest_delete_user(req(array('id' => 60, 'confirm' => true, 'reassign_target' => 61))));

eq('deleted', $deleted['result'], 'deleted');
ok('...confirming it verified emptiness at delete time', $deleted['verified_empty_at_delete'] === true);
eq('...echoing the reassignment target', $deleted['reassigned_to'], 61);
ok('the user is gone', get_user_by('id', 60) === false);
eq('the content survives under the new owner', deheled_um_count_owned_content(61)['total'], 2);
// WordPress's own $reassign argument only moves posts and links, and DELETES
// everything else — so it is never used.
ok('wp_delete_user was called with no reassign argument',
   $GLOBALS['__deleted_users'][0]['reassign'] === null);

/* ----------------------------------------- THE STALE-UI ORPHAN SCENARIO --- */

echo "\n--- a stale dashboard can never orphan content ---\n";
reset_all();
mkuser(70); mkuser(71, array('editor'));
mkpost(1, 70, 'post', 'publish');

// The dashboard checks, reassigns, and sees a verified zero.
$verified = body(deheled_um_rest_reassign(req(array('id' => 70, 'target_id' => 71))));
ok('the dashboard is told zero remain', $verified['remaining']['total'] === 0);

// ...then the confirmation screen sits there while the site keeps working.
mkpost(2, 70, 'post', 'publish');          // someone publishes
mkpost(3, 70, 'attachment', 'inherit');    // a plugin adds media

$stale = deheled_um_rest_delete_user(req(array('id' => 70, 'confirm' => true, 'reassign_target' => 71)));
eq('the delete is refused on the re-count', code($stale), 'has_content');
ok('the user still exists', get_user_by('id', 70) !== false);
eq('nothing was destroyed', deheled_um_count_owned_content(70)['total'], 2);
eq('wp_delete_user was never reached', count($GLOBALS['__deleted_users']), 0);

// The same thing for a scheduled post going live between check and click.
reset_all();
mkuser(72); mkuser(73, array('editor'));
deheled_um_rest_reassign(req(array('id' => 72, 'target_id' => 73)));
mkpost(9, 72, 'post', 'future');
eq('a newly scheduled post also blocks the delete',
   code(deheled_um_rest_delete_user(req(array('id' => 72, 'confirm' => true)))), 'has_content');
ok('...and the account survives', get_user_by('id', 72) !== false);

/* ------------------------------------------------------------ idempotency - */

echo "\n--- deletion is idempotent ---\n";
reset_all();
mkuser(80); mkuser(81, array('administrator'));
$k = 'delete-once';
$first = body(deheled_um_rest_delete_user(req(array('id' => 80, 'confirm' => true), $k)));
eq('deleted', $first['result'], 'deleted');
eq('one deletion recorded', count($GLOBALS['__deleted_users']), 1);

$again = deheled_um_rest_delete_user(req(array('id' => 80, 'confirm' => true), $k));
eq('a replay returns the stored result', body($again)['result'], 'deleted');
eq('...flagged as a replay', $again->get_headers()['X-DE-Idempotent-Replay'], '1');
eq('...and deletes nothing further', count($GLOBALS['__deleted_users']), 1);

// A fresh key on a user that no longer exists is a not_found, not a crash.
eq('deleting a gone user reports not_found',
   code(deheled_um_rest_delete_user(req(array('id' => 80, 'confirm' => true), 'other-key'))), 'not_found');

echo "\n--- reassignment is idempotent too ---\n";
reset_all();
mkuser(90); mkuser(91, array('editor'));
mkpost(1, 90, 'post', 'publish');
$rk = 'reassign-once';
$r1 = body(deheled_um_rest_reassign(req(array('id' => 90, 'target_id' => 91), $rk)));
eq('moved one post', $r1['moved']['posts'], 1);
// Content created after the move must not be swept along by a replay.
mkpost(2, 90, 'post', 'publish');
$r2 = body(deheled_um_rest_reassign(req(array('id' => 90, 'target_id' => 91), $rk)));
eq('the replay returns the original result', $r2['moved']['posts'], 1);
eq('...and does not move the new post', $GLOBALS['__posts'][2]['author'], 90);

echo "\n";
echo $FAIL ? "$FAIL assertion(s) failed\n" : "All assertions passed\n";
exit($FAIL ? 1 : 0);
