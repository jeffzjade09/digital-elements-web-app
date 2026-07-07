<?php
if (!defined('ABSPATH')) { exit; }

/* =========================================================================
 * 2b. Deep security scan (server-side; daily cron + on-demand)
 *
 * Read-only. Never modifies files. Bounded by a time budget and file caps so
 * it can't hang or exhaust memory on large/shared hosts. It looks for the
 * high-signal fingerprints of a compromise: PHP in uploads, obfuscated code
 * signatures, modified WordPress core files, and newly-created admin accounts.
 * ========================================================================= */

// Signature list. HIGH = strong backdoor/injection indicators. We deliberately
// do NOT flag lone base64_decode()/eval() — legitimate plugins use them — only
// the combinations and user-input sinks that malware actually uses.
// NOTE: web-shell names are assembled via concatenation so this file never
// contains them literally (otherwise the scanner would flag itself).
function deheled_sec_patterns() {
    $shells = implode('|', array(
        'c99' . 'shell', 'r57' . 'shell', 'b37' . '4k', 'files' . 'man',
        'wso' . 'shell', 'php' . 'spy', 'wee' . 'vely',
    ));
    return array(
        'high' => array(
            '/eval\s*\(\s*(?:gzinflate|gzuncompress|str_rot13)?\s*\(?\s*base64_decode\s*\(/i' => 'eval() of a base64/gzip payload (backdoor)',
            '/\bpreg_replace\s*\(\s*([\'"])([^a-zA-Z0-9\s]).*?\2[imsxuADSUXJ]*e[imsxuADSUXJ]*\1/is' => 'preg_replace() with /e modifier (code execution)',
            '/\b(?:' . $shells . ')\b/i'                                                      => 'Known web-shell signature',
            '/\beval\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE|SERVER)/i'                          => 'eval() of user input (remote code execution)',
            '/\b(?:system|shell_exec|passthru|proc_open|popen)\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/i' => 'Shell command built from user input',
            '/\bassert\s*\(\s*\$_(?:GET|POST|REQUEST|COOKIE)/i'                               => 'assert() of user input (code execution)',
            '/\bmove_uploaded_file\s*\([^;]*\.php/i'                                          => 'Uploader writing a .php file',
        ),
        'med' => array(
            '/\bgzinflate\s*\(\s*base64_decode\s*\(/i'          => 'gzinflate + base64 obfuscation chain',
            '/\bstr_rot13\s*\(\s*base64_decode\s*\(/i'          => 'str_rot13 + base64 obfuscation chain',
            '/\$\{\s*[\'"]\w+[\'"]\s*\}\s*\(/'                  => 'Dynamic variable-function call (obfuscation)',
            '/\bcreate_function\s*\(/i'                          => 'create_function usage (removed in PHP 8; common in malware)',
        ),
    );
}

function deheled_sec_rel($path) {
    $abs = wp_normalize_path(ABSPATH);
    $p   = wp_normalize_path($path);
    return (strpos($p, $abs) === 0) ? substr($p, strlen($abs)) : basename($p);
}

// Match the strongest signature in a blob of code. Returns null or {sev,msg}.
function deheled_sec_match($code, $patterns) {
    foreach ($patterns['high'] as $re => $msg) {
        if (preg_match($re, $code)) return array('sev' => 'high', 'msg' => $msg);
    }
    foreach ($patterns['med'] as $re => $msg) {
        if (preg_match($re, $code)) return array('sev' => 'med', 'msg' => $msg);
    }
    return null;
}

// Walk a directory for .php files, invoking $cb($fullpath) for each, honoring
// the shared time budget. Returns true if it stopped early (budget/error).
function deheled_sec_walk($dir, $cb, $start, $budget) {
    if (!is_dir($dir) || !is_readable($dir)) return false;
    try {
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS | FilesystemIterator::FOLLOW_SYMLINKS),
            RecursiveIteratorIterator::LEAVES_ONLY
        );
        foreach ($it as $file) {
            if ((microtime(true) - $start) > $budget) return true;
            if (!$file->isFile()) continue;
            if (strtolower($file->getExtension()) !== 'php') continue;
            $cb($file->getPathname());
        }
    } catch (Exception $e) {
        return true;
    }
    return false;
}

// Benign "guard" files: plugins (Yoast, WooCommerce, …) drop empty index.php
// files into uploads subfolders to block directory listing. Only PHP open tag,
// comments, whitespace, and at most a lone exit/die — no real code.
function deheled_sec_is_guard_file($file) {
    $size = @filesize($file);
    if ($size === false || $size > 4096) return false;
    $code = @file_get_contents($file);
    if ($code === false) return false;
    $stripped = preg_replace('/\/\*.*?\*\//s', '', $code);          // block comments
    $stripped = preg_replace('/(?:\/\/|#)[^\r\n]*/', '', $stripped); // line comments
    $stripped = preg_replace('/<\?(?:php)?|\?>/i', '', $stripped);   // php tags
    $stripped = preg_replace('/\b(?:exit|die)\s*(?:\(\s*\))?\s*;?/i', '', $stripped);
    return trim($stripped) === '';
}

