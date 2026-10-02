<?php
/**
 * devices-factory/api.php — engine-side re-home of the Laravel store's
 * Admin\DevicesController (store decommission item C4). This is the "Docker
 * Devices" catalog: pull/remove ready-made Docker Hub images that become docker
 * node types. POST-only, admin-gated, authenticated with the engine's own
 * token-cookie check (same idiom as status/api.php and cluster/api.php).
 *
 * NB: this lives under devices-factory/ (NOT devices/, which is the engine's
 * node-type driver tree).
 *
 *   POST ?action=filter                          → {result:true, data:[device,…]}
 *   POST ?action=get     {device_id,overwritten} → start pull
 *   POST ?action=delete  {device_id}             → start remove
 *   POST ?action=pull    {ref}                   → start an ad-hoc `docker pull <ref>`
 *                                                   (strict-validated image ref, no catalog
 *                                                   entry required); reuses the same
 *                                                   factory-script/broker/process lane as
 *                                                   get/process so pulls stream progress the
 *                                                   same way catalog installs do.
 *   POST ?action=process {device_id}             → {finish,data:{…log}}
 *   POST ?action=images                          → {result,data:[{id,repository,tag,size,
 *                                                   created,in_use},…]} — the raw local Docker
 *                                                   image store (`docker images`), independent
 *                                                   of the ishare2 catalog above; in_use is a
 *                                                   cheap best-effort hint from `docker ps -a`,
 *                                                   not a hard guarantee.
 *   POST ?action=rmi     {ref}                   → `docker rmi <ref-or-id>` (no -f/force — an
 *                                                   image in use by a container fails with
 *                                                   Docker's own error, surfaced verbatim-ish).
 *                                                   ref must match PNQ_REF_RE or PNQ_ID_RE.
 *
 * Envelope: the store's Reply::finish shape {result,message,data} for get /
 * delete / process; filter returns the store's raw {result,data} array (it
 * returned an array, not Reply::finish). The consumers (main/js/devices.js) read
 * res.body.result, res.body.data, and res.body.data.confirm accordingly.
 *
 * Catalog + per-device scripts come from ishare2/devices.json (device_check /
 * device_script / device_delete), exactly as the store read them. Root ops
 * (dos2unix + detached factory run) go through the privilege broker.
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

const PNQ_CATALOG = '/opt/unetlab/html/ishare2/devices.json';

// Strict docker image reference: optional registry[:port]/, repo path segments
// (lowercase alnum + . _ __ - separators), optional :tag, optional @sha256:digest.
// No whitespace, no shell metacharacters — this is the ONLY gate before the ref
// is interpolated into a root-run bash script (belt-and-braces: also
// escapeshellarg()'d at interpolation time). Mirrors the client-side regex in
// main/js/devices.js — keep both in sync.
const PNQ_REF_RE = '~^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?/)?' .
    '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*' .
    '(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*' .
    '(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?' .
    '(?:@sha256:[a-f0-9]{64})?$~';

// Docker's short/long image id: bare lowercase hex, 12-64 chars. images/rmi accept
// either this or PNQ_REF_RE — `docker images` and `docker ps` freely mix both.
const PNQ_ID_RE = '~^[a-f0-9]{12,64}$~';

function reply_finish($result, $message, $data = '') {
    echo json_encode(['result' => $result, 'message' => $message, 'data' => $data]);
    exit;
}
function reply_raw($x) { echo json_encode($x); exit; }
function fail($code, $m) { http_response_code($code); echo json_encode(['error' => $m]); exit; }

function pnq_local_catalog() {
    if (!is_file(PNQ_CATALOG)) return [];
    $data = json_decode(file_get_contents(PNQ_CATALOG), true);
    return is_array($data) ? $data : [];
}
function pnq_find_device($deviceId) {
    foreach (pnq_local_catalog() as $d) {
        if ((string) $d['device_id'] === (string) $deviceId) return $d;
    }
    return null;
}
// process_device row helpers (plain PDO; table process_device, PK
// process_device_id varchar). Mirrors the store's Process_device model ops.
function pd_drop($db, $id) {
    $st = $db->prepare('DELETE FROM process_device WHERE process_device_id = :id');
    $st->execute(['id' => (string) $id]);
}
function pd_add($db, $id, $log) {
    $st = $db->prepare(
        'INSERT INTO process_device (process_device_id, process_device_log) VALUES (:id, :log)'
    );
    $st->execute(['id' => (string) $id, 'log' => (string) $log]);
}
function pd_read($db, $id) {
    $st = $db->prepare('SELECT * FROM process_device WHERE process_device_id = :id');
    $st->execute(['id' => (string) $id]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

/* ---- device_check evaluation (Stage 5) ----------------------------------------
 * Every shipped device_check string is a `docker … images <ref> | grep <pat>`
 * image-PRESENCE pipeline. Those are no longer exec()'d by www-data: the
 * docker-shaped ones are parsed here and evaluated as DATA against a single
 * brokered repo:tag list (docker_image_ls mode=refs, one round-trip for the
 * whole catalog). Old-exec equivalence: `docker images <ref>` lists the
 * repo:tag row(s) matching <ref> (every tag when <ref> has none), `grep <pat>`
 * keeps lines containing <pat> as a substring, and exec()'s non-empty last
 * line meant "present". pnq_check_available() returns '1'/'0' accordingly —
 * or null when the string is NOT that shape (a non-docker device_check; none
 * ship today), in which case the caller falls back to exec() as before. */
