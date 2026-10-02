<?php
/**
 * pnq-linkhide.php — server-side persistence for the "hide link" view preference.
 *
 * The link-hide overlay (themes/default/js/pnetlab-link-hide.js) stores WHICH links
 * a user has hidden. Client-side localStorage proved unreliable across reloads, so
 * the authoritative store lives here, keyed by the lab id the user has open (the
 * session unambiguously identifies it — no client-side key guessing). The actual
 * hiding is still client-side CSS; this only persists the LIST of hidden network ids.
 *
 *   GET                       -> {hidden:[net_id,...]} for the open lab
 *   POST {hidden:[net_id,...]}-> replace the list, returns {ok:true,hidden:[...]}
 *
 * Auth + lab model mirror pnq-wifi.php (token cookie -> indentify -> Lab). One JSON
 * map file (BASE_LAB/.pnq-linkhide.json, www-data-writable, dot-prefixed so the lab
 * file manager ignores it) holds every lab's list; read-modify-write under flock.
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');
function lh_out($x, $code = 200) { http_response_code($code); echo json_encode($x); exit; }

$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) lh_out(['error' => 'not authenticated'], 401);

$session = isset($user['lab']) ? $user['lab'] : '';
if ($session === '') lh_out(['error' => 'no lab session'], 400);

$labsession = getLabFromSession($session);
if (!$labsession) lh_out(['error' => 'no lab session'], 400);

try {
    $lab = new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $session);
} catch (Exception $e) {
    lh_out(['error' => 'cannot open lab'], 400);
}
$labId = (string) $lab->getId();
$store = BASE_LAB . '/.pnq-linkhide.json';

/* sanitise a client list into a deduped array of numeric-id strings (network ids). */
function lh_clean($arr) {
    $out = [];
    if (is_array($arr)) {
        foreach ($arr as $h) {
            if (!is_string($h) && !is_int($h)) continue;
            $s = preg_replace('/[^0-9]/', '', (string) $h);
            if ($s !== '') $out[$s] = $s;
        }
    }
    $out = array_values($out);
    if (count($out) > 5000) $out = array_slice($out, 0, 5000);
    return $out;
}

/* read the whole map under a shared lock. */
function lh_read_all($store) {
    if (!is_file($store)) return [];
    $fh = @fopen($store, 'r');
    if (!$fh) return [];
    @flock($fh, LOCK_SH);
    $raw = stream_get_contents($fh);
    @flock($fh, LOCK_UN);
    @fclose($fh);
    $j = json_decode($raw, true);
    return is_array($j) ? $j : [];
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true);
    $hidden = lh_clean(is_array($body) && isset($body['hidden']) ? $body['hidden'] : []);
    // read-modify-write the map under an exclusive lock
    $fh = @fopen($store, 'c+');
    if (!$fh) lh_out(['error' => 'store not writable'], 500);
    @flock($fh, LOCK_EX);
    $raw = stream_get_contents($fh);
    $map = json_decode($raw, true);
    if (!is_array($map)) $map = [];
    if (empty($hidden)) unset($map[$labId]); else $map[$labId] = $hidden;
    rewind($fh);
    ftruncate($fh, 0);
    fwrite($fh, json_encode($map));
    fflush($fh);
    @flock($fh, LOCK_UN);
    @fclose($fh);
    @chmod($store, 0664);
    lh_out(['ok' => true, 'hidden' => $hidden]);
}

/* GET */
$map = lh_read_all($store);
$hidden = (isset($map[$labId]) && is_array($map[$labId])) ? array_values($map[$labId]) : [];
lh_out(['hidden' => $hidden]);
