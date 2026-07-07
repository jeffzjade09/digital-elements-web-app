<?php
if (!defined('ABSPATH')) { exit; }

// Fail-soft: if the dashboard is unreachable we keep the last known status.
function deheled_validate_license($key) {
    $key = trim((string) $key);
    if ($key === '') {
        delete_option(DEHELED_LIC_STATUS);
        return null;
    }
    $res = wp_remote_get(
        DEHELED_HUB_URL . '/api/license/validate?key=' . rawurlencode($key),
        array('timeout' => 8)
    );
    $status = array('checked_at' => time());
    if (is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200) {
        $prev = get_option(DEHELED_LIC_STATUS, array());
        $status = is_array($prev) ? $prev : array();
        $status['checked_at'] = isset($status['checked_at']) ? $status['checked_at'] : 0;
        $status['unreachable'] = time();
        update_option(DEHELED_LIC_STATUS, $status, false);
        return $status;
    }
    $body = json_decode(wp_remote_retrieve_body($res), true);
    $status['unreachable'] = 0;
    $status['valid']      = !empty($body['valid']);
    $status['expired']    = !empty($body['expired']);
    $status['site']       = isset($body['site']) ? (string) $body['site'] : '';
    $status['expires_at'] = isset($body['expiresAt']) ? (string) $body['expiresAt'] : '';
    $status['days_left']  = isset($body['daysLeft']) ? $body['daysLeft'] : null;
    update_option(DEHELED_LIC_STATUS, $status, false);
    return $status;
}

