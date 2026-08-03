<?php
/**
 * Tests for the image audit. Runs without WordPress or MySQL: we stub the few
 * WP functions the file touches at load time, then exercise the pure classifier
 * and the byte/layer formatting directly. Real image files are generated with GD
 * to check has_webp detection and the filesize path against the filesystem.
 */

// --- Minimal WP surface needed just to load the file -----------------------
define('ABSPATH', __DIR__);
define('HOUR_IN_SECONDS', 3600);
function add_action($h, $c, $p = 10, $a = 1) {}
function register_rest_route($ns, $route, $args = array()) {}
function apply_filters($tag, $value) { return $value; }
function rest_ensure_response($d) { return $d; }
function current_time($f) { return '2026-08-04T12:00:00+00:00'; }
function get_option($k, $d = null) { return $d; }
function update_option($k, $v, $autoload = null) { return true; }
function rest_sanitize_boolean($v) { return (bool) $v; }

require dirname(__DIR__) . '/wordpress-plugin/digital-elements-helper/includes/optimize-images.php';

$pass = 0; $fail = 0;
function ok($label, $cond, $extra = '') {
    global $pass, $fail;
    if ($cond) { $pass++; echo "PASS  $label\n"; }
    else { $fail++; echo "FAIL  $label" . ($extra ? "  ($extra)" : '') . "\n"; }
}
function eq($label, $actual, $expected) {
    ok($label, $actual === $expected, "expected " . var_export($expected, true) . ", got " . var_export($actual, true));
}

$cfg = deheled_images_config();
echo "config: oversize_px={$cfg['oversize_px']} large_bytes={$cfg['large_bytes']} webp_ratio={$cfg['webp_ratio']}\n\n";

// ---------------------------------------------------------------- byte format
echo "--- deheled_images_bytes ---\n";
eq('0 bytes',        deheled_images_bytes(0),        '0 B');
eq('negative clamps',deheled_images_bytes(-5),       '0 B');
eq('512 B',          deheled_images_bytes(512),      '512 B');
eq('1 KB',           deheled_images_bytes(1024),     '1.0 KB');
eq('1.5 MB',         deheled_images_bytes(1572864),  '1.5 MB');
eq('large MB no dec',deheled_images_bytes(52428800), '50 MB');
eq('1 GB',           deheled_images_bytes(1073741824),'1.0 GB');

// ------------------------------------------------------------- classification
echo "\n--- deheled_images_classify ---\n";

// Empty library.
$r = deheled_images_classify(array(), $cfg);
eq('empty: scanned',   $r['scanned'], 0);
eq('empty: est total', $r['est_total_bytes'], 0);
eq('empty: oversized', $r['oversized']['count'], 0);

// A single well-optimised image: small, within threshold, already has WebP.
$r = deheled_images_classify(array(
    array('id'=>1,'file'=>'good.jpg','mime'=>'image/jpeg','width'=>1200,'height'=>800,'bytes'=>90000,'has_webp'=>true,'missing'=>false),
), $cfg);
eq('clean: scanned',      $r['scanned'], 1);
eq('clean: oversized',    $r['oversized']['count'], 0);
eq('clean: large',        $r['large']['count'], 0);
eq('clean: missing webp', $r['missing_webp']['count'], 0);
eq('clean: nothing to recover', $r['est_total_bytes'], 0);

// Oversized: 5120px wide, threshold 2560 -> linear scale 0.5, area 0.25.
// 4,000,000 bytes -> projected 1,000,000; saving 3,000,000.
$r = deheled_images_classify(array(
    array('id'=>2,'file'=>'huge.jpg','mime'=>'image/jpeg','width'=>5120,'height'=>2880,'bytes'=>4000000,'has_webp'=>true,'missing'=>false),
), $cfg);
eq('oversized: counted',   $r['oversized']['count'], 1);
eq('oversized: est bytes', $r['oversized']['est_bytes'], 3000000);
eq('oversized: also large',$r['large']['count'], 1);
eq('oversized: est total', $r['est_total_bytes'], 3000000);

// Estimates must chain, not double-count. Same image, no WebP:
// resize 4,000,000 -> 1,000,000, then WebP takes 28% of 1,000,000 = 280,000.
// Total recoverable = 3,000,000 + 280,000 = 3,280,000 (NOT 3,000,000 + 1,120,000).
$r = deheled_images_classify(array(
    array('id'=>3,'file'=>'huge2.jpg','mime'=>'image/jpeg','width'=>5120,'height'=>2880,'bytes'=>4000000,'has_webp'=>false,'missing'=>false),
), $cfg);
eq('chained: webp est on reduced size', $r['missing_webp']['est_bytes'], 280000);
eq('chained: est total no double count', $r['est_total_bytes'], 3280000);
ok('chained: total below original size', $r['est_total_bytes'] < 4000000);

