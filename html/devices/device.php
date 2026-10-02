<?php

/**
 *
 * @author LIN
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 *
 *
 *
 * Device: device factory
 *  |
 *  |__ Device Type : extends device factory (device_iol.php, device_dynamips.php, device_qemu.php, device_docker.php, device_vpcs.php)
 *          |
 *          |__ Device Line: Extends device type (device_[device line name].php)
 *          |
 *          |__ Adapter : Line card, network module
 *
 *
 */

/**   
 * @property type $console protocol. It's optional.
 * @property type $config Filename for the startup configuration. It's optional.
 * @property type $config_data The full startup configuration. It's optional.
 * @property type $cpu CPUs configured on the node. It's optional.
 * @property type $delay Seconds before starting the node. It's optional.
 * @property type $id Device ID. It's mandatory and set during contruction phase.
 * @property type $ethernet Number of configured Ethernet interfaces/portgroups. It's optional.
 * @property type $ethernets Configured Ethernet interfaces/portgroups. It's optional.
 * @property type $icon Icon used on diagram. It's optional.
 * @property type $idlepc Idle PC for Dynamips nodes. It's optional.
 * @property type $image Image for the node. It's mandatory and automatically set to one of the available one.
 * @property type $lab_id Lab ID. It's mandatory and set during contruction phase.
 * @property type $left Left margin for visual position. It's optional.
 * @property type $name Name of the node. It's optional but suggested.
 * @property type $nvram RAM configured on the node. It's optional.
 * @property type $port Console port. It's mandatory and set during contruction phase.
 * @property type $ram NVRAM configured on the node. It's optional.
 * @property type $serial Number of configured Serial interfaces/porgroups. It's optional (IOL only)
 * @property type $serials Configured Serial interfaces/porgroups. It's optional (IOL only)
 * @property type $slots Array of configured slots. It's optional (Dynamips only)
 * @property type $template Template of the node. It's mandatory.
 * @property type $tenant Tenant ID. It's mandatory and set during contruction phase.
 * @property type $top Top margin for visual position.
 * @property type $width Cosmetic icon width in pixels. It's optional.
 * @property type $type Type of the node. It's mandatory.

 */

class device
{
    public $console;
    public $console_2nd;
    public $config;
    public $config_data;
    public $multi_config = [];
    public $config_script;
    public $cpu;
    public $cpulimit = 1;
    public $delay;
    public $ethernet;
    public $pci_mode;
    public $firstmac;
    public $icon;
    public $idlepc;
    public $image;
    public $left;
    public $name;
    public $first_nic;
    public $nvram;
    public $ram;
    public $etba;
    public $TPM;
    public $UEFI = 0;
    public $serial;
    public $script_timeout;
    public $top;
    public $width = "";
    public $terminaltype = "linux";
    public $backspace = 127;
    public $size = "";
    public $mtu = 9000;
    public $inject_as_first_nic = 0;
    public $lock = 0;
    protected $node = null;
    protected $ethernets = [];
    protected $serials = [];
    protected $modules = [];
    protected $tpl = []; // save template value

    function __construct($node)
    {
        $this->node = $node;
        try {
            $this->tpl = yaml_parse_file(
                BASE_DIR .
                    "/html/" .
                    TPL_DIR .
                    "/" .
                    $this->getTemplate() .
                    ".yml"
            );
        } catch (Exception $e) {
            throw new ResponseException("Can not load template file {data}", [
                "data" => $this->getTemplate(),
            ]);
        }
    }

    /**
     * Create and return an unique MAC address for Node
     */
    public function createNodeMac($id)
    {
        $session = $this->getSession();
        $session = sprintf("%06x", $session);
        $mac =
            "50:" .
            chunk_split($session, 2, ":") .
            "00:" .
            sprintf("%02x", $id);
        return $mac;
    }

