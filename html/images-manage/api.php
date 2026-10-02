<?php
/**
 * images-manage/api.php — Local image manager backend (PNetLab v8).
 *
 * Admin-only endpoint (token-cookie, same gate as ishare2/api.php).
 * All writes into /opt/unetlab/addons/ are routed through the privilege broker
 * (pnetlab-brokerd verb_fs_op, jailed to FS_JAILS) since www-data has no sudo.
 * Temp assembly area for uploads: /opt/unetlab/tmp/uploads/<token>/ (in FS_JAILS).
 *
 * Endpoints (all return JSON):
 *   GET  ?action=list                              → {qemu:[{dir,files:[{name,size}]}], iol:[{name,size}], dynamips:[{name,size}]}
 *   POST ?action=mkdir    {type, name}             → create qemu image directory
 *   POST ?action=rename   {type, path, newname}    → rename file or directory
 *   POST ?action=delete   {type, path}             → delete file or directory
 *   GET  ?action=download_file   &type=…&path=…    → stream file as attachment
 *   GET  ?action=download_folder &type=qemu&dir=… → stream tar as attachment
 *   POST ?action=upload_init   {type, filename, size, chunks, dir?}  → {token, chunk_size}
 *   POST ?action=upload_chunk  &token=…&idx=N  (raw body = bytes)    → {ok}
 *   POST ?action=upload_finish {token}             → move assembled file into addons
 *   POST ?action=upload_cancel {token}             → discard temp upload dir
 */
error_reporting(E_ERROR | E_PARSE);
header('Content-Type: application/json');
header('Cache-Control: no-store');

define('ADDONS',      '/opt/unetlab/addons');
define('UPLOAD_TMP',  '/opt/unetlab/tmp/uploads');
define('CHUNK_SIZE',  4 * 1024 * 1024);    // 4 MB — stays under post_max_size=8M

// Engine bootstrap: indentify + broker_call
require_once '/opt/unetlab/html/includes/init.php';
require_once '/opt/unetlab/html/includes/broker.php';
// Shared qemu dir-name normaliser (same as ishare2)
require_once '/opt/unetlab/html/ishare2/image_normalize.php';

/* ---- AUTH — admin-only ----------------------------------------------- */
$_imgmgr_indent = new \indentify();
list($_imgmgr_user, , ) = $_imgmgr_indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($_imgmgr_user === false || empty($_imgmgr_user)) {
    http_response_code(401); echo json_encode(['error' => 'not authenticated']); exit;
}
$_imgmgr_role = isset($_imgmgr_user['role']) ? $_imgmgr_user['role'] : '';
if (!($_imgmgr_role === 0 || $_imgmgr_role === '0' || strtolower((string) $_imgmgr_role) === 'admin')) {
    http_response_code(403); echo json_encode(['error' => 'image manager is admin-only']); exit;
}
unset($_imgmgr_indent, $_imgmgr_user, $_imgmgr_role);

/* ---- Helpers ---------------------------------------------------------- */
function out($x) { echo json_encode($x); exit; }
function fail($m, $code = 400) { http_response_code($code); echo json_encode(['error' => $m]); exit; }

function human_size($bytes) {
    if ($bytes < 1024) return $bytes . ' B';
    if ($bytes < 1048576) return round($bytes / 1024, 1) . ' KB';
    if ($bytes < 1073741824) return round($bytes / 1048576, 1) . ' MB';
    return round($bytes / 1073741824, 2) . ' GB';
}

/** Validate a bare filename / dirname: no path separators, no NUL, no control chars, non-empty. */
function valid_name($n) {
    if (!is_string($n) || $n === '' || $n === '.' || $n === '..') return false;
    // No slash, backslash, NUL, or control characters
    if (preg_match('/[\x00-\x1f\x7f\/\\\\]/', $n)) return false;
    // No leading dot (hidden files) — optional but safe
    return true;
}

