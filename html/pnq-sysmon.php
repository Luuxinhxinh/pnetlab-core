<?php
/**
 * pnq-sysmon.php — lightweight host CPU / RAM / Disk usage for the topology-page
 * monitor widget (pnetlab-sysmon.js). Returns JSON: {"cpu":N,"mem":N,"disk":N}
 * where each N is a 0-100 percentage (or -1 if unavailable). Cheap: CPU is a
 * 200ms /proc/stat delta, RAM is /proc/meminfo, disk is the /opt/unetlab
 * filesystem. No app/DB bootstrap, no auth (returns only three integers).
 */
header('Content-Type: application/json');
header('Cache-Control: no-store');

function pnq_cpu_sample()
{
    $lines = @file('/proc/stat');
    if (!$lines) {
        return null;
    }
    $p = preg_split('/\s+/', trim($lines[0])); // cpu user nice system idle iowait irq softirq steal
    if ($p[0] !== 'cpu') {
        return null;
    }
    $vals = array_slice($p, 1);
    $total = 0;
    foreach ($vals as $v) {
        $total += (int) $v;
    }
    $idle = (int) $vals[3] + (isset($vals[4]) ? (int) $vals[4] : 0); // idle + iowait
    return array('total' => $total, 'idle' => $idle);
}

function pnq_cpu_pct()
{
    $a = pnq_cpu_sample();
    if (!$a) {
        return -1;
    }
    usleep(200000); // 0.2s
    $b = pnq_cpu_sample();
    if (!$b) {
        return -1;
    }
    $dt = $b['total'] - $a['total'];
    $di = $b['idle'] - $a['idle'];
    if ($dt <= 0) {
        return 0;
    }
    return max(0, min(100, (int) round(100 * ($dt - $di) / $dt)));
}

function pnq_mem_pct()
{
    $data = @file_get_contents('/proc/meminfo');
    if ($data === false) {
        return -1;
    }
    $m = array();
    foreach (explode("\n", $data) as $l) {
        if (preg_match('/^(\w+):\s+(\d+)/', $l, $x)) {
            $m[$x[1]] = (int) $x[2];
        }
    }
    if (empty($m['MemTotal'])) {
        return -1;
    }
    $avail = isset($m['MemAvailable'])
        ? $m['MemAvailable']
        : (isset($m['MemFree']) ? $m['MemFree'] : 0);
    return max(0, min(100, (int) round(100 - ($avail / $m['MemTotal'] * 100))));
}

function pnq_disk_pct()
{
    $path = is_dir('/opt/unetlab') ? '/opt/unetlab' : '/';
    $t = @disk_total_space($path);
    $f = @disk_free_space($path);
    if ($t && $t > 0) {
        return max(0, min(100, (int) round(100 - ($f / $t * 100))));
    }
    // fall back to df if disk_*_space is restricted
    $o = array();
    @exec('df -P ' . escapeshellarg($path), $o, $rc);
    if ($rc === 0 && isset($o[1]) && preg_match('/(\d+)%/', $o[1], $x)) {
        return (int) $x[1];
    }
    return -1;
}

echo json_encode(array(
    'cpu' => pnq_cpu_pct(),
    'mem' => pnq_mem_pct(),
    'disk' => pnq_disk_pct(),
));
