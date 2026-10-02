<?php
/**
 * import/api.php — admin-gated "Import Data" backend.
 *
 * SSHes to an OLD PNetLab server (host/user/password supplied by the admin) and
 * pulls selected QEMU image folders, IOL *.bin files, and *.unl labs into THIS
 * server's proper addons/labs folders, then fixes permissions.
 *
 * Mirrors the ishare2 image-store model: a synchronous "discover" listing, then a
 * detached root worker.sh driven by a JSON job file the browser polls.
 *
 *   POST ?action=discover  {host,user,pass,port?}        → list remote qemu/iol/labs
 *   POST ?action=import     {host,user,pass,port?,images[],labs[]} → {job}
 *   GET  ?action=status&job=<16hex>                      → job progress JSON
 *
 * Docker is intentionally out of scope (qemu + iol images + labs only).
 * SECURITY: admin-only, gated with the engine's OWN cookie/session check
 * (indentify::authorization + admin role) — the same pattern console/token_mint.php
 * uses for the host-shell lane. The remote password is never placed on a command
 * line: discover passes it to ssh via the SSHPASS env (proc_open), and import hands
 * it to the worker through a 0600 jobs/<job>.req file the worker shreds immediately.
 */

// init.php loads includes/config.php via a CWD-relative path, exactly like api.php
// (which runs from /opt/unetlab/html). Match that so config overrides are honoured.
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

$BASE   = __DIR__;
$JOBS   = "$BASE/jobs";
$WORKER = "$BASE/worker.sh";
@mkdir($JOBS, 0777, true);

function out($x) { echo json_encode($x); exit; }
function fail($code, $m) { http_response_code($code); echo json_encode(['error' => $m]); exit; }

/* ---- AUTH — reuse the engine's real cookie/session check (admin only) ------- */
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
    fail(403, 'import is admin-only');
}

$action = isset($_GET['action']) ? $_GET['action'] : '';

/* ---- read connection details from a POST JSON body -------------------------- */
function read_conn() {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) fail(400, 'bad request body');
    $host = isset($body['host']) ? trim($body['host']) : '';
    $u    = isset($body['user']) ? trim($body['user']) : '';
    $pass = isset($body['pass']) ? (string) $body['pass'] : '';
    $port = isset($body['port']) ? (int) $body['port'] : 22;
    if ($port <= 0 || $port > 65535) $port = 22;
    if ($host === '' || $u === '' || $pass === '') fail(400, 'missing host, username, or password');
    // a hostname/IP — keep it shell-safe even though we never shell-concat it
    if (!preg_match('/^[A-Za-z0-9_.:\-]+$/', $host)) fail(400, 'invalid host');
    return [$host, $u, $pass, $port, $body];
}

/* ---- run one remote command over sshpass+ssh; password via SSHPASS env ------ */
function ssh_capture($host, $port, $u, $pass, $remoteCmd, &$rc) {
    $cmd = 'sshpass -e ssh -p ' . (int) $port
         . ' -o StrictHostKeyChecking=accept-new'
         . ' -o UserKnownHostsFile=/dev/null'
         . ' -o ConnectTimeout=10 -o NumberOfPasswordPrompts=1 '
         . escapeshellarg($u . '@' . $host) . ' ' . escapeshellarg($remoteCmd);
    $env = getenv();                 // inherit PATH etc, then add the password
    if (!is_array($env)) $env = [];
    $env['SSHPASS'] = $pass;
    $desc = [1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $p = @proc_open($cmd, $desc, $pipes, null, $env);
    if (!is_resource($p)) { $rc = 127; return ['', 'cannot start ssh']; }
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]); fclose($pipes[2]);
    $rc = proc_close($p);
    return [$stdout, $stderr];
}

