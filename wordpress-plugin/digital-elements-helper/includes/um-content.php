<?php
/**
 * de/v2 content ownership, reassignment, and guarded deletion.
 *
 * This is the only file in the plugin that can destroy something a client
 * cannot get back, so it is built around one rule:
 *
 *   NOTHING IS EVER ORPHANED. wp_delete_user() is never reached while the
 *   account still owns anything, and ownership is re-counted AT DELETE TIME
 *   rather than trusted from whatever the dashboard saw earlier.
 *
 * That last part matters more than it sounds. A dashboard can show a correct
 * "0 remaining" and then sit on screen while an editor publishes a post, or a
 * scheduled post goes live, or a plugin creates an attachment. Deleting on the
 * strength of that earlier count would silently destroy content. So the count
 * is taken again here, inside the same request that does the deleting, and a
 * non-zero result refuses the delete outright.
 *
 * WordPress's own wp_delete_user($id, $reassign) would accept a reassignment
 * target and do this in one step — but it reassigns only posts and links, and
 * silently DELETES everything else the user owns. Reassignment is therefore a
 * separate, verified step here, and deletion refuses to proceed until it has
 * demonstrably worked.
 */

if (!defined('ABSPATH')) { exit; }

/** Statuses worth reporting separately — a scheduled post is not a draft. */
function deheled_um_content_statuses() {
    return array('publish', 'draft', 'pending', 'future', 'private', 'trash');
}

add_action('rest_api_init', function () {
    register_rest_route(DEHELED_UM_NAMESPACE, '/users/(?P<id>\d+)/content', array(
        'methods'             => 'GET',
        'permission_callback' => deheled_um_permission('users:read'),
        'callback'            => 'deheled_um_rest_content',
    ));
    register_rest_route(DEHELED_UM_NAMESPACE, '/users/(?P<id>\d+)/reassign', array(
        'methods'             => 'POST',
        'permission_callback' => deheled_um_permission('content:reassign'),
        'callback'            => 'deheled_um_rest_reassign',
    ));
    register_rest_route(DEHELED_UM_NAMESPACE, '/users/(?P<id>\d+)', array(
        'methods'             => 'DELETE',
        'permission_callback' => deheled_um_permission('users:delete'),
        'callback'            => 'deheled_um_rest_delete_user',
    ));
});

/* ------------------------------------------------------ ownership counts -- */

/**
 * Everything this account owns, counted from the database.
 *
 * EVERY registered post type, not a hardcoded list: a rehab site's "location"
 * CPT or a shop's "product" is exactly the content that would be destroyed
 * unnoticed by a check that only looked at posts and pages. Attachments are
 * included for the same reason — media is content.
 *
 * Counted with a direct query rather than one WP_Query per type: a media
 * library of 30,000 items is not unusual, and this runs inside a request that
 * must not time out.
 */
function deheled_um_count_owned_content($user_id) {
    global $wpdb;
    $user_id = (int) $user_id;

    $types = get_post_types(array(), 'objects');
    $labels = array();
    foreach ($types as $slug => $object) {
        $labels[$slug] = isset($object->labels->name) ? (string) $object->labels->name : $slug;
    }

    $rows = $wpdb->get_results($wpdb->prepare(
        "SELECT post_type, post_status, COUNT(*) AS n
           FROM {$wpdb->posts}
          WHERE post_author = %d
          GROUP BY post_type, post_status",
        $user_id
    ));

    $by_type = array();
    $total = 0;
    $by_status = array_fill_keys(deheled_um_content_statuses(), 0);

    foreach ((array) $rows as $row) {
        $type = (string) $row->post_type;
        $status = (string) $row->post_status;
        $n = (int) $row->n;

        // Revisions are copies of content, not content in their own right, and
        // WordPress removes them with their parent.
        if ($type === 'revision') continue;

        if (!isset($by_type[$type])) {
            $by_type[$type] = array(
                'type' => $type,
                'label' => isset($labels[$type]) ? $labels[$type] : $type,
                'registered' => isset($types[$type]),
                'total' => 0,
                'by_status' => array(),
            );
        }
        $by_type[$type]['total'] += $n;
        $by_type[$type]['by_status'][$status] = (isset($by_type[$type]['by_status'][$status]) ? $by_type[$type]['by_status'][$status] : 0) + $n;
        if (array_key_exists($status, $by_status)) $by_status[$status] += $n;
        $total += $n;
    }

    // Comments are the user's words. They are not reassigned by post
    // reassignment, and WordPress would strip authorship on delete.
    $comments = (int) $wpdb->get_var($wpdb->prepare(
        "SELECT COUNT(*) FROM {$wpdb->comments} WHERE user_id = %d",
        $user_id
    ));

    $user = get_user_by('id', $user_id);
    $is_admin_email = $user && strcasecmp((string) $user->user_email, (string) get_option('admin_email')) === 0;

    ksort($by_type);
    return array(
        'total'          => $total,
        'by_type'        => array_values($by_type),
        'by_status'      => $by_status,
        'comments'       => $comments,
        // Deleting the account behind the site's admin_email would leave
        // WordPress mailing an address nobody owns.
        'is_admin_email' => $is_admin_email,
        // The single question the delete flow turns on.
        'owns_content'   => $total > 0,
    );
}

