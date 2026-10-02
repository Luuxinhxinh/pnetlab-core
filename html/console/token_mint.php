<?php
/**
 * token_mint.php — session-gated console token minter (PNETLab-Jammy).
 *
 * The browser calls:  token_mint.php?node=<id>&type=telnet|vnc
 * and gets back a short-lived token. Both lanes share ONE tmpfs token store
 * (websockify TokenFile format, "<token>: 127.0.0.1:<port>"), read by two
 * consumers:
 *
 *   telnet -> telnet_ws_bridge_telnetlib3.py  (xterm.js)      [Slice 1]
 *   vnc    -> websockify TokenFile plugin      (noVNC)         [Slice 2]
 *   rdp    -> guacamole-lite (AES blob, no TokenFile)          [Slice 3]
 *
 * SECURITY: the only thing between a browser and a raw console port is the
 * auth + ownership check below. Raw console targets are never exposed directly —
 * the bridges bind 127.0.0.1 and are only reachable via Apache wss behind the
 * PNETLab session cookie. We reuse the engine's OWN auth + lab/tenant boundary
 * (indentify::authorization + the user's open lab session), not a placeholder.
 *
 * Slice 1+2 = telnet + vnc lanes (shared tmpfs TokenFile store). Slice 3 adds
 * the rdp lane: guacamole-lite is STATELESS, so instead of a TokenFile line we
 * mint a self-contained AES-256-CBC blob carrying the whole RDP connection,
 * decrypted server-side by guacamole-lite with the shared GUAC_CRYPT_KEY.
 */

// init.php loads the optional includes/config.php via a CWD-relative path, just
// like api.php which runs from /opt/unetlab/html. Match that so any local
// config overrides (DATABASE, MODE, ...) are honoured identically.
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

// Shared constants (TOKEN_DIR, TOKEN_TTL[, GUAC_CRYPT_KEY]). Kept OUTSIDE the
// web root so the secret is never web-served. Installed by install-jammy.sh.
$cfg = '/etc/pnet-webconsole/console_config.php';
if (is_readable($cfg)) {
    require_once $cfg;
} else {
    error_log("PNetLab web console: optional console config is missing or unreadable: $cfg");
}
if (!defined('TOKEN_DIR')) { define('TOKEN_DIR', '/dev/shm/pnet-tokens'); }
if (!defined('TOKEN_TTL')) { define('TOKEN_TTL', 60); }
// http web-console lane: a SEPARATE grant store read by http_ws_bridge.py, which
// reverse-proxies a node's own http/https web console for iframe embedding. The
// store is its own dir (own owner/janitor policy) and its file format differs
// from the websockify TokenFile: one line "<scheme> <host> <port>". http console
// sessions are long-lived (an open iframe), so the TTL is much longer than the
// 60s telnet/vnc token — the janitor reaps this store on a longer window.
if (!defined('HTTP_TOKEN_DIR')) { define('HTTP_TOKEN_DIR', '/dev/shm/pnet-http-tokens'); }
if (!defined('HTTP_TOKEN_TTL')) { define('HTTP_TOKEN_TTL', 43200); }   // 12h; long-lived iframe session

header('Content-Type: application/json');
header('Cache-Control: no-store');

function fail($code, $msg) {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

/* ---- 1. AUTH — reuse the engine's real cookie/session check ------------- */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    fail(401, 'not authenticated');
}

/* ---- 1b. Host shell lane (admin only) --------------------------------- */
// A node-less lane: shell_ws_bridge.py opens a PTY running login(1) on THIS host,
// so the OS authenticates the user (root/pnet etc). We only mint the gate token
// for an admin session; the token is a single-use sentinel the shell bridge alone
// honours (it can never be pointed at a node port). login(1) is the real check.
if (isset($_GET['type']) && $_GET['type'] === 'shell') {
    $role = isset($user['role']) ? $user['role'] : '';
    $isAdmin = ($role === 0 || $role === '0' || strtolower((string) $role) === 'admin');
    if (!$isAdmin) { fail(403, 'host shell is admin-only'); }
    $token = bin2hex(random_bytes(16));
    $line  = sprintf("%s: %s:%d\n", $token, '__pnetshell__', 0);   // sentinel target
    $path  = rtrim(TOKEN_DIR, '/') . '/' . $token;
    if (@file_put_contents($path, $line, LOCK_EX) === false) {
        fail(500, 'could not write token');
    }
    @chmod($path, 0640);
    echo json_encode(['token' => $token, 'expires_in' => TOKEN_TTL]);
    exit;
}