function deheled_security_scan() {
    @set_time_limit(60);
    if (function_exists('wp_raise_memory_limit')) wp_raise_memory_limit('admin');

    $start    = microtime(true);
    $budget   = 15.0;                 // hard wall-clock budget (seconds)
    $maxBytes = 2 * 1024 * 1024;      // skip files larger than 2 MB
    $patterns = deheled_sec_patterns();

    $findings = array();
    $scanned = 0; $skippedBig = 0; $phpInUploads = 0; $partial = false;

    // 1) PHP files inside uploads — should never exist (empty guard index.php
    //    files that plugins create to block directory listing are exempt).
    $up  = wp_upload_dir();
    $upl = isset($up['basedir']) ? $up['basedir'] : WP_CONTENT_DIR . '/uploads';
    $partial = deheled_sec_walk($upl, function ($file) use (&$findings, &$phpInUploads, $patterns, $maxBytes) {
        if ($phpInUploads >= 25) return;
        if (deheled_sec_is_guard_file($file)) return;
        $phpInUploads++;
        $msg = 'PHP file in uploads directory';
        $size = @filesize($file);
        if ($size !== false && $size <= $maxBytes) {
            $code = @file_get_contents($file);
            if ($code !== false) {
                $hit = deheled_sec_match($code, $patterns);
                if ($hit) $msg .= ' (' . $hit['msg'] . ')';
            }
        }
        $findings[] = array('sev' => 'high', 'msg' => $msg, 'file' => deheled_sec_rel($file));
    }, $start, $budget) || $partial;

    // 2) Obfuscated / injected code in themes, plugins and mu-plugins.
    //    Our own plugin folder is skipped — it contains the signature list.
    $own = wp_normalize_path(plugin_dir_path(__FILE__));
    $dirs = array(get_theme_root(), defined('WP_PLUGIN_DIR') ? WP_PLUGIN_DIR : WP_CONTENT_DIR . '/plugins');
    if (defined('WPMU_PLUGIN_DIR') && is_dir(WPMU_PLUGIN_DIR)) $dirs[] = WPMU_PLUGIN_DIR;
    foreach (array_unique($dirs) as $dir) {
        $stop = deheled_sec_walk($dir, function ($file) use (&$findings, &$scanned, &$skippedBig, $patterns, $maxBytes, $own) {
            if (count($findings) >= 80) return;
            if ($own && strpos(wp_normalize_path($file), $own) === 0) return;
            $size = @filesize($file);
            if ($size === false) return;
            if ($size > $maxBytes) { $skippedBig++; return; }
            $code = @file_get_contents($file);
            if ($code === false) return;
            $scanned++;
            $hit = deheled_sec_match($code, $patterns);
            if ($hit) $findings[] = array('sev' => $hit['sev'], 'msg' => $hit['msg'], 'file' => deheled_sec_rel($file));
        }, $start, $budget);
        if ($stop) { $partial = true; break; }
    }

    // 3) Modified WordPress core files (checksum verification against WordPress.org).
    if ((microtime(true) - $start) < $budget) {
        if (!function_exists('get_core_checksums')) {
            @require_once ABSPATH . 'wp-admin/includes/update.php';
        }
        if (function_exists('get_core_checksums')) {
            $sums = @get_core_checksums(get_bloginfo('version'), 'en_US');
            if (is_array($sums)) {
                $badCore = 0;
                foreach ($sums as $rel => $md5) {
                    if ((microtime(true) - $start) > $budget) { $partial = true; break; }
                    if (strpos($rel, 'wp-content/') === 0) continue;   // themes/plugins change legitimately
                    $path = ABSPATH . $rel;
                    if (!file_exists($path)) continue;
                    if (@md5_file($path) !== $md5) {
                        $findings[] = array('sev' => 'high', 'msg' => 'Modified WordPress core file', 'file' => $rel);
                        if (++$badCore >= 15) { break; }
                    }
                }
            }
        }
    }

    // 4) Admin accounts created recently (surface for review — not proof of compromise).
    $newAdmins = array();
    $admins = get_users(array('role' => 'administrator', 'number' => 50, 'fields' => array('user_login', 'user_registered')));
    $cutoff = time() - 30 * DAY_IN_SECONDS;
    foreach ($admins as $ua) {
        $reg = strtotime($ua->user_registered);
        if ($reg && $reg >= $cutoff) $newAdmins[] = $ua->user_login;
    }
    if (!empty($newAdmins)) {
        $findings[] = array('sev' => 'med', 'msg' => 'Admin account(s) created in last 30 days: ' . implode(', ', array_slice($newAdmins, 0, 5)));
    }

    $result = array(
        'scanned_at'     => current_time('c'),
        'files_scanned'  => $scanned,
        'skipped_large'  => $skippedBig,
        'php_in_uploads' => $phpInUploads,
        'admin_count'    => is_array($admins) ? count($admins) : null,
        'partial'        => $partial,
        'findings'       => array_slice($findings, 0, 80),
    );
    update_option(DEHELED_SEC_OPTION, $result, false);
    return $result;
}

// Run the deep scan daily in the background so the REST call stays instant.
add_action('init', function () {
    if (!wp_next_scheduled(DEHELED_SEC_CRON)) {
        wp_schedule_event(time() + 300, 'daily', DEHELED_SEC_CRON);
    }
});
add_action(DEHELED_SEC_CRON, 'deheled_security_scan');