function pnq_check_available($check, $refs) {
    if (!preg_match('~^docker\s+(?:-H=?\S+\s+)?images\s+([^\s|]+)\s*\|\s*grep\s+([^\s|;&]+)\s*$~',
                    trim((string) $check), $m)) {
        return null;
    }
    $ref = $m[1];
    $pat = $m[2];
    // Does <ref> carry a :tag (a ':' after the last '/')?
    $slash = strrpos($ref, '/');
    $colon = strrpos($ref, ':');
    $hasTag = $colon !== false && ($slash === false || $colon > $slash);
    foreach ($refs as $line) {
        $line = trim($line);
        if ($line === '') continue;
        $refMatch = $hasTag ? ($line === $ref) : (strpos($line, $ref . ':') === 0);
        if ($refMatch && strpos($line, $pat) !== false) return '1';
    }
    return '0';
}
function pnq_image_refs() {
    $resp = broker_docker_image_ls('refs');
    return (!empty($resp['ok']) && isset($resp['out'])) ? $resp['out'] : [];
}

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

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') fail(405, 'method not allowed');

$action = isset($_GET['action']) ? $_GET['action'] : '';
$body   = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) $body = [];
$deviceId = isset($body['device_id']) ? $body['device_id'] : '';

/* ---- filter: local catalog + per-device availability (admin) ----------------
 * Returns the store's RAW {result,data} array (its filter() returned an array,
 * not Reply::finish); devices.js reads res.body.result / res.body.data. */
if ($action === 'filter') {
    if (!$isAdmin) reply_finish(false, 'ERROR_PERMISSION');
    $catalog = pnq_local_catalog();
    $refs = pnq_image_refs();     // ONE broker round-trip for the whole catalog
    foreach ($catalog as $key => $device) {
        $checkExist = htmlspecialchars_decode($device['device_check'], ENT_QUOTES);
        $avail = pnq_check_available($checkExist, $refs);
        if ($avail === null) {           // non-docker check — run it as before
            $checkExistLog = exec($checkExist);
            $avail = ($checkExistLog == '') ? '0' : '1';
        }
        $catalog[$key]['available'] = $avail;
    }
    reply_raw(['result' => true, 'data' => $catalog]);
}

/* ---- get: build the pull script + start the detached factory run (admin) ----- */
if ($action === 'get') {
    if (!$isAdmin) reply_finish(false, 'ERROR_PERMISSION');
    $overwritten = !empty($body['overwritten']);
    $device = pnq_find_device($deviceId);
    if (!$device) reply_finish(false, 'Device not found in local catalog');

    if (!$overwritten) {
        $checkExist = htmlspecialchars_decode($device['device_check'], ENT_QUOTES);
        $avail = pnq_check_available($checkExist, pnq_image_refs());
        if ($avail === null) {           // non-docker check — run it as before
            $checkExistLog = exec($checkExist);
            $avail = ($checkExistLog == '') ? '0' : '1';
        }
        if ($avail === '1') reply_finish(false, 'device_existed_alert', ['confirm' => true]);
    }

    $script = htmlspecialchars_decode($device['device_script'], ENT_QUOTES);
    $script = str_replace('{device_id}', (string) $deviceId, $script);
    $script = "#!/bin/bash\n" . $script;

    $excutefile = '/tmp/pnet_device_factory_' . $deviceId;
    $logfile    = $excutefile . '_log';

    broker_call('device_factory_kill', ['id' => (string) $deviceId]);
    if (is_file($excutefile)) unlink($excutefile);
    if (is_file($logfile)) unlink($logfile);

    file_put_contents($excutefile, $script);
    chmod($excutefile, 0755);

    $db = checkDatabase();
    pd_drop($db, $device['device_id']);
    pd_add($db, $device['device_id'], 'Start loading ' . $device['device_name']);

    // dos2unix + root-detached run (journald unit pnet-factory-<id>) via broker
    broker_call('device_factory_run', ['id' => (string) $deviceId]);
    reply_finish(true, 'success');
}

