<?php
/**
 * de/v2 write endpoints: create, update, link, unlink, password reset.
 *
 * This is the first file in the plugin that changes a client's site, so every
 * guard below is enforced HERE, in PHP, regardless of what the dashboard sent.
 * The dashboard's own checks are a courtesy to the administrator; these are the
 * ones that actually hold.
 *
 * THE GUARDS, and why each exists:
 *
 *   MANAGED-ONLY — every mutating route refuses an account without _de_managed.
 *     Clients' own accounts are not ours to touch. /link is the single
 *     exception, and it requires its own explicit confirmation.
 *
 *   CREATED-BY-US — a stronger claim than "managed", and the one that gates
 *     account TAKEOVER. Changing an email address or triggering a password
 *     reset both hand control of an account to whoever receives the mail, so
 *     they are allowed only for accounts we created. Without this, linking a
 *     client's Editor, changing its address and requesting a reset would be a
 *     complete takeover using nothing but the default write scope.
 *
 *   ROLE WHITELIST — the target role must exist in get_editable_roles(). Never
 *     an arbitrary string: an unknown slug handed to add_role() would create a
 *     capability-less role and silently lock the user out.
 *
 *   ADMIN CONFIRMATION — a role with real administration capabilities needs the
 *     users:admin scope AND confirm_admin in the body. Two independent signals,
 *     one of which (the scope) only the site's own administrator can grant.
 *
 *   LAST ADMINISTRATOR — never demote or unmanage the last administrator. A
 *     site that loses its last admin cannot be recovered through the dashboard,
 *     only through the database.
 *
 *   PASSWORDS — generated, used once, never returned, never logged, never
 *     stored by us. If mail fails, that is a WARNING on an otherwise successful
 *     create; there is no condition under which a password is disclosed instead.
 *
 *   IDEMPOTENCY — required on every write. A bulk run across many sites will
 *     hit timeouts and be retried, and a retry must never apply a change twice.
 */

if (!defined('ABSPATH')) { exit; }

/**
 * Marks an account this tool CREATED, as opposed to one it was allowed to
 * manage. Set once at creation and never cleared — linking and unlinking move
 * _de_managed around, but they cannot make us the originator of an account we
 * did not create.
 *
 * The distinction carries real weight: changing an account's email address or
 * triggering its password reset is, in effect, taking the account over. That is
 * reasonable for an account we made for a member of staff, and is not
 * reasonable for a client's own Editor that we were permitted to re-role.
 */


/**
 * Records that someone completed a password reset.
 *
 * WordPress fires these when the reset form is submitted successfully, which is
 * the only moment anyone can observe from outside that an invitation was acted
 * on. Before this existed the dashboard had to infer it from the activation key
 * having been cleared — still true, still used for older accounts, but an
 * inference rather than an observation, and the two are reported separately so
 * nobody has to guess which they are looking at.
 *
 * Stamped for every account, not only ours: the hook is cheap, and an account
 * we link later is more useful with the timestamp already on it than without.
 * The value is a timestamp. Nothing about the password, the key or the form is
 * read, stored or transmitted.
 */
function deheled_um_stamp_password_set($user) {
    $id = ($user instanceof WP_User) ? (int) $user->ID : (int) $user;
    if ($id > 0) update_user_meta($id, DEHELED_UM_PASSWORD_SET_META, time());
}
add_action('password_reset', 'deheled_um_stamp_password_set', 10, 1);
add_action('after_password_reset', 'deheled_um_stamp_password_set', 10, 1);

add_action('rest_api_init', function () {
    register_rest_route(DEHELED_UM_NAMESPACE, '/users', array(
        'methods'             => 'POST',
        'permission_callback' => deheled_um_permission('users:write'),
        'callback'            => 'deheled_um_rest_create_user',
    ));
    register_rest_route(DEHELED_UM_NAMESPACE, '/users/(?P<id>\d+)', array(
        'methods'             => 'PATCH',
        'permission_callback' => deheled_um_permission('users:write'),
        'callback'            => 'deheled_um_rest_update_user',
    ));
    register_rest_route(DEHELED_UM_NAMESPACE, '/users/(?P<id>\d+)/link', array(
        'methods'             => 'POST',
        'permission_callback' => deheled_um_permission('users:write'),
        'callback'            => 'deheled_um_rest_link_user',
    ));
    register_rest_route(DEHELED_UM_NAMESPACE, '/users/(?P<id>\d+)/unlink', array(
        'methods'             => 'POST',
        'permission_callback' => deheled_um_permission('users:write'),
        'callback'            => 'deheled_um_rest_unlink_user',
    ));
    register_rest_route(DEHELED_UM_NAMESPACE, '/users/(?P<id>\d+)/password-reset', array(
        'methods'             => 'POST',
        'permission_callback' => deheled_um_permission('users:write'),
        'callback'            => 'deheled_um_rest_password_reset',
    ));
});

