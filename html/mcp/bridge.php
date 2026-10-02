<?php
/**
 * mcp/bridge.php — localhost engine bridge for the PNetLab MCP server (P1 read +
 * P2 write).
 *
 * The MCP protocol server (scripts/mcp/pnetlab-mcp.py, runs as root) terminates
 * the external bearer-token auth and maps each authenticated client to a PNetLab
 * pod/tenant. It then proxies the tool calls here, over the loopback, so all
 * lab parsing/validation/mutation runs in the real engine (Lab class, locks,
 * getTemplates, the node config export) — never reimplemented in Python.
 *
 * This file does NOT use the engine cookie session: it is reached only from the
 * MCP service, which it authenticates two ways —
 *   1. REMOTE_ADDR must be loopback (Apache only listens locally for /mcp here),
 *   2. the X-MCP-Bridge header must equal data/ai/bridge.secret (0640 root:www-data,
 *      written by the broker; the MCP service holds the same secret).
 * The pod/tenant is supplied by the (trusted) MCP service; everything is then
 * scoped to that tenant.
 *
 *   POST {action, pod, lab_path?, ...}        Content-Type: application/json
 *
 * Read actions (P1):
 *     list_templates              -> {data:{templates:[{slug,desc,type,config_capable}]}}
 *     get_lab / open_lab          -> {data:{id,name,description,body,nodes,networks}}
 *     list_nodes                  -> {data:{nodes:{...}}}
 *     get_running_config          -> {data:{configs:{node_id:text}}}
 *
 * Write actions (P2 — mutate the open lab, each under a lockFile() on the .unl):
 *     create_lab                  {name, path?}  -> {data:{lab_path,id,name}}
 *     save_lab                    -> {data:{saved:true}}
 *     set_lab_documentation       {objectives, tasks[]}
 *     add_node                    {template,name,left,top,ram?,cpu?,ethernet?}
 *     edit_node                   {id, params:{...}}
 *     set_node_position           {id,left,top}
 *     delete_node                 {id, confirm:true}
 *     add_network                 {type,name,left?,top?}
 *     connect_nodes               {a_id,a_if,b_id,b_if}   (p2p bridge + both ends)
 *     connect_node_to_network     {node_id,if,net_id}
 *     disconnect                  {node_id,if}
 *     set_startup_config          {node_id, config_text}  (config_capable only)
 *
 *     batch  {pod, lab_path, ops:[{op,...params}, ...]}
 *         Runs many of the above write ops against ONE lab under a SINGLE
 *         lockFile()/unlockFile() pair (this request already paid for the
 *         init.php bootstrap once — batch amortizes it across every op instead
 *         of one HTTP round-trip per op). Allowed op names: add_node,
 *         add_network, connect_nodes, connect_node_to_network, disconnect,
 *         edit_node, set_node_position, delete_node, set_startup_config,
 *         set_lab_documentation, add_text — same action name + params as the
 *         single-action form above, just nested under "op" instead of
 *         top-level "action". lab_path is taken ONLY from the top-level batch
 *         request (each op mutates that one open lab). Ops run in order; the
 *         first op that throws stops the batch (partial results are still
 *         returned). The lab is saved once at the end if anything mutated it.
 *         Capped at 200 ops/request.
 *         -> {data:{results:[<per-op result, or {error} for the failed one>],
 *                   failed_at:<0-based index or null>, error:<message or null>}}
 *
 * Inventory / read (P6 — file-level, no running session needed):
 *     list_networks_types         -> {data:{types:[...]}}        (global)
 *     host_capacity               -> {data:{cpu,ram,...,caps}}   (pod-scoped)
 *     list_links                  -> {data:{links:[...]}}
 *     list_configurable_nodes     -> {data:{nodes:[...]}}
 *     get_node_interfaces         {id} -> {data:{interfaces:[...]}}
 *
 * Run / observe / fault-inject (P6 — operate on the pod's OPEN lab session, so a
 * node is actually running; lab_path is ignored for these):
 *     start_node                  {id, confirm:true}
 *     stop_node                   {id}
 *     wipe_node                   {id, confirm:true}
 *     export_running_config       {node_id}   (live scrape via the broker)
 *     set_link_impairment         {node_id, iface, delay?,jitter?,loss?,rate?, ...netem}
 *     link_up / link_down         {node_id, iface}
 *
 * lab_path is relative to BASE_LAB (e.g. "/Folder/My Lab.unl"). For external MCP
 * clients there is no interactive web session, so write actions require an
 * explicit lab_path (the MCP server supplies the lab the client open_lab'd).
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';
// init.php does not pull the API layer in (api.php requires these explicitly) —
// the tools reuse apiGetLabNodes/apiGetLabNetworks/apiGetLabNodeTemplate, so
// load them here too.
require_once BASE_DIR . '/html/includes/api_nodes.php';
require_once BASE_DIR . '/html/includes/api_networks.php';
// P6 node lifecycle (apiStartLabNode/...) calls node_wrapper_exec(), which lives
// in cluster.php — pull it in if init.php hasn't already.
if (!function_exists('node_wrapper_exec')) {
    require_once BASE_DIR . '/html/includes/cluster.php';
}

header('Content-Type: application/json');
header('Cache-Control: no-store');

function bout($x, $code = 200) { http_response_code($code); echo json_encode($x); exit; }
function bfail($code, $m) { http_response_code($code); echo json_encode(['error' => $m]); exit; }

/* ---- helpers ---------------------------------------------------------------- */

// Engine methods return 0 on success; addNetwork/addNode/edit return 5-digit
// error codes on failure, connectNode/disconnect return 1 when a link changed.
function rcOk($rc) { return $rc === 0 || $rc === 1 || $rc === true; }

// Map an engine return code to its human message, with a fallback.
function rcMsg($rc, $fallback = '') {
    if (is_int($rc) && isset($GLOBALS['messages'][$rc])) return $GLOBALS['messages'][$rc];
    return $fallback !== '' ? $fallback : ('engine rc=' . var_export($rc, true));
}

// True when a template carries a config_script handler (the vios/viosl2/xrd/
// nxosv9k/cat*/csr family) and therefore supports day-0 config import/export.
function bridgeTemplateConfigCapable($slug) {
    // Request-scoped memo: the template YAML cannot change mid-request, and a
    // batch (or list_configurable_nodes) commonly asks this for the same
    // template many times over — avoid re-stat+re-parsing the YAML each time.
    static $cache = [];
    if (array_key_exists($slug, $cache)) return $cache[$slug];
    $yml = BASE_DIR . '/html/' . TPL_DIR . '/' . $slug . '.yml';
    if (!is_file($yml)) return $cache[$slug] = false;
    $p = @yaml_parse_file($yml);
    return $cache[$slug] = (is_array($p) && isset($p['config_script']) && $p['config_script'] !== '');
}

// Flatten apiGetLabNodeTemplate()'s param map (each entry is {value, options?})
// down to a plain key=>value array of the Add-Node defaults (resolved image,
// ram, cpu, ethernet, console, qemu_*, icon, type, ...). Throws if unknown.
function bridgeTemplateDefaults($template) {
    // Request-scoped memo: a batch building N nodes of the same template (the
    // common case) would otherwise reload+reparse that template's YAML N times
    // via apiGetLabNodeTemplate(). Only successful lookups are cached — a throw
    // (unknown template) is never memoized, so a later retry still re-checks.
    static $cache = [];
    if (array_key_exists($template, $cache)) return $cache[$template];
    $tpl = apiGetLabNodeTemplate($template);   // throws ResponseException if missing
    // apiGetLabNodeTemplate returns data.options = the param map (each {value,..}).
    $params = (isset($tpl['data']['options']) && is_array($tpl['data']['options']))
        ? $tpl['data']['options'] : [];
    $flat = [];
    foreach ($params as $k => $v) {
        if (is_array($v)) {
            if (array_key_exists('value', $v)) $flat[$k] = $v['value'];
        } else {
            $flat[$k] = $v;
        }
    }
    return $cache[$template] = $flat;
}

