<?php
/**
 * pnq-telemetry.php — per-node CPU/RAM HISTORY for the caller's OWN lab
 * session (feature 5's canvas Resource-graph panel feed). Auth mirrors
 * pnq-nodestats.php exactly: engine token cookie + the user's lab session —
 * a user can only ever read series for nodes of the lab THEY have open
 * (the nid is resolved against node_sessions rows of $user['lab']; any
 * other nid → 404, no cross-lab leak).
 *
 *   GET /pnq-telemetry.php?nid=<n>&range=15m|1h|2h
 *   → {"data":{"nid":N,"step":30,"range":"15m","collector":"ok|down",
 *              "series":[{"ts":epoch,"cpu":pct,"mem_mb":MB}, ...]}}
 *
 * Series come from pnq-telemetryd's SQLite store (node_raw, 30s step, 2h
 * retention — which is why 2h is the max range). CPU% is the daemon's
 * /proc-delta definition (percent of ONE core, 30s window; docker via
 * docker stats) — smoother than the live modal's top numbers by design.
 * Reads are READONLY with busy_timeout; a missing DB / stopped daemon
 * degrades to {series:[],collector:'down'}, never a 500.
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
if ($user === false || empty($user)) {
    http_response_code(401); out(['error' => 'not authenticated']);
}

$lab = isset($user['lab']) ? $user['lab'] : '';
if ($lab === '') { http_response_code(404); out(['error' => 'no open lab session']); }

$nid = isset($_GET['nid']) ? (int) $_GET['nid'] : 0;
$RANGES = ['15m' => 900, '1h' => 3600, '2h' => 7200];
$range = isset($_GET['range']) && isset($RANGES[$_GET['range']]) ? $_GET['range'] : '15m';

/* Own-lab jail: the nid must belong to a node session of THIS lab session. */
try {
    $db = checkDatabase();
    $st = $db->prepare('SELECT node_session_nid FROM node_sessions WHERE node_session_lab = :lab AND node_session_nid = :nid');
    $st->execute(['lab' => $lab, 'nid' => $nid]);
    if ($st->fetch(PDO::FETCH_ASSOC) === false) {
        http_response_code(404); out(['error' => 'no such node in your lab']);
    }
} catch (Exception $e) {
    http_response_code(404); out(['error' => 'no such node in your lab']);
}

$empty = ['nid' => $nid, 'step' => 30, 'range' => $range,
          'collector' => 'down', 'series' => []];
$dbp = '/opt/unetlab/data/telemetry/telemetry.db';
if (!is_file($dbp)) out(['data' => $empty]);
try {
    $tdb = new SQLite3($dbp, SQLITE3_OPEN_READONLY);
    $tdb->busyTimeout(2500);
} catch (Exception $e) { out(['data' => $empty]); }

$series = [];
$coll = 'ok';
try {
    $st = $tdb->prepare('SELECT ts, cpu, mem_mb FROM node_raw
                         WHERE lab = :lab AND nid = :nid AND ts >= :s ORDER BY ts');
    $st->bindValue(':lab', (int) $lab, SQLITE3_INTEGER);
    $st->bindValue(':nid', $nid, SQLITE3_INTEGER);
    $st->bindValue(':s', time() - $RANGES[$range], SQLITE3_INTEGER);
    $rs = $st->execute();
    while ($rs && ($row = $rs->fetchArray(SQLITE3_ASSOC))) {
        $series[] = ['ts' => (int) $row['ts'],
                     'cpu' => round((float) $row['cpu'], 1),
                     'mem_mb' => (int) $row['mem_mb']];
    }
    $last = $tdb->querySingle('SELECT MAX(ts) FROM sys_raw');
    if ($last === null || (time() - (int) $last) > 60) $coll = 'down';
} catch (Exception $e) { out(['data' => $empty]); }

out(['data' => ['nid' => $nid, 'step' => 30, 'range' => $range,
                'collector' => $coll, 'series' => $series]]);
