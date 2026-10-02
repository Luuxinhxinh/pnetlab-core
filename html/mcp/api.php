<?php
/**
 * mcp/api.php — admin dashboard backend for the AI / MCP server view (P1).
 *
 * Cookie/session authenticated (the shared `token` cookie), admin-only, exactly
 * like status/api.php. Every privileged action is brokered (www-data has no sudo
 * since B7): the toggleable pnetlab-mcp.service is controlled through the
 * `mcp_service` verb, and the root-owned data/ai/config.json (token hashes +
 * bridge secret + future LLM key) is read/written only through the broker, never
 * touched by www-data directly.
 *
 *   GET  ?action=status     -> {data:{active,active_state,enabled,bind,port,configured}}
 *   GET  ?action=health     -> {data:{active,listening,bind,port}}
 *   GET  ?action=settings   -> {data:<redacted config>}      (no secrets ever returned)
 *   GET  ?action=usage      -> {data:{today,per_user_daily_cap,by_day,ledger}}
 *   POST ?action=service    {state:bool}      enable+start / stop+disable
 *   POST ?action=settings   {bind,port,provider,base_url,model,api_key?,clear_api_key?,per_user_daily_tokens?}
 *   POST ?action=token_new  {name,pod?}       -> {token:<plaintext, shown once>}
 *   POST ?action=token_del  {name}
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

function out($x) { echo json_encode($x); exit; }
function fail($code, $m) { http_response_code($code); echo json_encode(['error' => $m]); exit; }
function jline($resp) {
    // last output line of a broker reply, decoded as JSON (our verbs emit one JSON line)
    if (!$resp['ok'] || empty($resp['out'])) return null;
    $d = json_decode(end($resp['out']), true);
    return is_array($d) ? $d : null;
}

/* ---- AUTH — engine cookie/session check, admin only ------------------------- */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) fail(401, 'not authenticated');
$role    = isset($user['role']) ? $user['role'] : '';
$isAdmin = ($role === 0 || $role === '0' || strtolower((string) $role) === 'admin');
if (!$isAdmin) fail(403, 'admin only');

$action = isset($_GET['action']) ? $_GET['action'] : '';
$method = $_SERVER['REQUEST_METHOD'];

/* ---- GET status: service + config summary ----------------------------------- */
if ($action === 'status' && $method === 'GET') {
    $resp = broker_call('mcp_service', ['op' => 'status'], 20);
    $d = jline($resp);
    if ($d === null) fail(500, 'could not read service status');
    out(['data' => $d]);
}

/* ---- GET health: listener + provider reachability --------------------------- */
if ($action === 'health' && $method === 'GET') {
    $resp = broker_call('mcp_health', [], 15);
    $d = jline($resp);
    if ($d === null) fail(500, 'health probe failed');
    out(['data' => $d]);
}

/* ---- GET settings: redacted config (tokens by name, no secrets) -------------- */
if ($action === 'settings' && $method === 'GET') {
    $resp = broker_call('ai_settings_read', [], 15);
    $d = jline($resp);
    if ($d === null) fail(500, 'could not read settings');
    out(['data' => $d]);
}

/* ---- GET usage: AI token ledger + per-user cap (dashboard summary) ----------- */
if ($action === 'usage' && $method === 'GET') {
    $resp = broker_call('ai_usage_read', [], 15);
    $d = jline($resp);
    if ($d === null) fail(500, 'could not read usage');
    out(['data' => $d]);
}

/* ---- POST service: one switch — enable+start or stop+disable ----------------- */
if ($action === 'service' && $method === 'POST') {
    $b = json_decode(file_get_contents('php://input'), true);
    $state = is_array($b) && !empty($b['state']);
    // persist the intent, then drive systemctl (order: on = enable→start;
    // off = stop→disable so the listener is gone before we forget it).
    broker_call('ai_settings_write', ['enabled' => $state ? 1 : 0], 15);
    if ($state) {
        $r1 = broker_call('mcp_service', ['op' => 'enable'], 30);
        $r2 = broker_call('mcp_service', ['op' => 'start'], 60);
    } else {
        $r1 = broker_call('mcp_service', ['op' => 'stop'], 60);
        $r2 = broker_call('mcp_service', ['op' => 'disable'], 30);
    }
    if (!$r1['ok'] || !$r2['ok']) {
        $err = $r2['err'] !== '' ? $r2['err'] : $r1['err'];
        fail(500, $err !== '' ? $err : 'could not change service state');
    }
    $st = jline(broker_call('mcp_service', ['op' => 'status'], 20));
    out(['ok' => true, 'data' => $st]);
}

/* ---- POST settings: write bind/port/provider (merge) ------------------------ */
if ($action === 'settings' && $method === 'POST') {
    $b = json_decode(file_get_contents('php://input'), true);
    if (!is_array($b)) fail(400, 'bad body');
    $args = [];
    foreach (['bind', 'port', 'provider', 'base_url', 'model', 'api_key'] as $k) {
        if (array_key_exists($k, $b)) $args[$k] = $b[$k];
    }
    if (array_key_exists('per_user_daily_tokens', $b)) {
        $args['per_user_daily_tokens'] = (int) $b['per_user_daily_tokens'];
    }
    if (!empty($b['clear_api_key'])) $args['clear_api_key'] = 1;
    if (array_key_exists('ai_allowed_roles', $b)) {
        $args['ai_allowed_roles'] = is_array($b['ai_allowed_roles']) ? array_values($b['ai_allowed_roles']) : [];
    }
    if (empty($args)) fail(400, 'nothing to set');
    $resp = broker_call('ai_settings_write', $args, 15);
    if (!$resp['ok']) fail(400, $resp['err'] !== '' ? $resp['err'] : 'settings rejected');
    out(['ok' => true, 'data' => jline($resp)]);
}

/* ---- POST token_new: generate an external access token (shown once) --------- */
if ($action === 'token_new' && $method === 'POST') {
    $b = json_decode(file_get_contents('php://input'), true);
    $name = (is_array($b) && isset($b['name'])) ? trim((string) $b['name']) : '';
    if ($name === '') fail(400, 'token name required');
    // Bind the token to a pod (== a PNetLab user id, the users PK). Default to the
    // minting admin's OWN pod, NOT 0: pod 0 is not a real user, so a token minted
    // without an explicit pod would resolve to "unknown pod" at the bridge and be
    // dead on arrival. An admin may still delegate by passing an explicit pod.
    $args = ['name' => $name];
    if (is_array($b) && isset($b['pod']) && $b['pod'] !== '') {
        $args['pod'] = (int) $b['pod'];
    } elseif (isset($user['pod'])) {
        $args['pod'] = (int) $user['pod'];
    }
    $resp = broker_call('mcp_token_new', $args, 15);
    if (!$resp['ok']) fail(400, $resp['err'] !== '' ? $resp['err'] : 'could not create token');
    out(['ok' => true, 'data' => jline($resp)]);   // {name,pod,token}
}

/* ---- POST token_del --------------------------------------------------------- */
if ($action === 'token_del' && $method === 'POST') {
    $b = json_decode(file_get_contents('php://input'), true);
    $name = (is_array($b) && isset($b['name'])) ? trim((string) $b['name']) : '';
    if ($name === '') fail(400, 'token name required');
    $resp = broker_call('mcp_token_del', ['name' => $name], 15);
    if (!$resp['ok']) fail(400, $resp['err'] !== '' ? $resp['err'] : 'could not delete token');
    out(['ok' => true]);
}

fail(400, 'unknown action');
