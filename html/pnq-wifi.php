<?php
/**
 * pnq-wifi.php — Wi-Fi Painter data + position-sync endpoint.
 *
 * GET  -> {"nodes":[{id,name,role,ssid,status}]}
 *         The lab's Wireless AP / STA nodes. The painter reads live canvas geometry
 *         from the DOM and computes RSSI/SNR + association from a path-loss model.
 *
 * POST {"action":"sync","assoc":[{"sta":<id>,"ap":<id>|null}]}
 *         Make the REAL vwifi nodes follow the painter's association decision so they
 *         actually roam (not just the drawing). Realised without tuning vwifi's loss
 *         curve: each AP is parked at a unique far-apart vwifi coordinate, each STA is
 *         co-located with the AP it is associated to (distance 0 -> links) or parked
 *         far away if "searching" (distance huge -> disassociates). loss is enabled so
 *         distance governs reachability. Node -> vwifi CID is the same crc32(uuid)
 *         mapping device_wifiap/wifista.php inject as guest-cid.
 *
 * POST {"action":"reset"}
 *         Return every wireless node to the origin + loss off (the auto-placer default
 *         = one cell, everyone associated) — used when the painter closes.
 *
 * Auth + lab model mirror pnq-overlay.php (token cookie -> indentify -> Lab).
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');
function wifi_out($x, $code = 200) { http_response_code($code); echo json_encode($x); exit; }

/* Same vsock CID derivation as the device handlers' guestCid(). */
function wifi_cid($uuid) { return (crc32((string) $uuid) % 0x7fff0000) + 0x10000; }

/* A wireless cell's persisted WLAN list (broker wifi_cell_get) as an array of
 * ['ssid'=>..,'vlan'=>..] or null. Keyed by session+net_id, same as api.php. */
function cell_wlans($lab, $nid) {
    if (!function_exists('broker_call')) return null;
    $resp = @broker_call('wifi_cell_get', ['session' => (int) $lab->getSession(), 'net_id' => (int) $nid]);
    if (empty($resp['ok']) || empty($resp['out'][0])) return null;
    $cfg = json_decode($resp['out'][0], true);
    if (!is_array($cfg) || empty($cfg['wlans'])) return null;
    return $cfg['wlans'];
}

$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) wifi_out(['error' => 'not authenticated'], 401);

$session = isset($user['lab']) ? $user['lab'] : '';
if ($session === '') wifi_out(['error' => 'no lab session'], 400);

$labsession = getLabFromSession($session);
if (!$labsession) wifi_out(['error' => 'no lab session'], 400);

try {
    $lab = new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $session);
} catch (Exception $e) {
    wifi_out(['error' => 'cannot open lab'], 400);
}