/** Validate that a relative path stays within addons (no .. escapes). Returns real path or false. */
function jailed_path($rel, $base = ADDONS) {
    // rel must not start with / or contain null
    if (!is_string($rel) || strpos($rel, "\x00") !== false) return false;
    $rel = ltrim($rel, '/\\');
    // No .. segments
    $parts = explode('/', $rel);
    foreach ($parts as $p) {
        if ($p === '..') return false;
    }
    $candidate = $base . '/' . $rel;
    // If it already exists, use realpath; otherwise check the parent
    if (file_exists($candidate)) {
        $real = realpath($candidate);
    } else {
        $parent = realpath(dirname($candidate));
        if ($parent === false) return false;
        $real = $parent . '/' . basename($candidate);
    }
    // Must be under addons or UPLOAD_TMP (when $base is UPLOAD_TMP)
    $allowed = [ADDONS, UPLOAD_TMP];
    foreach ($allowed as $jail) {
        if (strpos($real . '/', $jail . '/') === 0) return $real;
    }
    return false;
}

/** Extension whitelist per type. */
function allowed_ext($type, $filename) {
    $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    switch ($type) {
        case 'qemu':     return in_array($ext, ['qcow2', 'img', 'vmdk', 'iso'], true);
        case 'iol':      return $ext === 'bin';
        case 'dynamips': return in_array($ext, ['image', 'bin'], true);
    }
    return false;
}

/** Call broker fs_op with one or two paths. */
function fs_op($op, $path, $dst = null) {
    $args = ['op' => $op, 'path' => $path];
    if ($dst !== null) $args['dst'] = $dst;
    return broker_call('fs_op', $args, 120);
}

/**
 * addons/iol/bin is excluded from verb_fs_op's write jail (it's where the
 * broker root-execs CiscoIOUKeygen3.py from — see pnetlab-brokerd.py
 * FS_WRITE_DENY), so install/rename/delete of IOL .bin images go through the
 * narrow, filename-locked verb_iol_bin_op instead. $extra carries the op's
 * extra bare-name arg (src+name for install, name+newname for rename, name
 * for delete) — never a full path, the broker composes the destination
 * itself from ADDONS/iol/bin + the filename.
 */
function iol_bin_op($op, $extra) {
    return broker_call('iol_bin_op', array_merge(['op' => $op], $extra), 120);
}

/** Parse the JSON body (falls back to POST). */
function json_body() {
    static $parsed = null;
    if ($parsed === null) {
        $raw = file_get_contents('php://input');
        $parsed = ($raw !== false && strlen($raw) > 0) ? (json_decode($raw, true) ?: []) : [];
    }
    return $parsed;
}

/* ---- Routing ---------------------------------------------------------- */
$action = $_GET['action'] ?? '';

/* ================================================================
   LIST — GET ?action=list
   ================================================================ */
if ($action === 'list') {
    $result = ['qemu' => [], 'iol' => [], 'dynamips' => []];

    // QEMU: scan addons/qemu/ dirs
    $qbase = ADDONS . '/qemu';
    if (is_dir($qbase)) {
        $dirs = @scandir($qbase);
        if ($dirs) {
            foreach ($dirs as $d) {
                if ($d === '.' || $d === '..') continue;
                $dpath = $qbase . '/' . $d;
                if (!is_dir($dpath)) continue;
                $files = [];
                $flist = @scandir($dpath);
                if ($flist) {
                    foreach ($flist as $f) {
                        if ($f === '.' || $f === '..') continue;
                        $fpath = $dpath . '/' . $f;
                        if (!is_file($fpath)) continue;
                        $sz = @filesize($fpath);
                        $files[] = ['name' => $f, 'size' => $sz === false ? 0 : $sz, 'human' => human_size($sz === false ? 0 : $sz)];
                    }
                }
                // Total dir size
                $total = array_sum(array_column($files, 'size'));
                $result['qemu'][] = ['dir' => $d, 'files' => $files, 'total' => $total, 'human' => human_size($total)];
            }
        }
    }

    // IOL: scan addons/iol/bin/*.bin
    $ibase = ADDONS . '/iol/bin';
    if (is_dir($ibase)) {
        $flist = @scandir($ibase);
        if ($flist) {
            foreach ($flist as $f) {
                if ($f === '.' || $f === '..') continue;
                $fpath = $ibase . '/' . $f;
                if (!is_file($fpath)) continue;
                $sz = @filesize($fpath);
                $result['iol'][] = ['name' => $f, 'size' => $sz === false ? 0 : $sz, 'human' => human_size($sz === false ? 0 : $sz)];
            }
        }
    }

    // Dynamips: scan addons/dynamips/
    $dbase = ADDONS . '/dynamips';
    if (is_dir($dbase)) {
        $flist = @scandir($dbase);
        if ($flist) {
            foreach ($flist as $f) {
                if ($f === '.' || $f === '..') continue;
                $fpath = $dbase . '/' . $f;
                if (!is_file($fpath)) continue;
                $sz = @filesize($fpath);
                $result['dynamips'][] = ['name' => $f, 'size' => $sz === false ? 0 : $sz, 'human' => human_size($sz === false ? 0 : $sz)];
            }
        }
    }

    out($result);
}

