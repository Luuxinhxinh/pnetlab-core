<?php
/**
 * status/api.php — engine-side System page backend for the self-created
 * dashboard (/main/). Authenticated with the engine's own cookie/session check
 * (the shared, unencrypted `token` cookie the Laravel login sets) — the exact
 * same pattern as cluster/api.php and import/api.php. This lets the System page
 * work without a Laravel session; it faithfully reproduces what the store's
 * Admin\StatusController did, including the privilege-broker toggles.
 *
 *   GET  ?action=system   → {data:{ram,swap,total_ram,total_swap[,cpu,disk,total_disk]}}
 *   GET  ?action=nodes    → {data:{iol,dynamips,qemu,docker,vpcs}}        (admin)
 *   GET  ?action=info     → {data:{qemu_version,cores,uksm,ksm,cpulimit}}
 *   POST ?action=ksm|uksm|cpulimit  {state:bool}  → {ok:true}            (admin)
 *
 * cpu + disk are root-gated (matching StatusController), since `top`/`df` reveal
 * host-wide load; ram/swap and info are available to any authenticated user.
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';
require_once '/opt/unetlab/html/includes/lab-session-access.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function out($x) { echo json_encode($x); exit; }
function fail($code, $m) { http_response_code($code); echo json_encode(['error' => $m]); exit; }

function run_cmd($cmd) { $o = []; $rc = 0; exec($cmd, $o, $rc); return [$o, $rc]; }
function first_int($o) { return (int) (count($o) ? trim($o[0]) : 0); }
function read_toggle($path) {
    list($o, $rc) = run_cmd('cat ' . escapeshellarg($path));
    if ($rc != 0) return 'unsupported';
    return (count($o) && trim($o[0]) === '1') ? 'enabled' : 'disabled';
}

require_once '/opt/unetlab/html/includes/version.php';   // PNET_RELEASE

/* ---- AUTH — engine cookie/session check -------------------------------------- */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    fail(401, 'not authenticated');
}
$role    = isset($user['role']) ? $user['role'] : '';
$isAdmin = ($role === 0 || $role === '0' || strtolower((string) $role) === 'admin');

$action = isset($_GET['action']) ? $_GET['action'] : '';

/* ============================================================================
 * STORE-COMPATIBLE ACTIONS (store decommission item C4)
 * ----------------------------------------------------------------------------
 * These re-home the Laravel store's Admin\StatusController endpoints that a
 * handful of lab-page consumers still call by their store method names:
 *   pnetlab-sysmon.js, pnetlab-node-runon.js, pnetlab-system-status.js and the
 *   System Status island (SystemStatus.svelte).
 * They return the SAME envelope the store's Reply::finish produced —
 *   {result:bool, message:string, data:mixed} — because those JS success paths
 * read `j.data` (GET) and `j.result` (POST toggle). The pre-existing bare
 * {data:...} actions below (used by /main/ system.js) are left untouched.
 * ========================================================================== */
function reply_finish($result, $message, $data = '') {
    echo json_encode(['result' => $result, 'message' => $message, 'data' => $data]);
    exit;
}

/* getSystemInfo — CPU/RAM/Swap/Disk (cpu+disk root-gated, like the store) */
if ($action === 'getSystemInfo') {
    $data = ['cpu' => 0, 'ram' => 0, 'swap' => 0, 'disk' => 0,
             'total_ram' => 0, 'total_swap' => 0, 'total_disk' => 0];
    list($o, ) = run_cmd('free -m');
    foreach ($o as $line) {
        if (preg_match('/^mem:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+).*$/mi', $line, $m)) {
            if ((int) $m[1] > 0) {
                $data['ram'] = 100 - round((int) $m[6] * 100 / (int) $m[1]);
                $data['total_ram'] = $m[1] * 1024;
            }
        }
        if (preg_match('/^swap:\s+(\d+)\s+(\d+)\s+(\d+).*$/mi', $line, $m)) {
            if ((int) $m[1] > 0) {
                $data['swap'] = round((int) $m[2] * 100 / (int) $m[1]);
                $data['total_swap'] = $m[1] * 1024;
            }
        }
    }
    if (!$isAdmin) reply_finish(true, 'success', $data);
    list($o, ) = run_cmd('top -b -n2 -p1 -d1');
    foreach ($o as $line) {
        if (preg_match('/^%cpu.*\s([\d\.]+)(?=\sid).*$/mi', $line, $m)) {
            $data['cpu'] = 100 - (int) round($m[1]);
        }
    }
    list($o, ) = run_cmd('df -h /');
    foreach ($o as $line) {
        if (preg_match('/^.*\s([\d\.]+[TGMKB]+)\s*([\d\.]+[TGMKB]+)\s*([\d\.]+[TGMKB])\s*([\d]+)%.*$/mi', $line, $m)) {
            $data['disk'] = (int) $m[4];
            $data['total_disk'] = $m[1];
        }
    }
    reply_finish(true, 'success', $data);
}

