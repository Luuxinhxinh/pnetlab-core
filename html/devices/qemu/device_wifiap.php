<?php

/**
 * device_wifiap.php — PNetLab Wireless Access Point (emulated 802.11).
 *
 * Substrate (proven in the vwifi P0/P0.5 spike): a QEMU VM with its own kernel +
 * mac80211_hwsim radio, joined to a host-side vwifi medium server over **vsock**.
 * Each node carries a unique `-device vhost-vsock-pci,guest-cid=<port>` so the
 * server identifies it (vsock guest-cid = clean per-node id, no Docker `-u` hack).
 *
 * Dev stand-in image (P1a) = CML `ubuntu-wireless` qcow2 with airduct masked and our
 * `vwifi-client` baked as a systemd unit (see addons/qemu/wifiap-1.0/). The image's
 * own `wifi-autoconfig.service` starts hostapd once vwifi-client creates wlan0.
 *
 * Day-0 role is delivered as a cloud-init **cidata** seed (same mechanism as the
 * Catalyst SD-WAN nodes, device_catmanager.php): this AP writes /home/cisco/hostapd.conf
 * (open SSID, channel 6) so a hand-dropped AP beacons with no manual config. The
 * matching Wireless STA (device_wifista.php) ships the same default SSID and associates.
 *
 * @author pnetlab vwifi wireless-emulation (P1a)
 * @link https://www.pnetlab.com/
 */

class device_wifiap extends device_qemu
{
    /** SSID for a standalone AP (no cell). Blank by default: an AP only beacons
     *  when an SSID is defined — by a connected Wireless cell or an explicit
     *  Wifi_SSID — so it never broadcasts a surprise hardcoded default. */
    public $pnq_ssid = '';

    /** Wired data-path mode (P1b): 'bridge' (AP-only, transparent L2) or 'routed' (AP = gateway). */
    public $pnq_ap_mode = 'bridge';

    /** Routed-mode client gateway/subnet (ignored in bridge mode). */
    public $pnq_lan_cidr = '192.168.10.1/24';

    /** P3 — security: 'open' | 'wpa2-psk' | 'wpa3-sae' | 'wpa-eap'. */
    public $pnq_security = 'open';

    /** PSK/SAE passphrase (wpa2-psk / wpa3-sae). */
    public $pnq_wpa_psk = 'pnetlab123';

    /** RADIUS server IP + shared secret (wpa-eap / 802.1X). */
    public $pnq_radius_server = '';
    public $pnq_radius_secret = 'pnetlab-radius';

    /** Radio band: 'g' (2.4 GHz, 802.11g) or 'a' (5 GHz, 802.11a/n/ac). hostapd hw_mode. */
    public $pnq_hwmode = 'g';

    /** 802.11 channel. Default 6 (2.4 GHz). For hw_mode=a use a 5 GHz channel (e.g. 36). */
    public $pnq_channel = '6';

    function __construct($node)
    {
        parent::__construct($node);
    }

    /**
     * Shared 8–63-char PSK check for the interactive node-edit path, mirroring the
     * broker's wireless-cell validation (pnetlab-brokerd.py _wificell_normalize).
     * Returns an error string when the passphrase is invalid for the chosen
     * security, or '' when OK. Called from api.php's node "edit" action so the user
     * gets a real 400 instead of an AP that silently emits a hostapd.conf hostapd
     * refuses to start (WPA-PSK/SAE require 8..63 ASCII chars). NOT called from
     * editParams(): that also runs on .unl load (Lab::__construct) where a throw
     * would abort opening the whole lab.
     */
    public static function validateWpaPsk($security, $psk)
    {
        if ($security === 'wpa2-psk' || $security === 'wpa3-sae') {
            $len = strlen((string) $psk);
            if ($len < 8 || $len > 63) {
                return 'WPA passphrase must be 8–63 characters (got ' . $len . ').';
            }
        }
        return '';
    }