/**
 * Who can receive this content.
 *
 * Only users who can actually author on this site — handing 400 posts to a
 * subscriber would leave them unmanageable by their new owner. The account
 * being emptied is excluded for the obvious reason.
 */
function deheled_um_reassign_targets($exclude_id) {
    $targets = array();
    foreach (get_users(array('number' => 200, 'orderby' => 'display_name')) as $candidate) {
        if ((int) $candidate->ID === (int) $exclude_id) continue;
        if (!user_can($candidate, 'edit_posts')) continue;
        $targets[] = array(
            'id'            => (int) $candidate->ID,
            'login'         => (string) $candidate->user_login,
            'email'         => (string) $candidate->user_email,
            'display_name'  => (string) $candidate->display_name,
            'roles'         => array_values(array_map('strval', (array) $candidate->roles)),
            'managed'       => deheled_um_user_is_managed($candidate->ID),
        );
    }
    return $targets;
}

function deheled_um_rest_content($request) {
    $user = deheled_um_require_user($request);
    if (deheled_um_is_failure($user)) return $user;

    $content = deheled_um_count_owned_content($user->ID);

    return rest_ensure_response(array(
        'ok'      => true,
        'user'    => deheled_um_user_shape($user),
        'content' => $content,
        'eligible_reassign_targets' => deheled_um_reassign_targets($user->ID),
        // Reported so the dashboard can warn before it is too late, not so it
        // can decide — the delete route checks again for itself.
        'administrators' => deheled_um_administrator_count(),
        'generated_at' => current_time('c'),
    ));
}

/* ---------------------------------------------------------- reassignment -- */

/**
 * Validates a reassignment target. Returns the target user or a failure.
 */
function deheled_um_require_reassign_target($target_id, $from_id) {
    $target_id = (int) $target_id;
    if ($target_id <= 0) {
        return deheled_um_fail('reassign_target_required', 'Choose a user to receive this content.', 400);
    }
    if ($target_id === (int) $from_id) {
        return deheled_um_fail('reassign_target_invalid', 'Content can\'t be reassigned to the same account.', 400);
    }
    $target = get_user_by('id', $target_id);
    if (!$target) {
        return deheled_um_fail('reassign_target_invalid', 'That user doesn\'t exist on this website.', 400);
    }
    if (!user_can($target, 'edit_posts')) {
        return deheled_um_fail(
            'reassign_target_invalid',
            'That user can\'t author content on this website, so they can\'t receive it.',
            400
        );
    }
    return $target;
}

/**
 * Moves everything this account owns to another user, then counts again.
 *
 * The re-count is the point: "we ran an UPDATE" is not the same claim as "the
 * account now owns nothing", and only the second one justifies a delete. The
 * verified remaining count is returned so the dashboard shows proof rather than
 * an assurance.
 */
