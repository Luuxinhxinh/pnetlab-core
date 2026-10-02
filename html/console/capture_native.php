<?php
/**
 * capture_native.php — resolve the host tap interface for a NATIVE (client-side)
 * Wireshark capture of node:iface, scoped to the caller's own running lab.
 *
 * The browser calls:  capture_native.php?node=<id>&iface=<id>
 * and gets {ok, tap, why}. The client (pnetlab-webconsole.js, html5=0 lane) then
 * builds capture://<server-host>/<tap> and hands it to the OS protocol handler
 * (EVE/PNetLab Windows Client Pack wireshark_wrapper.bat), which SSHes in and runs
 *   tcpdump -U -i <tap> -s 0 -w -   | Wireshark
 * The tap (vunl<session>_<iface> / ser…) is the SAME interface the docker/VNC
 * capture lane tc-mirrors — captureMirrorTap() is the single source of truth, so
 * native and in-browser capture point at identical L2 frames (incl. the satellite
 * cross-host master-peer redirect). This endpoint only RESOLVES + ownership-checks
 * the tap; it never runs tcpdump (the client pack does, over its own SSH).
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function fail($code, $msg) {
    http_response_code($code);
    echo json_encode(['ok' => false, 'why' => $msg]);
    exit;
}

/* AUTH — reuse the engine's real cookie/session check (same as token_mint.php). */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    fail(401, 'not authenticated');
}

$nodeId = isset($_GET['node'])  ? (string) $_GET['node']  : '';
$iface  = isset($_GET['iface']) ? (string) $_GET['iface'] : '';
if ($nodeId === '' || $iface === '') {
    fail(400, 'node and iface are required');
}

/* Open ONLY the lab the caller has running in their session (engine ownership
   boundary — identical to token_mint.php::open_user_lab). */
$sessionId = isset($user['lab']) ? (string) $user['lab'] : '';
if ($sessionId === '') { fail(409, 'no lab open in this session'); }
$labsession = getLabFromSession($sessionId);
if (!$labsession) { fail(409, 'no running lab session'); }
try {
    $lab = new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $sessionId);
} catch (Exception $e) {
    fail(500, 'cannot open lab');
}

/* Resolve the effective host tap (own tap, or master peer's tap for a satellite
   cross-host p2p link). captureMirrorTap() lives in includes/functions.php. */
$cap = captureMirrorTap($lab, $nodeId, $iface);
if (empty($cap['ok']) || empty($cap['tap'])) {
    fail(409, (isset($cap['why']) && $cap['why'] !== '') ? $cap['why'] : 'Capture is not available for this interface.');
}

echo json_encode(['ok' => true, 'tap' => $cap['tap'], 'redirected' => !empty($cap['redirected'])]);
exit;