// Non-convertible formats are not flagged for WebP.
$r = deheled_images_classify(array(
    array('id'=>4,'file'=>'logo.svg','mime'=>'image/svg+xml','width'=>0,'height'=>0,'bytes'=>2000,'has_webp'=>false,'missing'=>false),
    array('id'=>5,'file'=>'anim.gif','mime'=>'image/gif','width'=>400,'height'=>300,'bytes'=>3000,'has_webp'=>false,'missing'=>false),
    array('id'=>6,'file'=>'photo.webp','mime'=>'image/webp','width'=>800,'height'=>600,'bytes'=>4000,'has_webp'=>false,'missing'=>false),
), $cfg);
eq('svg/gif/webp not webp candidates', $r['missing_webp']['count'], 0);
eq('all three still scanned', $r['scanned'], 3);

// PNG is a candidate.
$r = deheled_images_classify(array(
    array('id'=>7,'file'=>'shot.png','mime'=>'image/png','width'=>1000,'height'=>800,'bytes'=>200000,'has_webp'=>false,'missing'=>false),
), $cfg);
eq('png is a webp candidate', $r['missing_webp']['count'], 1);
eq('png webp estimate', $r['missing_webp']['est_bytes'], 56000);

// Missing files are separated out and excluded from scanned/total.
$r = deheled_images_classify(array(
    array('id'=>8,'file'=>'gone.jpg','mime'=>'image/jpeg','width'=>3000,'height'=>2000,'bytes'=>0,'has_webp'=>false,'missing'=>true),
    array('id'=>9,'file'=>'here.jpg','mime'=>'image/jpeg','width'=>800,'height'=>600,'bytes'=>50000,'has_webp'=>true,'missing'=>false),
), $cfg);
eq('missing counted separately', $r['missing_files'], 1);
eq('missing excluded from scanned', $r['scanned'], 1);
eq('missing excluded from bytes', $r['total_bytes'], 50000);
eq('missing not flagged oversized', $r['oversized']['count'], 0);

// Zero-byte file must not produce a divide/estimate artefact.
$r = deheled_images_classify(array(
    array('id'=>10,'file'=>'empty.jpg','mime'=>'image/jpeg','width'=>4000,'height'=>3000,'bytes'=>0,'has_webp'=>false,'missing'=>false),
), $cfg);
eq('zero-byte: no oversize estimate', $r['oversized']['count'], 0);
eq('zero-byte: est total 0', $r['est_total_bytes'], 0);

// Boundary: exactly at the oversize threshold is NOT oversized; one over is.
$r = deheled_images_classify(array(
    array('id'=>11,'file'=>'at.jpg','mime'=>'image/jpeg','width'=>2560,'height'=>1440,'bytes'=>800000,'has_webp'=>true,'missing'=>false),
    array('id'=>12,'file'=>'over.jpg','mime'=>'image/jpeg','width'=>2561,'height'=>1440,'bytes'=>800000,'has_webp'=>true,'missing'=>false),
), $cfg);
eq('threshold boundary exclusive', $r['oversized']['count'], 1);
eq('boundary: the 2561px one', $r['oversized']['samples'][0]['file'], 'over.jpg');

// Boundary: large_bytes is inclusive (>=).
$r = deheled_images_classify(array(
    array('id'=>13,'file'=>'exact.jpg','mime'=>'image/jpeg','width'=>900,'height'=>600,'bytes'=>$cfg['large_bytes'],'has_webp'=>true,'missing'=>false),
    array('id'=>14,'file'=>'under.jpg','mime'=>'image/jpeg','width'=>900,'height'=>600,'bytes'=>$cfg['large_bytes']-1,'has_webp'=>true,'missing'=>false),
), $cfg);
eq('large threshold inclusive', $r['large']['count'], 1);

// Samples are capped and ordered by impact, biggest first.
$many = array();
for ($i = 0; $i < 12; $i++) {
    $many[] = array('id'=>100+$i,'file'=>"big{$i}.jpg",'mime'=>'image/jpeg',
        'width'=>5000,'height'=>3000,'bytes'=>(1000000 * ($i + 1)),'has_webp'=>true,'missing'=>false);
}
$r = deheled_images_classify($many, $cfg);
eq('samples capped at config', count($r['oversized']['samples']), $cfg['samples']);
eq('samples ordered desc: first is biggest', $r['oversized']['samples'][0]['file'], 'big11.jpg');
ok('samples strictly descending', (function ($s) {
    for ($i = 1; $i < count($s); $i++) if ($s[$i-1]['est_saved'] < $s[$i]['est_saved']) return false;
    return true;
})($r['oversized']['samples']));
eq('all 12 still counted', $r['oversized']['count'], 12);

