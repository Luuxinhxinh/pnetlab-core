#!/usr/bin/env php
<?php
/**
 * pnetlab_doctor.php — B8 platform health CLI.
 *
 *   sudo php /opt/unetlab/scripts/pnetlab_doctor.php          # human output
 *   sudo php /opt/unetlab/scripts/pnetlab_doctor.php --json   # machine output
 *
 * Exit code: 0 = no failures (warnings allowed), 1 = at least one FAIL.
 * Same checks as GET /api/health (shared includes/doctor.php).
 */

require_once('/opt/unetlab/html/includes/init.php');
require_once('/opt/unetlab/html/includes/doctor.php');

if (php_sapi_name() != 'cli') {
    fwrite(STDERR, "CLI only\n");
    exit(1);
}

$result = doctor_run();

if (in_array('--json', $argv)) {
    echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
} else {
    echo "=== pnetlab doctor — " . php_uname('n') . " — " . $result['time'] . " ===\n";
    foreach ($result['checks'] as $c) {
        printf("%-5s %-26s %s\n", strtoupper($c['status']), $c['name'], $c['detail']);
    }
    echo "=== overall: " . $result['overall'] . " ===\n";
}

exit($result['overall'] === 'fail' ? 1 : 0);
