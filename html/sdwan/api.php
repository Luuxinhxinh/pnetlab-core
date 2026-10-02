<?php
/**
 * sdwan/api.php — status poll for the SD-WAN control-plane onboarding job.
 *
 * The job is CREATED by the build/onboard handler (includes/api_sdwan.php, route
 * POST /api/labs/session/sdwan/build), which writes a 0600 jobs/<job>.req and
 * kicks the broker verb worker_sdwan. This endpoint only reports/controls it:
 *
 *   GET  ?action=status&job=<16hex>   → jobs/<job>.json  ({state,pct,msg})
 *   POST ?action=cancel&job=<16hex>   → stop the pnet-sdwan-<job> unit
 *
 * Admin-gated with the engine's own cookie/session check — identical to
 * import/api.php (the background-job pattern this clones).
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

$BASE = __DIR__;
$JOBS = "$BASE/jobs";
@mkdir($JOBS, 0777, true);

function fail($code, $m) { http_response_code($code); echo json_encode(['error' => $m]); exit; }

/* ---- AUTH — reuse the engine's real cookie/session check (admin only) ------- */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    fail(401, 'not authenticated');
}
$role    = isset($user['role']) ? $user['role'] : '';
$isAdmin = ($role === 0 || $role === '0' || strtolower((string) $role) === 'admin');
if (!$isAdmin) {
    fail(403, 'sdwan onboarding is admin-only');
}

$action = isset($_GET['action']) ? $_GET['action'] : '';
$job    = isset($_GET['job']) ? $_GET['job'] : '';
if (!preg_match('/^[a-f0-9]{16}$/', $job)) fail(400, 'bad job');

if ($action === 'status') {
    $f = "$JOBS/$job.json";
    if (!file_exists($f)) fail(404, 'no such job');
    echo file_get_contents($f);
    exit;
}

if ($action === 'cancel') {
    // detach is via the broker; worker_kill validates the job-id format itself
    $resp = broker_call('worker_kill', ['kind' => 'sdwan', 'job' => $job]);
    echo json_encode(['ok' => !empty($resp['ok'])]);
    exit;
}

fail(400, 'unknown action');
