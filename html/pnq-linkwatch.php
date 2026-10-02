<?php
/**
 * pnq-linkwatch.php — Network Watcher endpoint for the lab UI.
 *
 * Frontend (themes/default/js/pnetlab-network-watcher.js) talks only to this:
 *   POST {"action":"start","filters":[{id,preset,src_ip?,dst_ip?,port?,proto?}]}
 *        -> resolves the lab's links to vunl taps, asks brokerd to spawn the
 *           watcher (pnet-linkwatch-<tenant>_<session> transient unit), returns
 *           {"status":"started","watch_id","links":[...],"exprs":[...]}
 *   POST {"action":"stop"}  -> brokerd linkwatch_stop -> {"status":"stopped"}
 *   GET  -> touches the watcher heartbeat and returns
 *           {"active":bool,"snapshot":{taps:{vunlX_Y:{f0:{out:{pps,..},in:{..}}}}},
 *            "links":[...]}   (links sidecar lets a reloaded page reattach)
 *
 * Link model: every ethernet interface with network_id > 0 and a live tap
 * (/sys/class/net/vunl<node_session>_<iface_id>). Point-to-point networks
 * (exactly 2 members) are watched on ONE tap — the lower node_id side is
 * "src", so snapshot "out" = src->dst. Multi-access networks watch every
 * member tap (dst = the network). Serial links are out of scope (non-EN10MB).
 *
 * Filter colors stay in the browser (sessionStorage); only structured match
 * fields travel here, and the BPF text itself is built inside brokerd.
 * Auth mirrors pnq-nodestats.php. Caps: 6 filters; links effectively unlimited
 * (LW_MAX_IF is just a sanity bound against a malformed request).
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

define('LW_DIR', '/dev/shm/pnet-watch');
define('LW_MAX_IF', 1024);
define('LW_MAX_FILTERS', 6);

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
$watch_id = intval($tenant) . '_' . intval($session);
$snap_file  = LW_DIR . '/' . $watch_id . '.json';
$hb_file    = LW_DIR . '/' . $watch_id . '.hb';
$links_file = LW_DIR . '/' . $watch_id . '.links.json';
// hosts running a piece of this watch (0 master, >0 satellite slot); written at
// start so GET/stop know which hosts to poll/stop. Missing => local-only.
$hosts_file = LW_DIR . '/' . $watch_id . '.hosts.json';
// raw filter spec ($clean) persisted at start so the GET self-heal can re-arm
// (conf.json only has the COMPILED bpf, which we can't feed back to brokerd).
$filt_file    = LW_DIR . '/' . $watch_id . '.rawfilters.json';
// throttle marker for the GET self-heal re-resolve.
$recheck_file = LW_DIR . '/' . $watch_id . '.recheck';

/* The hosts that carry part of this watch (defaults to master-only). */
function lw_watch_hosts($hosts_file) {
    $h = json_decode(@file_get_contents($hosts_file), true);
    return (is_array($h) && !empty($h)) ? array_map('intval', $h) : [0];
}

/* Resolve the lab's links -> watchable vunl taps (live, admin-UP). Shared by the
 * start action and the GET self-heal. Returns
 * ['links'=>[...], 'taps'=>[unique], 'tap_host'=>[tap=>host_id]]. */
