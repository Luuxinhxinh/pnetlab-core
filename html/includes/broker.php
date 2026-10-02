<?php
/**
 * broker.php — client for pnetlab-brokerd (B1 privilege broker).
 *
 * Engine code calls broker_call()/broker_exec() instead of exec("sudo ...").
 * The daemon (scripts/pnetlab-brokerd.py, pnetlab-brokerd.service) runs as
 * root on a unix socket and exposes an allowlisted, argument-validated verb
 * set. NO sudo fallback here on purpose: a dead broker must fail loudly so
 * the gate catches it, not silently fall back to the grant we are retiring.
 */

define('BROKER_SOCK', 'unix:///run/pnetlab/broker.sock');

/**
 * Send one verb to the broker.
 * Returns ['ok' => bool, 'rc' => int, 'out' => [lines], 'err' => string].
 */
function broker_call($verb, $args = [], $timeout = 60)
{
    $fail = function ($msg) use ($verb) {
        error_log(date('M d H:i:s ') . 'ERROR: broker ' . $verb . ': ' . $msg);
        return ['ok' => false, 'rc' => 255, 'out' => [], 'err' => $msg];
    };

    $sock = @stream_socket_client(BROKER_SOCK, $errno, $errstr, 5);
    if (!$sock) {
        return $fail('unreachable: ' . $errstr);
    }
    stream_set_timeout($sock, $timeout);
    fwrite($sock, json_encode(['verb' => $verb, 'args' => (object) $args]) . "\n");
    $line = stream_get_line($sock, 1048576, "\n");
    fclose($sock);

    if ($line === false || $line === '') {
        return $fail('no response (timeout after ' . $timeout . 's?)');
    }
    $resp = json_decode($line, true);
    if (!is_array($resp) || !isset($resp['ok'])) {
        return $fail('bad response');
    }
    if (!$resp['ok']) {
        error_log(date('M d H:i:s ') . 'WARNING: broker ' . $verb .
            ' rc=' . $resp['rc'] . ' err=' . $resp['err']);
    }
    return $resp;
}

/**
 * exec()-shaped wrapper for drop-in ports: fills $out/$rc like exec() did,
 * returns the last output line (or '' on none/failure).
 */
function broker_exec($verb, $args, &$out = null, &$rc = null, $timeout = 60)
{
    $resp = broker_call($verb, $args, $timeout);
    $out = $resp['out'];
    $rc = $resp['rc'];
    return count($out) ? $out[count($out) - 1] : '';
}

/**
 * Attach an already-started QEMU to its broker-owned systemd scope.
 * Every QEMU gets the fairness weight.  The exact-1 checkbox is passed only as
 * a typed policy bit; the broker derives the PID, unit name, quota, period,
 * weight, timer, and cgroup path.
 */
function broker_qemu_cpu_scope($nodeSession, $smp, $quotaRequested, $timeout = 35)
{
    return broker_call('qemu_cpu_scope', [
        'session' => (int) $nodeSession,
        'smp'     => (int) $smp,
        'quota'   => $quotaRequested ? 1 : 0,
    ], $timeout);
}

/** Repoint the retained global CPU policy and reapply it to live scopes. */
function broker_qemu_cpu_policy($enabled, $timeout = 35)
{
    return broker_call('qemu_cpu_policy', [
        'enabled' => $enabled ? 1 : 0,
    ], $timeout);
}

/** Read the retained global CPU policy flag through the root broker. */
function broker_qemu_cpu_policy_status($timeout = 10)
{
    return broker_call('qemu_cpu_policy_status', [], $timeout);
}

/**
 * Stage 1 (docker rebroker): READ-ONLY `docker inspect` through the broker.
 * The container name is derived BROKER-side from typed integer ids — never
 * passed as a string:
 *   kind 'node'           $ids = ['node_session' => N]          -> docker<N>
 *   kind 'capture'        $ids = tenant/lab_session/node_session/interface_id
 *                                -> Capture_<t>_<l>_<ns>_<if>
 *   kind 'capture_shared' $ids = tenant/lab_session -> Capture_<t>_<l>
 * $format must be one of the broker's allowlisted inspect templates
 * ('{{ .State.Running }}', '{{ .State.Pid }}', '{{json .State}}') or null for
 * the full JSON document. Returns the broker_call() response array.
 */
function broker_docker_inspect($kind, $ids, $format = null, $timeout = 30)
{
    $args = array_merge(['kind' => $kind], $ids);
    if ($format !== null) {
        $args['format'] = $format;
    }
    return broker_call('docker_inspect', $args, $timeout);
}