    public function editParams($p)
    {
        if (isset($p['Wifi_SSID']) && $p['Wifi_SSID'] !== '') {
            $this->pnq_ssid = preg_replace('/[^A-Za-z0-9_\- ]/', '', (string) $p['Wifi_SSID']);
        }
        if (isset($p['AP_Mode'])) {
            $this->pnq_ap_mode = ($p['AP_Mode'] === 'routed') ? 'routed' : 'bridge';
        }
        if (isset($p['AP_LAN_CIDR']) && preg_match('/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/', (string) $p['AP_LAN_CIDR'])) {
            $this->pnq_lan_cidr = (string) $p['AP_LAN_CIDR'];
        }
        if (isset($p['Security']) && in_array($p['Security'], ['open', 'wpa2-psk', 'wpa3-sae', 'wpa-eap'], true)) {
            $this->pnq_security = (string) $p['Security'];
        }
        if (isset($p['WPA_Passphrase'])) {
            $this->pnq_wpa_psk = (string) $p['WPA_Passphrase'];
        }
        if (isset($p['RADIUS_Server'])) {
            // Accept a comma-separated list (primary + failover RADIUS servers).
            // Keep only digits/dots/commas, then drop blank entries so e.g.
            // "10.0.0.1, 10.0.0.2" normalises to "10.0.0.1,10.0.0.2".
            $raw = preg_replace('/[^0-9.,]/', '', (string) $p['RADIUS_Server']);
            $parts = array_filter(array_map('trim', explode(',', $raw)), function ($x) {
                return $x !== '';
            });
            $this->pnq_radius_server = implode(',', $parts);
        }
        if (isset($p['RADIUS_Secret'])) {
            $this->pnq_radius_secret = (string) $p['RADIUS_Secret'];
        }
        if (isset($p['Wifi_HwMode'])) {
            $this->pnq_hwmode = ($p['Wifi_HwMode'] === 'a') ? 'a' : 'g';
        }
        if (isset($p['Wifi_Channel'])) {
            // 2.4 GHz: 1–13. 5 GHz: common non-DFS channels. Clamp/ignore anything
            // else so a bad value never reaches hostapd (which would refuse to start).
            $ch = (int) $p['Wifi_Channel'];
            $valid24 = ($ch >= 1 && $ch <= 13);
            $valid5  = in_array($ch, [36, 40, 44, 48, 149, 153, 157, 161, 165], true);
            if ($valid24 || $valid5) {
                $this->pnq_channel = (string) $ch;
            }
        }
        if (isset($p['Initial_startup_config'])) {
            $this->Initial_startup_config = (string) $p['Initial_startup_config'];
        }
        parent::editParams($p);
    }

    public function getParams()
    {
        $params = parent::getParams();

        return array_replace($params, [
            'Wifi_SSID' => $this->pnq_ssid,
            'AP_Mode' => $this->pnq_ap_mode,
            'AP_LAN_CIDR' => $this->pnq_lan_cidr,
            'Security' => $this->pnq_security,
            'WPA_Passphrase' => $this->pnq_wpa_psk,
            'RADIUS_Server' => $this->pnq_radius_server,
            'RADIUS_Secret' => $this->pnq_radius_secret,
            'Wifi_HwMode' => $this->pnq_hwmode,
            'Wifi_Channel' => $this->pnq_channel,
            'Initial_startup_config' => $this->Initial_startup_config
        ]);
    }

    /**
     * P3 — hostapd security stanza for ONE WLAN (open / wpa2-psk / wpa3-sae /
     * wpa-eap). Open adds nothing; PSK/SAE use the passphrase; EAP points 802.1X
     * at the RADIUS server (the AP is the authenticator and relays EAP — clients
     * never talk to RADIUS directly). Returned as extra hostapd.conf lines.
     */
    protected function buildHostapdSecurityFor($security, $psk, $radiusServer, $radiusSecret)
    {
        $psk = str_replace(["\n", "\r"], '', (string) $psk);
        switch ($security) {
            case 'wpa2-psk':
                return "wpa=2\nwpa_key_mgmt=WPA-PSK\nrsn_pairwise=CCMP\nwpa_passphrase=" . $psk;
            case 'wpa3-sae':
                return "wpa=2\nwpa_key_mgmt=SAE\nrsn_pairwise=CCMP\nieee80211w=2\nsae_password=" . $psk;
            case 'wpa-eap':
                $sec = str_replace(["\n", "\r"], '', (string) $radiusSecret);
                $servers = array_filter(array_map('trim', explode(',', (string) $radiusServer)),
                    function ($x) { return $x !== ''; });
                if (empty($servers)) $servers = ['127.0.0.1'];
                // One auth_server block per server: hostapd treats the first as the
                // primary and the rest as failover (tried in order when the primary
                // stops answering). All share auth_server_shared_secret.
                $out = "wpa=2\nwpa_key_mgmt=WPA-EAP\nrsn_pairwise=CCMP\nieee8021x=1";
                foreach ($servers as $srv) {
                    $out .= "\nauth_server_addr=" . $srv . "\nauth_server_port=1812\n"
                        . "auth_server_shared_secret=" . $sec;
                }
                return $out;
            default:
                return ''; // open
        }
    }