// ------------------------------------------------------------------- layers
echo "\n--- deheled_images_layers ---\n";
$scanMeta = array('candidates'=>2,'capped'=>false,'timed_out'=>false,'duration_ms'=>12);
$clean = deheled_images_classify(array(
    array('id'=>1,'file'=>'a.jpg','mime'=>'image/jpeg','width'=>1000,'height'=>800,'bytes'=>50000,'has_webp'=>true,'missing'=>false),
), $cfg);
$layers = deheled_images_layers($clean, $scanMeta);
$byName = array();
foreach ($layers as $l) $byName[$l['name']] = $l;
ok('layer: Media library present', isset($byName['Media library']));
eq('clean library all verified', count(array_filter($layers, function ($l) { return $l['status'] === 'verified'; })), count($layers));
ok('no Missing files layer when none', !isset($byName['Missing files']));

$dirty = deheled_images_classify(array(
    array('id'=>2,'file'=>'x.jpg','mime'=>'image/jpeg','width'=>6000,'height'=>4000,'bytes'=>5000000,'has_webp'=>false,'missing'=>false),
    array('id'=>3,'file'=>'y.jpg','mime'=>'image/jpeg','width'=>100,'height'=>100,'bytes'=>0,'has_webp'=>false,'missing'=>true),
), $cfg);
$layers = deheled_images_layers($dirty, array('candidates'=>2,'capped'=>false,'timed_out'=>false,'duration_ms'=>5));
$byName = array();
foreach ($layers as $l) $byName[$l['name']] = $l;
eq('oversized layer flags findings', $byName['Oversized images']['status'], 'cleared');
eq('webp layer flags findings', $byName['WebP coverage']['status'], 'cleared');
ok('Missing files layer appears', isset($byName['Missing files']));

// A truncated scan must say so in the Media library line.
$layers = deheled_images_layers($dirty, array('candidates'=>9000,'capped'=>true,'timed_out'=>false,'duration_ms'=>12000));
$media = null; foreach ($layers as $l) if ($l['name'] === 'Media library') $media = $l;
ok('capped scan disclosed', strpos($media['detail'], 'partial scan') !== false, $media['detail']);
ok('capped reason named', strpos($media['detail'], 'item cap') !== false, $media['detail']);

$layers = deheled_images_layers($dirty, array('candidates'=>9000,'capped'=>false,'timed_out'=>true,'duration_ms'=>12000));
$media = null; foreach ($layers as $l) if ($l['name'] === 'Media library') $media = $l;
ok('timeout reason named', strpos($media['detail'], 'time budget') !== false, $media['detail']);

// -------------------------------------------------- has_webp against real files
echo "\n--- deheled_images_has_webp (real files, GD) ---\n";
$tmp = sys_get_temp_dir() . '/deheled_img_' . getmypid();
@mkdir($tmp, 0777, true);
$mk = function ($name, $w, $h) use ($tmp) {
    $im = imagecreatetruecolor($w, $h);
    imagefill($im, 0, 0, imagecolorallocate($im, 120, 140, 160));
    $p = $tmp . '/' . $name;
    if (substr($name, -4) === '.png') imagepng($im, $p); else imagejpeg($im, $p, 85);
    imagedestroy($im);
    return $p;
};
$plain    = $mk('plain.jpg', 60, 40);
$swapped  = $mk('swapped.jpg', 60, 40);
$appended = $mk('appended.jpg', 60, 40);
touch($tmp . '/swapped.webp');           // photo.jpg -> photo.webp
touch($tmp . '/appended.jpg.webp');      // photo.jpg -> photo.jpg.webp

ok('no webp sibling -> false', deheled_images_has_webp($plain) === false);
ok('swapped-extension webp found', deheled_images_has_webp($swapped) === true);
ok('appended-extension webp found', deheled_images_has_webp($appended) === true);
ok('empty path -> false', deheled_images_has_webp('') === false);
ok('nonexistent path -> false', deheled_images_has_webp($tmp . '/nope.jpg') === false);

// Real dimensions/filesize feed the classifier correctly.
$big = $mk('real-big.jpg', 3200, 1800);
$sz  = getimagesize($big);
$r = deheled_images_classify(array(array(
    'id'=>1,'file'=>basename($big),'mime'=>'image/jpeg',
    'width'=>$sz[0],'height'=>$sz[1],'bytes'=>filesize($big),
    'has_webp'=>deheled_images_has_webp($big),'missing'=>false,
)), $cfg);
eq('real 3200px image flagged oversized', $r['oversized']['count'], 1);
ok('real image estimate is positive and under file size',
   $r['est_total_bytes'] > 0 && $r['est_total_bytes'] < filesize($big),
   "est={$r['est_total_bytes']} size=" . filesize($big));

// cleanup
foreach (glob($tmp . '/*') as $f) @unlink($f);
@rmdir($tmp);

echo "\n" . ($fail ? "FAILED: $fail failed, $pass passed\n" : "OK: all $pass checks passed\n");
exit($fail ? 1 : 0);
