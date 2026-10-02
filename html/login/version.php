<?php
/**
 * login/version.php — lightweight, pre-auth-safe JSON endpoint that hands the
 * login page the friendly PNetLab release string. login/ is Apache-served so
 * PHP executes here even before a token exists.
 *
 * Single source of truth: includes/version.php (PNET_VERSION — the numeric
 * "8.2.0" release label the classic login shows). That file only define()s the
 * constants — no DB, no side effects — so it's safe to pull in ahead of
 * authentication. Do NOT query the DB here: a running box may hold a stale
 * ctrl_version row, and this endpoint must work even if the DB is down.
 */
require_once '/opt/unetlab/html/includes/version.php';
header('Content-Type: application/json');
echo json_encode([
    'version' => defined('PNET_VERSION') ? PNET_VERSION : '',
    'release' => defined('PNET_RELEASE') ? PNET_RELEASE : '',
]);
