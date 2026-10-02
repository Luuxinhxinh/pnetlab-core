<?php
/**
 * cluster/api.php — backend for the System -> Cluster admin page and the
 * satellite join handshake.
 *
 *   POST ?action=join                {body:{...},hmac} → {db_pass,rsync_pubkey}
 *   GET  ?action=status                                → {psk_set,satellites[]}
 *   POST ?action=genpsk                                → {psk}   (shown once)
 *   POST ?action=remove              {host}            → {ok}
 *   GET  ?action=sync_status&job=<16hex>               → image-sync job JSON
 *
 * `join` is the ONLY unauthenticated-cookie action: it is called by
 * pnet-satellite-join from a freshly installed satellite that has no PNetLab
 * account. Its authentication is the HMAC over the cluster PSK, verified by
 * brokerd's cluster_join verb (root — the PSK file is never readable by
 * www-data), with a ±300 s timestamp window against replay. Everything else
 * reuses the engine's own cookie/session check, admin-only — the same pattern
 * as import/api.php.
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

$JOBS = __DIR__ . '/jobs';

function out($x) { echo json_encode($x); exit; }
function fail($code, $m) { http_response_code($code); echo json_encode(['error' => $m]); exit; }

$action = isset($_GET['action']) ? $_GET['action'] : '';

/* ---- join: PSK-HMAC authenticated, no cookie --------------------------------- */
if ($action === 'join') {
    $req = json_decode(file_get_contents('php://input'), true);
    if (!is_array($req) || !isset($req['body']) || !isset($req['hmac']) ||
            !is_array($req['body']) || !is_string($req['hmac'])) {
        fail(400, 'bad join request');
    }
    $resp = broker_call('cluster_join', [
        'body' => $req['body'], 'hmac' => $req['hmac'],
        'self_ip' => isset($_SERVER['SERVER_ADDR']) ? $_SERVER['SERVER_ADDR'] : '',
    ], 180);
    if (!$resp['ok']) {
        fail(403, $resp['err'] !== '' ? $resp['err'] : 'join rejected');
    }
    $grant = json_decode($resp['out'][count($resp['out']) - 1], true);
    if (!is_array($grant)) {
        fail(500, 'broker returned a bad join grant');
    }

    // registry row for the UI / engine helpers (brokerd already validated these)
    $b = $req['body'];
    try {
        $db = checkDatabase();
        $statement = $db->prepare(
            'REPLACE INTO cluster_hosts ' .
            '(host_id, host_name, host_ip, host_status, host_last_seen, host_version, host_joined) ' .
            'VALUES (:id, :name, :ip, 1, UNIX_TIMESTAMP(), :version, UNIX_TIMESTAMP())'
        );
        $statement->execute([
            'id' => (int) $b['host_id'], 'name' => (string) $b['name'],
            'ip' => (string) $b['ip'], 'version' => (string) $b['version'],
        ]);
    } catch (Exception $e) {
        error_log(date('M d H:i:s ') . 'ERROR: cluster join DB upsert: ' . $e);
        fail(500, 'could not record the satellite');
    }
    out($grant);
}

/* ---- AUTH — engine cookie/session check, admin only -------------------------- */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    fail(401, 'not authenticated');
}
$role    = isset($user['role']) ? $user['role'] : '';
$isAdmin = ($role === 0 || $role === '0' || strtolower((string) $role) === 'admin');
if (!$isAdmin) {
    fail(403, 'cluster management is admin-only');
}

if ($action === 'status') {
    $resp = broker_call('cluster_info');
    $info = $resp['ok'] ? json_decode($resp['out'][count($resp['out']) - 1], true) : [];
    $rows = [];
    try {
        $db = checkDatabase();
        $rows = $db->query('SELECT * FROM cluster_hosts ORDER BY host_id')
                   ->fetchAll(PDO::FETCH_ASSOC);
    } catch (Exception $e) {
        // pre-migration DB: show an empty cluster rather than a 500
    }
    // master_version = friendly release for DISPLAY; master_pkg = the deb version,
    // used for cluster version-skew detection against each satellite's host_version.
    require_once '/opt/unetlab/html/includes/version.php';   // PNET_RELEASE
    $masterPkg = '';
    exec('dpkg-query -W -f \'${Version}\' pnetlab 2>/dev/null', $mvOut, $mvRc);
    if ($mvRc === 0 && count($mvOut)) {
        $masterPkg = trim($mvOut[0]);
    }
    out([
        'psk_set' => is_array($info) && !empty($info['psk_set']),
        'master_version' => PNET_RELEASE,
        'master_pkg' => $masterPkg,
        'satellites' => $rows,
    ]);
}

