<?php

/**
 *
 * @author LIN
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 *
 */

require_once "/opt/unetlab/html/devices/dynamips/adapters/adapter.php";

class device_dynamips extends device
{
    function __construct($node)
    {
        parent::__construct($node);
    }

    public function createModule($slot, $subSlot, $nm)
    {
        $nm = preg_replace("/[^\-\_\w]/", "", $nm);
        $nm = str_replace("-", "_", strtolower($nm));

        if (
            is_file(
                "/opt/unetlab/html/devices/dynamips/adapters/" . $nm . ".php"
            )
        ) {
            require_once "/opt/unetlab/html/devices/dynamips/adapters/" .
                $nm .
                ".php";
            $nmid = $slot . "/" . $subSlot;
            $this->modules[$nmid] = new $nm($this, $slot, $subSlot);
        }
    }

    public function editParams($p)
    {
        if (isset($p["dynamips_options"])) {
            $this->dynamips_options = (string) $p["dynamips_options"];
        }
        if (isset($p["Initial_startup_config"])) {
            $this->Initial_startup_config =
                (string) $p["Initial_startup_config"];
        }
        if (isset($p["serial"])) {
            $this->serial = (string) $p["serial"];
        }
        if (isset($p["idlepc"])) {
            $this->idlepc = $p["idlepc"] != "" ? $p["idlepc"] : "0x0";
        }
        if (isset($p["ethernet"]) && $this->ethernet !== (int) $p["ethernet"]) {
            $this->ethernet = (int) $p["ethernet"];
            $this->createEthernets($this->ethernet);
        }
        if (isset($p["serial"]) && $this->serial !== (int) $p["serial"]) {
            $this->serial = (int) $p["serial"];
            $this->createSerials($this->serial);
        }
        if (isset($p["nvram"])) {
            $this->nvram = $p["nvram"] != "" ? (int) $p["nvram"] : 1024;
        }

        parent::editParams($p);
    }

    public function getParams()
    {
        $params = parent::getParams();

        return array_replace($params, [
            "dynamips_options" => $this->dynamips_options,
            "Initial_startup_config" => $this->Initial_startup_config,
            "ethernet" => (int) $this->ethernet,
            "serial" => (int) $this->serial,
            "idlepc" => (int) $this->idlepc,
            "nvram" => (int) $this->nvram,
        ]);
    }

    public function command()
    {
        $cmd = "dynamips -T " . $this->getPort() . " ";
        $cmd .= isset($this->dynamips_options) ? $this->dynamips_options : "";
        $cmd .= " -l dynamips.txt"; // Set logging file
        $cmd .= ' -N "' . $this->name . '"'; // Set logging file
        $cmd .= " --idle-pc " . $this->idlepc; // Set the idle PC
        $cmd .= " -i " . $this->getSession(); // Set instance ID
        $cmd .= " -r " . $this->ram; // Set the virtual RAM size
        $cmd .= " -n " . $this->nvram; // Set the NVRAM size
        $cmd .= " " . $this->getFlag(); // Adding Ethernet flags

        if ($this->config == "1") {
            $cmd .= " -C startup-config";
            $cmd .=
                " /opt/unetlab/addons/dynamips/" .
                $this->image .
                " > " .
                $this->getRunningPath() .
                "/wrapper.txt";
        } elseif (
            !is_file($this->getRunningPath() . "/dynamips.txt") &&
            !is_file(
                "/opt/unetlab/startup_configs/dynamips/ios_base_startup-config.txt"
            )
        ) {
            $cmd .=
                " /opt/unetlab/addons/dynamips/" .
                $this->image .
                " > " .
                $this->getRunningPath() .
                "/wrapper.txt";
        } elseif (
            !is_file($this->getRunningPath() . "/dynamips.txt") &&
            $this->Initial_startup_config == 1
        ) {
            copy(
                "/opt/unetlab/startup_configs/dynamips/ios_base_startup-config.txt",
                $this->getRunningPath() . "/ios_base_startup-config.txt"
            );
            $startup_vios =
                $this->getRunningPath() . "/ios_base_startup-config.txt";
            $file_contents = file_get_contents($startup_vios);
            $file_contents = str_replace(
                "hostname",
                "hostname  $this->name  ",
                $file_contents
            );
            file_put_contents(
                $this->getRunningPath() . "/ios_base_startup-config.txt",
                $file_contents
            );
            copy(
                $this->getRunningPath() . "/ios_base_startup-config.txt",
                $this->getRunningPath() . "/ios_final_startup-config.txt"
            );
            unlink($this->getRunningPath() . "/ios_base_startup-config.txt");
            $cmd .= " -C ios_final_startup-config.txt";
            $cmd .=
                " /opt/unetlab/addons/dynamips/" .
                $this->image .
                " > " .
                $this->getRunningPath() .
                "/wrapper.txt";
        } else {
            $cmd .=
                " /opt/unetlab/addons/dynamips/" .
                $this->image .
                " > " .
                $this->getRunningPath() .
                "/wrapper.txt";
        }

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
        $serials = $this->getSerials();
        foreach ($serials as $serial) {
            $socketFile = $serial->getSocketFile();

            if (
                isset($socketFile) &&
                $socketFile != "" &&
                file_exists($socketFile)
            ) {
                unlink($socketFile);
            }
        }

        if (!is_dir("/tmp/dynamips")) {
            mkdir("/tmp/dynamips");
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
        sleep((int) $this->delay);
        return parent::start();
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

        foreach (scandir($this->getRunningPath()) as $filename) {
            if (preg_match('/_nvram$/', $filename)) {
                $nvram = $this->getRunningPath() . "/" . $filename;
                break;
            } elseif (preg_match('/_rom$/', $filename)) {
                $nvram = $this->getRunningPath() . "/" . $filename;
                break;
            }
        }

        if (!isset($nvram) || !is_file($nvram)) {
            // NVRAM file not found
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80066]
            );
            return 80066;
        }
        $cmd =
            "/opt/unetlab/config_scripts/wrconf_dyn.py -p " .
            $this->getPort() .
            " -t 30";
        secureCmd($cmd);
        exec($cmd, $o, $rc);
        error_log(
            date("M d H:i:s ") . "INFO: force write configuration " . $cmd
        );
        if ($rc != 0) {
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80060]
            );
            error_log(date("M d H:i:s ") . implode("\n", $o));
            return 80060;
        }
        $cmd = "nvram_export " . $nvram . " " . $tmp;
        exec($cmd, $o, $rc);
        error_log(date("M d H:i:s ") . "INFO: exporting " . $cmd);
        if ($rc != 0) {
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80060]
            );
            error_log(date("M d H:i:s ") . implode("\n", $o));
            return 80060;
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