    /** Legacy single-SSID security from this node's own params (no cell, or a
     *  cell with no WLAN list). Delegates to the per-WLAN builder. */
    protected function buildHostapdSecurity()
    {
        return $this->buildHostapdSecurityFor($this->pnq_security, $this->pnq_wpa_psk,
            $this->pnq_radius_server, $this->pnq_radius_secret);
    }

    /**
     * P5 (VLAN-trunk multi-SSID) — full hostapd multi-BSS config from a cell's
     * WLAN list. One BSS per WLAN on the single radio: the first is the primary
     * interface (wlan0), the rest are bss=wlan0_1, wlan0_2 ... Each BSS carries
     * its own ssid + security and is bridged to its VLAN bridge br<vid> (the
     * bring-up enslaves <wired>.<vid> into br<vid>, so the SSID rides VLAN <vid>
     * on the single trunk to the cell). hw_mode/channel are radio-global (set
     * once on the primary). Returns the conf text.
     */
    protected function buildHostapdMultiBss($wlans)
    {
        $out = [];
        $idx = 0;
        foreach ($wlans as $w) {
            $vid = (int) $w['vlan'];
            $ssid = isset($w['ssid']) ? $w['ssid'] : 'pnet-wifi';
            $bridge = 'br' . $vid;
            if ($idx === 0) {
                $out[] = 'interface=wlan0';
                $out[] = 'driver=nl80211';
                $out[] = 'ctrl_interface=/var/run/hostapd';
                $out[] = 'ctrl_interface_group=0';
                $out[] = 'hw_mode=' . $this->pnq_hwmode;
                $out[] = 'channel=' . $this->pnq_channel;
                $out[] = 'ssid=' . $ssid;
                $out[] = 'bridge=' . $bridge;
            } else {
                $out[] = '';
                $out[] = 'bss=wlan0_' . $idx;
                $out[] = 'ssid=' . $ssid;
                $out[] = 'bridge=' . $bridge;
            }
            $sec = $this->buildHostapdSecurityFor(
                isset($w['security']) ? $w['security'] : 'open',
                isset($w['psk']) ? $w['psk'] : '',
                isset($w['radius_server']) ? $w['radius_server'] : '',
                isset($w['radius_secret']) ? $w['radius_secret'] : '');
            if ($sec !== '') {
                foreach (explode("\n", $sec) as $line) {
                    $out[] = $line;
                }
            }
            $idx++;
        }
        return implode("\n", $out);
    }

    /**
     * Globally-unique, restart-stable vsock context id for this node, derived from
     * the node UUID. Console ports (getPort()) repeat across labs/tenants, which
     * collides the vsock CID ("unable to set guest cid: Address already in use");
     * the UUID is unique per node and stable across restarts. Mapped into a safe
     * range (>2, well within u32).
     */
    protected function guestCid()
    {
        return (crc32($this->uuid) % 0x7fff0000) + 0x10000;
    }

    /**
     * The first Wireless cell this AP is cabled to: returns ['net'=>Network,
     * 'ifId'=>int] or null. The cell carries the WLAN list (one or more SSIDs)
     * and is the AP's trunk uplink.
     */
    protected function connectedCell()
    {
        foreach ($this->getInterfaces() as $ifId => $iface) {
            $nid = method_exists($iface, 'getNetworkId') ? $iface->getNetworkId() : 0;
            if ($nid > 0) {
                $net = $this->getNetwork($nid);
                if ($net && method_exists($net, 'getNType') && $net->getNType() === 'wireless') {
                    return ['net' => $net, 'ifId' => $ifId];
                }
            }
        }
        return null;
    }

    /** A cell's sanitised NAME (legacy single-SSID fallback uses it as the SSID). */
    protected function cellName($cellNet)
    {
        if ($cellNet && method_exists($cellNet, 'getName')) {
            return preg_replace('/[^A-Za-z0-9_\- ]/', '', (string) $cellNet->getName());
        }
        return '';
    }

    /** Parse a cell's bridge sysname "vnet<labSession>_<netid>" into the broker
     *  session/net_id keys the WLAN state is stored under. Returns [s,n] or null. */
    protected function cellIds($cellNet)
    {
        $sys = method_exists($cellNet, 'getSysName') ? (string) $cellNet->getSysName() : '';
        if (preg_match('/^vnet(\d+)_(\d+)$/', $sys, $m)) {
            return [(int) $m[1], (int) $m[2]];
        }
        return null;
    }