/* ------------------------------------------------------------ envelope ---- */

function deheled_um_ok($result, $user = null, $warnings = array(), $extra = array()) {
    return array_merge(array(
        'ok'       => true,
        'result'   => $result,          // created | linked | updated | skipped | unlinked | reset
        'user'     => $user ? deheled_um_user_shape($user) : null,
        'warnings' => array_values($warnings),
        'error'    => null,
    ), $extra);
}

/**
 * The fixed error set. Nothing here leaks a path, a query or a WordPress
 * internal — an administrator sees what to do, and nobody learns anything about
 * the server.
 */
function deheled_um_fail($code, $message, $status = 400, $extra = array()) {
    $body = array(
        'ok'     => false,
        'result' => 'failed',
        'user'   => null,
        'warnings' => array(),
        'error'  => array_merge(array('code' => $code, 'message' => $message), $extra),
    );
    $response = rest_ensure_response($body);
    $response->set_status($status);
    return $response;
}

/* --------------------------------------------------------- idempotency ---- */

/**
 * Wraps a write so it happens at most once per Idempotency-Key.
 *
 * Three states: already finished (replay the stored body), in flight (another
 * request is mid-write — tell the caller to retry rather than racing it), or
 * ours to run. The in-flight claim uses add_option(), which fails when the row
 * exists, so two concurrent duplicates cannot both win.
 */
function deheled_um_with_idempotency($request, $callback) {
    $key = (string) $request->get_header('idempotency-key');
    if ($key === '') {
        return deheled_um_fail('idempotency_required', 'This request needs an Idempotency-Key header.', 400);
    }

    $replay = deheled_um_idempotent_replay($key);
    if ($replay !== null) return $replay;

    $lock = 'deheled_um_l_' . hash('sha256', $key);
    if (!add_option($lock, time(), '', 'no')) {
        $started = (int) get_option($lock, 0);
        // A lock older than the request timeout is a crashed run, not a live
        // one; reclaim it rather than blocking this key forever.
        if ($started && (time() - $started) < 120) {
            return deheled_um_fail('in_progress', 'An identical request is already being processed.', 409);
        }
        update_option($lock, time(), 'no');
    }

    try {
        $result = call_user_func($callback);
    } catch (Exception $e) {
        delete_option($lock);
        return deheled_um_fail('failed', 'The request could not be completed.', 500);
    }

    // Only successful results are stored. A failure is usually a guard the
    // caller can fix (wrong role, missing confirmation); replaying it forever
    // would make the corrected retry impossible.
    $status = 200;
    $body = $result;
    if ($result instanceof WP_REST_Response) {
        $status = $result->get_status();
        $body = $result->get_data();
    }
    if (!empty($body['ok'])) {
        deheled_um_idempotent_store($key, $body, $status);
    }
    delete_option($lock);
    return $result;
}

/* --------------------------------------------------------------- guards --- */

/** Loads a user, or the not_found failure. */
function deheled_um_require_user($request) {
    $id = (int) $request['id'];
    $user = $id > 0 ? get_user_by('id', $id) : false;
    if (!$user) return deheled_um_fail('not_found', 'No such user on this website.', 404);
    return $user;
}

/**
 * THE guard that keeps clients' accounts theirs. Every mutating route calls it
 * except /link, which is how an account becomes managed in the first place.
 */
function deheled_um_require_managed($user) {
    if (!deheled_um_user_is_managed($user->ID)) {
        return deheled_um_fail(
            'not_managed',
            'That account isn\'t managed by Digital Elements. Link it first if it should be.',
            409
        );
    }
    return true;
}

/**
 * Validates a role and the permission to assign it.
 *
 * Returns true, or a failure response. `$confirm` is the caller's explicit
 * confirmation; the users:admin scope is the site's own consent. Both are
 * required for an administering role, and neither can substitute for the other.
 */
