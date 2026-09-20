<?php
/**
 * The DE Monitoring panel's user-management section.
 *
 * This is the ONLY user-management UI in the plugin, and it manages nothing:
 * it connects the site and sets local limits. All the actual controls — teams,
 * users, roles, website selection, bulk operations — live in the Digital
 * Elements web app. The plugin's job is the secure connection, nothing more.
 *
 * What a site administrator can do here:
 *   - connect the site by redeeming a one-time enrollment code
 *   - decide locally whether the dashboard may delete users or grant
 *     Administrator (both off by default)
 *   - disconnect, which revokes the credential immediately
 *
 * Kept in its own file, attached to a hook, so admin.php doesn't keep growing.
 */

if (!defined('ABSPATH')) { exit; }

add_action('deheled_after_license_panel', 'deheled_um_render_panel');

function deheled_um_render_panel() {
    $enrolled = deheled_um_is_enrolled();
    $scopes   = deheled_um_scopes();
    $key_id   = (string) get_option(DEHELED_UM_KEY_ID, '');
    $since    = (int) get_option(DEHELED_UM_ENROLLED, 0);
    $notice   = isset($_GET['um_msg']) ? sanitize_text_field(wp_unslash($_GET['um_msg'])) : '';
    $ok       = isset($_GET['um_ok']) && $_GET['um_ok'] === '1';
    ?>
    <div class="deheled-license <?php echo $enrolled ? 'ok' : 'warn'; ?>">
      <h2>User management <?php echo $enrolled ? '&middot; connected &check;' : '&middot; not connected'; ?></h2>

      <?php if ($notice): ?>
        <p class="deheled-lic-status <?php echo $ok ? 'good' : 'bad'; ?>"><?php echo esc_html($notice); ?></p>
      <?php endif; ?>

      <?php if ($enrolled): ?>
        <p class="deheled-lic-status good">
          &#10003; Connected to the Digital Elements dashboard
          <?php if ($key_id !== ''): ?> &middot; credential <code><?php echo esc_html($key_id); ?></code><?php endif; ?>
          <?php if ($since): ?> &middot; since <?php echo esc_html(date_i18n('M j, Y', $since)); ?><?php endif; ?>
        </p>
        <p class="description">
          This lets Digital Elements manage agency staff accounts on this site from their
          dashboard. It can only touch accounts it created or that were deliberately
          linked — your own users are never modified. Passwords are never transmitted or
          shown; WordPress sends its own set-password email.
        </p>

        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
          <?php wp_nonce_field('deheled_um_scopes'); ?>
          <input type="hidden" name="action" value="deheled_um_scopes" />
          <p><strong>Permissions granted to the dashboard</strong></p>
          <?php foreach (deheled_um_optional_scopes() as $scope => $label): ?>
            <p>
              <label>
                <input type="checkbox" name="scopes[]" value="<?php echo esc_attr($scope); ?>"
                       <?php checked(in_array($scope, $scopes, true)); ?> />
                <?php echo esc_html($label); ?>
              </label>
            </p>
          <?php endforeach; ?>
          <p class="description">
            Both are off unless you turn them on here. Turning them off again takes effect
            immediately, whatever the dashboard is configured to do. Reading users and
            creating or updating them is always allowed once connected.
          </p>
          <button class="button">Save permissions</button>
        </form>

        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="margin-top:14px">
          <?php wp_nonce_field('deheled_um_disconnect'); ?>
          <input type="hidden" name="action" value="deheled_um_disconnect" />
          <button class="button" onclick="return confirm('Disconnect user management? The dashboard will no longer be able to manage users on this site. No WordPress accounts are changed or removed.');">Disconnect</button>
          <span class="description">Revokes the credential. No accounts are changed or removed.</span>
        </form>
      <?php else: ?>
        <p class="description">
          Optional. Connect this site so Digital Elements can manage agency staff accounts
          from their dashboard instead of you creating each one by hand. It can only touch
          accounts it creates or that are deliberately linked — your own users are never
          modified, and it cannot delete anyone or grant Administrator unless you allow it
          below after connecting.
        </p>
        <p class="description">
          Ask Digital Elements for an enrollment code, then paste it here. The code is valid
          for 15 minutes and works once.
        </p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
          <?php wp_nonce_field('deheled_um_enroll'); ?>
          <input type="hidden" name="action" value="deheled_um_enroll" />
          <input type="text" name="um_code" class="regular-text code" placeholder="DEUM-XXXX-XXXX-XXXX" autocomplete="off" />
          <button class="button button-primary">Connect</button>
        </form>
      <?php endif; ?>
    </div>
    <?php
}

/* ------------------------------------------------------------------ actions */

function deheled_um_redirect($message, $ok) {
    wp_safe_redirect(add_query_arg(
        array('um_msg' => rawurlencode($message), 'um_ok' => $ok ? '1' : '0'),
        admin_url('admin.php?page=deheled-monitor')
    ));
    exit;
}

// Redeem an enrollment code. Nonce + manage_options, like every other action on
// this screen — this one is a real administrator acting in their own browser,
// which is exactly the case current_user_can() is for.
add_action('admin_post_deheled_um_enroll', function () {
    if (!current_user_can('manage_options')) wp_die('Forbidden');
    check_admin_referer('deheled_um_enroll');

    $code = isset($_POST['um_code']) ? sanitize_text_field(wp_unslash($_POST['um_code'])) : '';
    $result = deheled_um_enroll($code);

    if (is_wp_error($result)) {
        deheled_um_redirect($result->get_error_message(), false);
    }
    deheled_um_redirect('User management connected. Digital Elements can now manage agency accounts on this site.', true);
});

// Local permission switches. Only the optional scopes can be changed here; the
// baseline ones are implied by being connected at all.
add_action('admin_post_deheled_um_scopes', function () {
    if (!current_user_can('manage_options')) wp_die('Forbidden');
    check_admin_referer('deheled_um_scopes');

    $submitted = isset($_POST['scopes']) && is_array($_POST['scopes'])
        ? array_map('sanitize_text_field', wp_unslash($_POST['scopes']))
        : array();

    // Whitelist: only scopes we actually define can be switched on, whatever the
    // form posts.
    $allowed = array_keys(deheled_um_optional_scopes());
    $optional = array_values(array_intersect($submitted, $allowed));
    $scopes = array_values(array_unique(array_merge(deheled_um_default_scopes(), $optional)));

    update_option(DEHELED_UM_SCOPES, $scopes, 'no');
    deheled_um_redirect('Permissions saved.', true);
});

add_action('admin_post_deheled_um_disconnect', function () {
    if (!current_user_can('manage_options')) wp_die('Forbidden');
    check_admin_referer('deheled_um_disconnect');
    deheled_um_disconnect();
    deheled_um_redirect('User management disconnected. No WordPress accounts were changed.', true);
});