/**
 * Stage 2 (docker rebroker): node-container lifecycle through the broker.
 *
 * The broker ROOT-READS the node's template YAML itself and builds the
 * `docker create` argv ARRAY from it (dangerous capabilities are sourced from
 * the template, validated against a fixed allowlist, executed as an argv list
 * — never a shell string). www-data passes ONLY typed, already-user-settable,
 * validated leaf values.
 *
 * $args keys (docker_create):
 *   family       'docker' | 'ceos' | 'srlinux'   (which driver profile)
 *   session      int  node global session   -> container docker<session>
 *   lab_session  int  lab session           -> runningPath jail
 *   template     str  template name (broker re-reads templates/<plat>/<name>.yml)
 *   name         str  node name (-h hostname; one argv token, cannot inject)
 *   image        str  docker image (broker strips :<imageid> + RE_IMAGE)
 *   ram, cpu     int  (family=docker only; --memory/--cpus)
 *   publish      [{host:int>=1024, guest:int}]  console -p pairs (GUI branch)
 *   firstboot    bool (family=docker; add -v <runpath>/firstboot.cfg:/firstboot.cfg:ro)
 *   etba, eos_platform          (family=ceos leaf values)
 *   card_type, clab_intfs, sr_license, has_startup  (family=srlinux)
 * Returns the broker_call() response array.
 */
function broker_docker_create($args, $timeout = 180)
{
    return broker_call('docker_create', $args, $timeout);
}

/** `docker start docker<node_session>` — name derived broker-side from the id. */
function broker_docker_start($node_session, $timeout = 60)
{
    return broker_call('docker_start', ['node_session' => (int) $node_session], $timeout);
}

/** `docker stop docker<node_session>` — name derived broker-side from the id. */
function broker_docker_stop($node_session, $timeout = 60)
{
    return broker_call('docker_stop', ['node_session' => (int) $node_session], $timeout);
}

/** `docker rm [--force] docker<node_session>` — name derived broker-side. */
function broker_docker_rm($node_session, $force = false, $timeout = 60)
{
    return broker_call('docker_rm', [
        'node_session' => (int) $node_session,
        'force' => $force ? 1 : 0,
    ], $timeout);
}

/**
 * Stage 3 (docker rebroker): `docker exec` through the broker. $cmd selects an
 * entry from the broker's fixed command enum (umount_resolv, chmod_node_shell,
 * ls_bin_bash, busybox_ln_bash, ethtool_offload_docker0, ethtool_offload_e1,
 * sr_cli_source_startup, sr_cli_export, attach_node_shell, attach_sh,
 * attach_bin_bash, attach_bash, attach_cli, attach_sr_cli) — NEVER a free-form
 * command string. ethtool_offload_e1 additionally takes ['interface_id' => int].
 * Container name is derived broker-side as docker<node_session>.
 */
function broker_docker_exec($node_session, $cmd, $extra = [], $timeout = 90)
{
    $args = array_merge([
        'node_session' => (int) $node_session,
        'cmd' => $cmd,
    ], $extra);
    return broker_call('docker_exec', $args, $timeout);
}

/**
 * Stage 3 (docker rebroker): `docker cp` through the broker. $file selects an
 * entry from the broker's fixed selector map:
 *   wrapper_busybox / wrapper_profile / wrapper_udhcpc / wrapper_bash_static
 *     -> shipped root-owned /opt/unetlab/wrappers/<f> pushed to <ctr>:/
 *   node_shell    -> <runningPath>/node_shell.sh  -> <ctr>:/node_shell.sh
 *   ceos_startup  -> <runningPath>/startup-config -> <ctr>:/mnt/flash/
 *   ceos_initial  -> <runningPath>/initial-config -> <ctr>:/mnt/flash/startup-config
 *   ceos_export   -> <ctr>:/mnt/flash/startup-config -> <runningPath>/export-config
 *   srlinux_export-> <ctr>:export-config             -> <runningPath>/export-config
 * runningPath endpoints are broker-derived from the typed ids (symlink-reject +
 * realpath jail); no path ever crosses the socket.
 */
function broker_docker_cp($node_session, $lab_session, $file, $timeout = 90)
{
    return broker_call('docker_cp', [
        'node_session' => (int) $node_session,
        'lab_session' => (int) $lab_session,
        'file' => $file,
    ], $timeout);
}

/**
 * Stage 4 (docker rebroker): image lifecycle through the broker. $ref is a
 * docker image reference (or, where noted, a bare hex image id) — the broker
 * re-validates it against the same strict grammar devices-factory/api.php
 * uses (RE_IMAGE_REF/RE_IMAGE_ID) and runs docker as an argv array.
 */

/** Detached `docker pull <ref>` on the device-factory lane. The broker derives
 * jobId = 'custom'+substr(md5(ref),0,12) itself (returned as out[0]), writes
 * /tmp/pnet_device_factory_<job>_log and clears the process_device row on
 * completion — identical polling contract to a catalog install. */
function broker_docker_image_pull($ref, $timeout = 30)
{
    return broker_call('docker_image_pull', ['ref' => (string) $ref], $timeout);
}

/** `docker rmi <ref-or-id>` — never -f; docker's own in-use refusal is the
 * guard and comes back in out/err. */
