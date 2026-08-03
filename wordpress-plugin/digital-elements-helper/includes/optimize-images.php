<?php
/**
 * Image audit — the "Optimize Images" action.
 *
 * READ-ONLY BY DESIGN. This reports what could be improved in the media library
 * and changes nothing: no file is rewritten, resized, converted, or deleted.
 * That keeps it safe to run unattended on a schedule, and makes it the input for
 * the dashboard's monthly optimize-or-recommend flow. Anything destructive
 * (recompression, WebP generation) belongs in a separate, approval-gated action.
 *
 * Structure note: the classification logic is a pure function
 * (deheled_images_classify) that takes plain arrays and returns the report, with
 * all WordPress access confined to deheled_images_collect(). That split is what
 * makes the thresholds and estimates testable without a database.
 *
 * Savings figures are ESTIMATES derived from pixel area and typical WebP ratios,
 * not measured re-encodes. They are labelled as such everywhere they surface.
 */
if (!defined('ABSPATH')) { exit; }

define('DEHELED_IMG_OPTION', 'deheled_images_result');

add_action('rest_api_init', function () {
    register_rest_route('wpmonitor/v1', '/optimize/images', array(
        'methods'             => 'POST',
        'permission_callback' => 'deheled_check_token',
        'callback'            => 'deheled_optimize_images',
        'args'                => array(
            'fresh' => array(
                'type'              => 'boolean',
                'required'          => false,
                'default'           => false,
                'sanitize_callback' => 'rest_sanitize_boolean',
            ),
        ),
    ));
});

/**
 * Tunable thresholds. Filterable so a site with unusual needs can adjust them
 * without forking the plugin.
 */
function deheled_images_config() {
    return array(
        // Width beyond which WordPress itself considers an upload "big".
        'oversize_px'   => max(320, (int) apply_filters('big_image_size_threshold', 2560)),
        // Per-file byte size worth flagging on its own.
        'large_bytes'   => max(50 * 1024, (int) apply_filters('deheled_images_large_bytes', 500 * 1024)),
        // Conservative mean saving from a WebP re-encode of a JPEG/PNG.
        'webp_ratio'    => 0.28,
        // Hard caps so the scan can never run away on a huge library.
        'max_items'     => max(100, (int) apply_filters('deheled_images_max_items', 5000)),
        'budget_ms'     => max(2000, (int) apply_filters('deheled_images_budget_ms', 12000)),
        // How long a cached report stays fresh.
        'cache_ttl'     => max(300, (int) apply_filters('deheled_images_cache_ttl', 12 * HOUR_IN_SECONDS)),
        'samples'       => 5,
    );
}

/**
 * Classify a list of image records into the audit report. Pure: no WordPress,
 * no filesystem, no database — every input arrives in $items.
 *
 * Each item: array(
 *   'id' => int, 'file' => string (relative path for display),
 *   'mime' => string, 'width' => int, 'height' => int,
 *   'bytes' => int, 'has_webp' => bool, 'missing' => bool
 * )
 *
 * Estimates are chained rather than summed independently: an oversized image is
 * first reduced by area, and the WebP saving is then applied to that smaller
 * figure. Summing both against the original size would double-count.
 */
function deheled_images_classify(array $items, array $cfg) {
    $rep = array(
        'scanned'      => 0,
        'total_bytes'  => 0,
        'missing_files' => 0,
        'oversized'    => array('count' => 0, 'est_bytes' => 0, 'threshold_px' => $cfg['oversize_px'], 'samples' => array()),
        'large'        => array('count' => 0, 'threshold_bytes' => $cfg['large_bytes'], 'samples' => array()),
        'missing_webp' => array('count' => 0, 'est_bytes' => 0, 'samples' => array()),
        'est_total_bytes' => 0,
    );

    foreach ($items as $it) {
        $bytes  = isset($it['bytes']) ? (int) $it['bytes'] : 0;
        $width  = isset($it['width']) ? (int) $it['width'] : 0;
        $mime   = isset($it['mime']) ? (string) $it['mime'] : '';
        $file   = isset($it['file']) ? (string) $it['file'] : '';

        if (!empty($it['missing'])) {
            $rep['missing_files']++;
            continue;
        }

        $rep['scanned']++;
        $rep['total_bytes'] += $bytes;

        // Running estimate of this file's optimised size, refined per rule.
        $projected = $bytes;

        // --- Oversized: stored far wider than any sensible render width -------
        if ($width > $cfg['oversize_px'] && $bytes > 0) {
            $scale  = $cfg['oversize_px'] / $width;          // linear
            $after  = (int) round($bytes * $scale * $scale);  // bytes track area
            $saved  = max(0, $bytes - $after);
            $rep['oversized']['count']++;
            $rep['oversized']['est_bytes'] += $saved;
            $rep['oversized']['samples'][] = array(
                'file' => $file, 'width' => $width,
                'height' => isset($it['height']) ? (int) $it['height'] : 0,
                'bytes' => $bytes, 'est_saved' => $saved,
            );
            $projected = $after;
        }

        // --- Large files worth a look regardless of dimensions ---------------
        if ($bytes >= $cfg['large_bytes']) {
            $rep['large']['count']++;
            $rep['large']['samples'][] = array('file' => $file, 'bytes' => $bytes);
        }

        // --- No WebP sibling: applies to the projected (post-resize) size ----
        if (empty($it['has_webp']) && deheled_images_webp_candidate($mime)) {
            $saved = (int) round($projected * $cfg['webp_ratio']);
            $rep['missing_webp']['count']++;
            $rep['missing_webp']['est_bytes'] += $saved;
            $rep['missing_webp']['samples'][] = array('file' => $file, 'bytes' => $bytes, 'est_saved' => $saved);
            $projected -= $saved;
        }

        $rep['est_total_bytes'] += max(0, $bytes - $projected);
    }

    // Keep only the highest-impact samples, biggest first.
    $rep['oversized']['samples']    = deheled_images_top($rep['oversized']['samples'], 'est_saved', $cfg['samples']);
    $rep['large']['samples']        = deheled_images_top($rep['large']['samples'], 'bytes', $cfg['samples']);
    $rep['missing_webp']['samples'] = deheled_images_top($rep['missing_webp']['samples'], 'est_saved', $cfg['samples']);

    return $rep;
}