/* getRunningNodes — running-process counts (root-gated; non-root gets []) */
if ($action === 'getRunningNodes') {
    if (!$isAdmin) reply_finish(true, 'success', []);
    list($iol, )      = run_cmd('pgrep -f -c -P 1 iol_wrapper');
    list($dynamips, ) = run_cmd('pgrep -f -c -P 1 dynamips');
    list($qemu, )     = run_cmd('pgrep -f -c -P 1 qemu-system');
    // broker docker_ps_count verb (Stage 5) — count computed root-side
    $docker = []; $drc = 0;
    broker_exec('docker_ps_count', [], $docker, $drc);
    list($vpcs, )     = run_cmd('pgrep -f -c -P 1 vpcs');
    reply_finish(true, 'success', [
        'iol'      => first_int($iol),
        'dynamips' => first_int($dynamips),
        'qemu'     => first_int($qemu),
        'docker'   => first_int($docker),
        'vpcs'     => first_int($vpcs),
    ]);
}

/* getInfo — qemu/cores + KSM/UKSM/cpulimit states (any authenticated user) */
if ($action === 'getInfo') {
    list($o, $rc) = run_cmd('/opt/qemu/bin/qemu-system-x86_64 -version | sed \'s/.* \([0-9]*\.[0-9.]*\.[0-9.]*\).*/\1/g\'');
    $qemu = ($rc === 0 && count($o)) ? trim($o[0]) : '';
    list($o, $rc) = run_cmd('nproc');
    $cores = ($rc === 0 && count($o)) ? (int) trim($o[0]) : '';
    // CPU Limit is a durable appliance policy flag, not a systemd unit state.
    $policy = broker_qemu_cpu_policy_status();
    $cpulimit = 'unsupported';
    if (!empty($policy['ok']) && !empty($policy['out'])) {
        $cpulimit = trim($policy['out'][0]) === 'enabled' ? 'enabled' :
            (trim($policy['out'][0]) === 'disabled' ? 'disabled' : 'unsupported');
    }
    reply_finish(true, 'success', [
        'qemu_version' => $qemu,
        'cores'        => $cores,
        'uksm'         => read_toggle('/sys/kernel/mm/uksm/run'),
        'ksm'          => read_toggle('/sys/kernel/mm/ksm/run'),
        'cpulimit'     => $cpulimit,
    ]);
}

/* getClusterInfo — cluster satellite stats (root-gated; store shape
 *   {enabled:bool, satellites:[{id,name,ip,online,last_seen,version,
 *    cpu,ram,swap,disk,cores,total_*,counts}]}). A /dev/shm snapshot with a
 * 5s TTL (B4 stale-while-revalidate) so N polling admins cost one probe per
 * window — mirrors the store's StatusController::getClusterInfo. */
if ($action === 'getClusterInfo') {
    $empty = ['enabled' => false, 'satellites' => []];
    if (!$isAdmin) reply_finish(true, 'success', $empty);

    $CACHE = '/dev/shm/pnq-cluster.cache.json';
    $TTL   = 5;

    $snap = null;
    $raw = @file_get_contents($CACHE);
    if ($raw !== false) {
        $j = json_decode($raw, true);
        if (is_array($j) && isset($j['ts'])) $snap = $j;
    }
    if ($snap !== null && (time() - $snap['ts']) < $TTL) {
        reply_finish(true, 'success', $snap['data']);
    }

    $fh = @fopen($CACHE . '.lock', 'c');
    if (!($fh && flock($fh, LOCK_EX | LOCK_NB))) {
        if ($snap !== null) {
            if ($fh) fclose($fh);
            reply_finish(true, 'success', $snap['data']);   // stale-while-revalidate
        }
        if ($fh) {
            flock($fh, LOCK_EX);     // first request ever: wait for the winner
            flock($fh, LOCK_UN);
            fclose($fh);
        }
        $raw = @file_get_contents($CACHE);
        $j = $raw !== false ? json_decode($raw, true) : null;
        reply_finish(true, 'success',
            (is_array($j) && isset($j['data'])) ? $j['data'] : $empty);
    }

    // collect (root-only path): one satd sysinfo round-trip per satellite
    $data = $empty;
    try {
        $db = checkDatabase();
        $rows = $db->query('SELECT * FROM cluster_hosts ORDER BY host_id')->fetchAll(PDO::FETCH_ASSOC);
        $sats = [];
        foreach ($rows as $row) {
            $id = (int) $row['host_id'];
            $sat = [
                'id'        => $id,
                'name'      => $row['host_name'],
                'ip'        => $row['host_ip'],
                'online'    => false,
                'last_seen' => $row['host_last_seen'] !== null ? (int) $row['host_last_seen'] : null,
                'version'   => $row['host_version'],
            ];
            $so = null; $src = null;
            $out = cluster_exec($id, 'sysinfo', [], $so, $src, 8);
            if ($src === 0 && $out !== '') {
                $info = json_decode($out, true);
                if (is_array($info)) {
                    $sat = array_merge($sat, $info, ['online' => true, 'last_seen' => time()]);
                    try {
                        $u = $db->prepare('UPDATE cluster_hosts SET host_status = 1, host_last_seen = ?, host_version = ? WHERE host_id = ?');
                        $u->execute([time(), isset($info['version']) ? $info['version'] : null, $id]);
                    } catch (Exception $e) {}
                }
            } else {
                try {
                    $u = $db->prepare('UPDATE cluster_hosts SET host_status = 0 WHERE host_id = ?');
                    $u->execute([$id]);
                } catch (Exception $e) {}
            }
            $sats[] = $sat;
        }
        $data = ['enabled' => count($rows) > 0, 'satellites' => $sats];
    } catch (Exception $e) {
        $data = $empty;   // pre-migration DB
    }

    @file_put_contents($CACHE . '.tmp', json_encode(['ts' => time(), 'data' => $data]));
    @rename($CACHE . '.tmp', $CACHE);
    @chmod($CACHE, 0644);
    flock($fh, LOCK_UN);
    fclose($fh);
    reply_finish(true, 'success', $data);
}

