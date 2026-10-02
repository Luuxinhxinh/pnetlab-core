<?php

/**
 * device_xrd.php — Cisco XRd (IOS XR control-plane container) device handler.
 *
 * XRd is a Docker node, so it inherits the entire docker lifecycle from device_docker
 * (createEthernets / prepare / start, including the day-0 config IMPORT which device_docker
 * already drives via the template's config_script: `config_xrd.py -a put -i docker<session>`).
 *
 * The ONLY thing device_docker can't do for XRd is config EXPORT: device_docker::export() is a
 * stub that returns 80061 ("export not supported"), because a generic container has no single
 * config file to copy out. IOS XR config has to be scraped from the running CLI — which is exactly
 * what config_xrd.py's `get` action does (telnet to the bridged console port, login, `show
 * running-config`). So this handler overrides export() to run that script, mirroring
 * device_qemu::export() (the console-scrape export path) but using the docker console port.
 *
 * __node.php requires device_docker.php (device_<type>.php) before this template handler, so the
 * parent class is always loaded for docker nodes — no explicit require needed here.
 *
 * @author pnetlab-noble xrd-config-export
 * @link https://www.pnetlab.com/
 */

class device_xrd extends device_docker
{
    public function export()
    {
        // config_xrd.py -a get REQUIRES the destination file to NOT exist, so create a unique
        // temp name and remove the placeholder file before handing the path to the script.
        $tmp = tempnam(sys_get_temp_dir(), "unl_cfg_" . $this->getSession());
        if (is_file($tmp) && !unlink($tmp)) {
            error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80059]);
            return 80059;
        }

        // Only a running node has a CLI to scrape.
        if ($this->getStatus() < 2) {
            error_log(date("M d H:i:s ") . "WARNING: " . $GLOBALS["messages"][80084]);
            return 80084;
        }

        // Per-node override, else the template's config_script, else the XRd default.
        $configScript =
            $this->config_script != ""
                ? $this->config_script
                : (isset($this->tpl["config_script"]) && $this->tpl["config_script"] != ""
                    ? $this->tpl["config_script"]
                    : "config_xrd.py");

        // IOS XR "show running-config" can be slow right after boot; give it room. The script's
        // -t is an overall watchdog, so a generous value only bounds a hung run, it doesn't delay
        // a healthy export.
        $timeout = 120;

        // get over the telnet console: device_docker bridges the container console to getPort()
        // via docker_console.sh, and config_xrd.py telnets to 127.0.0.1:<port>.
        $cmd =
            "/opt/unetlab/config_scripts/" . $configScript .
            " -a get -p " . $this->getPort() .
            " -f " . $tmp .
            " -t " . $timeout;
        exec($cmd, $o, $rc);
        error_log(date("M d H:i:s ") . "INFO: exporting " . $cmd);
        if ($rc != 0) {
            error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80060]);
            error_log(date("M d H:i:s ") . implode("\n", $o));
            return 80060;
        }

        if (!is_file($tmp)) {
            error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80062]);
            return 80062;
        }

        // Save the scraped config into the lab (same chain as device_qemu / device_ceos).
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
}
