<?php
/**
 * Live verification of the helper plugin against a real WordPress install.
 *
 * The suites under tests/ cover the pure logic without a database. This covers
 * what they can't: REST route registration, the permission callback, and the
 * data-collection paths that actually query WordPress and touch the filesystem.
 *
 * Read-only apart from the plugin's own result cache, which is saved and
 * restored around the run.
 *
 *   php scripts/live-check.php <path-to-wordpress-root>
 *
 * e.g. php scripts/live-check.php D:/laragon/www/wordpresstester
 *
 * Requires the site's database to be reachable (start MySQL first). The plugin
 * does NOT need to be installed in wp-content/plugins — it is loaded directly
 * from this repo, so you always test the working copy.
 */

if (PHP_SAPI !== 'cli') { exit(1); }

$wp_root = isset($argv[1]) ? $argv[1] : '';
if (!$wp_root || !file_exists(rtrim($wp_root, '/\\') . '/wp-load.php')) {
    fwrite(STDERR, "\nUsage: php scripts/live-check.php <path-to-wordpress-root>\n"
        . "       (a directory containing wp-load.php)\n\n");
    exit(1);
}

$de_plugin_path = __DIR__ . '/../wordpress-plugin/digital-elements-helper/digital-elements-helper.php';
if (!file_exists($de_plugin_path)) {
    fwrite(STDERR, "Plugin not found at $de_plugin_path\n");
    exit(1);
}

define('WP_USE_THEMES', false);
require_once rtrim($wp_root, '/\\') . '/wp-load.php';
// NOTE: load the plugin AFTER wp-load — and never into a variable named
// $plugin, which wp-settings.php uses for its own plugin loop and then unsets.
require_once $de_plugin_path;

$fail = 0;
function ok($label, $cond, $extra = '') {
    global $fail;
    if ($cond) { echo "PASS  $label\n"; }
    else { $fail++; echo "FAIL  $label" . ($extra ? "  ($extra)" : '') . "\n"; }
}

echo "\nWordPress " . get_bloginfo('version') . " at $wp_root\n";
echo "Plugin " . DEHELED_VERSION . " loaded from the working copy\n";

// ---------------------------------------------------------------- REST routes
echo "\n=== REST routes ===\n";
$server = rest_get_server();
do_action('rest_api_init', $server);
$routes = $server->get_routes();

$expected = array(
    '/wpmonitor/v1/status',
    '/wpmonitor/v1/security',
    '/wpmonitor/v1/optimize/clear-cache',
    '/wpmonitor/v1/optimize/remove-transients',
    '/wpmonitor/v1/optimize/images',
);
foreach ($expected as $p) ok("route registered: $p", isset($routes[$p]));

if (isset($routes['/wpmonitor/v1/optimize/images'])) {
    $h = $routes['/wpmonitor/v1/optimize/images'][0];
    ok('images: POST only', !empty($h['methods']['POST']) && empty($h['methods']['GET']));
    ok('images: token-guarded', $h['permission_callback'] === 'deheled_check_token');
    ok('images: fresh arg has a schema', isset($h['args']['fresh']['type']) && $h['args']['fresh']['type'] === 'boolean');
}

// Every wpmonitor route must be behind the token check — no accidental openings.
foreach ($routes as $path => $handlers) {
    if (strpos($path, '/wpmonitor/') !== 0) continue;
    foreach ($handlers as $h) {
        if (!isset($h['permission_callback'])) continue;
        ok("guarded: $path", $h['permission_callback'] === 'deheled_check_token',
            is_string($h['permission_callback']) ? $h['permission_callback'] : gettype($h['permission_callback']));
    }
}

ok('unauthenticated request refused', (function () {
    $res = deheled_check_token(new WP_REST_Request('POST', '/wpmonitor/v1/optimize/images'));
    return $res === false || is_wp_error($res);
})());

// ------------------------------------------------------- image audit collector
echo "\n=== Image audit: collector against the real library ===\n";
$cfg = deheled_images_config();
ok('threshold is an int even though the filter returns a string', $cfg['oversize_px'] === (int) $cfg['oversize_px']);

$t0   = microtime(true);
$scan = deheled_images_collect($cfg);
$ms   = (int) round((microtime(true) - $t0) * 1000);
printf("candidates=%d collected=%d capped=%s timed_out=%s in %dms\n",
    $scan['candidates'], count($scan['items']),
    $scan['capped'] ? 'yes' : 'no', $scan['timed_out'] ? 'yes' : 'no', $ms);