/* Map of wireless nodes: id => [role, ssid, cid, name, status]. */
$wnodes = [];
$nets = $lab->getNetworks();
foreach ($lab->getNodes() as $node_id => $node) {
    $tpl = $node->getTemplate();
    // Wireless node types the painter models. wifiap/wifista/wificlient = the vwifi
    // stack; cvap/cwificlient = the Cisco airduct stack (closed cVAP + its client),
    // while cvapvw is the Cisco cVAP over the vwifi medium. Both share the SAME
    // log-distance RF model (see pnetlab-wifi-painter.js RF{} and airhandler.py), so
    // the coverage/path overlays and the airhandler Tier-1 loss agree by construction.
    $WLROLE = ['wifiap' => 'ap', 'wifista' => 'sta', 'wificlient' => 'sta',
               'cvap' => 'ap', 'cvapvw' => 'ap', 'cwificlient' => 'sta'];
    if (!isset($WLROLE[$tpl])) continue;
    // Which emulated medium carries this node's frames — the airduct daemon
    // (Cisco cvap/cwificlient), the Cisco cVAP-vwifi image (cvapvw), or the
    // vwifi-server (wifiap/wifista/wificlient).
    // Drives the painter's 802.11-capture control (each medium tees its own pcap).
    $WLMEDIUM = ['cvap' => 'airduct', 'cwificlient' => 'airduct',
                 'cvapvw' => 'vwifi', 'wifiap' => 'vwifi', 'wifista' => 'vwifi',
                 'wificlient' => 'vwifi'];
    $medium = isset($WLMEDIUM[$tpl]) ? $WLMEDIUM[$tpl] : 'airduct';

    $ssid = ''; $uuid = ''; $nleft = 0.0; $ntop = 0.0;
    try {
        // getOptions() carries the real per-node fields (uuid, Wifi_SSID, left, top).
        // The Node wrapper's getParams() only returns {id,template,type} and it has no
        // getLeft/getTop/getUuid, so reading those from getParams/getters gave EMPTY —
        // which silently broke the vwifi coord sync (uuid='' -> wifi_cid('') collapsed
        // every node onto one bogus CID; left/top=0 -> every node pushed to the origin,
        // so distance grading never happened) and left SSID badges blank. Use getOptions.
        $p = method_exists($node, 'getOptions') ? $node->getOptions() : [];
        if (isset($p['Wifi_SSID']) && $p['Wifi_SSID'] !== '') $ssid = (string) $p['Wifi_SSID'];
        if (isset($p['uuid'])) $uuid = (string) $p['uuid'];
        if (isset($p['left'])) $nleft = floatval($p['left']);
        if (isset($p['top'])) $ntop = floatval($p['top']);
    } catch (Exception $e) {}

    // A connected Wireless cell (network nature 'wireless') is the source of truth
    // for the SSID(s). VLAN-trunk multi-SSID: an AP cabled to a cell broadcasts the
    // cell's WHOLE WLAN list (hostapd multi-BSS), so collect every SSID. Falls back
    // to the cell NAME (single-SSID cell) then the per-node Wifi_SSID param. Mirrors
    // device_wifiap.php so the painter matches what the AP actually beacons.
    $ssids = [];
    try {
        foreach ($node->getInterfaces() as $iface) {
            $nid = method_exists($iface, 'getNetworkId') ? intval($iface->getNetworkId()) : 0;
            if ($nid > 0 && isset($nets[$nid]) && method_exists($nets[$nid], 'getNType')
                && $nets[$nid]->getNType() === 'wireless') {
                $wl = ($tpl === 'wifiap') ? cell_wlans($lab, $nid) : null;
                if ($wl) {
                    foreach ($wl as $w) { if (!empty($w['ssid'])) $ssids[] = (string) $w['ssid']; }
                } else if (method_exists($nets[$nid], 'getName')) {
                    $cn = preg_replace('/[^A-Za-z0-9_\- ]/', '', (string) $nets[$nid]->getName());
                    if ($cn !== '') $ssids[] = $cn;
                }
                break;
            }
        }
    } catch (Exception $e) {}
    if (!empty($ssids)) $ssid = $ssids[0];        // first SSID for back-compat fields
    if (empty($ssids)) $ssids = [$ssid];

    // GUI client (NetworkManager-driven): its SSID is whatever the user picks in
    // nm-applet, unknown to the engine. Empty SSID tells the painter to draw it as
    // a station associated to the NEAREST in-range AP (any SSID) — so its link to
    // the AP shows on the canvas.
    // GUI/airduct clients: SSID is unknown to the engine (nm-applet / WLC-driven) —
    // draw as a station associated to the NEAREST in-range AP (any SSID).
    if ($tpl === 'wificlient' || $tpl === 'cwificlient') { $ssid = ''; $ssids = ['']; }
    // Airduct cVAP beacons an SSID pushed by its WLC (not a node param/cell); use the
    // Wifi_SSID param if set, else a default so the association line has a label.
    if (($tpl === 'cvap' || $tpl === 'cvapvw') && $ssid === '') {
        $ssid = 'LAB-SSID'; $ssids = ['LAB-SSID'];
    }

    $wnodes[intval($node_id)] = [
        'role'   => $WLROLE[$tpl],
        'medium' => $medium,
        'ssid'   => $ssid,
        'ssids'  => array_values(array_unique($ssids)),
        'cid'    => wifi_cid($uuid),
        'name'   => $node->getName(),
        'status' => intval($node->getStatus()),
        'port'   => method_exists($node, 'getPort') ? intval($node->getPort()) : 0,
        // Runtime dir -> qemu console UNIX socket, the robust console path for the
        // truth read (the TCP telnet port only listens when the web-console bridge is up).
        'runpath' => method_exists($node, 'getRunningPath') ? (string) $node->getRunningPath() : '',
        // Canvas coords straight from the .unl (server-side, DOM-free) — the SAME
        // source airduct-pos-sync.py uses and immune to canvas virtualization (an
        // off-screen node has no DOM but always has left/top here). Drives the graded
        // vwifi RF mapping in action=sync. Read from getOptions (the Node wrapper has
        // no getLeft/getTop).
        'left'   => $nleft,
        'top'    => $ntop,
    ];
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    // Opt-in truth overlay (?truth=1): for each RUNNING node, read its real 802.11
    // association state over the serial console (broker wifi_truth -> pnet-wifi-truth.py)
    // and attach it as `real`. The painter uses this to flag model-vs-actual divergence
    // (a wrong-PSK STA that "looks" connected but never associated). Off the 3s status
    // poll by design (a console read is heavier and single-client), so the painter asks
    // for it on a slower cadence. Best-effort: a busy/soon console just omits `real`.
    $want_truth = isset($_GET['truth']) && $_GET['truth'] === '1'
        && function_exists('broker_call');
    $rows = [];
    foreach ($wnodes as $id => $w) {
        // left/top are the node's LAB (canvas-logical) coords. The painter uses them
        // as a DOM-free position fallback: under canvas virtualization
        // (onlyRenderVisibleElements) an off-screen node has NO DOM, so nodeCenter's
        // DOM query returns null and its coverage/association would vanish; with these
        // it converts lab->screen via the island's __pnqFlowXform instead.
        $row = ['id' => $id, 'name' => $w['name'], 'role' => $w['role'],
                'medium' => $w['medium'],
                'ssid' => $w['ssid'], 'ssids' => $w['ssids'], 'status' => $w['status'],
                'left' => $w['left'], 'top' => $w['top']];
        // Gate the read on the node actually running. getStatus() (status==2) probes
        // the TCP console port, which only listens when the web-console bridge is up —
        // so it can read 0 for a genuinely-running node whose bridge is down. The
        // console UNIX socket existing is a truer "node is up" signal and is exactly
        // what we read from, so accept either.
        $sock = ($w['runpath'] !== '') ? ($w['runpath'] . '/console.sock') : '';
        $running = ($w['status'] == 2 || $w['status'] == 3)
            || ($sock !== '' && preg_match('#^/opt/unetlab/tmp/\d+/\d+/console\.sock$#', $sock)
                && @file_exists($sock));
        if ($want_truth && $running) {
            // Prefer the console UNIX socket (robust); fall back to the TCP port.
            $targs = ['role' => $w['role']];
            if ($sock !== '' && preg_match('#^/opt/unetlab/tmp/\d+/\d+/console\.sock$#', $sock)) {
                $targs['sock'] = $sock;
            } else if ($w['port'] > 0) {
                $targs['port'] = $w['port'];
            } else {
                $targs = null;
            }
            if ($targs !== null) {
                $resp = @broker_call('wifi_truth', $targs);
                if (!empty($resp['ok']) && !empty($resp['out'][0])) {
                    $real = json_decode($resp['out'][0], true);
                    if (is_array($real) && empty($real['error'])) $row['real'] = $real;
                }
            }
        }
        $rows[] = $row;
    }
    wifi_out(['nodes' => $rows]);
}