/* apiSetKsm | apiSetUksm | apiSetCpuLimit — toggle {state:bool} (root, broker) */
if ($action === 'apiSetKsm' || $action === 'apiSetUksm' || $action === 'apiSetCpuLimit') {
    if (!$isAdmin) reply_finish(false, 'ERROR_PERMISSION');
    $body  = json_decode(file_get_contents('php://input'), true);
    $state = is_array($body) && !empty($body['state']);
    $map = [
        'apiSetKsm'      => ['ksmon', 'ksmoff', 'Change KSM status fail'],
        'apiSetUksm'     => ['uksmon', 'uksmoff', 'Change UKSM status fail'],
        'apiSetCpuLimit' => ['cpulimiton', 'cpulimitoff', 'Change CPU limit status fail'],
    ];
    $verbAction = $state ? $map[$action][0] : $map[$action][1];
    $o = null; $rc = null;
    broker_exec('wrapper', ['action' => $verbAction], $o, $rc);
    if ($rc === 0) reply_finish(true, 'success');
    reply_finish(false, $map[$action][2]);
}

/* ---- GET system: CPU/RAM/Swap/Disk (cpu+disk admin-only) -------------------- */
if ($action === 'system') {
    $data = ['cpu' => 0, 'ram' => 0, 'swap' => 0, 'disk' => 0,
             'total_ram' => 0, 'total_swap' => 0, 'total_disk' => 0];

    list($o, ) = run_cmd('free -m');
    foreach ($o as $line) {
        if (preg_match('/^mem:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+).*$/mi', $line, $m)) {
            if ((int) $m[1] > 0) {
                $data['ram'] = 100 - round((int) $m[6] * 100 / (int) $m[1]);
                $data['total_ram'] = $m[1] * 1024;
            }
        }
        if (preg_match('/^swap:\s+(\d+)\s+(\d+)\s+(\d+).*$/mi', $line, $m)) {
            if ((int) $m[1] > 0) {
                $data['swap'] = round((int) $m[2] * 100 / (int) $m[1]);
                $data['total_swap'] = $m[1] * 1024;
            }
        }
    }

    if ($isAdmin) {
        list($o, ) = run_cmd('top -b -n2 -p1 -d1');
        foreach ($o as $line) {
            if (preg_match('/^%cpu.*\s([\d\.]+)(?=\sid).*$/mi', $line, $m)) {
                $data['cpu'] = 100 - (int) round($m[1]);
            }
        }
        list($o, ) = run_cmd('df -h /');
        foreach ($o as $line) {
            if (preg_match('/^.*\s([\d\.]+[TGMKB]+)\s*([\d\.]+[TGMKB]+)\s*([\d\.]+[TGMKB])\s*([\d]+)%.*$/mi', $line, $m)) {
                $data['disk'] = (int) $m[4];
                $data['total_disk'] = $m[1];
            }
        }
    }
    out(['data' => $data]);
}