/* ---- pull: ad-hoc `docker pull <ref>` outside the catalog (admin) -------------
 * The ref MUST match PNQ_REF_RE first, then rides the broker's
 * docker_image_pull verb (Stage 4): the broker re-validates the ref, AUTHORS
 * the factory script body itself (www-data no longer writes a root-executed
 * /tmp script on this action) and runs the pull detached on the same
 * pnet-factory-<job> / logfile / process_device lane, so the process-polling
 * contract is unchanged. jobId = 'custom'+substr(md5(ref),0,12) on both sides
 * — keep the derivations in sync. */
if ($action === 'pull') {
    if (!$isAdmin) reply_finish(false, 'ERROR_PERMISSION');
    $ref = isset($body['ref']) ? trim((string) $body['ref']) : '';
    // Client sends the raw field verbatim; tolerate a pasted `docker pull ` prefix.
    if (stripos($ref, 'docker pull ') === 0) $ref = trim(substr($ref, 12));
    if ($ref === '' || strlen($ref) > 256 || !preg_match(PNQ_REF_RE, $ref)) {
        // 422, not the reply_finish(200, result:false) idiom the other actions use:
        // this is the one action taking free-text user input, so a bad ref is a
        // genuine client error worth a non-2xx status (defense in depth for any
        // caller that checks HTTP status rather than the JSON body).
        fail(422, 'Not a valid image reference (e.g. rspnet/pnet-browser:1.0).');
    }

    $jobId = 'custom' . substr(md5($ref), 0, 12);

    // Kill any stale run of the same job (also clears its stale tmp files).
    broker_call('device_factory_kill', ['id' => $jobId]);

    $db = checkDatabase();
    pd_drop($db, $jobId);
    pd_add($db, $jobId, 'Pulling ' . $ref);

    $resp = broker_docker_image_pull($ref);
    if (empty($resp['ok']) || $resp['rc'] != 0) {
        pd_drop($db, $jobId);
        reply_finish(false, 'Could not start pull: ' .
            (isset($resp['err']) && $resp['err'] !== '' ? $resp['err'] : 'broker error'));
    }
    reply_finish(true, 'success', ['job_id' => $jobId]);
}

/* ---- delete: docker-in-use guard + remove script via broker (admin) ---------- */
if ($action === 'delete') {
    if (!$isAdmin) reply_finish(false, 'ERROR_PERMISSION');
    $device = pnq_find_device($deviceId);
    if (!$device) reply_finish(false, 'Device not found in local catalog');

    // Refuse to remove an image any container still references. The ancestor
    // lookup (`docker ps -a --filter ancestor=`) deliberately includes STOPPED
    // containers: `docker rmi` (no -f) fails if ANY container — running or
    // Exited — references the image, and an Exited lab container still holds
    // node state. The old message called these "running lab node(s)", which
    // misled users whose lab was fully stopped; name the real remedy instead
    // (stopping does NOT release the image — wipe the node or close the lab).
    // The lookup rides the broker's read-only docker_image_ancestor verb
    // (Stage 4); on a broker failure/reject it degrades to "not in use" — the
    // same behaviour the old `shell_exec(... 2>/dev/null)` had on error.
    $image = isset($device['device_version']) ? trim($device['device_version']) : '';
    if ($image !== '') {
        $resp = broker_docker_image_ancestor($image);
        $inUse = (!empty($resp['ok']) && !empty($resp['out']))
            ? trim(implode("\n", $resp['out'])) : '';
        if ($inUse !== '') {
            $nodes = implode(', ', array_filter(array_map('trim', explode("\n", $inUse))));
            reply_finish(false, '"' . $device['device_name'] .
                '" is in use by lab container(s) (possibly stopped): ' . $nodes .
                '. Wipe the node(s) or close the lab session(s) that own them, then Remove.');
        }
    }

    $script = htmlspecialchars_decode($device['device_delete'], ENT_QUOTES);
    $script = str_replace('{device_id}', (string) $deviceId, $script);
    $script = "#!/bin/bash\n" . $script;

    $excutefile = '/tmp/pnet_device_factory_' . $deviceId;
    $logfile    = $excutefile . '_log';

    broker_call('device_factory_kill', ['id' => (string) $deviceId]);
    if (is_file($excutefile)) unlink($excutefile);
    if (is_file($logfile)) unlink($logfile);

    file_put_contents($excutefile, $script);
    chmod($excutefile, 0755);

    $db = checkDatabase();
    pd_drop($db, $device['device_id']);
    pd_add($db, $device['device_id'], 'Delete ' . $device['device_name']);

    broker_call('device_factory_run', ['id' => (string) $deviceId]);
    reply_finish(true, 'success');
}

