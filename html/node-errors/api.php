<?php
/**
 * node-errors/api.php — per-node launch-failure classifier for the flow canvas.
 *
 * When a node is MARKED intended-running (node_sessions.node_session_running = 1)
 * but is NOT actually up (getNodeStatus() → 0), this endpoint works out WHY and
 * returns a human message + a contextual fix suggestion the island renders as a
 * ⚠ error badge on that node.
 *
 * Standalone engine idiom (same as status/api.php, users/api.php): chdir the
 * html root, pull in init.php, authenticate off the shared unencrypted `token`
 * cookie via \indentify. www-data has no sudo, but every probe here is read-only
 * and needs none: `docker inspect`/`docker images` over tcp 4243, and
 * file_exists on the addon dirs — exactly the checks getNodeStatus() and the
 * device factories already do as www-data.
 *
 *   GET|POST (action-less) [lab_session=<id>]
 *     → {status:'success', data:{
 *          "<node_id>": {kind, title, message, suggestion, action}, ...
 *       }}
 *   data is {} when nothing is in a classifiable failed state.
 *
 *   kind   ∈ invalid_image | corrupt_image | missing_license | launch_failed
 *   action ∈ edit_image | wipe_reload | add_license | none
 *
 * The node set is enumerated from node_sessions for the SAME lab session the
 * status poll uses (users.lab pointer, or a client-pinned lab_session that the
 * caller has joined — mirrors /api/labs/session/nodestatus), and status is read
 * through getNodeStatus() itself so this never disagrees with the LED. The
 * per-node image/type/template come from the lab .unl XML (node_sessions has no
 * image column). `docker images` is run once and cached for the whole request.
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function ne_out($x) { echo json_encode($x); exit; }
function ne_fail($code, $m) { http_response_code($code); echo json_encode(['status' => 'fail', 'message' => $m]); exit; }

/* ---- launch_failed debounce state -------------------------------------------
 * A node that just Start()ed is intended-running (node_session_running=1) but
 * its console/process typically takes a few seconds to come up — during that
 * window getNodeStatus()==0 exactly like a genuine launch failure, and (for
 * docker/qemu/iol) the image/license checks all pass because the image IS
 * fine, so ne_classify_*() correctly falls through to `launch_failed`. Without
 * debouncing, EVERY normal node start flashes a ⚠ badge for a few seconds.
 *
 * The definitive kinds (invalid_image/corrupt_image/missing_license) are NOT
 * debounced — those are true regardless of how long the node has been down.
 * Only `launch_failed` — "image/license fine, just not up yet" — is ambiguous
 * at a single instant vs. a normal boot, so we require it to persist across
 * GRACE_SECONDS of polling (the island polls every 8s) before reporting it.
 *
 * State is one small JSON file per lab session under /dev/shm (same idiom as
 * pnq-overlay.php's OV_CACHE_DIR): { "<nid>": <epoch first seen failing> }.
 * flock over the whole read-modify-write serialises concurrent pollers. */
define('NE_GRACE_SECONDS', 5);
define('NE_STATE_DIR', '/dev/shm/pnet-nodeerr');

function ne_state_path($session) {
    return NE_STATE_DIR . '/' . intval($session) . '.json';
}

/* Read-modify-write the per-session state file under an exclusive lock so two
 * near-simultaneous polls (or two browser tabs) can't race each other. $fn
 * receives the current state array (nid-string => epoch) and must return the
 * new state array to persist. Returns the state array $fn returned. */
function ne_state_update($session, $fn) {
    if (!is_dir(NE_STATE_DIR)) {
        @mkdir(NE_STATE_DIR, 0777, true);
        @chmod(NE_STATE_DIR, 0777);
    }
    $path = ne_state_path($session);
    $fp = @fopen($path, 'c+');
    if (!$fp) {
        // Can't persist state (dir not writable?) — degrade to "no grace info",
        // caller treats every launch_failed as freshly-seen (safe, just noisier).
        return $fn([]);
    }
    $deadline = microtime(true) + 2;
    while (!flock($fp, LOCK_EX)) {
        if (microtime(true) > $deadline) { fclose($fp); return $fn([]); }
        usleep(50000);
    }
    $raw = stream_get_contents($fp);
    $state = json_decode($raw !== false ? $raw : '', true);
    if (!is_array($state)) {
        $state = [];
    }
    $new = $fn($state);
    if (!is_array($new)) {
        $new = [];
    }
    // Atomic-ish in-place rewrite: truncate + rewind under the same lock/handle
    // rather than a separate tmp+rename (file is tiny, contention window is the
    // flock itself, and we already hold it for the whole request).
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($new));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    @chmod($path, 0664);
    return $new;
}

