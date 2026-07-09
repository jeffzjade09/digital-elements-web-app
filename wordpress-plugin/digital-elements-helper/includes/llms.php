<?php
/**
 * llms.txt — editable from WP admin, published to the site root.
 *
 * Publishing strategy (in order):
 *   1. PHYSICAL FILE: on save, the content is written to ABSPATH/llms.txt,
 *      next to robots.txt. Required on hosts like WP Engine whose nginx
 *      serves *.txt requests straight from disk and 404s missing files
 *      before WordPress runs.
 *   2. DYNAMIC FALLBACK: if the root isn't writable, /llms.txt is served
 *      from the database the way WordPress serves its virtual robots.txt
 *      (works on hosts that route unknown URLs through WordPress).
 *
 * llms.txt is a proposed standard (https://llmstxt.org/) that gives AI
 * models a concise, curated map of a site's most important content.
 */
if (!defined('ABSPATH')) { exit; }

function deheled_llms_file_path() {
    return ABSPATH . 'llms.txt';
}

// True when the physical file exists and holds exactly the saved content.
function deheled_llms_file_in_sync() {
    $path = deheled_llms_file_path();
    if (!file_exists($path)) return false;
    $saved = (string) get_option(DEHELED_LLMS_OPTION, '');
    $disk  = (string) @file_get_contents($path);
    return trim($disk) !== '' && trim($disk) === trim($saved);
}

// Write the physical file. Returns true on success.
function deheled_llms_write_file($content) {
    return @file_put_contents(deheled_llms_file_path(), $content) !== false;
}

// Remove the physical file, but only if it's one we wrote (content matches
// the saved option) — never delete a file someone else put there.
function deheled_llms_delete_file() {
    $path = deheled_llms_file_path();
    if (!file_exists($path)) return true;
    if (!deheled_llms_file_in_sync()) return false;
    return @unlink($path);
}

// ---- Dynamic fallback: serve /llms.txt when no physical file exists ---------
add_action('init', 'deheled_llms_maybe_serve', 1);
function deheled_llms_maybe_serve() {
    if (is_admin() || (defined('WP_CLI') && WP_CLI)) return;
    $req = isset($_SERVER['REQUEST_URI']) ? (string) wp_unslash($_SERVER['REQUEST_URI']) : '';
    $path = (string) strtok($req, '?');
    // Respect subdirectory installs (e.g. example.com/blog/llms.txt).
    $home_path = rtrim((string) wp_parse_url(home_url(), PHP_URL_PATH), '/');
    if (!preg_match('#^' . preg_quote($home_path, '#') . '/llms\.txt/?$#i', $path)) return;

    if (get_option(DEHELED_LLMS_ENABLED, '0') !== '1') return; // disabled -> normal 404
    $content = (string) get_option(DEHELED_LLMS_OPTION, '');
    if (trim($content) === '') return;

    status_header(200);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: public, max-age=3600');
    echo $content;
    exit;
}

// ---- Admin: submenu page under DE Monitoring --------------------------------
add_action('admin_menu', function () {
    add_submenu_page(
        'deheled-monitor',
        'llms.txt',
        'llms.txt',
        'manage_options',
        'deheled-llms',
        'deheled_render_llms_page'
    );
}, 20);

// Save handler (nonce-protected, admins only).
add_action('admin_post_deheled_save_llms', function () {
    if (!current_user_can('manage_options')) wp_die('Forbidden');
    check_admin_referer('deheled_save_llms');

    $content = isset($_POST['llms_content']) ? (string) wp_unslash($_POST['llms_content']) : '';
    $content = str_replace(array("\r\n", "\r"), "\n", $content); // normalize newlines
    $content = str_replace("\0", '', $content);
    if (strlen($content) > 1048576) $content = substr($content, 0, 1048576); // 1 MB cap
    $enabled = !empty($_POST['llms_enabled']) && trim($content) !== '';

    // Remove an out-of-date file we previously wrote BEFORE the option changes
    // (deletion is only allowed while disk content still matches the option).
    if (!$enabled || trim($content) !== trim((string) get_option(DEHELED_LLMS_OPTION, ''))) {
        deheled_llms_delete_file();
    }

    update_option(DEHELED_LLMS_OPTION, $content, false); // autoload off: only read on /llms.txt hits
    update_option(DEHELED_LLMS_ENABLED, $enabled ? '1' : '0');
    if ($enabled) deheled_llms_write_file($content);

    wp_safe_redirect(add_query_arg('saved', '1', admin_url('admin.php?page=deheled-llms')));
    exit;
});

/**
 * Starter template generated from this site's real pages, following the
 * llms.txt format (title, blockquote summary, sectioned link lists).
 */
