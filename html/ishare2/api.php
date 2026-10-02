<?php
/**
 * ishare2 Image Store — backend API for the PNetLab GUI image downloader.
 *
 * Endpoints (all return JSON):
 *   ?action=catalog            → list QEMU + IOL images (id,name,size,installed)
 *   ?action=download type id   → start a background download, returns {job}
 *   ?action=status&job=ID      → progress of a running/finished job
 *
 * Data source: labhub.json catalog (GitHub release asset of ishare2-org/mirrors),
 * cached locally and refreshed every 6h. Downloads run via worker.sh as root,
 * detached through the pnetlab-brokerd privilege broker.
 */
error_reporting(E_ERROR | E_PARSE);
header('Content-Type: application/json');
header('Cache-Control: no-store');

$BASE        = __DIR__;
$CAT         = "$BASE/labhub.json";
$JOBS        = "$BASE/jobs";
$WORKER      = "$BASE/worker.sh";
$RELEASE_API = 'https://api.github.com/repos/ishare2-org/mirrors/releases/latest';

// Shared qemu image-folder normaliser (EVE-NG linux- convention). Same helper
// worker.sh calls, so the catalog/install-state shown here and the folder the
// download actually lands in can never disagree.
require_once "$BASE/image_normalize.php";
// Engine bootstrap: defines indentify class (in __lab.php via init.php) and
// the privilege-broker client.  init.php does not pull broker.php, so load both.
require_once '/opt/unetlab/html/includes/init.php';
require_once '/opt/unetlab/html/includes/broker.php';

/* ---- AUTH — admin-only (same pattern as import/api.php and cluster/api.php) ---------- */
$_ishare2_indent = new \indentify();
list($_ishare2_user, , ) = $_ishare2_indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($_ishare2_user === false || empty($_ishare2_user)) {
    http_response_code(401); echo json_encode(['error' => 'not authenticated']); exit;
}
$_ishare2_role = isset($_ishare2_user['role']) ? $_ishare2_user['role'] : '';
if (!($_ishare2_role === 0 || $_ishare2_role === '0' || strtolower((string) $_ishare2_role) === 'admin')) {
    http_response_code(403); echo json_encode(['error' => 'image store is admin-only']); exit;
}
unset($_ishare2_indent, $_ishare2_user, $_ishare2_role);

@mkdir($JOBS, 0777, true);

function out($x){ echo json_encode($x); exit; }
function fail($m, $code = 400){ http_response_code($code); echo json_encode(['error' => $m]); exit; }

function curl_get($url, $toFile = null){
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_USERAGENT      => 'pnetlab-ishare2-gui',
        CURLOPT_CONNECTTIMEOUT => 6,      // fail fast when the box is offline
        CURLOPT_TIMEOUT        => 120,
    ]);
    $fp = null;
    if ($toFile) {
        // php8.1: curl_setopt(CURLOPT_FILE, false) is a fatal TypeError. If the catalog
        // dir isn't writable (e.g. root-owned after a cp -a install), fail soft so the
        // caller serves the cached/stale copy instead of crashing the whole endpoint (500).
        $fp = @fopen($toFile, 'w');
        if ($fp === false) { curl_close($ch); return [0, false]; }
        curl_setopt($ch, CURLOPT_FILE, $fp);
    } else {
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    }
    $r    = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($fp) fclose($fp);
    return [$code, $r];
}

// returns: 'cached' (fresh local copy) | 'fresh' (just downloaded) |
//          'stale' (refresh failed, serving old copy) | 'none' (no copy at all)
function refresh_catalog($CAT, $RELEASE_API){
    if (file_exists($CAT) && (time() - filemtime($CAT) < 21600)) return 'cached';
    [$c, $j] = curl_get($RELEASE_API);
    if ($c != 200) return file_exists($CAT) ? 'stale' : 'none';
    $rel = json_decode($j, true);
    $url = null;
    foreach (($rel['assets'] ?? []) as $a) {
        if (($a['name'] ?? '') === 'labhub.json') { $url = $a['browser_download_url']; break; }
    }
    if (!$url) return file_exists($CAT) ? 'stale' : 'none';
    [$c2, ] = curl_get($url, "$CAT.tmp");
    if ($c2 == 200 && @filesize("$CAT.tmp") > 1000) { rename("$CAT.tmp", $CAT); return 'fresh'; }
    @unlink("$CAT.tmp");
    return file_exists($CAT) ? 'stale' : 'none';
}

