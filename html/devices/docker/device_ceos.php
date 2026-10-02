<?php

/**
 *
 * @author LIN
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 *
 */

class device_ceos extends device
{
    public function createEthernets($quantity)
    {
        $ethernets = [];
        for ($i = 0; $i < $quantity; $i++) {
            if (!isset($this->ethernets[$i])) {
                if ($i == 0) {
                    $n = "Mgmt/eth0";
                } else {
                    $n = "et" . $i;
                }
                // Interface name
                try {
                    $ethernets[$i] = new Interfc(
                        $this,
                        ["name" => $n, "type" => "ethernet"],
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
        // SECURITY (2026-07-12): docker_options is sourced ONLY from the trusted
        // template YAML ($this->tpl) — see device_docker.php::editParams() for the
        // full rationale. Never read it from $p (API payload) or persisted state.

        if (isset($p["console"])) {
            $this->console = (string) $p["console"];
        }
        if (isset($p["ETBA"])) {
            // SECURITY (docker-rebroker stage 0): ETBA is spliced UNESCAPED into the
            // root-run `docker create ... systemd.setenv=ETBA=<x>` command at
            // start(), so reject anything outside a safe charset (fail closed).
            if (preg_match('/^[A-Za-z0-9_.-]+$/', (string) $p["ETBA"])) {
                $this->ETBA = (string) $p["ETBA"];
            }
        }
        if (isset($p["EOS_PLATFORM"])) {
            // SECURITY (docker-rebroker stage 0): same as ETBA — reaches the root-run
            // `systemd.setenv=EOS_PLATFORM=<x>` shell string unescaped.
            if (preg_match('/^[A-Za-z0-9_.-]+$/', (string) $p["EOS_PLATFORM"])) {
                $this->EOS_PLATFORM = (string) $p["EOS_PLATFORM"];
            }
        }

        if (isset($p["eth0_dhcp"])) {
            $this->eth0_dhcp = (int) $p["eth0_dhcp"];
        }
        if (isset($p["eth0_ip"])) {
            $this->eth0_ip = (string) $p["eth0_ip"];
        }
        if (isset($p["console_2nd"])) {
            $this->console_2nd = (string) $p["console_2nd"];
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
            // never user/.unl state (see editParams()).
            "docker_options" => isset($this->tpl["docker_options"]) ? (string) $this->tpl["docker_options"] : "",
            "console" => $this->console,
            "console_2nd" => $this->console_2nd,
            "ETBA" => $this->ETBA,
            "EOS_PLATFORM" => $this->EOS_PLATFORM,
            "eth0_dhcp" => $this->eth0_dhcp,
            "eth0_ip" => $this->eth0_ip,
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
            if ($this->console == "ssh") {
                $connPort = 22;
            } else {
                $connPort = 23;
            }
        } else {
            $connPort = (int) $this->map_port;
        }
        if ($this->map_port_2nd == "") {
            if ($this->console_2nd == "ssh") {
                $connPort2nd = 22;
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
            // Must create the container. The cEOS `docker create` string (fixed
            // env + --net=none --privileged + the /sbin/init systemd.setenv
            // entrypoint) is now a ROOT-authored broker profile (family=ceos).
            // www-data passes only the charset-validated ETBA / EOS_PLATFORM
            // leaf values and typed console publish ports.

            // Console publish pairs (reproduces the old consoleCmd -p mapping).
            $publish = [];
            if ($connPort !== 23) {
                $publish[] = ['host' => (int) $this->getPort(), 'guest' => (int) $connPort];
            }
            if ($connPort2nd !== 23) {
                $publish[] = ['host' => (int) $this->getSecondPort(), 'guest' => (int) $connPort2nd];
            }

            $resp = broker_docker_create([
                'family' => 'ceos',
                'session' => (int) $this->getSession(),
                'lab_session' => (int) $this->getLabSession(),
                'template' => (string) $this->getTemplate(),
                'name' => (string) $this->name,
                'image' => (string) $this->image,   // broker strips :<imageid> + RE_IMAGE
                'etba' => (string) $this->ETBA,
                'eos_platform' => (string) $this->EOS_PLATFORM,
                'publish' => $publish,
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
        // Container start rides the broker's typed docker_start verb.
        $resp = broker_docker_start($this->getSession());
        error_log(date("M d H:i:s ") . "INFO: starting docker" . $this->getSession());
        $rc = (!empty($resp['ok']) && $resp['rc'] == 0) ? 0 : 1;
        sleep((int) $this->delay);
        if ($rc == 0) {
            // PID read rides the broker's read-only docker_inspect verb
            // (Stage 1) — pid is out[0], no more $o[1] exec-append contract.
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

            if (file_exists($this->getRunningPath() . "/startup-config")) {
                // startup-config push rides the broker's fixed docker_cp
                // allowlist (Stage 3): source broker-resolved under the
                // runningPath jail, dest pinned to /mnt/flash/.
                broker_docker_cp($this->getSession(), $this->getLabSession(), 'ceos_startup');
                error_log(date("M d H:i:s ") . "INFO: importing startup-config via broker docker_cp");
            } elseif (
                !file_exists($this->getRunningPath() . "/initial-config")
            ) {
                copy(
                    "/opt/unetlab/startup_configs/Docker/cEOS/initial-config",
                    $this->getRunningPath() . "/initial-config"
                );
                $startup_ceos = $this->getRunningPath() . "/initial-config";
                $file_contents = file_get_contents($startup_ceos);
                $file_contents = str_replace(
                    "hostname ",
                    "hostname  $this->name  ",
                    $file_contents
                );
                file_put_contents(
                    $this->getRunningPath() . "/initial-config",
                    $file_contents
                );
                // initial-config push rides the broker's fixed docker_cp
                // allowlist (Stage 3), dest pinned to /mnt/flash/startup-config.
                broker_docker_cp($this->getSession(), $this->getLabSession(), 'ceos_initial');
                error_log(date("M d H:i:s ") . "INFO: importing initial-config via broker docker_cp");
            }

            foreach ($this->getEthernets() as $interface_id => $interface) {
                $vunl = "vunl" . $this->getSession() . "_" . $interface_id;
                $ceos = "ceos" . $this->getSession() . "_" . $interface_id;

                $cmd = "ip link delete " . $vunl;
                exec($cmd, $o, $rc);

                // Drop any stale peer half left by an uncleanly-stopped run,
                // else the veth re-add fails ("File exists") and no host-side
                // device is created (start log: 'Cannot find device "vunlX_Y"').
                $cmd = "ip link delete " . $ceos;
                exec($cmd, $o, $rc);

                $cmd =
                    "ip link add " .
                    $ceos .
                    " type veth peer name " .
                    $vunl;
                error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                exec($cmd, $o, $rc);
                $cmd = "ip link set dev " . $vunl . " mtu " . $this->mtu;
                error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                exec($cmd, $o, $rc);

                // cEOS software-forwards over veth; leaving NIC offload on causes
                // bad checksums / oversized segments to be dropped by the peer
                // (classic containerlab issue). Disable host-side offload on the
                // vunl end, belt-and-suspenders alongside the in-netns disable below.
                $cmd = "ethtool --offload " . $vunl . " rx off tx off";
                error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                exec($cmd, $o, $rc);

                $cmd = "ip link set dev " . $vunl . " up";
                error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                exec($cmd, $o, $rc);
                $network = $this->getNetwork($interface->getNetworkId());

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
                error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                exec($cmd, $o, $rc);
                if ($rc !== 0) {
                    error_log(date("M d H:i:s ") . "ERROR: brctl addif "
                        . $net_name . " " . $vunl . " rc=" . $rc . " "
                        . implode(" ", $o));
                }
                if ($interface_id == 0) {
                    $cmd =
                        "ip link set netns " .
                        $pid .
                        " " .
                        $ceos .
                        " name eth0  " .
                        " address " .
                        $this->createNodeMac($interface_id) .
                        " mtu " .
                        $this->mtu .
                        " up";
                    error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                    exec($cmd, $o, $rc);
                } else {
                    $cmd =
                        "ip link set netns " .
                        $pid .
                        " " .
                        $ceos .
                        " name eth" .
                        $interface_id .
                        " address " .
                        $this->createNodeMac($interface_id) .                        
                        " mtu " .
                        $this->mtu .
                        " up";
                    error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                    exec($cmd, $o, $rc);
                }

                // cEOS software-forwards over veth; disable NIC offload inside the
                // container netns (host ethtool via nsenter, no image dependency)
                // to avoid bad checksums / oversized segments dropped by peers.
                $ethname = $interface_id == 0 ? "eth0" : "eth" . $interface_id;
                $cmd =
                    "/opt/unetlab/wrappers/nsenter -t " .
                    $pid .
                    " -n ethtool --offload " .
                    $ethname .
                    " rx off tx off";
                error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                exec($cmd, $o, $rc);

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

                // Re-assert the host side UP as the final step: moving the peer
                // into the container netns (or a re-plumb on a rewired/restarted
                // lab) can leave "$vunl" admin-DOWN, stranding the link with no
                // carrier (a veth has carrier only when BOTH ends are up).
                $cmd = "ip link set dev " . $vunl . " up";
                exec($cmd, $o, $rc);
            }
            // umount + wrapper pushes ride the broker's fixed docker_exec /
            // docker_cp allowlists (Stage 3) — no shell strings.
            broker_docker_exec($this->getSession(), 'umount_resolv');
            error_log(date("M d H:i:s ") . "umount /etc/resolv.conf via broker docker_exec");

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
            error_log(date("M d H:i:s ") . " starting  " . $cmd);
            exec($cmd, $o, $rc);
            $cmd =
                "/opt/unetlab/wrappers/nsenter -t " .
                $pid .
                " -m -u -i -n -p -w bash /etc/profile";
            error_log(date("M d H:i:s ") . " starting  " . $cmd);
            exec($cmd, $o, $rc);

            // Start configuration process

            $cmd = exec("sleep 5");

            //DHCP Settings
            if (
                preg_match(
                    "/([0-9]+.[0-9]+.[0-9]+.[0-9]+)\/[0-9]+/",
                    $this->eth0_ip
                )
            ) {
                $cmd =
                    "/opt/unetlab/wrappers/nsenter  -r -m -t " .
                    $pid .
                    " -n /busybox ip a add " .
                    $this->eth0_ip .
                    " dev eth0";
                exec($cmd, $o, $rc);
                error_log(date("M d H:i:s ") . "INFO: importing " . $cmd);
            } elseif ($this->eth0_dhcp) {
                $cmd =
                    "/opt/unetlab/wrappers/nsenter -r -m -t " .
                    $pid .
                    ' -n  /busybox udhcpc NODE="' .
                    $this->name .
                    '" -b -s /udhcpc.script -i eth0';
                // error_log(date('M d H:i:s ') . ' starting  ' . $cmd);
                exec($cmd, $o, $rc);
            }
            if (preg_match("/([0-9]+.[0-9]+.[0-9]+.[0-9]+)/", $this->DNS)) {
                broker_docker_exec($this->getSession(), 'umount_resolv');
                error_log(date("M d H:i:s ") . "umount /etc/resolv.conf via broker docker_exec");
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
            //error_log(date('M d H:i:s ') . 'INFO: run ' . $cmd);
            unlink($this->getRunningPath() . "/startup-config");
            $attachCmd = "Cli";
            $attachCmd_bash = "bash";
            if ($this->console == "telnet") {
                // docker_wrapper is a licensing stub on this build (prints "Download
                // PNETLab from pnetlab.com", binds nothing) -> the cEOS web console never
                // opened. Bridge to a PTY `docker exec` via docker_console.sh, exactly as
                // device_docker.php does (guacd connects here as protocol=telnet). The
                // attach cmd "Cli" resolves to /usr/bin/Cli once EOS has booted.
                $cmd =
                    "sudo /opt/unetlab/wrappers/docker_console.sh " .
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
                    $this->getSecondPort() .
                    " docker" .
                    $this->getSession() .
                    " " .
                    $attachCmd .
                    " > " .
                    $this->getRunningPath() .
                    "/wrapper1.txt 2>&1 &";
                exec($cmd, $o, $rc);
                error_log(date("M d H:i:s ") . "INFO: run " . $cmd);
            }
            if ($this->console == "bash") {
                $cmd =
                    "sudo /opt/unetlab/wrappers/docker_console.sh " .
                    $this->getPort() .
                    " docker" .
                    $this->getSession() .
                    " " .
                    $attachCmd_bash .
                    " > " .
                    $this->getRunningPath() .
                    "/wrapper.txt 2>&1 &";
                exec($cmd, $o, $rc);
                error_log(date("M d H:i:s ") . "INFO: run " . $cmd);
            } elseif ($this->console_2nd == "bash") {
                $cmd =
                    "sudo /opt/unetlab/wrappers/docker_console.sh " .
                    $this->getSecondPort() .
                    " docker" .
                    $this->getSession() .
                    " " .
                    $attachCmd_bash .
                    " > " .
                    $this->getRunningPath() .
                    "/wrapper1.txt 2>&1 &";
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
        // Config out-copy rides the broker's fixed docker_cp allowlist
        // (Stage 3): src pinned to <ctr>:/mnt/flash/startup-config, dest
        // broker-resolved to <runningPath>/export-config (jailed).
        broker_docker_cp($this->getSession(), $this->getLabSession(), 'ceos_export');

        $tmp = $this->getRunningPath() . "/export-config";

        // Now save the config file within the lab
        clearstatcache();

        $fp = fopen($tmp, "r");
        if (!isset($fp)) {
            // Cannot open file
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80064]
            );
            return 80064;
        }

        $config_data = fread($fp, filesize($tmp));
        if ($config_data === false || $config_data === "") {
            // Cannot read file
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80065]
            );
            return 80065;
        }

        $activeConfig = $this->getActiveConfig();
        if ($activeConfig == "") {
            $this->config_data = $config_data;
        } else {
            $this->multi_config[$activeConfig] = $config_data;
        }

        if (!unlink($tmp)) {
            // Failed to remove tmp file
            error_log(
                date("M d H:i:s ") . "WARNING: " . $GLOBALS["messages"][80070]
            );
        }
        return 0;
    }

    public function wipe()
    {
        // Container removal rides the broker's typed docker_rm verb. The old
        // cEOS rm had no --force; preserve that (force=false).
        broker_docker_rm($this->getSession(), false);

        return parent::wipe();
    }
}