/** Formats that are worth converting to WebP. */
function deheled_images_webp_candidate($mime) {
    return in_array($mime, array('image/jpeg', 'image/jpg', 'image/png'), true);
}

/** Sort descending by $key and take the first $n. */
function deheled_images_top(array $rows, $key, $n) {
    usort($rows, function ($a, $b) use ($key) {
        $av = isset($a[$key]) ? $a[$key] : 0;
        $bv = isset($b[$key]) ? $b[$key] : 0;
        if ($av === $bv) return 0;
        return ($av < $bv) ? 1 : -1;
    });
    return array_slice($rows, 0, max(0, (int) $n));
}

/**
 * Does a WebP sibling exist for this original? Covers both conventions:
 * photo.jpg -> photo.webp (replaced extension) and photo.jpg.webp (appended,
 * used by several conversion plugins).
 */
function deheled_images_has_webp($path) {
    if (!$path) return false;
    if (file_exists($path . '.webp')) return true;
    $swapped = preg_replace('/\.(jpe?g|png)$/i', '.webp', $path);
    return ($swapped && $swapped !== $path && file_exists($swapped));
}

/**
 * Gather image records from the media library. This is the only WordPress- and
 * filesystem-aware part. Honours both a item cap and a wall-clock budget, and
 * reports honestly when either one cut the scan short.
 */
function deheled_images_collect(array $cfg) {
    global $wpdb;
    $started = microtime(true);

    // One cheap query for candidate IDs; +1 so we can detect the cap being hit.
    $ids = $wpdb->get_col($wpdb->prepare(
        "SELECT ID FROM {$wpdb->posts}
          WHERE post_type = 'attachment' AND post_mime_type LIKE %s
          ORDER BY ID DESC
          LIMIT %d",
        'image/%',
        $cfg['max_items'] + 1
    ));

    $capped = count($ids) > $cfg['max_items'];
    if ($capped) array_pop($ids);

    $items = array();
    $timed_out = false;

    foreach (array_chunk($ids, 200) as $chunk) {
        if ((microtime(true) - $started) * 1000 > $cfg['budget_ms']) { $timed_out = true; break; }

        // Prime the meta cache for the whole chunk so the per-item calls below
        // don't each hit the database.
        update_meta_cache('post', $chunk);

        foreach ($chunk as $id) {
            if ((microtime(true) - $started) * 1000 > $cfg['budget_ms']) { $timed_out = true; break 2; }

            $meta = wp_get_attachment_metadata($id);
            $path = get_attached_file($id);
            $exists = ($path && @file_exists($path));

            // Prefer stored metadata; fall back to reading the file only when
            // the metadata is incomplete.
            $width  = (isset($meta['width'])  && $meta['width'])  ? (int) $meta['width']  : 0;
            $height = (isset($meta['height']) && $meta['height']) ? (int) $meta['height'] : 0;
            if ((!$width || !$height) && $exists) {
                $size = @getimagesize($path);
                if (is_array($size)) { $width = (int) $size[0]; $height = (int) $size[1]; }
            }

            $bytes = 0;
            if ($exists) {
                if (isset($meta['filesize']) && (int) $meta['filesize'] > 0) {
                    $bytes = (int) $meta['filesize'];        // WP 6.0+ stores this
                } else {
                    $bytes = (int) @filesize($path);
                }
            }

            $items[] = array(
                'id'       => (int) $id,
                'file'     => $exists ? basename($path) : (isset($meta['file']) ? basename($meta['file']) : ('#' . $id)),
                'mime'     => (string) get_post_mime_type($id),
                'width'    => $width,
                'height'   => $height,
                'bytes'    => $bytes,
                'has_webp' => $exists ? deheled_images_has_webp($path) : false,
                'missing'  => !$exists,
            );
        }
    }

    return array(
        'items'       => $items,
        'candidates'  => count($ids),
        'capped'      => $capped,
        'timed_out'   => $timed_out,
        'duration_ms' => (int) round((microtime(true) - $started) * 1000),
    );
}

