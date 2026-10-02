<?php

/**
 *
 * @author LIN
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 *
 */

class Interfc
{
    private $id;
    private $name;
    private $networks = [];

    private $network_id;
    private $remote_id;
    private $remote_if;
    private $type; // serial or ethernet
    private $socket_file; // socket file for serial
    private $flag = "";

    private $style; // border style
    private $linkstyle; // link style
    private $color; //link color
    private $label; // link label
    private $linkcfg; // link configuration
    private $srcpos;
    private $dstpos;
    private $labelpos;
    private $width;
    private $fontsize;
    private $curviness;
    private $round;
    private $device;
    private $vid = 1;          // access VLAN / trunk native VLAN
    private $vlanmode = "access"; // dot1q port mode: access | trunk
    private $vlans = "";       // dot1q trunk allowed VLAN list (e.g. "10,20,30-39")

    private $if_session; // session data

    public function __construct($device, $p, $id)
    {
        // Mandatory parameters
        if (!isset($p["type"])) {
            // Missing mandatory parameters
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][10000]
            );
            throw new Exception("10000");
            return 10000;
        }
        if (!checkInterfcType($p["type"])) {
            // Type is not valid
            error_log(
                date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][10001]
            );
            throw new Exception("10001");
            return 10001;
        }
        // Now building the interface
        $this->id = (int) $id;
        $this->type = $p["type"];
        $this->device = $device;
        $this->edit($p);
    }
    /**
     * Method to add or replace the interface metadata.
     * Editable attributes:
     * - left
     * - name
     * - top
     * If an attribute is set and is valid, then it will be used. If an
     * attribute is not set, then the original is maintained. If in attribute
     * is set and empty '', then the current one is deleted.
     *
     * @param   Array   $p                  Parameters
     * @return  int                         0 means ok
     */
    public function edit($p)
    {
        if (isset($p["networks"])) {
            $this->networks = $p["networks"];
        }

        $this->setInterfaceStyle($p);

        if (isset($p["name"]) && $p["name"] === "") {
            $this->name = "";
            throw new Exception("No interface Name");
        } elseif (isset($p["name"])) {
            $this->name = htmlentities($p["name"]);
        }

        if ($this->type == "ethernet") {
            if (isset($p["remote_id"]) || isset($p["remote_if"])) {
                unset($p["remote_id"]);
                unset($p["remote_if"]);
                error_log(
                    date("M d H:i:s ") .
                        "WARNING: " .
                        $GLOBALS["messages"][10004]
                );
            }

            if (isset($p["network_id"]) && $p["network_id"] === "") {
                // Remote network is empty, unset the current one
                unset($this->network_id);
            } elseif (isset($p["network_id"]) && (int) $p["network_id"] <= 0) {
                throw new Exception("Network ID is not valid");
            } elseif (isset($p["network_id"])) {
                $this->network_id = (int) $p["network_id"];
            }
        }

        if ($this->type == "serial") {
            if (isset($p["network_id"])) {
                unset($p["network_id"]);
                error_log(
                    date("M d H:i:s ") .
                        "WARNING: " .
                        $GLOBALS["messages"][10005]
                );
            }

            if (isset($p["remote_id"]) && $p["remote_id"] === "") {
                // Remote node ID is empty, unset the current one
                unset($this->remote_id);
                unset($this->remote_if);
            } else {
                if (isset($p["remote_id"]) && (int) $p["remote_id"] <= 0) {
                    // Remote ID is not valid
                    throw new Exception("Remote ID is not valid");
                } elseif (isset($p["remote_id"])) {
                    $this->remote_id = (int) $p["remote_id"];
                }

                if (isset($p["remote_if"]) && (int) $p["remote_if"] < 0) {
                    // Remote IF is not valid
                    throw new Exception("Remote IF is not valid");
                } elseif (isset($p["remote_if"])) {
                    $this->remote_if = (int) $p["remote_if"];
                }

                if (isset($p["socket_file"])) {
                    $this->socket_file = $p["socket_file"];
                }
            }
        }

        if (isset($p["flag"])) {
            $this->flag = $p["flag"];
        }
        if (isset($p["vid"])) {
            $this->vid = $p["vid"];
        }
        if (isset($p["vlanmode"]) && ($p["vlanmode"] == "access" || $p["vlanmode"] == "trunk")) {
            $this->vlanmode = $p["vlanmode"];
        }
        if (isset($p["vlans"])) {
            $this->vlans = $p["vlans"];
        }

        return 0;
    }

    public function addIfSession($labSessionId, $nodeSessionId, $ifSessions)
    {
        if (isset($ifSessions[$nodeSessionId . "_" . $this->id])) {
            $this->if_session = $ifSessions[$nodeSessionId . "_" . $this->id];
            return;
        }

        $ifModel = loadModel("if_sessions");
        $this->if_session = [
            IF_SESSION_LAB => $labSessionId,
            IF_SESSION_NODE => $nodeSessionId,
            IF_SESSION_IFID => $this->id,
            IF_SESSION_TYPE => $this->type,
        ];
        $result = $ifModel->insert($this->if_session);
        return $result;
    }

    /**
     * Method to get network name.
     *
     * @return  string                      ID
     */
    public function getId()
    {
        if (isset($this->id)) {
            return $this->id;
        } else {
            // By default return an empty string
            return "";
        }
    }

    /**
     * Method to get network name.
     *
     * @return  string                      Network name
     */
    public function getName()
    {
        if (isset($this->name)) {
            return $this->name;
        } else {
            // By default return an empty string
            return "";
        }
    }

    /**
     * Method to get remote network ID.
     *
     * @return	string                      Remote network ID or 0 if not set or not "ethernet" type
     */
    public function getNetworkId()
    {
        if ($this->type == "ethernet" && isset($this->network_id)) {
            return $this->network_id;
        } else {
            return 0;
        }
    }

    public function getVlanId()
    {
        if ($this->type == "ethernet" && isset($this->vid)) {
            return $this->vid;
        } else {
            return 0;
        }
        //return $this->vid;
    }

    public function getVlanMode()
    {
        return ($this->type == "ethernet" && isset($this->vlanmode))
            ? $this->vlanmode : "access";
    }

    public function getVlans()
    {
        return ($this->type == "ethernet" && isset($this->vlans))
            ? $this->vlans : "";
    }

    /**
     * Method to get interface type.
     *
     * @return	string                      Interface type
     */
    public function getNType()
    {
        return $this->type;
    }

    /**
     * Method to get remote node ID.
     *
     * @return	int                         Remote node ID or 0 if not connected or not "serial" type
     */
    public function getRemoteId()
    {
        if ($this->type == "serial" && isset($this->remote_id)) {
            return $this->remote_id;
        } else {
            return 0;
        }
    }

    /**
     * Method to get remote interface ID.
     *
     * @return	int                         Remote interface ID or 0 if not connected or not "serial" type
     */
    public function getRemoteIf()
    {
        if ($this->type == "serial" && isset($this->remote_if)) {
            return $this->remote_if;
        } else {
            return 0;
        }
    }

    public function getStyle()
    {
        return $this->style;
    }

    public function getLinkstyle()
    {
        return $this->linkstyle;
    }

    public function getColor()
    {
        return $this->color;
    }

    public function getLabel()
    {
        return $this->label;
    }

    public function getLinkcfg()
    {
        return $this->linkcfg;
    }

    public function getLabelpos()
    {
        return $this->labelpos;
    }

    public function getSrcpos()
    {
        return $this->srcpos;
    }

    public function getDstpos()
    {
        return $this->dstpos;
    }

    public function getSocketFile()
    {
        return $this->socket_file;
    }

    public function getFlag()
    {
        return $this->flag;
    }

    /** Functions for interface style */
    public function setInterfaceStyle($p)
    {
        if (isset($p["style"])) {
            $this->style = $p["style"];
        }
        if (isset($p["linkstyle"])) {
            $this->linkstyle = $p["linkstyle"];
        }
        if (isset($p["color"])) {
            $this->color = $p["color"];
        }
        if (isset($p["label"])) {
            $this->label = $p["label"];
        }
        if (isset($p["linkcfg"])) {
            $this->linkcfg = $p["linkcfg"];
        }
        if (isset($p["labelpos"])) {
            $this->labelpos = $p["labelpos"];
        }
        if (isset($p["srcpos"])) {
            $this->srcpos = $p["srcpos"];
        }
        if (isset($p["dstpos"])) {
            $this->dstpos = $p["dstpos"];
        }
        if (isset($p["width"])) {
            $this->width = $p["width"];
        }
        if (isset($p["fontsize"])) {
            $this->fontsize = $p["fontsize"];
        }
        if (isset($p["curviness"])) {
            if ($p["curviness"] === "") {
                $this->curviness = "";
            } elseif (is_numeric($p["curviness"])) {
                $curviness = (float) $p["curviness"];
                if (!is_nan($curviness) && !is_infinite($curviness)) {
                    $this->curviness = min(100, max(0, $curviness));
                }
            }
        }
        if (isset($p["round"])) {
            if ($p["round"] === "") {
                $this->round = "";
            } elseif (is_numeric($p["round"])) {
                $round = (float) $p["round"];
                if (!is_nan($round) && !is_infinite($round)) {
                    $this->round = min(50, max(0, $round));
                }
            }
        }
    }
    /** Functions for set interface vlan */

    public function setvlan($p, $n)
    {
        if (isset($p["Vlan"])) {
            $this->vid = $p["Vlan"];
        }
        // dot1q switch port: mode/native/allowed-list
        if (isset($p["mode"]) && ($p["mode"] == "access" || $p["mode"] == "trunk")) {
            $this->vlanmode = $p["mode"];
        }
        if (isset($p["native"]) && $p["native"] !== "") {
            $this->vid = $p["native"];
        }
        if (isset($p["vlans"])) {
            $this->vlans = $p["vlans"];
        }
        $this->applyVlan($n);
    }
    /** Functions for unset interface vlan */

    public function unsetvlan($p, $n)
    {
        if (isset($p["Vlan"])) {
            $this->vid = $p["Vlan"];
        }
        $this->unapplyVlan($n);
    }

    /** Functions for interface style */

    public function getInterfaceStyle()
    {
        return [
            "style" => get($this->style, ""),
            "linkstyle" => get($this->linkstyle, ""),
            "color" => get($this->color, ""),
            "label" => get($this->label, ""),
            "linkcfg" => get($this->linkcfg, ""),
            "labelpos" => get($this->labelpos, ""),
            "srcpos" => get($this->srcpos, ""),
            "dstpos" => get($this->dstpos, ""),
            "width" => get($this->width, ""),
            "fontsize" => get($this->fontsize, ""),
            "curviness" => get($this->curviness, ""),
            "round" => get($this->round, ""),
        ];
    }

    /** Functions for interface quality */
    /**
     * @param Quality data
     * @return Update quality data to interface session in database. Deploy configuration to system
     * Is called when user set quality for interface
     */
    public function setQuality($p)
    {
        // Basic impairments + the advanced netem knobs (all optional). Only keys
        // actually present are stored, so an empty field clears that knob.
        $dataArray = [];
        $qualityKeys = [
            "delay", "jitter", "bandwidth", "loss",
            "dist", "loss_mode", "delay_corr", "loss_corr",
            "duplicate", "dup_corr", "corrupt",
            "reorder", "reorder_corr", "gap", "limit",
        ];
        foreach ($qualityKeys as $k) {
            if (isset($p[$k])) {
                $dataArray[$k] = $p[$k];
            }
        }
        $data = json_encode($dataArray);

        $hadPrior = array_key_exists(IF_SESSION_QUALITY, $this->if_session);
        $prior = $hadPrior ? $this->if_session[IF_SESSION_QUALITY] : null;
        $restoreMemory = function () use ($hadPrior, $prior) {
            if ($hadPrior) {
                $this->if_session[IF_SESSION_QUALITY] = $prior;
            } else {
                unset($this->if_session[IF_SESSION_QUALITY]);
            }
        };

        // applyQuality reads the staged candidate. Publish it to the database
        // only after the live kernel operation succeeds.
        $this->if_session[IF_SESSION_QUALITY] = $data;
        $apply = $this->applyQuality();
        if ($apply !== 0) {
            $restoreMemory();
            $rollback = $this->applyQuality();
            if ($rollback !== 0) {
                throw new RuntimeException($apply . "; quality rollback failed: " . $rollback);
            }
            throw new RuntimeException($apply);
        }

        if (isset($this->if_session[IF_SESSION_NODE]) &&
            isset($this->if_session[IF_SESSION_IFID])) {
            try {
                $ifModel = loadModel("if_sessions");
                $result = $ifModel->update(
                    [IF_SESSION_QUALITY => $data],
                    [
                        [IF_SESSION_NODE, "=", $this->if_session[IF_SESSION_NODE]],
                        [IF_SESSION_IFID, "=", $this->if_session[IF_SESSION_IFID]],
                    ]
                );
                if (!$result) {
                    throw new RuntimeException("quality database update failed");
                }
            } catch (Throwable $e) {
                $restoreMemory();
                $rollback = $this->applyQuality();
                if ($rollback !== 0) {
                    throw new RuntimeException(
                        "quality database update failed and kernel rollback failed: " . $rollback,
                        0,
                        $e
                    );
                }
                throw $e;
            }
        }
        return 0;
    }

    /**
     * Remote quality data from interface session in database
     * Is called when user unlink a interface
     */
    public function removeQuality()
    {
        $ifModel = loadModel("if_sessions");
        if (
            isset($this->if_session[IF_SESSION_NODE]) &&
            isset($this->if_session[IF_SESSION_IFID])
        ) {
            $result = $ifModel->update(
                [
                    IF_SESSION_QUALITY => null,
                ],
                [
                    [IF_SESSION_NODE, "=", $this->if_session[IF_SESSION_NODE]],
                    [IF_SESSION_IFID, "=", $this->if_session[IF_SESSION_IFID]],
                ]
            );

            if ($result) {
                $this->if_session[IF_SESSION_QUALITY] = null;
                return true;
            }
        }
    }

    /**
     * @return Quality configuration of interface
     */
    public function getQuality()
    {
        if (isset($this->if_session[IF_SESSION_QUALITY])) {
            $quality = json_decode($this->if_session[IF_SESSION_QUALITY], true);
            if (!$quality) {
                $quality = [];
            }

            return $quality;
        }
        return [];
    }

    /**
     * Apply quality configuration to system
     * Is called when user set quality to interface and node is started
     */
    public function applyQuality()
    {
        if ($this->type == "serial") {
            return 0;
        }
        $vunl = "vunl" . $this->if_session[IF_SESSION_NODE] . "_" . $this->id;
        if (!isInterface($vunl)) {
            return 0;
        }

        $p = $this->getQuality();
        $delay = "";
        if (isset($p["delay"]) && $p["delay"] != "") {
            $delay = " delay " . $p["delay"] . "ms";
            if (isset($p["jitter"]) && $p["jitter"] != "") {
                $delay .= " " . $p["jitter"] . "ms";
            }
        }

        $loss = "";
        if (isset($p["loss"]) && $p["loss"] != "") {
            $loss = " loss " . $p["loss"] . "%";
        }

        $bandwidth = "";
        if (isset($p["bandwidth"]) && $p["bandwidth"] != "") {
            $bandwidth = " rate " . $p["bandwidth"] . "Kbit";
        }

        // B7: `sudo tc qdisc` no-ops as www-data, so jitter/latency/loss/rate
        // never reached the kernel (link quality silently ignored). Apply the
        // netem qdisc through the broker, which builds the command from these
        // validated numbers as root.
        $g = function ($k) use ($p) { return isset($p[$k]) ? $p[$k] : ''; };
        $resp = broker_call('netem_set', array(
            'name'   => $vunl,
            'delay'  => $g('delay'),
            'jitter' => $g('jitter'),
            'loss'   => $g('loss'),
            'rate'   => $g('bandwidth'),
            // advanced netem knobs (broker validates + ignores blanks)
            'dist'         => $g('dist'),
            'loss_mode'    => $g('loss_mode'),
            'delay_corr'   => $g('delay_corr'),
            'loss_corr'    => $g('loss_corr'),
            'duplicate'    => $g('duplicate'),
            'dup_corr'     => $g('dup_corr'),
            'corrupt'      => $g('corrupt'),
            'reorder'      => $g('reorder'),
            'reorder_corr' => $g('reorder_corr'),
            'gap'          => $g('gap'),
            'limit'        => $g('limit'),
        ));
        if (!$resp['ok'] || $resp['rc'] != 0) {
            error_log(date("M d H:i:s ") . "ERROR: set quality interface fail: " . $vunl);
            error_log(date("M d H:i:s ") . $resp['err'] . ' ' . implode("\n", $resp['out']));
            return "set quality interface fail: " . $vunl;
        }

        return 0;
    }

    /**
     * Function to apply vlan for interface
     */

    public function applyVlan($network)
    {
        // B7: the `sudo ip link ... vlan_filtering` + `sudo bridge vlan` calls
        // no-op as www-data, so per-interface VLANs were silently ignored.
        // The broker performs the filtering toggle + PVID rules as root.
        $net = $this->networks[$network];
        $netName = $net->getSysName();
        $vlan = $this->getVlanId();
        $vunl = "vunl" . $this->if_session[IF_SESSION_NODE] . "_" . $this->id;
        // dot1q switch AND wireless cell: both are vlan_filtering bridges, so a
        // port carries the full per-port access/trunk model. On a wireless cell
        // the AP uplink is a TRUNK (every SSID's VLAN, native = AP mgmt) and the
        // wired lab nodes are per-VLAN access ports.
        if (method_exists($net, 'getNType')
            && ($net->getNType() == 'dot1q' || $net->getNType() == 'wireless')) {
            // Wireless cell with SSIDs: EVERY attached port (the AP uplink AND wired
            // lab nodes such as a switch/router) must carry the cell's SSID VLANs,
            // otherwise a wired node cabled to the cell never sees a tagged SSID's
            // traffic (its port would default to access VLAN 1 and tagged frames get
            // dropped at the vlan_filtering bridge). Trunk the port: native = the
            // management VLAN (untagged), plus every SSID's VLAN tagged. This mirrors
            // the AP's own self-trunk (device_wifiap::applyApTrunk) for all cell ports.
            if ($net->getNType() == 'wireless'
                && function_exists('broker_call')
                && preg_match('/^vnet(\d+)_(\d+)$/', $netName, $m)) {
                $resp = @broker_call('wifi_cell_get', array(
                    'session' => intval($m[1]),
                    'net_id'  => intval($m[2]),
                ));
                if (!empty($resp['ok']) && !empty($resp['out'][0])) {
                    $cfg = json_decode($resp['out'][0], true);
                    if (is_array($cfg) && !empty($cfg['wlans'])) {
                        $mgmt = isset($cfg['mgmt_vlan']) ? intval($cfg['mgmt_vlan']) : 1;
                        if ($mgmt < 1) $mgmt = 1;
                        $vids = array($mgmt);
                        foreach ($cfg['wlans'] as $w) {
                            if (isset($w['vlan']) && intval($w['vlan']) > 0) {
                                $vids[] = intval($w['vlan']);
                            }
                        }
                        $vids = array_values(array_unique($vids));
                        broker_call('iface_vlan', array(
                            'action' => 'set',
                            'bridge' => $netName,
                            'tap'    => $vunl,
                            'mode'   => 'trunk',
                            'native' => $mgmt,
                            'vlans'  => implode(',', $vids),
                        ));
                        return 0;
                    }
                }
            }
            if ($this->getVlanMode() == 'trunk') {
                broker_call('iface_vlan', array(
                    'action' => 'set',
                    'bridge' => $netName,
                    'tap'    => $vunl,
                    'mode'   => 'trunk',
                    'native' => intval($vlan) > 0 ? intval($vlan) : 1,
                    'vlans'  => $this->getVlans(),
                ));
            } else {
                broker_call('iface_vlan', array(
                    'action' => 'set',
                    'bridge' => $netName,
                    'tap'    => $vunl,
                    'mode'   => 'access',
                    'pvid'   => intval($vlan) > 0 ? intval($vlan) : 1,
                ));
            }
            return 0;
        }
        // legacy smart-bridge single-vid path
        broker_call('iface_vlan', array(
            'action' => 'set',
            'bridge' => $netName,
            'tap'    => $vunl,
            'vid'    => intval($vlan),
        ));
        return 0;
    }
    /**
     * Function to unapply vlan for interface
     */

    public function unapplyVlan($network)
    {
        $netName = $this->networks[$network]->getSysName();
        $vunl = "vunl" . $this->if_session[IF_SESSION_NODE] . "_" . $this->id;
        broker_call('iface_vlan', array(
            'action' => 'clear',
            'bridge' => $netName,
            'tap'    => $vunl,
        ));
        return 0;
    }

    /**
     * Function to unset quality of interface
     */
    public function unApplyQuality()
    {
        if ($this->type == "serial") {
            return 0;
        }
        $vunl = "vunl" . $this->if_session[IF_SESSION_NODE] . "_" . $this->id;
        // B7: `sudo tc qdisc del` no-ops as www-data; clear via the broker.
        $resp = broker_call('netem_del', array('name' => $vunl));
        if (!$resp['ok'] || $resp['rc'] != 0) {
            error_log(date("M d H:i:s ") . "ERROR: unset quality interface fail: " . $vunl);
            error_log(date("M d H:i:s ") . $resp['err'] . ' ' . implode("\n", $resp['out']));
            return "unset quality interface fail: " . $vunl;
        }
        return 0;
    }


    /** Functions for interface suspend */
    /**
     * @param int Status: 0 is normal 1 is suppend
     *
     */
    private function persistSuspendStatus($status)
    {
        $ifModel = loadModel("if_sessions");
        if (
            isset($this->if_session[IF_SESSION_NODE]) &&
            isset($this->if_session[IF_SESSION_IFID])
        ) {
            $result = $ifModel->update(
                [
                    IF_SESSION_SUSPEND => $status ? "1" : "0",
                ],
                [
                    [IF_SESSION_NODE, "=", $this->if_session[IF_SESSION_NODE]],
                    [IF_SESSION_IFID, "=", $this->if_session[IF_SESSION_IFID]],
                ]
            );

            if ($result) {
                $this->if_session[IF_SESSION_SUSPEND] = $status;
                return true;
            }
        }
        return false;
    }

    public function setSuspendStatus($status)
    {
        // Resume must clear the stored intent before plug() is attempted.  A
        // failed plug must not leave a row that can never be cleared.
        if (!$status) {
            $persisted = $this->persistSuspendStatus($status);
            if (!$persisted) {
                error_log(date("M d H:i:s ") . "ERROR: unable to clear suspend status for " . $this->getSysName());
            }
            return $this->applySuspendStatus();
        }

        // Keep the serial lane's write-before-apply behaviour unchanged.
        if ($this->type == "serial") {
            $persisted = $this->persistSuspendStatus($status);
            if (!$persisted) {
                error_log(date("M d H:i:s ") . "ERROR: unable to persist suspend status for " . $this->getSysName());
            }
            return $this->applySuspendStatus();
        }

        // Ethernet suspend is recorded only after bridge detachment succeeds.
        $rc = $this->suspend();
        if ($rc === 0) {
            $persisted = $this->persistSuspendStatus($status);
            if (!$persisted) {
                error_log(date("M d H:i:s ") . "ERROR: suspend enforced but status could not be persisted for " . $this->getSysName());
            }
        } else {
            // Clear an old/stuck 1 as well as refusing to write a new one.
            $cleared = $this->persistSuspendStatus(0);
            if (!$cleared) {
                error_log(date("M d H:i:s ") . "ERROR: failed suspend could not clear stored status for " . $this->getSysName());
            }
            error_log(date("M d H:i:s ") . "ERROR: suspend requested but not enforced for " . $this->getSysName() . " (rc=" . $rc . ")");
        }
        return $rc;
    }

    /** Functions for interface suspend to all nics */
    /**
     * @param int Status: 0 is normal 1 is suppend
     *
     */
    public function setSuspendStatus_all_Nics($status)
    {
        // The all-NIC resume path also clears first; unplug()/plug() are not
        // symmetric, and a failed plug must not strand the database flag.
        if (!$status) {
            $persisted = $this->persistSuspendStatus($status);
            if (!$persisted) {
                error_log(date("M d H:i:s ") . "ERROR: unable to clear suspend status for " . $this->getSysName());
            }
            return $this->applySuspendStatus_all_nics();
        }

        // Keep the serial lane's write-before-apply behaviour unchanged.
        if ($this->type == "serial") {
            $persisted = $this->persistSuspendStatus($status);
            if (!$persisted) {
                error_log(date("M d H:i:s ") . "ERROR: unable to persist suspend status for " . $this->getSysName());
            }
            return $this->applySuspendStatus_all_nics();
        }

        // Isolate/all-NIC suspend uses unplug(), so apply the same
        // enforce-before-persist rule as the per-NIC suspend() lane.
        $rc = $this->unplug();
        if ($rc === 0) {
            $persisted = $this->persistSuspendStatus($status);
            if (!$persisted) {
                error_log(date("M d H:i:s ") . "ERROR: suspend enforced but status could not be persisted for " . $this->getSysName());
            }
        } else {
            $cleared = $this->persistSuspendStatus(0);
            if (!$cleared) {
                error_log(date("M d H:i:s ") . "ERROR: failed suspend could not clear stored status for " . $this->getSysName());
            }
            error_log(date("M d H:i:s ") . "ERROR: suspend requested but not enforced for " . $this->getSysName() . " (all-NIC rc=" . $rc . ")");
        }
        return $rc;
    }

    /**
     * Remote suspend data from interface session in database
     * Is called when user unlink a interface
     */
    public function removeSuspendStatus()
    {
        $ifModel = loadModel("if_sessions");
        if (
            isset($this->if_session[IF_SESSION_NODE]) &&
            isset($this->if_session[IF_SESSION_IFID])
        ) {
            $result = $ifModel->update(
                [
                    IF_SESSION_SUSPEND => null,
                ],
                [
                    [IF_SESSION_NODE, "=", $this->if_session[IF_SESSION_NODE]],
                    [IF_SESSION_IFID, "=", $this->if_session[IF_SESSION_IFID]],
                ]
            );

            if ($result) {
                $this->if_session[IF_SESSION_QUALITY] = null;
                return true;
            }
        }
    }

    /**
     * @return int configuration of interface
     */
    public function getSuspendStatus()
    {
        return get($this->if_session[IF_SESSION_SUSPEND], 0);
    }

    /**
     * Apply suspend status configuration to system
     * Is called when user set suspend status to interface and node is started
     */
    public function applySuspendStatus()
    {
        $suspendStatus = $this->getSuspendStatus();
        if ($this->type == "serial") {
            if ($suspendStatus == 1) {
                return $this->setLinkState("down");
            } else {
                return $this->unApplySuspendStatus();
            }
        } else {
            $vunl = $this->getSysName();
            if (!isInterface($vunl)) {
                if ($suspendStatus == 1) {
                    error_log(date("M d H:i:s ") . "ERROR: suspend interface is not present: " . $vunl);
                    return 1;
                }
                return 0;
            }
            if ($suspendStatus == 1) {
                return $this->suspend();
            } else {
                return $this->unApplySuspendStatus();
            }
        }

        return 0;
    }
    /**
     * Apply suspend status configuration to system
     * Is called when user set suspend status to  node interfaces and node is started
     */

    public function applySuspendStatus_all_nics()
    {
        $suspendStatus = $this->getSuspendStatus();
        if ($this->type == "serial") {
            if ($suspendStatus == 1) {
                return $this->setLinkState("down");
            } else {
                return $this->unApplySuspendStatus();
            }
        } else {
            $vunl = $this->getSysName();
            if (!isInterface($vunl)) {
                if ($suspendStatus == 1) {
                    error_log(date("M d H:i:s ") . "ERROR: all-NIC suspend interface is not present: " . $vunl);
                    return 1;
                }
                return 0;
            }
            if ($suspendStatus == 1) {
                return $this->unplug();
            } else {
                return $this->unApplySuspendStatus();
            }
        }
        return 0;
    }

    /** * Function to unset suspend status of interface */
    public function unApplySuspendStatus()
    {
        if ($this->type == "serial") {
            return $this->setLinkState("up");
        }
        return $this->plug();
    }
    /** Function for hot Link */
    public function plug()
    {
        if ($this->type == "serial") {
            return 0;
        }
        if (isset($this->networks[$this->network_id])) {
            $netName = $this->networks[$this->network_id]->getSysName();
        } else {
            return 0;
        }
        $vunl = $this->getSysName();

        if (!isInterface($netName)) {
            $rc1 = addBridge([
                "name" => $netName,
                "type" => $this->networks[$this->network_id]->getNType(),
                "count" => $this->networks[$this->network_id]->getcount(),
            ]);
        }
        $rc = connectInterface($netName, $vunl);
        $this->setLinkState("up");
        return $rc;
    }

    /** Function for suspend Link without delete bridge */

    public function suspend()
    {
        if ($this->type == "serial") {
            return 0;
        }

        if (isset($this->networks[$this->network_id])) {
            $netName = $this->networks[$this->network_id]->getSysName();
        } else {
            error_log(date("M d H:i:s ") . "ERROR: suspend interface has no resolvable network: " . $this->getSysName());
            return 1;
        }
        $vunl = $this->getSysName();
        if (!isInterface($vunl)) {
            error_log(date("M d H:i:s ") . "ERROR: suspend interface is not present: " . $vunl);
            return 1;
        }
        $this->setLinkState("down");
        $rc = disconnectInterface($netName, $vunl);
        return $rc;
    }
    /** Function for delete bridge  */

    public function unplug()
    {
        if ($this->type == "serial") {
            return 0;
        }
        if (isset($this->networks[$this->network_id])) {
            $netName = $this->networks[$this->network_id]->getSysName();
        } else {
            error_log(date("M d H:i:s ") . "ERROR: all-NIC suspend interface has no resolvable network: " . $this->getSysName());
            return 1;
        }
        $vunl = $this->getSysName();
        if (!isInterface($vunl)) {
            error_log(date("M d H:i:s ") . "ERROR: all-NIC suspend interface is not present: " . $vunl);
            return 1;
        }
        if (!isInterface($netName)) {
            error_log(date("M d H:i:s ") . "ERROR: all-NIC suspend network is not present: " . $netName);
            return 1;
        }
        $rc = disconnectInterface($netName, $vunl);
        if (isInterfaceDOWN($netName)) {
            $rc1 = delBridge($netName);
        }
        $this->setLinkState("down");
        return $rc;
    }

    /**
     * Function to apply vlan8021a for bridge
     */

    public function setvlan8021ad($id)
    {
        $netName = $this->networks[$id]->getSysName();
        $cmd =
            "sudo ip link set " .
            $netName .
            " type bridge vlan_protocol  802.1ad 2>&1";
        error_log(date("M d H:i:s ") . $cmd);
        secureCmd($cmd);
        exec($cmd, $o, $rc);
        return 0;
    }
    /**
     * Function to unapply vlan8021a for bridge
     */

    public function unsetvlan8021ad($id)
    {
        $netName = $this->networks[$id]->getSysName();
        $cmd =
            "sudo ip link set " .
            $netName .
            " type bridge vlan_protocol  802.1Q 2>&1";
        error_log(date("M d H:i:s ") . $cmd);
        secureCmd($cmd);
        exec($cmd, $o, $rc);
        return 0;
    }

    public function setLinkState($status, $ifIndex = null)
    {
        if (
            $this->device->getNType() == "qemu" &&
            $this->device->getStatus() > 0
        ) {
            // B7: www-data has no sudo, so the old `sudo nc -U monitor.sock`
            // (HMP info network -> set_link netN on|off) silently no-oped and a
            // live interface suspend/rewire never reached the QEMU monitor.
            // Route through the broker (root), which resolves netN and toggles.
            $resp = broker_call('qemu_setlink', array(
                'mon' => $this->device->getRunningPath() . '/monitor.sock',
                'tap' => $this->getSysName(),
                'state' => ($status == "up") ? "up" : "down"));
            if (!$resp['ok'] || $resp['rc'] != 0) {
                error_log(date("M d H:i:s ") . 'ERROR: qemu_setlink ' .
                    $this->getSysName() . ' ' . $status . ': ' . $resp['err']);
            }
            return;
        }

        if (
            $this->device->getNType() == "iol" &&
            $this->device->getStatus() > 0 &&
            $this->device->isKeepAlive()
        ) {
            // B7: www-data has no sudo, so the old `sudo php .../wrapper`
            // (start keepalive.pl) and `sudo kill -9` silently no-oped — the
            // IOL L1-keepalive link toggle never happened. Route through the
            // broker (root). uid comes from a non-privileged `id -u`.
            $cmd = "id -u unl" . $this->device->getSession() . " 2>&1";
            exec($cmd, $o, $rc);
            $uid = isset($o[0]) ? trim($o[0]) : "0";
            $resp = broker_call('iol_keepalive', array(
                'runpath' => $this->device->getRunningPath(),
                'state' => ($status == "up") ? "up" : "down",
                'session' => $this->device->getSession(),
                'if_id' => $this->getId(),
                'iol_id' => $this->device->getIolId(),
                'uid' => $uid));
            if (!$resp['ok'] || $resp['rc'] != 0) {
                error_log(date("M d H:i:s ") . 'ERROR: iol_keepalive ' .
                    $this->device->getSession() . '_' . $this->getId() . ' ' .
                    $status . ': ' . $resp['err']);
            }
            return;
        }

        if (
            $this->device->getNType() == "docker" &&
            $this->device->getStatus() > 0
        ) {
            $vunl = $this->getSysName();
            // B7: www-data has no sudo, so the old `sudo ip link set <vunl>
            // up|down` silently no-oped from the web context and left the veth
            // admin-DOWN on a live rewire/suspend (bridged but no carrier -> no
            // traffic). Route the link-state change through the broker (root).
            $resp = broker_call('iface_linkstate', array(
                'name' => $vunl,
                'state' => ($status == "up") ? "up" : "down"));
            if (!$resp['ok'] || $resp['rc'] != 0) {
                error_log(date("M d H:i:s ") . 'ERROR: iface_linkstate ' .
                    $vunl . ' ' . $status . ': ' . $resp['err']);
            }
            return;
        }
    }

    public function getSysName()
    {
        if ($this->type == "ethernet") {
       			 return "vunl" . $this->if_session[IF_SESSION_NODE] . "_" . $this->id;
        }
        else {
           		 return "ser" . $this->if_session[IF_SESSION_NODE] . "_" . $this->id;
        }
    }
}
