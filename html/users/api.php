<?php
/**
 * users/api.php — engine-side User + Role management for the self-created
 * dashboard. Token-cookie authenticated, ADMIN-ONLY (same pattern as
 * cluster/api.php and status/api.php). Operates on the engine DB via the
 * engine's own checkDatabase() PDO helper — the same users/user_roles/
 * user_permission tables the Laravel store uses. Offline local accounts.
 *
 *   GET  ?action=users        → [{pod,username,email,role,role_name,user_status,note}]
 *   POST ?action=user_add     {username,password,email,role,note,user_status}
 *   POST ?action=user_edit    {pod,email,role,note,user_status,password?}
 *   POST ?action=user_delete  {pod}
 *   GET  ?action=roles        → [{id,name,workspace,cpu,ram,hdd,perms[],users}]
 *   GET  ?action=permcatalog  → [permission names]
 *   POST ?action=role_add     {name,workspace,cpu,ram,hdd,permissions[]}
 *   POST ?action=role_edit    {id,name,workspace,cpu,ram,hdd,permissions[]}
 *   POST ?action=role_delete  {id}
 *
 * `role` is a TEXT field: "0" = built-in Admin (full perms, never a table row);
 * any other value = a user_roles.user_role_id. Passwords are sha256 (engine
 * convention). Mirrors the store's offline UsersController/User_rolesController.
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';
require_once '/opt/unetlab/html/includes/password_reset.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function out($x) { echo json_encode($x); exit; }
function fail($code, $m) { http_response_code($code); echo json_encode(['error' => $m]); exit; }
function body() { $b = json_decode(file_get_contents('php://input'), true); return is_array($b) ? $b : []; }
function input_bool($v) { return $v === true || $v === 1 || $v === '1'; }

/* Older installs predate the per-user workspace override column. Add it lazily
   (information_schema probe + ALTER) so this shim works on any schema vintage. */
function ensure_user_workspace_col($db) {
    static $done = false;
    if ($done) return;
    $done = true;
    try {
        $q = $db->query("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_workspace'");
        if ((int) $q->fetchColumn() === 0) {
            $db->exec('ALTER TABLE users ADD COLUMN user_workspace text NULL');
        }
    } catch (Exception $e) {
        // Non-fatal: a locked-down grant may forbid DDL. Reads/writes of the
        // column will surface any real problem to the caller.
    }
}

/* Older installs predate the external-authentication flag. Same lazy-ALTER
   pattern as ensure_user_workspace_col (postinst + fix-db-migrations.sh carry
   the authoritative migration; this is belt and braces for this shim). */
function ensure_ext_auth_col($db) {
    static $done = false;
    if ($done) return;
    $done = true;
    try {
        $q = $db->query("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'ext_auth'");
        if ((int) $q->fetchColumn() === 0) {
            $db->exec('ALTER TABLE users ADD COLUMN ext_auth varchar(8) DEFAULT NULL');
        }
    } catch (Exception $e) {
        // Non-fatal, same rationale as ensure_user_workspace_col.
    }
}

/* users.ext_auth: NULL = local password, 'radius'/'ldap' = the broker verifies
   the password against that directory at login. */
function san_ext_auth($v) {
    $v = strtolower(trim((string) $v));
    return ($v === 'radius' || $v === 'ldap') ? $v : null;
}

/* Normalise a workspace path: '' -> null; must start with '/'; trailing '/'
   trimmed (except the bare root). */
function san_workspace($v) {
    $v = trim((string) $v);
    if ($v === '') return null;
    if ($v[0] !== '/') $v = '/' . $v;
    if (strlen($v) > 1) $v = rtrim($v, '/');
    if ($v === '') $v = '/';
    return $v;
}

/* Effective landing/enforcement workspace for a user row: per-user override
   (user_workspace) if set, else the role's user_role_workspace, else '/'. */
function effective_workspace($db, $userWorkspace, $roleId) {
    $uw = san_workspace($userWorkspace);
    if ($uw !== null) return $uw;
    if ((string) $roleId !== '0' && $roleId !== null && $roleId !== '') {
        $st = $db->prepare('SELECT user_role_workspace FROM user_roles WHERE user_role_id=:id');
        $st->execute(['id' => $roleId]);
        $rw = $st->fetchColumn();
        if ($rw !== false && trim((string) $rw) !== '') {
            $rw = trim((string) $rw);
            if ($rw[0] !== '/') $rw = '/' . $rw;
            return $rw;
        }
    }
    return '/';
}

