<?php
// Pure catalog/request helpers; image mutations belong to the root broker.
function pnq_managed_device($device) {
    return !empty($device['managed_repository']) &&
        preg_match('~^rspnet/pnet-[a-z0-9-]+$~', $device['managed_repository']) &&
        preg_match('~^pnet-[a-z0-9-]+:[0-9]+\.[0-9]+(?:\.[0-9]+)?$~', $device['device_version'] ?? '');
}

function pnq_managed_present($device, $refs) {
    $family = explode(':', $device['device_version'])[0];
    foreach ($refs as $ref) {
        if ($ref === $device['device_version'] ||
            preg_match('~^' . preg_quote($family, '~') . ':[0-9]+\.[0-9]+(?:\.[0-9]+)?$~', $ref)) return true;
    }
    return false;
}

// JSON requests cannot be sent by cross-origin HTML forms. Also reject
// cross-site fetches and explicit foreign origins; absent Origin is allowed
// for same-origin requests and authenticated CLI users.
function pnq_update_request_allowed($server) {
    if (strtolower(trim(explode(';', $server['CONTENT_TYPE'] ?? '')[0])) !== 'application/json') return false;
    if (($server['HTTP_SEC_FETCH_SITE'] ?? '') === 'cross-site') return false;
    if (!empty($server['HTTP_ORIGIN'])) {
        $scheme = (!empty($server['HTTPS']) && $server['HTTPS'] !== 'off') ? 'https' : 'http';
        if (strtolower(rtrim($server['HTTP_ORIGIN'], '/')) !==
            strtolower($scheme . '://' . ($server['HTTP_HOST'] ?? ''))) return false;
    }
    return true;
}

function pnq_updates_call($operation, $args = []) {
    $resp = broker_call('docker_node_updates', array_merge(['operation' => $operation], $args), 30);
    $data = json_decode($resp['out'][0] ?? '', true);
    if (empty($resp['ok']) || ($resp['rc'] ?? 1) !== 0 || !is_array($data)) {
        return ['result' => false, 'message' => !empty($resp['err']) ? $resp['err'] : 'Docker node update service unavailable', 'data' => []];
    }
    return ['result' => true, 'message' => 'success', 'data' => $data];
}
