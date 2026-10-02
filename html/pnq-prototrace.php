<?php
/**
 * pnq-prototrace.php — Protocol Inspector endpoint for the lab UI.
 *
 * Per-link packet ladder for ONE chosen protocol (v1: BGP). Frontend
 * (themes/default/js/pnetlab-protocol-inspector.js) talks only to this:
 *   GET  ?list=1   -> the inspectable point-to-point links (so a right-clicked
 *                     connector can be mapped to a network_id, no Watcher needed):
 *                     {"links":[{network_id,a_node_id,b_node_id,a,b,a_iface,b_iface}]}
 *   POST {"action":"start","network_id":N,"proto":"bgp"}
 *        -> resolves that link to its vunl tap (reusing the Network Watcher's
 *           p2p up-tap selection), asks brokerd to spawn the tracer
 *           (pnet-prototrace-<tenant>_<session>_n<N> transient unit), returns
 *           {"status":"started","watch_id","a","b","proto"}
 *   POST {"action":"stop","network_id":N}            -> {"status":"stopped"}
 *   GET  ?network_id=N&since=S -> touches the heartbeat and returns the decoded
 *        events with seq >= S:
 *           {"active":bool,"a":..,"b":..,"proto":..,"next_seq":..,"dropped":..,
 *            "events":[{seq,ts,dir,proto,kind,label,detail,severity,fields}]}
 *
 * "dir":"ab" = the lower-node end (A) -> the other end (B). Auth + link model
 * mirror pnq-linkwatch.php; only a point-to-point link is inspectable (a
 * multi-access net has no unambiguous two-party ladder).
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

define('PT_DIR', '/dev/shm/pnet-trace');
define('PT_PROTOS', 'bgp,ospf,eigrp,isis,stp,gre');   // supported protocols (dropdown order)

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

// A tap is watchable only if it EXISTS and is admin-UP (IFF_UP=0x1) — a
// container node's host veth can exist but stay DOWN (carries no frames).
function _pt_tap_live($tap) {
    $p = '/sys/class/net/' . $tap;
    if (!file_exists($p)) return false;
    $flags = @file_get_contents($p . '/flags');
    return $flags !== false && (hexdec(trim($flags)) & 1);
}

/* Resolve the lab's point-to-point links -> [{network_id, members[2]}].
   members sorted by node_id (A = lower). Each member: tap,node_id,name,iface,live. */
function pt_p2p_links($lab) {
    $nets = [];
    foreach ($lab->getNodes() as $node_id => $node) {
        $ns = $node->getSession();
        $hid = (int) cluster_session_host($lab, $node_id);
        foreach ($node->getEthernets() as $iface_id => $iface) {
            $net = intval($iface->getNetworkId());
            if ($net <= 0) continue;
            $tap = 'vunl' . $ns . '_' . $iface_id;
            $nets[$net][] = [
                'tap' => $tap, 'node_id' => intval($node_id),
                'name' => $node->getName(), 'iface' => $iface->getName(),
                'host_id' => $hid,                   // 0 master, >0 satellite slot
                'live' => _pt_tap_live($tap),        // local probe; re-checked per host at start
            ];
        }
    }
    $links = [];
    foreach ($nets as $net_id => $members) {
        if (count($members) !== 2) continue;           // p2p only
        usort($members, function ($a, $b) { return $a['node_id'] - $b['node_id']; });
        $links[$net_id] = $members;
    }
    return $links;
}

function pt_open_lab($session, $tenant) {
    $labsession = getLabFromSession($session);
    if (!$labsession) throw new Exception('no lab session');
    return new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $session);
}

$method = $_SERVER['REQUEST_METHOD'];
$body = null; $action = '';
if ($method !== 'GET') {
    $body = json_decode(file_get_contents('php://input'), true);
    $action = is_array($body) && isset($body['action']) ? $body['action'] : '';
}

/* ---- GET ?list=1: enumerate inspectable links --------------------------- */
if ($method === 'GET' && isset($_GET['list'])) {
    try {
        $links = pt_p2p_links(pt_open_lab($session, $tenant));
    } catch (Exception $e) {
        out(['error' => 'lab open failed: ' . $e->getMessage()], 400);
    }
    $rows = [];
    foreach ($links as $net_id => $m) {
        $rows[] = ['network_id' => $net_id,
                   'a_node_id' => $m[0]['node_id'], 'b_node_id' => $m[1]['node_id'],
                   'a' => $m[0]['name'], 'b' => $m[1]['name'],
                   'a_iface' => $m[0]['iface'], 'b_iface' => $m[1]['iface']];
    }
    out(['links' => $rows, 'protos' => explode(',', PT_PROTOS)]);
}

// All other actions are scoped to one link.
$net_req = null;
if ($method === 'GET') {
    if (isset($_GET['network_id'])) $net_req = intval($_GET['network_id']);
} elseif (isset($body['network_id'])) {
    $net_req = intval($body['network_id']);
}
if ($net_req === null || $net_req <= 0) out(['error' => 'bad network_id'], 400);

