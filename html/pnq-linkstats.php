<?php
/**
 * pnq-linkstats.php — per-tap sysfs rx_packets totals for the current lab
 * session. Used by pnetlab-egress-glow.js to detect node egress traffic.
 *
 * Returns {"ts":<unix>,"taps":{"vunl<sid>_<n>":<rx_packets>, …},
 *          "txs":{"vunl<sid>_<n>":<tx_packets>, …},
 *          "rxb":{"vunl<sid>_<n>":<rx_bytes>, …},
 *          "txb":{"vunl<sid>_<n>":<tx_bytes>, …},
 *          "meta":{"vunl<sid>_<n>":{"node_id":N,"network_id":M,
 *                                   "ntype":"iol","if_name":"e0/1"}, …}}.
 * tap rx = node egress (drives the glow); tap tx = node ingress (informational
 * only — a shut port's tap still receives, so ingress can't drive UI state).
 * rxb/txb are the BYTE counters for the same taps — the island's per-link
 * utilization labels diff them per poll to compute a throughput (bps). Additive
 * keys: the packet-counter consumers (egress glow) ignore them.
 *
 * "meta" lets pnetlab-egress-glow.js map a tap to its jsPlumb connector +
 * interface label without depending on window.nodes carrying per-interface
 * data (it doesn't reliably). Resolved server-side from the lab XML, exactly
 * like pnq-linkwatch.php.
 *
 * Auth mirrors pnq-nodestats.php (engine token + user's lab session).
 * Only taps belonging to the caller's session IDs are returned (sysfs jail
 * by prefix). www-data can read /sys/class/net/.../statistics/rx_packets
 * directly without broker involvement.
 *
 * Satellite-hosted nodes' taps live on the satellite: their rx/tx are fetched
 * via the satd-forwarded `linkstats` verb (cluster_broker) and merged in, so the
 * egress glow covers satellite-placed nodes too.
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
if ($lab === '') out(['ts' => time(), 'taps' => new stdClass()]);

// Resolve session IDs for this lab session (one per running node).
try {
    $db = checkDatabase();
    $st = $db->prepare(
        'SELECT node_session_id FROM node_sessions WHERE node_session_lab = :lab'
    );
    $st->execute(['lab' => $lab]);
    $sids = $st->fetchAll(PDO::FETCH_COLUMN);
} catch (Exception $e) {
    out(['ts' => time(), 'taps' => new stdClass()]);
}

if (empty($sids)) out(['ts' => time(), 'taps' => new stdClass()]);

// Build a set of allowed sid prefixes: vunl<sid>_
$sidPrefixes = [];
foreach ($sids as $sid) {
    $sidPrefixes['vunl' . (int) $sid . '_'] = true;
}

$taps = [];
$txs  = [];
$rxb  = [];
$txb  = [];
$netDir = '/sys/class/net';
$entries = @scandir($netDir);
if ($entries) {
    foreach ($entries as $iface) {
        if ($iface === '.' || $iface === '..') continue;
        // Check prefix match against any of this session's sids.
        $matched = false;
        foreach ($sidPrefixes as $pfx => $_) {
            if (strncmp($iface, $pfx, strlen($pfx)) === 0) { $matched = true; break; }
        }
        if (!$matched) continue;
        $rxPath = $netDir . '/' . $iface . '/statistics/rx_packets';
        $val = @file_get_contents($rxPath);
        if ($val !== false) {
            $taps[$iface] = (int) trim($val);
            // tap tx = packets TOWARD the node (its ingress). NOTE: the glow
            // client no longer uses this — a shut port's tap still receives
            // the peer's frames (no carrier propagation), so ingress can't
            // distinguish shut from quiet; kept for tooling/debugging.
            $tv = @file_get_contents($netDir . '/' . $iface . '/statistics/tx_packets');
            if ($tv !== false) {
                $txs[$iface] = (int) trim($tv);
            }
            // Byte counters for the per-link utilization labels: tap rx_bytes =
            // node egress bytes, tap tx_bytes = node ingress bytes (same
            // orientation as the packet counters above).
            $bv = @file_get_contents($netDir . '/' . $iface . '/statistics/rx_bytes');
            if ($bv !== false) {
                $rxb[$iface] = (int) trim($bv);
            }
            $bv = @file_get_contents($netDir . '/' . $iface . '/statistics/tx_bytes');
            if ($bv !== false) {
                $txb[$iface] = (int) trim($bv);
            }
        }
    }
}

// Resolve tap -> {node_id, network_id} from the lab XML so the client can map
// each tap to its connector/label without window.nodes. Best-effort: any
// failure just omits meta (glow degrades to no-op rather than erroring).
// Satellite-hosted nodes' taps live on the satellite, so the local sysfs scan
// above can't see them — enumerate each satellite's taps from the XML and fetch
// their rx/tx via the satd-forwarded `linkstats` verb, then merge.
$meta = [];
try {
    $labsession = getLabFromSession($lab);
    if ($labsession) {
        $labObj = new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $lab);
        $remote = [];   // host_id => [tap, ...]   (satellite taps to fetch)
        foreach ($labObj->getNodes() as $node_id => $node) {
            $hid = (int) cluster_session_host($labObj, $node_id);
            if ($hid <= 0) continue;
            $ns = $node->getSession();
            foreach ($node->getEthernets() as $iface_id => $iface) {
                if ((int) $iface->getNetworkId() <= 0) continue;
                $remote[$hid][] = 'vunl' . $ns . '_' . $iface_id;
            }
        }
        foreach ($remote as $hid => $rtaps) {
            $r = cluster_broker($hid, 'linkstats',
                               ['interfaces' => array_values(array_unique($rtaps))], 20);
            if (!$r['ok']) continue;
            $j = json_decode(implode("\n", $r['out']), true);
            if (!is_array($j)) continue;
            foreach ($j as $tap => $st) {
                if (isset($st['rx'])) $taps[$tap] = (int) $st['rx'];
                if (isset($st['tx'])) $txs[$tap]  = (int) $st['tx'];
                // Byte counters (additive — an older satellite brokerd that
                // doesn't send them just leaves this tap without a util label).
                if (isset($st['rxb'])) $rxb[$tap] = (int) $st['rxb'];
                if (isset($st['txb'])) $txb[$tap] = (int) $st['txb'];
            }
        }
        foreach ($labObj->getNodes() as $node_id => $node) {
            $ns = $node->getSession();
            $ntype = (string) $node->getNType();            // iol|qemu|dynamips|docker|vpcs
            foreach ($node->getEthernets() as $iface_id => $iface) {
                $tap = 'vunl' . $ns . '_' . $iface_id;
                if (!isset($taps[$tap])) continue;          // only live taps we report
                $meta[$tap] = [
                    'node_id'    => (int) $node_id,
                    'network_id' => (int) $iface->getNetworkId(),
                    'ntype'      => $ntype,
                    // Template drives the client's per-type quiet-retention:
                    // vios ROUTERS keepalive every 10 s (fast down-detect),
                    // L2 switchports only CDP every 60 s.
                    'tpl'        => (string) $node->getTemplate(),
                    // Interface name disambiguates PARALLEL p2p links between
                    // the same node pair (e.g. an LACP bundle): the client
                    // matches it against the connection's label overlay text.
                    'if_name'    => (string) $iface->getName(),
                ];
            }
        }
    }
} catch (Exception $e) { /* meta is optional */ }

out([
    'ts'   => time(),
    'taps' => empty($taps) ? new stdClass() : $taps,
    'txs'  => empty($txs)  ? new stdClass() : $txs,
    'rxb'  => empty($rxb)  ? new stdClass() : $rxb,
    'txb'  => empty($txb)  ? new stdClass() : $txb,
    'meta' => empty($meta) ? new stdClass() : $meta,
]);
