<?php
/**
 * cron_resource_guard.php — Background incident monitor for PNetLab.
 * Runs every minute via cron.
 * 
 * Logic:
 *  - Checks host CPU & RAM load.
 *  - IF host is healthy (CPU < 85% and RAM < 85%), exits immediately (0 overhead).
 *  - IF host is overloaded (CPU >= 85% or RAM >= 85%), captures snapshot:
 *      * Top consumers (users/pods with highest RAM / CPU).
 *      * Inserts into `resource_incidents` table (minimum 3m interval).
 *      * Auto-purges records older than 14 days and trims to 1000 max records.
 * 
 * Storage safety guarantee:
 *  - Storage is capped at max 1,000 records (~500 KB total).
 *  - Will NEVER fill disk space.
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

try {
    $db = checkDatabase();
    if (!$db) exit(0);

    // 1. Measure Host RAM & CPU
    $server_cpu = 0.0;
    $server_ram_percent = 0.0;

    // Read RAM
    $mem_lines = [];
    @exec('free -m', $mem_lines);
    foreach ($mem_lines as $line) {
        if (preg_match('/^mem:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+).*$/mi', $line, $m)) {
            $total = (int) $m[1];
            $available = (int) $m[6];
            if ($total > 0) {
                $server_ram_percent = round(100 - ($available * 100 / $total), 1);
            }
        }
    }

    // Read CPU (2nd sample)
    $cpu_lines = [];
    @exec('top -b -n2 -p1 -d0.5', $cpu_lines);
    foreach ($cpu_lines as $line) {
        if (preg_match('/^%cpu.*\s([\d\.]+)(?=\sid).*$/mi', $line, $m)) {
            $server_cpu = round(100 - (float) $m[1], 1);
        }
    }

    // Healthy threshold check: normal load doesn't write anything
    if ($server_cpu < 85.0 && $server_ram_percent < 85.0) {
        exit(0);
    }

    // 2. Ensure table exists
    $db->exec("CREATE TABLE IF NOT EXISTS `resource_incidents` (
        `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `created_at` INT UNSIGNED NOT NULL,
        `server_cpu` FLOAT NOT NULL DEFAULT 0,
        `server_ram` FLOAT NOT NULL DEFAULT 0,
        `top_users` TEXT NOT NULL,
        `total_nodes` INT NOT NULL DEFAULT 0,
        `severity` VARCHAR(16) NOT NULL DEFAULT 'warning',
        INDEX `idx_created_at` (`created_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;");

    // 3. Rate-limit snapshot creation (minimum 3 minutes between entries)
    $last_ts = 0;
    try {
        $last_ts = (int) $db->query("SELECT MAX(created_at) FROM resource_incidents")->fetchColumn();
    } catch (Exception $e) {}

    if ((time() - $last_ts) < 180) {
        exit(0); // already logged an incident within 3 minutes
    }

    // 4. Collect Pod consumption
    $pod_usage = []; // pod => ['cpu' => 0.0, 'ram_mb' => 0, 'pids' => []]
    $proc_dirs = @glob('/proc/[0-9]*', GLOB_NOSORT);
    $node_pids = [];
    if (is_array($proc_dirs)) {
        foreach ($proc_dirs as $pdir) {
            $cwd = @readlink($pdir . '/cwd');
            if ($cwd && strpos($cwd, '/opt/unetlab/tmp/') === 0) {
                $parts = explode('/', trim($cwd, '/'));
                if (isset($parts[3]) && is_numeric($parts[3])) {
                    $pod = (int) $parts[3];
                    $pid = (int) basename($pdir);
                    $node_pids[$pid] = $pod;
                    if (!isset($pod_usage[$pod])) {
                        $pod_usage[$pod] = ['cpu' => 0.0, 'ram_mb' => 0, 'pids' => []];
                    }
                    $pod_usage[$pod]['pids'][] = $pid;
                }
            }
        }
    }

    if (!empty($node_pids)) {
        $ps_out = [];
        @exec('ps -eo pid=,rss=', $ps_out);
        foreach ($ps_out as $row) {
            $c = preg_split('/\s+/', trim($row));
            if (count($c) >= 2) {
                $pid = (int) $c[0];
                if (isset($node_pids[$pid])) {
                    $pod = $node_pids[$pid];
                    $pod_usage[$pod]['ram_mb'] += (int) round(((int) $c[1]) / 1024);
                }
            }
        }

        $top_out = [];
        @exec('top -b -n2 -d0.5 -w512', $top_out);
        foreach ($top_out as $row) {
            $row = preg_replace('/^\s+/', '', $row);
            $c = preg_split('/\s+/', $row);
            if (isset($c[8]) && is_numeric($c[0])) {
                $pid = (int) $c[0];
                if (isset($node_pids[$pid])) {
                    $pod = $node_pids[$pid];
                    $pod_usage[$pod]['cpu'] += (float) str_replace(',', '.', $c[8]);
                }
            }
        }
    }

    // Fetch user details
    $users_info = [];
    $rows = $db->query("SELECT pod, username, name, email FROM users")->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as $r) {
        $users_info[(int) $r['pod']] = $r;
    }

    $top_users = [];
    $total_nodes = count($node_pids);

    foreach ($pod_usage as $pod => $stat) {
        $u = isset($users_info[$pod]) ? $users_info[$pod] : ['username' => 'pod_' . $pod, 'name' => 'Pod ' . $pod, 'email' => ''];
        $top_users[] = [
            'pod'           => $pod,
            'username'      => $u['username'],
            'name'          => $u['name'],
            'email'         => $u['email'],
            'cpu_percent'   => round($stat['cpu'], 1),
            'ram_mb'        => (int) $stat['ram_mb'],
            'running_nodes' => count($stat['pids'])
        ];
    }

    usort($top_users, function ($a, $b) {
        if ($b['ram_mb'] === $a['ram_mb']) {
            return $b['cpu_percent'] <=> $a['cpu_percent'];
        }
        return $b['ram_mb'] <=> $a['ram_mb'];
    });

    $top_snapshot = array_slice($top_users, 0, 5);
    $severity = ($server_cpu >= 95.0 || $server_ram_percent >= 95.0) ? 'critical' : 'warning';

    // 5. Insert Incident
    $ins = $db->prepare("INSERT INTO resource_incidents (created_at, server_cpu, server_ram, top_users, total_nodes, severity) VALUES (?, ?, ?, ?, ?, ?)");
    $ins->execute([
        time(),
        $server_cpu,
        $server_ram_percent,
        json_encode($top_snapshot),
        $total_nodes,
        $severity
    ]);

    // 6. Enforce safe retention & FIFO ring buffer
    // A. Delete older than 14 days
    $cutoff = time() - (14 * 86400);
    $db->exec("DELETE FROM resource_incidents WHERE created_at < " . (int) $cutoff);

    // B. Keep maximum 1000 records
    $db->exec("DELETE FROM resource_incidents WHERE id NOT IN (SELECT id FROM (SELECT id FROM resource_incidents ORDER BY id DESC LIMIT 1000) AS t)");

} catch (Exception $e) {
    error_log("[ResourceGuard] " . $e->getMessage());
}