    /**
     * Create and Return an unique the First MAC address for Node
     */
    private $createFirstMacResult = null;
    public function createFirstMac()
    {
        if (IsValidMac($this->firstmac)) {
            return $this->firstmac;
        }

        if (!$this->createFirstMacResult || $this->createFirstMacResult == "") {
            $session = $this->getSession();
            $session = sprintf("%04x", $session);
            $random = sprintf("%04x", rand(0, 16 * 16 * 16 * 16));
            $mac =
                "50:" .
                chunk_split($random, 2, ":") .
                chunk_split($session, 2, ":") .
                "00";
            $this->createFirstMacResult = $mac;
        }

        return $this->createFirstMacResult;
    }

    /**
     * Create ethernet interfaces for onboard card
     * @property quantity : number of ethernet interface
     */
    public function createEthernets($quantity)
    {
        return $this->ethernets;
    }

    /**
     * Create serial interfaces for onboard card
     * @property quantity : number of serial interface
     */
    public function createSerials($quantity)
    {
        return $this->serials;
    }

    /**
     * Add network module or card to device
     * @property slot: Slot id
     * @property subSlot: Sub-Slot id
     * @property nm: Network module name
     *
     */
    public function createModule($slot, $subSlot, $nm)
    {
        return $this->modules;
    }

    /**
     * Return all ethernets interface instances of device.
     * all interfaces in onboard and network modules
     *
     */
    public function getEthernets()
    {
        $ethernets = $this->ethernets;
        foreach ($this->modules as $module) {
            foreach ($module->getEthernets() as $ethernet) {
                $ethernets[$ethernet->getId()] = $ethernet;
            }
        }
        return $ethernets;
    }

    /**
     * Return all serials interface instances of device.
     * all interfaces in onboard and network modules
     *
     */
    public function getSerials()
    {
        $serials = $this->serials;
        foreach ($this->modules as $module) {
            foreach ($module->getserials() as $serial) {
                $serials[$serial->getId()] = $serial;
            }
        }
        return $serials;
    }

    public function getInterfaces()
    {
        return $this->getEthernets() + $this->getSerials();
    }

    /**
     *
     * Return Flag to setting all interfaces and modules
     * in comand
     */

    public function getFlag()
    {
        $flag = "";
        foreach ($this->ethernets as $eth) {
            $flag .= " " . $eth->getFlag();
        }
        foreach ($this->serials as $serial) {
            $flag .= " " . $serial->getFlag();
        }
        foreach ($this->modules as $module) {
            $flag .= " " . $module->getFlag();
        }
        return preg_replace("/\s+/m", " ", $flag);
    }

    /**
     * Return all Network Modules
     *
     */
    public function getModules()
    {
        return $this->modules;
    }

    /**
     * Return session id of node.
     * When a node is loaded system will create a unique id (session) and save in database
     * session id will be deleted when you destroy lab.
     */
    public function getSession()
    {
        return $this->node->getSession();
    }

    /**
     * Return Lab session id
     */

    public function getLabSession()
    {
        return $this->node->getLabSession();
    }

    public function getconsole()
    {
        return $this->console;
    }
    public function getconsole_2nd()
    {
        return $this->console_2nd;
    }

    /**
     *
     * Get console port of Node
     */
    public function getPort()
    {
        return $this->node->getPort();
    }

    /**
     *
     * Get secondary port of Node
     */
    public function getSecondPort()
    {
        return $this->node->getSecondPort();
    }

    /**
     * Get Remote node by id
     */
    public function getNode($id)
    {
        return $this->node->getNode($id);
    }

    /**
     * Get network by ID
     */
    public function getNetwork($id)
    {
        return $this->node->getNetwork($id);
    }

    /**
     * Return Running folder of Node
     */
    public function getRunningPath()
    {
        return $this->node->getRunningPath();
    }

    /**
     * Return Node type
     */
    public function getNType()
    {
        return $this->node->getNType();
    }

    /**
     * Return Node template name
     */

    public function getTemplate()
    {
        return $this->node->getTemplate();
    }

    /**
     * Return pod of user who create node session
     */

    public function getHost()
    {
        return $this->node->getHost();
    }

    /**
     * @return Status of node
     */