/* ---- AUTH — engine cookie/session check (same as the other api.php modules) -- */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    ne_fail(401, 'not authenticated');
}

/* ---- Resolve the lab session exactly like /api/labs/session/nodestatus ------
 * Prefer a client-pinned lab_session the caller has joined (multi-tab safe);
 * otherwise fall back to the per-POD users.lab pointer. No session → empty. */
$session = '';
$pin = isset($_POST['lab_session']) ? $_POST['lab_session']
     : (isset($_GET['lab_session']) ? $_GET['lab_session'] : '');
if (!empty($pin) && ctype_digit((string) $pin) && labSessionJoinedBy((int) $pin, $tenant)) {
    $session = (int) $pin;
}
if (empty($session)) {
    $session = get($user['lab'], '');
}
if ($session === '' || $session === null) {
    // Not currently in a lab — nothing to classify, but not an error.
    ne_out(['status' => 'success', 'data' => new stdClass()]);
}

$db = checkDatabase();

/* ---- Enumerate the SAME node set getNodesStatus() iterates ------------------- */
$statement = $db->prepare(
    'SELECT * FROM node_sessions WHERE node_session_lab = :lab'
);
$statement->execute(['lab' => $session]);
$rows = $statement->fetchAll(PDO::FETCH_ASSOC);

/* Candidates: marked intended-running but not actually up. getNodeStatus()
 * returns 0=stopped, 1=stopped+locked, 2=running, 3=running+locked, 6=hibernated,
 * 7=frozen. Only a plain 0 (down, not deliberately locked/hibernated/frozen)
 * while node_session_running=1 is a launch failure worth flagging. */
$candidates = [];
foreach ($rows as $node) {
    if ((int) get($node['node_session_running'], 0) !== 1) {
        continue;
    }
    // Satellite-hosted nodes: getNodeStatus trusts the shared running flag, so a
    // running=1 satellite node reports up (2) — it won't reach here. If it did,
    // we can't probe its host's docker/files locally, so skip classification.
    if ((int) get($node['node_session_host'], 0) !== 0) {
        continue;
    }
    $status = getNodeStatus(
        $node['node_session_id'],
        $node['node_session_type'],
        $node['node_session_workspace'],
        $node['node_session_port'],
        $node['node_session_port_2nd'],
        0
    );
    if ((int) $status === 0) {
        $candidates[] = $node;
    }
}

/* ---- Per-node image/type/template from the lab .unl XML ---------------------
 * node_sessions has no image column; the image lives as a <node> attribute in
 * the .unl. Parse once, keyed by node id (= node_session_nid). Needed before
 * the early-return check below, since the missing-disk-image scan that
 * follows also depends on it. */
$nodeMeta = [];   // nid => ['image'=>, 'type'=>, 'template'=>]
$lab = getLabFromSession($session);
if (is_array($lab) && !empty($lab['lab_session_path'])) {
    $unl = BASE_LAB . $lab['lab_session_path'];
    if (is_file($unl) && is_readable($unl)) {
        $xml = @simplexml_load_file($unl);
        if ($xml !== false) {
            foreach ($xml->xpath('//lab/topology/nodes/node') as $xn) {
                $a = $xn->attributes();
                if (!isset($a->id)) {
                    continue;
                }
                $nid = (int) $a->id;
                $nodeMeta[$nid] = [
                    'image'    => isset($a->image) ? (string) $a->image : '',
                    'type'     => isset($a->type) ? (string) $a->type : '',
                    'template' => isset($a->template) ? (string) $a->template : '',
                ];
            }
        }
    }
}