    /**
     * Fetch the connected cell's persisted WLAN list (broker wifi_cell_get):
     * ['mgmt_vlan'=>int,'wlans'=>[...]] or null when the cell has no WLANs (so
     * the AP falls back to the legacy single-SSID path).
     */
    protected function fetchCellWlans($cellNet)
    {
        if (!function_exists('broker_call')) return null;
        $ids = $this->cellIds($cellNet);
        if ($ids === null) return null;
        $resp = @broker_call('wifi_cell_get', ['session' => $ids[0], 'net_id' => $ids[1]]);
        if (empty($resp['ok']) || empty($resp['out'][0])) return null;
        $cfg = json_decode($resp['out'][0], true);
        if (!is_array($cfg) || empty($cfg['wlans'])) return null;
        return $cfg;
    }

    /**
     * Auto-configure the AP's cell-facing port as a VLAN trunk on the cell's
     * vlan_filtering bridge: native(untagged) = the management VLAN (AP mgmt),
     * every WLAN VLAN tagged. Runs after parent::prepare() so the tap exists;
     * reuses the same broker verb the dot1q switch ports use (iface_vlan).
     */
    protected function applyApTrunk($cellNet, $ifId, $mgmt, $wlans)
    {
        if (!function_exists('broker_call')) return;
        $bridge = method_exists($cellNet, 'getSysName') ? (string) $cellNet->getSysName() : '';
        if (!preg_match('/^vnet\d+_\d+$/', $bridge)) return;
        $tap = 'vunl' . $this->getSession() . '_' . $ifId;
        $vids = [];
        foreach ($wlans as $w) {
            $vids[] = (int) $w['vlan'];
        }
        $vids[] = (int) $mgmt;
        $vids = array_values(array_unique($vids));
        @broker_call('iface_vlan', [
            'action' => 'set',
            'bridge' => $bridge,
            'tap'    => $tap,
            'mode'   => 'trunk',
            'native' => (int) $mgmt,
            'vlans'  => implode(',', $vids),
        ]);
    }

    /**
     * Render the multi-SSID day-0 cidata from the cell's WLAN list: a PHP-built
     * hostapd multi-BSS conf + a compact per-WLAN VLAN spec ("<vid>:<mode>:<cidr>"
     * space-joined), substituted into ap_multi_user-data.txt. The bring-up script
     * in that template builds the VLAN sub-interfaces + bridges on the trunk.
     */
    protected function buildMultiSsidUserData($wlans, $mgmt)
    {
        $tpl = file_get_contents('/opt/unetlab/startup_configs/wireless/ap_multi_user-data.txt');
        $tpl = str_replace('inserthostname-here', $this->name, $tpl);
        // hostapd.conf (multi-BSS), indented to the write_files YAML block.
        $conf = $this->buildHostapdMultiBss($wlans);
        $tpl = str_replace('insert-hostapd-conf-here', preg_replace('/\n/', "\n      ", $conf), $tpl);
        $specs = [];
        foreach ($wlans as $w) {
            $vid = (int) $w['vlan'];
            $mode = (isset($w['mode']) && $w['mode'] === 'routed') ? 'routed' : 'bridge';
            $cidr = isset($w['lan_cidr']) ? $w['lan_cidr'] : '';
            $specs[] = $vid . ':' . $mode . ':' . $cidr;
        }
        $tpl = str_replace('insert-mgmt-vlan-here', (string) ((int) $mgmt), $tpl);
        $tpl = str_replace('insert-wlan-specs-here', implode(' ', $specs), $tpl);
        return $tpl;
    }