function lw_resolve($lab) {
    // Pass 1: collect every candidate member with its OWNING host (0 master, >0 sat).
    $pending = []; $remote_taps = [];
    foreach ($lab->getNodes() as $node_id => $node) {
        $ns = $node->getSession();
        $hid = (int) cluster_session_host($lab, $node_id);
        foreach ($node->getEthernets() as $iface_id => $iface) {
            $net = intval($iface->getNetworkId());
            if ($net <= 0) continue;
            $tap = 'vunl' . $ns . '_' . $iface_id;
            $pending[] = ['net' => $net, 'tap' => $tap, 'node_id' => intval($node_id),
                          'node_name' => $node->getName(), 'iface_name' => $iface->getName(),
                          'host_id' => $hid];
            if ($hid > 0) $remote_taps[$hid][] = $tap;
        }
    }
    // Batch-probe satellite tap liveness (one cluster_call per satellite).
    $live_remote = [];
    foreach ($remote_taps as $hid => $rt) {
        $r = cluster_broker($hid, 'linkwatch_probe',
                            ['interfaces' => array_values(array_unique($rt))], 20);
        if ($r['ok']) foreach ($r['out'] as $t) $live_remote[$t] = true;
    }
    // Pass 2: assemble $nets with host-correct liveness.
    $nets = [];
    foreach ($pending as $m) {
        $m['live'] = $m['host_id'] > 0 ? !empty($live_remote[$m['tap']])
                                       : _lw_tap_live($m['tap']);
        $net = $m['net']; unset($m['net']);
        $nets[$net][] = $m;
    }
    $net_names = [];
    try {
        foreach ($lab->getNetworks() as $nid => $n) $net_names[intval($nid)] = $n->getName();
    } catch (Exception $e) { /* labels only */ }
    $links = []; $taps = []; $tap_host = [];
    foreach ($nets as $net_id => $members) {
        $live = array_values(array_filter($members, function ($m) { return $m['live']; }));
        if (count($live) === 0) continue;
        if (count($members) === 2 && count($live) >= 1) {
            // p2p: ONE tap watches the wire; "out" = src->dst with src = lower node_id
            usort($members, function ($a, $b) { return $a['node_id'] - $b['node_id']; });
            $m = $members[0]['live'] ? $members[0] : $members[1];
            $flip = !$members[0]['live'];      // watching the higher side: out=dst->src
            $links[] = [
                'key' => 'n' . $net_id, 'tap' => $m['tap'], 'network_id' => $net_id,
                'flip' => $flip,
                'src' => ['node_id' => $members[0]['node_id'], 'name' => $members[0]['node_name'],
                          'iface' => $members[0]['iface_name']],
                'dst' => ['node_id' => $members[1]['node_id'], 'name' => $members[1]['node_name'],
                          'iface' => $members[1]['iface_name']],
            ];
            $taps[] = $m['tap']; $tap_host[$m['tap']] = $m['host_id'];
        } else {
            // multi-access: each member's tap; link = node <-> network blob
            foreach ($live as $m) {
                $links[] = [
                    'key' => 'n' . $net_id . '_' . $m['node_id'], 'tap' => $m['tap'],
                    'network_id' => $net_id, 'flip' => false,
                    'src' => ['node_id' => $m['node_id'], 'name' => $m['node_name'],
                              'iface' => $m['iface_name']],
                    'dst' => ['network_id' => $net_id,
                              'name' => isset($net_names[$net_id]) ? $net_names[$net_id] : ('Net' . $net_id)],
                ];
                $taps[] = $m['tap']; $tap_host[$m['tap']] = $m['host_id'];
            }
        }
    }
    return ['links' => $links, 'taps' => array_values(array_unique($taps)), 'tap_host' => $tap_host];
}

/* GET self-heal: the live link set can change AFTER a watch is armed — a slow node
 * (esp. a docker container) brings its tap up late, or the user adds/deletes a link.
 * Re-resolve and, if the live tap set DIFFERS from the armed conf (grew OR shrank),
 * re-arm the watcher (last-start-wins) to match and rewrite the links sidecar so the
 * client adopts the change. Returns the fresh links on a re-arm, else null.
 * No-op/safe on any failure. */