if ($action === 'genpsk') {
    $resp = broker_call('cluster_psk_new');
    if (!$resp['ok'] || count($resp['out']) === 0) {
        fail(500, 'could not generate a PSK: ' . $resp['err']);
    }
    out(['psk' => $resp['out'][count($resp['out']) - 1]]);
}

if ($action === 'remove') {
    $body = json_decode(file_get_contents('php://input'), true);
    $host = is_array($body) && isset($body['host']) ? (int) $body['host'] : 0;
    if ($host < 1 || $host > 5) fail(400, 'bad host');

    // refuse while the satellite still runs nodes — stop those labs first
    try {
        $db = checkDatabase();
        $statement = $db->prepare(
            'SELECT COUNT(*) FROM node_sessions ' .
            'WHERE node_session_host = :h AND node_session_running > 0'
        );
        $statement->execute(['h' => $host]);
        if ((int) $statement->fetchColumn() > 0) {
            fail(409, 'satellite still has running nodes — stop them first');
        }
        $resp = broker_call('cluster_remove', ['host' => $host]);
        if (!$resp['ok']) fail(500, 'broker: ' . $resp['err']);
        $statement = $db->prepare('DELETE FROM cluster_hosts WHERE host_id = :h');
        $statement->execute(['h' => $host]);
        // Revert placements and live session-host mirrors to master (0).
        // The 409 gate above guarantees no nodes are running on this host.
        cluster_placement_clear_host($host);
        $statement = $db->prepare(
            'UPDATE node_sessions SET node_session_host = 0 WHERE node_session_host = :h'
        );
        $statement->execute(['h' => $host]);
    } catch (Exception $e) {
        fail(500, 'remove failed: ' . $e->getMessage());
    }
    out(['ok' => true]);
}

if ($action === 'deploy') {
    // Push-deploy a satellite from the master: copy the staged bundle over
    // SSH with admin-supplied credentials, install, join, reboot. Mirrors
    // import/api.php's credential handling: the password reaches the root
    // worker only through a 0600 jobs/<job>.req it shreds on read.
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) fail(400, 'bad request body');
    $ip   = isset($body['ip']) ? trim($body['ip']) : '';
    $u    = isset($body['user']) ? trim($body['user']) : 'root';
    $pass = isset($body['pass']) ? (string) $body['pass'] : '';
    $sudo = isset($body['sudo_pass']) ? (string) $body['sudo_pass'] : '';
    $host = isset($body['host_id']) ? (int) $body['host_id'] : 0;
    $name = isset($body['name']) ? trim($body['name']) : '';
    if (!preg_match('/^[0-9.]{7,15}$/', $ip)) fail(400, 'invalid satellite IP');
    if (!preg_match('/^[a-z_][a-z0-9_-]{0,31}$/', $u)) fail(400, 'invalid SSH user');
    if ($pass === '') fail(400, 'SSH password required');
    if ($host < 1 || $host > 5) fail(400, 'bad satellite slot');
    if ($name !== '' && !preg_match('/^[A-Za-z0-9 ._-]{1,64}$/', $name)) fail(400, 'invalid name');
    try {
        $db = checkDatabase();
        $statement = $db->prepare('SELECT COUNT(*) FROM cluster_hosts WHERE host_id = :h');
        $statement->execute(['h' => $host]);
        if ((int) $statement->fetchColumn() > 0) {
            fail(409, 'slot ' . $host . ' already has a satellite — remove it first');
        }
    } catch (Exception $e) {
        // pre-migration DB falls through; the worker re-checks the target
    }

    @mkdir(__DIR__ . '/jobs', 0777, true);
    $job = bin2hex(random_bytes(8));
    file_put_contents("$JOBS/$job.json", json_encode(['state' => 'queued', 'pct' => 0, 'msg' => 'queued']));
    @chmod("$JOBS/$job.json", 0666);
    file_put_contents("$JOBS/$job.req", json_encode([
        'ip' => $ip, 'user' => $u, 'pass' => $pass, 'sudo_pass' => $sudo,
        'host_id' => $host, 'name' => $name !== '' ? $name : ('Satellite ' . $host),
    ]));
    @chmod("$JOBS/$job.req", 0600);

    $resp = broker_call('cluster_deploy', ['job' => $job]);
    if (!$resp['ok']) {
        @unlink("$JOBS/$job.req");
        fail(500, 'deploy worker failed to start: ' . $resp['err']);
    }
    out(['job' => $job]);
}