/* ---- QEMU nodes reporting RUNNING can still have no boot disk attached at
 * all: device_qemu.php's command() builder scandir()s addons/qemu/<image>
 * unconditionally when assembling -drive flags and just adds nothing if that
 * directory is missing or empty (PHP foreach-over-false is a silent no-op,
 * not a fatal) — QEMU still launches and its console/VNC port still comes up,
 * it just has nothing to boot from and falls through to network/iPXE. Because
 * getNodeStatus() for qemu is purely a console-port liveness check (functions.
 * php's netstat-LISTEN probe), such a node reports status 2 (running/green)
 * and never becomes a launch-failure $candidate above, so the invalid_image
 * check already inside ne_classify_qemu() never runs for it. Scan every
 * running qemu node for this regardless of its live status, and treat it as
 * definitive (not debounced) — a missing image directory doesn't resolve on
 * its own the way a slow boot does. */
$imageProblems = [];   // nid => [kind,title,message,suggestion,action]
foreach ($rows as $node) {
    if ((int) get($node['node_session_running'], 0) !== 1) {
        continue;
    }
    if ((string) get($node['node_session_type'], '') !== 'qemu') {
        continue;
    }
    if ((int) get($node['node_session_host'], 0) !== 0) {
        continue;   // satellite — can't probe its addons/qemu locally
    }
    $nid = (int) $node['node_session_nid'];
    $meta = isset($nodeMeta[$nid]) ? $nodeMeta[$nid] : ['image' => ''];
    $problem = ne_qemu_image_problem(isset($meta['image']) ? $meta['image'] : '');
    if ($problem !== null) {
        $imageProblems[$nid] = $problem;
    }
}

if (empty($candidates) && empty($imageProblems)) {
    // Nothing down and no missing-image nodes — any previously-tracked
    // launch_failed grace timers are stale (their nodes recovered or left the
    // session). Clear the whole per-session state file rather than leaving
    // stale timers to rot in /dev/shm.
    ne_state_update($session, function ($state) { return []; });
    ne_out(['status' => 'success', 'data' => new stdClass()]);
}

/* ---- docker images, fetched once and cached for the whole request ----------
 * Returns a set of the "repo:tag" refs present locally (both repo:tag and the
 * bare repo, so we tolerate the store's repo:tag:<imageid> triple form). */
$dockerImagesCache = null;
function ne_docker_images() {
    global $dockerImagesCache;
    if ($dockerImagesCache !== null) {
        return $dockerImagesCache;
    }
    $set = [];
    // Broker read-only docker_image_ls verb (Stage 5) — same
    // {{.Repository}}:{{.Tag}} lines the direct exec produced.
    $resp = broker_docker_image_ls('refs');
    if (!empty($resp['ok'])) {
        $o = isset($resp['out']) ? $resp['out'] : [];
        foreach ($o as $line) {
            $line = trim($line);
            if ($line === '' || $line === '<none>:<none>') {
                continue;
            }
            $set[$line] = true;             // repo:tag
            $repo = preg_replace('/:[^:]*$/', '', $line);
            if ($repo !== '') {
                $set[$repo] = true;         // bare repo
            }
        }
    }
    $dockerImagesCache = $set;
    return $set;
}

/* Normalise the node's stored docker image ref to repo:tag (strip a trailing
 * :<imageid>, 12- or 64-hex, exactly as device_docker.php does before create). */
function ne_docker_ref($image) {
    return preg_replace('/:[0-9a-f]{12}$|:[0-9a-f]{64}$/', '', (string) $image);
}

/* Inspect a stopped/absent container. Returns [existsBool, stateArray|null].
 * Stage 1 (docker rebroker): rides the broker's read-only docker_inspect verb
 * (name derived broker-side from the typed session id) instead of a www-data
 * exec of the docker CLI. Same contract: failure/empty = container absent. */
function ne_docker_inspect($session) {
    $resp = broker_docker_inspect('node',
        ['node_session' => (int) $session], '{{json .State}}');
    if (!$resp['ok'] || empty($resp['out'])) {
        return [false, null];               // container does not exist
    }
    $state = json_decode(implode('', $resp['out']), true);
    return [true, is_array($state) ? $state : null];
}