/* ---- 1d. HTTP web-console lane (authenticated reverse-proxy grant) ----- */
// A Docker node's OWN http/https web console, reverse-proxied for iframe
// embedding by http_ws_bridge.py (loopback). SSRF-safe contract: the client
// supplies ONLY a node id — scheme/host/port are resolved SERVER-SIDE from the
// node the caller owns, then written to a private grant store the bridge trusts.
// A client-supplied host/port/scheme is NEVER honoured, and a grant is never
// mintable for a non-http/https console (telnet/vnc/rdp stay on their own lanes).
// Ownership is the engine's own boundary via open_user_lab() + getNodes()[$id],
// identical to the telnet/vnc mint (apiPortcheckLabNode's cross-tenant check).
if (isset($_GET['type']) && $_GET['type'] === 'http') {
    $nodeId = isset($_GET['node'])   ? (string) $_GET['node'] : '';
    $second = isset($_GET['second']) && $_GET['second'] === '1';   // 2nd console/port
    if ($nodeId === '') { fail(400, 'bad params'); }

    // Packet-capture (html5 lane) sub-branch: the target is the pnet-capture-web
    // container the engine's capture action created (image swapped from the old VNC
    // pnet-wireshark), NOT the node's own web console. It serves a live-packet http
    // UI on ws_ip:80 (wiresharks row), reverse-proxied by http_ws_bridge.py exactly
    // like a node http console. Client sends ONLY node+iface (capture=1); scheme/
    // host/port are resolved SERVER-SIDE from the wiresharks row scoped to the
    // caller's OWN running lab (a foreign capture is simply not found), never from
    // the client. We write the same "<scheme> <host> <port>" grant the node http
    // lane writes below, so the bridge treats it identically.
    if (isset($_GET['capture']) && $_GET['capture'] === '1') {
        $iface = isset($_GET['iface']) ? (string) $_GET['iface'] : '';
        list($scheme, $chost, $cport) =
            resolve_capture_http_target($user, $tenant, $nodeId, $iface);
        $token = bin2hex(random_bytes(16));
        $line  = sprintf("%s %s %d\n", $scheme, $chost, $cport);
        $path  = rtrim(HTTP_TOKEN_DIR, '/') . '/' . $token;
        if (@file_put_contents($path, $line, LOCK_EX) === false) {
            fail(500, 'could not write token');
        }
        @chmod($path, 0640);
        echo json_encode(['token' => $token, 'expires_in' => HTTP_TOKEN_TTL]);
        exit;
    }

    // (3) Open ONLY the caller's own running lab; (4) the node must live in it.
    $lab   = open_user_lab($user, $tenant);
    $nodes = $lab->getNodes();
    if (!isset($nodes[$nodeId])) {
        fail(404, 'node not found in your lab');       // the cross-tenant boundary
    }
    $node = $nodes[$nodeId];

    // (5) Pick the requested console (primary or ?second=1) and assert it is an
    // http lane — an http grant must NEVER be mintable for a telnet/vnc/rdp node.
    if ($second) {
        $console  = $node->getconsole_2nd();
        $basePort = (int) $node->getSecondPort();
    } else {
        $console  = $node->getconsole();
        $basePort = (int) $node->getPort();
    }
    if (!in_array($console, ['http', 'https'], true)) {
        fail(409, "node console '$console' is not an http lane");
    }
    if ($basePort <= 0) {
        fail(409, 'node has no console port (is it started?)');
    }

    // (6) Resolve the target SERVER-SIDE. host = 127.0.0.1, or the satellite IP
    // for a cluster node whose console lives on that host (the bridge runs
    // master-side and dials out) — exactly as resolve_node_target() does.
    $chost = '127.0.0.1';
    if (method_exists($node, 'getSessionHost') && $node->getSessionHost() > 0) {
        $satIp = cluster_host_ip($node->getSessionHost());
        if ($satIp !== null) {
            $chost = $satIp;
        }
    }

    // (7) Mint an opaque token + write the grant. Store file is one line
    // "<scheme> <host> <port>\n" (e.g. "http 127.0.0.1 30336"), mode 0640; the
    // bridge trusts this file and never accepts a target from the client.
    $token = bin2hex(random_bytes(16));
    $line  = sprintf("%s %s %d\n", $console, $chost, $basePort);
    $path  = rtrim(HTTP_TOKEN_DIR, '/') . '/' . $token;
    if (@file_put_contents($path, $line, LOCK_EX) === false) {
        fail(500, 'could not write token');
    }
    @chmod($path, 0640);
    echo json_encode(['token' => $token, 'expires_in' => HTTP_TOKEN_TTL]);
    exit;
}