if ($method !== 'POST') wifi_out(['error' => 'method'], 405);

$body = json_decode(file_get_contents('php://input'), true);
$action = is_array($body) ? ($body['action'] ?? '') : '';

if (!function_exists('broker_call')) wifi_out(['error' => 'broker unavailable'], 500);

function vw_set($cid, $x, $y) {
    return broker_call('vwifi_ctrl', ['cmd' => 'set', 'cid' => (string) $cid,
        'x' => (string) $x, 'y' => (string) $y, 'z' => '0']);
}

/* AIRDUCT TIER-1 OPT-IN — the painter's "Distance roaming (RF)" toggle is the front
 * door. Turning it ON POSTs action=sync (below), which drops the per-session marker
 * /opt/unetlab/tmp/<session>/airduct-rf; turning it OFF POSTs action=reset, which
 * removes it. airduct-pos-sync.py feeds canvas positions to the airhandler ONLY for
 * sessions carrying this marker, and the airhandler fails OPEN (delivers, no loss)
 * for every un-opted lab. Net: airduct distance-loss (Tier-1) applies ONLY to labs
 * where the user enabled RF in the painter — same signal that grades the overlays.
 * (vwifi nodes ignore the marker; their roaming is the vw_set path above.) */
function airduct_rf_marker($session) {
    $s = intval($session);
    return $s > 0 ? "/opt/unetlab/tmp/$s/airduct-rf" : '';
}

