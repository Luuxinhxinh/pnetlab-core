<?php
/**
 * cluster.php — master-side helpers for PNetLab clustering (1 master + up to
 * 2 satellites).
 *
 * Placement is stored in the `cluster_placements` DB table (sparse: only
 * host>0 rows are kept; host=0 deletes the row). Legacy lab XML
 * `cluster_host` attrs are migrated on first open by __lab.php and stripped
 * from the XML on the next save. node_sessions.node_session_host mirrors the
 * host that a node actually starts on (used by stop/wipe so they follow the
 * real process even if the user re-places the node mid-session).
 *
 * Satellite RPC rides the privilege broker: PHP never holds the cluster PSK;
 * brokerd's `cluster_call` verb owns the TLS+HMAC transport to pnetlab-satd.
 */

/**
 * True when at least one satellite has joined.
 */
function cluster_enabled()
{
    return count(cluster_hosts()) > 0;
}

/**
 * Joined satellites keyed by host_id (1/2):
 * ['host_id','host_name','host_ip','host_status','host_last_seen','host_version'].
 * Returns [] when the cluster_hosts table is missing (pre-migration DB).
 */
function cluster_hosts()
{
    static $hosts = null;
    if ($hosts !== null) {
        return $hosts;
    }
    $hosts = [];
    try {
        $db = checkDatabase();
        if ($db === false) {
            return $hosts;
        }
        $statement = $db->query('SELECT * FROM cluster_hosts ORDER BY host_id');
        foreach ($statement->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $hosts[(int) $row['host_id']] = $row;
        }
    } catch (Exception $e) {
        // Table absent (migration not run) or DB error: behave as single-host.
        $hosts = [];
    }
    return $hosts;
}

/**
 * IP of a joined satellite, or null if that host_id is not joined.
 */
function cluster_host_ip($host_id)
{
    $hosts = cluster_hosts();
    return isset($hosts[(int) $host_id]) ? $hosts[(int) $host_id]['host_ip'] : null;
}

/**
 * nid→host map for all placements of a lab UUID (global per-request cache).
 * Returns [] on single-host installs or when the table is absent.
 */
function cluster_placements_of($uuid)
{
    if (!isset($GLOBALS['_pnq_placements'][$uuid])) {
        $GLOBALS['_pnq_placements'][$uuid] = [];
        try {
            $db = checkDatabase();
            $st = $db->prepare(
                'SELECT placement_nid, placement_host FROM cluster_placements ' .
                'WHERE placement_lab = :u'
            );
            $st->execute(['u' => $uuid]);
            foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $GLOBALS['_pnq_placements'][$uuid][(int) $row['placement_nid']] =
                    (int) $row['placement_host'];
            }
        } catch (Exception $e) {
            // table absent (pre-migration DB): single-host behaviour
        }
    }
    return $GLOBALS['_pnq_placements'][$uuid];
}

/**
 * Placement of a single node (0 = master).
 */
function cluster_placement_get($uuid, $nid)
{
    $map = cluster_placements_of($uuid);
    return isset($map[(int) $nid]) ? $map[(int) $nid] : 0;
}

/**
 * Set or clear a node's placement. host=0 deletes the row (sparse table).
 * Invalidates the per-request cache so subsequent reads in the same request
 * see the new value.
 */
function cluster_placement_set($uuid, $nid, $host)
{
    $host = max(0, min(2, (int) $host));
    try {
        $db = checkDatabase();
        if ($host === 0) {
            $st = $db->prepare(
                'DELETE FROM cluster_placements ' .
                'WHERE placement_lab = :u AND placement_nid = :n'
            );
            $st->execute(['u' => $uuid, 'n' => (int) $nid]);
        } else {
            $st = $db->prepare(
                'REPLACE INTO cluster_placements ' .
                '(placement_lab, placement_nid, placement_host) VALUES (:u, :n, :h)'
            );
            $st->execute(['u' => $uuid, 'n' => (int) $nid, 'h' => $host]);
        }
    } catch (Exception $e) {
        // table absent (pre-migration DB): silently ignore
    }
    unset($GLOBALS['_pnq_placements'][$uuid]);
}

/**
 * Migrate legacy XML cluster_host attrs into the DB on first open.
 * $map is nid=>host (host>0 only). INSERT IGNORE so DB wins on conflict.
 * Caller must NOT set $modified — the attr disappears on the next real save.
 */
