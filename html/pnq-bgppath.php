<?php
/**
 * pnq-bgppath.php — BGP best-path waterfall endpoint for the lab UI.
 *
 * Two stages, both driven by a read-only `show` on the node's serial console
 * (brokerd node_show verb -> pnet-showcmd.py -> pnet_bgpparse.py):
 *
 *   GET  ?list=1
 *        -> running nodes that have a telnet serial console (candidates to run
 *           `show ip bgp` on): {"nodes":[{node_id,name,port,host}]}
 *
 *   POST {"action":"table","node_id":N}              (Stage 1: the prefix picker)
 *        -> `show ip bgp` parsed into one summary row per prefix:
 *           {"node":{..},"picker":[{prefix,paths,best_next_hop,rib_failure,
 *            multipath}],"raw":".."}
 *
 *   POST {"action":"path","node_id":N,"prefix":"10.0.0.0/24"}   (Stage 2)
 *        -> `show ip bgp <prefix>` parsed into the candidate paths, plus the
 *           server-computed decision ladder:
 *           {"node":{..},"prefix":"..","detail":{..},"waterfall":[..],
 *            "decision":{winner,decided_at,rungs,multipath},"raw":".."}
 *
 * Auth + lab model mirror pnq-prototrace.php. Console access is read-only by
 * contract (brokerd validates the command against ^show ...$).
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');
function out($x, $code = 200) { http_response_code($code); echo json_encode($x); exit; }

$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) out(['error' => 'not authenticated'], 401);

$session = isset($user['lab']) ? $user['lab'] : '';
if ($session === '') out(['error' => 'no lab session'], 400);

function bp_open_lab($session, $tenant) {
    $labsession = getLabFromSession($session);
    if (!$labsession) throw new Exception('no lab session');
    return new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $session);
}

/* A node is a candidate if it is running and exposes a telnet serial console. */
function bp_console_nodes($lab) {
    $rows = [];
    foreach ($lab->getNodes() as $node_id => $node) {
        // getNodeStatus(): 0 stopped, 1 stopped+locked, 2 running, 3 running+locked
        // (the GUI padlock = locked, still console-reachable). Running = 2 or 3.
        $status = intval($node->getStatus());
        if ($status !== 2 && $status !== 3) continue;        // running only
        // serial CLI only — but IOL/dynamips report console='' when the lab XML
        // omits the `console` attr (device.php forces telnet for them only inside
        // the isset guard), so accept those by node type too.
        if ($node->getconsole() !== 'telnet'
            && !in_array($node->getNType(), ['iol', 'dynamips'], true)) continue;
        $port = intval($node->getPort());
        if ($port <= 0) continue;
        $host = $node->getHost();
        if (!filter_var($host, FILTER_VALIDATE_IP)) $host = '127.0.0.1';
        $rows[intval($node_id)] = [
            'node_id' => intval($node_id), 'name' => $node->getName(),
            'port' => $port, 'host' => $host,
            // 0 master, >0 satellite slot — node_show routes to the owning host.
            'host_id' => cluster_session_host($lab, $node_id),
        ];
    }
    return $rows;
}

$method = $_SERVER['REQUEST_METHOD'];
$body = null; $action = '';
if ($method !== 'GET') {
    $body = json_decode(file_get_contents('php://input'), true);
    $action = is_array($body) && isset($body['action']) ? $body['action'] : '';
}

try {
    $nodes = bp_console_nodes(bp_open_lab($session, $tenant));
} catch (Exception $e) {
    out(['error' => 'lab open failed: ' . $e->getMessage()], 400);
}

/* ---- GET ?list=1: enumerate candidate nodes ------------------------------ */
if ($method === 'GET' && isset($_GET['list'])) {
    out(['nodes' => array_values($nodes)]);
}

/* All other actions target one node. */
$node_id = null;
if (isset($body['node_id'])) $node_id = intval($body['node_id']);
if ($node_id === null || !isset($nodes[$node_id])) {
    out(['error' => 'unknown or non-running node'], 400);
}
$n = $nodes[$node_id];

if ($action !== 'table' && $action !== 'path') out(['error' => 'bad action'], 400);

/* Build the (read-only) show command for this action. */
if ($action === 'table') {
    $cmd = 'show ip bgp';
    $mode = 'bgp-table';
} else {
    $prefix = isset($body['prefix']) ? trim((string) $body['prefix']) : '';
    if (!preg_match('#^\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?$#', $prefix)) {
        out(['error' => 'bad prefix'], 400);
    }
    $cmd = 'show ip bgp ' . $prefix;
    $mode = 'bgp-detail';
}

$nhid = isset($n['host_id']) ? (int) $n['host_id'] : 0;
$resp = cluster_broker($nhid, 'node_show', [
    'host' => $nhid > 0 ? '127.0.0.1' : $n['host'], 'port' => $n['port'],
    'cmd' => $cmd, 'mode' => $mode,
], 75);
if (!$resp['ok']) out(['error' => 'broker: ' . $resp['err']], 502);

$json = json_decode(implode("\n", $resp['out']), true);
if (!is_array($json)) out(['error' => 'console read returned no parseable output'], 502);
if (isset($json['error']) && !isset($json['raw'])) {
    out(['error' => $json['error'], 'node' => $n], 502);
}

if ($action === 'table') {
    out(['node' => $n, 'picker' => isset($json['picker']) ? $json['picker'] : [],
         'raw' => isset($json['raw']) ? $json['raw'] : '']);
}
out(['node' => $n, 'prefix' => $prefix,
     'detail' => isset($json['detail']) ? $json['detail'] : null,
     'waterfall' => isset($json['waterfall']) ? $json['waterfall'] : [],
     'decision' => isset($json['decision']) ? $json['decision'] : null,
     'raw' => isset($json['raw']) ? $json['raw'] : '']);
