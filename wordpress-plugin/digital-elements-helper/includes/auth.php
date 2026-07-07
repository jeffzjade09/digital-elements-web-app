<?php
if (!defined('ABSPATH')) { exit; }

function deheled_validate_token($provided) {
    if (!is_string($provided) || $provided === '') {
        return false;
    }
    // Preferred: the license key entered in DE Monitoring settings (no wp-config needed).
    $license = get_option(DEHELED_LICENSE_OPTION, '');
    if (is_string($license) && $license !== '' && hash_equals((string) $license, $provided)) {
        return true;
    }
    // Backward compatible: token/hash defined in wp-config.php.
    if (defined('WPMONITOR_TOKEN_HASH') && WPMONITOR_TOKEN_HASH !== '') {
        return hash_equals(strtolower((string) WPMONITOR_TOKEN_HASH), hash('sha256', $provided));
    }
    if (defined('WPMONITOR_TOKEN') && WPMONITOR_TOKEN !== '') {
        return hash_equals((string) WPMONITOR_TOKEN, $provided);
    }
    return false; // fail closed
}

function deheled_check_token($request) {
    $provided = '';
    $auth = $request->get_header('authorization');
    if ($auth && stripos($auth, 'Bearer ') === 0) {
        $provided = trim(substr($auth, 7));
    }
    if ($provided === '') {
        $provided = (string) $request->get_header('x-wpmonitor-token');
    }
    if (deheled_validate_token($provided)) {
        return true;
    }
    return new WP_Error('deheled_forbidden', 'Forbidden', array('status' => 403));
}
