<?php
/**
 * resource_guard_daemon.php — 24/7 background resource monitor & incident recorder.
 * Runs as root under systemd (pnetlab-resource-guard.service).
 *
 * Roles:
 * 1. Root Telemetry Provider: Scans /proc as root every 3 seconds, maps active nodes
 *    to users/pods, and publishes /dev/shm/pnetlab_user_resources.json for the web dashboard.
 * 2. Incident Recorder: Detects host overloads (CPU >= 85% or RAM >= 85%), records snapshot
 *    to `resource_incidents` (FIFO 1000 limit, 14-day retention).
 * 3. Root Process Terminator: Executes emergency stop requests dispatched by admin from UI.
 */

chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

define('SHM_LIVE_FILE', '/dev/shm/pnetlab_user_resources.json');
define('SHM_STOP_REQ',  '/dev/shm/pnetlab_guard_stop.req');

function log_msg($msg) {
    $entry = date('[Y-m-d H:i:s] ') . $msg . "\n";
    @file_put_contents('/var/log/pnetlab-resource-guard.log', $entry, FILE_APPEND);
}

function get_cpu_sample() {
    $lines = @file('/proc/stat');
    if (!$lines) return null;
    $p = preg_split('/\s+/', trim($lines[0]));
    if ($p[0] !== 'cpu') return null;
    $total = array_sum(array_slice($p, 1));
    $idle = (int)$p[4] + (isset($p[5]) ? (int)$p[5] : 0);
    return ['total' => $total, 'idle' => $idle];
}

$last_cpu_sample = get_cpu_sample();

function measure_cpu(&$last_sample) {
    $s2 = get_cpu_sample();
    if (!$last_sample || !$s2) {
        $last_sample = $s2;
        return 0.0;
    }
    $dt = $s2['total'] - $last_sample['total'];
    $di = $s2['idle'] - $last_sample['idle'];
    $last_sample = $s2;
    if ($dt <= 0) return 0.0;
    return round(max(0, min(100, 100 * ($dt - $di) / $dt)), 1);
}

function measure_ram() {
    $memdata = @file_get_contents('/proc/meminfo');
    if (!$memdata) return ['percent' => 0.0, 'used_mb' => 0, 'total_mb' => 0];
    $m = [];
    foreach (explode("\n", $memdata) as $l) {
        if (preg_match('/^(\w+):\s+(\d+)/', $l, $x)) {
            $m[$x[1]] = (int)$x[2];
        }
    }
    $total_kb = isset($m['MemTotal']) ? $m['MemTotal'] : 0;
    $avail_kb = isset($m['MemAvailable']) ? $m['MemAvailable'] : (isset($m['MemFree']) ? $m['MemFree'] : 0);
    if ($total_kb <= 0) return ['percent' => 0.0, 'used_mb' => 0, 'total_mb' => 0];
    $total_mb = (int)round($total_kb / 1024);
    $used_mb = max(0, (int)round(($total_kb - $avail_kb) / 1024));
    $percent = round(($used_mb * 100) / $total_mb, 1);
    return ['percent' => $percent, 'used_mb' => $used_mb, 'total_mb' => $total_mb];
}

function ensure_incident_table($db) {
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
}