if ($action === 'sync_status') {
    $job = isset($_GET['job']) ? $_GET['job'] : '';
    if (!preg_match('/^[a-f0-9]{16}$/', $job)) fail(400, 'bad job');
    $f = "$JOBS/$job.json";
    if (!file_exists($f)) fail(404, 'no such job');
    $jdata = json_decode(file_get_contents($f), true);
    // finalize hook: run fixpermissions on the satellite once after a push completes
    if (is_array($jdata) && ($jdata['state'] ?? '') === 'done') {
        $meta = "$JOBS/$job.meta.json";
        if (file_exists($meta)) {
            $mfp = fopen($meta, 'r+');
            if ($mfp && flock($mfp, LOCK_EX | LOCK_NB)) {
                $md = json_decode(fread($mfp, 8192), true);
                if (is_array($md) && empty($md['finalized']) && ($md['attempts'] ?? 0) < 3
                        && ($md['type'] ?? '') !== 'docker') {
                    $md['attempts'] = ($md['attempts'] ?? 0) + 1;
                    $frc = null;
                    cluster_exec((int) $md['host'], 'wrapper', ['action' => 'fixpermissions'], $fo, $frc, 60);
                    if ($frc === 0) {
                        $md['finalized'] = true;
                    }
                    fseek($mfp, 0); ftruncate($mfp, 0);
                    fwrite($mfp, json_encode($md));
                }
                flock($mfp, LOCK_UN);
                fclose($mfp);
            }
        }
    }
    echo json_encode($jdata ?? []);
    exit;
}

if ($action === 'list_images') {
    // Master image inventory + per-satellite presence (from their cached sysinfo or a quick image_list call)
    $addons = '/opt/unetlab/addons';
    $images = [];
    // qemu
    $qd = $addons . '/qemu';
    if (is_dir($qd)) {
        foreach (array_diff(scandir($qd), ['.', '..']) as $d) {
            $dd = $qd . '/' . $d;
            if (is_dir($dd) && count(scandir($dd)) > 2) {
                $sz = 0;
                foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dd,
                        FilesystemIterator::SKIP_DOTS)) as $fi) { $sz += $fi->getSize(); }
                $images[] = ['type' => 'qemu', 'name' => $d, 'size' => $sz];
            }
        }
    }
    // iol
    $id = $addons . '/iol/bin';
    if (is_dir($id)) {
        foreach (glob($id . '/*.bin') ?: [] as $f) {
            $images[] = ['type' => 'iol', 'name' => basename($f), 'size' => filesize($f)];
        }
    }
    // dynamips
    $dd2 = $addons . '/dynamips';
    if (is_dir($dd2)) {
        foreach (glob($dd2 . '/*.image') ?: [] as $f) {
            $images[] = ['type' => 'dynamips', 'name' => basename($f), 'size' => filesize($f)];
        }
    }
    // docker — broker read-only docker_image_ls verb (Stage 5), same
    // {{.Repository}}:{{.Tag}} lines the direct exec produced
    $dresp = broker_docker_image_ls('refs');
    $dout = (!empty($dresp['ok']) && isset($dresp['out'])) ? $dresp['out'] : [];
    foreach ($dout as $line) {
        $line = trim($line);
        if ($line !== '') $images[] = ['type' => 'docker', 'name' => $line, 'size' => 0];
    }
    // satellite inventory from recent cluster_exec (best-effort, may be offline)
    $satInventory = [];
    try {
        $db = checkDatabase();
        $rows = $db->query('SELECT host_id, host_name FROM cluster_hosts ORDER BY host_id')
                   ->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $row) {
            $hid = (int) $row['host_id'];
            $satInventory[$hid] = ['name' => $row['host_name'], 'offline' => true, 'images' => []];
        }
    } catch (Exception $e) {}
    out(['images' => $images, 'satellites' => $satInventory]);
}

if ($action === 'check_images') {
    $body = json_decode(file_get_contents('php://input'), true);
    $host = is_array($body) && isset($body['host']) ? (int) $body['host'] : 0;
    if ($host < 1 || $host > 5) fail(400, 'bad host');
    $result = cluster_exec($host, 'image_list', [], $o, $rc, 30);
    if ($rc === 255) { out(['host' => $host, 'offline' => true]); }
    if ($rc === 254) {
        // old satellite without image_list — fall back gracefully
        out(['host' => $host, 'offline' => false, 'images' => [], 'legacy' => true]);
    }
    $inv = json_decode($result ?: '', true);
    if (!is_array($inv)) $inv = [];
    $flat = [];
    foreach (['qemu', 'iol', 'dynamips', 'docker'] as $t) {
        foreach (($inv[$t] ?? []) as $name) {
            $flat[] = ['type' => $t, 'name' => $name];
        }
    }
    out(['host' => $host, 'offline' => false, 'images' => $flat]);
}