    public function getStatus()
    {
        return $this->node->getStatus();
    }

    /**
     * @return int User POD of current session
     */
    public function getTenant()
    {
        return $this->node->getTenant();
    }

    /**
     * @return int ID of node in lab
     */
    public function getId()
    {
        return $this->node->getId();
    }

    /**
     *
     *@return ScriptTimeout: the time system will wait before running script to apply start-up configuration
     * The time wait = Script Timeout + Delay
     */
    public function getScriptTimeout()
    {
        if ($this->script_timeout > 0) {
            return $this->script_timeout;
        }
        return $this->node->getScriptTimeout();
    }
    public function getIolId()
    {
        return $this->node->getIolId();
    }

    public function getCpu()
    {
        return $this->cpu;
    }
    public function getRam()
    {
        return $this->ram;
    }

    /**
     * Return parameters for a device.
     * The return data of this function will be used to save node's data to .unl file
     * or show on edit node form
     */
    public function getParams()
    {
        return [
            "config" => $this->config,
            "config_data" => base64_encode($this->config_data),
            "multi_config" => base64_encode(json_encode($this->multi_config)),
            "delay" => (int) $this->delay,
            "icon" => $this->icon,
            "console" => $this->console,
            "image" => $this->image,
            "left" => (int) $this->left,
            "name" => $this->name,
            "top" => (int) $this->top,
            "width" => $this->width,
            "size" => (int) $this->size,
            "ethernet" => (int) $this->ethernet,
            "ram" => (int) $this->ram,
            "mtu" => (int) $this->mtu,
            "backspace" => $this->backspace,
            "terminaltype" =>  $this->terminaltype,
            "lock" => (int) $this->lock,
        ];
    }

    /**
     * Using parameters get from .unl file or add edit node form to set value for device instance
     * @property p: node's params get from .unl file or add/edit node form
     *
     */