function deheled_um_check_role($role, $confirm) {
    $role = sanitize_key($role);
    $editable = deheled_um_editable_roles();

    if ($role === '' || !isset($editable[$role])) {
        return deheled_um_fail(
            'role_not_available',
            sprintf('"%s" isn\'t a role on this website.', $role),
            400,
            array('available' => array_keys($editable))
        );
    }

    if (deheled_um_role_is_site_admin($editable[$role]['capabilities'])) {
        if (!in_array('users:admin', deheled_um_scopes(), true)) {
            return deheled_um_fail(
                'scope_denied',
                'This website hasn\'t allowed the dashboard to assign administrator roles.',
                403
            );
        }
        if (!$confirm) {
            return deheled_um_fail(
                'role_requires_confirmation',
                sprintf('"%s" can administer this website. Confirm explicitly to assign it.', $role),
                409
            );
        }
    }
    return true;
}

/**
 * Refuses anything that would leave the site without an administrator.
 *
 * Counted live rather than trusted from the request, and applied to unlinking
 * as well as demotion: an unlinked admin is one we can no longer act on, which
 * is the same trap from the dashboard's point of view.
 */
function deheled_um_check_last_administrator($user, $new_role = null) {
    if (!in_array('administrator', (array) $user->roles, true)) return true;
    if ($new_role === 'administrator') return true;

    if (deheled_um_administrator_count() <= 1) {
        return deheled_um_fail(
            'last_administrator',
            'This is the only administrator on this website. Add another before changing this one.',
            409
        );
    }
    return true;
}

/** True when the value is a real failure response rather than a pass. */
function deheled_um_is_failure($value) {
    return $value instanceof WP_REST_Response || $value instanceof WP_Error;
}

/* --------------------------------------------------------------- create --- */

/**
 * A username derived from the email local part, de-duplicated on this site.
 *
 * Only the site knows what is already taken, so the suffix is resolved here
 * rather than guessed by the dashboard.
 */
function deheled_um_unique_login($email, $preferred = '') {
    $base = $preferred !== '' ? $preferred : substr((string) $email, 0, strpos((string) $email, '@'));
    $base = sanitize_user($base, true);
    $base = preg_replace('/[^A-Za-z0-9_.\-]/', '', $base);
    $base = trim($base, '._-');
    if ($base === '') $base = 'user';
    $base = substr($base, 0, 50);

    $login = $base;
    for ($n = 2; $n < 1000 && username_exists($login); $n++) {
        $login = substr($base, 0, 50 - strlen((string) $n)) . $n;
    }
    return $login;
}

function deheled_um_rest_create_user($request) {
    return deheled_um_with_idempotency($request, function () use ($request) {
        $email = sanitize_email((string) $request->get_param('email'));
        if ($email === '' || !is_email($email)) {
            return deheled_um_fail('invalid_email', 'A valid email address is required.', 400);
        }

        $role = sanitize_key((string) $request->get_param('role'));
        $check = deheled_um_check_role($role, (bool) $request->get_param('confirm_admin'));
        if (deheled_um_is_failure($check)) return $check;

        // Creating a duplicate is exactly what the dashboard's lookup exists to
        // prevent, but the site is the authority and races are possible.
        $existing = get_user_by('email', $email);
        if ($existing) {
            return deheled_um_fail(
                'user_exists',
                'An account with that email address already exists on this website.',
                409,
                array('user' => deheled_um_user_shape($existing))
            );
        }

        $login = deheled_um_unique_login($email, sanitize_user((string) $request->get_param('username'), true));

        // Generated, handed straight to WordPress, and never referenced again.
        // It is deliberately not assigned to a named variable that outlives this
        // call, not returned, and not logged.
        $userdata = array(
            'user_login'   => $login,
            'user_email'   => $email,
            'user_pass'    => wp_generate_password(32, true, true),
            'role'         => $role,
            'first_name'   => sanitize_text_field((string) $request->get_param('first_name')),
            'last_name'    => sanitize_text_field((string) $request->get_param('last_name')),
            'display_name' => sanitize_text_field((string) $request->get_param('display_name')),
        );
        if ($userdata['display_name'] === '') {
            $userdata['display_name'] = trim($userdata['first_name'] . ' ' . $userdata['last_name']);
            if ($userdata['display_name'] === '') $userdata['display_name'] = $login;
        }

        $user_id = wp_insert_user($userdata);
        unset($userdata);

        if (is_wp_error($user_id)) {
            return deheled_um_fail('create_failed', 'WordPress refused to create that account.', 400);
        }

        update_user_meta($user_id, DEHELED_UM_MANAGED_META, '1');
        update_user_meta($user_id, '_de_managed_at', time());
        // Durable, and deliberately NOT cleared by unlink: "did we create this
        // account?" must stay answerable for the life of the account. An
        // account we merely linked is a client's account we were allowed to
        // administer, which is a weaker claim than one we made ourselves.
        update_user_meta($user_id, DEHELED_UM_CREATED_META, '1');

        $warnings = deheled_um_notify_new_user($user_id);

        return rest_ensure_response(deheled_um_ok('created', get_user_by('id', $user_id), $warnings));
    });
}