/* ---- Classification helpers ------------------------------------------------- */
function ne_classify_docker($node, $meta) {
    $image = isset($meta['image']) ? $meta['image'] : '';
    list($exists, $state) = ne_docker_inspect($node['node_session_id']);
    if (!$exists) {
        // No container. Present image ⇒ create/start failed; absent ⇒ bad image.
        $ref = ne_docker_ref($image);
        $images = ne_docker_images();
        if ($image !== '' && isset($images[$ref])) {
            return ['launch_failed', 'Node failed to start',
                'The Docker image is present but the container could not be created or started.',
                'Wipe the node and reload it, then Start again.', 'wipe_reload'];
        }
        return ['invalid_image', 'Image not found',
            'The Docker image "' . ($ref !== '' ? $ref : $image) . '" is not installed on this server.',
            'Change the node\'s image to one that is installed.', 'edit_image'];
    }
    // Container exists but is not running — read why it died.
    $exit  = is_array($state) && isset($state['ExitCode']) ? (int) $state['ExitCode'] : 0;
    $oom   = is_array($state) && !empty($state['OOMKilled']);
    $err   = is_array($state) && isset($state['Error']) ? trim((string) $state['Error']) : '';
    if ($oom || $exit !== 0 || $err !== '') {
        $why = $oom ? 'ran out of memory' : ($err !== '' ? $err : ('exited with code ' . $exit));
        return ['corrupt_image', 'Node crashed on boot',
            'The container started but stopped unexpectedly (' . $why . '). The image may be corrupt or misconfigured.',
            'Wipe the node and reload it, then Start again.', 'wipe_reload'];
    }
    // Exists, cleanly stopped, running flag stale — treat as a failed launch.
    return ['launch_failed', 'Node is not running',
        'The container exists but is not running.',
        'Wipe the node and reload it, then Start again.', 'wipe_reload'];
}

/* QEMU rejects the assembled command line itself (bad -machine type, a flag
 * it no longer recognises, a CPU property that doesn't exist, …) BEFORE any
 * guest ever boots, and prints exactly one terse line to its own stdout/
 * stderr — which device.php's start() redirects into "wrapper.txt" in the
 * node's running dir (device_qemu.php::command(), "$bin.$flags.' > '.
 * getRunningPath().'/wrapper.txt'"). modernizeQemuFlags() already rewrites
 * the specific dead flags found by boot-testing (pc-1.0, -no-hpet, …), but
 * that's a closed blocklist — an imported .unl's saved per-node qemu_options
 * (freely hand-editable via the Advanced tab, and never migrated on import)
 * can carry anything else QEMU has since removed or renamed. Detect that
 * class of failure generically from QEMU's own error text and point the
 * user at the actual saved override instead of a generic "may have crashed".
 */
function ne_qemu_options_error($workspace) {
    $log = rtrim((string) $workspace, '/') . '/wrapper.txt';
    if ($workspace === '' || !is_file($log) || !is_readable($log)) {
        return null;
    }
    $tail = @file_get_contents($log, false, null, 0, 8192);
    if ($tail === false || $tail === '') {
        return null;
    }
    // QEMU's own CLI-parse-failure phrasing — never text a booting/booted
    // guest would produce, so this is a low false-positive-risk pattern
    // rather than an exhaustive flag audit.
    if (preg_match(
        '/qemu-system-\S+:\s.*(unsupported machine type|invalid option|' .
        'is not a valid (option|value)|unknown option|no property|' .
        'Property\s.*not found|doesn\'t support requested feature)/i',
        $tail,
        $m
    )) {
        return trim($m[0]);
    }
    return null;
}

/* A DIFFERENT failure shape than a bad flag: the flag itself is fine, but a
 * file it references (a driver floppy/ISO, a base image, …) isn't present on
 * this server — an asset/packaging gap that can vary install to install.
 * QEMU reports this as "-drive file=<path>: Could not open '<path>': No such
 * file or directory" — text ne_qemu_options_error()'s patterns don't match.
 * This isn't something the user can fix by editing a flag, so it gets its
 * own kind + message (name the missing path; don't suggest "reset to
 * template default" as if it were a stale-options problem).
 */
