<?php
/* ============================================================================
   server-init/index.php — engine-side emitter for window.server (Phase C store
   decommission, item C5). Replaces the retired Laravel store endpoint
   /store/public/admin/default/initial (DefaultController::initial()).

   Emits Content-Type: application/javascript that builds the global
   `window.server` object with the SAME shape the store used:

     window.server = {
       user:   { username, email, role, html5, offline, pod },
       common: { APP_SLOGAN, APP_TITLE, APP_DOMAIN, APP_AUTHEN, APP_UPLOAD,
                 APP_ADMIN, APP_CENTER, ctrl_docker_wireshark }
     };

   Engine consumers: pnetlab-webconsole.js (reads/writes server.user.html5) and
   the canvas-flow island ({user:{html5}, common:{}}).

   Auth: standalone-module idiom — chdir /opt/unetlab/html + require init.php +
   identify the caller via the `token` cookie through indentify::authorization().
   Unauthenticated → emit user:{} (exactly like the store did with an empty user
   object) so the page still boots; common:{...} is always emitted.

   The offline appliance never phones home, so the store's online APP_* URLs
   (APP_DOMAIN/APP_AUTHEN/APP_UPLOAD/APP_ADMIN/APP_CENTER) are null-routed to
   http://disabled.invalid; APP_TITLE is the product name, APP_SLOGAN empty.
   ============================================================================ */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';
require_once BASE_DIR . '/html/includes/api_authentication.php';

header('Content-Type: application/javascript');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

// --- resolve the authenticated user (empty on failure, like the store) -------
$userOut = new stdClass(); // json_encode({}) → {} (empty object, not [])
try {
	$indent = new \indentify();
	$token = isset($_COOKIE['token']) ? $_COOKIE['token'] : '';
	list($user, $tenant, $err) = $indent->authorization($token);
	if (is_array($user)) {
		$userOut = [
			USER_USERNAME => isset($user[USER_USERNAME]) ? $user[USER_USERNAME] : '',
			USER_EMAIL    => isset($user[USER_EMAIL])    ? $user[USER_EMAIL]    : '',
			USER_ROLE     => isset($user[USER_ROLE])     ? $user[USER_ROLE]     : '',
			USER_HTML5    => isset($user[USER_HTML5])    ? $user[USER_HTML5]    : '',
			USER_OFFLINE  => isset($user[USER_OFFLINE])  ? $user[USER_OFFLINE]  : '',
			USER_POD      => isset($user[USER_POD])      ? $user[USER_POD]      : '',
		];
	}
} catch (\Throwable $e) {
	// leave $userOut as the empty object — unauthenticated boot still works
	$userOut = new stdClass();
}

// --- ctrl_docker_wireshark from the control table (default '0') --------------
$wireshark = '0';
try {
	$db = checkDatabase();
	$stmt = $db->prepare('SELECT ' . CONTROL_VALUE . ' FROM ' . CONTROL_TABLE .
		' WHERE ' . CONTROL_NAME . ' = :name');
	$stmt->bindValue(':name', CTRL_DOCKER_WIRESHARK, PDO::PARAM_STR);
	$stmt->execute();
	$row = $stmt->fetch(PDO::FETCH_ASSOC);
	if (is_array($row) && isset($row[CONTROL_VALUE]) && $row[CONTROL_VALUE] !== null) {
		$wireshark = (string) $row[CONTROL_VALUE];
	}
} catch (\Throwable $e) {
	$wireshark = '0';
}

/* Custom product name (/main/#/custom). Read straight from the branding config
   rather than via branding/api.php — this file is already server-side, and an
   HTTP round trip to ourselves would be silly. Every failure mode (no file,
   unreadable, malformed JSON, wrong type) falls through to the stock name. */
$appTitle = 'PNetLab';
$brandCfg = '/opt/unetlab/data/branding/config.json';
if (is_file($brandCfg) && is_readable($brandCfg)) {
	$brandRaw = @file_get_contents($brandCfg);
	if ($brandRaw !== false && $brandRaw !== '') {
		$brandJson = json_decode($brandRaw, true);
		if (is_array($brandJson) && isset($brandJson['name']) && is_string($brandJson['name']) && trim($brandJson['name']) !== '') {
			$appTitle = mb_substr(trim($brandJson['name']), 0, 40);
		}
	}
}

$common = [
	'APP_SLOGAN' => '',
	'APP_TITLE'  => $appTitle,
	'APP_DOMAIN' => 'http://disabled.invalid',
	'APP_AUTHEN' => 'http://disabled.invalid',
	'APP_UPLOAD' => 'http://disabled.invalid',
	'APP_ADMIN'  => 'http://disabled.invalid',
	'APP_CENTER' => 'http://disabled.invalid',
	CTRL_DOCKER_WIRESHARK => $wireshark,
];

$server = [
	'user'   => $userOut,
	'common' => $common,
];

// JSON_UNESCAPED_SLASHES keeps the disabled.invalid URLs readable; the payload
// is assigned to a global, so escaping is via json_encode (no raw interpolation).
echo 'window.server = ' . json_encode($server, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . ';';