/* ---- GET nodes: running-process counts (admin-only) ------------------------- */
if ($action === 'nodes') {
    if (!$isAdmin) out(['data' => new stdClass()]);
    list($iol, )      = run_cmd('pgrep -f -c -P 1 iol_wrapper');
    list($dynamips, ) = run_cmd('pgrep -f -c -P 1 dynamips');
    list($qemu, )     = run_cmd('pgrep -f -c -P 1 qemu-system');
    // broker docker_ps_count verb (Stage 5) — count computed root-side
    $docker = []; $drc = 0;
    broker_exec('docker_ps_count', [], $docker, $drc);
    list($vpcs, )     = run_cmd('pgrep -f -c -P 1 vpcs');
    out(['data' => [
        'iol'      => first_int($iol),
        'dynamips' => first_int($dynamips),
        'qemu'     => first_int($qemu),
        'docker'   => first_int($docker),
        'vpcs'     => first_int($vpcs),
    ]]);
}

/* ---- GET info: qemu/cores + KSM/UKSM/cpulimit states ------------------------ */
if ($action === 'info') {
    list($o, $rc) = run_cmd('/opt/qemu/bin/qemu-system-x86_64 -version | sed \'s/.* \([0-9]*\.[0-9.]*\.[0-9.]*\).*/\1/g\'');
    $qemu = ($rc === 0 && count($o)) ? trim($o[0]) : '';
    list($o, $rc) = run_cmd('nproc');
    $cores = ($rc === 0 && count($o)) ? (int) trim($o[0]) : '';
    // CPU Limit is a durable appliance policy flag, not a systemd unit state.
    $policy = broker_qemu_cpu_policy_status();
    $cpulimit = 'unsupported';
    if (!empty($policy['ok']) && !empty($policy['out'])) {
        $cpulimit = trim($policy['out'][0]) === 'enabled' ? 'enabled' :
            (trim($policy['out'][0]) === 'disabled' ? 'disabled' : 'unsupported');
    }
    out(['data' => [
        'engine_version' => PNET_RELEASE,
        'qemu_version' => $qemu,
        'cores'        => $cores,
        'uksm'         => read_toggle('/sys/kernel/mm/uksm/run'),
        'ksm'          => read_toggle('/sys/kernel/mm/ksm/run'),
        'cpulimit'     => $cpulimit,
        // Idle/session timeout (seconds) - admin override of the SESSION
        // constant, see includes/functions.php::getSessionTimeoutSeconds().
        'idle_timeout' => getSessionTimeoutSeconds(),
    ]]);
}

/* ---- GET version: component versions for the Version page -------------------- */
if ($action === 'version') {
    $vget = function ($c) { $o = []; $rc = 0; exec($c, $o, $rc); return ($rc === 0 && count($o)) ? trim($o[0]) : ''; };

    // docker server version via the broker's docker_version verb (Stage 5) —
    // no :4243 dial from www-data; '' when the engine endpoint is down.
    $dresp = broker_docker_version();
    $dockerVer = (!empty($dresp['ok']) && count($dresp['out'])) ? trim($dresp['out'][0]) : '';

    // Release / package / kernel are ADMIN-ONLY. All three spell out the real
    // product ("27H1 v8.2", "6.8.51resolute1", and uname's "-pnetlab" suffix),
    // so leaking them to every logged-in user undoes a custom rebrand
    // (/main/#/custom) on the very panel that applies it — and hands anyone with
    // an account an exact build to match advisories against. Admins keep the
    // full identity card: support and diagnostics depend on it.
    //
    // The fields are OMITTED rather than blanked, and the commands are not run
    // at all for non-admins — nothing to strip client-side, nothing to time.
    // This is the authoritative gate; the Version view hiding rows is cosmetic.
    $ident = $isAdmin ? [
        // Friendly product release shown on the main page; the deb version stays
        // in 'pnetlab' for the Version detail page. Single source: includes/version.php.
        'release'  => PNET_RELEASE,
        // Package: show the 26.04 codename (resolute), not the 24.04 one (noble),
        // regardless of the deb's build-time version suffix. Idempotent once the
        // deb itself is rebuilt with a resolute1 suffix.
        'pnetlab'  => str_replace('noble', 'resolute', $vget('dpkg-query -W -f=\'${Version}\' pnetlab 2>/dev/null')),
        // Stock Ubuntu 7.0 kernel, branded for the appliance (no custom kernel on v8).
        'kernel'   => str_replace('-generic', '-pnetlab', $vget('uname -r')),
    ] : [];

    out(['data' => $ident + [
        'os'       => $vget('. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"'),
        'arch'     => $vget('uname -m'),
        'qemu'     => $vget('/opt/qemu/bin/qemu-system-x86_64 -version 2>/dev/null | sed \'s/.* \([0-9]*\.[0-9.]*\.[0-9.]*\).*/\1/g\''),
        'docker'   => $dockerVer,
        'php'      => $vget('php -r \'echo PHP_VERSION;\' 2>/dev/null'),
        // guacd's version flag is lowercase -v (uppercase -V is an invalid option →
        // blank field); pull just the x.y.z out of "guacd ... version 1.6.0".
        'guacd'    => $vget('guacd -v 2>&1 | grep -oE \'[0-9]+\.[0-9]+\.[0-9]+\' | head -1'),
        'hostname' => $vget('hostname'),
    ]]);
}

