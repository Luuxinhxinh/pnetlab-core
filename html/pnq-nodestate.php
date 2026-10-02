<?php
/**
 * pnq-nodestate.php — CLI-ONLY node-status producer for the lab-state push server
 * (pnetlab-labstated). Writes /dev/shm/pnet-nodestate/<lab_session>.json:
 *
 *   {"ts": 1719446400.1, "nodes": {"<nid>": <statuscode>, ...}}
 *
 * statuscode is the engine's own getNodeStatus() value (0 stopped, 1 stopped+locked,
 * 2 running, 3 running+locked, 6 hibernated, 7 frozen) — we reuse getNodesStatus()
 * verbatim rather than re-deriving it, so the push channel and the /api poll agree
 * byte-for-byte. The status checks (netstat/fsockopen/lockfile/docker) require no
 * root, so this runs as www-data (the labstated identity), exactly like the engine's
 * own nodestatus route.
 *
 * SECURITY: refuses to run under any web SAPI. It takes a bare lab_session on argv
 * and never authenticates, so it must never be web-reachable — the daemon spawns it
 * directly. (Node up/down is low-sensitivity, but CLI-gating removes the question.)
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("cli only\n");
}

$session = isset($argv[1]) ? $argv[1] : '';
if (!ctype_digit((string) $session)) {
    fwrite(STDERR, "usage: pnq-nodestate.php <lab_session>\n");
    exit(2);
}
$session = (int) $session;

// init.php loads config/db/engine functions via a CWD-relative path, like api.php.
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

$dir = '/dev/shm/pnet-nodestate';
@mkdir($dir, 0770, true);

try {
    // engine's own per-lab status map: { node_session_nid => statuscode }
    $nodes = getNodesStatus($session);
} catch (Exception $e) {
    // fail safe: leave any prior snapshot in place, daemon serves stale
    exit(0);
}
if (!is_array($nodes)) {
    $nodes = [];
}

$snap = ['ts' => round(microtime(true), 1), 'nodes' => $nodes];
$path = $dir . '/' . $session . '.json';
$tmp  = $path . '.' . getmypid() . '.tmp';
if (@file_put_contents($tmp, json_encode($snap)) !== false) {
    @chmod($tmp, 0640);
    @rename($tmp, $path);   // atomic publish
}
exit(0);