/* Per-user resource limit: positive int caps usage, 0/blank = unlimited (stored NULL).
   user_max_cpu = max concurrent vCPUs, user_max_ram = max concurrent RAM in MB — the
   engine already enforces both at node start (__node.php::updateRunning_start). */
function san_limit($v) {
    if ($v === null || $v === '') return null;
    $n = (int) $v;
    return $n > 0 ? $n : null;
}
/* Allowed weekdays as PHP date('N') digits 1=Mon..7=Sun, e.g. "12345" = Mon–Fri.
   Blank = any day (stored NULL). */
function san_days($v) {
    $v = preg_replace('/[^1-7]/', '', (string) $v);
    if ($v === '') return null;
    $s = array_unique(str_split($v));
    sort($s);
    return implode('', $s);
}
/* "From"/"To" bounds of the absolute lab-access window. The UI sends a datetime-local
   string "YYYY-MM-DDTHH:MM" (server-local); we store a UNIX epoch in active_time /
   expired_time, which the auth path already enforces ("not yet active" / "expired").
   Blank = no bound (stored NULL). Returns false on a malformed value so the caller
   can reject it. */
function san_dt($v) {
    $v = trim((string) $v);
    if ($v === '') return null;
    $t = strtotime($v);
    return $t === false ? false : $t;
}

// Fixed permission catalog (matches the store's USER_PER_* constants).
$PERM_CATALOG = ['ADD_FOLDER', 'EDIT_FOLDER', 'DELETE_FOLDER', 'ADD_LAB', 'EDIT_LAB',
    'DELETE_LAB', 'RENAME_LAB', 'CLONE_LAB', 'MOVE_LAB', 'IMPORT_LAB', 'EXPORT_LAB',
    'OPEN_LAB', 'JOIN_LAB', 'EDIT_TASKS'];

/* ---- AUTH — admin only ------------------------------------------------------ */
$indent = new \indentify();
list($user, , $autherr) = $indent->authorization(isset($_COOKIE['token']) ? $_COOKIE['token'] : '');
if ($user === false || empty($user)) fail(401, 'not authenticated');
$role = isset($user['role']) ? $user['role'] : '';
$isAdmin = ($role === 0 || $role === '0' || strtolower((string) $role) === 'admin');

$action = $_GET['action'] ?? '';

/* Effective workspace of the CURRENT user — available to ANY authenticated
   caller (not just admins), so the dashboard can land a fresh non-admin in a
   folder they can actually access. MUST stay above the admin-only guard. */
if ($action === 'myworkspace') {
    if ($isAdmin) out(['workspace' => '/']);
    try {
        $db = checkDatabase();
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        ensure_user_workspace_col($db);
        $uw = isset($user['user_workspace']) ? $user['user_workspace'] : null;
        out(['workspace' => effective_workspace($db, $uw, $role)]);
    } catch (Exception $e) {
        out(['workspace' => '/']);
    }
}

/* Self-service password change — available to ANY authenticated caller for
   THEIR OWN account (the store gated this admin-only, an artifact we drop).
   POST {old_pass,new_pass}; verify sha256(old_pass) == the caller's stored
   hash, then write sha256(new_pass) keyed on the authenticated pod. MUST stay
   above the admin-only guard. */
if ($action === 'change_password') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST required');
    $b = body();
    $oldPass = (string) ($b['old_pass'] ?? '');
    $newPass = (string) ($b['new_pass'] ?? '');
    if ($oldPass === '' || $newPass === '') fail(400, 'Current and new password are both required.');
    if (strlen($newPass) < 4) fail(400, 'New password is too short.');
    $stored = isset($user[USER_PASSWORD]) ? $user[USER_PASSWORD] : '';
    if (!hash_equals((string) $stored, hash('sha256', $oldPass))) fail(400, 'Current password is incorrect.');
    if (hash('sha256', $newPass) === (string) $stored) fail(400, 'New password must differ from the current one.');
    try {
        $db = checkDatabase();
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $st = $db->prepare('UPDATE users SET password = :p WHERE pod = :pod');
        $st->execute(['p' => hash('sha256', $newPass), 'pod' => $user['pod']]);
        out(['status' => 'success', 'message' => 'Password changed.']);
    } catch (Exception $e) {
        fail(500, 'Could not update the password.');
    }
}

