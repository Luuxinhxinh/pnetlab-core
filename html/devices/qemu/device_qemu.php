<?php

/**
 *
 * @author LIN
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 *
 */

class device_qemu extends device
{
    public $qemu_version = "";
    private $qemu_version_explicit = false;

    function __construct($node)
    {
        parent::__construct($node);
    }

    private function resolveQemuRoot($qversion, $optRoot = "/opt")
    {
        $defaultRoot = $optRoot . "/qemu";
        if ($qversion === "") {
            return $defaultRoot;
        }

        $requestedRoot = $optRoot . "/qemu-" . $qversion;
        $defaultReal = realpath($defaultRoot);
        $requestedReal = realpath($requestedRoot);

        // The add-node form records the selected default version even for
        // templates which deliberately have no zoo pin. Keep those nodes on
        // the stable /opt/qemu dispatch path instead of treating the default
        // build as a version-pinned zoo dependency.
        if (
            $defaultReal !== false &&
            $requestedReal !== false &&
            $defaultReal === $requestedReal
        ) {
            return $defaultRoot;
        }

        if (!is_dir($requestedRoot)) {
            error_log(
                date("M d H:i:s ") .
                    "WARNING: qemu_version=" .
                    $qversion .
                    " requested missing " .
                    $requestedRoot .
                    "; falling back to " .
                    $defaultRoot
            );
            return $defaultRoot;
        }

        return $requestedRoot;
    }

    /**
     * Return true only for the dedicated Windows 11 node template.
     *
     * The template slug is persisted in the lab's .unl node record; the image
     * folder prefix is only what lets the Add Node picker select that template.
     * Keep this exact (case-insensitive) match so a generic `win` node, or a
     * future Windows-family template, never inherits the Win11 boot policy.
     */
    private function isWindows11Node()
    {
        return strtolower(trim((string) $this->getTemplate())) === "win11";
    }

    private function isWindows11UefiNode()
    {
        return $this->isWindows11Node() && (string) $this->UEFI === "1";
    }

    /**
     * Resolve a complete OVMF CODE/VARS pair for a Win11 UEFI node.
     *
     * Ubuntu's package has used both the modern 4M names and the older flat
     * names.  Resolve a pair, rather than selecting CODE and VARS separately,
     * so a 4M firmware is never mixed with a legacy VARS image.  The optional
     * roots argument exists only for the focused contract test.
     */
    private function resolveWindows11UefiFirmware($roots = null)
    {
        if (!is_array($roots)) {
            $roots = ["/usr/share/OVMF", "/usr/share/ovmf"];
        }

        $profiles = [
            ["OVMF_CODE_4M.secboot.fd", "OVMF_VARS_4M.ms.fd", "4M Secure Boot", true],
            ["OVMF_CODE_4M.fd", "OVMF_VARS_4M.fd", "4M UEFI", false],
            ["OVMF_CODE.fd", "OVMF_VARS.fd", "legacy UEFI", false],
        ];

        foreach ($profiles as $profile) {
            foreach ($roots as $root) {
                $root = rtrim((string) $root, "/\\");
                if ($root === "") {
                    continue;
                }
                $code = $root . "/" . $profile[0];
                $vars = $root . "/" . $profile[1];
                if (is_file($code) && is_file($vars)) {
                    return [
                        "code" => $code,
                        "vars" => $vars,
                        "profile" => $profile[2],
                        "secure_boot" => $profile[3],
                    ];
                }
            }
        }

        return false;
    }

    /**
     * Force a Win11 UEFI node's machine option to Q35 with SMM enabled.
     *
     * This is applied only to the Win11+UEFI path.  Existing machine
     * properties (notably accel=) are retained, while any user/template
     * smm=off property is replaced.  If no machine option exists, add one.
     */
    private function forceWindows11UefiMachine($options)
    {
        $options = trim((string) $options);
        $found = false;
        $options = preg_replace_callback(
            '/(^|\s)-machine\s+([^\s]+)/i',
            function ($match) use (&$found) {
                $found = true;
                $parts = [];
                foreach (explode(",", $match[2]) as $part) {
                    $part = trim($part);
                    if ($part === "" || preg_match('/^smm\s*=/i', $part)) {
                        continue;
                    }
                    if (preg_match('/^type\s*=/i', $part)) {
                        continue;
                    }
                    if (strpos($part, "=") === false) {
                        // The first bare token is the machine type (e.g. pc).
                        if (count($parts) === 0) {
                            continue;
                        }
                    }
                    $parts[] = $part;
                }
                array_unshift($parts, "type=q35");
                $parts[] = "smm=on";
                return $match[1] . "-machine " . implode(",", $parts);
            },
            $options
        );

        if (!$found) {
            return "-machine type=q35,smm=on" .
                ($options === "" ? "" : " " . $options);
        }
        return $options;
    }

    //Default qemu device factory