/* ================================================================
   MKDIR — POST ?action=mkdir {type, name}
   Only meaningful for qemu (creates addons/qemu/<normalised-name>/)
   ================================================================ */
if ($action === 'mkdir') {
    $b    = json_body();
    $type = $b['type'] ?? '';
    $name = trim($b['name'] ?? '');
    if ($type !== 'qemu') fail('mkdir only valid for qemu type');
    if (!valid_name($name)) fail('invalid directory name');
    $name = pnq_normalize_qemu_dirname($name);
    if (!valid_name($name)) fail('normalized name is invalid');

    $target = ADDONS . '/qemu/' . $name;
    // Safety: already exists is fine
    $r1 = fs_op('mkdir_p', $target);
    if (!$r1['ok']) fail('mkdir failed: ' . $r1['err']);
    $r2 = fs_op('chown_www', $target);   // so www-data can write into it during upload assembly
    if (!$r2['ok']) fail('chown failed: ' . $r2['err']);
    $r3 = fs_op('chmod_755', $target);
    if (!$r3['ok']) fail('chmod failed: ' . $r3['err']);
    out(['ok' => true, 'dir' => $name]);
}

/* ================================================================
   RENAME — POST ?action=rename {type, path, newname}
   path = relative inside type root (e.g. "vios-adventerprisek9-m" or "vios-adventerprisek9-m/virtioa.qcow2")
   newname = bare filename/dirname (no slashes)
   ================================================================ */
if ($action === 'rename') {
    $b       = json_body();
    $type    = $b['type'] ?? '';
    $path    = trim($b['path'] ?? '');
    $newname = trim($b['newname'] ?? '');

    if (!in_array($type, ['qemu', 'iol', 'dynamips'], true)) fail('bad type');
    if (!valid_name($newname)) fail('invalid new name');

    // Derive base path for the type
    switch ($type) {
        case 'qemu':     $base = ADDONS . '/qemu'; break;
        case 'iol':      $base = ADDONS . '/iol/bin'; break;
        case 'dynamips': $base = ADDONS . '/dynamips'; break;
    }

    $src = jailed_path($path, $base);
    if ($src === false || !file_exists($src)) fail('source not found or path invalid');

    // dst is same directory, new basename
    $dst = dirname($src) . '/' . $newname;
    // Verify dst is still jailed
    $dst_check = jailed_path(substr($dst, strlen(ADDONS) + 1));
    if ($dst_check === false) fail('destination escapes jail');

    $r = $type === 'iol'
        ? iol_bin_op('rename', ['name' => basename($src), 'newname' => $newname])
        : fs_op('mv_f', $src, $dst);
    if (!$r['ok']) fail('rename failed: ' . $r['err']);
    out(['ok' => true]);
}

/* ================================================================
   DELETE — POST ?action=delete {type, path}
   path = relative inside type root
   ================================================================ */
if ($action === 'delete') {
    $b    = json_body();
    $type = $b['type'] ?? '';
    $path = trim($b['path'] ?? '');

    if (!in_array($type, ['qemu', 'iol', 'dynamips'], true)) fail('bad type');

    switch ($type) {
        case 'qemu':     $base = ADDONS . '/qemu'; break;
        case 'iol':      $base = ADDONS . '/iol/bin'; break;
        case 'dynamips': $base = ADDONS . '/dynamips'; break;
    }

    $target = jailed_path($path, $base);
    if ($target === false) fail('invalid path');

    // Guard: never delete the type root itself
    $roots = [ADDONS . '/qemu', ADDONS . '/iol/bin', ADDONS . '/dynamips'];
    if (in_array(rtrim($target, '/'), $roots, true)) fail('cannot delete addon root');

    if (!file_exists($target) && !is_dir($target)) fail('path not found', 404);

    $r = $type === 'iol'
        ? iol_bin_op('delete', ['name' => basename($target)])
        : fs_op('rm_rf', $target);
    if (!$r['ok']) fail('delete failed: ' . $r['err']);
    out(['ok' => true]);
}

