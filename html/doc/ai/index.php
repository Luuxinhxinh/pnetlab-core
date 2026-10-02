<?php
/**
 * doc/ai/index.php — authentication gate for the API documentation.
 *
 * The /doc/ai/ artifacts (index.html, openapi.yaml, api-ai.md,
 * mcp-tools.json, doc.css) are committed static files, but they enumerate
 * the appliance's full route map and error taxonomy — free reconnaissance
 * for an anonymous visitor. So nothing in this directory is served
 * directly: the .htaccess rewrites every request to this gate, which runs
 * the engine's own token-cookie session check (identical pattern to
 * status/api.php) and only then streams the requested artifact.
 *
 * Unauthenticated: a browser asking for the page is bounced to the login
 * page (302 /); a tool asking for an artifact gets 401 JSON.
 * The filename is whitelist-matched — no traversal, no surprise files.
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

$ALLOW = array(
    'index.html'     => 'text/html; charset=utf-8',
    'doc.css'        => 'text/css; charset=utf-8',
    'openapi.yaml'   => 'application/yaml; charset=utf-8',
    'api-ai.md'      => 'text/markdown; charset=utf-8',
    'mcp-tools.json' => 'application/json; charset=utf-8',
);

$f = isset($_GET['f']) ? basename((string) $_GET['f']) : '';
if ($f === '' || $f === 'index.php') {
    $f = 'index.html';
}
if (!isset($ALLOW[$f]) || !is_file(__DIR__ . '/' . $f)) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(array('code' => 404, 'status' => 'fail',
                           'message' => 'not found'));
    exit;
}

/* ---- AUTH — engine cookie/session check (pattern: status/api.php) ------- */
$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    if ($f === 'index.html') {
        header('Location: /', true, 302);   // browser -> login page
        exit;
    }
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(array('code' => 401, 'status' => 'unauthorized',
                           'message' => 'authentication required'));
    exit;
}

header('Content-Type: ' . $ALLOW[$f]);
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
readfile(__DIR__ . '/' . $f);