function cluster_placements_migrate($uuid, $map)
{
    if (empty($map)) {
        return;
    }
    try {
        $db = checkDatabase();
        $st = $db->prepare(
            'INSERT IGNORE INTO cluster_placements ' .
            '(placement_lab, placement_nid, placement_host) VALUES (:u, :n, :h)'
        );
        foreach ($map as $nid => $host) {
            $host = max(1, min(2, (int) $host));
            $st->execute(['u' => $uuid, 'n' => (int) $nid, 'h' => $host]);
        }
    } catch (Exception $e) {
        // table absent (pre-migration DB): ignore
    }
    unset($GLOBALS['_pnq_placements'][$uuid]);
}

/**
 * Clear all placements for a satellite being removed.
 * Called by cluster/api.php action=remove after the 409 running-nodes gate.
 */
function cluster_placement_clear_host($host)
{
    try {
        $db = checkDatabase();
        $st = $db->prepare(
            'DELETE FROM cluster_placements WHERE placement_host = :h'
        );
        $st->execute(['h' => (int) $host]);
    } catch (Exception $e) {
        // pre-migration: ignore
    }
    unset($GLOBALS['_pnq_placements']);
}

/**
 * Placement of a node for a NEW start: reads cluster_placements DB,
 * downgraded to 0 (master) when that satellite is not (or no longer) joined.
 */
function cluster_host_of($lab, $node_id)
{
    $host = cluster_placement_get($lab->getId(), (int) $node_id);
    if ($host > 0 && cluster_host_ip($host) === null) {
        return 0;
    }
    return $host;
}

/**
 * Host a node's CURRENT session lives on (node_sessions mirror, set at start
 * time) — use this for stop/wipe/delete of an existing session. Falls back to
 * the lab XML placement when no session row exists.
 */