/* ================================================================
   DOWNLOAD_FILE — GET ?action=download_file &type=…&path=…
   Streams the file to the browser as an attachment.
   Uses readfile() in chunks (no X-Accel so it works without nginx config change).
   ================================================================ */
if ($action === 'download_file') {
    $type = $_GET['type'] ?? '';
    $path = trim($_GET['path'] ?? '');

    if (!in_array($type, ['qemu', 'iol', 'dynamips'], true)) fail('bad type');

    switch ($type) {
        case 'qemu':     $base = ADDONS . '/qemu'; break;
        case 'iol':      $base = ADDONS . '/iol/bin'; break;
        case 'dynamips': $base = ADDONS . '/dynamips'; break;
    }

    $target = jailed_path($path, $base);
    if ($target === false || !is_file($target)) fail('file not found', 404);

    $filename = basename($target);
    $size = @filesize($target);

    // Clear the JSON header set at the top — we're streaming a file
    header_remove('Content-Type');
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . addslashes($filename) . '"');
    if ($size !== false) header('Content-Length: ' . $size);
    header('Cache-Control: no-store');

    $fp = @fopen($target, 'rb');
    if ($fp === false) { http_response_code(500); echo 'cannot open file'; exit; }
    while (!feof($fp)) {
        echo fread($fp, 65536);
        if (connection_aborted()) break;
    }
    fclose($fp);
    exit;
}

/* ================================================================
   DOWNLOAD_FOLDER — GET ?action=download_folder &type=qemu&dir=…
   Streams a tar of the qemu image dir to the browser.
   tar runs as www-data — qemu dirs are world-readable (755) so this works.
   ================================================================ */
if ($action === 'download_folder') {
    $type = $_GET['type'] ?? '';
    $dir  = trim($_GET['dir'] ?? '');

    if ($type !== 'qemu') fail('folder download only supported for qemu type');
    if (!valid_name($dir)) fail('invalid dir name');

    $qbase  = ADDONS . '/qemu';
    $target = jailed_path($dir, $qbase);
    if ($target === false || !is_dir($target)) fail('directory not found', 404);

    $dirname = basename($target);   // safe basename after jail check

    // Escape for shell (dirname should be safe but use escapeshellarg anyway)
    $base_esc = escapeshellarg($qbase);
    $dir_esc  = escapeshellarg($dirname);

    header_remove('Content-Type');
    header('Content-Type: application/x-tar');
    header('Content-Disposition: attachment; filename="' . addslashes($dirname) . '.tar"');
    header('Cache-Control: no-store');
    header('Transfer-Encoding: chunked');

    $fp = popen("tar -C $base_esc -cf - $dir_esc 2>/dev/null", 'r');
    if ($fp === false) { http_response_code(500); echo 'tar failed'; exit; }
    while (!feof($fp)) {
        $chunk = fread($fp, 65536);
        if ($chunk !== false && strlen($chunk) > 0) echo $chunk;
        if (connection_aborted()) break;
    }
    pclose($fp);
    exit;
}

/* ================================================================
   UPLOAD_INIT — POST ?action=upload_init
   Body: {type, filename, size, chunks, dir?}
   Validates, creates temp dir, returns {token, chunk_size}.
   ================================================================ */