    public function editParams($p)
    {
        if (isset($p["config"])) {
            $this->config = $p["config"];
        }

        if (isset($p["config_data"])) {
            $this->config_data = base64_decode($p["config_data"]);
        }

        if (isset($p["multi_config"])) {
            try {
                $this->multi_config = json_decode(
                    base64_decode($p["multi_config"]),
                    true
                );
            } catch (Exception $th) {
                $this->multi_config = [];
            }
        }

        if (isset($p["delay"])) {
            $this->delay = (int) $p["delay"];
        }

        if (isset($p["icon"])) {
            $this->icon = $p["icon"] != "" ? $p["icon"] : "Router.png";
        }

        if (isset($p["width"])) {
            if ($p["width"] === "") {
                // An empty edit clears the cosmetic override.
                $this->width = "";
            } elseif (is_numeric($p["width"])) {
                $width = (float) $p["width"];
                if (!is_nan($width) && !is_infinite($width)) {
                    // 30px matches the canvas minimum; 512px is a generous
                    // upper bound that prevents pathological canvas geometry.
                    // Numeric zero is the reset sentinel used by the canvas.
                    $this->width = $width == 0
                        ? ""
                        : min(512, max(30, $width));
                }
            }
        }

        if (isset($p["image"])) {
            // SECURITY (docker-rebroker stage 0): unlike the metacharacter-stripped
            // name field below, $this->image is spliced UNESCAPED into root-run shell
            // strings by the docker/iol/qemu create drivers (node start runs as root
            // via broker -> unl_wrapper), so an image like  x";id>/tmp/pwn;#  was a
            // root command injection reachable by a non-admin with USER_PER_EDIT_LAB.
            // A legit image contains '/' and ':' (repo/name:tag:imageid) so we can't
            // blanket-strip like name; instead fail closed on an anchored allowlist and
            // keep the prior value on a bad match (this is the single chokepoint every
            // driver's $this->image flows through on add/edit/load-from-DB).
            if (
                preg_match(
                    '#^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?(:[0-9a-f]{12,64})?$#',
                    (string) $p["image"]
                )
            ) {
                $this->image = $p["image"];
            }
        }
        if (isset($p["left"])) {
            $this->left = $p["left"] != "" ? $p["left"] : rand(100, 924);
        }

        if (isset($p["name"])) {
            // SECURITY (review 2026-07-06): the node name is spliced UNESCAPED into
            // root-run shell commands by several device drivers (e.g. docker/ceos/
            // srlinux `docker create -h "<name>"`, `hostname <name>`), so a name like
            //   x" ; <cmd> #
            // was a root command-injection at node start. This is the single
            // chokepoint every driver's $this->name flows through (on add, edit, and
            // load-from-DB), so strip shell-dangerous metacharacters here — that
            // neutralizes the vector everywhere downstream, including any name
            // already persisted by an older build. Spaces/dots/dashes/underscores and
            // ordinary label text are preserved; only injection metacharacters go.
            $this->name = preg_replace('/[`$;|&<>(){}"\'\\\\\r\n]/', '', (string) $p["name"]);
        }

        if (isset($p["top"])) {
            $this->top = $p["top"] != "" ? $p["top"] : rand(100, 668);
        }

        if (isset($p["size"])) {
            $this->size = $p["size"];
        }
        if (isset($p["console"])) {
            $this->console = $p["console"];
            if (in_array($this->type, ["iol", "dynamips"])) {
                $this->console = "telnet";
            }
        }
        if (isset($p["ethernet"]) && $this->ethernet !== (int) $p["ethernet"]) {
            $this->ethernet = (int) $p["ethernet"];
            $this->createEthernets($this->ethernet);
        }
        if (isset($p["serial"]) && $this->serial !== (int) $p["serial"]) {
            $this->serial = (int) $p["serial"];
            // was $this->serial(...) — no such method anywhere; editing a
            // node's serial-port count fataled (mirror the ethernet branch)
            $this->createSerials($this->serial);
        }
        if (isset($p["backspace"])) {
            $this->backspace = htmlentities($p["backspace"]);
        }
        if (isset($p["terminaltype"])) {
            $this->terminaltype = htmlentities($p["terminaltype"]);
        }

        if (isset($p["ram"])) {
            $this->ram = $p["ram"] != "" ? (int) $p["ram"] : 1024;
        }
        if (isset($p["mtu"])) {
            $this->mtu = (string) $p["mtu"];
        }
        if (isset($p["lock"])) {
            $this->lock = (int) $p["lock"] === 1 ? 1 : 0;
        }
    }

    /**
     * Host part of native console URLs: the satellite's IP when this node's
     * session runs on a cluster satellite (consoles are served THERE), else
     * the master as the browser addressed it. Web-console (html5) lanes are
     * unaffected — token_mint.php points the master-side bridges itself.
     */
    private function consoleHost()
    {
        if ($this->node !== null
                && method_exists($this->node, 'getSessionHost')
                && $this->node->getSessionHost() > 0
                && function_exists('cluster_host_ip')) {
            $ip = cluster_host_ip($this->node->getSessionHost());
            if ($ip !== null) {
                return $ip;
            }
        }
        return $_SERVER['SERVER_NAME'];
    }