/**
 * Triggers WordPress's own set-password email and reports whether it went.
 *
 * wp_new_user_notification() discards wp_mail()'s return value, so delivery has
 * to be observed through hooks. Getting this right matters more than it looks:
 * a send reported as successful when it silently failed means someone never
 * receives their set-password email and nobody finds out.
 *
 * There is deliberately no branch anywhere that returns the password instead. A
 * site with broken mail is a site whose users use the ordinary Lost Password
 * flow, not one where we email plaintext credentials around.
 */
/**
 * Starts watching wp_mail, and returns the handle to stop with.
 *
 * Extracted so the invitation and the resend judge delivery by exactly the same
 * evidence. They used not to: creation watched the hooks, while the resend
 * trusted retrieve_password()'s return value — which reports wp_mail()'s
 * verdict, and wp_mail() can return true while a plugin silently drops the
 * message. Two paths answering "was it sent?" differently is how a person ends
 * up waiting for an email the dashboard says they received.
 */
function deheled_um_watch_mail() {
    $state = array('attempted' => false, 'succeeded' => false, 'failed' => false,
                   'short_circuited' => false, 'short_value' => null);

    $handle = array('state' => &$state);
    $handle['on_attempt'] = function ($atts) use (&$state) { $state['attempted'] = true; return $atts; };
    // Observed at the lowest priority so we see the FINAL short-circuit value,
    // after any mail plugin has had its say.
    $handle['on_short'] = function ($pre, $atts = null) use (&$state) {
        $state['short_circuited'] = true;
        $state['short_value'] = $pre;
        return $pre;
    };
    $handle['on_ok']   = function ($info) use (&$state) { $state['succeeded'] = true; };
    $handle['on_fail'] = function ($err) use (&$state) { $state['failed'] = true; };

    add_filter('wp_mail', $handle['on_attempt'], PHP_INT_MAX);
    add_filter('pre_wp_mail', $handle['on_short'], PHP_INT_MAX, 2);
    add_action('wp_mail_succeeded', $handle['on_ok']);
    add_action('wp_mail_failed', $handle['on_fail']);

    return $handle;
}

/** Stops watching and returns what was observed, for deheled_um_mail_delivered(). */
function deheled_um_stop_watching_mail($handle) {
    remove_filter('wp_mail', $handle['on_attempt'], PHP_INT_MAX);
    remove_filter('pre_wp_mail', $handle['on_short'], PHP_INT_MAX);
    remove_action('wp_mail_succeeded', $handle['on_ok']);
    remove_action('wp_mail_failed', $handle['on_fail']);
    return $handle['state'];
}

function deheled_um_notify_new_user($user_id) {
    $handle = deheled_um_watch_mail();
    wp_new_user_notification($user_id, null, 'user');
    $state = deheled_um_stop_watching_mail($handle);

    if (deheled_um_mail_delivered($state)) return array();

    return array(array(
        'code' => 'mail_failed',
        'message' => 'The account was created, but this website couldn\'t send the set-password email. The user can use the Lost Password link instead.',
    ));
}

/**
 * Did the notification actually go?
 *
 * Separated out because the ordering is subtle enough to be worth testing on
 * its own. In particular: wp_mail() applies the `wp_mail` filter BEFORE
 * `pre_wp_mail`, so a plugin short-circuiting delivery still looks like an
 * attempt. Treating "the filter ran" as success is exactly how a failed send
 * gets reported as a successful one.
 *
 * When nothing conclusive is observed the answer is "not delivered". An
 * unnecessary warning costs an administrator a moment; a missed one costs
 * somebody their account access with no indication why.
 */