    public function createEthernets($quantity)
    {
        $ethernets = [];
        $bridgeid = 0;
        $addr = 0;
        $p = $this->node->getParams();
        $tpl = $this->tpl;
        $prefix = "e";
        $eth_format =
            $this->eth_format != ""
                ? $this->eth_format
                : (isset($tpl["eth_format"])
                    ? $tpl["eth_format"]
                    : "");

        if ($eth_format != "") {
            $format = EthFormat2val($eth_format);
            $prefix = $format["prefix"];
            $first = $format["first"];
        } else {
            $first = 0;
        }
        $pass = 0;
if ($this->inject_as_first_nic == 1) {
        /*FOR CUSTOM COSNOLES */
        if ($this->console == "http" || $this->console_2nd == "http") {
            $ethernets[$quantity] = new Interfc(
                $this,
                ["name" => "Mgmt http", "type" => "ethernet"],
                $quantity
            );
            $first++;
        }
        if ($this->console == "https" || $this->console_2nd == "https") {
            $ethernets[$quantity + 1] = new Interfc(
                $this,
                ["name" => "Mgmt https", "type" => "ethernet"],
                $quantity + 1
            );
            $first++;
        }
        if ($this->console == "ssh" || $this->console_2nd == "ssh") {
            $ethernets[$quantity + 2] = new Interfc(
                $this,
                ["name" => "Mgmt ssh", "type" => "ethernet"],
                $quantity + 2
            );
            $first++;
        }
        if ($this->console == "rdp" || $this->console_2nd == "rdp") {
            $ethernets[$quantity + 3] = new Interfc(
                $this,
                ["name" => "Mgmt rdp", "type" => "ethernet"],
                $quantity + 3
            );
            $first++;
        }
        if ($this->console == "rdp-tls" || $this->console_2nd == "rdp-tls") {
            $ethernets[$quantity + 4] = new Interfc(
                $this,
                ["name" => "Mgmt rdp-tls", "type" => "ethernet"],
                $quantity + 4
            );
            $first++;
        }
        /*FOR CUSTOM COSNOLES */
}
        for ($i = 0; $i < $quantity; $i++) {
            if (!isset($this->ethernets[$i])) {
                if ($i == 0 && $this->first_nic != "") {
                    $flags =
                        "  -device " .
                        $this->first_nic .
                        ",netdev=net" .
                        $i .
                        ",mac=" .
                        incMac($this->createFirstMac(), $i);
                    $flags .=
                        " -netdev tap,id=net" .
                        $i .
                        ",ifname=vunl" .
                        $this->getSession() .
                        "_" .
                        $i .
                        ",script=no,downscript=no";
                } else {
                    if ($this->pci_mode == "Default" || $this->pci_mode == "") {
                        $flags =
                            " -device %NICDRIVER%,netdev=net" .
                            $i .
                            ",mac=" .
                            incMac($this->createFirstMac(), $i);

                        $flags .=
                            " -netdev tap,id=net" .
                            $i .
                            ",ifname=vunl" .
                            $this->getSession() .
                            "_" .
                            $i .
                            ",script=no,downscript=no";
                    }
                    if ($this->pci_mode == "multifunction") {
                        if (
                            $this->console == "spice" ||
                            $this->console_2nd == "spice"
                        ) {
                            $flags =
                                " -device  %NICDRIVER%,addr=" .
                                ((int) ($i / 8) + 9) .
                                "." .
                                $i % 8 .
                                ",multifunction=on,netdev=net" .
                                $i .
                                ",mac=" .
                                incMac($this->createFirstMac(), $i);
                        } else {
                            $flags =
                                " -device  %NICDRIVER%,addr=" .
                                ((int) ($i / 8) + 5) .
                                "." .
                                $i % 8 .
                                ",multifunction=on,netdev=net" .
                                $i .
                                ",mac=" .
                                incMac($this->createFirstMac(), $i);
                        }
                        $flags .=
                            " -netdev tap,id=net" .
                            $i .
                            ",ifname=vunl" .
                            $this->getSession() .
                            "_" .
                            $i .
                            ",script=no,downscript=no";
                    }
                    if ($this->pci_mode == "Pci_Bridge") {
                        if ($i <= 16) {
                            $flags =
                                " -device %NICDRIVER%,netdev=net" .
                                $i .
                                ",mac=" .
                                incMac($this->createFirstMac(), $i);
                            $flags .=
                                " -netdev tap,id=net" .
                                $i .
                                ",ifname=vunl" .
                                $this->getSession() .
                                "_" .
                                $i .
                                ",script=no,downscript=no";
                        } else {
                            if ($i % 17 == 0) {
                                $addr = 0;
                                $bridgeid++;
                                $flags =
                                    "-device pci-bridge,id=pci_bridge" .
                                    $bridgeid .
                                    ",bus=dmi_pci_bridge,chassis_nr=0x1,addr=0x" .
                                    $bridgeid .
                                    ",shpc=off ";
                                $flags .=
                                    " -device %NICDRIVER%,netdev=net" .
                                    $i .
                                    ",mac=" .
                                    incMac($this->createFirstMac(), $i) .
                                    ",bus=pci_bridge" .
                                    $bridgeid .
                                    ",addr=0x" .
                                    sprintf("%02x\n", $addr);
                            } else {
                                $addr++;
                                $flags =
                                    " -device %NICDRIVER%,netdev=net" .
                                    $i .
                                    ",mac=" .
                                    incMac($this->createFirstMac(), $i) .
                                    ",bus=pci_bridge" .
                                    $bridgeid .
                                    ",addr=0x" .
                                    sprintf("%02x\n", $addr);
                            }
                            $flags .=
                                " -netdev tap,id=net" .
                                $i .
                                ",ifname=vunl" .
                                $this->getSession() .
                                "_" .
                                $i .
                                ",script=no,downscript=no";
                        }
                    }
                }
                $n = $prefix;
                if (isset($tpl["eth_name"][$i]) && $tpl["eth_name"][$i] != "") {
                    $n = $tpl["eth_name"][$i];
                    $pass += 1;
                } else {
                    if (
                        isset($format["slotstart"]) &&
                        $format["slotstart"] != 9999
                    ) {
                        $n .=
                            (int) (($i - $pass) / $format["mod"]) +
                            $format["slotstart"] .
                            $format["sep"];
                    }
                    if (isset($format["mod"]) && $format["mod"] != 9999) {
                        $n .=
                            (($i - $pass) % $format["mod"]) + $format["first"];
                    } else {
                        $n .= $i - $pass + $first;
                    }
                }
                try {
                    $ethernets[$i] = new Interfc(
                        $this,
                        ["name" => $n, "type" => "ethernet", "flag" => $flags],
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

    public function getParams()
    {
        $params = parent::getParams();
        $re = '/\'|"|\\\\"|\\\\\'/m';
        $this->qemu_options = preg_replace($re, "'", $this->qemu_options);

        return array_replace($params, [
            "uuid" => $this->uuid,
            "cpu" => (int) $this->cpu,
            "cpulimit" => (int) $this->cpulimit,
            "firstmac" => $this->firstmac,
            "first_nic" => $this->first_nic,
            "qemu_options" => $this->qemu_options,
            "qemu_version" => $this->qemu_version,
            "qemu_arch" => $this->qemu_arch,
            "qemu_nic" => $this->qemu_nic,
            "username" => $this->username,
            "password" => $this->password,
            "eth_format" => $this->eth_format,
            "pci_mode" => $this->pci_mode,
            "console" => $this->console,
            "console_2nd" => $this->console_2nd,
            "map_port" => $this->map_port,
            "map_port_2nd" => $this->map_port_2nd,
            "TPM" => $this->TPM,
            "UEFI" => $this->UEFI,
            "inject_as_first_nic" => $this->inject_as_first_nic,            
            "script_timeout" => $this->script_timeout,
            "config_script" => $this->config_script,
        ]);
    }

    public function editParams($p)
    {
        if (isset($p["cpu"])) {
            $this->cpu = (int) $p["cpu"];
        }

        if (isset($p["firstmac"])) {
            if (isValidMac($p["firstmac"])) {
                $this->firstmac = (string) $p["firstmac"];
            } else {
                $this->firstmac = $this->createFirstMac();
            }
        }

        if (isset($p["uuid"])) {
            $this->uuid = $p["uuid"];
            if (!checkUuid($this->uuid)) {
                $this->uuid = genUuid();
            }
        }

        if (isset($p["qemu_options"])) {
            $this->qemu_options = (string) $p["qemu_options"];
        }

        if (array_key_exists("qemu_version", $p)) {
            $this->qemu_version = (string) $p["qemu_version"];
            $this->qemu_version_explicit = true;
        }

        if (isset($p["qemu_arch"])) {
            $this->qemu_arch = (string) $p["qemu_arch"];
        }

        if (isset($p["qemu_nic"])) {
            $this->qemu_nic = (string) $p["qemu_nic"];
        }

        if (isset($p["username"])) {
            $this->username = (string) $p["username"];
        }

        if (isset($p["password"])) {
            $this->password = (string) $p["password"];
        }

        if (isset($p["console_2nd"])) {
            $this->console_2nd = (string) $p["console_2nd"];
            if ($this->console_2nd == $this->console) {
                $this->console_2nd = "";
            }
        }
        if (isset($p["TPM"])) {
            $this->TPM = htmlentities($p["TPM"]);
        }
        if (isset($p["UEFI"])) {
            $this->UEFI = (string) $p["UEFI"];
        }
        if (isset($p["map_port"])) {
            $this->map_port = (string) $p["map_port"];
        }

        if (isset($p["map_port_2nd"])) {
            $this->map_port_2nd = (string) $p["map_port_2nd"];
        }
        if (isset($p["console"])) {
            $this->console = htmlentities($p["console"]);
        }
        if (isset($p["console_2nd"])) {
            $this->console_2nd = htmlentities($p["console_2nd"]);
        }
        if (isset($p["pci_mode"])) {
            $this->pci_mode = htmlentities($p["pci_mode"]);
        }

        if (isset($p["first_nic"])) {
            $this->first_nic = (string) $p["first_nic"];
        }
        if (isset($p["inject_as_first_nic"])) {
            $this->inject_as_first_nic = (string) $p["inject_as_first_nic"];
        }
        if (isset($p["cpulimit"])) {
            $this->cpulimit = (string) $p["cpulimit"];
        }

        if (isset($p["script_timeout"])) {
            $this->script_timeout = (int) $p["script_timeout"];
        }
        if (isset($p["config_script"])) {
            $this->config_script = (string) $p["config_script"];
        }

        parent::editParams($p);
    }

    public function command()
    {
        $bin = "";
        $flags = "";

        // SECURITY (docker-rebroker stage 0): $this->image is spliced into filesystem
        // paths ("/opt/unetlab/addons/qemu/<image>...") that root qemu scandir()s and
        // opens. It is a single path segment, so validate as a traversal/charset guard
        // (not escapeshellarg) and fail closed on slash/'..'/unexpected characters.
        if (!preg_match('/^[A-Za-z0-9._-]+$/', (string) $this->image)) {
            error_log(
                date("M d H:i:s ") .
                    "ERROR: refusing QEMU node start: invalid image segment"
            );
            return [false, false];
        }

        $p = $this->tpl;
        $qarch =
            $this->qemu_arch != ""
                ? $this->qemu_arch
                : (isset($p["qemu_arch"])
                    ? $p["qemu_arch"]
                    : "");
        if ($qarch == "") {
            // Arch not found
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80015]
            );
            return [false, false];
        }

        $qversion =
            $this->qemu_version_explicit
                ? (string) $this->qemu_version
                : (isset($p["qemu_version"])
                    ? (string) $p["qemu_version"]
                    : "");
        $win11Uefi = $this->isWindows11UefiNode();
        if ($win11Uefi && $this->resolveWindows11UefiFirmware() === false) {
            error_log(
                date("M d H:i:s ") .
                    "ERROR: Win11 UEFI firmware CODE/VARS pair not found"
            );
            return [false, false];
        }
        $qemuRoot = $this->resolveQemuRoot($qversion);
        $bin .= $qemuRoot . "/bin/qemu-system-" . $qarch;
        error_log(date("M d H:i:s ") . "ERROR: " . $bin);

        if (!is_file($bin)) {
            // QEMU not found
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80016]
            );
            return [false, false];
        }

        // load configuration for
    if ($this->inject_as_first_nic == 1) {

        if ($this->console == "ssh") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_ssh,mac=" .
                $this->createNodeMac("253");
            $flags .=
                " -netdev user,id=net_ssh,hostfwd=tcp::" .
                $this->getPort() .
                "-:" .
                ($this->map_port > 0 ? $this->map_port : 22) .
                ",net=169.254.3.100/30,dhcpstart=169.254.3.101,restrict=on";
        } elseif ($this->console_2nd == "ssh") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_ssh_2nd,mac=" .
                $this->createNodeMac("252");
            $flags .=
                " -netdev user,id=net_ssh_2nd,hostfwd=tcp::" .
                $this->getSecondPort() .
                "-:" .
                ($this->map_port_2nd > 0 ? $this->map_port_2nd : 22) .
                ",net=169.254.4.100/30,dhcpstart=169.254.4.101,restrict=on";
        }
        if ($this->console == "winbox") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_winbox,mac=" .
                $this->createNodeMac("251");
            $flags .=
                " -netdev user,id=net_winbox,hostfwd=tcp::" .
                $this->getPort() .
                "-:" .
                ($this->map_port > 0 ? $this->map_port : 8291) .
                ",net=169.254.5.100/30,dhcpstart=169.254.5.101,restrict=on";
        } elseif ($this->console_2nd == "winbox") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_winbox_2nd,mac=" .
                $this->createNodeMac("250");
            $flags .=
                " -netdev user,id=net_winbox_2nd,hostfwd=tcp::" .
                $this->getSecondPort() .
                "-:" .
                ($this->map_port_2nd > 0 ? $this->map_port_2nd : 8291) .
                ",net=169.254.6.100/30,dhcpstart=169.254.6.101,restrict=on";
        }

        if ($this->console == "http") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_http,mac=" .
                $this->createNodeMac("249");
            $flags .=
                " -netdev user,id=net_http,hostfwd=tcp::" .
                $this->getPort() .
                "-:" .
                ($this->map_port > 0 ? $this->map_port : 80) .
                ",net=169.254.7.100/30,dhcpstart=169.254.7.101,restrict=on";
        } elseif ($this->console_2nd == "http") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_http_2nd,mac=" .
                $this->createNodeMac("248");
            $flags .=
                " -netdev user,id=net_http_2nd,hostfwd=tcp::" .
                $this->getSecondPort() .
                "-:" .
                ($this->map_port_2nd > 0 ? $this->map_port_2nd : 80) .
                ",net=169.254.8.100/30,dhcpstart=169.254.8.101,restrict=on";
        }

        if ($this->console == "https") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_https,mac=" .
                $this->createNodeMac("247");
            $flags .=
                " -netdev user,id=net_https,hostfwd=tcp::" .
                $this->getPort() .
                "-:" .
                ($this->map_port > 0 ? $this->map_port : 443) .
                ",net=169.254.9.100/30,dhcpstart=169.254.9.101,restrict=on";
        } elseif ($this->console_2nd == "https") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_https_2nd,mac=" .
                $this->createNodeMac("246");
            $flags .=
                " -netdev user,id=net_https_2nd,hostfwd=tcp::" .
                $this->getSecondPort() .
                "-:" .
                ($this->map_port_2nd > 0 ? $this->map_port_2nd : 443) .
                ",net=169.254.10.100/30,dhcpstart=169.254.10.101,restrict=on";
        }
             $flags .= " " . $this->getFlag();
    }

    else {
        $flags .= " " . $this->getFlag();
            if ($this->console == "ssh") {
                $flags .=
                    " -device %NICDRIVER%,netdev=net_ssh,mac=" .
                    $this->createNodeMac("253");
                $flags .=
                    " -netdev user,id=net_ssh,hostfwd=tcp::" .
                    $this->getPort() .
                    "-:" .
                    ($this->map_port > 0 ? $this->map_port : 22) .
                    ",net=169.254.3.100/30,dhcpstart=169.254.3.101,restrict=on";
            } elseif ($this->console_2nd == "ssh") {
                $flags .=
                    " -device %NICDRIVER%,netdev=net_ssh_2nd,mac=" .
                    $this->createNodeMac("252");
                $flags .=
                    " -netdev user,id=net_ssh_2nd,hostfwd=tcp::" .
                    $this->getSecondPort() .
                    "-:" .
                    ($this->map_port_2nd > 0 ? $this->map_port_2nd : 22) .
                    ",net=169.254.4.100/30,dhcpstart=169.254.4.101,restrict=on";
            }
            if ($this->console == "winbox") {
                $flags .=
                    " -device %NICDRIVER%,netdev=net_winbox,mac=" .
                    $this->createNodeMac("251");
                $flags .=
                    " -netdev user,id=net_winbox,hostfwd=tcp::" .
                    $this->getPort() .
                    "-:" .
                    ($this->map_port > 0 ? $this->map_port : 8291) .
                    ",net=169.254.5.100/30,dhcpstart=169.254.5.101,restrict=on";
            } elseif ($this->console_2nd == "winbox") {
                $flags .=
                    " -device %NICDRIVER%,netdev=net_winbox_2nd,mac=" .
                    $this->createNodeMac("250");
                $flags .=
                    " -netdev user,id=net_winbox_2nd,hostfwd=tcp::" .
                    $this->getSecondPort() .
                    "-:" .
                    ($this->map_port_2nd > 0 ? $this->map_port_2nd : 8291) .
                    ",net=169.254.6.100/30,dhcpstart=169.254.6.101,restrict=on";
            }

            if ($this->console == "http") {
                $flags .=
                    " -device %NICDRIVER%,netdev=net_http,mac=" .
                    $this->createNodeMac("249");
                $flags .=
                    " -netdev user,id=net_http,hostfwd=tcp::" .
                    $this->getPort() .
                    "-:" .
                    ($this->map_port > 0 ? $this->map_port : 80) .
                    ",net=169.254.7.100/30,dhcpstart=169.254.7.101,restrict=on";
            } elseif ($this->console_2nd == "http") {
                $flags .=
                    " -device %NICDRIVER%,netdev=net_http_2nd,mac=" .
                    $this->createNodeMac("248");
                $flags .=
                    " -netdev user,id=net_http_2nd,hostfwd=tcp::" .
                    $this->getSecondPort() .
                    "-:" .
                    ($this->map_port_2nd > 0 ? $this->map_port_2nd : 80) .
                    ",net=169.254.8.100/30,dhcpstart=169.254.8.101,restrict=on";
            }

            if ($this->console == "https") {
                $flags .=
                    " -device %NICDRIVER%,netdev=net_https,mac=" .
                    $this->createNodeMac("247");
                $flags .=
                    " -netdev user,id=net_https,hostfwd=tcp::" .
                    $this->getPort() .
                    "-:" .
                    ($this->map_port > 0 ? $this->map_port : 443) .
                    ",net=169.254.9.100/30,dhcpstart=169.254.9.101,restrict=on";
            } elseif ($this->console_2nd == "https") {
                $flags .=
                    " -device %NICDRIVER%,netdev=net_https_2nd,mac=" .
                    $this->createNodeMac("246");
                $flags .=
                    " -netdev user,id=net_https_2nd,hostfwd=tcp::" .
                    $this->getSecondPort() .
                    "-:" .
                    ($this->map_port_2nd > 0 ? $this->map_port_2nd : 443) .
                    ",net=169.254.10.100/30,dhcpstart=169.254.10.101,restrict=on";
            }
    }
        if ($this->pci_mode == "Pci_Bridge") {
            $flags .= " -device i82801b11-bridge,id=dmi_pci_bridge ";
        }

        if ($this->console == "spice") {
            $config = yaml_parse_file("/opt/unetlab/html/includes/config.yml");
                $ipv6 = $config["ipv6"];
            if ($ipv6 == 1 ) {
                $flags .=
                " -spice port=" .
                $this->getPort() .
                ",addr=::,disable-ticketing"; // start a spice server on display
            }
            else {
                $flags .=
                " -spice port=" .
                $this->getPort() .
                ",addr=0.0.0.0,disable-ticketing"; // start a spice server on display
  
            }
            $flags .=
                " -device virtio-serial-pci,id=virtio-serial0 -device virtio-balloon -device virtserialport,bus=virtio-serial0.0,nr=1,chardev=charchannel1,id=channel1,name=org.spice-space.webdav.0 -chardev spiceport,name=org.spice-space.webdav.0,id=charchannel1 -chardev spicevmc,id=vdagent,debug=0,name=vdagent  -device virtserialport,chardev=vdagent,name=com.redhat.spice.0  -device ich9-usb-ehci1,id=usb -device ich9-usb-uhci1,masterbus=usb.0,firstport=0,multifunction=on -device ich9-usb-uhci2,masterbus=usb.0,firstport=2 -device ich9-usb-uhci3,masterbus=usb.0,firstport=4 -chardev spicevmc,name=usbredir,id=usbredirchardev1 -device usb-redir,chardev=usbredirchardev1,id=usbredirdev1 -chardev spicevmc,name=usbredir,id=usbredirchardev2 -device usb-redir,chardev=usbredirchardev2,id=usbredirdev2 -chardev spicevmc,name=usbredir,id=usbredirchardev3 -device usb-redir,chardev=usbredirchardev3,id=usbredirdev3 -device ich9-intel-hda -device hda-micro ";
                if ($this->getTemplate() == "win" || $this->getTemplate() == "winserver") {
                    $flags .=
                        " -drive file=/opt/unetlab/scripts/virtio-win-drivers-for-spice.iso,index=1,media=cdrom ";
                }
        } elseif ($this->console_2nd == "spice") {
            $config = yaml_parse_file("/opt/unetlab/html/includes/config.yml");
                $ipv6 = $config["ipv6"];

            if ($ipv6 == 1 ) {
                $flags .=
                " -spice port=" .
                $this->getSecondPort() .
                ",addr=::,disable-ticketing"; // start a spice server on display

            }
            else {
                $flags .=
                " -spice port=" .
                $this->getSecondPort() .
                ",addr=0.0.0.0,disable-ticketing"; // start a spice server on display
  
            }
            $flags .=
                " -device virtio-serial-pci,id=virtio-serial0 -device virtio-balloon -device virtserialport,bus=virtio-serial0.0,nr=1,chardev=charchannel1,id=channel1,name=org.spice-space.webdav.0 -chardev spiceport,name=org.spice-space.webdav.0,id=charchannel1 -chardev spicevmc,id=vdagent,debug=0,name=vdagent  -device virtserialport,chardev=vdagent,name=com.redhat.spice.0  -device ich9-usb-ehci1,id=usb -device ich9-usb-uhci1,masterbus=usb.0,firstport=0,multifunction=on -device ich9-usb-uhci2,masterbus=usb.0,firstport=2 -device ich9-usb-uhci3,masterbus=usb.0,firstport=4 -chardev spicevmc,name=usbredir,id=usbredirchardev1 -device usb-redir,chardev=usbredirchardev1,id=usbredirdev1 -chardev spicevmc,name=usbredir,id=usbredirchardev2 -device usb-redir,chardev=usbredirchardev2,id=usbredirdev2 -chardev spicevmc,name=usbredir,id=usbredirchardev3 -device usb-redir,chardev=usbredirchardev3,id=usbredirdev3 -device ich9-intel-hda -device hda-micro ";
                if ($this->getTemplate() == "win" || $this->getTemplate() == "winserver") {
                    $flags .=
                        " -drive file=/opt/unetlab/scripts/virtio-win-drivers-for-spice.iso,index=1,media=cdrom ";
                }        
        }

        if ($this->console == "rdp") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_rdp,mac=" .
                $this->createNodeMac("255");
            $flags .=
                " -netdev user,id=net_rdp,hostfwd=tcp::" .
                $this->getPort() .
                "-:" .
                ($this->map_port > 0 ? $this->map_port : 3389) .
                ",net=169.254.1.100/30,dhcpstart=169.254.1.101,restrict=on";
        } elseif ($this->console_2nd == "rdp") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_rdp_2nd,mac=" .
                $this->createNodeMac("254");
            $flags .=
                " -netdev user,id=net_rdp_2nd,hostfwd=tcp::" .
                $this->getSecondPort() .
                "-:" .
                ($this->map_port_2nd > 0 ? $this->map_port_2nd : 3389) .
                ",net=169.254.2.100/30,dhcpstart=169.254.2.101,restrict=on";
        }
        if ($this->console == "rdp-tls") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_rdp_tls,mac=" .
                $this->createNodeMac("245");
            $flags .=
                " -netdev user,id=net_rdp_tls,hostfwd=tcp::" .
                $this->getPort() .
                "-:" .
                ($this->map_port > 0 ? $this->map_port : 3389) .
                ",net=169.254.11.100/30,dhcpstart=169.254.11.101,restrict=on";
        } elseif ($this->console_2nd == "rdp-tls") {
            $flags .=
                " -device %NICDRIVER%,netdev=net_rdp_tls_2nd,mac=" .
                $this->createNodeMac("244");
            $flags .=
                " -netdev user,id=net_rdp_tls_2nd,hostfwd=tcp::" .
                $this->getSecondPort() .
                "-:" .
                ($this->map_port_2nd > 0 ? $this->map_port_2nd : 3389) .
                ",net=169.254.12.100/30,dhcpstart=169.254.12.101,restrict=on";
        }
        // Load configuration of all interface

        if ($this->console == "vnc") {
            $flags .= " -vnc :" . ($this->getPort() - 5900); // start a VNC server on display
        } elseif ($this->console_2nd == "vnc") {
            $flags .= " -vnc :" . ($this->getSecondPort() - 5900); // start a VNC server on display
        } else {
            $flags .= " -nographic ";
        }

        if ($this->TPM == "tpm-tis") {
            $flags .=
                " -chardev socket,id=chrtpm,path=/tmp/" .
                $this->getSession() .
                "_swtpm-sock/sock -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0 ";
        }
        if ($this->TPM == "tpm-crb") {
            $flags .=
                " -chardev socket,id=chrtpm,path=/tmp/" .
                $this->getSession() .
                "_swtpm-sock/sock -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-crb,tpmdev=tpm0 ";
        }
        if ($this->UEFI == "1") {
            if ($win11Uefi) {
                $firmware = $this->resolveWindows11UefiFirmware();
                $varsPath = $this->getRunningPath() . "/OVMF_VARS.fd";
                if (
                    !is_file($varsPath) &&
                    !copy($firmware["vars"], $varsPath)
                ) {
                    error_log(
                        date("M d H:i:s ") .
                            "ERROR: unable to initialize Win11 UEFI VARS"
                    );
                    return [false, false];
                }
                $flags .=
                    ($firmware["secure_boot"]
                        ? " -global driver=cfi.pflash01,property=secure,value=on"
                        : "");
                if (!$firmware["secure_boot"]) {
                    error_log(
                        date("M d H:i:s ") .
                            "WARNING: Win11 UEFI Secure Boot unavailable with " .
                            $firmware["profile"] . " firmware"
                    );
                }
                $flags .=
                    " -drive if=pflash,format=raw,unit=0,file=" .
                    $firmware["code"] .
                    ",readonly=on -drive if=pflash,format=raw,unit=1,file=./OVMF_VARS.fd ";
            } elseif (
                is_file($this->getRunningPath() . "/sataa.qcow2") &&
                $this->getTemplate() != "nxosv9k"
            ) {
                $flags .= " -bios /opt/qemu/share/qemu/OVMF-sata.fd";
            } elseif ($this->getTemplate() == "macos") {
                $flags .=
                    " -no-hpet -global kvm-pit.lost_tick_policy=discard -global ICH9-LPC.disable_s3=1 -drive id=OpenCore,if=virtio,format=qcow2,file=/opt/unetlab/scripts/Mac_os_Guest/OpenCore.qcow2 -drive if=pflash,format=raw,readonly,file=/opt/unetlab/scripts/Mac_os_Guest/OVMF_CODE.fd -drive if=pflash,format=raw,file=/opt/unetlab/scripts/Mac_os_Guest/OVMF_VARS-1024x768.fd  ";
            } elseif ($this->getTemplate() != "nxosv9k") {
                copy(
                    "/usr/share/OVMF/OVMF_VARS.fd",
                    $this->getRunningPath() . "/OVMF_VARS.fd"
                );
                if (
                    $this->getTemplate() == "win" ||
                    $this->getTemplate() == "winserver" ||
                    $this->getTemplate() == "macos_simple_kvm"
                ) {
                    $flags .=
                        " -no-hpet -global kvm-pit.lost_tick_policy=discard -global ICH9-LPC.disable_s3=1";
                }
                $flags .=
                    " -global driver=cfi.pflash01,property=secure,value=on  -drive if=pflash,format=raw,unit=0,file=/usr/share/OVMF/OVMF_CODE.fd,readonly=on -drive if=pflash,format=raw,unit=1,file=./OVMF_VARS.fd ";
            }
        }
        /*if ($this->UEFI == 'secureboot'){
            copy('/usr/share/OVMF/OVMF_VARS_4M.ms.fd', $this->getRunningPath() . '/OVMF_VARS_4M.ms.fd'); 
            if ($this->getTemplate() == 'win' || $this->getTemplate() == 'winserver') {
                        $flags .= '-no-hpet -global kvm-pit.lost_tick_policy=discard -global ICH9-LPC.disable_s3=1';
            }
            $flags .= ' -global driver=cfi.pflash01,property=secure,value=on  -drive if=pflash,format=raw,unit=0,file=/usr/share/OVMF/OVMF_CODE_4M.fd,readonly=on -drive if=pflash,format=raw,unit=1,file=./OVMF_VARS_4M.ms.fd ';
        }*/
        if ($this->console == "telnet" || $this->console_2nd == "telnet") {
            $flags .=
                " -chardev socket,id=serial0,path=" .
                $this->getRunningPath() .
                "/console.sock,server,nowait -serial chardev:serial0";
        }
        // Add monitor socket
        $flags .=
            " -chardev socket,id=monitor,path=" .
            $this->getRunningPath() .
            "/monitor.sock,server,nowait -monitor chardev:monitor";
        $flags .=
            " -chardev socket,id=monitor2,path=" .
            $this->getRunningPath() .
            "/monitor2.sock,server,nowait -monitor chardev:monitor2";

        $qnic =
            $this->qemu_nic != ""
                ? $this->qemu_nic
                : (isset($p["qemu_nic"])
                    ? $p["qemu_nic"]
                    : "");
        if (preg_match('/^[0-9a-zA-Z-]+$/', $qnic)) {
            // Setting non default NIC driver
            $flags = str_replace("%NICDRIVER%", $qnic, $flags);
        } elseif ($qnic != "") {
            // Invalid NIC driver
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80017]
            );
            return "";
        } else {
            // Setting default NIC driver
            $flags = str_replace("%NICDRIVER%", "e1000", $flags);
        }
        // vhost-net: kernel-bypass data path for virtio-net-pci only
        if ($qnic === 'virtio-net-pci') {
            $flags = str_replace(',script=no', ',script=no,vhost=on', $flags);
        }

        // Set configuration for device
        /*if ($this->getTemplate() == 'win' || $this->getTemplate() == 'winserver' ||  $this->getTemplate() == 'macos_simple_kvm'||  $this->getTemplate() == 'pnetlab' ) {
                    $flags .= ' -smp '. $this->cpu .',sockets=1,cores='. $this->cpu;

        }
        else  {
            $flags .= ' -smp cpus=' . $this->cpu . ',sockets=1';           // set the number of CPUs
        }*/
        $flags .= " -smp cpus=" . $this->cpu . ",sockets=1"; // set the number of CPUs
        $flags .= " -m " . $this->ram; // configure guest RAM
        $flags .= ' -name "' . $this->name . '"'; // set the name of the guest
        $flags .= " -uuid " . $this->uuid; // specify machine UUID
        if ($this->qemu_arch == "x86_64" && !$win11Uefi) {
            $flags .= " -machine smm=off "; // specify machine smm
        }
        // Adding controller
        foreach (
            scandir("/opt/unetlab/addons/qemu/" . $this->image)
            as $filename
        ) {
            if (preg_match('/^megasas[a-z]+.qcow2$/', $filename)) {
                // MegaSAS
                $flags .= " -device megasas,id=scsi0,bus=pci.0,addr=0x5"; // Define SCSI BUS
                break;
            } elseif (preg_match('/^lsi[a-z]+.qcow2$/', $filename)) {
                // LSI
                $flags .= " -device lsi,id=scsi0,bus=pci.0,addr=0x5"; // Define SCSI BUS
                break;
            }
        }

        // Disk AIO backend. io_uring is faster/lower-overhead than the thread
        // pool, but needs QEMU >= 5.0 built with liburing. The modern default
        // (empty qemu_version or a missing pinned tree -> /opt/qemu; on v8/27H1 the appliance points that
        // at stock QEMU 10.2.1, which links liburing natively; on v7.x it was the
        // bundled 9.2.4) supports it, as does any explicitly modern pin (major
        // >= 8). The legacy version-pinned zoo (/opt/qemu-2.4.0 .. 7.2.0) lacks
        // liburing, so a blanket aio=io_uring would stop those nodes from
        // starting -> they keep the safe thread pool.
        $qv = (string) $qversion;
        $qmajor = (int) $qv; // "10.2.1"->10, "2.4.0"->2, ""->0
        $aio =
            ($qemuRoot === "/opt/qemu" ||
                $qv === "9.2.4" ||
                $qmajor >= 8)
                ? "io_uring"
                : "threads";

        // Adding disks
        foreach (
            scandir("/opt/unetlab/addons/qemu/" . $this->image)
            as $filename
        ) {
            if ($filename == "cdrom.iso") {
                // CDROM
                $flags .=
                    " -cdrom /opt/unetlab/addons/qemu/" .
                    $this->image .
                    "/cdrom.iso";
            } elseif ($filename == "BaseSystem.img") {
                // CDROM
                $flags .=
                    " -drive id=InstallMedia,if=virtio,format=raw,file=/opt/unetlab/addons/qemu/" .
                    $this->image .
                    "/BaseSystem.img";
            } elseif ($filename == "kernel.img") {
                // Custom Kernel
                $flags .=
                    " -kernel /opt/unetlab/addons/qemu/" .
                    $this->image .
                    "/kernel.img";
            } elseif (preg_match('/^megasas[a-z]+.qcow2$/', $filename)) {
                // MegaSAS
                $patterns[0] = '/^megasas([a-z]+).qcow2$/';
                $replacements[0] = '$1';
                $disk_id = preg_replace($patterns, $replacements, $filename);
                $lun = (int) ord(strtolower($disk_id)) - 97;
                $flags .=
                    " -device scsi-disk,bus=scsi0.0,scsi-id=" .
                    $lun .
                    ",drive=drive-scsi0-0-" .
                    $lun .
                    ",id=scsi0-0-" .
                    $lun .
                    ",bootindex=" .
                    $lun; // Define SCSI disk
                $flags .=
                    " -drive file=" .
                    $filename .
                    ",if=none,id=drive-scsi0-0-" .
                    $lun .
                    ",cache=writeback,aio=" . $aio; // Define SCSI file
            } elseif (preg_match('/^lsi[a-z]+.qcow2$/', $filename)) {
                // LSI
                $patterns[0] = '/^lsi([a-z]+).qcow2$/';
                $replacements[0] = '$1';
                $disk_id = preg_replace($patterns, $replacements, $filename);
                $lun = (int) ord(strtolower($disk_id)) - 97;
                $flags .=
                    " -device scsi-disk,bus=scsi0.0,scsi-id=" .
                    $lun .
                    ",drive=drive-scsi0-0-" .
                    $lun .
                    ",id=scsi0-0-" .
                    $lun .
                    ",bootindex=" .
                    $lun; // Define SCSI disk
                $flags .=
                    " -drive file=" .
                    $filename .
                    ",if=none,id=drive-scsi0-0-" .
                    $lun .
                    ",cache=writeback,aio=" . $aio;
                // Define SCSI file
            } elseif (preg_match('/^hd[a-z]+.qcow2$/', $filename)) {
                // IDE
                $patterns[0] = '/^hd([a-z]+).qcow2$/';
                $replacements[0] = '$1';
                $disk_id = preg_replace($patterns, $replacements, $filename);
                $flags .= " -hd" . $disk_id . " " . $filename;
                if ($this->getTemplate() == "nxosv9k") {
                    $flags .=
                        " -bios /opt/qemu/share/qemu/OVMF.fd -drive file=hda.qcow2,if=ide,index=2";
                }
            } elseif (preg_match('/^virtide[a-z]+.qcow2$/', $filename)) {
                // IDE
                $patterns[0] = '/^virtide([a-z]+).qcow2$/';
                $replacements[0] = '$1';
                $disk_id = preg_replace($patterns, $replacements, $filename);
                $disk_num = (int) ord(strtolower($disk_id)) - 97;
                $flags .=
                    " -device virtio-blk-pci,scsi=off,drive=idedisk" .
                    $disk_num .
                    ",id=hd" .
                    $disk_id .
                    ",bootindex=1";
                $flags .=
                    " -drive file=" .
                    $filename .
                    ",if=none,id=idedisk" .
                    $disk_num .
                    ",format=qcow2,cache=writethrough";
            } elseif (preg_match('/^virtio[a-z]+.qcow2$/', $filename)) {
                // VirtIO
                $patterns[0] = '/^virtio([a-z]+).qcow2$/';
                $replacements[0] = '$1';
                $disk_id = preg_replace($patterns, $replacements, $filename);
                $lun = (int) ord(strtolower($disk_id)) - 97;
                $flags .=
                    " -drive file=" .
                    $filename .
                    ",if=virtio,bus=1,unit=" .
                    $lun .
                    ",cache=writeback,aio=" . $aio;
            } elseif (preg_match('/^scsi[a-z]+.qcow2$/', $filename)) {
                // SCSI
                $patterns[0] = '/^scsi([a-z]+).qcow2$/';
                $replacements[0] = '$1';
                $disk_id = preg_replace($patterns, $replacements, $filename);
                $lun = (int) ord(strtolower($disk_id)) - 97;
                $flags .=
                    " -drive file=" .
                    $filename .
                    ",if=scsi,bus=0,unit=" .
                    $lun .
                    ",cache=writeback,aio=" . $aio;
            } elseif (preg_match('/^sata[a-z]+.qcow2$/', $filename)) {
                //SATA
                $patterns[0] = '/^sata([a-z]+).qcow2$/';
                $replacements[0] = '$1';
                $disk_id = preg_replace($patterns, $replacements, $filename);
                $disk_id = (int) ord(strtolower($disk_id)) - 97;
                $flags .= " -device ahci,id=ahci" . $disk_id . ",bus=pci.0";
                $flags .=
                    " -drive file=" .
                    $filename .
                    ",if=none,id=drive-sata-disk" .
                    $disk_id .
                    ",format=qcow2";
                $flags .=
                    " -device ide-hd,bus=ahci" .
                    $disk_id .
                    ".0,drive=drive-sata-disk" .
                    $disk_id .
                    ",id=drive-sata-disk" .
                    $disk_id .
                    ",bootindex=" .
                    ($disk_id + 1);
                if ($this->getTemplate() == "nxosv9k") {
                    $flags .= " -bios /opt/qemu/share/qemu/OVMF-sata.fd";
                }
            }
        }
        // Append the template's cstart args (e.g. the USB config-stick or
        // config.iso device built by its prep script). Unlike the base disk
        // scan above, prep-generated files live in the node's running
        // directory, not the image directory, so they are never picked up
        // by the loop above and must be attached explicitly here.
        $cstart = isset($this->tpl['cstart']) ? trim($this->tpl['cstart']) : '';
        if ($cstart != '') {
            $flags .= ' ' . $cstart;
        }
        // Adding custom flags
        $qoptions =
            $this->qemu_options != ""
                ? $this->qemu_options
                : (isset($p["qemu_options"])
                    ? $p["qemu_options"]
                    : "");
        if ($win11Uefi) {
            $qoptions = $this->forceWindows11UefiMachine($qoptions);
        }
        $flags .= " " . $qoptions;
        $flags = $this->customFlag($flags);
        // Bare -cdrom uses legacy IDE index=2 (bus=1,unit=0), which collides
        // with virtioa.qcow2's inherited explicit address. Split config.iso
        // into an unaddressed backend and an auto-placed IDE frontend instead:
        // if=none cannot collide with any virtio bus/unit, including multi-disk
        // nodes, while ide-cd selects a real free IDE slot independently.
        // Limit this normalization to templates that actually request the
        // legacy attachment so every other template's flags stay unchanged.
        if (
            preg_match('/(?:^|\s)-cdrom\s+config\.iso(?:\s|$)/', $cstart) ||
            preg_match('/(?:^|\s)-cdrom\s+config\.iso(?:\s|$)/', $qoptions)
        ) {
            // Some legacy device subclasses append the same CD-ROM again;
            // consolidate all exact duplicates into one explicit attachment.
            $flags = preg_replace(
                '/\s+-cdrom\s+config\.iso(?=\s|$)/',
                '',
                $flags
            );
            $flags .=
                ' -drive file=config.iso,if=none,media=cdrom,id=pnetlab-config-iso';
            $flags .= ' -device ide-cd,drive=pnetlab-config-iso';
        }
        if ($qemuRoot == "/opt/qemu") {
            // Legacy zoo-era templates and pre-decomm saved .unl files still
            // carry qemu_options QEMU has since removed. Only translate when
            // we are actually running the modern default binary — a real
            // pinned /opt/qemu-<ver> zoo binary still understands its own
            // era's flags natively and must not be rewritten.
            $flags = $this->modernizeQemuFlags($flags);
        }

        // $cmd = '/opt/unetlab/wrappers/qemu_wrapper -T ' . $this->getHost() . ' -D ' . $this->getSession() . ' -P ' . $port . ' -t "' . $this->name . '" -F ' . $bin . ' -d ' . $this->delay;
        // if ($this->console != 'telnet'  && $this->console_2nd != 'telnet') {
        //     // Disable telnet (wrapper)
        //     $cmd .= ' -x';
        // }

        // KSM whole-process merge: front the qemu binary with ksm_merge_exec,
        // which sets prctl(PR_SET_MEMORY_MERGE) (survives execve, no privilege
        // needed) so all of qemu's anon memory — not just madvise'd guest RAM —
        // is eligible for kernel same-page merging. No-op on kernels < 6.4.
        // Opt out by touching /opt/unetlab/wrappers/.ksm_merge_off.
        $ksmWrap = "/opt/unetlab/wrappers/ksm_merge_exec";
        $ksmLauncher =
            is_executable($ksmWrap) &&
            !file_exists("/opt/unetlab/wrappers/.ksm_merge_off")
                ? $ksmWrap . " "
                : "";

        $cmd =
            $ksmLauncher .
            $bin .
            $flags .
            " > " .
            $this->getRunningPath() .
            "/wrapper.txt";
        if (HYPERVISOR == "vm" && $this->qemu_arch == "x86_64") {
            $cmd = preg_replace(
                "/-cpu *host/",
                "-cpu host,vmx=off,svm=off",
                $cmd
            );
            $cmd = preg_replace(
                "/vmx=off,smv=off([A-Za-z])/",
                'vmx=off,svm=off\1',
                $cmd
            );
        }

        $re = '/\'|"|\\\\"|\\\\\'/m';
        $cmd = preg_replace($re, "'", $cmd);

        return $cmd;
    }

    /**
     * Flag is a command's parameter signal by -- in wrapper
     * This function is overwritten by children to custom
     * @property flag : current flag
     * @return flag: flag after custom
     */
    public function customFlag($flag)
    {
        return $flag;
    }

    /**
     * Translate qemu command-line flags that legacy zoo-era templates (and
     * .unl files saved before the qemu-zoo-unpin decommission) still carry,
     * but that modern QEMU has since removed. Only called when the node is
     * actually launching the modern default binary (/opt/qemu) — see the
     * $qemuRoot guard at the call site — so a real pinned legacy
     * /opt/qemu-<ver> zoo binary is never rewritten, only the flags that
     * would otherwise hard-fail against the current default QEMU.
     * @property flags : the fully-assembled qemu command-line flags
     * @return flags : flags with dead/renamed options translated
     */
    private function modernizeQemuFlags($flags)
    {
        // pc-1.0/pc-0.x (removed upstream long ago) -> the bare "pc" alias,
        // which always resolves to the current default i440fx machine type.
        $flags = preg_replace('/type=pc-[01]\.\d+\b/', 'type=pc', $flags);

        // pc-q35-<N>.<M> below 5.0 (e.g. pc-q35-4.2, used by xrv8102) was
        // removed upstream the same way; "q35" is the current default alias.
        $flags = preg_replace('/type=pc-q35-[0-4]\.\d+\b/', 'type=q35', $flags);

        // -no-hpet was removed as a standalone flag; fold it into the
        // -machine clause as the hpet=off property instead.
        if (strpos($flags, '-no-hpet') !== false) {
            $flags = preg_replace('/\s*-no-hpet\b/', '', $flags);
            if (preg_match('/-machine\s+(\S+)/', $flags, $m)) {
                if (strpos($m[1], 'hpet=') === false) {
                    $flags = preg_replace(
                        '/-machine\s+' . preg_quote($m[1], '/') . '/',
                        '-machine ' . $m[1] . ',hpet=off',
                        $flags,
                        1
                    );
                }
            } else {
                $flags .= ' -machine pc,hpet=off';
            }
        }

        // -realtime mlock=off was removed; -overcommit mem-lock=off is the
        // modern equivalent (same intent: don't lock guest RAM).
        $flags = preg_replace(
            '/-realtime\s+mlock=off/',
            '-overcommit mem-lock=off',
            $flags
        );

        return $flags;
    }