    /**
     * Method to get node console URL.
     *
     * @return  string                      Node console URL
     */
    public function getConsoleUrl($html5)
    {
        if ($html5 != 1) {
            switch ($this->console) {
                default:
                case "telnet":
                    return "telnet://" .
                        $this->consoleHost() .
                        ":" .
                        $this->getPort();
                    break;
                case "bash":
                    return "telnet://" .
                        $this->consoleHost() .
                        ":" .
                        $this->getPort();
                    break;
                case "ssh":
                    return "ssh://" .
                        $this->consoleHost() .
                        ":" .
                        $this->getPort();
                    break;
                case "vnc":
                    return "vnc://" .
                        $this->consoleHost() .
                        ":" .
                        $this->getPort();
                    break;
                case "rdp":
                    // Native RDP lane: emit a real rdp://host:port URL. The web
                    // client turns this into a downloadable .rdp file the local
                    // Remote Desktop client opens (pnetlab-webconsole.js
                    // downloadRdpFile). Target host:port mirror the native
                    // telnet/vnc lanes (consoleHost() = browser-reachable host,
                    // getPort() = the node RDP port guacd also dials). The old
                    // "/rdp/?target=..." path pointed at a route that never
                    // existed, so native RDP silently fell back to the web
                    // console even with HTML5 off.
                    return "rdp://" .
                        $this->consoleHost() .
                        ":" .
                        $this->getPort();
                    break;
                case "rdp-tls":
                    return "rdp://" .
                        $this->consoleHost() .
                        ":" .
                        $this->getPort();
                    break;
                case "spice":
                    return "spice://" .
                        $this->consoleHost() .
                        ":" .
                        $this->getPort();
                    break;
                case "winbox":
                    return "winbox://" .
                        $this->consoleHost() .
                        ":" .
                        $this->getPort();
                    break;
                case "http":
                    return "http://" .
                        $this->consoleHost() .
                        ":" .
                        $this->getPort();
                    break;
                case "https":
                    return "https://" .
                        $this->consoleHost() .
                        ":" .
                        $this->getPort();
                    break;
            }
        } else {
            if ($this->console == "winbox") {
                return "winbox://" .
                    $this->consoleHost() .
                    ":" .
                    $this->getPort();
            }
            if ($this->console == "http") {
                return "http://" .
                    $this->consoleHost() .
                    ":" .
                    $this->getPort();
            }
            if ($this->console == "https") {
                return "https://" .
                    $this->consoleHost() .
                    ":" .
                    $this->getPort();
            }
            if ($this->console == "spice") {
                // The web console has no SPICE lane (console-init.js/token_mint.php
                // only bridge telnet/vnc/rdp) — fall back to a native spice:// scheme
                // URL, same as winbox/http/https above. The native client pack
                // handles spice:// registration; without this carve-out html5-on
                // spice nodes got an unservable web-console URL (silent blank window).
                return "spice://" .
                    $this->consoleHost() .
                    ":" .
                    $this->getPort();
            }
            // Every other HTML5 lane (telnet/ssh/vnc/rdp) opens the built-in
            // xterm web console — Guacamole-for-telnet is retired; guacd serves only
            // RDP + the Wireshark capture lane. Mirrors getGuacConsoleLink() so the
            // node `url` (api_nodes) and picture-map hotspots point at the web console
            // instead of the dead legacy "guacamole" sentinel.
            return "/console/console.html?node=" . rawurlencode($this->getId());
        }
    }

    /**
     * Method to get node 2nd console URL.
     *
     * @return  string                      Node 2nd console URL
     */
    public function getSecondConsoleUrl($html5)
    {
        if (!isset($this->console_2nd) || $this->console_2nd == "") {
            return "";
        }

        $secondPort = $this->getSecondPort();

        if ($html5 != 1) {
            switch ($this->console_2nd) {
                default:
                case "telnet":
                    return "telnet://" .
                        $this->consoleHost() .
                        ":" .
                        $secondPort;
                    break;
                case "bash":
                    return "telnet://" .
                        $this->consoleHost() .
                        ":" .
                        $secondPort;
                    break;
                case "ssh":
                    return "ssh://" .
                        $this->consoleHost() .
                        ":" .
                        $secondPort;
                    break;
                case "vnc":
                    return "vnc://" .
                        $this->consoleHost() .
                        ":" .
                        $secondPort;
                    break;
                case "rdp":
                    // Native RDP 2nd lane → rdp://host:port (see getConsoleUrl).
                    return "rdp://" .
                        $this->consoleHost() .
                        ":" .
                        $secondPort;
                    break;
                case "rdp-tls":
                    return "rdp://" .
                        $this->consoleHost() .
                        ":" .
                        $secondPort;
                    break;
                case "spice":
                    return "spice://" .
                        $this->consoleHost() .
                        ":" .
                        $secondPort;
                    break;
                case "winbox":
                    return "winbox://" .
                        $this->consoleHost() .
                        ":" .
                        $secondPort;
                    break;
                case "http":
                    return "http://" .
                        $this->consoleHost() .
                        ":" .
                        $secondPort;
                    break;
                case "https":
                    return "https://" .
                        $this->consoleHost() .
                        ":" .
                        $secondPort;
                    break;
            }
        } else {
            if ($this->console_2nd == "winbox") {
                return "winbox://" .
                    $this->consoleHost() .
                    ":" .
                    $secondPort;
            }
            if ($this->console_2nd == "http") {
                return "http://" . $this->consoleHost() . ":" . $secondPort;
            }
            if ($this->console_2nd == "https") {
                return "https://" . $this->consoleHost() . ":" . $secondPort;
            }
            if ($this->console_2nd == "spice") {
                // 2nd SPICE lane: same web-console gap as getConsoleUrl() above —
                // fall back to native spice://host:port.
                return "spice://" . $this->consoleHost() . ":" . $secondPort;
            }
            // 2nd HTML5 console → xterm web console (retire Guacamole-for-telnet);
            // mirrors getGuacConsoleLink(2). &second=1 makes the URL open the node's
            // SECOND console lane (console_2nd / second port) — console-init.js reads
            // ?second=1 and resolves the lane from console_2nd, token_mint re-validates
            // server-side. Without it this URL opened the PRIMARY console.
            return "/console/console.html?node=" . rawurlencode($this->getId()) . "&second=1";
        }
    }