function ne_qemu_missing_asset_error($workspace) {
    $log = rtrim((string) $workspace, '/') . '/wrapper.txt';
    if ($workspace === '' || !is_file($log) || !is_readable($log)) {
        return null;
    }
    $tail = @file_get_contents($log, false, null, 0, 8192);
    if ($tail === false || $tail === '') {
        return null;
    }
    if (preg_match(
        '/qemu-system-\S+:\s.*Could not open [\'"]([^\'"]+)[\'"]:\s*No such file or directory/i',
        $tail,
        $m
    )) {
        return trim($m[1]);
    }
    return null;
}

/* Checks whether a QEMU node's configured image is present/complete on this
 * server — split out of ne_classify_qemu() so the running-node scan above can
 * reuse it too. Returns the [kind,title,message,suggestion,action]
 * classification, or null if the image itself is fine. */
function ne_qemu_image_problem($image) {
    $dir = '/opt/unetlab/addons/qemu/' . $image;
    if ($image === '' || !is_dir($dir)) {
        return ['invalid_image', 'Image not found',
            'The QEMU image directory "' . ($image !== '' ? $image : '(none)') . '" does not exist under addons/qemu.',
            'Change the node\'s image to an installed one.', 'edit_image'];
    }
    $hasQcow = false;
    foreach (@scandir($dir) ?: [] as $f) {
        if (substr($f, -6) === '.qcow2') { $hasQcow = true; break; }
    }
    if (!$hasQcow) {
        return ['invalid_image', 'Image is incomplete',
            'The QEMU image directory "' . $image . '" contains no .qcow2 disk.',
            'Change the node\'s image, or re-upload the disk for this image.', 'edit_image'];
    }
    return null;
}

function ne_classify_qemu($node, $meta) {
    $image = isset($meta['image']) ? $meta['image'] : '';
    $problem = ne_qemu_image_problem($image);
    if ($problem !== null) {
        return $problem;
    }
    // Disk is present — check whether QEMU actually rejected the assembled
    // command line (stale/incompatible saved qemu_options) before falling
    // back to the generic "didn't start" message.
    $workspace = isset($node['node_session_workspace']) ? $node['node_session_workspace'] : '';
    $missingAsset = ne_qemu_missing_asset_error($workspace);
    if ($missingAsset !== null) {
        return ['missing_qemu_asset', 'A required file is missing on this server',
            'This node\'s saved QEMU options reference "' . $missingAsset . '", which does not exist on this server. This is a server-side asset gap (e.g. an install missing a shared driver file), not something wrong with the lab itself.',
            'Open the node\'s Advanced settings and clear the QEMU Options override to fall back to this template\'s current defaults, or ask an admin to install the missing file at that path.',
            'edit_qemu_options'];
    }
    $optErr = ne_qemu_options_error($workspace);
    if ($optErr !== null) {
        return ['stale_qemu_options', 'Startup options rejected by QEMU',
            'This node\'s saved QEMU options are incompatible with the QEMU version on this server (' . $optErr . '). This is common on labs imported from an older PNetLab/EVE-NG install — the per-node options are exported unchanged and never automatically updated.',
            'Open the node\'s Advanced settings and either fix the flag above, or clear the QEMU Version / QEMU Options overrides to fall back to this template\'s current (tested) defaults.',
            'edit_qemu_options'];
    }
    return ['launch_failed', 'Node failed to start',
        'The QEMU image is present but the virtual machine did not start (it may have crashed on boot).',
        'Wipe the node and reload it, then Start again.', 'wipe_reload'];
}

function ne_classify_iol($node, $meta) {
    $image = isset($meta['image']) ? $meta['image'] : '';
    if (!is_file('/opt/unetlab/addons/iol/bin/iourc')) {
        return ['missing_license', 'IOL license missing',
            'The IOL license file (iourc) is not installed, so IOL nodes cannot start.',
            'Install the IOL license (iourc) under addons/iol/bin.', 'add_license'];
    }
    if ($image === '' || !file_exists('/opt/unetlab/addons/iol/bin/' . $image)) {
        return ['invalid_image', 'Image not found',
            'The IOL image "' . ($image !== '' ? $image : '(none)') . '" is not installed under addons/iol/bin.',
            'Change the node\'s image to an installed one.', 'edit_image'];
    }
    // Binary + license present but the node is down.
    return ['launch_failed', 'Node failed to start',
        'The IOL image and license are present but the node did not start.',
        'Wipe the node and reload it, then Start again.', 'wipe_reload'];
}