/* ---- GET sessions: open lab sessions for the Running Labs view --------------
 * Pure-DB aggregation (no live console-port probes) so the view can poll
 * cheaply, mirroring what the legacy Store main page listed:
 *   - lab_sessions  → one row per OPEN lab session (id, owner pod, .unl path)
 *   - node_sessions → per-session node tally; node_session_running is the
 *                     wrapper's 0/1 flag (NULL when never started),
 *                     node_session_host is 0=master / N=satellite N.
 * Owner pod is resolved to a display name via users (users.pod is the PK).
 * Administrators receive every open session; regular users receive rows they
 * own or have joined. Membership is checked as an exact CSV token before a
 * row is copied into the response, so a pod such as 2 cannot match 12. */
if ($action === 'sessions') {
    $db = checkDatabase();

    // Let SQL discard unrelated rows for non-admin polls. The REGEXP pattern
    // matches a complete comma-delimited token (including legacy whitespace
    // and zero padding), never a substring such as pod 2 inside pod 12.
    // Keep the PHP predicate below as defense-in-depth before shaping output.
    if ($isAdmin) {
        $sessionRows = $db->query('SELECT * FROM lab_sessions')->fetchAll(PDO::FETCH_ASSOC);
    } else {
        $sessionTenant = labSessionNormalizePod($tenant);
        if ($sessionTenant === null) {
            out(['data' => []]);
        }
        $joinedPattern = $sessionTenant === '0'
            ? '(^|,)[[:space:]]*0+[[:space:]]*(,|$)'
            : '(^|,)[[:space:]]*0*' . $sessionTenant . '[[:space:]]*(,|$)';
        $sessionQuery = $db->prepare(
            'SELECT * FROM lab_sessions WHERE lab_session_pod = :session_owner_pod' .
            ' OR COALESCE(lab_session_joined, \'\') REGEXP :session_joined_pattern'
        );
        $sessionQuery->execute([
            'session_owner_pod' => (int) $sessionTenant,
            'session_joined_pattern' => $joinedPattern,
        ]);
        $sessionRows = [];
        foreach ($sessionQuery->fetchAll(PDO::FETCH_ASSOC) as $s) {
            if (labSessionVisibleTo($s, $tenant, false)) {
                $sessionRows[] = $s;
            }
        }
    }

    // Resolve owner names only for sessions already proven visible. Admins can
    // use the existing all-owner map; regular users get only the owner pods in
    // their visible rows, including owners of sessions they joined.
    $owners = [];
    $ownerPods = [];
    foreach ($sessionRows as $s) {
        $pod = labSessionNormalizePod(isset($s['lab_session_pod']) ? $s['lab_session_pod'] : null);
        if ($pod !== null) {
            $ownerPods[$pod] = true;
        }
    }
    if ($isAdmin) {
        $ownerRows = $db->query('SELECT pod, username, email, name FROM users')->fetchAll(PDO::FETCH_ASSOC);
    } elseif ($ownerPods) {
        $ownerPlaceholders = [];
        $ownerParams = [];
        foreach (array_keys($ownerPods) as $i => $pod) {
            $key = ':owner_pod_' . $i;
            $ownerPlaceholders[] = $key;
            $ownerParams[$key] = (int) $pod;
        }
        $ownerQuery = $db->prepare(
            'SELECT pod, username, email, name FROM users WHERE pod IN (' . implode(', ', $ownerPlaceholders) . ')'
        );
        $ownerQuery->execute($ownerParams);
        $ownerRows = $ownerQuery->fetchAll(PDO::FETCH_ASSOC);
    } else {
        $ownerRows = [];
    }
    foreach ($ownerRows as $u) {
        $pod = (int) $u['pod'];
        $owners[$pod] = trim((string) $u['username']) ?: (trim((string) $u['name']) ?: (trim((string) $u['email']) ?: ('pod ' . $pod)));
    }

    // Aggregate only the visible session IDs. The IDs come from the same
    // labSessionVisibleTo predicate above, so joined sessions get their node
    // tally while another user's sessions cannot enter this query.
    $tally = [];
    $visibleIds = [];
    foreach ($sessionRows as $s) {
        $visibleIds[(int) $s['lab_session_id']] = true;
    }
    if ($visibleIds) {
        $tallyPlaceholders = [];
        $tallyParams = [];
        foreach (array_keys($visibleIds) as $i => $sid) {
            $key = ':session_id_' . $i;
            $tallyPlaceholders[] = $key;
            $tallyParams[$key] = (int) $sid;
        }
        $tallySql =
            'SELECT node_session_lab AS lab, COUNT(*) AS tot, ' .
            'SUM(CASE WHEN node_session_running = 1 THEN 1 ELSE 0 END) AS run, ' .
            'GROUP_CONCAT(DISTINCT node_session_host) AS hosts ' .
            'FROM node_sessions WHERE node_session_lab IN (' . implode(', ', $tallyPlaceholders) . ')' .
            ' GROUP BY node_session_lab';
        $tq = $db->prepare($tallySql);
        $tq->execute($tallyParams);
        foreach ($tq->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $hosts = array_map('intval', array_filter(explode(',', (string) $r['hosts']), 'strlen'));
            sort($hosts);
            $tally[(int) $r['lab']] = ['tot' => (int) $r['tot'], 'run' => (int) $r['run'], 'hosts' => $hosts];
        }
    }

    $rows = [];
    foreach ($sessionRows as $s) {
        $sid  = (int) $s['lab_session_id'];
        $path = (string) $s['lab_session_path'];
        $name = preg_replace('/\.unl$/i', '', basename($path));
        $pod  = (int) $s['lab_session_pod'];
        $t    = isset($tally[$sid]) ? $tally[$sid] : ['tot' => 0, 'run' => 0, 'hosts' => []];
        $rows[] = [
            'session'       => $sid,
            'name'          => ($name !== '' ? $name : $path),
            'path'          => $path,
            'owner'         => isset($owners[$pod]) ? $owners[$pod] : ('pod ' . $pod),
            'pod'           => $pod,
            'can_manage'    => labSessionCanManage($s, $tenant, $isAdmin),
            'nodes_total'   => $t['tot'],
            'nodes_running' => $t['run'],
            'hosts'         => $t['hosts'],
        ];
    }
    usort($rows, function ($a, $b) { return $b['session'] - $a['session']; });
    out(['data' => $rows]);
}

