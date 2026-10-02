<?php
/**
 * images-icons/api.php — engine-side re-home of the Laravel store's
 * Admin\ImageController::scan (store decommission item C4). POST-only,
 * authenticated with the engine's own token-cookie check (same idiom as
 * status/api.php and cluster/api.php).
 *
 *   POST ?action=scan  → {result:true, message:'success',
 *                         data:[ '<basename>', ... ]}
 *
 * Returns the basenames of the node-icon files under html/images/icons, in the
 * SAME {result,message,data} envelope the store's Reply::finish produced — the
 * consumers (pnetlab-node-form.js icon picker, CanvasFlow.svelte node editor)
 * read `j.data`.
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

/* ---- AUTH — engine cookie/session check -------------------------------------- */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    fail(401, 'not authenticated');
}

$action = isset($_GET['action']) ? $_GET['action'] : '';

/* ---- POST scan: basenames of the node-icon directory ------------------------- */
if ($action === 'scan') {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') fail(405, 'method not allowed');
    $folder = '/opt/unetlab/html/images/icons';
    $data = [];
    if (is_dir($folder)) {
        foreach (scandir($folder) as $f) {
            if ($f === '.' || $f === '..') continue;
            if (is_file($folder . '/' . $f)) $data[] = basename($f);
        }
    }
    reply_finish(true, 'success', $data);
}

fail(400, 'unknown action');