if ($action === 'push_image') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) fail(400, 'bad request body');
    $type = isset($body['type']) ? (string) $body['type'] : '';
    $image = isset($body['image']) ? (string) $body['image'] : '';
    $host = isset($body['host']) ? (int) $body['host'] : 0;
    if (!in_array($type, ['qemu', 'iol', 'dynamips', 'docker'], true)) fail(400, 'bad type');
    if ($host < 1 || $host > 5) fail(400, 'bad host');
    // validate image name: alphanumeric + safe chars, no ..
    if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9_.:\/ +-]{0,127}$/', $image) || strpos($image, '..') !== false) {
        fail(400, 'invalid image name');
    }
    // verify satellite is joined
    try {
        $db = checkDatabase();
        $st = $db->prepare('SELECT COUNT(*) FROM cluster_hosts WHERE host_id = :h');
        $st->execute(['h' => $host]);
        if ((int) $st->fetchColumn() === 0) fail(404, 'satellite not joined');
    } catch (Exception $e) {
        fail(500, 'db error: ' . $e->getMessage());
    }
    // idempotent job id (same formula as cluster_image_gate)
    $job = substr(sha1($host . '|' . $type . '|' . $image), 0, 16);
    @mkdir($JOBS, 0777, true);
    $jobFile = "$JOBS/$job.json";
    // join an in-progress job
    if (file_exists($jobFile)) {
        $j = json_decode(@file_get_contents($jobFile), true);
        if (is_array($j) && in_array($j['state'] ?? '', ['queued', 'running', 'finalizing'], true)) {
            out(['job' => $job, 'joined' => true]);
        }
    }
    file_put_contents($jobFile, json_encode(['state' => 'queued', 'pct' => 0, 'msg' => 'queued']));
    @chmod($jobFile, 0666);
    // sidecar for finalize hook
    $metaFile = "$JOBS/$job.meta.json";
    file_put_contents($metaFile, json_encode([
        'host' => $host, 'type' => $type, 'image' => $image,
        'finalized' => false, 'attempts' => 0,
    ]));
    @chmod($metaFile, 0666);
    $resp = broker_call('cluster_sync_image', [
        'host' => $host, 'type' => $type, 'image' => $image, 'job' => $job,
    ], 60);
    if (!$resp['ok']) {
        @unlink($jobFile);
        @unlink($metaFile);
        fail(500, 'sync worker failed to start: ' . $resp['err']);
    }
    out(['job' => $job]);
}