$watch_id  = intval($tenant) . '_' . intval($session) . '_n' . $net_req;
$snap_file = PT_DIR . '/' . $watch_id . '.json';
$hb_file   = PT_DIR . '/' . $watch_id . '.hb';
// host the tracer runs on (0 master, >0 satellite slot), written at start so
// GET/stop reach it. The selected link end may live on a satellite.
$host_file = PT_DIR . '/' . $watch_id . '.host';
function pt_trace_host($host_file) {
    $h = @file_get_contents($host_file);
    return ($h !== false && is_numeric(trim($h))) ? (int) trim($h) : 0;
}

/* ---- GET: poll events since <seq> --------------------------------------- */
if ($method === 'GET') {
    $thost = pt_trace_host($host_file);
    if ($thost > 0) {
        // satd refreshes the satellite heartbeat and returns its snapshot
        $r = cluster_broker($thost, 'prototrace_snapshot', ['watch_id' => $watch_id], 20);
        $snap = $r['ok'] ? json_decode(implode("\n", $r['out']), true) : null;
    } else {
        @touch($hb_file);                   // keep the local tracer alive
        $snap = json_decode(@file_get_contents($snap_file), true);
    }
    $since = isset($_GET['since']) ? intval($_GET['since']) : 0;
    $age = ($snap && isset($snap['ts'])) ? (microtime(true) - $snap['ts']) : 1e9;
    if (!$snap || $age > 10) out(['active' => false]);
    $events = [];
    if (isset($snap['events']) && is_array($snap['events'])) {
        foreach ($snap['events'] as $e) {
            if (isset($e['seq']) && $e['seq'] >= $since) $events[] = $e;
        }
    }
    out(['active' => true,
         'a' => isset($snap['a']) ? $snap['a'] : 'A',
         'b' => isset($snap['b']) ? $snap['b'] : 'B',
         'proto' => isset($snap['proto']) ? $snap['proto'] : '',
         'next_seq' => isset($snap['next_seq']) ? $snap['next_seq'] : 0,
         'dropped' => isset($snap['dropped']) ? $snap['dropped'] : 0,
         /* derived FSM (Convergence Timeline) — session-wide, not since-filtered;
            absent for protocols with no state machine (STP/GRE). */
         'fsm' => isset($snap['fsm']) ? $snap['fsm'] : null,
         'events' => $events]);
}

/* ---- POST stop ----------------------------------------------------------- */
if ($action === 'stop') {
    cluster_broker(pt_trace_host($host_file), 'prototrace_stop', ['watch_id' => $watch_id]);
    @unlink($host_file);
    out(['status' => 'stopped']);
}
if ($action !== 'start') out(['error' => 'bad action'], 400);

$proto = isset($body['proto']) ? (string) $body['proto'] : 'bgp';
if (!in_array($proto, explode(',', PT_PROTOS), true)) {
    out(['error' => 'unsupported proto'], 400);
}

/* ---- POST start: resolve the chosen link -> tap (p2p up-tap selection) --- */
try {
    $links = pt_p2p_links(pt_open_lab($session, $tenant));
} catch (Exception $e) {
    out(['error' => 'lab open failed: ' . $e->getMessage()], 400);
}
if (!isset($links[$net_req])) {
    out(['error' => 'not_p2p', 'message' =>
        'the Protocol Inspector works on a point-to-point link between two '
        . 'running nodes'], 400);
}
$members = $links[$net_req];                 // already sorted, A = lower node_id
// Re-check each end's liveness on its OWNING host (a satellite end's tap is not
// visible in the master's /sys/class/net) — reuses the linkwatch_probe verb.
foreach ($members as $i => $mm) {
    $h = (int) $mm['host_id'];
    if ($h > 0) {
        $r = cluster_broker($h, 'linkwatch_probe', ['interfaces' => [$mm['tap']]], 15);
        $members[$i]['live'] = $r['ok'] && in_array($mm['tap'], $r['out'], true);
    } else {
        $members[$i]['live'] = _pt_tap_live($mm['tap']);
    }
}
// Watch A's tap if it's up, else B's and flip the direction. The tracer runs on
// whichever host owns the chosen tap (the console/tap is local there).
$flip = false; $thost = 0;
if ($members[0]['live']) {
    $tap = $members[0]['tap']; $thost = (int) $members[0]['host_id'];
} elseif ($members[1]['live']) {
    $tap = $members[1]['tap']; $flip = true; $thost = (int) $members[1]['host_id'];
} else {
    out(['error' => 'no_live_tap', 'message' =>
        'neither end of this link has a running interface'], 400);
}

$bargs = ['watch_id' => $watch_id, 'interface' => $tap, 'flip' => $flip,
          'proto' => $proto, 'a' => $members[0]['name'], 'b' => $members[1]['name']];
if (isset($body['buffer_max']) && is_numeric($body['buffer_max'])) {
    $bargs['buffer_max'] = intval($body['buffer_max']);
}
$resp = cluster_broker($thost, 'prototrace_start', $bargs, 30);
if (!$resp['ok']) out(['error' => 'broker: ' . $resp['err']], 502);

@file_put_contents($host_file, (string) $thost);
@touch($hb_file);
out(['status' => 'started', 'watch_id' => $watch_id, 'proto' => $proto,
     'a' => $members[0]['name'], 'b' => $members[1]['name'],
     'flip' => $flip, 'expr' => $resp['out']]);
