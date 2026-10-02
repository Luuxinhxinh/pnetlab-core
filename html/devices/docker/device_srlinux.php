<?php

/**
 *
 * @author LIN
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 *
 */

class device_srlinux extends device
{
    public function createEthernets($quantity)
    {
        $ethernets = [];
        for ($i = 0; $i < $quantity; $i++) {
            if (!isset($this->ethernets[$i])) {
                if ($i == 0) {
                    $n = "Mgmt"; // Interface name
                } else {
                    $n = "ethernet-1/" . $i; // Interface name
                }
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

        if (isset($p["console_2nd"])) {
            $this->console_2nd = (string) $p["console_2nd"];
        }

        if (isset($p["Card_Type"])) {
            // SECURITY (docker-rebroker stage 0): Card_Type is spliced into filesystem
            // paths (srlinux_topology/<Card_Type>.yml, running-path copy) AND into the
            // root-run `docker create --mount source=.../<Card_Type>.yml` string at
            // start(). Allowlist WITHOUT slash/dot closes both the path traversal and
            // the --mount injection; fail closed on a bad match.
            if (preg_match('/^[A-Za-z0-9_-]+$/', (string) $p["Card_Type"])) {
                $this->Card_Type = (string) $p["Card_Type"];
            }
        }
        if (isset($p["SR_license"])) {
            $this->SR_license = (int) $p["SR_license"];
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
            "Card_Type" => $this->Card_Type,
            "SR_license" => $this->SR_license,
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
            // Must create the container. The SR Linux `docker create` string
            // (startup-config + card-topology binds, the six fixed sysctls,
            // --net=none -u 0:0, optional license -v, sr_linux entrypoint) is now
            // a ROOT-authored broker profile (family=srlinux). www-data does the
            // file prep in its own runningPath and passes only typed leaf values.

            // Console publish pairs (reproduces the old consoleCmd -p mapping).
            $publish = [];
            if ($connPort !== 23) {
                $publish[] = ['host' => (int) $this->getPort(), 'guest' => (int) $connPort];
            }
            if ($connPort2nd !== 23) {
                $publish[] = ['host' => (int) $this->getSecondPort(), 'guest' => (int) $connPort2nd];
            }

            $has_startup = false;
            if (file_exists($this->getRunningPath() . "/startup-config")) {
                $file = $this->getRunningPath() . "/startup-config";
                $fileContent = file_get_contents($file);
                file_put_contents(
                    $file,
                    "enter candidate" . "\n" . $fileContent
                );
                $has_startup = true;
            }
            if (isset($this->Card_Type)) {
                if (
                    file_exists(
                        "/opt/unetlab/html/devices/docker/srlinux_topology/" .
                            $this->Card_Type .
                            ".yml"
                    )
                ) {
                    copy(
                        "/opt/unetlab/html/devices/docker/srlinux_topology/" .
                            $this->Card_Type .
                            ".yml",
                        $this->getRunningPath() .
                            "/" .
                            $this->Card_Type .
                            ".yml"
                    );
                    $TYPE =
                        $this->getRunningPath() .
                        "/" .
                        $this->Card_Type .
                        ".yml";
                    $MAC = $this->createNodeMac(0);
                    $file_contents = file_get_contents($TYPE);
                    file_put_contents(
                        $TYPE,
                        preg_replace("{{{ .MAC }}}", $MAC, $file_contents)
                    );
                }
            }

            $resp = broker_docker_create([
                'family' => 'srlinux',
                'session' => (int) $this->getSession(),
                'lab_session' => (int) $this->getLabSession(),
                'template' => (string) $this->getTemplate(),
                'name' => (string) $this->name,
                'image' => (string) $this->image,   // broker strips :<imageid> + RE_IMAGE
                'card_type' => (string) $this->Card_Type,
                'clab_intfs' => (int) ($this->ethernet + 1),
                'sr_license' => ($this->SR_license == 1) ? 1 : 0,
                'has_startup' => $has_startup,
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
        $cmd = "sudo ethtool --offload docker0 tx off";
        error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
        exec($cmd, $o, $rc);
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

            foreach ($this->getEthernets() as $interface_id => $interface) {
                $vunl = "vunl" . $this->getSession() . "_" . $interface_id;
                $sr_linux =
                    "srlinux" . $this->getSession() . "_" . $interface_id;

                $cmd = "ip link delete " . $vunl;
                exec($cmd, $o, $rc);

                // Drop any stale peer half left by an uncleanly-stopped run,
                // else the veth re-add fails ("File exists") and no host-side
                // device is created (start log: 'Cannot find device "vunlX_Y"').
                $cmd = "ip link delete " . $sr_linux;
                exec($cmd, $o, $rc);

                $cmd =
                    "ip link add " .
                    $sr_linux .
                    " type veth peer name " .
                    $vunl;
                error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                exec($cmd, $o, $rc);
                $cmd = "ip link set dev " . $vunl . " mtu " . $this->mtu;
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
                        $sr_linux .
                        " name docker0 address " .
                        $this->createNodeMac($interface_id) .
                        "  mtu " .
                        $this->mtu .
                        " up";
                    error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                    exec($cmd, $o, $rc);
                } else {
                    $cmd =
                        "ip link set netns " .
                        $pid .
                        " " .
                        $sr_linux .
                        " name e1-" .
                        $interface_id .
                        " address " .
                        $this->createNodeMac($interface_id) .
                        " mtu " .
                        $this->mtu .
                        " up";
                    error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
                    exec($cmd, $o, $rc);
                }
                // ethtool offload execs ride the broker's fixed docker_exec
                // enum (Stage 3); e1-<id> is parameterised on the typed int only.
                broker_docker_exec($this->getSession(), 'ethtool_offload_docker0');
                broker_docker_exec($this->getSession(), 'ethtool_offload_e1', [
                    'interface_id' => (int) $interface_id,
                ]);

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
            foreach (['wrapper_bash_static', 'wrapper_busybox', 'wrapper_profile'] as $wf) {
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
                "sudo /opt/unetlab/wrappers/nsenter -t " .
                $pid .
                ' -m -u -i -n -p -w bash -c "/profile.sh"';
            error_log(date("M d H:i:s ") . " starting  " . $cmd);
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

            // Start configuration process. Shipped SR Linux templates provide a
            // readiness-aware docker_shell; keep the listener alive and re-present it after
            // the user exits, matching the generic Docker console contract.
            $docker_shell = isset($this->tpl["docker_shell"])
                ? trim($this->tpl["docker_shell"])
                : "";
            if ($docker_shell !== "") {
                $shellScript = $this->getRunningPath() . "/node_shell.sh";
                file_put_contents(
                    $shellScript,
                    "#!/bin/sh\nwhile true; do\n  " . $docker_shell . "\ndone\n"
                );
                broker_docker_cp(
                    $this->getSession(),
                    $this->getLabSession(),
                    "node_shell"
                );
                broker_docker_exec($this->getSession(), "chmod_node_shell");
                $attachCmd = "/node_shell.sh";
            } else {
                $attachCmd = "sr_cli";
            }
            $attachCmd_bash = "bash";

            // Normal stop() reaps this bridge; also remove an orphan from an unclean or
            // duplicate start. The trailing space anchors the exact docker session.
            $reapCmd =
                "sudo pkill -f " .
                escapeshellarg(
                    "docker_console\\.(py|sh) [0-9]+ docker" .
                        $this->getSession() .
                        " "
                );
            exec($reapCmd, $ro, $rrc);

            if ($this->console == "telnet") {
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
                error_log(date("M d H:i:s ") . "INFO: attach sr_cli console " . $cmd);
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
                error_log(date("M d H:i:s ") . "INFO: attach sr_cli console " . $cmd);
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
                error_log(date("M d H:i:s ") . "INFO: attach bash console " . $cmd);
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
                error_log(date("M d H:i:s ") . "INFO: attach bash console " . $cmd);
            }

            if (file_exists($this->getRunningPath() . "/startup-config")) {
                // Startup-config import rides the broker's fixed docker_exec
                // enum (Stage 3). The old shape was `sleep 10 && docker exec`;
                // keep the settle delay PHP-side, the exec broker-side.
                sleep(10);
                broker_docker_exec($this->getSession(), 'sr_cli_source_startup');
                error_log(
                    date("M d H:i:s ") .
                        "INFO: importing startup-config via broker docker_exec"
                );
                unlink($this->getRunningPath() . "/startup-config");
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
        // Config export rides the broker's fixed docker_exec / docker_cp
        // allowlists (Stage 3): sr_cli_export is the exact bash -c shape the
        // driver used; the out-copy dest is broker-jailed under runningPath.
        broker_docker_exec($this->getSession(), 'sr_cli_export');
        broker_docker_cp($this->getSession(), $this->getLabSession(), 'srlinux_export');
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
        // Container removal rides the broker's typed docker_rm verb.
        broker_docker_rm($this->getSession(), true);

        return parent::wipe();
    }
}