function deheled_um_rest_reassign($request) {
    return deheled_um_with_idempotency($request, function () use ($request) {
        global $wpdb;

        $user = deheled_um_require_user($request);
        if (deheled_um_is_failure($user)) return $user;

        $target = deheled_um_require_reassign_target($request->get_param('target_id'), $user->ID);
        if (deheled_um_is_failure($target)) return $target;

        $before = deheled_um_count_owned_content($user->ID);

        // One statement for every post type at once. Revisions are excluded for
        // the same reason they are not counted; they follow their parent.
        $moved_posts = $wpdb->query($wpdb->prepare(
            "UPDATE {$wpdb->posts} SET post_author = %d WHERE post_author = %d AND post_type != 'revision'",
            (int) $target->ID,
            (int) $user->ID
        ));

        // Comments carry their own authorship columns; moving the user id alone
        // would leave the old name and email displayed on the site.
        $moved_comments = $wpdb->query($wpdb->prepare(
            "UPDATE {$wpdb->comments}
                SET user_id = %d, comment_author = %s, comment_author_email = %s
              WHERE user_id = %d",
            (int) $target->ID,
            (string) $target->display_name,
            (string) $target->user_email,
            (int) $user->ID
        ));

        // Caches hold per-post author data and per-user counts; a stale cache
        // here would make the verification read the old numbers.
        clean_user_cache($user->ID);
        clean_user_cache($target->ID);
        if (function_exists('wp_cache_flush_group')) {
            wp_cache_flush_group('posts');
        } else {
            wp_cache_flush();
        }

        $after = deheled_um_count_owned_content($user->ID);

        return rest_ensure_response(array(
            'ok'       => true,
            'result'   => 'reassigned',
            'user'     => deheled_um_user_shape($user),
            'target'   => deheled_um_user_shape($target),
            'moved'    => array(
                'posts'    => max(0, (int) $moved_posts),
                'comments' => max(0, (int) $moved_comments),
            ),
            'before'   => $before,
            // The verified state afterwards. remaining.total === 0 is what the
            // delete route will independently require.
            'remaining' => $after,
            'verified' => $after['total'] === 0 && $after['comments'] === 0,
            'warnings' => array(),
            'error'    => null,
        ));
    });
}

/* -------------------------------------------------------------- deletion -- */

/**
 * Deletes a WordPress account.
 *
 * Every gate here is checked again inside this request, not inherited from an
 * earlier one:
 *
 *   managed        — a client's own account is never deleted by us.
 *   confirm        — an explicit flag, so a mis-routed call can't delete.
 *   last admin     — a site must not lose its only administrator.
 *   OWNERSHIP      — re-counted now. Non-zero refuses, whatever the dashboard
 *                    believed when it rendered its confirmation screen.
 *
 * The reassign target is echoed back by the caller and checked against what
 * actually happened: if the account still owns anything, the delete is refused
 * regardless of what target was named.
 */
function deheled_um_rest_delete_user($request) {
    return deheled_um_with_idempotency($request, function () use ($request) {
        $user = deheled_um_require_user($request);
        if (deheled_um_is_failure($user)) return $user;

        $managed = deheled_um_require_managed($user);
        if (deheled_um_is_failure($managed)) return $managed;

        if (!$request->get_param('confirm')) {
            return deheled_um_fail('confirmation_required', 'Deleting an account needs an explicit confirmation.', 400);
        }

        $guard = deheled_um_check_last_administrator($user);
        if (deheled_um_is_failure($guard)) return $guard;

        // THE check that makes orphaning impossible. Taken now, in this
        // request, so content created since the dashboard last looked is seen.
        $content = deheled_um_count_owned_content($user->ID);
        if ($content['total'] > 0 || $content['comments'] > 0) {
            return deheled_um_fail(
                'has_content',
                sprintf(
                    'This account still owns %d item(s) and %d comment(s) on this website. Reassign them before deleting.',
                    $content['total'],
                    $content['comments']
                ),
                409,
                array('content' => $content)
            );
        }

        // Named purely so the response can state what the caller believed; the
        // decision above does not depend on it.
        $claimed_target = (int) $request->get_param('reassign_target');

        $shape = deheled_um_user_shape($user);

        if (!function_exists('wp_delete_user')) {
            require_once ABSPATH . 'wp-admin/includes/user.php';
        }
        // No second argument: there is deliberately nothing left to reassign,
        // and passing one would hide a failure of the check above.
        $deleted = wp_delete_user($user->ID);
        if (!$deleted) {
            return deheled_um_fail('delete_failed', 'WordPress refused to delete that account.', 500);
        }

        return rest_ensure_response(array(
            'ok'       => true,
            'result'   => 'deleted',
            'user'     => $shape,
            'reassigned_to' => $claimed_target ?: null,
            'verified_empty_at_delete' => true,
            'warnings' => array(),
            'error'    => null,
        ));
    });
}
