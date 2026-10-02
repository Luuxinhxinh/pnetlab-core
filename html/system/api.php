<?php
/**
 * system/api.php — engine-side re-home of the Laravel store's
 * Admin\SystemController::fixPermission (store decommission item C4). POST-only,
 * admin-gated, authenticated with the engine's own token-cookie check (same
 * idiom as status/api.php and cluster/api.php).
 *
 *   POST ?action=fixPermission  → {result:true, message:'success', data:''}
 *
 * Runs `fixpermissions` (unl_wrapper) then regenerates the host-locked IOL
 * license (iourc) via the broker's iol_keygen verb — exactly what the store
 * controller did. Returns the same {result,message,data} Reply envelope; the
 * consumer (pnetlab-sidebar-tools.js) fires-and-forgets and only needs a 200.
 *
 * Only fixPermission is re-homed here. SystemController's other methods
 * (proxy/clouds/ipv6/numa/console/service-restart/power/shutdown) are consumed
 * by the /main/ dashboard via status/api.php or have no live engine consumer;
 * they are intentionally NOT ported in this change (open product decision).
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function reply_finish($result, $message, $data = '') {
    echo json_encode(['result' => $result, 'message' => $message, 'data' => $data]);
    exit;
}
function fail($code, $m) { http_response_code($code); echo json_encode(['error' => $m]); exit; }

/* ---- AUTH — engine cookie/session check, admin only -------------------------- */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    fail(401, 'not authenticated');
}
$role    = isset($user['role']) ? $user['role'] : '';
$isAdmin = ($role === 0 || $role === '0' || strtolower((string) $role) === 'admin');

$action = isset($_GET['action']) ? $_GET['action'] : '';

/* ---- POST fixPermission: fixpermissions + iol_keygen (admin, via broker) ----- */
if ($action === 'fixPermission') {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') fail(405, 'method not allowed');
    if (!$isAdmin) reply_finish(false, 'ERROR_PERMISSION');
    // fixpermissions can be slow on large installs — matches the store's 300s.
    broker_call('wrapper', ['action' => 'fixpermissions'], 300);
    // Regenerate the host-locked IOL license (iourc) with the python3 keygen,
    // which writes a correctly-permissioned iourc to the absolute path itself.
    broker_call('iol_keygen');
    reply_finish(true, 'success');
}

fail(400, 'unknown action');