/* Self-service HTML5-console preference — any authenticated caller may set it
   for THEIR OWN account. The left-pane console toggle POSTs here so users.html5
   (which api.php's apiGetLabNodes reads to build each node.url as either the web
   console URL or a native telnet:// URL) actually changes server-side. MUST stay
   above the admin-only guard. POST {html5:0|1}. */
if ($action === 'set_html5') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST required');
    $b = body();
    $raw = $b['html5'] ?? null;
    $v = ((string) $raw === '1') ? 1 : 0;
    try {
        $db = checkDatabase();
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $st = $db->prepare('UPDATE users SET html5 = :v WHERE pod = :pod');
        $st->execute(['v' => $v, 'pod' => $user['pod']]);
        out(['status' => 'success', 'html5' => $v]);
    } catch (Exception $e) {
        fail(500, 'Could not update the console preference.');
    }
}

if (!$isAdmin) fail(403, 'user management is admin-only');

if ($action === 'permcatalog') out(['data' => $PERM_CATALOG]);

/* ---- External authentication settings (admin-only broker proxies) ----------
   Secrets are WRITE-ONLY: extauth_get returns the broker's redacted view
   (secret_set / bind_pw_set booleans, never values); extauth_set accepts
   radius.secret / ldap.bind_pw on POST and forwards them over the local
   broker socket, where they land in the root-0600 config. */
if ($action === 'extauth_get') {
    $resp = broker_call('extauth_settings_read', [], 10);
    if (empty($resp['ok']) || empty($resp['out'])) fail(502, 'broker unavailable: ' . ($resp['err'] ?? ''));
    out(['data' => json_decode($resp['out'][count($resp['out']) - 1], true)]);
}

if ($action === 'extauth_set') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST required');
    $b = body();
    // forward only the known top-level keys; the broker re-validates every leaf
    $args = [];
    foreach (['enabled', 'mode', 'fallback_local', 'default_role', 'radius', 'ldap', 'group_map'] as $k) {
        if (array_key_exists($k, $b)) $args[$k] = $b[$k];
    }
    $resp = broker_call('extauth_settings_write', $args, 15);
    if (empty($resp['ok'])) fail(400, $resp['err'] !== '' ? $resp['err'] : 'settings rejected');
    out(['ok' => true, 'data' => json_decode($resp['out'][count($resp['out']) - 1], true)]);
}

if ($action === 'extauth_test') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST required');
    $b = body();
    $proto = (string) ($b['proto'] ?? '');
    if ($proto !== 'radius' && $proto !== 'ldap') fail(400, 'proto must be radius or ldap');
    $resp = broker_call('extauth_test', [
        'proto' => $proto,
        'username' => (string) ($b['username'] ?? ''),
        'password' => (string) ($b['password'] ?? ''),
    ], 45);
    if (empty($resp['ok']) || empty($resp['out'])) fail(400, $resp['err'] !== '' ? $resp['err'] : 'test failed');
    out(['data' => json_decode($resp['out'][count($resp['out']) - 1], true)]);
}

