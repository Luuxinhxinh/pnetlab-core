<?php
/**
 * doctor.php — PNetLab platform health checks (B8).
 *
 * One shared check set, two consumers:
 *   - CLI:  /opt/unetlab/scripts/pnetlab_doctor.php   (root, human/JSON output)
 *   - API:  GET /api/health                            (auth-gated, JSON)
 *
 * Each check returns: name, status ('ok'|'warn'|'fail'), detail.
 * 'fail' = the platform is broken for users; 'warn' = degraded/missing
 * optional capability (e.g. capture image not pulled on an offline box).
 */

function doctor_check($name, $status, $detail = '', $fix = '')
{
    $r = ['name' => $name, 'status' => $status, 'detail' => $detail];
    if ($status !== 'ok' && $fix !== '') $r['fix'] = $fix;
    return $r;
}

function doctor_exec($cmd)
{
    $out = [];
    $rc = 1;
    exec($cmd . ' 2>/dev/null', $out, $rc);
    return [$rc, trim(implode("\n", $out))];
}

function doctor_run()
{
    $checks = [];

    // ── systemd units ─────────────────────────────────────────────────────
    $units = [
        'apache2' => 'fail', 'mysql' => 'fail', 'docker' => 'fail',
        'guacd' => 'fail',
        'pnet-console-mux' => 'fail',
        'pnet-guac-lite' => 'fail', 'pnet-shell-bridge' => 'fail',
    ];
    foreach ($units as $u => $sev) {
        list($rc, $state) = doctor_exec('systemctl is-active ' . escapeshellarg($u));
        $checks[] = doctor_check("unit $u", $state === 'active' ? 'ok' : $sev, $state,
            "systemctl restart $u; journalctl -u $u -n 50");
    }

    // ── docker engine (probed through the broker's docker_version verb —
    //    Stage 5: no direct :4243 dial here, so this check stays truthful
    //    when the tcp socket closes and docker access becomes broker-only) ─
    $dv = broker_call('docker_version', [], 10);
    $dver = (!empty($dv['ok']) && !empty($dv['out'])) ? trim($dv['out'][0]) : '';
    $checks[] = doctor_check('docker engine', $dver !== '' ? 'ok' : 'fail',
        $dver !== '' ? "server $dver" : ('unreachable' . (!empty($dv['err']) ? ': ' . trim($dv['err']) : '')),
        "systemctl restart docker; journalctl -u docker -n 50; systemctl restart pnetlab-brokerd");

    // ── privilege broker (B1: engine root verbs ride this socket) ───────
    list($rc, $state) = doctor_exec('systemctl is-active pnetlab-brokerd');
    $checks[] = doctor_check('unit pnetlab-brokerd', $state === 'active' ? 'ok' : 'fail', $state,
        "systemctl restart pnetlab-brokerd; journalctl -u pnetlab-brokerd -n 50");
    $pong = broker_call('ping', [], 5);
    $checks[] = doctor_check('broker ping', $pong['ok'] ? 'ok' : 'fail',
        $pong['ok'] ? 'pong' : $pong['err'],
        "systemctl restart pnetlab-brokerd; ls -la /run/pnetlab/broker.sock");
    // B7: the www-data NOPASSWD grant is retired — flag a resurrected one
    $checks[] = doctor_check('sudoers grant retired',
        is_file('/etc/sudoers.d/unetlab') ? 'warn' : 'ok',
        is_file('/etc/sudoers.d/unetlab') ? '/etc/sudoers.d/unetlab present (legacy)' : 'absent',
        "rm /etc/sudoers.d/unetlab  # retired since 6.7.10 — pnetlab-brokerd handles root ops");

    // ── bridge/LACP kernel compatibility (optional DKMS capability) ─────
    // The bridge package owns this read-only status record. Keep it a warning:
    // stock-kernel fallback still carries ordinary lab traffic, while LACP
    // needs an operator-visible rollback to a previously checked kernel.
    $lacpFile = '/run/pnetlab-bridge-dkms/bridge-lacp.status';
    $lacp = [];
    if (is_readable($lacpFile)) {
        foreach (@file($lacpFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
            $parts = explode('=', $line, 2);
            if (count($parts) === 2) $lacp[$parts[0]] = $parts[1];
        }
    }
    $lacpResult = isset($lacp['result']) && $lacp['result'] !== '' ? $lacp['result'] : 'indeterminate';
    $lacpDetail = isset($lacp['detail']) && $lacp['detail'] !== '' ? $lacp['detail'] : 'no result for this boot';
    $lacpKernel = isset($lacp['kernel']) && $lacp['kernel'] !== '' ? $lacp['kernel'] : php_uname('r');
    if ($lacpResult === 'compatible') {
        $checks[] = doctor_check('bridge LACP kernel', 'ok', "kernel=$lacpKernel $lacpDetail");
    } else {
        $checks[] = doctor_check(
            'bridge LACP kernel',
            'warn',
            "kernel=$lacpKernel result=$lacpResult detail=$lacpDetail",
            'pnetlab-bridge-dkms-status; after a real LACP failure, reboot into the newest installed release-confirmed kernel it lists (see /boot/grub/grub.cfg)'
        );
    }

    // ── KSM (memory dedup) ───────────────────────────────────────────────
    // Current releases use the distro's stock kernel, whose in-tree KSM is
    // the supported implementation. Check the capability, not the retired
    // custom-kernel name.
    $kernel = php_uname('r');
    $ksmRun = '/sys/kernel/mm/ksm/run';
    $ksmAvailable = is_readable($ksmRun);
    $checks[] = doctor_check('ksm available', $ksmAvailable ? 'ok' : 'warn',
        $ksmAvailable ? "$kernel (in-tree KSM present)" : "$kernel (KSM sysfs missing)",
        'boot a kernel that provides CONFIG_KSM and /sys/kernel/mm/ksm');
    $run = $ksmAvailable ? @trim(@file_get_contents($ksmRun)) : '';
    $shared = @trim(@file_get_contents('/sys/kernel/mm/ksm/pages_shared'));
    $checks[] = doctor_check('ksm active', $ksmAvailable && $run === '1' ? 'ok' : 'warn',
        $ksmAvailable ? "run=$run pages_shared=$shared" : 'unavailable',
        "echo 1 > /sys/kernel/mm/ksm/run");

    // ── QEMU default (pnetlab-qemu reinstalls can clobber this symlink) ──
    // Release 8.2 uses the distro-backed qemu-10.x compatibility tree. Keep
    // this check version-agnostic: the health contract is a valid executable
    // default target, while release/install gates own the version policy.
    $qemu = @readlink('/opt/qemu');
    if ($qemu === false) {
        $checks[] = doctor_check('qemu default', 'fail', '/opt/qemu symlink missing',
            'repoint /opt/qemu to the installed modern /opt/qemu-* tree; ldconfig');
    } else {
        $bin = '/opt/' . basename($qemu) . '/bin/qemu-system-x86_64';
        if (!is_dir('/opt/' . basename($qemu)) || !is_executable($bin)) {
            $checks[] = doctor_check('qemu default', 'fail', "$qemu (target/binary missing)",
                'repoint /opt/qemu to the installed modern /opt/qemu-* tree; ldconfig');
        } else {
            $checks[] = doctor_check('qemu default', 'ok', $qemu);
        }
    }

    // ── database + release label ─────────────────────────────────────────
    $db = function_exists('checkDatabase') ? checkDatabase() : false;
    if ($db === false) {
        $checks[] = doctor_check('database', 'fail', 'pnetlab_db unreachable',
            "systemctl restart mysql; check /opt/unetlab/html/includes/config.yml for credentials");
    } else {
        $checks[] = doctor_check('database', 'ok', 'pnetlab_db reachable');
        try {
            $st = $db->query("SELECT control_value FROM control WHERE control_name='ctrl_version'");
            $v = $st ? $st->fetchColumn() : false;
            $checks[] = doctor_check('release label', $v ? 'ok' : 'warn', $v ?: 'ctrl_version row missing',
                "mysql pnetlab_db -e \"INSERT INTO control VALUES('ctrl_version','8.2.0') ON DUPLICATE KEY UPDATE control_value='8.2.0'\"");
        } catch (Exception $e) {
            $checks[] = doctor_check('release label', 'warn', $e->getMessage(),
                "systemctl restart mysql; check /opt/unetlab/html/includes/config.yml");
        }
    }

    // ── disk space (labs/images land under /opt/unetlab) ────────────────
    list($rc, $avail) = doctor_exec("df -BG --output=avail /opt/unetlab | tail -1 | tr -dc 0-9");
    $availG = (int) $avail;
    $checks[] = doctor_check(
        'disk space',
        $availG >= 10 ? 'ok' : ($availG >= 2 ? 'warn' : 'fail'),
        "${availG}G free on /opt/unetlab",
        "rm -rf /opt/unetlab/tmp/pnetlab-*; docker image prune -f  # as root"
    );

    // ── IOL prerequisite ─────────────────────────────────────────────────
    // The current release gate confirmed its supported IOL binaries do not
    // consume libssl1.1; that retired offline compatibility rider must not be
    // reported as a platform dependency merely because its soname is absent.
    $checks[] = doctor_check(
        'iol license (iourc)',
        is_file('/opt/unetlab/addons/iol/bin/iourc') ? 'ok' : 'warn',
        is_file('/opt/unetlab/addons/iol/bin/iourc') ? 'present' : 'missing — IOL nodes will not boot',
        "python3 /opt/unetlab/addons/iol/bin/CiscoIOUKeygen3.py  # generates /opt/unetlab/addons/iol/bin/iourc"
    );

    // ── HTML5 capture image (pulled from Docker Hub) ─────────────────────
    // pnet-capture-web replaced the retired bundled pnet-wireshark VNC image.
    // Presence is evaluated against the brokered repo:tag list (Stage 5), with
    // no direct Docker socket or shell pipe from the API consumer.
    $wresp = broker_call('docker_image_ls', ['mode' => 'refs'], 30);
    $captureRef = '';
    if (!empty($wresp['ok']) && isset($wresp['out'])) {
        foreach ($wresp['out'] as $wl) {
            if (strpos($wl, 'pnet-capture-web:') === 0) {
                $captureRef = $wl;
                break;
            }
        }
    }
    $checks[] = doctor_check('html5 capture image', $captureRef !== '' ? 'ok' : 'warn',
        $captureRef !== '' ? "$captureRef present" : 'pnet-capture-web:1.0 not installed — HTML5 capture unavailable',
        'docker pull rspnet/pnet-capture-web:latest && docker tag rspnet/pnet-capture-web:latest pnet-capture-web:1.0');

    // ── node run dir perms (root:unl 2777 — node start breaks otherwise) ─
    $st = @stat('/opt/unetlab/tmp');
    $perm = $st ? substr(sprintf('%o', $st['mode']), -4) : '';
    $checks[] = doctor_check('tmp perms', $perm === '2777' ? 'ok' : 'warn', "/opt/unetlab/tmp mode $perm",
        "/opt/unetlab/wrappers/unl_wrapper -a fixpermissions");

    // ── DNS (warn-only: offline appliances often ship empty resolv.conf) ─
    $resolv = @file_get_contents('/etc/resolv.conf');
    $checks[] = doctor_check('dns resolver', ($resolv && preg_match('/^\s*nameserver\s+\S+/m', $resolv)) ? 'ok' : 'warn',
        'nameserver ' . (($resolv && preg_match('/^\s*nameserver\s+(\S+)/m', $resolv, $m)) ? $m[1] : 'missing (apt/docker pulls will fail)'),
        "echo 'nameserver 1.1.1.1' > /etc/resolv.conf");

    // ── overall ──────────────────────────────────────────────────────────
    $overall = 'ok';
    foreach ($checks as $c) {
        if ($c['status'] === 'fail') { $overall = 'fail'; break; }
        if ($c['status'] === 'warn') { $overall = 'degraded'; }
    }

    return ['overall' => $overall, 'checks' => $checks, 'time' => date('c')];
}