function lw_rearm_if_changed($watch_id, $session, $tenant, $links_file, $filt_file) {
    $conf = json_decode(@file_get_contents(LW_DIR . '/' . $watch_id . '.conf.json'), true);
    if (!is_array($conf) || empty($conf['interfaces'])) return null;
    $raw = json_decode(@file_get_contents($filt_file), true);
    if (!is_array($raw) || empty($raw['filters'])) return null;   // can't re-arm without raw filters
    try {
        $ls = getLabFromSession($session);
        if (!$ls) return null;
        $lab = new Lab(BASE_LAB . $ls['lab_session_path'], $tenant, $session);
    } catch (Exception $e) { return null; }
    $res = lw_resolve($lab);
    $live = $res['taps']; sort($live);
    $armed = array_values($conf['interfaces']); sort($armed);
    if ($live === $armed) return null;     // unchanged
    if (count($live) === 0) return null;   // transient all-down: keep the current watch, don't tear it down
    $iv = (isset($raw['interval']) && is_numeric($raw['interval'])) ? (float) $raw['interval'] : null;
    $by_host = [];
    foreach ($res['taps'] as $tap) {
        $h = isset($res['tap_host'][$tap]) ? (int) $res['tap_host'][$tap] : 0;
        $by_host[$h][] = $tap;
    }
    $ok = false;
    foreach ($by_host as $h => $htaps) {
        $bargs = ['watch_id' => $watch_id, 'filters' => $raw['filters'],
                  'interfaces' => array_values(array_unique($htaps))];
        if ($iv !== null) $bargs['interval'] = $iv;
        $r = cluster_broker($h, 'linkwatch_start', $bargs, 30);
        if ($r['ok']) $ok = true;
    }
    if (!$ok) return null;
    @file_put_contents($links_file, json_encode($res['links']));
    return $res['links'];
}

/* ---- GET: poll snapshot (merge each host's taps) ------------------------ */
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $taps = []; $newest = 0;
    foreach (lw_watch_hosts($hosts_file) as $h) {
        if ($h <= 0) {
            @touch($hb_file);               // keep the local watcher alive
            $snap = json_decode(@file_get_contents($snap_file), true);
        } else {
            // satd refreshes the satellite heartbeat and returns its snapshot
            $r = cluster_broker($h, 'linkwatch_snapshot', ['watch_id' => $watch_id], 20);
            $snap = $r['ok'] ? json_decode(implode("\n", $r['out']), true) : null;
        }
        if (is_array($snap) && isset($snap['ts'])) {
            if ($snap['ts'] > $newest) $newest = $snap['ts'];
            if (isset($snap['taps']) && is_array($snap['taps'])) {
                foreach ($snap['taps'] as $tap => $v) $taps[$tap] = $v;
            }
        }
    }
    $age = $newest > 0 ? (microtime(true) - $newest) : 1e9;
    if ($newest === 0 || $age > 10) out(['active' => false]);
    $links = json_decode(@file_get_contents($links_file), true);
    $links = is_array($links) ? $links : [];
    // Self-heal (throttled ~8s): links whose taps came up AFTER the watch started
    // (slow docker nodes especially) are missing from the sidecar. Re-resolve and
    // re-arm the watcher if the live tap set grew, so the link starts highlighting
    // without the user having to stop/start the watch.
    if (@filemtime($recheck_file) < time() - 8) {
        @touch($recheck_file);
        $healed = lw_rearm_if_changed($watch_id, $session, $tenant, $links_file, $filt_file);
        if (is_array($healed)) $links = $healed;
    }
    out(['active' => true, 'snapshot' => ['ts' => $newest, 'taps' => $taps],
         'links' => $links]);
}

$body = json_decode(file_get_contents('php://input'), true);
$action = is_array($body) && isset($body['action']) ? $body['action'] : '';

/* ---- POST stop ------------------------------------------------------------ */
if ($action === 'stop') {
    foreach (lw_watch_hosts($hosts_file) as $h) {
        cluster_broker($h, 'linkwatch_stop', ['watch_id' => $watch_id]);
    }
    @unlink($links_file);
    @unlink($hosts_file);
    @unlink($filt_file);
    @unlink($recheck_file);
    out(['status' => 'stopped']);
}
if ($action !== 'start') out(['error' => 'bad action'], 400);