    /**
     * Build the cidata seed ISO (user-data + meta-data) in the node running path.
     */
    private function buildCidata($userdata)
    {
        $rp = $this->getRunningPath();
        file_put_contents($rp . '/user-data', $userdata);
        file_put_contents(
            $rp . '/meta-data',
            "instance-id: " . $this->name . "\nlocal-hostname: " . $this->name . "\n"
        );
        $isocmd = 'cd ' . escapeshellarg($rp)
            . ' && mkisofs -J -r -V cidata -o config.iso user-data meta-data';
        exec($isocmd, $o, $rc);
    }

    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) return $result;

        // Kill any orphaned qemu left bound to this node's run path (a deleted/
        // restarted wireless node can leave a ghost radio beaconing a stale SSID
        // on the shared medium). Safe here: our own qemu hasn't started yet.
        // Then ensure the host RF medium (vwifi-server, vsock) is running.
        if (function_exists('broker_call')) {
            @broker_call('node_kill_orphan_qemu', ['run' => $this->getRunningPath()]);
            @broker_call('vwifi_server_ensure', []);
        }

        $rp = $this->getRunningPath();
        $cell = $this->connectedCell();
        $cfg = $cell ? $this->fetchCellWlans($cell['net']) : null;

        // VLAN-trunk multi-SSID path: the cell defines one or more WLANs, each on
        // its own VLAN. The AP broadcasts them all (hostapd multi-BSS) over a
        // single trunk to the cell; the untagged/native VLAN is AP management.
        if ($cfg && !empty($cfg['wlans'])) {
            $mgmt = isset($cfg['mgmt_vlan']) ? (int) $cfg['mgmt_vlan'] : 1;
            $wlans = $cfg['wlans'];
            $this->applyApTrunk($cell['net'], $cell['ifId'], $mgmt, $wlans);
            if (is_file($rp . '/startup-config') && !is_file($rp . '/.configured')) {
                $this->buildCidata(file_get_contents($rp . '/startup-config'));
            } else if (!is_file($rp . '/.configured') && $this->Initial_startup_config != '0') {
                $this->buildCidata($this->buildMultiSsidUserData($wlans, $mgmt));
            }
            return 0;
        }

        // Legacy single-SSID path (P1b/P3): a connected cell's NAME overrides the
        // per-node SSID param; security/mode come from this node's own params.
        $name = $cell ? $this->cellName($cell['net']) : '';
        if ($name !== '') {
            $this->pnq_ssid = $name;
        }

        if (is_file($rp . '/startup-config') && !is_file($rp . '/.configured')) {
            // Saved/edited config delivered verbatim as user-data.
            $this->buildCidata(file_get_contents($rp . '/startup-config'));
        } else if (!is_file($rp . '/.configured') && $this->Initial_startup_config != '0') {
            // Fresh node: deliver the AP cloud-config ONLY when an SSID is defined —
            // either inherited from a connected Wireless cell (above) or an explicit
            // Wifi_SSID param. With NO SSID source the AP stays idle (no hostapd, no
            // beacon) instead of broadcasting a hardcoded default: a bare AP that
            // isn't cabled to a cell advertises nothing until you set Wifi_SSID or
            // attach it to a cell.
            if ($this->pnq_ssid !== '') {
                $tpl = file_get_contents('/opt/unetlab/startup_configs/wireless/ap_user-data.txt');
                $tpl = str_replace('inserthostname-here', $this->name, $tpl);
                $tpl = str_replace('insert-ssid-here', $this->pnq_ssid, $tpl);
                $tpl = str_replace('insert-hwmode-here', $this->pnq_hwmode, $tpl);
                $tpl = str_replace('insert-channel-here', $this->pnq_channel, $tpl);
                $tpl = str_replace('insert-ap-mode-here', $this->pnq_ap_mode, $tpl);
                $tpl = str_replace('insert-lan-cidr-here', $this->pnq_lan_cidr, $tpl);
                // Security stanza: indent continuation lines to match the hostapd.conf YAML block.
                $sec = $this->buildHostapdSecurity();
                $tpl = str_replace('insert-security-here',
                    ($sec === '' ? '' : preg_replace('/\n/', "\n      ", $sec)), $tpl);
                $this->buildCidata($tpl);
            } else {
                error_log(date('M d H:i:s ') . 'INFO: Wireless AP ' . $this->name
                    . ' has no SSID (no cell, no Wifi_SSID) — not beaconing.');
            }
        }

        return 0;
    }

    public function customFlag($flag)
    {
        $rp = $this->getRunningPath();

        // Attach the day-0 cidata CD whenever it exists and the node has not been marked
        // configured. NOT gated on wrapper.txt: that is just qemu's stdout file (recreated
        // on every start) and a Wipe can leave it behind, which would suppress the seed on
        // the post-wipe boot -> cloud-init finds no datasource ("disabled") -> no provisioning.
        if (is_file($rp . '/config.iso') && !is_file($rp . '/.configured')
            && ($this->config != 0 || $this->Initial_startup_config != '0')) {
            $flag .= ' -drive file=config.iso,if=ide,media=cdrom,index=3';
        }

        // Attach the vwifi medium transport: a vsock device with a unique guest-cid.
        $flag .= ' -device vhost-vsock-pci,id=vwifi0,guest-cid=' . $this->guestCid();

        return $flag;
    }
}