/* ---- process: poll the process_device row + <id>_log file -------------------- */
if ($action === 'process') {
    // device_id is used to build a /tmp path; keep it to the safe id charset.
    if (!preg_match('/^[A-Za-z0-9_.-]+$/', (string) $deviceId)) {
        reply_finish(false, 'bad device id');
    }
    $db = checkDatabase();
    $row = pd_read($db, $deviceId);

    $excutefile = '/tmp/pnet_device_factory_' . $deviceId;
    $logfile    = $excutefile . '_log';

    if ($row === null) {
        // no row → the factory script deleted its own row on completion. Read
        // the log BEFORE the broker rm's it (fast failures — e.g. "manifest
        // unknown" on a bad ref — can finish inside one polling interval, so
        // this may be the only poll that ever sees a null row; without this
        // the caller would see finish:true with no final log line at all).
        $finalLog = is_file($logfile) ? file_get_contents($logfile) : null;
        broker_call('device_factory_rm', ['id' => (string) $deviceId]);
        reply_finish(true, 'success', ['finish' => true, 'data' => ['log' => $finalLog]]);
    }

    if (is_file($logfile)) {
        $row['log'] = file_get_contents($logfile);
    }
    reply_finish(true, 'success', ['finish' => false, 'data' => $row]);
}

/* ---- images: local Docker image store (admin) --------------------------------
 * `docker images --format '{{json .}}'` — one JSON object per line, via the
 * broker's read-only docker_image_ls verb (no user input on this action at
 * all). Cross-referenced against `docker ps -a` (mode=used) for a cheap
 * "in use" hint; best-effort only, never blocks the list from rendering if
 * that second call fails. */
if ($action === 'images') {
    if (!$isAdmin) reply_finish(false, 'ERROR_PERMISSION');

    $resp = broker_docker_image_ls('images_json');
    $out = (!empty($resp['ok']) && isset($resp['out'])) ? $resp['out'] : [];
    $images = [];
    foreach ($out as $line) {
        $row = json_decode($line, true);
        if (!is_array($row) || empty($row['ID'])) continue;
        $images[] = [
            'id'         => (string) $row['ID'],
            'repository' => isset($row['Repository']) ? (string) $row['Repository'] : '<none>',
            'tag'        => isset($row['Tag']) ? (string) $row['Tag'] : '<none>',
            'size'       => isset($row['Size']) ? (string) $row['Size'] : '',
            'created'    => isset($row['CreatedSince']) ? (string) $row['CreatedSince']
                           : (isset($row['CreatedAt']) ? (string) $row['CreatedAt'] : ''),
        ];
    }

    $used = [];
    $uresp = broker_docker_image_ls('used');
    $cout = (!empty($uresp['ok']) && isset($uresp['out'])) ? $uresp['out'] : [];
    foreach ($cout as $ref) {
        $ref = trim($ref);
        if ($ref !== '') $used[$ref] = true;
    }
    foreach ($images as &$im) {
        $ref = ($im['repository'] !== '<none>' && $im['tag'] !== '<none>')
            ? ($im['repository'] . ':' . $im['tag']) : '';
        $im['in_use'] = ($ref !== '' && isset($used[$ref])) || isset($used[$im['id']]);
    }
    unset($im);

    reply_raw(['result' => true, 'data' => $images]);
}

/* ---- rmi: delete a local Docker image (admin) ---------------------------------
 * `docker rmi <ref>` via the broker's docker_image_rmi verb (Stage 4) — never
 * `-f`/force. An image still referenced by a container (running or stopped)
 * fails on its own with Docker's own error text, which is surfaced back to
 * the caller near-verbatim instead of being swallowed — that IS the "in use"
 * protection, no separate check needed. */
if ($action === 'rmi') {
    if (!$isAdmin) reply_finish(false, 'ERROR_PERMISSION');
    $ref = isset($body['ref']) ? trim((string) $body['ref']) : '';
    if ($ref === '' || strlen($ref) > 256 || !(preg_match(PNQ_REF_RE, $ref) || preg_match(PNQ_ID_RE, $ref))) {
        fail(422, 'Not a valid image reference or id.');
    }

    $resp = broker_docker_image_rmi($ref);
    $msg = trim(implode("\n", isset($resp['out']) ? $resp['out'] : []));
    if ($msg === '' && isset($resp['err'])) $msg = trim($resp['err']);
    if (empty($resp['ok']) || $resp['rc'] != 0) {
        reply_finish(false, $msg !== '' ? $msg : ('Could not delete ' . $ref . '.'));
    }
    reply_finish(true, 'success');
}

fail(400, 'unknown action');