/* ---- Definitive missing-image reports (running qemu nodes, scanned above) -- */
$data = [];
foreach ($imageProblems as $nid => $problem) {
    list($kind, $title, $message, $suggestion, $action) = $problem;
    $data[(string) $nid] = [
        'kind'       => $kind,
        'title'      => $title,
        'message'    => $message,
        'suggestion' => $suggestion,
        'action'     => $action,
    ];
}

/* ---- Classify every candidate ---------------------------------------------- */
$launchFailedNow = [];   // nid => full [kind,title,message,suggestion,action] classification
foreach ($candidates as $node) {
    $nid  = (int) $node['node_session_nid'];
    if (isset($imageProblems[$nid])) {
        continue;   // already reported above — same image gap, no need to re-derive it
    }
    $type = (string) get($node['node_session_type'], '');
    $meta = isset($nodeMeta[$nid]) ? $nodeMeta[$nid] : ['image' => '', 'type' => $type, 'template' => ''];

    if ($type === 'docker') {
        list($kind, $title, $message, $suggestion, $action) = ne_classify_docker($node, $meta);
    } elseif ($type === 'qemu') {
        list($kind, $title, $message, $suggestion, $action) = ne_classify_qemu($node, $meta);
    } elseif ($type === 'iol') {
        list($kind, $title, $message, $suggestion, $action) = ne_classify_iol($node, $meta);
    } else {
        // dynamips/vpcs and friends: no cheap image classification — report a
        // generic launch failure so the badge still surfaces the problem.
        $kind = 'launch_failed';
        $title = 'Node is not running';
        $message = 'The node is marked running but no process is up.';
        $suggestion = 'Wipe the node and reload it, then Start again.';
        $action = 'wipe_reload';
    }

    if ($kind === 'launch_failed') {
        // Definitive kinds always fall through to $data below unfiltered; only
        // launch_failed is gated on the grace window, resolved in one shot
        // (under a single flock) after the classify loop below. Keep the real
        // per-type title/message/suggestion so a debounced report still reads
        // exactly as it did before (just delayed).
        $launchFailedNow[$nid] = [$kind, $title, $message, $suggestion, $action];
        continue;
    }

    $data[(string) $nid] = [
        'kind'       => $kind,
        'title'      => $title,
        'message'    => $message,
        'suggestion' => $suggestion,
        'action'     => $action,
    ];
}

/* ---- launch_failed debounce: resolve which of $launchFailedNow have been
 * failing for >= NE_GRACE_SECONDS, and prune stale/resolved entries ---------- */
if (!empty($rows)) {
    $now = time();
    $toReport = [];   // nid => true, cleared the grace window this call
    // Note: state hygiene (dropping recovered/definitive/session-gone nodes) is
    // implicit — $new is built ONLY from $launchFailedNow, so any nid not in
    // that set this call (recovered, reclassified, or gone from the session)
    // is simply not carried over into $new and its entry disappears.
    ne_state_update($session, function ($state) use ($launchFailedNow, $now, &$toReport) {
        $new = [];
        foreach ($launchFailedNow as $nid => $_classification) {
            $key = (string) $nid;
            if (isset($state[$key])) {
                $first = (int) $state[$key];
                if (($now - $first) >= NE_GRACE_SECONDS) {
                    $toReport[$nid] = true;   // grace elapsed — report + keep tracking
                }
                $new[$key] = $first;
            } else {
                $new[$key] = $now;            // first time seen — start the clock, don't report yet
            }
        }
        return $new;
    });
    foreach ($toReport as $nid => $_) {
        list($kind, $title, $message, $suggestion, $action) = $launchFailedNow[$nid];
        $data[(string) $nid] = [
            'kind'       => $kind,
            'title'      => $title,
            'message'    => $message,
            'suggestion' => $suggestion,
            'action'     => $action,
        ];
    }
}

ne_out(['status' => 'success', 'data' => empty($data) ? new stdClass() : $data]);