if ($action === 'sync_sat') {
    // Push the matching satellite + bridge deb pair to a joined satellite and
    // restart satd.  The bridge package is deliberately selected by package
    // metadata, not just by its filename: a satellite that receives the
    // engine package without the matching DKMS source can still boot while
    // silently losing LACP forwarding.
    // Mirrors push_image: job file + broker spawn + poll via sync_status.

    /* dpkg-deb -f prints one bare value when exactly one field is requested. */
    $debField = function ($path, $field) {
        if (!is_string($path) || !is_file($path) || is_link($path)) return '';
        $out = [];
        $rc = 1;
        exec('dpkg-deb -f ' . escapeshellarg($path) . ' ' .
             escapeshellarg($field) . ' 2>/dev/null', $out, $rc);
        return ($rc === 0 && isset($out[0])) ? trim($out[0]) : '';
    };
    $debCandidates = function ($package) use ($debField) {
        $roots = [
            '/opt/unetlab/data/satellite',
            // Older masters staged only the satellite deb in data/satellite;
            // the atomically published release bundle still has the optional
            // bridge deb and is root-owned/read-only to the web tier.
            '/opt/unetlab/cluster-bundle/current/pnetlab-debs',
            // pnetlab-update retains verified package bytes by release.  Keep
            // this fallback read-only; the broker applies the same root jail.
            '/var/cache/pnetlab/debs',
        ];
        $files = [];
        foreach ($roots as $root) {
            $patterns = [$root . '/' . $package . '_*.deb'];
            if ($root === '/var/cache/pnetlab/debs') {
                $patterns[] = $root . '/*/' . $package . '_*.deb';
            }
            foreach ($patterns as $pattern) {
                foreach ((glob($pattern) ?: []) as $path) {
                    if (is_file($path) && !is_link($path)) $files[$path] = true;
                }
            }
        }
        return array_keys($files);
    };
    $selectDebPair = function ($expectedVersion) use ($debField, $debCandidates) {
        $satellites = $debCandidates('pnetlab-satellite');
        $bridges = $debCandidates('pnetlab-bridge-dkms');
        $bridgeByVersion = [];
        foreach ($bridges as $path) {
            if ($debField($path, 'Package') !== 'pnetlab-bridge-dkms') continue;
            $version = $debField($path, 'Version');
            $arch = $debField($path, 'Architecture');
            if ($version === '' || !in_array($arch, ['all', 'amd64'], true)) continue;
            $bridgeByVersion[$version][] = $path;
        }
        // Prefer the installed master release.  This prevents a stale cached
        // satellite deb from being pushed after the master has been updated.
        usort($satellites, function ($a, $b) use ($debField) {
            return strcmp(basename($b), basename($a));
        });
        foreach ($satellites as $satellite) {
            if ($debField($satellite, 'Package') !== 'pnetlab-satellite') continue;
            $version = $debField($satellite, 'Version');
            $arch = $debField($satellite, 'Architecture');
            if ($version === '' || ($expectedVersion !== '' && $version !== $expectedVersion) ||
                    $arch !== 'amd64' || empty($bridgeByVersion[$version])) continue;
            return [$satellite, $bridgeByVersion[$version][0], $version];
        }
        return [null, null, ''];
    };
    $body = json_decode(file_get_contents('php://input'), true);
    $host = is_array($body) && isset($body['host']) ? (int) $body['host'] : 0;
    if ($host < 1 || $host > 5) fail(400, 'bad host');

    // confirm the satellite is joined
    try {
        $db = checkDatabase();
        $st = $db->prepare('SELECT COUNT(*) FROM cluster_hosts WHERE host_id = :h');
        $st->execute(['h' => $host]);
        if ((int) $st->fetchColumn() === 0) fail(404, 'satellite not joined');
    } catch (Exception $e) {
        fail(500, 'db error: ' . $e->getMessage());
    }

    // Select the package version installed on the master, then require the
    // bridge package to carry exactly that same version.  If the master was
    // installed from an older bundle and its bridge bytes are absent, fail
    // clearly instead of deploying an engine-only upgrade.
    $masterVersion = '';
    $masterOut = [];
    $masterRc = 1;
    exec("dpkg-query -W -f='\${Version}' pnetlab 2>/dev/null", $masterOut, $masterRc);
    if ($masterRc === 0 && isset($masterOut[0])) $masterVersion = trim($masterOut[0]);
    [$debFile, $bridgeDebFile, $syncVersion] = $selectDebPair($masterVersion);
    if ($debFile === null) {
        if ($masterVersion !== '') {
            fail(404, 'matching pnetlab-satellite and pnetlab-bridge-dkms debs for master ' . $masterVersion . ' are unavailable');
        }
        fail(404, 'matching pnetlab-satellite and pnetlab-bridge-dkms debs are unavailable');
    }

    @mkdir($JOBS, 0777, true);
    $job = bin2hex(random_bytes(8));
    $jobFile = "$JOBS/$job.json";
    file_put_contents($jobFile, json_encode(['state' => 'queued', 'pct' => 0, 'msg' => 'queued']));
    @chmod($jobFile, 0666);

    // Also push the master's current docker-template capability manifest so
    // the satellite's dangerous/free-form docker-template gate tracks the
    // master after a gen-template-manifest re-run (the deb-shipped copy can
    // lag). Best-effort: a hiccup here must not block the deb push itself.
    $mresp = broker_call('cluster_sync_manifest', ['host' => $host], 60);
    if (!$mresp['ok']) {
        error_log(date('M d H:i:s ') . 'WARN: cluster_sync_manifest to host ' .
            $host . ' failed: ' . $mresp['err']);
    }

    $resp = broker_call('cluster_sync_satellite', [
        'host' => $host, 'job' => $job, 'deb_source' => $debFile,
        'bridge_deb_source' => $bridgeDebFile,
    ], 60);
    if (!$resp['ok']) {
        @unlink($jobFile);
        fail(500, 'sync worker failed to start: ' . $resp['err']);
    }
    out(['job' => $job]);
}

fail(400, 'unknown action');
