<?php
/**
 * pnq-nodestats.php — per-node live CPU% + RAM (MB) for the current lab session,
 * for the Nodes modal usage columns. Returns {"data":{"<nid>":{"cpu":N,"mem":N}}}.
 *
 * Mapping (no per-node pid file needed):
 *   • node_sessions gives each node's nid + type + workspace (BASE_TMP/<lab>/<sid>).
 *   • QEMU / IOL node processes chdir into their workspace, so workspace -> pid is
 *     found from /proc/<pid>/cwd (broker 'nodestats' verb -> pnq-nodestats.sh).
 *   • Docker: `docker stats` on container "docker<sid>".
 *   • CPU% from `top -b -n2` (2nd sample = current), RAM (RSS) from `ps`.
 * Auth mirrors import/api.php (engine token + the user's lab session). Fails safe:
 * any error yields {cpu:0,mem:0}, never breaks the modal.
 *
 * B4: sampling is cached host-globally in /dev/shm (3s TTL, flock'd refresh)
 * so N polling clients cost ONE top/ps/docker sample per window, not N.
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');
function out($x) { echo json_encode($x); exit; }
function mb_from($v, $u) {
    $v = (float) $v; $u = strtoupper(substr(trim($u), 0, 1));
    if ($u === 'G') return (int) round($v * 1024);
    if ($u === 'K') return (int) round($v / 1024);
    return (int) round($v); // MiB/MB/B-ish
}

$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) { http_response_code(401); out(['error' => 'not authenticated']); }

$lab = isset($user['lab']) ? $user['lab'] : '';
if ($lab === '') out(['data' => new stdClass()]);

try {
    $db = checkDatabase();
    $st = $db->prepare("SELECT node_session_nid, node_session_id, node_session_type, node_session_workspace FROM node_sessions WHERE node_session_lab = :lab");
    $st->execute(['lab' => $lab]);
    $nodes = $st->fetchAll(PDO::FETCH_ASSOC);
} catch (Exception $e) { out(['data' => new stdClass()]); }

/* ---- B4 shared snapshot: the raw sampling (broker cwd walk, top, ps,
   docker stats) is host-global, not per-user, yet every polling client used
   to fork the whole set per request (top alone is ~1s of wall time). Cache
   one snapshot in /dev/shm with a short TTL; concurrent pollers ride it,
   exactly one (flock winner) refreshes per window. Per-lab filtering below
   stays per-request. ---- */
function pnq_collect_snapshot() {
    $snap = ['ts' => time(), 'cwd' => [], 'cpu' => [], 'rss' => [], 'dock' => []];

    /* workspace -> [pids] (QEMU/IOL: the node process AND its tiny wrapper/sh/nc
       all share the node workspace cwd; the consumer picks the real one) */
    broker_exec('nodestats', [], $o, $rc);
    foreach ($o as $line) {
        $p = explode(' ', $line, 2);
        if (count($p) === 2) $snap['cwd'][rtrim($p[1], '/')][] = (int) $p[0];
    }

    /* pid -> cpu% (2nd top sample) */
    $t = [];
    @exec('top -b -n2 -d0.5 -w512 2>/dev/null', $t);
    foreach ($t as $row) {
        $row = preg_replace('/^\s+/', '', $row);
        $c = preg_split('/\s+/', $row);
        if (isset($c[8]) && is_numeric($c[0]) && is_numeric(str_replace(',', '.', $c[8]))) {
            $snap['cpu'][(int) $c[0]] = (int) round((float) str_replace(',', '.', $c[8]));  // last sample wins
        }
    }

    /* pid -> RSS MB */
    $ps = [];
    @exec('ps -eo pid=,rss= 2>/dev/null', $ps);
    foreach ($ps as $row) {
        $c = preg_split('/\s+/', trim($row));
        if (count($c) >= 2) $snap['rss'][(int) $c[0]] = (int) round(((int) $c[1]) / 1024);
    }

    /* docker container -> cpu/mem — broker docker_stats verb (Stage 5); the
       '{{.Name}};{{.CPUPerc}};{{.MemUsage}}' format is fixed broker-side */
    $ds = []; $dsrc = 0;
    broker_exec('docker_stats', [], $ds, $dsrc);
    foreach ($ds as $row) {
        $c = explode(';', $row);
        if (count($c) >= 3) {
            $cp = (int) round((float) str_replace('%', '', $c[1]));
            $mem = preg_match('/([\d.]+)\s*([KMG]i?B)/i', $c[2], $m) ? mb_from($m[1], $m[2]) : 0;
            $snap['dock'][trim($c[0])] = ['cpu' => $cp, 'mem' => $mem];
        }
    }
    return $snap;
}