/* ---- POST start: validate filters (broker re-validates + builds the BPF) -- */
$filters = isset($body['filters']) && is_array($body['filters']) ? $body['filters'] : [];
if (count($filters) < 1 || count($filters) > LW_MAX_FILTERS) {
    out(['error' => 'cap_exceeded', 'what' => 'filters',
         'max' => LW_MAX_FILTERS], 400);
}
$clean = [];
$seen_ids = [];
foreach (array_values($filters) as $i => $f) {
    if (!is_array($f)) out(['error' => 'bad filter'], 400);
    // Tier 2: honour a client-assigned STABLE id (e.g. "c7") so snapshot keys /
    // lane colours / per-filter counters survive an add/remove/reorder. Falls
    // back to the legacy positional "f<i>" when absent (legacy overlay) or on a
    // collision. brokerd re-validates the id against the same charset.
    $fid = 'f' . $i;
    if (!empty($f['id']) && preg_match('/^[a-z][a-z0-9]{0,15}$/', (string) $f['id'])
        && !isset($seen_ids[(string) $f['id']])) {
        $fid = (string) $f['id'];
    }
    $seen_ids[$fid] = true;
    $cf = ['id' => $fid, 'preset' => isset($f['preset']) ? (string) $f['preset'] : 'custom'];
    // Keep the optional version field strict at the HTTP boundary.  The old
    // truthy-only check silently dropped values such as 5, arrays, and objects,
    // allowing a malformed request to change meaning before broker validation.
    $version = null;
    if (array_key_exists('version', $f) && $f['version'] !== '' && $f['version'] !== null) {
        if (!is_string($f['version']) || !in_array($f['version'], ['4', '6'], true)) {
            out(['error' => 'bad version in filter ' . ($i + 1)], 400);
        }
        $version = $f['version'];
        $cf['version'] = $version;
    }
    $ip_versions = [];
    foreach (['src_ip', 'dst_ip'] as $k) {
        // Empty strings/null retain the UI's optional-field semantics.  Any
        // other present value must be a valid address of the selected family;
        // this also prevents filter_var() from receiving an array/object.
        if (array_key_exists($k, $f) && $f[$k] !== '' && $f[$k] !== null) {
            if (!is_string($f[$k])) {
                out(['error' => 'bad ' . $k . ' in filter ' . ($i + 1)], 400);
            }
            $ip_flags = $version === '4' ? FILTER_FLAG_IPV4 :
                        ($version === '6' ? FILTER_FLAG_IPV6 : 0);
            if (filter_var($f[$k], FILTER_VALIDATE_IP, $ip_flags) === false) {
                out(['error' => 'bad ' . $k . ' in filter ' . ($i + 1)], 400);
            }
            // With no explicit version, both endpoints still have to describe
            // one IP family.  A v4 source + v6 destination can never match one
            // packet and pcap rejects that conjunction during compilation.
            $ip_versions[$k] = filter_var($f[$k], FILTER_VALIDATE_IP,
                                          FILTER_FLAG_IPV4) !== false ? 4 : 6;
            $cf[$k] = $f[$k];
        }
    }
    if ($version === null && count($ip_versions) === 2 &&
        $ip_versions['src_ip'] !== $ip_versions['dst_ip']) {
        out(['error' => 'src_ip and dst_ip must use the same IP family in filter ' .
             ($i + 1)], 400);
    }
    if (isset($f['port']) && $f['port'] !== '' && $f['port'] !== null) {
        $p = intval($f['port']);
        if ($p < 1 || $p > 65535) out(['error' => 'bad port in filter ' . ($i + 1)], 400);
        $cf['port'] = $p;
    }
    if (!empty($f['proto'])) $cf['proto'] = (string) $f['proto'];
    // Subtype: alphanumeric/dash/underscore slug validated here; brokerd is authoritative.
    if (!empty($f['subtype']) && preg_match('/^[a-z0-9_-]{1,24}$/', (string) $f['subtype'])) {
        $cf['subtype'] = (string) $f['subtype'];
    }
    if (isset($f['subtype_arg']) && is_numeric($f['subtype_arg'])) {
        $sa = (int) $f['subtype_arg'];
        if ($sa >= 1 && $sa <= 16777215) $cf['subtype_arg'] = $sa;
    }
    $clean[] = $cf;
}