// Role of an IOL .bin image from its filename: an L2 image is an Ethernet SWITCH,
// an L3 image is a ROUTER (PNetLab/EVE convention; gate images are named
// "i86bi_Linux-L2-…" / "…-L3-…"). Anything without an l2/l3 marker defaults to
// router (most bare IOL images are L3). Lets the agent place a switch vs a router.
function bridgeIolImageRole($filename) {
    if (preg_match('/[-_ ]l2[-_ .]/i', (string) $filename)) return 'switch';
    if (preg_match('/[-_ ]l3[-_ .]/i', (string) $filename)) return 'router';
    return 'router';
}

// True for the IOL template family (whose images carry an L2/L3 switch/router role).
function bridgeIsIolTemplate($slug, $type) {
    if ($type === 'iol') return true;
    return (bool) preg_match('/^(iol|i86bi_linux)/i', (string) $slug);
}

/* ---- loopback + bridge-secret auth (NOT the engine cookie) ------------------ */
$remote = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
if ($remote !== '127.0.0.1' && $remote !== '::1' && $remote !== '::ffff:127.0.0.1') {
    bfail(403, 'loopback only');
}
$secretFile = '/opt/unetlab/data/ai/bridge.secret';
$wantSecret = is_file($secretFile) ? trim((string) file_get_contents($secretFile)) : '';
$gotSecret  = isset($_SERVER['HTTP_X_MCP_BRIDGE']) ? trim((string) $_SERVER['HTTP_X_MCP_BRIDGE']) : '';
if ($wantSecret === '' || $gotSecret === '' || !hash_equals($wantSecret, $gotSecret)) {
    bfail(401, 'bad bridge secret');
}

/* ---- request ---------------------------------------------------------------- */
$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) $body = [];
$action = isset($body['action']) ? (string) $body['action'] : '';
$pod    = isset($body['pod']) ? (int) $body['pod'] : 0;

/* ---- list_templates: installed node types + config_script capability -------- */
if ($action === 'list_templates') {
    $list = [];
    $templates = getTemplates();                 // slug => description (installed only)
    foreach ($templates as $slug => $desc) {
        $yml = BASE_DIR . '/html/' . TPL_DIR . '/' . $slug . '.yml';
        $type = '';
        $configCapable = false;
        if (is_file($yml)) {
            $p = @yaml_parse_file($yml);
            if (is_array($p)) {
                $type = isset($p['type']) ? (string) $p['type'] : '';
                $configCapable = isset($p['config_script']) && $p['config_script'] !== '';
            }
        }
        // Whether this template can actually be placed: vpcs needs no image,
        // everything else needs at least one installed image. Lets the builder
        // pick only buildable node types.
        $imageAvailable = ($type === 'vpcs');
        $roles = [];
        if (!$imageAvailable && $type !== '') {
            $imgs = @listNodeImages($type, $slug);
            $imageAvailable = is_array($imgs) && count($imgs) > 0;
            // For IOL, tell the builder which device roles are installed (an L2
            // image is a switch, an L3 image is a router) so it can pick one.
            if ($imageAvailable && bridgeIsIolTemplate($slug, $type)) {
                foreach ($imgs as $img) {
                    $r = bridgeIolImageRole($img);
                    if (!in_array($r, $roles, true)) $roles[] = $r;
                }
            }
        }
        $entry = [
            'slug' => $slug,
            'desc' => (string) $desc,
            'type' => $type,
            'config_capable' => $configCapable,
            'image_available' => $imageAvailable,
        ];
        if (!empty($roles)) $entry['roles'] = $roles;
        $list[] = $entry;
    }
    bout(['data' => ['templates' => $list, 'count' => count($list)]]);
}

/* ---- list_node_images: installed images for a template (+ IOL switch/router role) */
if ($action === 'list_node_images') {
    $slug = isset($body['template']) ? (string) $body['template'] : '';
    if ($slug === '') bfail(400, 'list_node_images requires a template');
    try {
        $d = bridgeTemplateDefaults($slug);
    } catch (Throwable $e) {
        bfail(400, "unknown template '$slug'");
    }
    $type = isset($d['type']) ? (string) $d['type'] : '';
    $defaultImg = isset($d['image']) ? (string) $d['image'] : '';
    $imgs = ($type !== '') ? @listNodeImages($type, $slug) : [];
    $out = [];
    if (is_array($imgs)) {
        foreach ($imgs as $img) {
            $row = ['name' => (string) $img, 'default' => ((string) $img === $defaultImg)];
            // IOL images carry a device role (L2 = switch, L3 = router).
            if (bridgeIsIolTemplate($slug, $type)) $row['role'] = bridgeIolImageRole($img);
            $out[] = $row;
        }
    }
    bout(['data' => ['template' => $slug, 'type' => $type,
                     'images' => $out, 'count' => count($out)]]);
}

/* ---- list_networks_types: the net-types the builder may create (global) ------ */
if ($action === 'list_networks_types') {
    // Friendly aliases the add_network tool accepts, plus what each maps to.
    bout(['data' => ['types' => [
        ['name' => 'bridge',   'desc' => 'isolated L2 segment (a shared LAN / point-to-point)'],
        ['name' => 'cloud',    'desc' => 'management bridge to the host (pnet0)', 'alias_of' => 'pnet0'],
        ['name' => 'nat',      'desc' => 'NAT cloud to the host network', 'alias_of' => 'nat0'],
        ['name' => 'dot1q',    'desc' => '802.1Q VLAN-aware switch segment'],
        ['name' => 'wireless', 'desc' => 'Wi-Fi cell (vwifi) for wireless nodes'],
    ]]]);
}

/* ---- everything below is pod-scoped ----------------------------------------- */
$indent = new \indentify();
$puser  = $indent->getUser($pod);
if (empty($puser)) bfail(400, 'unknown pod');
$tenant = (int) $pod;

