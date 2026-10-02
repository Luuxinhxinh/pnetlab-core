<?php

use Illuminate\Console\Parser;

/**
 *
 * @author LIN
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 *
 */

class device_iol extends device
{
    // IOL uses porgroups, 4 interfaces each portgroup
    // Ethernets before Serials
    // i = x/y -> i = x + y * 16 -> x = i - y * 16 = i % 16

    public function createEthernets($quantity)
    {
        $ethernets = [];
        for ($x = 0; $x < $quantity; $x++) {
            for ($y = 0; $y <= 3; $y++) {
                $i = $x + $y * 16; // Interface ID
                $n = "e" . $x . "/" . $y; // Interface name
                if (!isset($this->ethernets[$i])) {
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
                        return false;
                    }
                } else {
                    $ethernets[$i] = $this->ethernets[$i];
                }
            }
        }
        $this->ethernets = $ethernets;
        return $this->ethernets;
    }

    public function createSerials($quantity)
    {
        $serials = [];
        $ethGroupCount = $this->ethernet;
        for ($x = 0; $x < $quantity; $x++) {
            for ($y = 0; $y <= 3; $y++) {
                $i = $ethGroupCount + $x + $y * 16; // Interface ID
                $n = "s" . ($x + $ethGroupCount) . "/" . $y; // Interface name
                if (!isset($this->serials[$i])) {
                    try {
                        $serials[$i] = new Interfc(
                            $this,
                            ["name" => $n, "type" => "serial"],
                            $i
                        );
                    } catch (Exception $e) {
                        error_log(
                            date("M d H:i:s ") .
                                "ERROR: " .
                                $GLOBALS["messages"][40022]
                        );
                        error_log(date("M d H:i:s ") . (string) $e);
                        return false;
                    }
                } else {
                    $serials[$i] = $this->serials[$i];
                }
            }
        }

        $this->serials = $serials;
        return $this->serials;
    }

    public function editParams($p)
    {
        if (isset($p["iol_options"])) {
            $this->iol_options = (string) $p["iol_options"];
        }
        if (isset($p["keepalive"])) {
            $this->keepalive = (string) $p["keepalive"];
        }
        if (isset($p["Initial_startup_config"])) {
            $this->Initial_startup_config =
                (string) $p["Initial_startup_config"];
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
            "iol_options" => $this->iol_options,
            "keepalive" => $this->keepalive,
            "Initial_startup_config" => $this->Initial_startup_config,
            "ethernet" => (int) $this->ethernet,
            "serial" => (int) $this->serial,
            "nvram" => (int) $this->nvram,
        ]);
    }

    public function command()
    {
        $iol_id = $this->node->getIolId();
        if ($iol_id == null) {
            error_log(
                date("M d H:i:s ") . "ERROR: maximum 512 IOL node foreach user"
            );
            return 12;
        }

        // SECURITY (docker-rebroker stage 0): $this->image is spliced into a
        // filesystem path ("<running-path>/<image>") that the root iol_wrapper opens.
        // It is a single path segment, so validate as a traversal/charset guard
        // (not escapeshellarg) and fail closed on anything containing a slash, '..'
        // or other unexpected character.
        if (!preg_match('/^[A-Za-z0-9._-]+$/', (string) $this->image)) {
            error_log(
                date("M d H:i:s ") .
                    "ERROR: refusing IOL node start: invalid image segment"
            );
            return 12;
        }

        // if($this->isKeepAlive()){
        //     $cmd = '/opt/unetlab/wrappers/iol_wrapper_telnet ';
        // }else{
        //     $cmd = '/opt/unetlab/wrappers/iol_wrapper ';
        // }
        $cmd = "/opt/unetlab/wrappers/iol_wrapper ";
        $cmd .=
            "-D " .
            $iol_id .
            " -S " .
            $this->getSession() .
            " -P " .
            $this->getPort() .
            ' -t "' .
            $this->name .
            '" -F ' .
            $this->node->getRunningPath() .
            "/" .
            $this->image .
            " -d " .
            (int) $this->delay .
            " -e " .
            (int) $this->ethernet .
            " -s " .
            (int) $this->serial;

        foreach ($this->getSerials() as $interface_id => $interface) {
            $remote_id = $interface->getRemoteId();
            if ($remote_id > 0) {
                $remote_node = $this->getNode($remote_id);
                if (!$remote_node) {
                    error_log("ERROR: Can not find node " + $remote_id);
                    return;
                }
                $cmd .=
                    " -l " .
                    $interface_id .
                    ":localhost:" .
                    $remote_node->getIolId() .
                    ":" .
                    $interface->getRemoteIf() .
                    ":" .
                    $remote_node->getPort();
                //   0                :localhost:     2                          :      0                          :          30007
                //   126              :localhost:     2                          :      16                         :          30007
            }
        }

        $flags = " -n " . $this->nvram; // Size of nvram in Kb
        $flags .= " -q"; // Suppress informational messages
        $flags .= " -m " . $this->ram; // Megabytes of router memory

        // PNETLAB-NOBLE: L1 keepalive (-l) makes IOS busy-spin at ~100% CPU on the
        // 6.12 kernel. With -l, the guest's unix_l1_read_l1_input loop never reaches
        // its idle sleep: getrusage's ru_utime is starved (the spin runs in-kernel so
        // cputime_adjust bills it all to stime), so IOS's scheduler thinks no user
        // time elapsed and polls getrusage forever -> one core pegged. Same image +
        // config without -l idles at ~2%. L1 keepalive only adds neighbour link-down
        // detection between directly-wired IOL nodes; force-disabled here regardless
        // of the per-node keepalive setting so old and new labs can't re-enable it.
        // (Was: if ($this->isKeepAlive()) { $flags .= " -l"; })
        if ($this->config == "1") {
            // Config = Exported. device::prepare() already dumped the user's
            // exported config_data to running_path/startup-config -- but "-c"
            // only ever loads RUNNING-config (see pnqBakeNvram() docblock);
            // NVRAM stays empty either way. IOS decides whether to show the
            // "--- System Configuration Dialog ---" setup prompt purely on
            // whether NVRAM/startup-config looks unset -- NOT on whether the
            // supplied config is complete. So a PARTIAL export (e.g. just a
            // hostname) left NVRAM empty and IOS always fell into setup,
            // stalling boot. Fix: merge the exported lines on top of this
            // template's base config (same base used by the no-config path
            // below, which already boots clean) and bake THAT into NVRAM, so
            // IOS always finds a populated startup-config. The base supplies
            // every prerequisite stanza (interfaces, line con/aux, etc.);
            // trailing exported lines are layered after so they win on any
            // overlap (e.g. hostname, interface addressing).
            $baseTemplate = $this->pnqBaseConfigPath();
            $startupCfg = $this->getRunningPath() . "/startup-config";
            if ($baseTemplate !== null && is_file($startupCfg)) {
                $merged = $this->pnqMergeExportedConfig(
                    $baseTemplate,
                    $startupCfg
                );
                if ($merged !== null) {
                    $this->pnqBakeNvram($merged, $iol_id);
                }
            }
            $flags .= " -c startup-config"; // Configuration file name
        } elseif (!file_exists($this->getRunningPath() . "/NETMAP")) {
            if ($this->Initial_startup_config == 1) {
                $baseTemplate = $this->pnqBaseConfigPath();
                $baseName = basename($baseTemplate);
                $startup_iol = $this->getRunningPath() . "/" . $baseName;
                copy($baseTemplate, $startup_iol);
                $file_contents = file_get_contents($startup_iol);
                $file_contents = str_replace(
                    "hostname",
                    "hostname  $this->name  ",
                    $file_contents
                );
                file_put_contents($startup_iol, $file_contents);
                $flags .= " -c " . $baseName;
                $this->pnqBakeNvram($startup_iol, $iol_id);
            }

            // Configuration file name
        }

        $flags .= isset($this->iol_options) ? " " . $this->iol_options : "";

        // PNETLAB-NOBLE: belt-and-suspenders — strip any stray standalone "-l" that
        // slipped in via iol_options (free-form) or a legacy code path, so the L1
        // keepalive flag can never reach the IOL binary. Safe: the wrapper's serial
        // "-l <conn>" connection flag lives in $cmd (before "--"), not in $flags.
        $flags = preg_replace('/(?<=\s)-l(?=\s|$)/', ' ', $flags);

        $cmd .=
            " -- " . $flags . " > " . $this->getRunningPath() . "/wrapper.txt";
        return $cmd;
    }

    /**
     * Pre-write the IOU NVRAM from a base startup-config so a fresh node boots
     * straight to its prompt with NO "initial configuration dialog".
     *
     * The IOU binary's "-c <config>" only loads RUNNING-config (the hostname is
     * applied, but startup-config/nvram stays empty), so IOS still shows the
     * setup dialog at boot. iou_import builds the IOU nvram (0xABCD startup +
     * 0xFEDC private + whole-nvram checksum) from the config text, which IOS
     * reads as the startup-config. nvram_<iol_id> is what the IOU instance reads.
     */
    private function pnqBakeNvram($cfgPath, $iol_id)
    {
        if (!is_file($cfgPath)) {
            return;
        }
        $nvram =
            $this->getRunningPath() .
            "/nvram_" .
            sprintf("%05d", (int) $iol_id);
        $cmd =
            "/opt/unetlab/scripts/iou_import -n " .
            (int) $this->nvram .
            " " .
            escapeshellarg($cfgPath) .
            " " .
            escapeshellarg($nvram) .
            " 2>&1";
        exec($cmd, $o, $rc);
        if ($rc != 0) {
            error_log(
                date("M d H:i:s ") .
                    "WARNING: iou_import failed (" .
                    $rc .
                    "): " .
                    implode(" ", $o)
            );
            return;
        }
        // Running dir is setgid unl; make the nvram group(unl)-writable so the
        // IOU instance (unl<session>) can both read it at boot and rewrite it on
        // "write memory".
        @chmod($nvram, 0664);
        error_log(date("M d H:i:s ") . "INFO: baked nvram " . $nvram);
    }

    /**
     * Which stock base-config template this node's IOL template uses (the
     * same one already applied on the no-config boot path), or null if the
     * template isn't one of the three known IOL flavors.
     */
    private function pnqBaseConfigPath()
    {
        if ($this->getTemplate() == "l3_iol") {
            return "/opt/unetlab/startup_configs/iol/iou_l3_base_startup-config.txt";
        }
        if ($this->getTemplate() == "l2_iol") {
            return "/opt/unetlab/startup_configs/iol/iou_l2_base_startup-config.txt";
        }
        return "/opt/unetlab/startup_configs/iol/iou_startup-config.txt";
    }

    /**
     * Layer an exported startup-config (possibly PARTIAL -- e.g. just a
     * hostname) on top of the stock base template, so booting from the
     * result always gives IOS a fully-populated NVRAM (base supplies every
     * prerequisite stanza: interfaces, line con/aux, etc.) while the user's
     * own lines are appended last so they take precedence on any overlap
     * (hostname, addressing, ACLs the user actually configured).
     *
     * Writes running_path/iou_merged_startup-config.txt and returns its path,
     * or null if the base template is unreadable (caller then leaves NVRAM
     * unbaked -- same as today's behavior, no regression).
     */
    private function pnqMergeExportedConfig($baseTemplatePath, $exportedCfgPath)
    {
        $base = @file_get_contents($baseTemplatePath);
        $exported = @file_get_contents($exportedCfgPath);
        if ($base === false || $exported === false) {
            return null;
        }
        $base = str_replace("hostname", "hostname  $this->name  ", $base);

        // Base always ends in a bare "end" -- drop it so the exported lines
        // land BEFORE the single terminating "end" below (a config with two
        // "end"s just parses as two sequential command sessions in IOS, but
        // keeping one is cleaner and matches the existing base-config style).
        $base = preg_replace('/\bend\s*\z/', '', rtrim($base));

        // Exported text: strip its own leading "!" and trailing "end" (kept
        // by dumpConfig() from the user's export) so it splices in as a plain
        // stanza list.
        $exportedLines = preg_split('/\r\n|\r|\n/', trim($exported));
        $exportedLines = array_filter($exportedLines, function ($line) {
            $t = trim($line);
            return $t !== "" && strcasecmp($t, "end") !== 0;
        });

        $merged = rtrim($base) . "\n!\n" . implode("\n", $exportedLines) .
            "\n!\nend\n";

        $mergedPath = $this->getRunningPath() .
            "/iou_merged_startup-config.txt";
        if (file_put_contents($mergedPath, $merged) === false) {
            return null;
        }
        return $mergedPath;
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
            // $network is null for an unconnected interface (network_id 0) or a
            // stale reference — guard before any method call (method_exists()
            // fatals on null in PHP 8; getNetworkId()>0 alone isn't enough).
            $isDot1q = $network && method_exists($network, 'getNType') && $network->getNType() == "dot1q";
            if ($interface->getNetworkId() > 0 && $network && ($network->getsmart() == "1" || $isDot1q)) {
                // dot1q switch ports use the interface's loaded mode/native/vlans;
                // smart bridges use the single vid. applyVlan() branches on type.
                $interface->setvlan($vlan, $interface->getNetworkId());
                if (!$isDot1q && $network->getvlan8021ad() == "1") {
                    $interface->setvlan8021ad($interface->getNetworkId());
                } elseif (!$isDot1q) {
                    $interface->unsetvlan8021ad($interface->getNetworkId());
                }
            }
        }
        foreach ($this->getSerials() as $interface_id => $interface) {
            $tap_name = "ser" . $this->getSession() . "_" . $interface_id;
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
        }

        if (
            !is_file($this->getRunningPath() . "/.prepared") &&
            !is_file($this->getRunningPath() . "/.lock")
        ) {
            // Node is not prepared/locked
            if (
                !is_dir($this->getRunningPath()) &&
                !mkdir($this->getRunningPath(), 0775, true)
            ) {
                // Cannot create running directory
                error_log(
                    date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80037]
                );
                return 80037;
            }

            if (!is_file("/opt/unetlab/addons/iol/bin/iourc")) {
                // IOL license not found
                error_log(
                    date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80039]
                );
                return 80039;
            }

            if (
                !file_exists($this->getRunningPath() . "/iourc") &&
                !symlink(
                    "/opt/unetlab/addons/iol/bin/iourc",
                    $this->getRunningPath() . "/iourc"
                )
            ) {
                // Cannot link IOL license
                error_log(
                    date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80040]
                );
                return 80040;
            }

            if (file_exists("/opt/unetlab/addons/iol/bin/" . $this->image)) {
                symlink(
                    "/opt/unetlab/addons/iol/bin/" . $this->image,
                    $this->getRunningPath() . "/" . $this->image
                );
            }

            if (file_exists("/opt/unetlab/addons/iol/bin/keepalive.pl")) {
                symlink(
                    "/opt/unetlab/addons/iol/bin/keepalive.pl",
                    $this->getRunningPath() . "/keepalive.pl"
                );
            }
        }

        if (!touch($this->getRunningPath() . "/.prepared")) {
            // Cannot write on directory
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80044]
            );
            return 80044;
        }

        $cmd = "id -u " . $user . " 2>&1";
        exec($cmd, $o, $rc);
        $uid = $o[0];
        if (!posix_setuid($uid)) {
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80036]
            );
            return 80036;
        }

        return 0;
    }


    public function start()
    {
        $result = parent::start();
        if ($this->isKeepAlive()) {
            $interfaces = $this->getInterfaces();
            foreach ($interfaces as $interface) {
                if ($interface->getNType() == "ethernet") {
                    if (
                        $interface->getNetworkId() > 0 &&
                        $interface->getSuspendStatus() != 1
                    ) {
                        usleep(100000); // waiting for device ready
                        $interface->setLinkState("up");
                    }
                } else {
                    // serial link
                    if (
                        $interface->getRemoteId() > 0 &&
                        $interface->getSuspendStatus() != 1
                    ) {
                        usleep(100000); // waiting for device ready
                        $interface->setLinkState("up");
                    }
                }
            }
        }
        /*
         foreach ($this->getSerials() as $interface_id => $interface) { 
        $remote_id = $interface->getRemoteId();
        $remote_node = $this->getNode($remote_id);
        $cmd = 'tc qdisc add dev ser' . $this->getSession() . '_' . $interface_id . 'ingress';
        exec($cmd, $o, $rc);
        $cmd = 'tc filter add dev ser'. $this->getSession() . '_' . $interface_id .' parent ffff: protocol all u32 match u8 0 0 action mirred egress redirect dev ser' .$remote_node->getSession().'_'. $interface->getRemoteIf();
        exec($cmd, $o, $rc);

        }*/
        return $result;
    }

    public function stop()
    {
        // Kill any leftover keepalive helper for this node's session. L1
        // keepalive itself is force-disabled (see command() above, ~line
        // 189-196), so on current labs this normally matches nothing -- kept
        // as a harmless no-op for older labs / stray processes.
        $cmd =
            "ps -aux | grep keepalive | grep vunl" .
            $this->getSession() .
            '_ | grep -v "ps -aux" | tr -s " "| cut -d " " -f 2';
        $o = [];
        exec($cmd, $o, $rc);
        foreach ($o as $pid) {
            exec("sudo kill -9 " . $pid);
            error_log("sudo kill -9 " . $pid);
        }

        // The actual IOL process is iol_wrapper (which forks the real IOL
        // ELF, i86bi_*, as a child) -- NOT the keepalive helper above. Match
        // it by this node's UNIQUE running path, NOT by session id: a
        // session-id substring (e.g. "-S 5") can match another node's
        // session (e.g. "-S 55"), which would kill a co-tenant's node.
        // getRunningPath() is /opt/unetlab/tmp/<tenant>/<lab_id>/<node_id>,
        // globally unique. Anchor the match with a trailing "/" -- exactly
        // as it appears right before the image name in the wrapper's "-F"
        // argument built in command() above -- so a node_id prefix collision
        // (e.g. ".../5" being a substring of ".../55") can't happen.
        $runningPathPattern = $this->getRunningPath() . "/";

        $this->pnqKillIolProcesses($runningPathPattern);

        // Verify the node is actually gone before reporting success. A
        // wrapper (and its forked IOL child) can take a moment to die/reap;
        // poll briefly and escalate the kill rather than trust a single pass.
        $stillAlive = $this->pnqRunningPathIsAlive($runningPathPattern);
        $attempts = 0;
        while ($stillAlive && $attempts < 5) {
            usleep(400000); // 400ms
            $this->pnqKillIolProcesses($runningPathPattern);
            $stillAlive = $this->pnqRunningPathIsAlive($runningPathPattern);
            $attempts++;
        }

        if ($stillAlive) {
            // Node did NOT actually stop -- do not report success.
            error_log(
                date("M d H:i:s ") .
                    "ERROR: IOL process for " .
                    $this->getRunningPath() .
                    " still running after stop attempts"
            );
            return 80035; // Failed to stop the node (80035).
        }

        return parent::stop();
    }

    /**
     * Kill every process (iol_wrapper and any forked IOL child) whose
     * cmdline contains this node's unique running-path pattern. Killing the
     * whole process GROUP takes the forked IOL child with the wrapper even
     * though pgrep -f only matched the wrapper's own cmdline.
     */
    private function pnqIolProcessPattern($runningPathPattern)
    {
        // pgrep -f also sees the shell running this search. Hide the leading
        // slash inside a character class so the regex matches the IOL command
        // line, but the literal path does not occur in the search command.
        return '[/]' . preg_quote(substr($runningPathPattern, 1), '/');
    }

    private function pnqKillIolProcesses($runningPathPattern)
    {
        $cmd =
            "sudo pgrep -f " .
            escapeshellarg($this->pnqIolProcessPattern($runningPathPattern)) .
            " 2>/dev/null";
        $pids = [];
        exec($cmd, $pids, $rc);
        foreach ($pids as $pid) {
            $pid = (int) trim($pid);
            if ($pid <= 0) {
                continue;
            }
            // Kill the whole process group first (wrapper + forked IOL
            // child share it unless the wrapper detached); fall back to
            // killing the pid directly in case it's not a group leader.
            exec("sudo kill -9 -- -" . $pid . " 2>/dev/null");
            exec("sudo kill -9 " . $pid . " 2>/dev/null");
            error_log(
                "sudo kill -9 (iol_wrapper/running-path match) " . $pid
            );
        }
    }

    /**
     * True if any process still has this node's unique running-path pattern
     * in its cmdline (i.e. the wrapper or its IOL child is still alive).
     */
    private function pnqRunningPathIsAlive($runningPathPattern)
    {
        $cmd =
            "sudo pgrep -f " .
            escapeshellarg($this->pnqIolProcessPattern($runningPathPattern)) .
            " 2>/dev/null";
        $pids = [];
        exec($cmd, $pids, $rc);
        return count($pids) > 0;
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

        error_log(date("M d H:i:s ") . "SCAN: " . $this->getRunningPath());
        foreach (scandir($this->getRunningPath()) as $filename) {
            if (preg_match("/nvram_/", $filename)) {
                $nvram = $this->getRunningPath() . "/" . $filename;
                break;
            }
        }

        if (!isset($nvram)) {
            // NVRAM file not found
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80066]
            );
            return 80066;
        }

        $cmd =
            "/opt/unetlab/config_scripts/wrconf_iol.py -p " .
            $this->getPort() .
            " -t 30";
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
        $cmd = "/opt/unetlab/scripts/iou_export " . $nvram . " " . $tmp;
        exec($cmd, $o, $rc);
        usleep(1);
        error_log(date("M d H:i:s ") . "INFO: exporting " . $cmd);
        if ($rc != 0) {
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80060]
            );
            error_log(date("M d H:i:s ") . implode("\n", $o));
            return 80060;
        }
        // Add no shut
        if (is_file($tmp)) {
            file_put_contents(
                $tmp,
                preg_replace(
                    '/(\ninterface.*)/',
                    '$1' . chr(10) . " no shutdown",
                    file_get_contents($tmp)
                )
            );
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

    public function isKeepAlive()
    {
        // if(count($this->getSerials()) > 0) return false;
        return $this->keepalive == 1;
    }

    /** Return ethernet index in ethernets array. Using for create iou2net command */
    public function getEthernetIndex($ifId)
    {
        $index = 0;
        $ethernets = $this->getEthernets();
        foreach ($ethernets as $ethernet) {
            if ($ethernet->getId() == $ifId) {
                return $index;
            }
            $index++;
        }
        return null;
    }

    /** Return ethernet index in all interface array. Using for create iou2net command */
    public function getInterfaceIndex($type, $ifId)
    {
        $index = 0;
        if ($type == "ethernet") {
            $ethernets = $this->getEthernets();
            foreach ($ethernets as $ethernet) {
                if ($ethernet->getId() == $ifId) {
                    return $index;
                }
                $index++;
            }
        } elseif ($type == "serial") {
            $serials = $this->getSerials();
            foreach ($serials as $serial) {
                if ($serial->getId() == $ifId) {
                    return $index;
                }
                $index++;
            }
        }
        return null;
    }
}
