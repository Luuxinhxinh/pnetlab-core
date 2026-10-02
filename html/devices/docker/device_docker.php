<?php

/**
 *
 * @author LIN
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 *
 */

class device_docker extends device
{
    public function createEthernets($quantity)
    {
        $ethernets = [];
        $tpl = $this->tpl;

        // Apply eth_format and eth_name from template (mirrors device_qemu.php logic).
        $eth_format = isset($tpl['eth_format']) ? $tpl['eth_format'] : '';
        $prefix = 'eth';
        $first  = 0;
        $format = [];
        if ($eth_format != '') {
            $format = EthFormat2val($eth_format);
            $prefix = $format['prefix'];
            $first  = $format['first'];
        }
        $pass = 0;

        for ($i = 0; $i < $quantity; $i++) {
            if (!isset($this->ethernets[$i])) {
                // Determine display name: eth_name overrides first, then eth_format, then plain ethN.
                if (!empty($tpl['eth_name'][$i])) {
                    $n = $tpl['eth_name'][$i];
                    $pass++;
                } elseif ($eth_format != '') {
                    if (isset($format['slotstart']) && $format['slotstart'] != 9999) {
                        $n  = $prefix . ((int)(($i - $pass) / $format['mod']) + $format['slotstart']) . $format['sep'];
                        $n .= (($i - $pass) % $format['mod']) + $first;
                    } elseif (isset($format['mod']) && $format['mod'] != 9999) {
                        $n = $prefix . ((($i - $pass) % $format['mod']) + $first);
                    } else {
                        $n = $prefix . ($i - $pass + $first);
                    }
                } else {
                    $n = 'eth' . $i;
                }

                try {
                    $ethernets[$i] = new Interfc(
                        $this,
                        [
                            "name" => $n,
                            "type" => "ethernet",
                        ],
                        $i
                    );
                } catch (Exception $e) {
                    error_log(
                        date("M d H:i:s ") .
                            "ERROR: " .
                            $GLOBALS["messages"][40020]
                    );
                    error_log(date("M d H:i:s ") . (string) $e);
                    return 40020;
                }
            } else {
                $ethernets[$i] = $this->ethernets[$i];
            }
        }
        $this->ethernets = $ethernets;
        return $this->ethernets;
    }

    public function editParams($p)
    {
        // SECURITY (2026-07-12): docker_options used to be settable via the
        // node-edit API payload (any USER_PER_EDIT_LAB lab user) and was later
        // raw-concatenated into a root-run `docker create` shell command in
        // prepare() below — a direct root command-injection
        // (docker_options="; id > /tmp/x ; #" ran as uid=0). docker_options is
        // now sourced ONLY from the trusted template YAML ($this->tpl, loaded
        // fresh from disk in the device constructor) — it is intentionally
        // never read from $p (API payload) or persisted node/.unl state here.

        if (isset($p["username"])) {
            $this->username = (string) $p["username"];
        }

        if (isset($p["password"])) {
            $this->password = (string) $p["password"];
        }

        if (isset($p["console"])) {
            $this->console = (string) $p["console"];
        }

        if (isset($p["console_2nd"])) {
            $this->console_2nd = (string) $p["console_2nd"];
        }

        if (isset($p["map_port"])) {
            $this->map_port = (string) $p["map_port"];
        }

        if (isset($p["map_port_2nd"])) {
            $this->map_port_2nd = (string) $p["map_port_2nd"];
        }

        if (isset($p["eth1_dhcp"])) {
            $this->eth1_dhcp = (int) $p["eth1_dhcp"];
        }

        if (isset($p["eth1_ip"])) {
            $this->eth1_ip = (string) $p["eth1_ip"];
        }

        if (isset($p["eth2_dhcp"])) {
            $this->eth2_dhcp = (int) $p["eth2_dhcp"];
        }

        if (isset($p["eth2_ip"])) {
            $this->eth2_ip = (string) $p["eth2_ip"];
        }

        if (isset($p["eth3_dhcp"])) {
            $this->eth3_dhcp = (int) $p["eth3_dhcp"];
        }

        if (isset($p["eth3_ip"])) {
            $this->eth3_ip = (string) $p["eth3_ip"];
        }

        if (isset($p["default_route"])) {
            $this->default_route = (string) $p["default_route"];
        }

        if (isset($p["DNS"])) {
            $this->DNS = (string) $p["DNS"];
        }

        parent::editParams($p);
    }