if ($action === 'upload_init') {
    $b        = json_body();
    $type     = $b['type']     ?? '';
    $filename = trim($b['filename'] ?? '');
    $size     = (int)($b['size']    ?? 0);
    $chunks   = (int)($b['chunks']  ?? 0);
    $dir      = trim($b['dir']      ?? '');   // qemu sub-dir (for qemu type)

    if (!in_array($type, ['qemu', 'iol', 'dynamips'], true)) fail('bad type');
    if (!valid_name($filename))       fail('invalid filename');
    if (!allowed_ext($type, $filename)) fail('file extension not allowed for this image type');
    if ($size <= 0)   fail('invalid size');
    if ($chunks <= 0) fail('invalid chunk count');

    // Validate qemu target dir
    if ($type === 'qemu') {
        if ($dir === '') fail('dir is required for qemu uploads');
        if (!valid_name($dir)) fail('invalid dir name');
        $dir = pnq_normalize_qemu_dirname($dir);
        if (!valid_name($dir)) fail('normalized dir name is invalid');
        $target_dir = ADDONS . '/qemu/' . $dir;
        // Auto-create on demand: a folder upload imports a brand-new image dir named after the
        // dropped folder, so the dir won't exist yet. (upload_finish also mkdir_p's it.)
        if (!is_dir($target_dir)) {
            $r = fs_op('mkdir_p', $target_dir);
            if (!$r['ok']) fail('could not create qemu dir: ' . $r['err']);
            fs_op('chown_www', $target_dir);
            fs_op('chmod_755', $target_dir);
        }
    }

    // Disk space precheck (check against the addons partition)
    $free = @disk_free_space(ADDONS);
    if ($free !== false && $size > $free * 0.95) {
        fail('insufficient disk space (need ' . human_size($size) . ', free ' . human_size($free) . ')');
    }

    // Mint upload token
    $token = bin2hex(random_bytes(16));

    // Create temp upload dir as www-data (UPLOAD_TMP is in FS_JAILS → broker can touch it too)
    $tmp_dir = UPLOAD_TMP . '/' . $token;
    if (!@mkdir($tmp_dir, 0700, true)) fail('could not create upload temp dir');

    // Persist upload metadata alongside the parts
    $meta = [
        'type'     => $type,
        'filename' => $filename,
        'size'     => $size,
        'chunks'   => $chunks,
        'dir'      => $dir,        // only relevant for qemu
        'created'  => time(),
        'received' => 0,
    ];
    file_put_contents($tmp_dir . '/.meta.json', json_encode($meta));
    chmod($tmp_dir . '/.meta.json', 0600);

    out(['token' => $token, 'chunk_size' => CHUNK_SIZE]);
}

/* ================================================================
   UPLOAD_CHUNK — POST ?action=upload_chunk &token=…&idx=N
   Raw body = chunk bytes (≤ chunk_size). Appended to part.N in tmp dir.
   No JSON Content-Type — reads php://input directly.
   ================================================================ */
if ($action === 'upload_chunk') {
    // Change Content-Type header to JSON for error responses (already set at top)
    $token = $_GET['token'] ?? '';
    $idx   = (int)($_GET['idx'] ?? -1);

    if (!preg_match('/^[a-f0-9]{32}$/', $token)) fail('bad token');
    if ($idx < 0) fail('bad idx');

    $tmp_dir = UPLOAD_TMP . '/' . $token;
    if (!is_dir($tmp_dir)) fail('unknown token', 404);

    $meta_file = $tmp_dir . '/.meta.json';
    if (!file_exists($meta_file)) fail('meta missing', 500);
    $meta = json_decode(file_get_contents($meta_file), true);
    if (!$meta) fail('meta corrupt', 500);

    if ($idx >= $meta['chunks']) fail('idx out of range');

    // Read raw body — never use $_FILES (upload_max_filesize=2M would block it)
    $data = file_get_contents('php://input');
    if ($data === false || strlen($data) === 0) fail('empty chunk body');
    if (strlen($data) > CHUNK_SIZE + 1024) fail('chunk too large');   // small slack for overhead

    $part_file = $tmp_dir . '/part.' . $idx;
    $written = file_put_contents($part_file, $data, LOCK_EX);
    if ($written === false) fail('write failed', 500);

    // Update received count (best-effort, non-atomic — just for progress)
    $meta['received'] = ($meta['received'] ?? 0) + $written;
    file_put_contents($meta_file, json_encode($meta));

    out(['ok' => true, 'idx' => $idx, 'written' => $written]);
}

/* ================================================================
   UPLOAD_FINISH — POST ?action=upload_finish {token}
   Concatenates parts, then broker mv_f into addons + perms + cleanup.
   ================================================================ */