function deheled_llms_starter_template() {
    // Decode entities: bloginfo is HTML-escaped ("&amp;"), but llms.txt is plain text.
    $name = wp_specialchars_decode(get_bloginfo('name'), ENT_QUOTES);
    $desc = wp_specialchars_decode(get_bloginfo('description'), ENT_QUOTES);
    $out  = '# ' . $name . "\n\n";
    $out .= '> ' . ($desc !== '' ? $desc : 'Describe what this site/organization does in two or three sentences, including location and contact details if relevant.') . "\n\n";
    $out .= "This file helps AI models and LLM-based assistants accurately understand, summarize, and cite this site's content.\n\n";
    $out .= "## Primary Pages\n\n";
    $out .= '- [Home](' . home_url('/') . "): Overview of " . $name . ".\n";

    $pages = get_pages(array('parent' => 0, 'sort_column' => 'menu_order,post_title', 'number' => 20));
    foreach ($pages as $p) {
        if ((int) $p->ID === (int) get_option('page_on_front')) continue;
        $out .= '- [' . wp_specialchars_decode($p->post_title, ENT_QUOTES) . '](' . get_permalink($p) . ")\n";
    }
    $out .= "\n## Resources\n\n";
    $out .= '- [Blog](' . home_url('/') . ")\n";
    $out .= '- [Sitemap](' . home_url('/sitemap.xml') . ")\n";
    return $out;
}

function deheled_render_llms_page() {
    $content  = (string) get_option(DEHELED_LLMS_OPTION, '');
    $enabled  = get_option(DEHELED_LLMS_ENABLED, '0') === '1';
    $is_new   = trim($content) === '';
    $value    = $is_new ? deheled_llms_starter_template() : $content;
    $url      = home_url('/llms.txt');
    $path     = deheled_llms_file_path();
    $physical = file_exists($path);
    $in_sync  = $physical && deheled_llms_file_in_sync();
    $writable = $physical ? is_writable($path) : is_writable(ABSPATH);
    ?>
    <div class="wrap deheled">
      <h1 class="deheled-title">
        <img class="deheled-logo" src="<?php echo esc_url(rtrim(DEHELED_HUB_URL, '/') . '/logo.png'); ?>" alt="Digital Elements" onerror="this.style.display='none'" />
        <span>llms.txt</span>
        <?php if ($enabled && !$is_new): ?>
          <a class="button" href="<?php echo esc_url($url); ?>" target="_blank" rel="noopener">View live file &rarr;</a>
        <?php endif; ?>
      </h1>
      <p class="deheled-sub">
        Published at <a href="<?php echo esc_url($url); ?>" target="_blank" rel="noopener"><code><?php echo esc_html($url); ?></code></a>
        &mdash; saving writes a real <code>llms.txt</code> file to your WordPress root folder, next to <code>robots.txt</code>.
        <a href="https://llmstxt.org/" target="_blank" rel="noopener">About the llms.txt format</a>.
      </p>

      <?php if (isset($_GET['saved'])): ?>
        <div class="notice notice-success is-dismissible"><p>
          <?php if (!$enabled): ?>
            llms.txt saved and unpublished (the file was removed &mdash; tick &ldquo;Enable&rdquo; to publish it).
          <?php elseif ($in_sync): ?>
            llms.txt saved and published &mdash; the file is live in your WordPress root.
          <?php else: ?>
            llms.txt saved.
          <?php endif; ?>
        </p></div>
      <?php endif; ?>

      <?php if ($enabled && !$in_sync): ?>
        <div class="notice notice-warning"><p><strong>The physical file could not be written<?php echo $writable ? ' yet' : ' (root folder not writable)'; ?>.</strong>
          The plugin is serving <code>/llms.txt</code> dynamically as a fallback, but some hosts (including WP Engine) answer <code>.txt</code> URLs directly from disk and will return 404.
          <?php if (!$writable): ?>Ask your host to make the WordPress root writable, or upload the content below as <code>llms.txt</code> via SFTP.<?php else: ?>Try saving again.<?php endif; ?>
        </p></div>
      <?php endif; ?>

      <?php if ($physical && !$in_sync && trim($content) !== ''): ?>
        <div class="notice notice-warning"><p>An <code>llms.txt</code> file already exists in your WordPress root with <strong>different content</strong> than what's saved here. Saving with &ldquo;Enable&rdquo; ticked will overwrite it.</p></div>
      <?php endif; ?>

      <?php if ($is_new): ?>
        <div class="notice notice-info"><p>A starter template has been generated from this site's pages. Edit it below, then tick <strong>Enable</strong> and save to publish.</p></div>
      <?php endif; ?>

      <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
        <?php wp_nonce_field('deheled_save_llms'); ?>
        <input type="hidden" name="action" value="deheled_save_llms" />
        <p>
          <label><input type="checkbox" name="llms_enabled" value="1" <?php checked($enabled); ?> />
          <strong>Enable</strong> &mdash; publish this content at <code>/llms.txt</code></label>
        </p>
        <textarea name="llms_content" rows="26" style="width:100%;max-width:980px;font-family:Consolas,Monaco,monospace;font-size:13px;line-height:1.5;tab-size:2;" spellcheck="false"><?php echo esc_textarea($value); ?></textarea>
        <p class="description">Markdown, per the llms.txt convention: an H1 title, a <code>&gt;</code> blockquote summary, then <code>##</code> sections of <code>- [Title](URL): description</code> links to your most important pages.</p>
        <p><button class="button button-primary">Save llms.txt</button></p>
      </form>
    </div>
    <?php
}