if ($action === 'discover') {
    list($host, $u, $pass, $port, ) = read_conn();

    // ONE round-trip: tagged sections so we authenticate once. du -sh per qemu
    // folder for a human size; iol limited to *.bin; labs as paths relative to
    // /opt/unetlab/labs. Tolerant of missing dirs (the remote may lack iol).
    $remote =
        'echo "=QEMU=";' .
        'for d in /opt/unetlab/addons/qemu/*/; do [ -d "$d" ] && printf "%s\t%s\n" "$(basename "$d")" "$(du -sh "$d" 2>/dev/null | cut -f1)"; done;' .
        'echo "=IOL=";' .
        'for f in /opt/unetlab/addons/iol/bin/*.bin; do [ -f "$f" ] && printf "%s\t%s\n" "$(basename "$f")" "$(du -h "$f" 2>/dev/null | cut -f1)"; done;' .
        'echo "=LABS=";' .
        'find /opt/unetlab/labs -name "*.unl" -printf "%P\n" 2>/dev/null;' .
        'echo "=END=";';

    list($stdout, $stderr) = ssh_capture($host, $port, $u, $pass, $remote, $rc);
    if ($rc !== 0 || strpos($stdout, '=END=') === false) {
        $msg = trim($stderr) !== '' ? trim($stderr) : 'could not connect (check host/credentials)';
        // sshpass exit codes: 5 = auth failure, 6 = host key issue, 255 = ssh error
        if ($rc === 5) $msg = 'authentication failed — wrong username or password';
        fail(502, $msg);
    }

    $section = '';
    $images  = [];
    $labs    = [];
    foreach (preg_split('/\r?\n/', $stdout) as $line) {
        if ($line === '=QEMU=') { $section = 'qemu'; continue; }
        if ($line === '=IOL=')  { $section = 'iol';  continue; }
        if ($line === '=LABS=') { $section = 'labs'; continue; }
        if ($line === '=END=' || $line === '') continue;

        if ($section === 'qemu') {
            $parts = explode("\t", $line);
            $name  = $parts[0];
            $size  = isset($parts[1]) ? $parts[1] : '';
            if ($name === '') continue;
            $local = "/opt/unetlab/addons/qemu/$name";
            $installed = is_dir($local) && count(glob("$local/*")) > 0;
            $images[] = ['type' => 'qemu', 'name' => $name, 'size' => $size, 'installed' => $installed];
        } elseif ($section === 'iol') {
            $parts = explode("\t", $line);
            $name  = $parts[0];
            $size  = isset($parts[1]) ? $parts[1] : '';
            if ($name === '' || substr($name, -4) !== '.bin') continue;   // .bin only
            $installed = file_exists("/opt/unetlab/addons/iol/bin/$name");
            $images[] = ['type' => 'iol', 'name' => $name, 'size' => $size, 'installed' => $installed];
        } elseif ($section === 'labs') {
            $path = $line;
            if ($path === '' || substr($path, -4) !== '.unl') continue;
            $installed = file_exists("/opt/unetlab/labs/$path");
            $labs[] = ['path' => $path, 'installed' => $installed];
        }
    }

    // qemu first then iol, each alphabetical; labs alphabetical
    usort($images, function ($a, $b) {
        if ($a['type'] !== $b['type']) return $a['type'] === 'qemu' ? -1 : 1;
        return strcasecmp($a['name'], $b['name']);
    });
    usort($labs, function ($a, $b) { return strcasecmp($a['path'], $b['path']); });

    out(['images' => $images, 'labs' => $labs]);
}

if ($action === 'import') {
    list($host, $u, $pass, $port, $body) = read_conn();
    $images = isset($body['images']) && is_array($body['images']) ? $body['images'] : [];
    $labs   = isset($body['labs'])   && is_array($body['labs'])   ? $body['labs']   : [];
    if (count($images) + count($labs) === 0) fail(400, 'nothing selected');

    // sanitise the selection: types/names the worker will rsync. Reject path
    // traversal in names/labs so a crafted request can't escape the addon trees.
    $cleanImgs = [];
    foreach ($images as $it) {
        $t = isset($it['type']) ? $it['type'] : '';
        $n = isset($it['name']) ? $it['name'] : '';
        if (!in_array($t, ['qemu', 'iol'], true)) continue;
        if ($n === '' || strpos($n, '/') !== false || strpos($n, '..') !== false) continue;
        if ($t === 'iol' && substr($n, -4) !== '.bin') continue;          // .bin only
        $cleanImgs[] = ['type' => $t, 'name' => $n];
    }
    $cleanLabs = [];
    foreach ($labs as $p) {
        $p = (string) $p;
        if ($p === '' || substr($p, -4) !== '.unl') continue;
        if (strpos($p, '..') !== false || $p[0] === '/') continue;        // no traversal/abs
        $cleanLabs[] = $p;
    }
    if (count($cleanImgs) + count($cleanLabs) === 0) fail(400, 'nothing valid to import');

    $job = bin2hex(random_bytes(8));                                      // 16 hex
    file_put_contents("$JOBS/$job.json", json_encode(['state' => 'queued', 'pct' => 0, 'msg' => 'queued']));
    @chmod("$JOBS/$job.json", 0666);

    // credentials + selection handed to the root worker via a 0600 file (NOT argv,
    // so the password never shows in ps); worker shreds it the moment it's read.
    file_put_contents("$JOBS/$job.req", json_encode([
        'host' => $host, 'user' => $u, 'pass' => $pass, 'port' => $port,
        'images' => $cleanImgs, 'labs' => $cleanLabs,
    ]));
    @chmod("$JOBS/$job.req", 0600);

    // detach as root via the privilege broker (validates the job-id format)
    $resp = broker_call('worker_import', ['job' => $job]);
    if (!$resp['ok']) fail(500, 'import worker failed to start: ' . $resp['err']);
    out(['job' => $job]);
}

if ($action === 'status') {
    $job = isset($_GET['job']) ? $_GET['job'] : '';
    if (!preg_match('/^[a-f0-9]{16}$/', $job)) fail(400, 'bad job');
    $f = "$JOBS/$job.json";
    if (!file_exists($f)) fail(404, 'no such job');
    echo file_get_contents($f);
    exit;
}

fail(400, 'unknown action');