/** Human-readable byte size, e.g. "1.4 MB". */
function deheled_images_bytes($n) {
    $n = (int) $n;
    if ($n <= 0) return '0 B';
    $units = array('B', 'KB', 'MB', 'GB');
    $i = (int) floor(log($n, 1024));
    $i = min($i, count($units) - 1);
    $v = $n / pow(1024, $i);
    return ($i === 0 ? (string) $n : number_format($v, $v < 10 ? 1 : 0)) . ' ' . $units[$i];
}

/**
 * Build the dashboard-facing `layers` list. Mirrors the shape the other
 * optimizations return so the existing renderer works unchanged, with status:
 *   "verified" — measured, nothing to do
 *   "cleared"  — findings to report (the dashboard shows these as informational)
 */
function deheled_images_layers(array $rep, array $scan) {
    $layers = array();

    $scope = sprintf('%d image%s scanned · %s total',
        $rep['scanned'], $rep['scanned'] === 1 ? '' : 's', deheled_images_bytes($rep['total_bytes']));
    if ($scan['capped'] || $scan['timed_out']) {
        $scope .= sprintf(' · partial scan (%s of %d candidates%s)',
            number_format($rep['scanned']), $scan['candidates'],
            $scan['timed_out'] ? ', time budget reached' : ', item cap reached');
    }
    $layers[] = array('name' => 'Media library', 'status' => 'verified', 'detail' => $scope);

    $o = $rep['oversized'];
    $layers[] = array(
        'name'   => 'Oversized images',
        'status' => $o['count'] ? 'cleared' : 'verified',
        'detail' => $o['count']
            ? sprintf('%d wider than %dpx · ~%s recoverable (est.)', $o['count'], $o['threshold_px'], deheled_images_bytes($o['est_bytes']))
            : sprintf('none wider than %dpx', $o['threshold_px']),
    );

    $l = $rep['large'];
    $layers[] = array(
        'name'   => 'Large files',
        'status' => $l['count'] ? 'cleared' : 'verified',
        'detail' => $l['count']
            ? sprintf('%d over %s%s', $l['count'], deheled_images_bytes($l['threshold_bytes']),
                !empty($l['samples']) ? ' · largest ' . $l['samples'][0]['file'] . ' (' . deheled_images_bytes($l['samples'][0]['bytes']) . ')' : '')
            : sprintf('none over %s', deheled_images_bytes($l['threshold_bytes'])),
    );

    $w = $rep['missing_webp'];
    $layers[] = array(
        'name'   => 'WebP coverage',
        'status' => $w['count'] ? 'cleared' : 'verified',
        'detail' => $w['count']
            ? sprintf('%d JPEG/PNG without a WebP version · ~%s recoverable (est.)', $w['count'], deheled_images_bytes($w['est_bytes']))
            : 'every JPEG/PNG has a WebP version',
    );

    if ($rep['missing_files']) {
        $layers[] = array(
            'name'   => 'Missing files',
            'status' => 'cleared',
            'detail' => sprintf('%d attachment%s reference a file that is not on disk',
                $rep['missing_files'], $rep['missing_files'] === 1 ? 's' : 's'),
        );
    }

    return $layers;
}

/**
 * REST handler. Serves a cached report unless it is stale or ?fresh=1, so the
 * dashboard gets an instant answer on repeat views and the expensive walk only
 * happens when it needs to.
 */
function deheled_optimize_images($request = null) {
    $cfg    = deheled_images_config();
    $fresh  = $request ? (bool) $request->get_param('fresh') : false;
    $cached = get_option(DEHELED_IMG_OPTION, null);

    if (!$fresh && is_array($cached) && isset($cached['scanned_at_ts'])
        && (time() - (int) $cached['scanned_at_ts']) < $cfg['cache_ttl']) {
        $cached['cached'] = true;
        return rest_ensure_response($cached);
    }

    $scan = deheled_images_collect($cfg);
    $rep  = deheled_images_classify($scan['items'], $cfg);

    $payload = array(
        'ok'      => true,
        'action'  => 'optimize-images',
        'layers'  => deheled_images_layers($rep, $scan),
        'images'  => array(
            'scanned'         => $rep['scanned'],
            'candidates'      => $scan['candidates'],
            'partial'         => (bool) ($scan['capped'] || $scan['timed_out']),
            'capped'          => (bool) $scan['capped'],
            'timed_out'       => (bool) $scan['timed_out'],
            'total_bytes'     => $rep['total_bytes'],
            'est_total_bytes' => $rep['est_total_bytes'],
            'missing_files'   => $rep['missing_files'],
            'oversized'       => $rep['oversized'],
            'large'           => $rep['large'],
            'missing_webp'    => $rep['missing_webp'],
            'duration_ms'     => $scan['duration_ms'],
        ),
        'read_only'     => true,
        'scanned_at_ts' => time(),
        'ran_at'        => current_time('c'),
        'cached'        => false,
    );

    update_option(DEHELED_IMG_OPTION, $payload, false); // not autoloaded
    return rest_ensure_response($payload);
}