function scan_user_telemetry($db, $host_cpu = 0.0) {
    // 1. Load users & lab_sessions mapping
    $users_info = [];
    try {
        $rows = $db->query("SELECT pod, username, name, email FROM users")->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $r) {
            $users_info[(int)$r['pod']] = $r;
        }
    } catch (Exception $e) {}

    $lab_to_pod = [];
    $pod_labs = [];
    try {
        $l_rows = $db->query("SELECT lab_session_id, lab_session_pod, lab_session_path FROM lab_sessions")->fetchAll(PDO::FETCH_ASSOC);
        foreach ($l_rows as $lr) {
            $lid = (int)$lr['lab_session_id'];
            $lpod = (int)$lr['lab_session_pod'];
            $lab_to_pod[$lid] = $lpod;
            if (!isset($pod_labs[$lpod])) $pod_labs[$lpod] = [];
            $lab_name = basename($lr['lab_session_path'], '.unl');
            if (!in_array($lab_name, $pod_labs[$lpod], true)) {
                $pod_labs[$lpod][] = ['lab_name' => $lab_name];
            }
        }
    } catch (Exception $e) {}

    // 2. Scan /proc
    $proc_dirs = @glob('/proc/[0-9]*', GLOB_NOSORT);
    $node_pids = [];
    $pod_stats = [];
    $all_unique_nodes = [];

    if (is_array($proc_dirs)) {
        foreach ($proc_dirs as $pdir) {
            $cwd = @readlink($pdir . '/cwd');
            if ($cwd && strpos($cwd, '/opt/unetlab/tmp/') === 0) {
                $parts = explode('/', trim($cwd, '/'));
                if (isset($parts[3]) && is_numeric($parts[3])) {
                    $lab_session_id = (int)$parts[3];
                    $node_session_id = (isset($parts[4]) && is_numeric($parts[4])) ? (int)$parts[4] : 0;
                    $pod = isset($lab_to_pod[$lab_session_id])
                        ? $lab_to_pod[$lab_session_id]
                        : (isset($users_info[$lab_session_id]) ? $lab_session_id : 0);

                    $pid = (int)basename($pdir);
                    $node_pids[$pid] = $pod;
                    if (!isset($pod_stats[$pod])) {
                        $pod_stats[$pod] = ['cpu' => 0.0, 'ram_mb' => 0, 'pids' => [], 'unique_nodes' => []];
                    }
                    $pod_stats[$pod]['pids'][] = $pid;
                    $node_key = $lab_session_id . '_' . $node_session_id;
                    $pod_stats[$pod]['unique_nodes'][$node_key] = true;
                    $all_unique_nodes[$node_key] = true;

                    // Read RSS from /proc/<pid>/statm
                    $statm = @file_get_contents($pdir . '/statm');
                    if ($statm) {
                        $f = preg_split('/\s+/', trim($statm));
                        if (isset($f[1])) {
                            $pod_stats[$pod]['ram_mb'] += (int)round(((int)$f[1] * 4) / 1024);
                        }
                    }
                }
            }
        }
    }

    // 3. Measure CPU per pid via ps
    if (!empty($node_pids)) {
        $ps_out = [];
        @exec('ps -eo pid=,%cpu=', $ps_out);
        foreach ($ps_out as $row) {
            $c = preg_split('/\s+/', trim($row));
            if (count($c) >= 2 && is_numeric($c[0])) {
                $pid = (int)$c[0];
                if (isset($node_pids[$pid])) {
                    $pod = $node_pids[$pid];
                    $pod_stats[$pod]['cpu'] += (float)str_replace(',', '.', $c[1]);
                }
            }
        }
    }

    // Number of CPU cores for system-wide 0-100% normalization
    $num_cores = 1;
    $cpuinfo = @file_get_contents('/proc/cpuinfo');
    if ($cpuinfo) {
        $num_cores = max(1, substr_count($cpuinfo, 'processor'));
    }

    $total_node_ps_cpu = 0.0;
    foreach ($pod_stats as $stat) {
        $total_node_ps_cpu += (float)$stat['cpu'];
    }

    $calc_cpu = function($stat_cpu) use ($num_cores, $host_cpu, $total_node_ps_cpu) {
        $raw_avg = $stat_cpu / $num_cores;
        if ($host_cpu > 0 && $total_node_ps_cpu > 5.0) {
            $share = $stat_cpu / $total_node_ps_cpu;
            $proportional = $host_cpu * $share;
            return round(min(100.0, max($raw_avg, $proportional)), 1);
        }
        return round(min(100.0, $raw_avg), 1);
    };

    $user_list = [];
    foreach ($users_info as $pod => $u) {
        $stat = isset($pod_stats[$pod]) ? $pod_stats[$pod] : ['cpu' => 0.0, 'ram_mb' => 0, 'pids' => [], 'unique_nodes' => []];
        $cpu_rounded = $calc_cpu($stat['cpu']);
        $running_nodes_count = count($stat['unique_nodes']);
        $is_high = ($cpu_rounded >= 80.0 || $stat['ram_mb'] >= 5000);
        $is_warning = (!$is_high && ($cpu_rounded >= 60.0 || $stat['ram_mb'] >= 3500));
        $user_list[] = [
            'pod'           => (int)$pod,
            'username'      => $u['username'],
            'name'          => $u['name'],
            'email'         => $u['email'],
            'cpu_percent'   => $cpu_rounded,
            'ram_mb'        => (int)$stat['ram_mb'],
            'running_nodes' => $running_nodes_count,
            'is_high_load'  => $is_high,
            'is_warning'    => $is_warning,
            'labs'          => isset($pod_labs[$pod]) ? $pod_labs[$pod] : [],
            'pids'          => $stat['pids']
        ];
    }
    foreach ($pod_stats as $pod => $stat) {
        if (!isset($users_info[$pod])) {
            $cpu_rounded = $calc_cpu($stat['cpu']);
            $running_nodes_count = count($stat['unique_nodes']);
            $is_high = ($cpu_rounded >= 80.0 || $stat['ram_mb'] >= 5000);
            $is_warning = (!$is_high && ($cpu_rounded >= 60.0 || $stat['ram_mb'] >= 3500));
            $user_list[] = [
                'pod'           => (int)$pod,
                'username'      => 'Pod ' . $pod,
                'name'          => '',
                'email'         => '',
                'cpu_percent'   => $cpu_rounded,
                'ram_mb'        => (int)$stat['ram_mb'],
                'running_nodes' => $running_nodes_count,
                'is_high_load'  => $is_high,
                'is_warning'    => $is_warning,
                'labs'          => isset($pod_labs[$pod]) ? $pod_labs[$pod] : [],
                'pids'          => $stat['pids']
            ];
        }
    }

    usort($user_list, function($a, $b) {
        if (($b['running_nodes'] > 0) !== ($a['running_nodes'] > 0)) {
            return ($b['running_nodes'] > 0) ? 1 : -1;
        }
        if ($b['ram_mb'] === $a['ram_mb']) {
            return $b['cpu_percent'] <=> $a['cpu_percent'];
        }
        return $b['ram_mb'] <=> $a['ram_mb'];
    });

    return [
        'users' => $user_list,
        'total_nodes' => count($all_unique_nodes),
        'lab_to_pod' => $lab_to_pod
    ];
}