function cluster_session_host($lab, $node_id)
{
    try {
        $db = checkDatabase();
        $statement = $db->prepare(
            'SELECT node_session_host FROM node_sessions ' .
            'WHERE node_session_lab = :lab AND node_session_nid = :nid'
        );
        $statement->execute(['lab' => $lab->getSession(), 'nid' => (int) $node_id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if ($row !== false) {
            $host = (int) $row['node_session_host'];
            return ($host > 0 && cluster_host_ip($host) === null) ? 0 : $host;
        }
    } catch (Exception $e) {
        // pre-migration column miss: single-host behaviour
    }
    return cluster_host_of($lab, $node_id);
}

/**
 * Run a verb on a satellite via brokerd's cluster_call relay. exec()-shaped
 * like broker_exec(): fills $out/$rc, returns last output line.
 */
function cluster_exec($host_id, $verb, $args, &$out = null, &$rc = null, $timeout = 60)
{
    return broker_exec('cluster_call', [
        'host' => (int) $host_id, 'verb' => $verb,
        'args' => (object) $args, 'timeout' => (int) $timeout,
    ], $out, $rc, $timeout + 10);
}

/**
 * broker_call()-shaped router for read-only inspection verbs (node_show,
 * linkwatch_*, prototrace_*): run the verb on the host that OWNS the node/tap.
 * host <= 0 (master) -> local broker; host > 0 -> relayed via cluster_call to
 * the satellite's satd (which forwards to its local brokerd against its own
 * taps/consoles). Returns the SAME ['ok','rc','out','err'] shape as
 * broker_call(), so feature endpoints can stay transport-agnostic.
 *
 * On a satellite the target's tap/console is LOCAL, so callers must pass any
 * host-address arg as 127.0.0.1 (not the satellite's external IP) when routing
 * remote — the relayed verb runs on the satellite itself.
 */
function cluster_broker($host_id, $verb, $args, $timeout = 60)
{
    if ((int) $host_id <= 0) {
        return broker_call($verb, $args, $timeout);
    }
    return broker_call('cluster_call', [
        'host' => (int) $host_id, 'verb' => $verb,
        'args' => (object) $args, 'timeout' => (int) $timeout,
    ], $timeout + 10);
}

/**
 * Satellites that host at least one node of this lab session.
 */
function cluster_satellites_of_session($lab_session)
{
    $hosts = [];
    try {
        $db = checkDatabase();
        $statement = $db->prepare(
            'SELECT DISTINCT node_session_host FROM node_sessions ' .
            'WHERE node_session_lab = :s AND node_session_host > 0'
        );
        $statement->execute(['s' => (int) $lab_session]);
        foreach ($statement->fetchAll(PDO::FETCH_COLUMN) as $h) {
            if (cluster_host_ip((int) $h) !== null) {
                $hosts[] = (int) $h;
            }
        }
    } catch (Exception $e) {
        // pre-migration column: single-host behaviour
    }
    return $hosts;
}

/**
 * Record which host a node's session actually runs on (called at start
 * dispatch, so stop/wipe later follow the process, not the lab XML).
 */
function cluster_update_session_host($lab, $node_id, $host)
{
    try {
        $db = checkDatabase();
        $statement = $db->prepare(
            'UPDATE node_sessions SET node_session_host = :h ' .
            'WHERE node_session_lab = :s AND node_session_nid = :n'
        );
        $statement->execute([
            'h' => (int) $host, 's' => $lab->getSession(), 'n' => (int) $node_id,
        ]);
    } catch (Exception $e) {
        // pre-migration column: nothing to mirror
    }
}

/**
 * Before a remote start, make sure the satellite has the node's image. If it
 * is missing, kick (or join) a pnet-imgsync job and return a JSend fail whose
 * `cluster_sync` payload lets pnetlab-cluster-sync.js show progress and
 * auto-retry the start when the sync completes. Returns null when the start
 * may proceed.
 */
function cluster_image_gate($lab, $node_id, $host)
{
    $nodes = $lab->getNodes();
    if (!isset($nodes[$node_id])) {
        return null;
    }
    $node = $nodes[$node_id];
    $type = $node->getNType();
    if (!in_array($type, ['qemu', 'iol', 'dynamips', 'docker'], true)) {
        return null;    // vpcs etc. carry no image
    }
    $options = $node->getOptions();
    $image = isset($options['image']) ? (string) $options['image'] : '';
    if ($image === '') {
        return null;
    }

    cluster_exec($host, 'image_check', ['type' => $type, 'image' => $image], $o, $rc, 30);
    if ($rc !== 0) {
        return null;    // satellite unreachable — let the wrapper call surface it
    }
    $check = json_decode(count($o) ? end($o) : '', true);
    if (!is_array($check) || !empty($check['present'])) {
        return null;
    }

    // idempotent job id: a second node needing the same image joins the job
    $job = substr(sha1($host . '|' . $type . '|' . $image), 0, 16);
    $jobsDir = '/opt/unetlab/html/cluster/jobs';
    $jobFile = $jobsDir . '/' . $job . '.json';
    $running = false;
    if (is_file($jobFile)) {
        $j = json_decode(@file_get_contents($jobFile), true);
        if (is_array($j) && isset($j['state'])
                && in_array($j['state'], ['queued', 'running', 'finalizing'], true)) {
            $running = true;
        }
        // a stale "done" with the image still absent (wiped on the satellite)
        // falls through and re-kicks the sync
    }
    if (!$running) {
        @mkdir($jobsDir, 0777, true);
        @file_put_contents($jobFile, json_encode(['state' => 'queued', 'pct' => 0, 'msg' => 'queued']));
        @chmod($jobFile, 0666);
        // sidecar for sync_status finalize hook (fixpermissions after completion)
        $metaFile = $jobsDir . '/' . $job . '.meta.json';
        @file_put_contents($metaFile, json_encode([
            'host' => $host, 'type' => $type, 'image' => $image,
            'finalized' => false, 'attempts' => 0,
        ]));
        @chmod($metaFile, 0666);
        $resp = broker_call('cluster_sync_image', [
            'host' => $host, 'type' => $type, 'image' => $image, 'job' => $job,
        ], 60);
        if (!$resp['ok']) {
            return [
                'code' => 400, 'status' => 'fail',
                'message' => 'Image sync to Satellite ' . $host . ' failed to start: ' . $resp['err'],
            ];
        }
    }
    return [
        'code' => 400, 'status' => 'fail',
        'message' => 'Image "' . $image . '" is syncing to Satellite ' . $host .
            ' — the node starts automatically when it finishes',
        'cluster_sync' => ['job' => $job, 'host' => $host, 'image' => $image],
    ];
}

/**
 * Master's own IP as satellites (and their vxlan peers) reach it. Recorded in
 * hosts.json at first join; web-context SERVER_ADDR is the fallback.
 */
function cluster_self_ip()
{
    static $ip = null;
    if ($ip !== null) {
        return $ip;
    }
    $resp = broker_call('cluster_info');
    if ($resp['ok'] && count($resp['out'])) {
        $info = json_decode($resp['out'][count($resp['out']) - 1], true);
        if (is_array($info) && !empty($info['self_ip'])) {
            return $ip = $info['self_ip'];
        }
    }
    return $ip = (isset($_SERVER['SERVER_ADDR']) ? $_SERVER['SERVER_ADDR'] : '');
}

/**
 * Overlay MTU (control-table key cluster_mtu, default 1450 = 1500 underlay
 * minus VXLAN overhead; set 9000 with a jumbo underlay).
 */
function cluster_mtu()
{
    static $mtu = null;
    if ($mtu !== null) {
        return $mtu;
    }
    $mtu = 1450;
    try {
        $db = checkDatabase();
        $statement = $db->prepare(
            "SELECT control_value FROM control WHERE control_name = 'cluster_mtu'"
        );
        $statement->execute();
        $v = (int) $statement->fetchColumn();
        if ($v >= 576 && $v <= 9216) {
            $mtu = $v;
        }
    } catch (Exception $e) {
        // keep the default
    }
    return $mtu;
}

/**
 * (Re)create VXLAN overlays for plain ("bridge"-type) lab networks whose
 * member nodes span cluster hosts. Idempotent; called after every successful
 * node start. Clouds (pnetX/natX) and internal/private/ovs networks stay
 * single-host in v1. Teardown is the session_cleanup vx-sweep on lab close.
 */
function cluster_sync_overlay($lab)
{
    if (!cluster_enabled()) {
        return;
    }
    $session = (int) $lab->getSession();
    if ($session <= 0) {
        return;
    }

    // network_id -> set of hosts whose member nodes touch it
    $netHosts = [];
    foreach ($lab->getNodes() as $node_id => $node) {
        $host = cluster_session_host($lab, $node_id);
        foreach ($node->getEthernets() as $interface) {
            $nid = (int) $interface->getNetworkId();
            if ($nid > 0) {
                $netHosts[$nid][$host] = true;
            }
        }
    }

    $networks = $lab->getNetworks();
    $selfIp = cluster_self_ip();
    if ($selfIp === '') {
        error_log(date('M d H:i:s ') . 'ERROR: cluster_sync_overlay: no self_ip');
        return;
    }
    $mtu = cluster_mtu();

    foreach ($netHosts as $nid => $hostSet) {
        $hosts = array_keys($hostSet);
        if (count($hosts) < 2 || !isset($networks[$nid])) {
            continue;
        }
        if ($networks[$nid]->getNType() !== 'bridge') {
            continue;   // v1: only plain lab networks are stitched
        }
        if ($nid >= 4096) {
            error_log(date('M d H:i:s ') .
                'ERROR: network ' . $nid . ' >= 4096 cannot span cluster hosts');
            continue;
        }
        // 12 session bits + 12 network bits keeps the VNI < 2^24. Sessions
        // beyond 4095 wrap (masked) — accepted v1 risk, collisions need two
        // ACTIVE cross-host labs 4096 sessions apart.
        $vni = (($session & 0xFFF) << 12) | $nid;

        foreach ($hosts as $h) {
            $peers = [];
            foreach ($hosts as $p) {
                if ($p !== $h) {
                    $peers[] = ($p === 0) ? $selfIp : cluster_host_ip($p);
                }
            }
            $args = [
                'session' => $session, 'net_id' => $nid, 'vni' => $vni,
                'local_ip' => ($h === 0) ? $selfIp : cluster_host_ip($h),
                'peers' => $peers, 'mtu' => $mtu,
            ];
            $resp = ($h === 0)
                ? broker_call('vxlan_attach', $args)
                : broker_call('cluster_call', [
                    'host' => $h, 'verb' => 'vxlan_attach', 'args' => (object) $args,
                ]);
            if (!$resp['ok']) {
                error_log(date('M d H:i:s ') . 'ERROR: vxlan_attach net ' . $nid .
                    ' host ' . $h . ': ' . $resp['err']);
            }
        }
    }
}

/**
 * unl_wrapper for ONE node, routed to the host it lives on. Drop-in for the
 * broker_exec('wrapper', ...) call sites in api_nodes.php: fills $o/$rc the
 * same way. start places by the lab XML (`cluster_host` option); every other
 * action follows node_sessions.node_session_host (where it actually runs).
 * Returns a JSend fail array when a cluster step blocks the action (image
 * sync in progress, satellite unreachable), null otherwise.
 */
function node_wrapper_exec($lab, $node_id, $action, $tenant, &$o = null, &$rc = null, $timeout = 600)
{
    $host = ($action === 'start')
        ? cluster_host_of($lab, $node_id)
        : cluster_session_host($lab, $node_id);

    $args = [
        'action' => $action, 'tenant' => (int) $tenant,
        'session' => (int) $lab->getSession(), 'node' => (int) $node_id,
        'lab' => $lab->getPath() . '/' . $lab->getFilename(),
    ];

    if ($host === 0) {
        if ($action === 'start') {
            cluster_update_session_host($lab, $node_id, 0);
        }
        broker_exec('wrapper', $args, $o, $rc, $timeout);
        return null;
    }

    if ($action === 'start') {
        $gate = cluster_image_gate($lab, $node_id, $host);
        if ($gate !== null) {
            $rc = 1;
            $o = [];
            return $gate;
        }
    }

    // the satellite wrapper parses the lab XML locally — ship the current copy
    broker_exec('cluster_sync_lab', [
        'host' => $host, 'lab' => $args['lab'], 'direction' => 'push',
    ], $so, $src, 120);
    if ($src !== 0) {
        $rc = $src;
        $o = $so;
        return [
            'code' => 400, 'status' => 'fail',
            'message' => 'Satellite ' . $host . ': lab sync failed — ' .
                (count($so) ? end($so) : 'rsync error'),
        ];
    }

    if ($action === 'start') {
        cluster_update_session_host($lab, $node_id, $host);
        // Ensure device prep/config scripts exist on the satellite before it
        // prepares the node. They live in /opt/unetlab/config_scripts (template
        // prep:/config_script:, e.g. SD-WAN prep_c8000vcm.sh that builds the
        // cEdge day-0 config.iso) and are NOT deb-owned, so a joined satellite
        // can lag the master. Best-effort: a sync hiccup shouldn't block the
        // start (a genuinely missing script still surfaces as the node's own
        // failure).
        broker_exec('cluster_sync_configscripts', ['host' => $host], $cso, $csrc, 120);
        // The satellite's broker gates dangerous/free-form docker templates on
        // the root-owned docker-template-manifest.sha256. It ships in the
        // satellite deb but is REGENERATED on the master (gen-template-manifest)
        // whenever a shipped template changes, so push the current copy
        // alongside the config scripts. Best-effort for the same reason: a
        // stale manifest still fails closed as the node's own create failure.
        broker_exec('cluster_sync_manifest', ['host' => $host], $mfo, $mfrc, 60);
    }
    cluster_exec($host, 'wrapper', $args, $o, $rc, $timeout);
    // cluster_call sentinels (pnetlab-brokerd verb_cluster_call): surface a clear
    // reason here instead of letting the rc fall through to $messages[$rc], which
    // has no entry for these and warns "Undefined array key 254/255/253".
    if ($rc === 255 || $rc === 254 || $rc === 253) {
        $why = ($rc === 255) ? 'unreachable'
            : (($rc === 254)
                ? 'version skew — the satellite runs a different PNetLab version '
                  . 'than the master; upgrade the satellite deb to match'
                : 'control-plane cert fingerprint mismatch — re-join the satellite');
        return [
            'code' => 400, 'status' => 'fail',
            'message' => 'Satellite ' . $host . ' (' . cluster_host_ip($host) .
                '): ' . $why,
        ];
    }

    // export writes the captured config into the SATELLITE's lab copy — pull
    // it back so the master's lab file (the source of truth) carries it
    if ($action === 'export' && $rc === 0) {
        broker_exec('cluster_sync_lab', [
            'host' => $host, 'lab' => $args['lab'], 'direction' => 'pull',
        ], $po, $prc, 120);
        if ($prc !== 0) {
            $rc = $prc;
            $o = $po;
        }
    }
    return null;
}

/**
 * Lab-wide unl_wrapper (export/wipe with no node id): run locally as before,
 * then fan out once per satellite hosting nodes of this session. First
 * non-zero rc wins so the caller's error path still fires.
 */
function lab_wrapper_exec($lab, $action, $tenant, &$o = null, &$rc = null, $timeout = 600)
{
    $args = [
        'action' => $action, 'tenant' => (int) $tenant,
        'session' => (int) $lab->getSession(),
        'lab' => $lab->getPath() . '/' . $lab->getFilename(),
    ];
    broker_exec('wrapper', $args, $o, $rc, $timeout);

    foreach (cluster_satellites_of_session($lab->getSession()) as $host) {
        broker_exec('cluster_sync_lab', [
            'host' => $host, 'lab' => $args['lab'], 'direction' => 'push',
        ], $so, $src, 120);
        if ($src !== 0) {
            if ($rc === 0) { $rc = $src; $o = $so; }
            continue;
        }
        cluster_exec($host, 'wrapper', $args, $ro, $rrc, $timeout);
        if ($action === 'export' && $rrc === 0) {
            broker_exec('cluster_sync_lab', [
                'host' => $host, 'lab' => $args['lab'], 'direction' => 'pull',
            ], $po, $prc, 120);
            if ($prc !== 0) { $rrc = $prc; $ro = $po; }
        }
        if ($rrc !== 0 && $rc === 0) {
            $rc = $rrc;
            $o = $ro;
        }
    }
}