/* ---- resolve lab links -> taps -------------------------------------------- */
try {
    $labsession = getLabFromSession($session);
    if (!$labsession) throw new Exception('no lab session');
    $lab = new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $session);
} catch (Exception $e) {
    out(['error' => 'lab open failed: ' . $e->getMessage()], 400);
}

// A tap is watchable only if it EXISTS and is admin-UP (IFF_UP=0x1). A container
// node's host-side veth (e.g. Cisco XRd) can exist but stay DOWN — it carries no
// frames, so binding it shows no traffic; the p2p selection below then falls
// through to the other (up) end and flips the direction.
function _lw_tap_live($tap) {
    $p = '/sys/class/net/' . $tap;
    if (!file_exists($p)) return false;
    $flags = @file_get_contents($p . '/flags');
    return $flags !== false && (hexdec(trim($flags)) & 1);
}

// Resolve the lab's links -> watchable taps (shared with the GET self-heal).
$res = lw_resolve($lab);
$links = $res['links']; $taps = $res['taps']; $tap_host = $res['tap_host'];
$taps = array_values(array_unique($taps));
if (count($taps) === 0) out(['error' => 'no_links', 'message' =>
    'no running nodes with connected ethernet interfaces'], 400);
if (count($taps) > LW_MAX_IF) {
    out(['error' => 'cap_exceeded', 'what' => 'interfaces',
         'count' => count($taps), 'max' => LW_MAX_IF], 400);
}

// interval (UI "speed" control) applies to every host's watcher
$iv = null;
if (isset($body['interval']) && is_numeric($body['interval'])) {
    $ivv = (float) $body['interval'];
    if ($ivv >= 0.2 && $ivv <= 2.0) $iv = $ivv;
}
// Start one watcher per owning host, each with that host's taps. The watch_id is
// the same on every host (each host's linkwatchd is independent — no collision),
// so GET merges their snapshots and stop tears them all down.
$by_host = [];
foreach ($taps as $tap) {
    $h = isset($tap_host[$tap]) ? (int) $tap_host[$tap] : 0;
    $by_host[$h][] = $tap;
}
$started = []; $exprs = [];
foreach ($by_host as $h => $htaps) {
    $bargs = ['watch_id' => $watch_id, 'filters' => $clean,
              'interfaces' => array_values(array_unique($htaps))];
    if ($iv !== null) $bargs['interval'] = $iv;
    $resp = cluster_broker($h, 'linkwatch_start', $bargs, 30);
    if ($resp['ok']) { $started[] = $h; $exprs = $resp['out']; }
}
if (empty($started)) out(['error' => 'broker: failed to start watcher'], 502);

@file_put_contents($hosts_file, json_encode(array_values($started)));
@file_put_contents($links_file, json_encode($links));
// persist the raw filter spec so the GET self-heal can re-arm later (conf.json
// holds only the compiled bpf). interval is the validated UI "speed".
@file_put_contents($filt_file, json_encode(['filters' => $clean, 'interval' => $iv]));
@unlink($recheck_file);   // fresh start: let the first GET re-check promptly
@touch($hb_file);
out(['status' => 'started', 'watch_id' => $watch_id, 'links' => $links,
     'filters' => array_map(function ($f) { return $f['id']; }, $clean),
     'exprs' => $exprs,
     'interfaces' => count($taps), 'max_interfaces' => LW_MAX_IF]);
