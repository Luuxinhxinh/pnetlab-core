#!/usr/bin/env php
<?php
/**
 * pnetlab-clear-stale-running.php — clear node running flags that outlived
 * their node (reboot, killed process). Run once per boot by
 * pnetlab-clear-stale-running.service, before the web tier starts.
 *
 *   php /opt/unetlab/scripts/pnetlab-clear-stale-running.php
 *
 * Only local rows whose live probe says "stopped" are cleared, so a manual or
 * package-time run never touches a node that is actually up.
 */

require_once('/opt/unetlab/html/includes/init.php');
require_once('/opt/unetlab/html/includes/docker-start-attempt.php');

if (php_sapi_name() != 'cli') {
    fwrite(STDERR, "CLI only\n");
    exit(1);
}

try {
    $cleared = pnqClearStaleLocalRunningFlags(checkDatabase());
} catch (Exception $e) {
    fwrite(STDERR, 'clear-stale-running: ' . $e->getMessage() . "\n");
    exit(1);
}

echo 'clear-stale-running: cleared ' . count($cleared) . ' stale running flag(s)'
    . ($cleared ? ' (node_session ' . implode(', ', $cleared) . ')' : '') . "\n";
