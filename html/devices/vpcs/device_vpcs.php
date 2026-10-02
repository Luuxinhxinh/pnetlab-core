<?php

/**
 *
 * @author LIN
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 *
 */

class device_vpcs extends device
{
    public function createEthernets($quantity)
    {
        $ethernets = [];
        for ($i = 0; $i < $quantity; $i++) {
            $flag = " -e -d vunl" . $this->getSession() . "_" . $i;
            if (!isset($this->ethernets[$i])) {
                $n = "eth" . $i; // Interface name
                try {
                    $ethernets[$i] = new Interfc(
                        $this,
                        [
                            "name" => $n,
                            "type" => "ethernet",
                            "flag" => $flag,
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
                    return false;
                }
            } else {
                $ethernets[$i] = $this->ethernets[$i];
            }

            // Setting CMD flags (virtual device and map to TAP device)
        }
        $this->ethernets = $ethernets;
        return $this->ethernets;
    }

    public function command()
    {
        $cmd =
            "/opt/vpcsu/bin/vpcs -m " .
            $this->getSession() .
            " -N " .
            $this->name;
        $flags = " -i 1 -p " . $this->getPort();
        $flags .= " " . $this->getFlag();
        $cmd .= $flags . " > " . $this->getRunningPath() . "/wrapper.txt";

        return $cmd;
    }

    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) {
            return $result;
        }

        if (!checkUsername($this->getSession())) {
            error_log(
                date("M d H:i:s ") .
                    date("M d H:i:s ") .
                    "ERROR: " .
                    $GLOBALS["messages"][14]
            );
            return 14;
        }

        $user = "unl" . $this->getSession();

        foreach ($this->getEthernets() as $interface_id => $interface) {
            $tap_name = "vunl" . $this->getSession() . "_" . $interface_id;
            $network = $this->getNetwork($interface->getNetworkId());
            if ($network && $network->isCloud()) {
                // Network is a Cloud
                $net_name = $network->getNType();
            } elseif ($network && $network->listNetworkTypes() == "internal") {
                $net_name = "internal_" . $this->getLabSession();
            } elseif ($network && $network->listNetworkTypes() == "internal2") {
                $net_name = "internal2_" . $this->getLabSession();
            } elseif ($network && $network->listNetworkTypes() == "internal3") {
                $net_name = "internal3_" . $this->getLabSession();
            } elseif ($network && $network->listNetworkTypes() == "private") {
                $net_name = "private_" . $this->getHost();
            } elseif ($network && $network->listNetworkTypes() == "private2") {
                $net_name = "private2_" . $this->getHost();
            } elseif ($network && $network->listNetworkTypes() == "private3") {
                $net_name = "private3_" . $this->getHost();
            } else {
                $net_name =
                    "vnet" .
                    $this->getLabSession() .
                    "_" .
                    $interface->getNetworkId();
            }

            // Remove interface
            $rc = delTap($tap_name);
            if ($rc !== 0) {
                // Failed to delete TAP interface
                return $rc;
            }

            // Add interface
            $rc = addTap($tap_name, $user, $this->mtu);
            if ($rc !== 0) {
                // Failed to add TAP interface
                return $rc;
            }

            if ($interface->getNetworkId() !== 0) {
                // Connect interface to network
                $rc = connectInterface($net_name, $tap_name);
                if ($rc !== 0) {
                    // Failed to connect interface to network
                    return $rc;
                }
            }
            $vlan = $interface->getVlanId();
            if ($interface->getNetworkId() > 0 && $network->getsmart() == "1") {
                $interface->setvlan($vlan, $interface->getNetworkId());
                if ($network->getvlan8021ad() == "1") {
                    $interface->setvlan8021ad($interface->getNetworkId());
                } else {
                    $interface->unsetvlan8021ad($interface->getNetworkId());
                }
            }
        }

        $startupVpc = $this->getRunningPath() . "/startup.vpc";

        // The per-node tmp dir is world-writable (0777) so another unprivileged
        // unl<session> account could plant a symlink named startup.vpc; refuse
        // to write/chown through it as root rather than following it.
        if (is_link($startupVpc)) {
            unlink($startupVpc);
        }

        if (is_file($this->getRunningPath() . "/startup-config")) {
            copy(
                $this->getRunningPath() . "/startup-config",
                $startupVpc
            );
        } elseif (!is_file($startupVpc)) {
            $file_contents = "set pcnam " . $this->name;
            file_put_contents(
                $startupVpc,
                $file_contents
            );
        }

        // netprobe (the vpcs replacement) drops privileges to the per-session
        // unl<session> account and refuses to load/save a startup.vpc it does
        // not own (config_load() rejects st_uid != geteuid()). This file is
        // written above as root, so without this chown netprobe treats every
        // fresh node's config as unreadable and permanently refuses `save`.
        if (is_file($startupVpc) && !is_link($startupVpc)) {
            chown($startupVpc, "unl" . $this->getSession());
        }

        if (!touch($this->getRunningPath() . "/.prepared")) {
            // Cannot write on directory
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80044]
            );
            return 80044;
        }
    }

    public function export()
    {
        $tmp = tempnam(sys_get_temp_dir(), "unl_cfg_" . $this->getSession());

        if (is_file($tmp) && !unlink($tmp)) {
            // Cannot delete tmp file
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80059]
            );
            return 80059;
        }

        if (!is_file($this->getRunningPath() . "/startup.vpc")) {
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80062]
            );
        } else {
            copy($this->getRunningPath() . "/startup.vpc", $tmp);
        }

        if (!is_file($tmp)) {
            // File not found
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80062]
            );
            return 80062;
        }

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
}