ok('finished inside the dashboard proxy timeout (30s)', $ms < 30000, "{$ms}ms");
ok('collected count is consistent', count($scan['items']) <= $scan['candidates']);

$badShape = 0; $missing = 0; $withBytes = 0; $withDims = 0;
foreach ($scan['items'] as $it) {
    foreach (array('id','file','mime','width','height','bytes','has_webp','missing') as $k) {
        if (!array_key_exists($k, $it)) { $badShape++; break; }
    }
    if (!empty($it['missing'])) { $missing++; continue; }
    if ($it['bytes'] > 0) $withBytes++;
    if ($it['width'] > 0 && $it['height'] > 0) $withDims++;
}
ok('all records well-formed for the classifier', $badShape === 0, "$badShape malformed");
if ($scan['candidates'] > 0) {
    ok('resolved real byte sizes', $withBytes > 0);
    ok('resolved real dimensions', $withDims > 0);
}
echo "  (attachments whose file is missing on disk: $missing)\n";

$rep = deheled_images_classify($scan['items'], $cfg);
printf("scanned=%d total=%s est_recoverable=%s oversized=%d large=%d no_webp=%d\n",
    $rep['scanned'], deheled_images_bytes($rep['total_bytes']),
    deheled_images_bytes($rep['est_total_bytes']),
    $rep['oversized']['count'], $rep['large']['count'], $rep['missing_webp']['count']);

ok('scanned + missing == collected', $rep['scanned'] + $rep['missing_files'] === count($scan['items']));
ok('estimate never exceeds the library size', $rep['est_total_bytes'] <= $rep['total_bytes']);
ok('estimate is non-negative', $rep['est_total_bytes'] >= 0);

foreach (deheled_images_layers($rep, $scan) as $l) {
    printf("  %-18s %-9s %s\n", $l['name'], $l['status'], $l['detail']);
}

// ------------------------------------------------------------- REST behaviour
echo "\n=== Image audit: REST handler ===\n";
$cache_before = get_option(DEHELED_IMG_OPTION, null);

$mk = function ($fresh) {
    $r = new WP_REST_Request('POST', '/wpmonitor/v1/optimize/images');
    $r->set_param('fresh', $fresh);
    return $r;
};
$unwrap = function ($res) { return is_array($res) ? $res : $res->get_data(); };

$r1 = $unwrap(deheled_optimize_images($mk(true)));
ok('fresh run succeeds', !empty($r1['ok']));
ok('fresh run is not marked cached', $r1['cached'] === false);
ok('declares itself read-only', $r1['read_only'] === true);
ok('action name is optimize-images', $r1['action'] === 'optimize-images');
ok('returns at least four layers', is_array($r1['layers']) && count($r1['layers']) >= 4);
ok('returns the images payload', isset($r1['images']['scanned']));

$r2 = $unwrap(deheled_optimize_images($mk(false)));
ok('repeat call is served from cache', !empty($r2['cached']));
ok('cached payload agrees with the fresh one', $r2['images']['scanned'] === $r1['images']['scanned']);

$r3 = $unwrap(deheled_optimize_images($mk(true)));
ok('fresh=1 bypasses the cache', $r3['cached'] === false);

global $wpdb;
$autoload = $wpdb->get_var($wpdb->prepare(
    "SELECT autoload FROM {$wpdb->options} WHERE option_name = %s", DEHELED_IMG_OPTION));
ok('result cache is not autoloaded', $autoload === 'no', var_export($autoload, true));

$json = json_encode($r1);
ok('payload survives JSON encoding', $json !== false && json_last_error() === JSON_ERROR_NONE, json_last_error_msg());
printf("  payload size over the wire: %s\n", deheled_images_bytes(strlen($json)));

// Restore the cache option to whatever it was before this run.
if ($cache_before === null) delete_option(DEHELED_IMG_OPTION);
else update_option(DEHELED_IMG_OPTION, $cache_before, false);
echo "  (restored " . DEHELED_IMG_OPTION . ")\n";

echo "\n" . ($fail ? "FAILED: $fail check(s) failed\n\n" : "OK: all live checks passed\n\n");
exit($fail ? 1 : 0);