    /**
     * Probe whether a graphical-console endpoint is actually serving.
     *
     * Returns true if the TCP port is open AND a server really answers — a VNC
     * server sends an "RFB" banner immediately; an RDP/xrdp server accepts and
     * waits for the client. Returns false on connection-refused OR an immediate
     * EOF: that is exactly what a `docker -p host:5900` mapping does when nothing
     * listens on 5900 inside the container (e.g. an image that only runs xrdp) —
     * docker-proxy accepts the client then closes it. Used to auto-pick VNC vs
     * RDP for GUI Docker consoles.
     */
    private function pnqConsoleServing($host, $port)
    {
        $errno = 0;
        $errstr = "";
        $fp = @fsockopen($host, (int) $port, $errno, $errstr, 0.8);
        if (!$fp) {
            return false; // refused / unreachable
        }
        stream_set_timeout($fp, 0, 500000); // 0.5s read timeout
        $data = @fread($fp, 16);
        $meta = stream_get_meta_data($fp);
        @fclose($fp);
        // no data AND not a read-timeout => the peer closed immediately => dead backend
        if (($data === "" || $data === false) && empty($meta["timed_out"])) {
            return false;
        }
        return true; // got a banner (VNC) or stayed open waiting (RDP/xrdp) => live
    }

    /**
     *
     * Get Html console link
     * Called when user console to device in HTML console mode
     * @param int index: 1 for primary console; 2 for secondary console
     * @return string link to connect to guacamole.
     */

    public function getGuacConsoleLink($index)
    {
        // PNetLab jammy Slice-5 cutover: the in-browser ("HTML5") console now opens
        // the built-in web console instead of the Tomcat Guacamole webapp (/html5/).
        // The web console covers telnet/serial, VNC and RDP via
        // guacamole-lite/websockify/the telnet bridge (guacd kept, Tomcat stripped)
        // and mints its own short-lived tokens, so no guacdb html5AddSession / SSO
        // token is needed. http/https consoles stay a direct link; every other
        // console type opens console.html for this node, where laneOf() picks the
        // lane from the node's console type + image. The secondary console (index=2)
        // appends &second=1 so console.html opens the node's SECOND lane (console_2nd
        // / second port) — console-init.js reads ?second=1 and token_mint re-validates.
        $console = $index == 1 ? $this->console : $this->console_2nd;
        $port = $index == 1 ? $this->getPort() : $this->getSecondPort();
        if ($console == "http") {
            return "http://" . $this->consoleHost() . ":" . $port;
        }
        if ($console == "https") {
            return "https://" . $this->consoleHost() . ":" . $port;
        }
        return "/console/console.html?node=" . rawurlencode($this->getId())
            . ($index == 1 ? "" : "&second=1");
    }