/* ---- 2. Params --------------------------------------------------------- */
$ALLOWED_TYPES = ['telnet', 'vnc', 'rdp'];   // rdp lane added in Slice 3
$nodeId  = isset($_GET['node'])    ? (string) $_GET['node']  : '';
$type    = isset($_GET['type'])    ? (string) $_GET['type']  : '';
$capture = isset($_GET['capture']) && $_GET['capture'] === '1';
$iface   = isset($_GET['iface'])   ? (string) $_GET['iface'] : '';
$second  = isset($_GET['second'])  && $_GET['second']  === '1';   // 2nd console (console_2nd / second port)
if ($nodeId === '' || !in_array($type, $ALLOWED_TYPES, true)) {
    fail(400, 'bad params');
}

/* ---- 3. Resolve node -> backend target, enforcing lab ownership -------- */
// Packet-capture (html5 lane) moved to the http reverse-proxy lane above: the
// capture container is now pnet-capture-web (http web UI on ws_ip:80), rendered
// through /console/http/<token>/ instead of guacd VNC. The frontend requests it
// as ?type=http&capture=1, handled in the type==='http' block near the top; a
// legacy ?type=rdp&capture=1 request is no longer a valid lane (the container no
// longer serves VNC/RDP). The NATIVE (html5-off) local-Wireshark capture:// lane
// is entirely separate (console/capture_native.php) and untouched.
if ($capture) {
    fail(409, 'capture is now the http lane — request type=http&capture=1');
}

list($host, $port, $rdp, $rdpHint, $rdpPromptCredentials) = resolve_node_target($user, $tenant, $nodeId, $type, $second);

/* ---- 4. Mint ----------------------------------------------------------- */
// RDP is a different shape: guacamole-lite is STATELESS — the "token" is a
// self-contained AES-256-CBC blob carrying the whole connection (decrypted by
// guacamole-lite with the shared GUAC_CRYPT_KEY), NOT a TokenFile line. So the
// rdp lane never touches /dev/shm; telnet/vnc keep the shared TokenFile store.
if ($type === 'rdp') {
    $token = mint_guac_token($host, $port, $rdp);
    $resp = ['token' => $token, 'expires_in' => TOKEN_TTL];
    // Surfaced by the frontend only if this connection attempt actually fails
    // (see console-tabs.js _mountRdp) — not shown up front, since plain RDP
    // works fine for plenty of uncredentialed guests.
    if ($rdpHint !== null) {
        $resp['hint'] = $rdpHint;
    }
    if ($rdpPromptCredentials) {
        $resp['prompt_credentials'] = true;
    }
    echo json_encode($resp);
    exit;
}

$token = bin2hex(random_bytes(16));

// websockify TokenFile format, also parsed by telnet_ws_bridge_telnetlib3.py.
$line = sprintf("%s: %s:%d\n", $token, $host, $port);
$path = rtrim(TOKEN_DIR, '/') . '/' . $token;
if (@file_put_contents($path, $line, LOCK_EX) === false) {
    fail(500, 'could not write token');
}
@chmod($path, 0640);
echo json_encode(['token' => $token, 'expires_in' => TOKEN_TTL]);
exit;