if ($action === 'reset') {
    foreach ($wnodes as $w) vw_set($w['cid'], 0, 0);
    broker_call('vwifi_ctrl', ['cmd' => 'loss', 'value' => 'no']);
    $m = airduct_rf_marker($session); if ($m) @unlink($m);   // airduct: opt OUT
    wifi_out(['ok' => true, 'reset' => count($wnodes)]);
}

/* Canvas px -> vwifi metres. Matches the Wi-Fi Painter's RF{ M_PER_PX } so the
 * medium's graded loss agrees with what the Painter draws (RSSI(d)=TX-(PL0+10*N*
 * log10(d_m)), d_m = px * M_PER_PX). Keep in sync with pnetlab-wifi-painter.js. */
const PNQ_WIFI_M_PER_PX = 0.07;

if ($action === 'sync') {
    // GRADED RF (replaces the old teleport hack that parked APs 200000 apart and STAs
    // at 0 or 1e9). Push each wireless node's REAL canvas position — scaled px->metres —
    // into vwifi via `vwifi_ctrl set cid x y z`, then enable loss. vwifi's native
    // log-distance path-loss then GRADES every link by actual node spacing: a near STA
    // hears the AP strongly, a far one weakly (or drops out of range), and the guest RX
    // RSSI (/proc/net/wireless, what the truth overlay reads) tracks it. Positions come
    // from the .unl (server-side), so this is correct for off-screen nodes too (canvas
    // virtualization removes their DOM but not their left/top).
    $applied = 0;
    foreach ($wnodes as $id => $w) {
        $x = (int) round($w['left'] * PNQ_WIFI_M_PER_PX);
        $y = (int) round($w['top'] * PNQ_WIFI_M_PER_PX);
        vw_set($w['cid'], $x, $y);
        $applied++;
    }
    broker_call('vwifi_ctrl', ['cmd' => 'loss', 'value' => 'yes']);
    $m = airduct_rf_marker($session);                        // airduct: opt IN
    if ($m && is_dir(dirname($m))) @touch($m);
    wifi_out(['ok' => true, 'nodes' => $applied]);
}

if ($action === 'capture') {
    // Arm/disarm the opt-in 802.11 pcap tee for THIS session, per medium. Delegates
    // to the broker wifi_capture verb (touches/removes the per-session marker; the
    // airhandler/vwifi-spy tee only writes while armed). op = start|stop|status.
    $op = (is_array($body) && isset($body['op'])) ? (string) $body['op'] : 'status';
    if (!in_array($op, ['start', 'stop', 'status'], true)) wifi_out(['error' => 'bad op'], 400);
    $medium = (is_array($body) && isset($body['medium']) && $body['medium'] === 'vwifi')
        ? 'vwifi' : 'airduct';
    $resp = @broker_call('wifi_capture',
        ['session' => (int) $session, 'action' => $op, 'medium' => $medium]);
    if (empty($resp['ok']) || empty($resp['out'][0])) wifi_out(['error' => 'capture failed'], 500);
    $st = json_decode($resp['out'][0], true);
    wifi_out(['ok' => true, 'medium' => $medium, 'capture' => is_array($st) ? $st : null]);
}

wifi_out(['error' => 'bad action'], 400);