/* ---- POST toggles: ksm | uksm | cpulimit (admin-only, via broker) ----------- */
if ($action === 'ksm' || $action === 'uksm' || $action === 'cpulimit') {
    if (!$isAdmin) fail(403, 'admin only');
    $body  = json_decode(file_get_contents('php://input'), true);
    $state = is_array($body) && !empty($body['state']);
    $map = [
        'ksm'      => ['ksmon', 'ksmoff'],
        'uksm'     => ['uksmon', 'uksmoff'],
        'cpulimit' => ['cpulimiton', 'cpulimitoff'],
    ];
    $verbAction = $state ? $map[$action][0] : $map[$action][1];
    $o = null; $rc = null;
    broker_exec('wrapper', ['action' => $verbAction], $o, $rc);
    if ($rc === 0) out(['ok' => true]);
    fail(500, 'could not change ' . $action . ' state');
}

/* ---- POST idle_timeout: site-wide idle/session timeout (admin-only) --------
 * Body: {"seconds": int}. A plain control-table write (NOT a root op, so no
 * broker verb) - see includes/functions.php::Ctrl_set()/getSessionTimeoutSeconds().
 * Bounded to [60, 86400] (1 minute .. 24h): too low locks users out between
 * clicks, and the column backing this is a MySQL TEXT read as a PHP int on
 * every authenticated request, so keep it a sane, bounded integer. */
if ($action === 'idle_timeout') {
    if (!$isAdmin) fail(403, 'admin only');
    $body = json_decode(file_get_contents('php://input'), true);
    $seconds = is_array($body) && isset($body['seconds']) ? (int) $body['seconds'] : 0;
    if ($seconds < 60 || $seconds > 86400) {
        fail(400, 'seconds must be between 60 and 86400');
    }
    if (!Ctrl_set(CTRL_SESSION_TIMEOUT, (string) $seconds)) {
        fail(500, 'could not save idle timeout');
    }
    out(['ok' => true, 'data' => ['idle_timeout' => $seconds]]);
}

/* ---- GET netcfg: current server network config (admin, via broker) --------- */
if ($action === 'netcfg_get') {
    if (!$isAdmin) fail(403, 'admin only');
    $resp = broker_call('server_netcfg', ['op' => 'get'], 20);
    if (!$resp['ok'] || empty($resp['out'])) fail(500, 'could not read network config');
    $data = json_decode(end($resp['out']), true);
    out(['data' => is_array($data) ? $data : new stdClass()]);
}

/* ---- POST netcfg: write server network config (admin, via broker) ----------
 * Body: {mode:'dhcp'|'static', address, netmask, gateway, dns:[], domain,
 *        apply:bool}. The broker validates every field, backs up the current
 * files, writes them, and (when apply && the pnet0 stanza changed) bounces the
 * management link in a detached unit. */