try {
    $db = checkDatabase();
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    ensure_user_workspace_col($db);
    ensure_ext_auth_col($db);

    if ($action === 'users') {
        $roles = [];
        foreach ($db->query('SELECT user_role_id,user_role_name FROM user_roles')->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $roles[(string) $r['user_role_id']] = $r['user_role_name'];
        }
        $rows = $db->query('SELECT pod,username,email,role,user_status,offline,note,user_max_cpu,user_max_ram,access_days,active_time,expired_time,user_workspace,ext_auth FROM users ORDER BY username')->fetchAll(PDO::FETCH_ASSOC);
        $data = array_map(function ($u) use ($roles) {
            $rn = ((string) $u['role'] === '0') ? 'Admin' : ($roles[(string) $u['role']] ?? ('role ' . $u['role']));
            return ['pod' => (int) $u['pod'], 'username' => $u['username'], 'email' => $u['email'],
                'role' => (string) $u['role'], 'role_name' => $rn, 'user_status' => (int) $u['user_status'],
                'offline' => (int) $u['offline'], 'note' => $u['note'],
                'workspace' => (string) ($u['user_workspace'] ?? ''),
                'max_cpu' => isset($u['user_max_cpu']) && $u['user_max_cpu'] !== null ? (int) $u['user_max_cpu'] : null,
                'max_ram' => isset($u['user_max_ram']) && $u['user_max_ram'] !== null ? (int) $u['user_max_ram'] : null,
                'ext_auth' => $u['ext_auth'] ?? null,
                'access_days' => (string) ($u['access_days'] ?? ''),
                'access_from' => (!empty($u['active_time']) && (int) $u['active_time'] > 0) ? date('Y-m-d\TH:i', (int) $u['active_time']) : '',
                'access_to' => (!empty($u['expired_time']) && (int) $u['expired_time'] > 0) ? date('Y-m-d\TH:i', (int) $u['expired_time']) : ''];
        }, $rows);
        out(['data' => $data]);
    }

    if ($action === 'user_add') {
        $b = body();
        $username = trim($b['username'] ?? '');
        $sendWelcome = input_bool(isset($b['send_welcome_email']) ? $b['send_welcome_email'] : false);
        $pass = (string) ($b['password'] ?? '');
        $email = trim($b['email'] ?? '');
        $extAuth = san_ext_auth($b['ext_auth'] ?? '');
        if ($username === '') fail(400, 'username is required');
        if ($pass === '' && !$sendWelcome) fail(400, 'password is required');
        if ($sendWelcome && $extAuth !== null) fail(409, 'welcome password links are only available for local accounts');
        if ($sendWelcome) {
            $deliveryError = password_reset_delivery_error($email);
            if ($deliveryError !== null) fail(400, $deliveryError);
            // Unknown to both the administrator and the user; the emailed token
            // is the only initial credential and replaces this hash on consume.
            $pass = bin2hex(random_bytes(32));
        }
        $chk = $db->prepare('SELECT COUNT(*) FROM users WHERE username=:u');
        $chk->execute(['u' => $username]);
        if ((int) $chk->fetchColumn() > 0) fail(409, 'a user with that username already exists');
        $afrom = san_dt($b['access_from'] ?? '');
        $ato = san_dt($b['access_to'] ?? '');
        if ($afrom === false || $ato === false) fail(400, 'access from/to must be a valid date & time, or blank');
        if ($afrom && $ato && $ato <= $afrom) fail(400, 'access "to" must be after "from"');
        $roleVal = (string) ($b['role'] ?? '0');
        $ws = san_workspace($b['workspace'] ?? '');
        // Land the new user somewhere they can actually reach: their effective
        // workspace (per-user override, else role default, else '/').
        $folder = effective_workspace($db, $ws, $roleVal);
        try {
            $db->beginTransaction();
            $ins = $db->prepare('INSERT INTO users (username,password,email,role,note,user_status,offline,folder,html5,user_max_cpu,user_max_ram,access_days,active_time,expired_time,user_workspace,ext_auth) VALUES (:u,:p,:e,:r,:n,:s,1,:fo,0,:mc,:mr,:ad,:af,:at,:uw,:ea)');
            $ins->execute([
                'u' => $username, 'p' => hash('sha256', $pass), 'e' => $email,
                'r' => $roleVal, 'n' => trim($b['note'] ?? ''), 's' => (int) ($b['user_status'] ?? 1),
                'fo' => $folder,
                'mc' => san_limit($b['max_cpu'] ?? ''), 'mr' => san_limit($b['max_ram'] ?? ''),
                'ad' => san_days($b['access_days'] ?? ''), 'af' => $afrom, 'at' => $ato, 'uw' => $ws,
                'ea' => $extAuth,
            ]);
            $newPod = (int) $db->lastInsertId();
            $welcomeToken = $sendWelcome ? password_reset_create_token($db, $newPod) : null;
            $db->commit();
        } catch (Throwable $e) {
            if ($db->inTransaction()) $db->rollBack();
            throw $e;
        }
        $response = ['ok' => true];
        if ($sendWelcome) {
            try {
                list($sent, $mailError) = password_reset_send_token($username, $email, $welcomeToken, 'welcome');
            } catch (Throwable $e) {
                $sent = false;
                $mailError = 'unexpected mail delivery failure';
                error_log('welcome mail failed after user creation: ' . $e->getMessage());
            }
            $response['email_sent'] = $sent;
            if (!$sent) $response['email_error'] = $mailError;
        }
        out($response);
    }

    if ($action === 'user_edit') {
        $b = body();
        $pod = (int) ($b['pod'] ?? 0);
        if (!$pod) fail(400, 'pod is required');
        $afrom = san_dt($b['access_from'] ?? '');
        $ato = san_dt($b['access_to'] ?? '');
        if ($afrom === false || $ato === false) fail(400, 'access from/to must be a valid date & time, or blank');
        if ($afrom && $ato && $ato <= $afrom) fail(400, 'access "to" must be after "from"');
        $roleVal = (string) ($b['role'] ?? '0');
        $ws = san_workspace($b['workspace'] ?? '');
        // Read the pre-edit role + workspace so we only re-home the landing folder
        // when one of them actually changes (never stomp a folder they've navigated
        // to via an unrelated edit).
        $cur = $db->prepare('SELECT role, user_workspace FROM users WHERE pod=:pod');
        $cur->execute(['pod' => $pod]);
        $curRow = $cur->fetch(PDO::FETCH_ASSOC);
        $sets = ['email=:e', 'role=:r', 'note=:n', 'user_status=:s', 'user_workspace=:uw',
            'user_max_cpu=:mc', 'user_max_ram=:mr', 'access_days=:ad', 'active_time=:af', 'expired_time=:at',
            'ext_auth=:ea'];
        $p = ['e' => trim($b['email'] ?? ''), 'r' => $roleVal,
            'n' => trim($b['note'] ?? ''), 's' => (int) ($b['user_status'] ?? 1), 'pod' => $pod, 'uw' => $ws,
            'mc' => san_limit($b['max_cpu'] ?? ''), 'mr' => san_limit($b['max_ram'] ?? ''),
            'ad' => san_days($b['access_days'] ?? ''), 'af' => $afrom, 'at' => $ato,
            'ea' => san_ext_auth($b['ext_auth'] ?? '')];
        if ($curRow) {
            $roleChanged = ((string) $curRow['role'] !== $roleVal);
            $wsChanged = (san_workspace($curRow['user_workspace'] ?? '') !== $ws);
            if ($roleChanged || $wsChanged) { $sets[] = 'folder=:fo'; $p['fo'] = effective_workspace($db, $ws, $roleVal); }
        }
        if (isset($b['password']) && $b['password'] !== '') { $sets[] = 'password=:pw'; $p['pw'] = hash('sha256', (string) $b['password']); }
        $db->prepare('UPDATE users SET ' . implode(',', $sets) . ' WHERE pod=:pod')->execute($p);
        out(['ok' => true]);
    }

    if ($action === 'user_delete') {
        $b = body();
        $pod = (int) ($b['pod'] ?? 0);
        if (!$pod) fail(400, 'pod is required');
        if (isset($user['pod']) && (int) $user['pod'] === $pod) fail(409, 'you cannot delete your own account');
        $tgt = $db->prepare('SELECT role FROM users WHERE pod=:pod');
        $tgt->execute(['pod' => $pod]);
        $trole = $tgt->fetchColumn();
        if ($trole === false) fail(404, 'no such user');
        if ((string) $trole === '0') {
            $cnt = (int) $db->query('SELECT COUNT(*) FROM users WHERE role="0"')->fetchColumn();
            if ($cnt <= 1) fail(409, 'cannot delete the last administrator');
        }
        $db->prepare('DELETE FROM users WHERE pod=:pod')->execute(['pod' => $pod]);
        out(['ok' => true]);
    }

    if ($action === 'roles') {
        $rows = $db->query('SELECT * FROM user_roles ORDER BY user_role_name')->fetchAll(PDO::FETCH_ASSOC);
        $perms = [];
        foreach ($db->query('SELECT user_per_role,user_per_name FROM user_permission')->fetchAll(PDO::FETCH_ASSOC) as $pp) {
            $perms[(string) $pp['user_per_role']][] = $pp['user_per_name'];
        }
        $counts = [];
        foreach ($db->query('SELECT role,COUNT(*) c FROM users GROUP BY role')->fetchAll(PDO::FETCH_ASSOC) as $c) {
            $counts[(string) $c['role']] = (int) $c['c'];
        }
        $data = array_map(function ($r) use ($perms, $counts) {
            $id = (string) $r['user_role_id'];
            return ['id' => (int) $r['user_role_id'], 'name' => $r['user_role_name'],
                'workspace' => $r['user_role_workspace'],
                'cpu' => $r['user_role_cpu'], 'ram' => $r['user_role_ram'], 'hdd' => $r['user_role_hdd'],
                'perms' => $perms[$id] ?? [], 'users' => $counts[$id] ?? 0];
        }, $rows);
        out(['data' => $data, 'admin_users' => $counts['0'] ?? 0]);
    }

    if ($action === 'role_add' || $action === 'role_edit') {
        $b = body();
        $name = trim($b['name'] ?? '');
        if ($name === '') fail(400, 'role name is required');
        if (strtolower($name) === 'admin') fail(409, '"admin" is the reserved built-in role');
        $ws = trim($b['workspace'] ?? '/'); if ($ws === '') $ws = '/'; if ($ws[0] !== '/') $ws = '/' . $ws;
        $cpu = isset($b['cpu']) && $b['cpu'] !== '' ? (float) $b['cpu'] : null;
        $ram = isset($b['ram']) && $b['ram'] !== '' ? (float) $b['ram'] : null;
        $hdd = isset($b['hdd']) && $b['hdd'] !== '' ? (float) $b['hdd'] : null;
        $permsIn = is_array($b['permissions'] ?? null) ? $b['permissions'] : [];
        $perms = array_values(array_intersect($PERM_CATALOG, $permsIn));   // whitelist

        if ($action === 'role_add') {
            $chk = $db->prepare('SELECT COUNT(*) FROM user_roles WHERE user_role_name=:n');
            $chk->execute(['n' => $name]);
            if ((int) $chk->fetchColumn() > 0) fail(409, 'a role with that name already exists');
            $db->prepare('INSERT INTO user_roles (user_role_name,user_role_workspace,user_role_cpu,user_role_ram,user_role_hdd) VALUES (:n,:w,:c,:r,:h)')
                ->execute(['n' => $name, 'w' => $ws, 'c' => $cpu, 'r' => $ram, 'h' => $hdd]);
            $id = (int) $db->lastInsertId();
        } else {
            $id = (int) ($b['id'] ?? 0);
            if (!$id) fail(400, 'role id is required');
            $db->prepare('UPDATE user_roles SET user_role_name=:n,user_role_workspace=:w,user_role_cpu=:c,user_role_ram=:r,user_role_hdd=:h WHERE user_role_id=:id')
                ->execute(['n' => $name, 'w' => $ws, 'c' => $cpu, 'r' => $ram, 'h' => $hdd, 'id' => $id]);
        }
        $db->prepare('DELETE FROM user_permission WHERE user_per_role=:id')->execute(['id' => $id]);
        if ($perms) {
            $st = $db->prepare('INSERT INTO user_permission (user_per_role,user_per_name) VALUES (:id,:p)');
            foreach ($perms as $pn) $st->execute(['id' => $id, 'p' => $pn]);
        }
        out(['ok' => true, 'id' => $id]);
    }

    if ($action === 'role_delete') {
        $b = body();
        $id = (int) ($b['id'] ?? 0);
        if (!$id) fail(400, 'role id is required');
        $cnt = $db->prepare('SELECT COUNT(*) FROM users WHERE role=:r');
        $cnt->execute(['r' => (string) $id]);
        if ((int) $cnt->fetchColumn() > 0) fail(409, 'this role is assigned to users — reassign them first');
        $db->prepare('DELETE FROM user_permission WHERE user_per_role=:id')->execute(['id' => $id]);
        $db->prepare('DELETE FROM user_roles WHERE user_role_id=:id')->execute(['id' => $id]);
        out(['ok' => true]);
    }

    fail(400, 'unknown action');
} catch (Exception $e) {
    fail(500, 'database error: ' . $e->getMessage());
}