/**
     * shutdown acpi node
     *
     */
    public function shutdown()
    {
        $monSocket = $this->getRunningPath() . "/monitor.sock";
        $cmd = "echo system_powerdown | sudo nc -U  " . $monSocket . " -q 0";
        error_log(date("M d H:i:s ") . $cmd);
        exec($cmd, $rc);
    }

/**
     * freeze cpu of node
     *
     */

    public function freeze()
    {
        $monSocket = $this->getRunningPath() . "/monitor2.sock";
        if (is_file($this->getRunningPath() . "/.run")) {
            $cmd = "echo stop | sudo nc -U  " . $monSocket . " -q 0";
            error_log(date("M d H:i:s ") . $cmd);
            exec($cmd, $rc);
            touch($this->getRunningPath() . "/.freeze");
            unlink($this->getRunningPath() . "/.run");
        } else {
            $cmd = "echo cont | sudo nc -U  " . $monSocket . " -q 0";
            error_log(date("M d H:i:s ") . $cmd);
            exec($cmd, $rc);
            touch($this->getRunningPath() . "/.run");
            unlink($this->getRunningPath() . "/.freeze");
        }
    }
    /**
     * shutdown and save state of   nodeb (ram , disk , cpu)
     *
     */

    public function hibernate()
    {
        touch($this->getRunningPath() . "/.hibernated");
        $monSocket = $this->getRunningPath() . "/monitor2.sock";
        $cmd = "echo savevm pnet-snapshot | sudo nc -U " . $monSocket . " -q 0";
        error_log(date("M d H:i:s ") . $cmd);
        exec($cmd, $rc);
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

        $win11Node = $this->isWindows11Node();
        $win11Uefi = $this->isWindows11UefiNode();
        if ($win11Uefi && $this->resolveWindows11UefiFirmware() === false) {
            error_log(
                date("M d H:i:s ") .
                    "ERROR: refusing Win11 UEFI start: firmware CODE/VARS pair not found"
            );
            return 80046;
        }

        $user = "unl" . $this->getSession();
        if ($this->TPM == "tpm-tis" || $this->TPM == "tpm-crb") {
            $tmp = "/tmp/" . $this->getSession() . "_swtpm-sock";
            if ($win11Node && !is_executable("/usr/bin/swtpm")) {
                error_log(
                    date("M d H:i:s ") .
                        "ERROR: refusing Win11 TPM start: /usr/bin/swtpm is not executable"
                );
                return 80046;
            }
            $cmd = $win11Node ? "mkdir -p " . $tmp : "mkdir " . $tmp;
            exec($cmd, $o, $rc);
            if ($win11Node && $rc !== 0) {
                error_log(
                    date("M d H:i:s ") .
                        "ERROR: unable to create Win11 swtpm state directory"
                );
                return 80046;
            }
            $cmd =
                "/usr/bin/swtpm socket --tpmstate dir=" .
                $tmp .
                " --ctrl type=unixio,path=" .
                $tmp .
                "/sock --log level=20 --tpm2 -d -t ";
            exec($cmd, $o, $rc);
            if ($win11Node && $rc !== 0) {
                error_log(
                    date("M d H:i:s ") .
                        "ERROR: unable to launch Win11 swtpm"
                );
                return 80046;
            }
        }
        if ($this->console == "rdp") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.1.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.1.102";
            exec($cmd, $o, $rc);
        }
        if ($this->console_2nd == "rdp") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.2.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.2.102";
            exec($cmd, $o, $rc);
        }
        if ($this->console == "ssh") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.3.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.3.102";
            exec($cmd, $o, $rc);
        }
        if ($this->console_2nd == "ssh") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.4.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.4.102";
            exec($cmd, $o, $rc);
        }
        if ($this->console == "winbox") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.5.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.5.102";
            exec($cmd, $o, $rc);
        }
        if ($this->console_2nd == "winbox") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.6.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.6.102";
            exec($cmd, $o, $rc);
        }
        if ($this->console == "http") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.7.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.7.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console_2nd == "http") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.8.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.8.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console == "https") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.9.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.9.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console_2nd == "https") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.10.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.10.102";
            exec($cmd, $o, $rc);
        }
        if ($this->console == "rdp-tls") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.11.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.11.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console_2nd == "rdp-tls") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.12.102";
            exec($cmd, $o, $rc);
            $cmd =
                "iptables -t nat -I INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.12.102";
            exec($cmd, $o, $rc);
        }

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

        if (
            !is_file($this->getRunningPath() . "/.prepared") &&
            !is_file($this->getRunningPath() . "/.lock")
        ) {
            $image = "/opt/unetlab/addons/qemu/" . $this->image;

            if (!touch($this->getRunningPath() . "/.lock")) {
                // Cannot lock directory
                error_log(
                    date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80041]
                );
                return 80041;
            }

            // Copy files from template
            foreach (scandir($image) as $filename) {
                if (preg_match('/^[a-zA-Z0-9]+.qcow2$/', $filename)) {
                    // TODO should check if file exists
                    $cmd =
                        '/opt/qemu/bin/qemu-img create -b "' .
                        $image .
                        "/" .
                        $filename .
                        '" -F qcow2 -f qcow2 "' .
                        $this->getRunningPath() .
                        "/" .
                        $filename .
                        '"';
                    exec($cmd, $o, $rc);
                    if ($rc !== 0) {
                        // Cannot make linked clone
                        error_log(
                            date("M d H:i:s ") .
                                "ERROR: " .
                                $GLOBALS["messages"][80045]
                        );
                        error_log(date("M d H:i:s ") . implode("\n", $o));
                        return 80045;
                    }
                } else {
                    $cmd =
                        "sudo link " .
                        $image .
                        "/" .
                        $filename .
                        " " .
                        $this->getRunningPath() .
                        "/" .
                        $filename;
                    exec($cmd, $o, $rc);
                }
            }

            if (is_file($this->getRunningPath() . "/.lock")) {
                if (!unlink($this->getRunningPath() . "/.lock")) {
                    // Cannot unlock directory
                    error_log(
                        date("M d H:i:s ") .
                            "ERROR: " .
                            $GLOBALS["messages"][80042]
                    );
                    return 80042;
                }
            }

            if (!touch($this->getRunningPath() . "/.prepared")) {
                // Cannot write on directory
                error_log(
                    date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80044]
                );
                return 80044;
            }
        }

        // Run prep script on every start (not just first prepare).
        // The script runs in the node's runtime directory so relative paths work.
        $prep = isset($this->tpl['prep']) ? trim($this->tpl['prep']) : '';
        if (!empty($prep)) {
            $prepScript = '/opt/unetlab/config_scripts/' . $prep;
            if (is_executable($prepScript)) {
                $prepCmd = 'cd ' . escapeshellarg($this->getRunningPath()) .
                           ' && ' . $prepScript . ' ' .
                           escapeshellarg($this->getRunningPath()) . ' 2>&1';
                error_log(date('M d H:i:s ') . 'INFO: running prep script: ' . $prepCmd);
                exec($prepCmd, $prepOut, $prepRc);
                if ($prepRc != 0) {
                    error_log(date('M d H:i:s ') . 'WARNING: prep script returned ' .
                              $prepRc . ': ' . implode(' ', $prepOut));
                }
            }
        }
    }

    public function start()
    {
        sleep((int) $this->delay);
        $result = parent::start();
        touch($this->getRunningPath() . "/.run");
        if ($result == 0) {
            // All QEMU nodes receive the fairness weight.  Exact-1 retains
            // the persisted checkbox semantics and requests the delayed cap.
            $scope = broker_qemu_cpu_scope(
                $this->getSession(),
                (int) $this->cpu,
                $this->cpulimit == 1
            );
            if (!empty($scope['warnings']) && is_array($scope['warnings'])) {
                foreach ($scope['warnings'] as $warning) {
                    $message = is_array($warning) && isset($warning['message'])
                        ? $warning['message'] : json_encode($warning);
                    error_log(date("M d H:i:s ") .
                        "WARNING: QEMU CPU policy: " . $message);
                }
            }
            if (empty($scope['ok'])) {
                $scopeError = isset($scope['err']) ? $scope['err'] :
                    'unknown broker error';
                // CPU policy is fail-open: preserve the running node and make
                // the uncapped state grep-able for operators and support.
                error_log(date("M d H:i:s ") .
                    "WARNING: QEMU CPU policy unavailable; node continues " .
                    "uncapped: " . $scopeError);
            }
            for ($i = 0; $i < 4; $i++) {
                $socketFile = $this->getRunningPath() . "/console.sock";

                if (file_exists($socketFile)) {
                    error_log(date("M d H:i:s ") . "INFO: " . $socketFile);
                    if ($this->console == "telnet") {
                        $port = $this->getPort();
                        $cmd =
                            "/opt/unetlab/wrappers/qemu_wrapper_telnet -P " .
                            $port .
                            ' -t "' .
                            $this->name .
                            '" -- nc -U ' .
                            $socketFile .
                            " > " .
                            $this->getRunningPath() .
                            "/wrapper_telnet.txt 2>&1 &";
                        error_log(date("M d H:i:s ") . "INFO: " . $cmd);
                        exec($cmd, $o, $rc);
                    } elseif ($this->console_2nd == "telnet") {
                        $port = $this->getSecondPort();
                        $cmd =
                            "/opt/unetlab/wrappers/qemu_wrapper_telnet -P " .
                            $port .
                            ' -t "' .
                            $this->name .
                            '" -- nc -U ' .
                            $socketFile .
                            " > " .
                            $this->getRunningPath() .
                            "/wrapper_telnet.txt 2>&1 &";
                        error_log(date("M d H:i:s ") . "INFO: " . $cmd);
                        exec($cmd, $o, $rc);
                    }
                }
                if ($this->getStatus() > 0) {
                    break;
                } else {
                    sleep(1);
                }
            }

            if (
                is_file($this->getRunningPath() . "/startup-config") &&
                !is_file($this->getRunningPath() . "/.configured") &&
                $this->config != 0
            ) {
                // Start configuration process or check if bootstrap is done
                $configScript =
                    $this->config_script != ""
                        ? $this->config_script
                        : (isset($this->tpl["config_script"])
                            ? $this->tpl["config_script"]
                            : "");

                if (
                    $configScript != "" &&
                    is_file("/opt/unetlab/config_scripts/" . $configScript)
                ) {
                    touch($this->getRunningPath() . "/.lock");
                    $cmd =
                        "sudo nohup /opt/unetlab/config_scripts/" .
                        $configScript .
                        " -a put -p " .
                        $this->getPort() .
                        " -f " .
                        $this->getRunningPath() .
                        "/startup-config -t " .
                        ($this->delay + $this->getScriptTimeout()) .
                        " > " .
                        $this->getRunningPath() .
                        "/startup_config.log 2>&1 &";
                    exec($cmd, $o, $rc);
                    error_log(date("M d H:i:s ") . "INFO: importing " . $cmd);
                } else {
                    touch($this->getRunningPath() . "/.configured");
                }
            }

            $ethernets = $this->getEthernets();
            foreach ($ethernets as $ethernet) {
                if ($ethernet->getNetworkId() == 0) {
                    $ethernet->setLinkState("down");
                }
            }

            return 0;
        }

        return $result;
    }

    public function stop()
    {
        // DELETE SNAT RULE RDP,SSH,WINBOX if needed
        $result = parent::stop();
        if ($this->console == "rdp") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.1.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console_2nd == "rdp") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.2.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console == "ssh") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.3.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console_2nd == "ssh") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.4.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console == "winbox") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.5.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console_2nd == "winbox") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.6.102";
            exec($cmd, $o, $rc);
        }
        if ($this->console == "http") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.7.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console_2nd == "http") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.8.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console == "https") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.9.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console_2nd == "https") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.10.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console == "rdp-tls") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getPort() .
                " -j SNAT --to 169.254.11.102";
            exec($cmd, $o, $rc);
        }

        if ($this->console_2nd == "rdp-tls") {
            $cmd =
                "iptables -t nat -D INPUT -p tcp --dport " .
                $this->getSecondPort() .
                " -j SNAT --to 169.254.12.102";
            exec($cmd, $o, $rc);
        }
        if ($this->TPM == "tpm-tis" || $this->TPM == "tpm-crb") {
            $tpid = [];
            $cpucommand =
                "ps axw -o pid,cmd | grep " .
                $this->getSession() .
                "_swtpm-sock | cut -b -7 ";
            error_log(date("M d H:i:s ") . "INFO: " . $cpucommand);
            exec($cpucommand, $tpid, $rc);
            if ($rc == 0 && isset($tpid) && count($tpid) > 0) {
                error_log(date("M d H:i:s ") . "INFO: TPM pid is " . $tpid[0]);
                exec("sudo kill " . $tpid[0], $ro, $rc);
                error_log(date("M d H:i:s ") . "KILL TPM" . $tpid[0]);
                if (is_file($this->getRunningPath() . "tpm2-00.permall")) {
                    unlink(
                        "/tmp/" .
                            $this->getSession() .
                            "_swtpm-sock/tpm2-00.permall"
                    );
                }
            }
        }
        return $result;
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

        if (
            $this->getStatus() < 2 ||
            !isExitConfigScript($this->getTemplate())
        ) {
            // Skipping powered off nodes or unsupported nodes
            error_log(
                date("M d H:i:s ") . "WARNING: " . $GLOBALS["messages"][80084]
            );
            return 80084;
        } else {
            $timeout = 45;
            // Depending on configuration's size, export from mikrotik could take longer than 15 seconds
            if ($this->getTemplate() == "mikrotik") {
                $timeout = 45;
            }

            $configScript =
                $this->config_script != ""
                    ? $this->config_script
                    : (isset($this->tpl["config_script"])
                        ? $this->tpl["config_script"]
                        : "");
            $cmd =
                "/opt/unetlab/config_scripts/" .
                $configScript .
                " -a get -p " .
                $this->getPort() .
                " -f " .
                $tmp .
                " -t " .
                $timeout;
            exec($cmd, $o, $rc);
            error_log(date("M d H:i:s ") . "INFO: exporting " . $cmd);
            if ($rc != 0) {
                error_log(
                    date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80060]
                );
                error_log(date("M d H:i:s ") . implode("\n", $o));
                return 80060;
            }
        }

        if (!is_file($tmp)) {
            // File not found
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80062]
            );
            return 80062;
        }

        // Add no shut
        if (
            $this->getTemplate() == "csr1000vng" ||
            $this->getTemplate() == "csr1000v" ||
            $this->getTemplate() == "crv" ||
            $this->getTemplate() == "vios" ||
            $this->getTemplate() == "viosl2" ||
            $this->getTemplate() == "xrv" ||
            $this->getTemplate() == "xrv9k"
        ) {
            file_put_contents(
                $tmp,
                preg_replace(
                    '/(\ninterface.*)/',
                    '$1' . chr(10) . " no shutdown",
                    file_get_contents($tmp)
                )
            );
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
