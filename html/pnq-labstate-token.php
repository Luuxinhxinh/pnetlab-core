<?php
/**
 * pnq-labstate-token.php — session-gated mint for the lab-state push socket.
 *
 * The topology page calls this (same-origin, behind the PNETLab session cookie)
 * before opening wss://<host>/labstate/. We reuse the engine's OWN auth boundary
 * (indentify::authorization + the user's open lab session) — exactly like
 * console/token_mint.php — and mint a single-use token bound to the caller's
 * tenant + lab_session:
 *
 *   /dev/shm/pnet-labstate-tokens/<hex32>  ->  "<tenant> <lab_session>"
 *
 * pnetlab-labstated reads+unlinks it on the hello frame and scopes the whole
 * connection to that tenant/lab, so a client can never subscribe to a foreign
 * lab. The token carries the same "<tenant>_<lab_session>" identity the Network
 * Watcher watch_id uses (pnq-linkwatch.php: intval($tenant)_intval($user['lab'])),
 * so the daemon's link.state path lines up.
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function ls_fail($code, $msg) {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

define('LS_TOKEN_DIR', '/dev/shm/pnet-labstate-tokens');
define('LS_TOKEN_TTL', 120);

/* ---- auth: the engine's real cookie/session check ---------------------- */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    ls_fail(401, 'not authenticated');
}

$session = isset($user['lab']) ? $user['lab'] : '';
if ($session === '' || !ctype_digit((string) $session)) {
    ls_fail(409, 'no lab open in this session');
}

/* ---- mint single-use token -------------------------------------------- */
if (!is_dir(LS_TOKEN_DIR)) {
    @mkdir(LS_TOKEN_DIR, 0770, true);
}
$token = bin2hex(random_bytes(16));
$line  = intval($tenant) . ' ' . intval($session);
$path  = rtrim(LS_TOKEN_DIR, '/') . '/' . $token;
if (@file_put_contents($path, $line, LOCK_EX) === false) {
    ls_fail(500, 'could not write token');
}
@chmod($path, 0640);

echo json_encode([
    'token'      => $token,
    'lab_session' => intval($session),
    'expires_in' => LS_TOKEN_TTL,
]);