function broker_docker_image_rmi($ref, $timeout = 120)
{
    return broker_call('docker_image_rmi', ['ref' => (string) $ref], $timeout);
}

/** `docker ps -a --filter ancestor=<ref-or-id> --format {{.Names}}` — the
 * read-only "which containers use this image" lookup (out = names). */
function broker_docker_image_ancestor($ref, $timeout = 60)
{
    return broker_call('docker_image_ancestor', ['ref' => (string) $ref], $timeout);
}

/** Read-only image-store listings; $mode is one of the broker's fixed set:
 * 'images_json' ({{json .}} lines), 'used' (ps -a {{.Image}}), 'refs'
 * ({{.Repository}}:{{.Tag}} lines). */
function broker_docker_image_ls($mode, $timeout = 60)
{
    return broker_call('docker_image_ls', ['mode' => (string) $mode], $timeout);
}

/**
 * Stage 5 (docker rebroker): read-only status/health verbs — no caller input
 * at all crosses the socket for any of these.
 */

/** Running-container count — `docker ps -q` counted broker-side (no shell
 * pipe). out[0] = decimal count. */
function broker_docker_ps_count($timeout = 30)
{
    return broker_call('docker_ps_count', [], $timeout);
}

/** `docker stats --no-stream --format '{{.Name}};{{.CPUPerc}};{{.MemUsage}}'`
 * — the format string is fixed broker-side; out = one 'name;cpu%;mem' line
 * per running container. */
function broker_docker_stats($timeout = 60)
{
    return broker_call('docker_stats', [], $timeout);
}

/** `docker version --format {{.Server.Version}}` — engine reachability +
 * server version. ok:false or empty out = docker endpoint down. */
function broker_docker_version($timeout = 30)
{
    return broker_call('docker_version', [], $timeout);
}

/**
 * Stage 6 (docker rebroker): capture + winbox container lane. Every verb's
 * docker argv is FIXED broker-side; the caller passes typed ids only (the
 * container/hostname/pcap-path derivations all happen in the broker):
 *   capture_create       tenant/lab_session/node_session/interface_id + serial
 *                        -> the live NET_ADMIN pnet-capture-web sidecar
 *   capture_wifi_create  tenant/lab_session/medium('airduct'|'vwifi')
 *                        -> file-mode viewer, pcap bind derived+jailed broker-side
 *   winbox_create        ids + hostname (option-arg token) -> winbox container
 *   capture_rm           name (RE-bounded Capture_<ints> ONLY) -> rm -f; the
 *                        ws_dc_name stale-session teardown lane
 * docker_start/stop/rm additionally accept ['kind'=>'capture'|'capture_shared']
 * with the capture ids (default 'node' keeps the Stage 2 shape), and
 * docker_exec accepts cmd 'raise_wireshark_window' with tenant/lab_session/
 * cap_idx on the legacy shared capture container.
 */

/** The four capture ids every per-interface capture verb keys on. */
function broker_capture_ids($tenant, $lab_session, $node_session, $interface_id)
{
    return [
        'tenant' => (int) $tenant,
        'lab_session' => (int) $lab_session,
        'node_session' => (int) $node_session,
        'interface_id' => (int) $interface_id,
    ];
}

/** rm -f of a capture container BY NAME (ws_dc_name teardown) — broker rejects
 * anything that is not a Capture_<ints> shape. */
function broker_capture_rm($name, $timeout = 60)
{
    return broker_call('capture_rm', ['name' => (string) $name], $timeout);
}

/* ---------------------------------------------------------------------------
 * qemu disk image commit / save-as (verb qemu_img).
 *
 * Both take a node's RUNNING overlay path; the broker jails it to
 * /opt/unetlab/tmp and re-validates the basename, so a caller cannot aim these
 * at a base image under addons. save_as takes a destination image NAME, never
 * a path — the broker composes addons/qemu/<name> itself and refuses a name
 * that already exists.
 *
 * NOTE: the broker does NO auth (it trusts the calling PHP). The admin check
 * and the node-is-stopped check belong to the caller, and both are done in
 * apiCommitLabNode. Writing into addons/qemu changes what EVERY lab on the
 * appliance can boot, so it is admin-only.
 * ------------------------------------------------------------------------ */

/** `qemu-img commit <overlay>` — folds the node's changes into its SHARED base
 * image. Every node cloned from that base inherits them, retroactively. */
function broker_qemu_commit($file, $timeout = 1800)
{
    return broker_call('qemu_img', [
        'op' => 'commit',
        'file' => (string) $file,
    ], $timeout);
}

/** `qemu-img convert` the overlay into a NEW addons/qemu/<dest>/ image.
 * Non-destructive: the base the node was cloned from is untouched. */
function broker_qemu_save_as($file, $dest, $timeout = 3600)
{
    return broker_call('qemu_img', [
        'op' => 'save_as',
        'file' => (string) $file,
        'dest' => (string) $dest,
    ], $timeout);
}
