<?php
/**
 * pnq-placements.php — which nodes of the caller's lab session run on a
 * satellite. Backs pnetlab-sat-badge.js, which paints a small ✈ marker on the
 * top-right of each satellite-hosted node on the canvas.
 *
 * Returns {"nodes":{"<node_id>":<host_id>, …}} for nodes whose session runs on
 * a satellite (host_id > 0; master-hosted nodes are omitted). Resolved from
 * node_sessions.node_session_host (falls back to the lab XML placement), exactly
 * like the overlay/glow endpoints. Empty object on a non-clustered install.
 *
 * Auth mirrors pnq-linkstats.php (engine token + the user's lab session).
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');
function out($x) { echo json_encode($x); exit; }

$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) { http_response_code(401); out(['error' => 'not authenticated']); }

$lab = isset($user['lab']) ? $user['lab'] : '';
if ($lab === '') out(['nodes' => new stdClass()]);

$res = [];
try {
    $labsession = getLabFromSession($lab);
    if ($labsession) {
        $labObj = new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $lab);
        foreach ($labObj->getNodes() as $node_id => $node) {
            $hid = (int) cluster_session_host($labObj, $node_id);
            if ($hid > 0) $res[(int) $node_id] = $hid;
        }
    }
} catch (Exception $e) { /* non-cluster / pre-migration: no markers */ }

out(['nodes' => empty($res) ? new stdClass() : $res]);