if ($action === 'netcfg_set') {
    if (!$isAdmin) fail(403, 'admin only');
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) fail(400, 'bad body');
    $args = [
        'op'      => 'set',
        'mode'    => isset($body['mode']) ? $body['mode'] : 'dhcp',
        'address' => isset($body['address']) ? $body['address'] : '',
        'netmask' => isset($body['netmask']) ? $body['netmask'] : '',
        'gateway' => isset($body['gateway']) ? $body['gateway'] : '',
        'dns'     => isset($body['dns']) && is_array($body['dns']) ? array_values($body['dns']) : [],
        'domain'  => isset($body['domain']) ? $body['domain'] : '',
        'apply'   => !empty($body['apply']) ? 1 : 0,
    ];
    $resp = broker_call('server_netcfg', $args, 30);
    if (!$resp['ok']) {
        fail(400, $resp['err'] !== '' ? $resp['err'] : 'network config rejected');
    }
    $data = (!empty($resp['out'])) ? json_decode(end($resp['out']), true) : ['ok' => true];
    out(['ok' => true, 'result' => $data]);
}

/* ---- POST power: shutdown | restart the server (admin-only, via broker) -----
 * Body: {op:'shutdown'|'reboot'}. verb_system_power spawns a detached unit
 * (pnet-power-<op>) and returns immediately, so this HTTP response is sent
 * before the box actually powers off / reboots. */
if ($action === 'power') {
    if (!$isAdmin) fail(403, 'admin only');
    $body = json_decode(file_get_contents('php://input'), true);
    $op = (is_array($body) && isset($body['op'])) ? (string) $body['op'] : '';
    if ($op !== 'shutdown' && $op !== 'reboot') fail(400, 'bad op');
    $resp = broker_call('system_power', ['op' => $op], 15);
    if (!$resp['ok']) {
        fail(500, $resp['err'] !== '' ? $resp['err'] : 'power command failed');
    }
    out(['ok' => true, 'op' => $op]);
}

/* ---- POST disk_expand: detect or expand root filesystem (admin, via broker) -
 * Body: {op:'detect'|'expand'}.
 *   detect → {ok:true, data:{dev, part, fstype, is_lvm, vg, lv, fs_size_gb,
 *             disk_total_gb, growable_gb, expandable, commands:[...]}}
 *   expand → {ok:true, data:{ok, before_gb, after_gb, steps:[...]}}
 * Broker validates op via v_enum; we do a quick pre-check here to give a
 * friendlier 400 before the 120s broker timeout. */
if ($action === 'disk_expand') {
    if (!$isAdmin) fail(403, 'admin only');
    $body = json_decode(file_get_contents('php://input'), true);
    $op = (is_array($body) && isset($body['op'])) ? (string) $body['op'] : '';
    if ($op !== 'detect' && $op !== 'expand') fail(400, 'bad op — must be detect or expand');
    $resp = broker_call('disk_expand', ['op' => $op], 120);
    if (!$resp['ok']) {
        fail(500, $resp['err'] !== '' ? $resp['err'] : 'disk_expand failed');
    }
    $data = (!empty($resp['out'])) ? json_decode($resp['out'][0], true) : null;
    out(['ok' => true, 'data' => $data]);
}

/* ---- GET history_sys / history_nodes: historical telemetry (admin-only) ----
 * Backed by the pnq-telemetryd SQLite store (/opt/unetlab/data/telemetry/
 * telemetry.db), opened READONLY with a busy_timeout so the daemon's short
 * write transactions never 500 us. Missing DB / stopped daemon degrades to
 * {series:[],collector:'down'} — never an error.
 *   history_sys   ?range=1h|6h|24h|7d|30d   → host CPU/RAM/swap/disk series
 *   history_nodes ?range=...&lab=<id>       → top-N node series by avg CPU
 * 1h/6h read the raw tables (10s/30s step); longer ranges read the 5m rollups.
 */