/* ===== helpers ========================================================== */

/**
 * Resolve [host, port] for the node's console (telnet or vnc lane), AND enforce
 * that the authenticated user owns the lab the node lives in.
 *
 * Ownership is the engine's own boundary: we load ONLY the lab the user has
 * open in their session ($user['lab']), built with their tenant/pod, then look
 * the node up inside it. A node that isn't in that lab is simply not found, so
 * a user can never resolve a node outside their own running lab.
 *
 * The bridge runs on this host, so telnet targets are always 127.0.0.1:<port>
 * (the host-side console port the engine already allocated via getPort()).
 */
/**
 * Open ONLY the lab the authenticated user has running in their session, built
 * with their tenant/pod. This is the engine's own ownership boundary: anything
 * not in this lab simply isn't found, so a user can never reach another tenant's
 * nodes or captures.
 */
function open_user_lab($user, $tenant) {
    $session = isset($user['lab']) ? (string) $user['lab'] : '';
    if ($session === '') {
        fail(409, 'no lab open in this session');
    }
    $labsession = getLabFromSession($session);
    if (!$labsession) {
        fail(409, 'no running lab session');
    }
    try {
        return new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $session);
    } catch (Exception $e) {
        fail(500, 'cannot open lab');
    }
}

/**
 * Resolve [scheme, host, port] for a packet-capture WEB container (html5 lane).
 * The engine's capture action creates Capture_<tenant_lab_node_if> (image
 * pnet-capture-web) with a docker0 IP (wiresharks.ws_ip) and serves a live-packet
 * http UI on ws_ip:80 (wiresharks.ws_port). The http bridge reverse-proxies it
 * exactly like a node http console. Ownership = the wiresharks row is keyed by the
 * user's OWN lab session + tenant, so a foreign capture is simply not found — the
 * same boundary the old VNC capture lane used. Client supplies only node+iface;
 * scheme/host/port are ALWAYS server-resolved here, never trusted from the client.
 */