/* ---- host_capacity: free CPU/RAM + this user's per-user caps ----------------- */
if ($action === 'host_capacity') {
    // RAM from /proc/meminfo (kB) -> MB; CPU from nproc.
    $memTotalMb = 0; $memAvailMb = 0;
    $mi = @file('/proc/meminfo', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (is_array($mi)) {
        foreach ($mi as $line) {
            if (preg_match('/^MemTotal:\s+(\d+)/', $line, $m))      $memTotalMb = (int) round($m[1] / 1024);
            elseif (preg_match('/^MemAvailable:\s+(\d+)/', $line, $m)) $memAvailMb = (int) round($m[1] / 1024);
        }
    }
    $cpuCount = 0;
    $nproc = @shell_exec('nproc 2>/dev/null');
    if ($nproc !== null) $cpuCount = (int) trim($nproc);
    if ($cpuCount <= 0) $cpuCount = (int) @substr_count((string) @file_get_contents('/proc/cpuinfo'), 'processor');

    // Per-user caps the engine enforces at node start (NULL/0 = unlimited).
    $maxCpu = (isset($puser['user_max_cpu']) && $puser['user_max_cpu'] !== null && $puser['user_max_cpu'] !== '')
        ? (int) $puser['user_max_cpu'] : 0;
    $maxRam = (isset($puser['user_max_ram']) && $puser['user_max_ram'] !== null && $puser['user_max_ram'] !== '')
        ? (int) $puser['user_max_ram'] : 0;

    bout(['data' => [
        'cpu_count'   => $cpuCount,
        'ram_total_mb' => $memTotalMb,
        'ram_free_mb'  => $memAvailMb,
        'caps' => [
            'max_cpu' => $maxCpu,   // 0 = unlimited
            'max_ram_mb' => $maxRam, // 0 = unlimited
            'note' => 'the engine refuses a node start that would exceed these per-user caps',
        ],
    ]]);
}

/* ---- create_lab: make a new empty .unl and return its path ------------------ */
if ($action === 'create_lab') {
    $name = isset($body['name']) ? trim((string) $body['name']) : '';
    if ($name === '') bfail(400, 'create_lab requires a name');
    // accept a bare name; strip any directory/extension a caller may include
    $name = basename($name);
    if (substr($name, -4) === '.unl') $name = substr($name, 0, -4);
    if (!checkLabFilename($name . '.unl')) bfail(400, 'invalid lab name');

    // folder relative to BASE_LAB; default the pod's own folder, else root
    $folder = isset($body['path']) ? (string) $body['path'] : '';
    if ($folder === '') {
        $folder = (isset($puser['folder']) && $puser['folder'] !== '') ? (string) $puser['folder'] : '/';
    }
    if ($folder === '' || $folder[0] !== '/') $folder = '/' . $folder;
    if (substr($folder, -1) !== '/') $folder .= '/';

    $dir = BASE_LAB . $folder;
    // F8: validate the resolved directory is under BASE_LAB BEFORE creating any
    // directories.  A traversal like "../../../../tmp/x" would otherwise cause
    // @mkdir(..., true) to create directories outside BASE_LAB before the check
    // fails.  We resolve the nearest existing ancestor first so realpath() doesn't
    // return false for a not-yet-existing path.
    $baseReal = realpath(BASE_LAB);
    $probeDir = $dir;
    while ($probeDir !== '' && $probeDir !== '/' && $probeDir !== '\\' && !file_exists($probeDir)) {
        $probeDir = dirname($probeDir);
    }
    $probeReal = ($probeDir !== '' && file_exists($probeDir)) ? realpath($probeDir) : false;
    if ($baseReal === false || $probeReal === false ||
        ($probeReal !== $baseReal && strpos($probeReal, $baseReal . DIRECTORY_SEPARATOR) !== 0)) {
        bfail(400, 'invalid path');
    }
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    $dirReal  = realpath($dir);
    if ($dirReal === false ||
        ($dirReal !== $baseReal && strpos($dirReal, $baseReal . DIRECTORY_SEPARATOR) !== 0)) {
        bfail(400, 'invalid path');
    }

    $labPathRel = $folder . $name . '.unl';
    $full = BASE_LAB . $labPathRel;
    if (is_file($full)) bfail(409, 'a lab with that name already exists');

    // Seed a minimal valid empty <lab> with our chosen attributes so the Lab
    // constructor parses a real (empty) file instead of taking its
    // missing-file fallback (the store-era Sample_LAB.unl clone is retired).
    $uuid = genUuid();
    $seed = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          . '<lab name="' . htmlspecialchars($name, ENT_QUOTES) . '" id="' . $uuid
          . '" version="1" scripttimeout="300" countdown="0" lock="0"></lab>';
    if (@file_put_contents($full, $seed) === false) bfail(500, 'could not write lab file');
    @chmod($full, 0644);

    try {
        $lab = new Lab($full, $tenant);
        // stamp author so the lab carries provenance and triggers a clean save
        $lab->edit(['author' => 'AI Lab Builder']);
    } catch (Exception $e) {
        bfail(400, 'could not initialize lab: ' . $e->getMessage());
    }
    bout(['data' => ['lab_path' => $labPathRel, 'id' => $lab->getId(), 'name' => $lab->getName()]]);
}

/* ---- running/fault actions act on the pod's OPEN lab session ----------------- *
 * start/stop/wipe a node, scrape a live config, or impair/toggle a running link
 * all need the node + interface *sessions* (running paths, vunl tap names), which
 * only exist when the lab is opened with its session. So these ignore lab_path and
 * bind to whatever lab this pod currently has open in the lab view. */
$runningActions = ['start_node', 'stop_node', 'wipe_node', 'export_running_config',
    'set_link_impairment', 'link_up', 'link_down', 'apply_config_console'];
$needSession = in_array($action, $runningActions, true);

/* ---- open the target lab (explicit lab_path, or the pod's open session) ------ */
$labFile = '';
try {
    $labPath = $needSession ? '' : (isset($body['lab_path']) ? (string) $body['lab_path'] : '');
    if ($labPath !== '') {
        // explicit lab file, validated to live under BASE_LAB and end in .unl
        $full = BASE_LAB . $labPath;
        $real = realpath($full);
        $baseReal = realpath(BASE_LAB);
        if ($real === false || $baseReal === false ||
            strpos($real, $baseReal . DIRECTORY_SEPARATOR) !== 0 ||
            substr($real, -4) !== '.unl') {
            bfail(400, 'invalid lab_path');
        }

        // F1: Authorization gate — a non-admin pod may only open labs that live
        // under its own home folder.  indentify::getUser() returns the raw users
        // row; role==0 is admin (mirrors isAdmin() in functions.php).
        // The in-app agent flow (api.php object=ai) already has checkLabPermission
        // and checkLockLab before it reaches here, so the pod's own lab always
        // passes.  External bearer tokens must satisfy the same folder constraint.
        // checkLabPermission() calls getUser() which relies on $GLOBALS['user']
        // (set by the cookie session) — that global is not available in the bridge,
        // so we fall back to a conservative realpath prefix check instead.
        $isAdminPod = (isset($puser['role']) && (int) $puser['role'] === 0);
        if (!$isAdminPod) {
            $podFolder = isset($puser['folder']) ? rtrim((string) $puser['folder'], '/') : '';
            // A folder of '' or '/' means the pod's root is BASE_LAB itself — that
            // would give universal access, which is wrong for a non-admin.  Require
            // a non-empty sub-folder; admins (role==0) are exempt above.
            if ($podFolder === '' || $podFolder === '/') {
                bfail(403, 'pod has no home folder — cannot verify lab ownership');
            }
            $ownerFolder = realpath(BASE_LAB . $podFolder);
            if ($ownerFolder === false ||
                strpos($real, $ownerFolder . DIRECTORY_SEPARATOR) !== 0) {
                bfail(403, 'lab not in this tenant\'s folder');
            }
        }

        $labFile = $full;
        $lab = new Lab($full, $tenant);
        $session = null;
    } else {
        // fall back to the pod's currently-open lab session. getUser() returns the
        // raw users row, where the open session is the `lab_session` column (older
        // code referenced `lab`, which is not a column — keep it as a fallback).
        $session = isset($puser['lab_session']) ? $puser['lab_session']
            : (isset($puser['lab']) ? $puser['lab'] : '');
        if ($session === '' || $session === null) {
            bfail(400, $needSession
                ? 'this action needs a running lab — open the lab in the lab view first'
                : 'no lab_path and no open lab session for this pod');
        }
        $labsession = getLabFromSession($session);
        if (!$labsession) bfail(400, 'no open lab session');
        $labFile = BASE_LAB . $labsession['lab_session_path'];
        $lab = new Lab($labFile, $tenant, $session);
    }
} catch (Exception $e) {
    bfail(400, 'could not open lab: ' . $e->getMessage());
}

/* ---- read actions ----------------------------------------------------------- */
if ($action === 'get_lab' || $action === 'open_lab') {
    $nodes = apiGetLabNodes($lab, true);
    $nets  = apiGetLabNetworks($lab);
    bout(['data' => [
        'id'          => $lab->getId(),
        'name'        => $lab->getName(),
        'description' => $lab->getDescription(),
        'body'        => $lab->getBody(),
        'nodes'       => isset($nodes['data']) ? $nodes['data'] : new stdClass(),
        'networks'    => isset($nets['data']) ? $nets['data'] : new stdClass(),
    ]]);
}

if ($action === 'list_nodes') {
    $nodes = apiGetLabNodes($lab, true);
    bout(['data' => ['nodes' => isset($nodes['data']) ? $nodes['data'] : new stdClass()]]);
}

if ($action === 'get_running_config') {
    // Returns each node's SAVED startup-config (the engine's stored/exported
    // configuration). Live device-scrape is wired at the agent level later.
    $wantId = isset($body['node_id']) ? (string) (int) $body['node_id'] : '';
    $configs = [];
    foreach ($lab->getNodes() as $node_id => $node) {
        if ($wantId !== '' && (string) $node_id !== $wantId) continue;
        try {
            $configs[$node_id] = (string) $node->getConfigData();
        } catch (Exception $e) {
            $configs[$node_id] = '';
        }
    }
    bout(['data' => ['configs' => (object) $configs]]);
}

/* ---- list_links: every link, derived from interfaces <-> networks ----------- */
if ($action === 'list_links') {
    $nets = $lab->getNetworks();
    // group node interfaces by the network they attach to
    $byNet = [];
    foreach ($lab->getNodes() as $nid => $node) {
        foreach ($node->getInterfaces() as $iid => $if) {
            $net = (int) $if->getNetworkId();
            if ($net <= 0) continue;
            $byNet[$net][] = ['node_id' => (int) $nid, 'node' => $node->getName(),
                              'if' => (int) $iid, 'if_name' => $if->getName()];
        }
    }
    $links = [];
    foreach ($byNet as $net => $ends) {
        $type = isset($nets[$net]) ? $nets[$net]->getNType() : '';
        $name = isset($nets[$net]) ? $nets[$net]->getName() : '';
        // a 2-endpoint bridge is a point-to-point link; anything else is a segment
        $links[] = [
            'net_id'    => (int) $net,
            'net_name'  => $name,
            'net_type'  => $type,
            'point_to_point' => (count($ends) === 2 && $type === 'bridge'),
            'endpoints' => $ends,
        ];
    }
    bout(['data' => ['links' => $links, 'count' => count($links)]]);
}

/* ---- list_configurable_nodes: nodes that accept a day-0 startup-config ------- */
if ($action === 'list_configurable_nodes') {
    $out = [];
    foreach ($lab->getNodes() as $nid => $node) {
        $slug = $node->getTemplate();
        if (bridgeTemplateConfigCapable($slug)) {
            $out[] = ['id' => (int) $nid, 'name' => $node->getName(),
                      'template' => $slug, 'type' => $node->getNType()];
        }
    }
    bout(['data' => ['nodes' => $out, 'count' => count($out)]]);
}

/* ---- get_node_interfaces: one node's interfaces (index, name, link) ---------- */
if ($action === 'get_node_interfaces') {
    $id = (int) (isset($body['id']) ? $body['id'] : (isset($body['node_id']) ? $body['node_id'] : 0));
    $nodes = $lab->getNodes();
    if (!isset($nodes[$id])) bfail(400, 'unknown node id ' . $id);
    $nets = $lab->getNetworks();
    $ifaces = [];
    foreach ($nodes[$id]->getInterfaces() as $iid => $if) {
        $net = (int) $if->getNetworkId();
        $ifaces[] = [
            'index'    => (int) $iid,
            'name'     => $if->getName(),
            'type'     => $if->getNType(),
            'net_id'   => $net ?: null,
            'net_name' => ($net && isset($nets[$net])) ? $nets[$net]->getName() : '',
            'connected' => ($net > 0),
        ];
    }
    bout(['data' => ['node_id' => $id, 'name' => $nodes[$id]->getName(),
                     'interfaces' => $ifaces, 'count' => count($ifaces)]]);
}

/* ---- running/fault actions: act on the (session-bound) running topology ------ */
if ($needSession) {
    if ($labFile === '') bfail(400, 'this action requires an open lab session');
    try {
        $res = bridgeHandleRunning($action, $lab, $body, $tenant, $labFile, $session);
    } catch (Exception $e) {
        bfail(400, $e->getMessage());
    }
    bout(['data' => $res]);
}

/* ---- write actions: lock the .unl around every mutation --------------------- */
$writeActions = ['save_lab', 'set_lab_documentation', 'add_node', 'edit_node',
    'set_node_position', 'delete_node', 'add_network', 'connect_nodes',
    'connect_node_to_network', 'disconnect', 'set_startup_config', 'add_text'];

if (in_array($action, $writeActions, true)) {
    if ($labFile === '') bfail(400, 'this action requires an open lab');
    lockFile($labFile);
    try {
        $res = bridgeHandleWrite($action, $lab, $body, $tenant);
    } catch (Exception $e) {
        unlockFile($labFile);
        bfail(400, $e->getMessage());
    }
    unlockFile($labFile);
    bout(['data' => $res]);
}

/* ---- batch: many write ops against ONE lab under ONE lock -------------------- *
 * Lets an LLM client build a whole topology (many add_node/connect_nodes/…) in a
 * single HTTP round-trip instead of one request per op — this request already
 * paid for the init.php bootstrap once, and we now take the .unl lock once too,
 * instead of once per op. Each op reuses bridgeHandleWrite() unchanged (it
 * already returns a result array / throws, rather than echoing+exiting via
 * bout()) — the single-action dispatch above and this batch loop are two thin
 * callers of the exact same function, so single-action behavior is untouched. */
// Resolve an existing-node-name reference (a_name/b_name/node_name) to an engine
// node id by exact-matching against the nodes already in this open $lab — this is
// what lets a later build_topology call wire links to nodes a PRIOR call created
// (the 200-op batch cap forces big topologies to split across calls). Nodes added
// earlier IN THIS SAME batch are also visible here (bridgeHandleWrite already
// mutated $lab), but those are never reached via *_name: build_topology only emits
// *_name for refs it could not resolve to a same-call handle itself. If two nodes
// share a name (PNetLab normally auto-uniquifies on add, so this is rare) the
// lowest node id wins. Throws a clear error if no node has that name.
function bridgeBatchResolveNodeName($lab, $name)
{
    $name = (string) $name;
    $matchId = null;
    foreach ($lab->getNodes() as $id => $node) {
        if ($node->getName() === $name && ($matchId === null || (int) $id < $matchId)) {
            $matchId = (int) $id;
        }
    }
    if ($matchId === null) {
        throw new Exception("batch: no existing node named '$name' in this lab");
    }
    return $matchId;
}

// Translate a batch op's symbolic *_handle references into the literal id keys
// bridgeHandleWrite expects, using ids created earlier in the same batch. An op
// with no *_handle keys (literal ids / a plain add_*) is returned unchanged.
// Throws if a handle was never registered (op ordering bug in the caller).
// Also resolves *_name references (a_name/b_name/node_name) against nodes that
// ALREADY EXIST in the open $lab — see bridgeBatchResolveNodeName() above.
// Literal a_id/b_id/node_id/net_id keys always pass straight through untouched.
function bridgeBatchResolveHandles($opName, $opSpec, $handles, $lab)
{
    $resolve = function ($h) use ($handles) {
        $h = (string) $h;
        if (!array_key_exists($h, $handles)) {
            throw new Exception("batch: unresolved handle '$h' "
                . "(references a node/network not created earlier in this batch)");
        }
        return $handles[$h];
    };
    if ($opName === 'connect_nodes') {
        if (isset($opSpec['a_handle'])) { $opSpec['a_id'] = $resolve($opSpec['a_handle']); unset($opSpec['a_handle']); }
        if (isset($opSpec['b_handle'])) { $opSpec['b_id'] = $resolve($opSpec['b_handle']); unset($opSpec['b_handle']); }
        if (isset($opSpec['a_name']))   { $opSpec['a_id'] = bridgeBatchResolveNodeName($lab, $opSpec['a_name']); unset($opSpec['a_name']); }
        if (isset($opSpec['b_name']))   { $opSpec['b_id'] = bridgeBatchResolveNodeName($lab, $opSpec['b_name']); unset($opSpec['b_name']); }
    } elseif ($opName === 'connect_node_to_network') {
        if (isset($opSpec['node_handle']))    { $opSpec['node_id'] = $resolve($opSpec['node_handle']);    unset($opSpec['node_handle']); }
        if (isset($opSpec['network_handle'])) { $opSpec['net_id']  = $resolve($opSpec['network_handle']); unset($opSpec['network_handle']); }
        if (isset($opSpec['node_name']))       { $opSpec['node_id'] = bridgeBatchResolveNodeName($lab, $opSpec['node_name']); unset($opSpec['node_name']); }
    }
    return $opSpec;
}

if ($action === 'batch') {
    if ($labFile === '') bfail(400, 'batch requires a lab_path (all ops target one lab)');

    $ops = isset($body['ops']) ? $body['ops'] : null;
    if (!is_array($ops)) bfail(400, 'batch requires an "ops" array');
    if (count($ops) > 200) bfail(400, 'batch supports at most 200 ops per request');

    // Exactly the op names the pnetlab-mcp.py batch contract advertises — a
    // deliberately narrower list than $writeActions (no save_lab/create_lab:
    // batch always saves once at the end itself, and create_lab needs no lock
    // on a file that does not exist yet, so it stays a single-action call).
    $batchOps = ['add_node', 'add_network', 'connect_nodes', 'connect_node_to_network',
        'disconnect', 'edit_node', 'set_node_position', 'delete_node',
        'set_startup_config', 'set_lab_documentation', 'add_text'];

    // Validate the whole ops list up front (shape + known op name) BEFORE
    // taking the lock or mutating anything — a malformed batch should fail
    // cleanly as a single 400, not after partially rewriting the topology.
    foreach ($ops as $i => $opSpec) {
        if (!is_array($opSpec) || !isset($opSpec['op'])) {
            bfail(400, "batch ops[$i] must be an object with an \"op\" key");
        }
        if (!in_array((string) $opSpec['op'], $batchOps, true)) {
            bfail(400, "batch ops[$i]: unknown op '" . (string) $opSpec['op'] . "'");
        }
    }

    lockFile($labFile);
    $results  = [];
    $failedAt = null;
    $errorMsg = null;
    $mutated  = false;
    // Symbolic-handle registry: a node/network's engine id isn't known until its
    // add_* op runs inside this batch, so build_topology emits ops with a "handle"
    // (e.g. "n0"/"net0") on add_node/add_network and references it as a_handle/
    // b_handle/node_handle/network_handle on the link ops. We resolve those to the
    // real ids created earlier in THIS batch, then hand the op the literal id keys
    // bridgeHandleWrite already expects (a_id/b_id/node_id/net_id). Literal ids
    // still pass straight through (a link to a pre-existing engine network/node).
    // A link may also target a node from an EARLIER build_topology call (no handle
    // for it exists in this batch): build_topology then emits a_name/b_name/
    // node_name (or a literal *_id when the caller already knew the engine id),
    // which bridgeBatchResolveHandles() resolves against the currently-open $lab.
    $handles = [];
    foreach ($ops as $i => $opSpec) {
        $opName = (string) $opSpec['op'];
        try {
            $opSpec = bridgeBatchResolveHandles($opName, $opSpec, $handles, $lab);
            $res = bridgeHandleWrite($opName, $lab, $opSpec, $tenant);
            $results[] = $res;
            $mutated = true;
            // Record this op's created id under its handle so later ops can ref it.
            if (isset($opSpec['handle']) && is_array($res) && isset($res['id'])) {
                $handles[(string) $opSpec['handle']] = (int) $res['id'];
            }
        } catch (Exception $e) {
            $results[]  = ['error' => $e->getMessage()];
            $failedAt   = $i;
            $errorMsg   = $e->getMessage();
            break;   // stop on the first hard error; keep partial results
        }
    }
    if ($mutated) {
        $rc = $lab->save();
        // Every op succeeded but the final save itself failed: no individual op
        // is "the failed one", so failed_at stays null — error alone reports it.
        if (!rcOk($rc) && $errorMsg === null) {
            $errorMsg = rcMsg($rc, 'lab save failed after batch');
        }
    }
    unlockFile($labFile);
    bout(['data' => ['results' => $results, 'failed_at' => $failedAt, 'error' => $errorMsg]]);
}

bfail(400, 'unknown action');

/* ============================================================================ */

/**
 * Lowest ethernet interface id on $node that is not attached to any network
 * (getNetworkId()==0), or -1 if every ethernet port is already wired. Used so
 * connect_nodes can auto-cable without the agent guessing interface indices.
 */
function bridgeFirstFreeEth($node)
{
    $free = -1;
    foreach ($node->getInterfaces() as $iid => $if) {
        if ($if->getNType() !== 'ethernet') continue;
        if ((int) $if->getNetworkId() !== 0) continue;
        if ($free < 0 || (int) $iid < $free) $free = (int) $iid;
    }
    return $free;
}

/**
 * Execute one mutating action against an already-opened, locked lab. Throws an
 * Exception (caught by the caller) on any failure; returns a small result array.
 */
function bridgeHandleWrite($action, $lab, $body, $tenant)
{
    switch ($action) {

    case 'save_lab':
        $rc = $lab->save();
        if (!rcOk($rc)) throw new Exception(rcMsg($rc, 'save failed'));
        return ['saved' => true];

    case 'set_lab_documentation':
        $obj   = isset($body['objectives']) ? (string) $body['objectives'] : '';
        $tasks = (isset($body['tasks']) && is_array($body['tasks'])) ? $body['tasks'] : [];
        // Stored as plain text — Lab::edit() escapes < > & on save, so HTML markup
        // would surface as literal tags; keep documentation as readable text.
        $bodyText = $obj;
        if (!empty($tasks)) {
            $bodyText .= ($bodyText !== '' ? "\n\n" : '') . "Tasks:\n";
            $i = 1;
            foreach ($tasks as $t) { $bodyText .= ($i++) . '. ' . (string) $t . "\n"; }
        }
        $rc = $lab->edit(['description' => $obj, 'body' => $bodyText]);
        // 20030 = "nothing changed" (e.g. empty docs) — not an error here.
        if (!rcOk($rc) && $rc !== 20030) throw new Exception(rcMsg($rc, 'set documentation failed'));
        return ['description_len' => strlen($obj), 'tasks' => count($tasks)];

    case 'add_text':
        // Place a TEXT ANNOTATION directly on the topology canvas (a PNetLab text
        // object), distinct from set_lab_documentation (the Lab-details info panel).
        $text = isset($body['text']) ? trim((string) $body['text']) : '';
        if ($text === '') throw new Exception('add_text requires text');
        if (strlen($text) > 8000) throw new Exception('text too long');
        $left = (int) (isset($body['left']) && $body['left'] !== '' ? $body['left'] : 60);
        $top  = (int) (isset($body['top'])  && $body['top']  !== '' ? $body['top']  : 60);
        $size = (int) (isset($body['font_size']) && (int) $body['font_size'] > 0 ? (int) $body['font_size'] : 14);
        // F2: Validate color against safe CSS patterns to prevent stored XSS.
        // The color is injected into a style="…color:<value>…" that is base64'd
        // and later innerHTML'd by the lab renderer — an unvalidated value can
        // break out of the style attribute and inject arbitrary HTML/JS.
        // Accept: #RGB, #RRGGBB, #RRGGBBAA (3–8 hex digits), or a short
        // alphabetic CSS colour name (e.g. "red", "darkblue").  Anything else
        // falls back to the default colour.
        $colorRaw = (isset($body['color']) && $body['color'] !== '') ? (string) $body['color'] : '';
        $color = ($colorRaw !== '' && preg_match('/^#[0-9A-Fa-f]{3,8}$|^[a-zA-Z]{1,20}$/', $colorRaw))
            ? $colorRaw : '#202124';
        $name = (isset($body['name']) && $body['name'] !== '') ? (string) $body['name'] : 'Notes';
        // Predict the id addTextObject() will assign (first free starting at 1) so
        // the embedded #customTextN matches the stored object id.
        $tid = 1; $existing = $lab->getTextObjects();
        if (is_array($existing)) { while (isset($existing[$tid])) $tid++; }
        // Escape the text and keep line breaks; build the #customTextN contract the
        // canvas renderer + data_to_textobjattr expect (outer div carries position,
        // inner <p> carries the text style).
        $safe = nl2br(htmlspecialchars($text, ENT_QUOTES, 'UTF-8'));
        $inner = '<p style="margin:0; font-size:' . $size . 'px; color:' . $color . ';">' . $safe . '</p>';
        $html = '<div id="customText' . $tid . '" class="customShape customText context-menu ck-content" '
              . 'data-path="' . $tid . '" name="' . htmlspecialchars($name, ENT_QUOTES, 'UTF-8') . '" '
              . 'style="position:absolute; display:inline-block; top:' . $top . 'px; left:' . $left . 'px; '
              . 'cursor:move; z-index:1000;">' . $inner . '</div>';
        // The lab renderer decodes a text object's data with atob() — so the data
        // MUST be base64-encoded HTML (matches the UI's createTextObject, which
        // does base64(utf8(html))). Storing raw HTML throws in atob() and aborts
        // the whole topology draw, so links stop rendering. base64 the UTF-8 HTML.
        $data = base64_encode($html);
        $rc = $lab->addTextObject(['data' => $data, 'type' => 'text', 'name' => $name]);
        if (!is_object($rc) || (int) $rc->status !== 0) {
            $st = is_object($rc) ? $rc->status : 'unknown';
            throw new Exception('addTextObject failed (rc=' . $st . ')');
        }
        return ['id' => (int) $rc->id, 'left' => $left, 'top' => $top, 'name' => $name];

    case 'add_node':
        $template = isset($body['template']) ? (string) $body['template'] : '';
        if ($template === '') throw new Exception('add_node requires a template');
        try {
            $d = bridgeTemplateDefaults($template);
        } catch (Throwable $e) {
            throw new Exception("could not load template '$template': " . $e->getMessage());
        }
        $type = isset($d['type']) ? (string) $d['type'] : '';
        if ($type === '') throw new Exception('unknown template: ' . $template);
        if ($type !== 'vpcs' && empty($d['image'])) {
            throw new Exception("no image installed for template '$template'");
        }
        $p = $d;
        $p['name'] = (isset($body['name']) && $body['name'] !== '')
            ? (string) $body['name'] : (isset($d['name']) && $d['name'] !== '' ? $d['name'] : $template);
        $p['left'] = (int) (isset($body['left']) ? $body['left'] : 0);
        $p['top']  = (int) (isset($body['top'])  ? $body['top']  : 0);
        foreach (['ram', 'cpu', 'ethernet'] as $opt) {
            if (isset($body[$opt]) && $body[$opt] !== '') $p[$opt] = (int) $body[$opt];
        }
        if (!isset($p['config']) || $p['config'] === '') $p['config'] = '0';

        // Optional image selection: an explicit `image` (validated against the
        // installed images) wins; otherwise a `role` (switch|router) picks the
        // first installed image of that role — for IOL, an L2 image is a switch
        // and an L3 image is a router.
        $chosenRole = null;
        $installed = ($type !== '' && $type !== 'vpcs') ? @listNodeImages($type, $template) : [];
        $installed = is_array($installed) ? $installed : [];
        if (isset($body['image']) && $body['image'] !== '') {
            $img = (string) $body['image'];
            if (!isset($installed[$img]) && !in_array($img, $installed, true)) {
                throw new Exception("image '$img' is not installed for template '$template'");
            }
            $p['image'] = $img;
            if (bridgeIsIolTemplate($template, $type)) $chosenRole = bridgeIolImageRole($img);
        } elseif (isset($body['role']) && $body['role'] !== '') {
            $role = strtolower((string) $body['role']);
            if ($role !== 'switch' && $role !== 'router') {
                throw new Exception("role must be 'switch' or 'router'");
            }
            if (!bridgeIsIolTemplate($template, $type)) {
                throw new Exception("role is only meaningful for IOL templates (L2=switch, L3=router)");
            }
            $pick = '';
            foreach ($installed as $img) {
                if (bridgeIolImageRole($img) === $role) { $pick = (string) $img; break; }
            }
            if ($pick === '') {
                throw new Exception("no $role (IOL " . ($role === 'switch' ? 'L2' : 'L3')
                    . ") image installed for '$template'");
            }
            $p['image'] = $pick;
            $chosenRole = $role;
        }

        $id = $lab->getFreeNodeId();
        $rc = $lab->addNode($p);
        if (!rcOk($rc)) throw new Exception(rcMsg($rc, 'addNode failed'));
        $nodes = $lab->getNodes();
        $out = [
            'id'       => $id,
            'name'     => isset($nodes[$id]) ? $nodes[$id]->getName() : $p['name'],
            'template' => $template,
        ];
        if (isset($p['image'])) $out['image'] = $p['image'];
        if ($chosenRole !== null) $out['role'] = $chosenRole;
        return $out;

    case 'edit_node':
        $id = (int) (isset($body['id']) ? $body['id'] : 0);
        $editNodes = $lab->getNodes();
        if (!isset($editNodes[$id])) throw new Exception('unknown node id ' . $id);
        $rawParams = (isset($body['params']) && is_array($body['params'])) ? $body['params'] : [];
        // F5: Allow-list editable keys.  editNode() accepts every attribute the
        // engine knows about (image, uuid, config, cpulimit, etc.) — forwarding an
        // arbitrary caller-supplied map lets a token holder set arbitrary node
        // attributes, including swapping the image to one that was never installed.
        // Restrict to the safe subset the MCP tool surface intentionally exposes.
        $allowedEditKeys = ['name', 'left', 'top', 'ram', 'cpu', 'ethernet',
                            'console', 'delay', 'icon', 'image'];
        $params = [];
        foreach ($allowedEditKeys as $k) {
            if (array_key_exists($k, $rawParams)) $params[$k] = $rawParams[$k];
        }
        // Validate image against the installed image list, mirroring add_node.
        if (isset($params['image']) && $params['image'] !== '') {
            $nodeType  = $editNodes[$id]->getNType();
            $nodeTpl   = $editNodes[$id]->getTemplate();
            $installed = ($nodeType !== '' && $nodeType !== 'vpcs')
                ? @listNodeImages($nodeType, $nodeTpl) : [];
            $installed = is_array($installed) ? $installed : [];
            $img = (string) $params['image'];
            if (!isset($installed[$img]) && !in_array($img, $installed, true)) {
                throw new Exception("image '$img' is not installed for this node's template");
            }
        }
        // Force id; save is never forwarded (engine uses a separate save step).
        $params['id'] = $id;
        unset($params['save']);
        $rc = $lab->editNode($params);
        if (!rcOk($rc)) throw new Exception(rcMsg($rc, 'editNode failed'));
        return ['id' => $id];

    case 'set_node_position':
        $id = (int) (isset($body['id']) ? $body['id'] : 0);
        if (!isset($lab->getNodes()[$id])) throw new Exception('unknown node id ' . $id);
        $rc = $lab->editNode([
            'id'   => $id,
            'left' => (int) (isset($body['left']) ? $body['left'] : 0),
            'top'  => (int) (isset($body['top'])  ? $body['top']  : 0),
        ]);
        if (!rcOk($rc)) throw new Exception(rcMsg($rc, 'set position failed'));
        return ['id' => $id];

    case 'delete_node':
        if (empty($body['confirm'])) throw new Exception('delete_node requires confirm=true');
        $id = (int) (isset($body['id']) ? $body['id'] : 0);
        if (!isset($lab->getNodes()[$id])) throw new Exception('unknown node id ' . $id);
        if ($lab->getNodes()[$id]->isLocked()) throw new Exception('node is locked');
        $rc = $lab->deleteNode($id);
        if (!rcOk($rc)) throw new Exception(rcMsg($rc, 'deleteNode failed'));
        return ['deleted' => $id];

    case 'add_network':
        $type = isset($body['type']) ? (string) $body['type'] : 'bridge';
        // friendly aliases -> engine net-types
        if ($type === 'cloud') $type = 'pnet0';
        if ($type === 'nat')   $type = 'nat0';
        if (!preg_match('/^(bridge|nat\d|pnet\d|dot1q|wireless)$/', $type)) {
            throw new Exception("invalid network type '$type'");
        }
        $name = (isset($body['name']) && $body['name'] !== '') ? (string) $body['name'] : 'Net';
        $id = $lab->getFreeNetworkId();
        // A real (visible) network: default it to a mid-canvas spot so an
        // unplaced cloud doesn't stack at origin (callers usually pass left/top).
        $rc = $lab->addNetwork([
            'name'       => $name,
            'type'       => $type,
            'left'       => (int) (isset($body['left']) && $body['left'] !== '' ? $body['left'] : 600),
            'top'        => (int) (isset($body['top'])  && $body['top']  !== '' ? $body['top']  : 200),
            'visibility' => 1,
        ]);
        if (!rcOk($rc)) throw new Exception(rcMsg($rc, 'addNetwork failed'));
        return ['id' => $id, 'name' => $name, 'type' => $type];

    case 'connect_nodes':
        $aId = (int) (isset($body['a_id']) ? $body['a_id'] : 0);
        $bId = (int) (isset($body['b_id']) ? $body['b_id'] : 0);
        $nodes = $lab->getNodes();
        if (!isset($nodes[$aId]) || !isset($nodes[$bId])) throw new Exception('unknown node id');
        // a_if/b_if are optional: when omitted or < 0, auto-pick that node's first
        // free ethernet so the agent doesn't have to guess interface indices.
        $aIf = (isset($body['a_if']) && $body['a_if'] !== '' && (int) $body['a_if'] >= 0)
            ? (int) $body['a_if'] : bridgeFirstFreeEth($nodes[$aId]);
        $bIf = (isset($body['b_if']) && $body['b_if'] !== '' && (int) $body['b_if'] >= 0)
            ? (int) $body['b_if'] : bridgeFirstFreeEth($nodes[$bId]);
        if ($aIf < 0) throw new Exception("node $aId ('" . $nodes[$aId]->getName() . "') has no free ethernet interface");
        if ($bIf < 0) throw new Exception("node $bId ('" . $nodes[$bId]->getName() . "') has no free ethernet interface");
        // EVE model: a point-to-point link is a bridge network with both ends on it.
        $an = $nodes[$aId]->getName();
        $bn = $nodes[$bId]->getName();
        $netId = $lab->getFreeNetworkId();
        // visibility=0 => a HIDDEN p2p bridge: EVE/PNetLab draws it as a DIRECT line
        // between the two endpoints, not a cloud icon. left/top are irrelevant for a
        // hidden network. plain name only — '<'/'>' get re-escaped each save cycle.
        $rc = $lab->addNetwork([
            'name' => "$an-$bn", 'type' => 'bridge', 'left' => 0, 'top' => 0, 'visibility' => 0,
        ]);
        if (!rcOk($rc)) throw new Exception(rcMsg($rc, 'link network failed'));
        $rc = $lab->connectNode($aId, [$aIf => $netId]);
        if (!rcOk($rc)) throw new Exception('connect A: ' . rcMsg($rc, 'failed'));
        $rc = $lab->connectNode($bId, [$bIf => $netId]);
        if (!rcOk($rc)) throw new Exception('connect B: ' . rcMsg($rc, 'failed'));
        return ['net_id' => $netId,
                'a' => ['id' => $aId, 'if' => $aIf],
                'b' => ['id' => $bId, 'if' => $bIf]];

    case 'connect_node_to_network':
        $nid = (int) (isset($body['node_id']) ? $body['node_id'] : 0);
        $if  = (int) (isset($body['if'])      ? $body['if']      : 0);
        $net = (int) (isset($body['net_id'])  ? $body['net_id']  : 0);
        if (!isset($lab->getNodes()[$nid]))    throw new Exception('unknown node id ' . $nid);
        if (!isset($lab->getNetworks()[$net])) throw new Exception('unknown network id ' . $net);
        $rc = $lab->connectNode($nid, [$if => $net]);
        if (!rcOk($rc)) throw new Exception('connect: ' . rcMsg($rc, 'failed'));
        return ['node_id' => $nid, 'if' => $if, 'net_id' => $net];

    case 'disconnect':
        $nid = (int) (isset($body['node_id']) ? $body['node_id'] : 0);
        $if  = (int) (isset($body['if'])      ? $body['if']      : 0);
        if (!isset($lab->getNodes()[$nid])) throw new Exception('unknown node id ' . $nid);
        $rc = $lab->connectNode($nid, [$if => '']);   // '' unlinks the interface
        if (!rcOk($rc)) throw new Exception('disconnect: ' . rcMsg($rc, 'failed'));
        return ['node_id' => $nid, 'if' => $if];

    case 'set_startup_config':
        $nid = (int) (isset($body['node_id']) ? $body['node_id'] : 0);
        $nodes = $lab->getNodes();
        if (!isset($nodes[$nid])) throw new Exception('unknown node id ' . $nid);
        $slug = $nodes[$nid]->getTemplate();
        if (!bridgeTemplateConfigCapable($slug)) {
            throw new Exception("node template '$slug' is not config-capable "
                . '(no config_script handler); cannot import a day-0 config');
        }
        $cfg = isset($body['config_text']) ? (string) $body['config_text'] : '';
        $rc = $lab->setNodeConfigData($nid, $cfg);
        if (!rcOk($rc)) throw new Exception(rcMsg(is_int($rc) ? $rc : 0, 'setNodeConfigData failed'));
        // config=1 => the device handler exports this stored config to the running
        // startup-config at boot (the cidata/import path).
        $lab->editNode(['id' => $nid, 'config' => '1']);
        return ['node_id' => $nid, 'bytes' => strlen($cfg)];

    }
    throw new Exception('unknown write action');
}

/* ============================================================================ */

/**
 * Execute one running/fault action against the pod's OPEN lab session. Lifecycle
 * (start/stop/wipe) and the live export ride the engine API (broker-mediated as
 * root); impairment + link toggles reuse the Interfc methods (which already route
 * the netem / linkstate / qemu-monitor calls through the broker post-B7). Throws
 * on failure; returns a small result array.
 *
 * @param  string  $session  the pod's lab-session id (interfaces are bound to it)
 */
function bridgeHandleRunning($action, $lab, $body, $tenant, $labFile, $session)
{
    $nodeId = (int) (isset($body['id']) ? $body['id']
        : (isset($body['node_id']) ? $body['node_id'] : 0));
    $nodes = $lab->getNodes();

    switch ($action) {

    case 'start_node':
        if (empty($body['confirm'])) throw new Exception('start_node requires confirm=true (it consumes CPU/RAM)');
        if (!isset($nodes[$nodeId])) throw new Exception('unknown node id ' . $nodeId);
        // apiStartLabNode surfaces the engine's per-user CPU/RAM cap error (the
        // engine refuses a start that would exceed user_max_cpu / user_max_ram).
        $r = apiStartLabNode($lab, $nodeId, $tenant);
        if (($r['code'] ?? 400) != 200) throw new Exception($r['message'] ?? 'start failed');
        return ['id' => $nodeId, 'status' => 'started', 'message' => $r['message']];

    case 'stop_node':
        if (!isset($nodes[$nodeId])) throw new Exception('unknown node id ' . $nodeId);
        $r = apiStopLabNode($lab, $nodeId, $tenant);
        if (($r['code'] ?? 400) != 200) throw new Exception($r['message'] ?? 'stop failed');
        return ['id' => $nodeId, 'status' => 'stopped', 'message' => $r['message']];

    case 'wipe_node':
        if (empty($body['confirm'])) throw new Exception('wipe_node requires confirm=true (it erases the node NVRAM)');
        if (!isset($nodes[$nodeId])) throw new Exception('unknown node id ' . $nodeId);
        $r = apiWipeLabNode($lab, $nodeId, $tenant);
        if (($r['code'] ?? 400) != 200) throw new Exception($r['message'] ?? 'wipe failed');
        return ['id' => $nodeId, 'status' => 'wiped', 'message' => $r['message']];

    case 'export_running_config':
        if (!isset($nodes[$nodeId])) throw new Exception('unknown node id ' . $nodeId);
        if (!bridgeTemplateConfigCapable($nodes[$nodeId]->getTemplate())) {
            throw new Exception("node template '" . $nodes[$nodeId]->getTemplate()
                . "' is not config-capable; nothing to export");
        }
        // Live scrape: config_<x>.py -a get on the RUNNING node (broker, root).
        $r = apiExportLabNode($lab, $nodeId, $tenant);
        if (($r['code'] ?? 400) != 200) throw new Exception($r['message'] ?? 'export failed');
        // Re-open the lab so getConfigData() reflects the freshly-exported config.
        $fresh = new Lab($labFile, $tenant, $session);
        $fn = $fresh->getNodes();
        $cfg = isset($fn[$nodeId]) ? (string) $fn[$nodeId]->getConfigData() : '';
        return ['node_id' => $nodeId, 'bytes' => strlen($cfg), 'config' => $cfg];

    case 'apply_config_console':
        // Boot-and-paste: drive the RUNNING node's console like a human — abort
        // autoinstall / the setup dialog, log in, paste the day-0 config in conf-t,
        // `write memory`, then export the running-config back into the lab's stored
        // config. The reliable alternative to the unattended startup-config import
        // (which leaves IOS waiting out autoinstall for minutes).
        if (!isset($nodes[$nodeId])) throw new Exception('unknown node id ' . $nodeId);
        if (!bridgeTemplateConfigCapable($nodes[$nodeId]->getTemplate())) {
            throw new Exception("node template '" . $nodes[$nodeId]->getTemplate()
                . "' is not config-capable");
        }
        // config to paste: an explicit config_text, else the node's stored config
        // (what set_startup_config saved).
        $cfgText = isset($body['config_text']) && $body['config_text'] !== ''
            ? (string) $body['config_text']
            : (string) $nodes[$nodeId]->getConfigData();
        if (trim($cfgText) === '') {
            throw new Exception('no config to apply — set_startup_config first, or pass config_text');
        }
        $port = (int) $nodes[$nodeId]->getPort();
        if ($port < 1) throw new Exception('node has no console port — start the node first');
        $save = !(isset($body['save']) && ($body['save'] === false || $body['save'] === 0 || $body['save'] === '0'));
        require_once BASE_DIR . '/html/includes/broker.php';
        $resp = broker_call('node_config_push', [
            'host'   => '127.0.0.1',
            'port'   => $port,
            'save'   => $save ? 1 : 0,
            'config' => $cfgText,
        ], 600);
        if (empty($resp['ok'])) {
            throw new Exception(($resp['err'] ?? '') !== '' ? $resp['err'] : 'console config push failed');
        }
        $pushLine = isset($resp['out'][0]) ? (string) $resp['out'][0] : '{}';
        $push = json_decode($pushLine, true);
        if (!is_array($push) || empty($push['ok'])) {
            $emsg = (is_array($push) && !empty($push['errors'])) ? implode('; ', (array) $push['errors']) : 'push failed';
            throw new Exception('console push: ' . $emsg);
        }
        // Back up the now-live config into the lab's stored config (so clone/export
        // keep it) — only meaningful once it was written to NVRAM.
        $exported = false;
        if ($save) {
            $r = apiExportLabNode($lab, $nodeId, $tenant);
            $exported = (($r['code'] ?? 400) == 200);
        }
        return ['node_id' => $nodeId, 'pushed' => true, 'saved' => !empty($push['saved']),
                'exported' => $exported, 'prompt' => ($push['prompt'] ?? ''),
                'config_errors' => ($push['errors'] ?? [])];

    case 'set_link_impairment':
        $if = (int) (isset($body['iface']) ? $body['iface'] : (isset($body['if']) ? $body['if'] : 0));
        if (!isset($nodes[$nodeId])) throw new Exception('unknown node id ' . $nodeId);
        $interfaces = $nodes[$nodeId]->getInterfaces();
        if (!isset($interfaces[$if])) throw new Exception('unknown interface ' . $if . ' on node ' . $nodeId);
        // Map the tool's args to the keys Interfc::setQuality understands; only
        // pass-through keys present, so an omitted knob clears that impairment.
        // (rate is "bandwidth" in the if_session quality store.)
        $q = [];
        if (isset($body['rate']))      $q['bandwidth'] = $body['rate'];
        foreach (['delay', 'jitter', 'loss', 'dist', 'loss_mode', 'delay_corr',
                  'loss_corr', 'duplicate', 'dup_corr', 'corrupt', 'reorder',
                  'reorder_corr', 'gap', 'limit'] as $k) {
            if (isset($body[$k])) $q[$k] = $body[$k];
        }
        lockFile($labFile);
        try {
            $interfaces[$if]->setQuality($q);   // persists + applies netem via broker
            $lab->save();
        } catch (Exception $e) {
            unlockFile($labFile);
            throw $e;
        }
        unlockFile($labFile);
        return ['node_id' => $nodeId, 'iface' => $if, 'applied' => array_keys($q)];

    case 'link_up':
    case 'link_down':
        $if = (int) (isset($body['iface']) ? $body['iface'] : (isset($body['if']) ? $body['if'] : 0));
        if (!isset($nodes[$nodeId])) throw new Exception('unknown node id ' . $nodeId);
        $interfaces = $nodes[$nodeId]->getInterfaces();
        if (!isset($interfaces[$if])) throw new Exception('unknown interface ' . $if . ' on node ' . $nodeId);
        // setSuspendStatus(1) admin-downs/suspends the link, (0) brings it back up
        // — the same path the lab-view link toggle uses (api.php setSuspend).
        $down = ($action === 'link_down');
        lockFile($labFile);
        try {
            $interfaces[$if]->setSuspendStatus($down ? '1' : '0');
            $lab->save();
        } catch (Exception $e) {
            unlockFile($labFile);
            throw $e;
        }
        unlockFile($labFile);
        return ['node_id' => $nodeId, 'iface' => $if, 'state' => $down ? 'down' : 'up'];

    }
    throw new Exception('unknown running action');
}