    /**
     *
     * Build command to start device
     */
    public function command()
    {
        return "";
    }

    /**
     * Make device ready for starting
     */
    public function prepare()
    {
        posix_setsid();
        posix_setgid(32768);

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

            if ($this->config == "1") {
                // Node should use saved startup-config

                $activeConfig = $this->getActiveConfig();
                if ($activeConfig == "") {
                    $startupCfg = $this->config_data;
                } else {
                    $startupCfg = get($this->multi_config[$activeConfig], "");
                }

                if ($startupCfg != "") {
                    if (
                        !dumpConfig(
                            $startupCfg,
                            $this->getRunningPath() . "/startup-config"
                        )
                    ) {
                        error_log(
                            date("M d H:i:s ") .
                                "WARNING: " .
                                $GLOBALS["messages"][80067]
                        );
                    }
                }
            }
        }

        return 0;
    }

    /**
     * Make device ready for starting
     */
    public function start()
    {
        $result = $this->prepare();

        if ($result > 0) {
            return $result;
        }

        if (!chdir($this->getRunningPath())) {
            // Failed to change directory
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][80047]
            );
            return 80047;
        }

        $cmd = $this->command();

        if ($this->type == "qemu") {
            // check vm / bare for vmx passthrough
            if (HYPERVISOR == "vm") {
                $cmd = preg_replace(
                    "/-cpu *host/",
                    "-cpu host,vmx=off,svm=off",
                    $cmd
                );
                $cmd = preg_replace(
                    "/vmx=off,smv=off([A-Za-z])/",
                    'vmx=off,svm=off,\1',
                    $cmd
                );
            }
        }
        if (is_file($this->getRunningPath() . "/.hibernated")) {
            $flags = " -loadvm pnet-snapshot ";
            unlink($this->getRunningPath() . "/.hibernated");
            $cmd = $cmd . $flags;
        }
        $cmd = secureCmd($cmd) . " 2>&1 &";
        if (!isset($cmd) || $cmd == "") {
            return;
        }
        $cmd = preg_replace("/\s+/m", " ", $cmd);

        error_log(date("M d H:i:s ") . "INFO: CWD is " . getcwd());
        error_log(date("M d H:i:s ") . "INFO: starting " . $cmd);
        // Clean TCP port
        exec("fuser -k -n tcp " . $this->getPort());
        exec($cmd, $o, $rcp);

        if ($rcp == 0 && $this->type != "docker") {
            $ethernets = $this->getEthernets();
            touch($this->getRunningPath() . "/.links_up");
            foreach ($ethernets as $ethernet) {
                if (count($ethernet->getQuality()) > 0) {
                    $ethernet->applyQuality();
                }
                if ($ethernet->getSuspendStatus() == 1) {
                    $ethernet->applySuspendStatus();
                }
            }
        }

        return $rcp;
    }

    /**
     * stop device
     *
     */
    public function stop()
    {
        if ($this->getStatus() != 0) {
            if ($this->getNType() == "docker") {
                // Container stop rides the broker's typed docker_stop verb
                // (Stage 2 verb; name derived broker-side from the session id)
                // instead of the old `sudo docker stop` shell string.
                error_log(date("M d H:i:s ") . "INFO: stopping docker" .
                    $this->getSession() . " via broker docker_stop");
                broker_docker_stop($this->getSession());
                // Kill the persistent console bridge for this node. The bridge
                // (docker_console.sh -> docker_console.py) lives independently of
                // container state and only self-exits when the container is DELETED
                // (wipe), not merely stopped. If left running across a stop, every
                // web-console reconnect forks `docker exec` against the now-stopped
                // container and streams "Error response from daemon: container <id>
                // is not running" until the node is wiped. start() relaunches a
                // fresh bridge, so tearing it down on stop is safe. The regex
                // "docker_console.(py|sh) <port> docker<session> " matches BOTH the
                // sudo .sh parent and the .py listener and, by anchoring the exact
                // "docker<session> " arg (trailing space before the attach cmd),
                // never hits a node whose name is a prefix of this one
                // (docker8 vs docker87).
                $bridgeCmd =
                    "sudo pkill -f " .
                    escapeshellarg(
                        "docker_console\\.(py|sh) [0-9]+ docker" .
                            $this->getSession() .
                            " "
                    );
                error_log(date("M d H:i:s ") . "INFO: stopping console bridge " . $bridgeCmd);
                exec($bridgeCmd, $bo, $brc);
            } else {
                $cmd = "sudo fuser -k -n file " . $this->getRunningPath();
                error_log(date("M d H:i:s ") . "INFO: stopping " . $cmd);
                exec($cmd, $o, $rc);
            }

            if ($this->getStatus() != 0) {
                if ($this->command() != "") {
                    $cmd = 'sudo pkill -term  \'' . $this->command() . '\'';
                    error_log(date("M d H:i:s ") . "INFO: stopping " . $cmd);
                    exec($cmd, $o, $rc);
                }
            }
            usleep(200000); //sleep waiting for vnet free
            #-----------------------------------------------------------------------------------------------------------------------------------------#
            if (!empty($this->getSerials())) {
                $cmd =
                    "sudo ip link | grep ser" .
                    $this->getSession() .
                    '_ | sed \'s/.*\(ser[0-9]\+_[0-9]\+\).*/\1/g\' | while read line; do sudo ip link set $line down ; sudo ip link delete $line ; sudo tunctl -d $line  ; done';
                //error_log(date('M d H:i:s ') . 'ERROR: ' . $cmd);
                exec($cmd, $o, $rc);
            }
            if (!empty($this->getEthernets())) {
                $cmd =
                    "sudo ip link | grep vunl" .
                    $this->getSession() .
                    '_ | sed \'s/.*\(vunl[0-9]\+_[0-9]\+\).*/\1/g\' | while read line; do sudo ip link set $line down ; sudo ip link delete $line ; sudo tunctl -d $line  ; done';
                //error_log(date('M d H:i:s ') . 'ERROR: ' . $cmd);
                exec($cmd, $o, $rc);
            }
            usleep(200000); //sleep waiting for vnet free
            $cmd =
                'sudo ip link  show | grep vnet |  grep DOWN | sed \'s/.*\(vnet[0-9]\+_[0-9]\+\).*/\1/g\' |  while read line; do sudo ifconfig $line down; sudo brctl delbr $line; done';
            // error_log(date('M d H:i:s ') . 'ERROR: ' . $cmd);
            exec($cmd, $o, $rc);

            return 0;
        }

        return 0;
    }
    /*
     * shutdown all nic of node
     *
     */
    public function isolate()
    {
        $interfaces = $this->getInterfaces();
        if (is_file($this->getRunningPath() . "/.links_up")) {
            foreach ($interfaces as $interface) {
                $interface->setSuspendStatus_all_Nics("1");
            }
            touch($this->getRunningPath() . "/.links_down");
            unlink($this->getRunningPath() . "/.links_up");

        } else {
            foreach ($interfaces as $interface) {
                $interface->setSuspendStatus_all_Nics("0");
            }
            unlink($this->getRunningPath() . "/.links_down");
            touch($this->getRunningPath() . "/.links_up");
        }
    }
    

    /**
     * Export configuration
     */

    public function export()
    {
        return 0;
    }

    /**
     * @return multi_config_active Config actived of Lab
     **/
    public function getActiveConfig()
    {
        return $this->node->getActiveConfig();
    }

    /**
     * Wipe Node
     */

    public function wipe()
    {
        $runningPath = $this->getRunningPath();
        if ($runningPath != null && $runningPath != "") {
            $cmd = "sudo rm -rf " . $runningPath;
            exec($cmd, $o, $rc);
        }

        return 0;
    }

    public function __get($name)
    {
        return isset($this->$name) ? $this->name : "";
    }
}