$PNQ_CACHE = '/dev/shm/pnq-nodestats.cache.json';
$PNQ_TTL = 3;

$snap = null;
$raw = @file_get_contents($PNQ_CACHE);
if ($raw !== false) {
    $j = json_decode($raw, true);
    if (is_array($j) && isset($j['ts'])) $snap = $j;
}
if ($snap === null || (time() - $snap['ts']) >= $PNQ_TTL) {
    $fh = @fopen($PNQ_CACHE . '.lock', 'c');
    if ($fh && flock($fh, LOCK_EX | LOCK_NB)) {
        // we won the refresh window
        $snap = pnq_collect_snapshot();
        @file_put_contents($PNQ_CACHE . '.tmp', json_encode($snap));
        @rename($PNQ_CACHE . '.tmp', $PNQ_CACHE);
        @chmod($PNQ_CACHE, 0644);
        flock($fh, LOCK_UN);
    } elseif ($snap === null && $fh) {
        // first request ever while someone else collects: wait for them, reuse
        flock($fh, LOCK_EX);
        flock($fh, LOCK_UN);
        $raw = @file_get_contents($PNQ_CACHE);
        $j = $raw !== false ? json_decode($raw, true) : null;
        $snap = (is_array($j) && isset($j['ts'])) ? $j : pnq_collect_snapshot();
    } elseif ($snap === null) {
        $snap = pnq_collect_snapshot();  // /dev/shm unavailable — degrade to inline
    }
    // else: stale cache + collector busy -> serve stale (stale-while-revalidate)
    if ($fh) fclose($fh);
}

$cwdmap = $snap['cwd'];
$cpu = $snap['cpu'];
$rss = $snap['rss'];
$dock = $snap['dock'];

$data = [];
foreach ($nodes as $n) {
    $nid = $n['node_session_nid'];
    $type = $n['node_session_type'];
    $ws = rtrim($n['node_session_workspace'], '/');
    $sid = $n['node_session_id'];

    if ($type === 'docker') {
        $key = 'docker' . $sid;
        $data[$nid] = isset($dock[$key]) ? $dock[$key] : ['cpu' => 0, 'mem' => 0];
        continue;
    }
    // QEMU / IOL: exact workspace match, else the pids whose cwd ends with /<sid>
    $pids = isset($cwdmap[$ws]) ? $cwdmap[$ws] : [];
    if (!$pids) {
        foreach ($cwdmap as $path => $plist) {
            if (substr($path, -((int) strlen($sid) + 1)) === '/' . $sid) { $pids = $plist; break; }
        }
    }
    // Several processes share the workspace cwd (the node's qemu-system/iol process +
    // its wrapper/sh/nc helpers). The real node process dominates RAM, so pick the
    // pid with the largest RSS rather than an arbitrary one (was reporting ~0%/1 MB).
    $pid = 0; $bestRss = -1;
    foreach ($pids as $pp) {
        $r = isset($rss[$pp]) ? $rss[$pp] : 0;
        if ($r > $bestRss) { $bestRss = $r; $pid = $pp; }
    }
    $data[$nid] = [
        'cpu' => ($pid && isset($cpu[$pid])) ? $cpu[$pid] : 0,
        'mem' => ($pid && isset($rss[$pid])) ? $rss[$pid] : 0,
    ];
}

out(['data' => $data]);