function handle_stop_requests($db, $lab_to_pod) {
    if (!is_file(SHM_STOP_REQ)) return;
    $raw = @file_get_contents(SHM_STOP_REQ);
    @unlink(SHM_STOP_REQ);
    if (!$raw) return;
    $data = json_decode($raw, true);
    if (!isset($data['pod'])) return;
    $pod = (int)$data['pod'];

    $target_lab_sessions = [];
    foreach ($lab_to_pod as $lid => $lpod) {
        if ($lpod === $pod) $target_lab_sessions[] = $lid;
    }

    $match_prefixes = ["/opt/unetlab/tmp/$pod/"];
    foreach ($target_lab_sessions as $tls) {
        $match_prefixes[] = "/opt/unetlab/tmp/$tls/";
    }

    $proc_dirs = @glob('/proc/[0-9]*', GLOB_NOSORT);
    $killed = 0;
    if (is_array($proc_dirs)) {
        foreach ($proc_dirs as $pdir) {
            $cwd = @readlink($pdir . '/cwd');
            if ($cwd) {
                foreach ($match_prefixes as $mp) {
                    if (strpos($cwd, $mp) === 0) {
                        $pid = (int)basename($pdir);
                        if ($pid > 1) {
                            @exec("kill -15 $pid 2>/dev/null");
                            $killed++;
                        }
                        break;
                    }
                }
            }
        }
        if ($killed > 0) {
            usleep(300000);
            foreach ($proc_dirs as $pdir) {
                $cwd = @readlink($pdir . '/cwd');
                if ($cwd) {
                    foreach ($match_prefixes as $mp) {
                        if (strpos($cwd, $mp) === 0) {
                            $pid = (int)basename($pdir);
                            if ($pid > 1) {
                                @exec("kill -9 $pid 2>/dev/null");
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    // Sync state in MySQL so Running Labs and Labs view immediately show 0 running
    try {
        $db->prepare("UPDATE node_sessions SET node_session_running = 0, node_cpu = 0, node_ram = 0 WHERE node_session_pod = ?")->execute([$pod]);
        if (!empty($target_lab_sessions)) {
            $in_clause = implode(',', array_map('intval', $target_lab_sessions));
            $db->exec("UPDATE node_sessions SET node_session_running = 0, node_cpu = 0, node_ram = 0 WHERE node_session_lab IN ($in_clause)");
            $db->exec("UPDATE lab_sessions SET lab_session_running = 0 WHERE lab_session_id IN ($in_clause)");
        }
    } catch (Exception $e) {
        log_msg("Error updating node_sessions on stop: " . $e->getMessage());
    }

    log_msg("Emergency stop executed as root for Pod $pod ($killed processes terminated, DB synchronized).");
}

log_msg("PNetLab Resource Guard Daemon started. Live root telemetry + 24/7 incident recorder active.");

$last_incident_ts = 0;
$reconcile_counter = 0;
$db = null;

while (true) {
    try {
        if (!$db) {
            $db = checkDatabase();
            if ($db) ensure_incident_table($db);
        }

        if ($db) {
            $cpu = measure_cpu($last_cpu_sample);
            $ram = measure_ram();

            $telemetry = scan_user_telemetry($db, $cpu);

            // Publish live JSON for web UI
            $payload = [
                'server' => [
                    'cpu'                 => $cpu,
                    'ram_percent'         => $ram['percent'],
                    'ram_used_mb'         => $ram['used_mb'],
                    'ram_total_mb'        => $ram['total_mb'],
                    'total_running_nodes' => $telemetry['total_nodes'],
                    'total_active_users'  => count($telemetry['users'])
                ],
                'users' => $telemetry['users'],
                'updated_at' => time()
            ];

            file_put_contents(SHM_LIVE_FILE, json_encode($payload));
            @chmod(SHM_LIVE_FILE, 0666);

            // Handle any stop requests
            handle_stop_requests($db, $telemetry['lab_to_pod']);

            // Periodic auto-healing of zombie/phantom running states
            $reconcile_counter++;
            if ($reconcile_counter >= 10) {
                $reconcile_counter = 0;
                if ($telemetry['total_nodes'] === 0) {
                    try {
                        $db->exec("UPDATE node_sessions SET node_session_running = 0, node_cpu = 0, node_ram = 0 WHERE node_session_running = 1 AND (node_session_host = 0 OR node_session_host IS NULL)");
                    } catch (Exception $e) {}
                }
            }

            // Overload detection (Record incident ONLY when Host CPU >= 80% or Host RAM >= 80% or an individual user consumes >= 80% CPU)
            $has_critical_user = false;
            foreach ($telemetry['users'] as $u_check) {
                if (!empty($u_check['cpu_percent']) && $u_check['cpu_percent'] >= 80.0) {
                    $has_critical_user = true;
                    break;
                }
            }

            if ($cpu >= 80.0 || $ram['percent'] >= 80.0 || $has_critical_user) {
                $now = time();
                if (($now - $last_incident_ts) >= 60) {
                    $active_consumers = array_filter($telemetry['users'], function($u) {
                        return (!empty($u['running_nodes']) && $u['running_nodes'] > 0) ||
                               (!empty($u['cpu_percent']) && $u['cpu_percent'] > 0) ||
                               (!empty($u['ram_mb']) && $u['ram_mb'] > 0);
                    });
                    $top_snapshot = array_slice(array_values($active_consumers), 0, 5);
                    $severity = ($cpu >= 90.0 || $ram['percent'] >= 90.0) ? 'critical' : 'warning';

                    $ins = $db->prepare("INSERT INTO resource_incidents (created_at, server_cpu, server_ram, top_users, total_nodes, severity) VALUES (?, ?, ?, ?, ?, ?)");
                    $ins->execute([
                        $now,
                        $cpu,
                        $ram['percent'],
                        json_encode($top_snapshot),
                        $telemetry['total_nodes'],
                        $severity
                    ]);

                    // Retention policy (FIFO 1000 limit, 14 days)
                    $cutoff = $now - (14 * 86400);
                    $db->exec("DELETE FROM resource_incidents WHERE created_at < " . (int)$cutoff);
                    $db->exec("DELETE FROM resource_incidents WHERE id NOT IN (SELECT id FROM (SELECT id FROM resource_incidents ORDER BY id DESC LIMIT 1000) AS t)");

                    $last_incident_ts = $now;
                    log_msg("Recorded overload incident ($severity): CPU {$cpu}%, RAM {$ram['percent']}%, Nodes: {$telemetry['total_nodes']}.");
                }
            }
        }
    } catch (Exception $e) {
        log_msg("Error in monitor cycle: " . $e->getMessage());
        $db = null; // Reconnect on error
    }

    sleep(3);
}