function deheled_um_mail_delivered($state) {
    // A plugin that short-circuits wp_mail decides the outcome outright — that
    // return value IS what wp_mail() gives back.
    if (!empty($state['short_circuited']) && $state['short_value'] !== null) {
        return (bool) $state['short_value'];
    }
    if (!empty($state['failed']))    return false;
    if (!empty($state['succeeded'])) return true;
    // Nothing was even attempted: no mail was sent.
    if (empty($state['attempted']))  return false;
    // Attempted, but neither outcome hook fired. WordPress 5.9+ always fires
    // one of them, so this is an older core or an unusual mail plugin, and the
    // send is unverified rather than confirmed.
    return false;
}

/* --------------------------------------------------------------- update --- */

function deheled_um_rest_update_user($request) {
    return deheled_um_with_idempotency($request, function () use ($request) {
        $user = deheled_um_require_user($request);
        if (deheled_um_is_failure($user)) return $user;

        $managed = deheled_um_require_managed($user);
        if (deheled_um_is_failure($managed)) return $managed;

        $fields = array('ID' => $user->ID);
        $changed = array();

        $email = $request->get_param('email');
        if ($email !== null && (string) $email !== (string) $user->user_email) {
            // Changing the address IS taking the account over: the next password
            // reset goes to the new address. Allowed for an account we created
            // for a member of staff; refused for a client's own account we were
            // merely permitted to administer.
            if (!deheled_um_user_was_created_by_us($user->ID)) {
                return deheled_um_fail(
                    'linked_account_protected',
                    'This account belongs to the website, not to us. Its email address can\'t be changed from here.',
                    403
                );
            }
            $email = sanitize_email((string) $email);
            if ($email === '' || !is_email($email)) {
                return deheled_um_fail('invalid_email', 'A valid email address is required.', 400);
            }
            $clash = get_user_by('email', $email);
            if ($clash && (int) $clash->ID !== (int) $user->ID) {
                return deheled_um_fail('user_exists', 'Another account on this website already uses that email address.', 409);
            }
            if ($email !== $user->user_email) { $fields['user_email'] = $email; $changed[] = 'email'; }
        }

        foreach (array('first_name', 'last_name', 'display_name') as $field) {
            $value = $request->get_param($field);
            if ($value === null) continue;
            $fields[$field] = sanitize_text_field((string) $value);
            $changed[] = $field;
        }

        $role = $request->get_param('role');
        if ($role !== null) {
            $role = sanitize_key((string) $role);
            $check = deheled_um_check_role($role, (bool) $request->get_param('confirm_admin'));
            if (deheled_um_is_failure($check)) return $check;

            // Demoting the only administrator would strand the site.
            $guard = deheled_um_check_last_administrator($user, $role);
            if (deheled_um_is_failure($guard)) return $guard;

            if (!in_array($role, (array) $user->roles, true) || count((array) $user->roles) !== 1) {
                $fields['role'] = $role;
                $changed[] = 'role';
            }
        }

        if (!$changed) {
            return rest_ensure_response(deheled_um_ok('skipped', $user, array(), array('changed' => array())));
        }

        $updated = wp_update_user($fields);
        if (is_wp_error($updated)) {
            return deheled_um_fail('update_failed', 'WordPress refused that change.', 400);
        }

        return rest_ensure_response(deheled_um_ok('updated', get_user_by('id', $user->ID), array(), array('changed' => $changed)));
    });
}

/* ----------------------------------------------------------- link/unlink -- */

/**
 * The ONLY route that may touch an account we don't already manage.
 *
 * Linking by itself changes nothing a visitor or the account holder would
 * notice: it records that this account is ours to manage from now on. Any role
 * change is a separate PATCH, with its own guards.
 */