$action = $_GET['action'] ?? '';

if ($action === 'catalog') {
    $status = refresh_catalog($CAT, $RELEASE_API);
    if ($status === 'none' || !file_exists($CAT)) fail('catalog unavailable — check server internet access', 502);
    $d = json_decode(file_get_contents($CAT), true);
    if (!$d) fail('catalog parse error', 500);
    $res = ['updated' => $d['last_update'] ?? '', 'stale' => ($status === 'stale'), 'qemu' => [], 'iol' => []];
    foreach (['QEMU' => 'qemu', 'IOL' => 'iol'] as $k => $kk) {
        foreach (($d[$k] ?? []) as $e) {
            $name = $e['name'];
            $ip   = $e['metadata']['install_path'] ?? '';
            if ($kk === 'iol') {
                $fn = $e['files'][0]['filename'] ?? '';
                $installed = $fn && file_exists("/opt/unetlab/addons/iol/bin/$fn");
            } else {
                // Normalise Linux orphans (e.g. alpine-*) to the linux- folder so
                // the name shown + the is_dir() check match where worker.sh lands
                // the files (and so the image maps to the linux/vnc template).
                $name = pnq_normalize_qemu_dirname($name);
                if ($ip !== '') {
                    $ip = rtrim(dirname($ip), '/') . '/' . pnq_normalize_qemu_dirname(basename(rtrim($ip, '/')));
                }
                $installed = $ip && is_dir($ip) && count(glob(rtrim($ip, '/') . '/*')) > 0;
            }
            $res[$kk][] = [
                'id'        => (int)$e['id'],
                'name'      => $name,
                'size'      => $e['metadata']['total_human_size'] ?? ($e['files'][0]['human_size'] ?? ''),
                'bytes'     => (int)($e['metadata']['total_size'] ?? 0),
                'installed' => (bool)$installed,
            ];
        }
    }
    out($res);
}

if ($action === 'download' || $action === 'delete') {
    // The dashboard posts a JSON body (App.api Content-Type: application/json),
    // which PHP does NOT fold into $_POST — read php://input like cluster/api.php.
    $body = json_decode(file_get_contents('php://input'), true) ?: [];
    $type = $body['type'] ?? $_POST['type'] ?? $_GET['type'] ?? '';
    $id   = $body['id']   ?? $_POST['id']   ?? $_GET['id']   ?? '';
    if (!in_array($type, ['qemu', 'iol', 'dynamips'], true)) fail('bad type');
    if (!ctype_digit((string)$id)) fail('bad id');
    $op  = ($action === 'delete') ? 'delete' : 'download';
    $job = bin2hex(random_bytes(8));                  // server-generated, 16 hex
    file_put_contents("$JOBS/$job.json", json_encode([
        'state' => ($op === 'delete' ? 'deleting' : 'queued'), 'pct' => 0,
        'type' => $type, 'id' => (int)$id, 'msg' => $op,
    ]));
    @chmod("$JOBS/$job.json", 0666);
    // detach as root via the privilege broker (validates type/id/job/op)
    $resp = broker_call('worker_ishare2', [
        'type' => $type, 'id' => (int)$id, 'job' => $job, 'op' => $op,
    ]);
    if (!$resp['ok']) fail('worker failed to start: ' . $resp['err']);
    out(['job' => $job]);
}

if ($action === 'status') {
    $job = $_GET['job'] ?? '';
    if (!preg_match('/^[a-f0-9]{16}$/', $job)) fail('bad job');
    $f = "$JOBS/$job.json";
    if (!file_exists($f)) fail('no such job', 404);
    echo file_get_contents($f);
    exit;
}

fail('unknown action');