    public function getParams()
    {
        $params = parent::getParams();
        return array_replace($params, [
            // Read-only, informational: reflects the trusted template value,
            // never user/.unl state (see editParams()). Any value the GUI
            // submits back for this key is ignored.
            "docker_options" => isset($this->tpl["docker_options"]) ? (string) $this->tpl["docker_options"] : "",
            "username" => $this->username,
            "password" => $this->password,
            "console" => $this->console,
            "console_2nd" => $this->console_2nd,
            "map_port" => $this->map_port,
            "map_port_2nd" => $this->map_port_2nd,
            "eth1_dhcp" => $this->eth1_dhcp,
            "eth1_ip" => $this->eth1_ip,
            "eth2_dhcp" => $this->eth2_dhcp,
            "eth2_ip" => $this->eth2_ip,
            "eth3_dhcp" => $this->eth3_dhcp,
            "eth3_ip" => $this->eth3_ip,
            "default_route" => $this->default_route,
            "DNS" => $this->DNS,
        ]);
    }

    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) {
            return $result;
        }

        if ($this->map_port == "") {
            if ($this->console == "vnc") {
                $connPort = 5900;
            } elseif ($this->console == "rdp" || $this->console == "rdp-tls") {
                $connPort = 3389;
            } elseif ($this->console == "ssh") {
                $connPort = 22;
            } elseif ($this->console == "http") {
                $connPort = 80;
            } elseif ($this->console == "https") {
                $connPort = 443;
            } else {
                $connPort = 23;
            }
        } else {
            $connPort = (int) $this->map_port;
        }

        if ($this->map_port_2nd == "") {
            if ($this->console_2nd == "vnc") {
                $connPort2nd = 5900;
            } elseif (
                $this->console_2nd == "rdp" ||
                $this->console_2nd == "rdp-tls"
            ) {
                $connPort2nd = 3389;
            } elseif ($this->console_2nd == "ssh") {
                $connPort2nd = 22;
            } elseif ($this->console_2nd == "http") {
                $connPort2nd = 80;
            } elseif ($this->console_2nd == "https") {
                $connPort2nd = 443;
            } else {
                $connPort2nd = 23;
            }
        } else {
            $connPort2nd = (int) $this->map_port_2nd;
        }

        // Container-exists probe rides the broker's read-only docker_inspect
        // verb (Stage 1; name derived broker-side from the typed session id).
        // A missing container inspects non-zero -> fall through to create.
        $resp = broker_docker_inspect(
            'node', ['node_session' => (int) $this->getSession()],
            '{{ .State.Running }}');
        $rc = (!empty($resp['ok']) && $resp['rc'] == 0) ? 0 : 1;
        error_log(date("M d H:i:s ") . "INFO: inspect docker" .
            $this->getSession() . " via broker rc=" . $rc);
        if ($rc != 0) {
            // Must create the container. The `docker create` command used to be
            // assembled as a free-form ROOT SHELL STRING here and exec()'d; it
            // now rides the broker's typed docker_create verb. The broker
            // ROOT-READS this node's template YAML and builds a validated docker
            // argv ARRAY from it (dangerous capabilities come from the template,
            // never from these params). www-data passes only typed leaf values.

            // Console publish pairs (GUI branch only; the broker ignores them on
            // the network-OS branch). Reproduces the old consoleCmd -p mapping:
            // publish each console whose effective port is not the default 23.
            $publish = [];
            if ($connPort !== 23) {
                $publish[] = ['host' => (int) $this->getPort(), 'guest' => (int) $connPort];
            }
            if ($connPort2nd !== 23) {
                $publish[] = ['host' => (int) $this->getSecondPort(), 'guest' => (int) $connPort2nd];
            }

            // Support dock_args (EVE-NG field for network-OS Docker nodes: XRd,
            // SR Linux, etc.). Its presence selects the broker's network-OS
            // branch and drives the eve_env.txt / firstboot / prep prep-work.
            $dock_args = isset($this->tpl['dock_args']) ? trim($this->tpl['dock_args']) : '';
            $firstboot = false;

            if (!empty($dock_args)) {
                // Generate eve_env.txt so prep scripts (e.g. prep_xrd.sh) know the
                // interface count. The broker resolves the template's
                // --env-file=./eve_env.txt to this file under the node runningPath.
                if (strpos($dock_args, 'env-file') !== false) {
                    $eth_count = count($this->getEthernets());
                    $ifaces = implode(',', array_fill(0, $eth_count, '{}'));
                    file_put_contents(
                        $this->getRunningPath() . '/eve_env.txt',
                        'EVE_ENV={"interfaces":[' . $ifaces . "]}\n"
                    );
                }

                // Bind-mount firstboot.cfg from the Docker addon dir if one exists.
                // Copy it into the node runningPath; the broker adds the -v
                // (symlink-rejected, runningPath-jailed, :ro).
                //
                // The addon file is a single static template shared by every node of
                // this type (e.g. addons/docker/XRD/firstboot.cfg), so a plain copy()
                // left every XRd node with the same generic control-plane hostname --
                // unlike cEOS/SR Linux, IOS XR never adopts the outer container's
                // Linux hostname on its own. Prepend a `hostname <node name>` line (the
                // canvas name, already sanitized into $this->name) so day-0 config
                // seeds the SAME identity the container's `-h` already gets.
                $tplName = isset($this->tpl['name']) ? $this->tpl['name'] : '';
                $addonFirstboot = '/opt/unetlab/addons/docker/' . $tplName . '/firstboot.cfg';
                if (!empty($tplName) && file_exists($addonFirstboot)) {
                    $cfg = file_get_contents($addonFirstboot);
                    $hostname = trim(preg_replace('/[^A-Za-z0-9-]+/', '-', (string) $this->name), '-');
                    if ($hostname !== '' && !preg_match('/^[A-Za-z]/', $hostname)) {
                        $hostname = 'n-' . $hostname;
                    }
                    if ($hostname !== '' && $cfg !== false && !preg_match('/^\s*hostname\s+\S/m', $cfg)) {
                        $cfg = 'hostname ' . substr($hostname, 0, 63) . "\n!\n" . $cfg;
                    }
                    file_put_contents($this->getRunningPath() . '/firstboot.cfg', $cfg);
                    $firstboot = true;
                    error_log(date('M d H:i:s ') . 'INFO: bind-mounting firstboot.cfg from ' . $addonFirstboot);
                }

                // Run prep script if defined in template (www-data config_scripts).
                $prep = isset($this->tpl['prep']) ? trim($this->tpl['prep']) : '';
                if (!empty($prep)) {
                    $prepScript = '/opt/unetlab/config_scripts/' . $prep;
                    if (is_executable($prepScript)) {
                        $prepCmd = $prepScript . ' ' . escapeshellarg($this->getRunningPath()) . ' 2>&1';
                        error_log(date('M d H:i:s ') . 'INFO: running prep script: ' . $prepCmd);
                        exec($prepCmd, $prepOut, $prepRc);
                        if ($prepRc != 0) {
                            error_log(date('M d H:i:s ') . 'WARNING: prep script returned ' . $prepRc . ': ' . implode(' ', $prepOut));
                        }
                    }
                }
            }

            $resp = broker_docker_create([
                'family' => 'docker',
                'session' => (int) $this->getSession(),
                'lab_session' => (int) $this->getLabSession(),
                'template' => (string) $this->getTemplate(),
                'name' => (string) $this->name,
                'image' => (string) $this->image,   // broker strips :<imageid> + RE_IMAGE
                'ram' => (int) $this->ram,
                'cpu' => (int) $this->cpu,
                'publish' => $publish,
                'firstboot' => $firstboot,
            ]);

            if (empty($resp['ok']) || $resp['rc'] != 0) {
                error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80083]);
                error_log(date("M d H:i:s ") . "docker_create: " .
                    (isset($resp['err']) ? $resp['err'] : '') . " " .
                    implode(" ", isset($resp['out']) ? $resp['out'] : []));
                return 80083;
            }
        }

        if (!touch($this->getRunningPath() . "/.prepared")) {
            // Cannot write on directory
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80044]
            );
            return 80044;
        }

        return 0;
    }


    public function start()
    {
        $result = parent::start();
        if ($result != 0) {
            return $result;
        }
        $docker_name = "docker" . $this->getSession();

        // Container start now rides the broker's typed docker_start verb (name
        // derived broker-side from the session id) instead of a root shell string.
        $resp = broker_docker_start($this->getSession());
        error_log(date("M d H:i:s ") . "INFO: starting docker" . $this->getSession());
        $rc = (!empty($resp['ok']) && $resp['rc'] == 0) ? 0 : 1;
        sleep((int) $this->delay);
        if ($rc == 0) {
            // PID read rides the broker's read-only docker_inspect verb
            // (Stage 1). The old code seeded $o and read the pid at $o[1] off
            // exec()'s append behaviour — the broker response replaces that
            // fragile contract: the pid is out[0], read cleanly here.
            $iresp = broker_docker_inspect(
                'node', ['node_session' => (int) $this->getSession()],
                '{{ .State.Pid }}');
            $pid = (!empty($iresp['ok']) && !empty($iresp['out']))
                ? trim($iresp['out'][0]) : '';
            if ($pid === '' || !ctype_digit($pid) || (int) $pid <= 0) {
                error_log(date("M d H:i:s ") . "ERROR: no pid for " .
                    $docker_name . " via broker docker_inspect (" .
                    (isset($iresp['err']) ? $iresp['err'] : '') .
                    ") — interfaces will not wire");
            }

            foreach ($this->getEthernets() as $interface_id => $interface) {
                $vunl = "vunl" . $this->getSession() . "_" . $interface_id;
                $docker = "docker" . $this->getSession() . "_" . $interface_id;

                $cmd = "ip link delete " . $vunl;
                exec($cmd, $o, $rc);

                // Also drop any stale peer half left by an uncleanly-stopped
                // run: if "$docker" still exists the veth re-add below fails
                // ("File exists") and no host-side device is created — the start
                // log then shows 'Cannot find device "vunlX_Y"' and the node
                // interface is left unwired.
                $cmd = "ip link delete " . $docker;
                exec($cmd, $o, $rc);

                $cmd ="ip link add " . $docker ." type veth peer name " .$vunl;
                exec($cmd, $o, $rc);

                $cmd = "ip link set dev " . $vunl . " mtu " . $this->mtu;
                exec($cmd, $o, $rc);

                $cmd = "ip link set dev " . $vunl . " up";
                exec($cmd, $o, $rc);                $network = $this->getNetwork($interface->getNetworkId());

                if (isset($network) && $network->isCloud()) {
                    // Network is a Cloud
                    $net_name = $network->getNType();
                } elseif (
                    $network &&
                    $network->listNetworkTypes() == "internal"
                ) {
                    $net_name = "internal_" . $this->getLabSession();
                    $netName1 = $this->getNetwork(
                        $interface->getNetworkId()
                    )->addSysNetwork();
                } elseif (
                    $network &&
                    $network->listNetworkTypes() == "internal2"
                ) {
                    $net_name = "internal2_" . $this->getLabSession();
                    $netName1 = $this->getNetwork(
                        $interface->getNetworkId()
                    )->addSysNetwork();
                } elseif (
                    $network &&
                    $network->listNetworkTypes() == "internal3"
                ) {
                    $net_name = "internal3_" . $this->getLabSession();
                    $netName1 = $this->getNetwork(
                        $interface->getNetworkId()
                    )->addSysNetwork();
                } elseif (
                    $network &&
                    $network->listNetworkTypes() == "private"
                ) {
                    $net_name = "private_" . $this->getHost();
                    $netName1 = $this->getNetwork(
                        $interface->getNetworkId()
                    )->addSysNetwork();
                } elseif (
                    $network &&
                    $network->listNetworkTypes() == "private2"
                ) {
                    $net_name = "private2_" . $this->getHost();
                    $netName1 = $this->getNetwork(
                        $interface->getNetworkId()
                    )->addSysNetwork();
                } elseif (
                    $network &&
                    $network->listNetworkTypes() == "private3"
                ) {
                    $net_name = "private3_" . $this->getHost();
                    $netName1 = $this->getNetwork(
                        $interface->getNetworkId()
                    )->addSysNetwork();
                } else {
                    $net_name =
                        "vnet" .
                        $this->getLabSession() .
                        "_" .
                        $interface->getNetworkId();
                }

                $cmd = "brctl addif " . $net_name . " " . $vunl . " 2>&1";
                exec($cmd, $o, $rc);
                if ($rc !== 0) {
                    // Surface a failed bridge attach instead of silently
                    // leaving the node unwired (it used to be lost entirely).
                    error_log(date("M d H:i:s ") . "ERROR: brctl addif "
                        . $net_name . " " . $vunl . " rc=" . $rc . " "
                        . implode(" ", $o));
                }

                $vlan = $interface->getVlanId();
                if (
                    $interface->getNetworkId() > 0 &&
                    $network->getsmart() == "1"
                ) {
                    $interface->setvlan($vlan, $interface->getNetworkId());
                    if ($network->getvlan8021ad() == "1") {
                        $interface->setvlan8021ad($interface->getNetworkId());
                    } else {
                        $interface->unsetvlan8021ad($interface->getNetworkId());
                    }
                }
                
                // ip link set netns ${PID} docker3_4_5 name eth0 address 22:ce:e0:99:04:05 up
                $cmd =
                    "ip link set netns " .
                    $pid .
                    " " .
                    $docker .
                    " name eth" .
                    $interface_id .
                    " address " .
                    $this->createNodeMac($interface_id) .
                    " mtu " .
                    $this->mtu .
                    " up";
                error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                exec($cmd, $o, $rc);

                // Re-assert the host side UP as the final step. Bringing it up
                // at creation (above) is not enough: moving the peer into the
                // container netns — or a re-plumb on a rewired/restarted lab —
                // can leave "$vunl" admin-DOWN, which strands the link with no
                // carrier (the node shows its interface up but nothing flows,
                // because a veth has carrier only when BOTH ends are up).
                $cmd = "ip link set dev " . $vunl . " up";
                exec($cmd, $o, $rc);
            }
             // Start configuration process

                

            // Run init script if defined in template (network-OS Docker nodes: XRd, cEOS, SR Linux).
            // Runs after interfaces are wired so the container has its eth* devices available.
            $init = isset($this->tpl['init']) ? trim($this->tpl['init']) : '';
            if (!empty($init)) {
                $initScript = '/opt/unetlab/config_scripts/' . $init;
                if (is_executable($initScript)) {
                    $initCmd = $initScript . ' ' . escapeshellarg($this->getRunningPath()) . ' ' . escapeshellarg('docker'.$this->getSession()) . ' 2>&1';
                    error_log(date('M d H:i:s ') . 'INFO: running init script: ' . $initCmd);
                    exec($initCmd, $initOut, $initRc);
                    if ($initRc != 0) {
                        error_log(date('M d H:i:s ') . 'WARNING: init script returned ' . $initRc . ': ' . implode(' ', $initOut));
                    }
                }
            }

            // Start configuration process. umount rides the broker's fixed
            // docker_exec enum (Stage 3) — no shell string.
            broker_docker_exec($this->getSession(), 'umount_resolv');
            error_log(date("M d H:i:s ") . "umount /etc/resolv.conf via broker docker_exec");

            touch($this->getRunningPath() . "/.lock");
            $configScript =
                $this->config_script != ""
                    ? $this->config_script
                    : (isset($this->tpl["config_script"])
                        ? $this->tpl["config_script"]
                        : "");
            $cmd =
                "nohup /opt/unetlab/config_scripts/" .
                $configScript .
                " -a put -i docker" .
                $this->getSession() .
                " -f " .
                $this->getRunningPath() .
                "/startup-config -t " .
                ($this->delay + 300) .
                " > /dev/null 2>&1 &";
            exec($cmd, $o, $rc);
            error_log(date("M d H:i:s ") . "INFO: importing " . $cmd);

            // Wrapper pushes ride the broker's fixed docker_cp allowlist
            // (Stage 3): shipped root-owned /opt/unetlab/wrappers files only.
            foreach (['wrapper_busybox', 'wrapper_profile', 'wrapper_udhcpc', 'wrapper_bash_static'] as $wf) {
                broker_docker_cp($this->getSession(), $this->getLabSession(), $wf);
                error_log(date("M d H:i:s ") . "importing " . $wf . " via broker docker_cp");
            }

            $cmd =
                "/opt/unetlab/wrappers/nsenter -t " .
                $pid .
                ' -m -u -i -n -p -w /bash-static -c "/busybox ls /bin/bash 2>/dev/null || /busybox ln /bash-static /bin/bash"';
            error_log(
                date("M d H:i:s ") . " linking bash if required  " . $cmd
            );
            exec($cmd, $o, $rc);

            $cmd =
                "/opt/unetlab/wrappers/nsenter -t " .
                $pid .
                " -m -u -i -n -p -w chmod a+x /etc/profile";
            error_log(date("M d H:i:s ") . " setting  " . $cmd);
            exec($cmd, $o, $rc);

            $cmd =
                "/opt/unetlab/wrappers/nsenter -t " .
                $pid .
                " -m -u -i -n -p -w /bash-static /etc/profile";
            error_log(date("M d H:i:s ") . " setting  " . $cmd);
            exec($cmd, $o, $rc);
            $output = exec('ifconfig docker0 | grep "inet "');
            error_log($output);
            if (
                preg_match(
                    "/inet[^0-9]*([0-9]+.[0-9]+.[0-9]+.[0-9]+)/",
                    $output,
                    $match
                )
            ) {
                $docker0 = $match[1];
                $cmd =
                    "/opt/unetlab/wrappers/nsenter -r -m -t " .
                    $pid .
                    " -n /busybox route del default gw " .
                    $docker0;
                exec($cmd, $o, $rc);
                error_log(date("M d H:i:s ") . "INFO: del default gw  " . $cmd);
            }

            if (
                preg_match(
                    "/([0-9]+.[0-9]+.[0-9]+.[0-9]+)\/[0-9]+/",
                    $this->eth1_ip
                )
            ) {
                $cmd =
                    "/opt/unetlab/wrappers/nsenter  -r -m -t " .
                    $pid .
                    " -n /busybox ip a add " .
                    $this->eth1_ip .
                    " dev eth1";
                exec($cmd, $o, $rc);
                error_log(date("M d H:i:s ") . "INFO: importing " . $cmd);
            } elseif ($this->eth1_dhcp) {
                $cmd =
                    "/opt/unetlab/wrappers/nsenter -r -m -t " .
                    $pid .
                    ' -n  /busybox udhcpc NODE="' .
                    $this->name .
                    '" -b -s /udhcpc.script -i eth1';
                // error_log(date('M d H:i:s ') . ' starting  ' . $cmd);
                exec($cmd, $o, $rc);
            }

            if (
                preg_match(
                    "/([0-9]+.[0-9]+.[0-9]+.[0-9]+)\/[0-9]+/",
                    $this->eth2_ip
                )
            ) {
                $cmd =
                    "/opt/unetlab/wrappers/nsenter  -r -m -t " .
                    $pid .
                    " -n /busybox ip a add " .
                    $this->eth2_ip .
                    " dev eth1";
                exec($cmd, $o, $rc);
                // error_log(date('M d H:i:s ') . 'INFO: importing ' . $cmd);
            } elseif ($this->eth2_dhcp) {
                $cmd =
                    "/opt/unetlab/wrappers/nsenter -r -m -t " .
                    $pid .
                    ' -n  /busybox udhcpc NODE="' .
                    $this->name .
                    '" -b -s /udhcpc.script -i eth2';
                //  error_log(date('M d H:i:s ') . ' starting  ' . $cmd);
                exec($cmd, $o, $rc);
            }

            if (
                preg_match(
                    "/([0-9]+.[0-9]+.[0-9]+.[0-9]+)\/[0-9]+/",
                    $this->eth3_ip
                )
            ) {
                $cmd =
                    "/opt/unetlab/wrappers/nsenter  -r -m -t " .
                    $pid .
                    " -n /busybox ip a add " .
                    $this->eth3_ip .
                    " dev eth1";
                exec($cmd, $o, $rc);
                // error_log(date('M d H:i:s ') . 'INFO: importing ' . $cmd);
            } elseif ($this->eth3_dhcp) {
                $cmd =
                    "/opt/unetlab/wrappers/nsenter -r -m -t " .
                    $pid .
                    ' -n  /busybox udhcpc NODE="' .
                    $this->name .
                    '" -b -s /udhcpc.script -i eth3';
                error_log(date("M d H:i:s ") . " starting  " . $cmd);
                exec($cmd, $o, $rc);
            }
            if (preg_match("/([0-9]+.[0-9]+.[0-9]+.[0-9]+)/", $this->DNS)) {
                $cmd =
                    "sudo /opt/unetlab/wrappers/nsenter -r -m -t " .
                    $pid .
                    ' -n /bash-static -c "echo nameserver "' .
                    $this->DNS .
                    '" > /etc/resolv.conf" ';
                exec($cmd, $o, $rc);
                error_log(date("M d H:i:s ") . "INFO: Set Dns Server " . $cmd);
            }

            if (
                preg_match(
                    "/([0-9]+.[0-9]+.[0-9]+.[0-9]+)/",
                    $this->default_route
                )
            ) {
                $cmd =
                    "/opt/unetlab/wrappers/nsenter -r -m -t " .
                    $pid .
                    " -n /busybox route add default gw " .
                    $this->default_route;
                exec($cmd, $o, $rc);
                error_log(date("M d H:i:s ") . "INFO: importing " . $cmd);
            }
            // Use docker_shell from template when defined (e.g. XRd, SR Linux) — write it
            // as a script inside the container so docker_wrapper gets a single clean path.
            $docker_shell = isset($this->tpl['docker_shell']) ? trim($this->tpl['docker_shell']) : '';
            if (!empty($docker_shell)) {
                $shellScript = $this->getRunningPath() . '/node_shell.sh';
                // Wrap in a loop: EVE-NG auto-reconnects when the script exits, PNetLab does not.
                // The loop keeps the docker exec session alive so the telnet port stays open,
                // and re-presents the CLI after the user exits or the system is not yet ready.
                file_put_contents($shellScript, "#!/bin/sh\nwhile true; do\n  " . $docker_shell . "\ndone\n");
                // node_shell.sh push + chmod ride the broker's fixed docker_cp
                // / docker_exec allowlists (Stage 3): the source is broker-
                // resolved under runningPath (symlink-reject + realpath jail),
                // the exec command is the fixed chmod_node_shell enum entry.
                broker_docker_cp($this->getSession(), $this->getLabSession(), 'node_shell');
                broker_docker_exec($this->getSession(), 'chmod_node_shell');
                $attachCmd = '/node_shell.sh';
            } else {
                $attachCmd = "sh";
                // Probe for bash via the broker's fixed ls_bin_bash enum entry.
                $resp = broker_docker_exec($this->getSession(), 'ls_bin_bash');
                error_log(date("M d H:i:s ") . "INFO: probing /bin/bash via broker docker_exec");
                if (!empty($resp['out'])) {
                    $attachCmd = "/bin/bash";
                }
            }

            // Reap any console bridge left over from a previous run of THIS node
            // before launching a fresh one. A stop() now kills the bridge, but a
            // node that was started twice without an intervening engine stop (or an
            // uncleanly-torn-down run) can leave an orphaned listener still bound to
            // the telnet port. Two listeners on one port => the guac console may
            // attach to the stale one, and on a container id change the stale exec
            // errors. Match is anchored to this exact session (see stop() note).
            // ".*" (not an anchored "[0-9]+ ") tolerates the optional --name=<node
            // name> flag now prefixed onto the invocation below -- the name can
            // itself contain spaces, so it can't be matched as a fixed token.
            $reapCmd =
                "sudo pkill -f " .
                escapeshellarg(
                    "docker_console\\.(py|sh) .*docker" .
                        $this->getSession() .
                        " "
                );
            exec($reapCmd, $ro, $rrc);

            // --name threads the canvas node name through to the bridge so it can
            // emit an OSC-0 window-title escape (device_docker.php has no console
            // of its own -- a bare docker-exec PTY has nothing that would ever set
            // a native client's tab/session title otherwise, unlike dynamips/IOL).
            $nameFlag = "--name=" . escapeshellarg($this->name) . " ";

            if ($this->console == "telnet") {
                // docker_wrapper is a licensing stub on this build (prints "Download PNETLab
                // from pnetlab.com", binds nothing). Bridge the telnet console to a PTY docker
                // exec via socat instead (reconnectable; guacd connects here as protocol=telnet).
                $cmd =
                    "sudo /opt/unetlab/wrappers/docker_console.sh " .
                    $nameFlag .
                    $this->getPort() .
                    " docker" .
                    $this->getSession() .
                    " " .
                    $attachCmd .
                    " > " .
                    $this->getRunningPath() .
                    "/wrapper.txt 2>&1 &";
                exec($cmd, $o, $rc);
                error_log(date("M d H:i:s ") . "INFO: run " . $cmd);
            } elseif ($this->console_2nd == "telnet") {
                $cmd =
                    "sudo /opt/unetlab/wrappers/docker_console.sh " .
                    $nameFlag .
                    $this->getSecondPort() .
                    " docker" .
                    $this->getSession() .
                    " " .
                    $attachCmd .
                    " > " .
                    $this->getRunningPath() .
                    "/wrapper.txt 2>&1 &";
                exec($cmd, $o, $rc);
                error_log(date("M d H:i:s ") . "INFO: run " . $cmd);
            }

            $ethernets = $this->getEthernets();
            $index = 0;
            foreach ($ethernets as $ethernet) {
                $index++;
                if ($index == 1) {
                    continue;
                } // Keep eth0 up for management
                if (count($ethernet->getQuality()) > 0) {
                    $ethernet->applyQuality();
                }
                if ($ethernet->getSuspendStatus() == 1) {
                    $ethernet->applySuspendStatus();
                }
                if ($ethernet->getNetworkId() == 0) {
                    $ethernet->setLinkState("down");
                }
            }
        }

        return 0;
    }

    public function export()
    {
        // Generic config export for GUI-docker nodes. A docker template with a
        // config_script already IMPORTS via `<script> -a put -i docker<session>`
        // (see start() above); the same script's `get` action pulls the node's
        // live config blob back out (config_aaa.py -a get copies /firstboot.cfg
        // from the container — azure/aws/aaa/redteam/telemetry all persist their
        // state there). Mirror device_xrd::export() but over the docker-id
        // contract instead of the telnet console. Plain containers without a
        // config_script keep the historical "export not supported".
        // Network-OS docker nodes are NOT affected: xrd overrides export() in
        // device_xrd, ceos/srlinux extend device with their own export().
        $configScript =
            $this->config_script != ""
                ? $this->config_script
                : (isset($this->tpl["config_script"]) && $this->tpl["config_script"] != ""
                    ? $this->tpl["config_script"]
                    : "");
        $scriptPath = "/opt/unetlab/config_scripts/" . $configScript;
        if ($configScript == "" || !is_executable($scriptPath)) {
            // Unsupported (no config_script to pull a config with)
            error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80061]);
            return 80061;
        }

        // Only a running container has a live config to pull.
        if ($this->getStatus() < 2) {
            error_log(date("M d H:i:s ") . "WARNING: " . $GLOBALS["messages"][80084]);
            return 80084;
        }

        // The config scripts' `get` action requires the destination file to NOT
        // exist, so create a unique temp name and remove the placeholder.
        $tmp = tempnam(sys_get_temp_dir(), "unl_cfg_" . $this->getSession());
        if (is_file($tmp) && !unlink($tmp)) {
            error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80059]);
            return 80059;
        }

        // `get` addresses the container directly (docker cp), same -i docker<session>
        // the import path uses. -t is an overall watchdog, not a delay.
        $cmd =
            $scriptPath .
            " -a get -i docker" . $this->getSession() .
            " -f " . $tmp .
            " -t 120";
        exec($cmd, $o, $rc);
        error_log(date("M d H:i:s ") . "INFO: exporting " . $cmd);
        if ($rc != 0) {
            error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80060]);
            error_log(date("M d H:i:s ") . implode("\n", $o));
            return 80060;
        }

        if (!is_file($tmp)) {
            // The script ran but pulled nothing (node has no config blob).
            error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80062]);
            return 80062;
        }

        // Save the pulled config into the lab (same chain as device_qemu / device_xrd).
        clearstatcache();
        $fp = fopen($tmp, "r");
        if (!isset($fp)) {
            error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80064]);
            return 80064;
        }
        $config_data = fread($fp, filesize($tmp));
        fclose($fp);
        if ($config_data === false || $config_data === "") {
            error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80065]);
            return 80065;
        }

        $activeConfig = $this->getActiveConfig();
        if ($activeConfig == "") {
            $this->config_data = $config_data;
        } else {
            $this->multi_config[$activeConfig] = $config_data;
        }

        if (!unlink($tmp)) {
            error_log(date("M d H:i:s ") . "WARNING: " . $GLOBALS["messages"][80070]);
        }
        return 0;
    }

    public function wipe()
    {
        // Container removal rides the broker's typed docker_rm verb (name
        // derived broker-side from the session id) instead of a root shell string.
        broker_docker_rm($this->getSession(), true);

        return parent::wipe();
    }
}