function resolve_capture_http_target($user, $tenant, $nodeId, $iface) {
    if ($iface === '') {
        fail(400, 'capture requires an interface');
    }
    $lab = open_user_lab($user, $tenant);
    $db = checkDatabase();
    $stmt = $db->prepare(
        'SELECT ws_ip, ws_port FROM wiresharks WHERE ws_tenant=:t AND ws_lab=:l AND ws_node=:n AND ws_if=:i'
    );
    $stmt->execute([
        ':t' => $lab->getTenant(),
        ':l' => $lab->getSession(),
        ':n' => $nodeId,
        ':i' => $iface,
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row || empty($row['ws_ip'])) {
        fail(409, 'capture not started for this interface');
    }
    $wsip = (string) $row['ws_ip'];
    $wsport = isset($row['ws_port']) ? (int) $row['ws_port'] : 80;
    if ($wsport <= 0) { $wsport = 80; }

    // Wait until the capture web UI is actually accepting on :80 before handing the
    // browser a token — a freshly-created container isn't listening for a few
    // seconds; without this the proxied iframe races an unreachable port and blanks.
    // The token is minted once per tab, so this waits at most once. Cap well under
    // the client's budget so a truly dead container surfaces an error.
    $deadline = microtime(true) + 25;
    while (microtime(true) < $deadline) {
        $fp = @fsockopen($wsip, $wsport, $en, $es, 2);
        if ($fp) { fclose($fp); break; }
        usleep(600000);
    }
    return ['http', $wsip, $wsport];
}

/**
 * Resolve [host, port, vncSettings] for a packet-capture container. The engine's
 * capture action creates Capture_<tenant_lab_node_if> (image pnet-wireshark) with
 * a docker0 IP (wiresharks.ws_ip) and serves the Wireshark GUI over VNC:5900, so
 * guacd's VNC plugin dials ws_ip:5900. Ownership = the wiresharks row is keyed by
 * the user's own lab session + tenant, so a foreign capture is simply not found.
 *
 * NOTE: superseded by resolve_capture_http_target() — the html5 capture lane now
 * uses pnet-capture-web (http) instead of pnet-wireshark (VNC). Retained only as
 * dead reference; no caller remains.
 */
function resolve_capture_target($user, $tenant, $nodeId, $iface) {
    if ($iface === '') {
        fail(400, 'capture requires an interface');
    }
    $lab = open_user_lab($user, $tenant);
    $db = checkDatabase();
    $stmt = $db->prepare(
        'SELECT ws_ip FROM wiresharks WHERE ws_tenant=:t AND ws_lab=:l AND ws_node=:n AND ws_if=:i'
    );
    $stmt->execute([
        ':t' => $lab->getTenant(),
        ':l' => $lab->getSession(),
        ':n' => $nodeId,
        ':i' => $iface,
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row || empty($row['ws_ip'])) {
        fail(409, 'capture not started for this interface');
    }

    // pnet-wireshark runs Xvnc on :5900 (SecurityTypes None) and launches
    // /capture.sh (dumpcap -i eth0 | wireshark) as the only X client. guacd's VNC
    // plugin reaches the container over docker0, so the host is the container IP
    // (ws_ip, NOT 127.0.0.1). No RDP/RDPGFX black-screen workarounds needed — that
    // whole class of bug is exactly why this lane moved RDP->VNC. 16-bpp halves the
    // pixel data through the guacamole-lite (Node) tunnel; Wireshark is a UI app so
    // it's visually identical. 'remote' cursor renders the server-side pointer.
    $settings = [
        'color-depth' => '16',
        'cursor'      => 'remote',
    ];
    // Wait until Xvnc is actually accepting on 5900 before handing the browser a
    // token. A freshly-created capture container — especially when two warm up at
    // once under host load — isn't listening for several seconds; without this the
    // client hammers an unreachable port and blanks. The token is minted once per
    // tab and reused across the client's retries, so this waits at most once. Cap
    // well under the client's budget so a truly dead container surfaces an error.
    $wsip = (string) $row['ws_ip'];
    $deadline = microtime(true) + 25;
    while (microtime(true) < $deadline) {
        $fp = @fsockopen($wsip, 5900, $en, $es, 2);
        if ($fp) { fclose($fp); break; }
        usleep(600000);
    }
    return [$wsip, 5900, $settings];
}

function resolve_node_target($user, $tenant, $nodeId, $type, $second = false) {
    $lab = open_user_lab($user, $tenant);
    $nodes = $lab->getNodes();
    if (!isset($nodes[$nodeId])) {
        fail(404, 'node not found in your lab');     // also the ACL denial path
    }
    $node = $nodes[$nodeId];

    // Cluster: a satellite-hosted node serves its console on the SATELLITE.
    // The bridges (telnet/websockify/guacd) run master-side and dial out, so
    // the browser still only ever talks to the master — the token just points
    // the bridge at <satellite_ip>:<port> instead of 127.0.0.1.
    $chost = '127.0.0.1';
    if (method_exists($node, 'getSessionHost') && $node->getSessionHost() > 0) {
        $satIp = cluster_host_ip($node->getSessionHost());
        if ($satIp !== null) {
            $chost = $satIp;
        }
    }

    // Pick the PRIMARY console (getconsole/getPort) or the SECOND console
    // (getconsole_2nd/getSecondPort). The 2nd console is a distinct lane+port on
    // the same node — e.g. a Windows node with primary RDP and a 2nd VNC view —
    // requested via ?second=1. Ownership is already enforced by open_user_lab().
    // Each lane accepts only its own console family; an UNSET PRIMARY console
    // defaults to telnet (device.php::getConsoleUrl()'s default — IOL reports an
    // empty console but serves telnet on getPort()). A node with no 2nd console
    // configured is a hard 409.
    if ($second) {
        $console  = $node->getconsole_2nd();
        $basePort = (int) $node->getSecondPort();
        if ($console === '' || $console === null) {
            fail(409, 'node has no second console');
        }
    } else {
        $console = $node->getconsole();
        if ($console === '' || $console === null) {
            $console = 'telnet';
        }
        $basePort = (int) $node->getPort();
    }
    if ($type === 'telnet') {
        // telnet + docker 'bash' both serve a telnet server on the host port
        // (device.php maps both to telnet://). ssh/vnc/rdp/spice are other lanes.
        if (!in_array($console, ['telnet', 'bash'], true)) {
            fail(409, "node console '$console' is not a telnet lane");
        }
    } elseif ($type === 'vnc') {
        // qemu graphical nodes expose a raw RFB server on the host port; the
        // shared token store routes websockify -> 127.0.0.1:getPort() -> noVNC.
        if ($console !== 'vnc') {
            fail(409, "node console '$console' is not a vnc lane");
        }
    } elseif ($type === 'rdp') {
        // The rdp lane covers rdp + rdp-tls (guacd's protocol is 'rdp'; rdp-tls
        // just pins security=tls). guacamole-lite -> guacd -> the node's RDP host
        // port on 127.0.0.1 (the engine maps a normal rdp node to 127.0.0.1:port,
        // see device.php::getGuacConsoleLink -> html5AddSession hostname default).
        if (!in_array($console, ['rdp', 'rdp-tls'], true)) {
            fail(409, "node console '$console' is not an rdp lane");
        }
        $port = $basePort;

        // Mirror device.php::getGuacConsoleLink()'s 788e116 VNC/RDP probe: when
        // the PRIMARY graphical console isn't actually serving but a graphical 2nd
        // one is, follow the live one (eve-noble images that moved vnc->xrdp).
        // Skipped when the 2nd console was explicitly requested (?second=1) — there
        // we target exactly the 2nd port, no auto-follow.
        if (!$second) {
            $alt  = $node->getconsole_2nd();
            $altP = (int) $node->getSecondPort();
            $graphical = ['vnc', 'rdp', 'rdp-tls', 'spice'];
            if (in_array($alt, $graphical, true) && $altP > 0 && $altP !== $port
                && !pnq_serving($chost, $port) && pnq_serving($chost, $altP)) {
                $console = $alt;
                $port = $altP;
            }
        }
        if ($port <= 0) {
            fail(409, 'node has no console port (is it started?)');
        }

        // security=tls for rdp-tls, else 'any'; ignore-cert + display-update
        // resize, mirroring html5AddSession()'s rdp params. Credentials are
        // passed through when the node defines them (Windows etc.); otherwise
        // disable-auth so guacd reaches the login/desktop (xrdp default).
        //
        // Performance flags: these map directly to the RDP PerformanceFlags
        // bitmask that FreeRDP (guacd) negotiates with the Windows RDP server.
        // Each disabled visual feature eliminates a class of full-screen redraws
        // that the Guacamole encoder would otherwise have to compress and send.
        //   color-depth 16      — 33 % less pixel data than 24-bit; Windows 10
        //                         still negotiates 16-bit for backward-compat.
        //   no wallpaper        — solid-colour desktop instead of an image; the
        //                         biggest single source of large frame updates.
        //   no theming          — disables Aero/visual-styles compositor redraws.
        //   font-smoothing ON   — ClearType makes text pixels predictable, which
        //                         compresses better in both PNG and JPEG modes.
        //   no full-window-drag — ghost outline drag instead of live content.
        //   no desktop-comp.    — no DWM/compositor glass effects.
        //   no menu-animations  — no slide/fade frames on menus.
        $settings = [
            'security'                   => ($console === 'rdp-tls') ? 'tls' : 'any',
            'ignore-cert'                => 'true',
            'resize-method'              => 'display-update',
            'disable-glyph-caching'      => 'true',
            // Disable the RDP Graphics Pipeline (RDPGFX): guacd 1.6/FreeRDP 3 enable
            // it by default and force 32 bpp, but xrdp-backed nodes (the eve-*-noble
            // desktop containers) negotiate GFX yet render black under FreeRDP 3.
            // Legacy bitmap updates work everywhere; Windows RDP just loses H.264/AVC
            // efficiency (still fully functional). Same fix as the capture lane.
            'disable-gfx'                => 'true',
            'color-depth'                => '16',
            'enable-wallpaper'           => 'false',
            'enable-theming'             => 'false',
            'enable-font-smoothing'      => 'true',
            'enable-full-window-drag'    => 'false',
            'enable-desktop-composition' => 'false',
            'enable-menu-animations'     => 'false',
        ];
        $options = (array) $node->getOptions();
        $ru = isset($options['username']) ? (string) $options['username'] : '';
        $rp = isset($options['password']) ? (string) $options['password'] : '';
        $hint = null;
        $promptCredentials = false;
        if ($ru !== '' && $rp !== '') {
            $settings['username']     = $ru;
            $settings['password']     = $rp;
            $settings['disable-auth'] = 'false';
        } elseif ($console !== 'rdp-tls'
            && method_exists($node, 'getTemplate')
            && strtolower((string) $node->getTemplate()) === 'win') {
            // Windows templates may require NLA. Negotiate normally and let
            // Guacamole request credentials from this browser session.
            $settings['security'] = 'any';
            $settings['disable-auth'] = 'false';
            $promptCredentials = true;
        } else {
            // xrdp and other graphical guests provide their own login screen.
            $settings['disable-auth'] = 'true';
            if ($console !== 'rdp-tls') {
                $settings['security'] = 'rdp';
            }
        }
        return [$chost, $port, $settings, $hint, $promptCredentials];
    } else {
        fail(400, "unsupported console lane '$type'");
    }

    if ($basePort <= 0) {
        fail(409, 'node has no console port (is it started?)');
    }

    return [$chost, $basePort, null, null, false];
}

/**
 * Build a guacamole-lite connection token: a self-contained AES-256-CBC blob
 * carrying the whole RDP connection, decrypted server-side by guacamole-lite
 * with the shared GUAC_CRYPT_KEY. NodeJS crypto-compatible wire format:
 *   base64( JSON{ iv: base64(16-byte IV), value: base64(ciphertext) } )
 * (guacamole-lite's decipher reads value as 'base64'; openssl_encrypt without
 * OPENSSL_RAW_DATA returns exactly that base64 ciphertext). No /dev/shm state,
 * so the token-janitor doesn't apply — the blob is only useful to guacd via the
 * same-origin /guac/ wss route, and is minted only after the auth+ACL check.
 */
function mint_guac_token($host, $port, $settings, $type = 'rdp') {
    if (!defined('GUAC_CRYPT_KEY')) {
        fail(500, 'rdp console not configured (GUAC_CRYPT_KEY missing)');
    }
    $key = (string) GUAC_CRYPT_KEY;
    if (strlen($key) !== 32) {
        fail(500, 'GUAC_CRYPT_KEY must be exactly 32 bytes');
    }
    $conn = [
        'connection' => [
            'type'     => $type,
            'settings' => array_merge([
                'hostname' => $host,
                'port'     => (string) $port,
            ], (array) $settings),
        ],
    ];
    $iv = random_bytes(16);
    $value = openssl_encrypt(json_encode($conn), 'AES-256-CBC', $key, 0, $iv);
    if ($value === false) {
        fail(500, 'token encryption failed');
    }
    return base64_encode(json_encode([
        'iv'    => base64_encode($iv),
        'value' => $value,
    ]));
}

/**
 * Is something live on host:port? A tiny copy of device.php::pnqConsoleServing
 * (private there) used for the VNC/RDP graphical-console swap above: a banner
 * (VNC) or a connection that stays open (RDP/xrdp) => live; an immediate close
 * with no data => dead backend.
 */
function pnq_serving($host, $port) {
    $errno = 0; $errstr = '';
    $fp = @fsockopen($host, (int) $port, $errno, $errstr, 0.8);
    if (!$fp) { return false; }
    stream_set_timeout($fp, 0, 500000);
    $data = @fread($fp, 16);
    $meta = stream_get_meta_data($fp);
    @fclose($fp);
    if (($data === '' || $data === false) && empty($meta['timed_out'])) {
        return false;
    }
    return true;
}