if ($action === 'upload_finish') {
    $b     = json_body();
    $token = trim($b['token'] ?? '');
    if (!preg_match('/^[a-f0-9]{32}$/', $token)) fail('bad token');

    $tmp_dir = UPLOAD_TMP . '/' . $token;
    if (!is_dir($tmp_dir)) fail('unknown token', 404);

    $meta_file = $tmp_dir . '/.meta.json';
    if (!file_exists($meta_file)) fail('meta missing', 500);
    $meta = json_decode(file_get_contents($meta_file), true);
    if (!$meta) fail('meta corrupt', 500);

    $type     = $meta['type'];
    $filename = $meta['filename'];
    $chunks   = (int)$meta['chunks'];
    $dir      = $meta['dir'] ?? '';

    // Verify all parts present
    for ($i = 0; $i < $chunks; $i++) {
        $part = $tmp_dir . '/part.' . $i;
        if (!file_exists($part)) fail("missing part $i of $chunks");
    }

    // Assemble parts as www-data (in UPLOAD_TMP — writable without broker)
    $assembled = $tmp_dir . '/' . $filename;
    $out_fp = @fopen($assembled, 'wb');
    if ($out_fp === false) fail('cannot open assembled file for writing', 500);
    for ($i = 0; $i < $chunks; $i++) {
        $part_fp = @fopen($tmp_dir . '/part.' . $i, 'rb');
        if ($part_fp === false) { fclose($out_fp); fail("cannot read part $i", 500); }
        while (!feof($part_fp)) {
            $chunk = fread($part_fp, 65536);
            if ($chunk !== false) fwrite($out_fp, $chunk);
        }
        fclose($part_fp);
    }
    fclose($out_fp);

    // Determine final destination
    switch ($type) {
        case 'qemu':
            $dest_dir = ADDONS . '/qemu/' . pnq_normalize_qemu_dirname($dir);
            // Ensure dest dir exists (should from mkdir step but be safe)
            $r = fs_op('mkdir_p', $dest_dir);
            if (!$r['ok']) {
                @unlink($assembled);
                fs_op('rm_rf', $tmp_dir);
                fail('mkdir for qemu dir failed: ' . $r['err']);
            }
            $dest = $dest_dir . '/' . $filename;
            break;
        case 'iol':
            $dest = ADDONS . '/iol/bin/' . $filename;
            break;
        case 'dynamips':
            $dest = ADDONS . '/dynamips/' . $filename;
            break;
        default:
            fail('bad type in meta');
    }

    if ($type === 'iol') {
        // addons/iol/bin is outside verb_fs_op's write jail (see iol_bin_op()
        // above) — install + chmod happen together, broker-side.
        $r = iol_bin_op('install', ['src' => $assembled, 'name' => $filename]);
        if (!$r['ok']) {
            @unlink($assembled);
            fail('move into addons failed: ' . $r['err']);
        }
    } else {
        // Broker mv_f: moves from tmp (in FS_JAILS) to addons (in FS_JAILS)
        $r = fs_op('mv_f', $assembled, $dest);
        if (!$r['ok']) {
            @unlink($assembled);
            fail('move into addons failed: ' . $r['err']);
        }
        // Fix ownership + permissions so node handlers can read
        fs_op('chmod_755', $dest);   // best-effort
    }

    // Cleanup temp dir
    fs_op('rm_rf', $tmp_dir);

    out(['ok' => true, 'dest' => $dest]);
}

/* ================================================================
   UPLOAD_CANCEL — POST ?action=upload_cancel {token}
   Discards temp upload dir.
   ================================================================ */
if ($action === 'upload_cancel') {
    $b     = json_body();
    $token = trim($b['token'] ?? '');
    if (!preg_match('/^[a-f0-9]{32}$/', $token)) fail('bad token');

    $tmp_dir = UPLOAD_TMP . '/' . $token;
    if (!is_dir($tmp_dir)) out(['ok' => true]);   // already gone

    // Clean up without broker (UPLOAD_TMP is writable by www-data)
    // Use broker rm_rf for safety (it's jailed anyway)
    fs_op('rm_rf', $tmp_dir);
    out(['ok' => true]);
}

fail('unknown action');
