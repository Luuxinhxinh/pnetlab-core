<?php
/**
 * pki/api.php — HTTP front for the Lab PKI engine.
 *
 * Auth mirrors the pnq-*.php pages (engine token cookie + the user's session).
 * Every privileged operation rides the broker `pki` verb (pnetlab-brokerd →
 * scripts/pki/pnet-pki.py, running as root); this PHP never touches the CA key
 * store. Reads (profiles/list/export/crl) accept GET or POST; mutations
 * (ca_create/issue/sign_csr/revoke/delete_ca) require POST + X-Requested-With.
 *
 * export/crl stream a file download (Content-Disposition); everything else
 * returns the engine's JSON verbatim.
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';
require_once '/opt/unetlab/html/includes/broker.php';

function jout($x, $code = 200)
{
    http_response_code($code);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($x);
    exit;
}

$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    jout(['ok' => false, 'error' => 'not authenticated'], 401);
}

// PKI is ADMIN-ONLY (security review 2026-07-06): this front-end never checked
// ownership and the broker (pnet-pki.py ca_dir) validates only the ca_id/cert_id
// FORMAT, never who owns the CA — so any authenticated non-admin could 'list'
// every CA and 'export' another user's PRIVATE KEY, or revoke/delete_ca/issue/
// sign_csr against a CA they do not own. Until a per-CA owner model + migration
// lands, restrict every action to the built-in Admin role ("0"). Deny with 403.
$pkiRole = isset($user['role']) ? $user['role'] : null;
$pkiIsAdmin = ($pkiRole === 0 || $pkiRole === '0' || strtolower((string) $pkiRole) === 'admin');
if (!$pkiIsAdmin) {
    jout(['ok' => false, 'error' => 'PKI administration is restricted to admin'], 403);
}

$method = $_SERVER['REQUEST_METHOD'];
$body = [];
if ($method === 'POST') {
    $raw = file_get_contents('php://input');
    $j = json_decode($raw, true);
    $body = is_array($j) ? $j : $_POST;
}
$req = array_merge($_GET, is_array($body) ? $body : []);
$action = isset($req['action']) ? $req['action'] : '';

$READS = ['profiles', 'list', 'export', 'crl'];
$MUTATIONS = ['ca_create', 'issue', 'sign_csr', 'revoke', 'delete_ca'];

if (!in_array($action, $READS, true) && !in_array($action, $MUTATIONS, true)) {
    jout(['ok' => false, 'error' => 'bad action'], 400);
}
if (in_array($action, $MUTATIONS, true)) {
    if ($method !== 'POST') {
        jout(['ok' => false, 'error' => 'POST required'], 405);
    }
    if (empty($_SERVER['HTTP_X_REQUESTED_WITH'])) {
        jout(['ok' => false, 'error' => 'missing X-Requested-With'], 403);
    }
}

// Whitelist the args forwarded to the broker (which validates again at the
// trust boundary). The user's lab tags new CAs for context.
$args = ['action' => $action];
foreach (['ca_id', 'cert_id', 'profile', 'key_type', 'format',
          'name', 'org', 'ou', 'country', 'cn', 'p12_pass', 'csr'] as $k) {
    if (isset($req[$k]) && is_string($req[$k])) {
        $args[$k] = $req[$k];
    }
}
if (isset($req['days'])) {
    $args['days'] = intval($req['days']);
}
if (isset($req['two_tier'])) {
    $args['two_tier'] = ($req['two_tier'] === true || $req['two_tier'] === '1'
        || $req['two_tier'] === 1 || $req['two_tier'] === 'true') ? 1 : 0;
}
if (isset($req['sans'])) {
    if (is_array($req['sans'])) {
        $args['sans'] = array_values(array_filter(array_map('strval', $req['sans'])));
    } elseif (is_string($req['sans'])) {
        $args['sans'] = array_values(array_filter(array_map('trim',
            explode(',', $req['sans'])), 'strlen'));
    }
}
if (isset($req['lab']) && is_string($req['lab'])) {
    $args['lab'] = $req['lab'];
} elseif (isset($user['lab']) && $user['lab'] !== '') {
    $args['lab'] = (string) $user['lab'];
}

$resp = broker_call('pki', $args, 60);
if (!$resp['ok'] || !count($resp['out'])) {
    jout(['ok' => false, 'error' => $resp['err'] ? $resp['err'] : 'pki broker error'], 502);
}
$data = json_decode($resp['out'][0], true);
if (!is_array($data)) {
    jout(['ok' => false, 'error' => 'bad engine response'], 502);
}

// File downloads (export/crl) when the engine succeeded; else fall through to JSON.
if (($action === 'export' || $action === 'crl') && !empty($data['ok'])) {
    $fname = preg_replace('/[^A-Za-z0-9._-]/', '_',
        isset($data['filename']) ? $data['filename'] : 'download');
    header('Content-Type: ' . (isset($data['ctype']) ? $data['ctype'] : 'application/octet-stream'));
    header('Content-Disposition: attachment; filename="' . $fname . '"');
    header('Cache-Control: no-store');
    if (!empty($data['binary'])) {
        echo base64_decode($data['data_b64']);
    } else {
        echo isset($data['data']) ? $data['data'] : '';
    }
    exit;
}

jout($data);