function deheled_um_rest_link_user($request) {
    return deheled_um_with_idempotency($request, function () use ($request) {
        $user = deheled_um_require_user($request);
        if (deheled_um_is_failure($user)) return $user;

        if (deheled_um_user_is_managed($user->ID)) {
            return rest_ensure_response(deheled_um_ok('skipped', $user, array(), array('already_linked' => true)));
        }

        // Adopting ANY account we did not create is a deliberate act, not a
        // side effect of a bulk run. Without this, /link is a door into every
        // account on the site that happens not to be an administrator.
        if (!$request->get_param('confirm_link')) {
            return deheled_um_fail(
                'link_requires_confirmation',
                'That account already exists on this website and wasn\'t created by us. Confirm explicitly to start managing it.',
                409
            );
        }

        // Adopting an administrator is a bigger step again: once linked, the
        // dashboard can change that account's role.
        if (deheled_um_user_has_role_matching($user, 'deheled_um_role_is_site_admin')) {
            if (!in_array('users:admin', deheled_um_scopes(), true)) {
                return deheled_um_fail('scope_denied', 'This website hasn\'t allowed the dashboard to manage administrator accounts.', 403);
            }
            if (!$request->get_param('confirm_admin')) {
                return deheled_um_fail('role_requires_confirmation', 'That account can administer this website. Confirm explicitly to link it.', 409);
            }
        }

        update_user_meta($user->ID, DEHELED_UM_MANAGED_META, '1');
        update_user_meta($user->ID, '_de_managed_at', time());
        update_user_meta($user->ID, '_de_linked', '1');

        return rest_ensure_response(deheled_um_ok('linked', get_user_by('id', $user->ID)));
    });
}

/**
 * Stops managing an account. The account itself is untouched — same role, same
 * content, same access. Deleting it is a separate, guarded operation.
 */
function deheled_um_rest_unlink_user($request) {
    return deheled_um_with_idempotency($request, function () use ($request) {
        $user = deheled_um_require_user($request);
        if (deheled_um_is_failure($user)) return $user;

        if (!deheled_um_user_is_managed($user->ID)) {
            return rest_ensure_response(deheled_um_ok('skipped', $user, array(), array('already_unlinked' => true)));
        }

        // An unlinked administrator is one the dashboard can no longer act on,
        // which strands the site the same way a demotion would.
        $guard = deheled_um_check_last_administrator($user);
        if (deheled_um_is_failure($guard)) return $guard;

        delete_user_meta($user->ID, DEHELED_UM_MANAGED_META);
        delete_user_meta($user->ID, '_de_managed_at');
        delete_user_meta($user->ID, '_de_linked');

        return rest_ensure_response(deheled_um_ok('unlinked', get_user_by('id', $user->ID)));
    });
}

/* ------------------------------------------------------- password reset --- */

/**
 * Asks WordPress to send its own reset email. We never see, choose, or transmit
 * the password — this is the supported recovery path when the original
 * set-password email didn't arrive.
 */
function deheled_um_rest_password_reset($request) {
    return deheled_um_with_idempotency($request, function () use ($request) {
        $user = deheled_um_require_user($request);
        if (deheled_um_is_failure($user)) return $user;

        $managed = deheled_um_require_managed($user);
        if (deheled_um_is_failure($managed)) return $managed;

        // Same reasoning as the email change: sending a reset link is a route
        // into the account. Ours to offer for an account we created; not ours
        // for a client's own account.
        if (!deheled_um_user_was_created_by_us($user->ID)) {
            return deheled_um_fail(
                'linked_account_protected',
                'This account belongs to the website, not to us. Use its own Lost Password link instead.',
                403
            );
        }

        // Sending a new link invalidates the previous one, because
        // retrieve_password() overwrites user_activation_key. That is
        // WordPress's own mechanism and there is deliberately nothing of ours
        // beside it: no second key, no expiry we maintain, nothing to fall out
        // of step with the only copy that matters.
        //
        // Delivery is judged the way creation judges it — by watching the mail
        // hooks — rather than by trusting the return value. retrieve_password()
        // reports on wp_mail()'s verdict, and wp_mail() can return true while a
        // plugin silently drops the message. That is exactly how an invitation
        // came to be reported as sent when nobody received it.
        $handle = deheled_um_watch_mail();
        $result = retrieve_password($user->user_login);
        $delivered = deheled_um_mail_delivered(deheled_um_stop_watching_mail($handle));

        if (is_wp_error($result) || !$delivered) {
            return rest_ensure_response(deheled_um_ok('reset', $user, array(array(
                'code' => 'mail_failed',
                'message' => 'This website couldn\'t send the reset email. The user can use the Lost Password link instead.',
            ))));
        }
        return rest_ensure_response(deheled_um_ok('reset', $user));
    });
}