if ($action === 'history_sys' || $action === 'history_nodes') {
    if (!$isAdmin) fail(403, 'admin only');
    $RANGES = ['1h' => 3600, '6h' => 21600, '24h' => 86400,
               '7d' => 604800, '30d' => 2592000];
    $range = isset($_GET['range']) && isset($RANGES[$_GET['range']]) ? $_GET['range'] : '1h';
    $secs  = $RANGES[$range];
    $raw   = ($secs <= 21600);           // 1h/6h → raw tables
    $dbp   = '/opt/unetlab/data/telemetry/telemetry.db';
    $tdb   = null;
    if (is_file($dbp)) {
        try {
            $tdb = new SQLite3($dbp, SQLITE3_OPEN_READONLY);
            $tdb->busyTimeout(2500);
        } catch (Exception $e) { $tdb = null; }
    }
    if ($tdb === null) {
        out(['data' => ['range' => $range, 'step' => 0, 'series' => [], 'collector' => 'down']]);
    }
    $since = time() - $secs;

    if ($action === 'history_sys') {
        $step = $raw ? 10 : 300;
        $sql = $raw
            ? 'SELECT ts, cpu, cpu AS cpu_max, ram_used, ram_total, swap_used, disk_used, disk_total, load1
               FROM sys_raw WHERE ts >= :s ORDER BY ts'
            : 'SELECT ts, cpu_avg AS cpu, cpu_max, ram_used, ram_total, swap_used, disk_used, disk_total, NULL AS load1
               FROM sys_5m WHERE ts >= :s ORDER BY ts';
        $series = [];
        $latest = 0;
        try {
            $st = $tdb->prepare($sql);
            $st->bindValue(':s', $since, SQLITE3_INTEGER);
            $rs = $st->execute();
            while ($rs && ($row = $rs->fetchArray(SQLITE3_ASSOC))) {
                $latest = (int) $row['ts'];
                $series[] = [
                    'ts'         => (int) $row['ts'],
                    'cpu'        => round((float) $row['cpu'], 1),
                    'cpu_max'    => round((float) $row['cpu_max'], 1),
                    'ram_used'   => (int) $row['ram_used'],
                    'ram_total'  => (int) $row['ram_total'],
                    'swap_used'  => (int) $row['swap_used'],
                    'disk_used'  => (int) $row['disk_used'],
                    'disk_total' => (int) $row['disk_total'],
                    'load1'      => $row['load1'] !== null ? (float) $row['load1'] : null,
                ];
            }
        } catch (Exception $e) { $series = []; }
        // daemon considered live if the newest raw sample is < 60s old
        $coll = 'ok';
        try {
            $last = $tdb->querySingle('SELECT MAX(ts) FROM sys_raw');
            if ($last === null || (time() - (int) $last) > 60) $coll = 'down';
        } catch (Exception $e) { $coll = 'down'; }
        out(['data' => ['range' => $range, 'step' => $step,
                        'series' => $series, 'collector' => $coll]]);
    }

    /* history_nodes */
    $step = $raw ? 30 : 300;
    $lab  = isset($_GET['lab']) ? (int) $_GET['lab'] : 0;
    $tbl  = $raw ? 'node_raw' : 'node_5m';
    $cpuc = $raw ? 'cpu' : 'cpu_avg';
    $memc = $raw ? 'mem_mb' : 'mem_avg';
    // node_raw only holds ~2h; a 6h "raw" request degrades gracefully to what exists
    $labW = $lab > 0 ? ' AND lab = :lab' : '';
    $nodes = [];
    try {
        // top 10 (lab,nid) by average cpu over the window
        $st = $tdb->prepare(
            "SELECT lab, nid, MAX(type) AS type, AVG($cpuc) AS cpu_avg
             FROM $tbl WHERE ts >= :s$labW GROUP BY lab, nid
             ORDER BY cpu_avg DESC LIMIT 10");
        $st->bindValue(':s', $since, SQLITE3_INTEGER);
        if ($lab > 0) $st->bindValue(':lab', $lab, SQLITE3_INTEGER);
        $rs = $st->execute();
        $tops = [];
        while ($rs && ($row = $rs->fetchArray(SQLITE3_ASSOC))) $tops[] = $row;
        foreach ($tops as $t) {
            $sst = $tdb->prepare(
                "SELECT ts, $cpuc AS cpu, $memc AS mem_mb FROM $tbl
                 WHERE ts >= :s AND lab = :lab AND nid = :nid ORDER BY ts");
            $sst->bindValue(':s', $since, SQLITE3_INTEGER);
            $sst->bindValue(':lab', (int) $t['lab'], SQLITE3_INTEGER);
            $sst->bindValue(':nid', (int) $t['nid'], SQLITE3_INTEGER);
            $srs = $sst->execute();
            $ser = [];
            while ($srs && ($row = $srs->fetchArray(SQLITE3_ASSOC))) {
                $ser[] = ['ts' => (int) $row['ts'],
                          'cpu' => round((float) $row['cpu'], 1),
                          'mem_mb' => (int) $row['mem_mb']];
            }
            $nodes[] = ['lab' => (int) $t['lab'], 'nid' => (int) $t['nid'],
                        'type' => (string) $t['type'],
                        'cpu_avg' => round((float) $t['cpu_avg'], 1),
                        'series' => $ser];
        }
    } catch (Exception $e) { $nodes = []; }
    out(['data' => ['range' => $range, 'step' => $step, 'nodes' => $nodes]]);
}

fail(400, 'unknown action');
