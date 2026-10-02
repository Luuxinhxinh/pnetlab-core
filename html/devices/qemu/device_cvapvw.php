<?php

/**
 * device_cvapvw.php — Cisco Virtual Access Point over the vwifi medium (cVAP-vwifi).
 *
 * Same genuine Cisco AP COS userland as device_cvap.php (capwapd/click/hostapd.stock,
 * CAPWAP-joins a Catalyst 9800-CL WLC over wired0, AP_Model/WLC_IP/CAPWAP_VER cidata),
 * but the RF medium is swapped: instead of cvap's virtio-serial "airduct" transport
 * (host-side airhandler.py), this AP relays 802.11 frames over the vwifi vsock medium
 * (pnet-vwifi-server), matching device_wifiap.php/device_wifista.php — so it can
 * associate with the full vwifi client ecosystem (wifista/wificlient: WPA3-SAE,
 * EAP-TLS+RADIUS, multi-SSID VLAN trunking) instead of only cwificlient.
 *
 * Boot shape (unchanged from cvap): EFI (OVMF-sata.fd) + SATA/AHCI disk (addon image
 * named sataa.qcow2) + e1000 NICs — set in the template's qemu_options/qemu_nic, so
 * this handler adds no firmware/disk flags.
 *
 * Config surface (unchanged from cvap): a cidata ISO (volume label "cidata") carrying
 * apvirtual.env. AP_Model/WLC_IP/CAPWAP_VER/AP_WIFI7_MLO/RADIO_FREQ are untouched by
 * the medium swap — nothing about the CAPWAP/WLC side of this AP changed.
 *
 * RF medium (grafted from device_wifiap.php): a vsock device with a per-node unique
 * guest-cid, relayed by the host-side vwifi-server (verb vwifi_server_ensure). No
 * "Wireless cell" ethernet cabling is needed here — that mechanism in device_wifiap
 * only exists to fetch a multi-SSID WLAN list for generic hostapd; this AP's SSID/
 * security config comes from the WLC over CAPWAP, same as the airduct-medium cvap.
 *
 * @author pnetlab vap-node
 * @link https://www.pnetlab.com/
 */

class device_cvapvw extends device_qemu
{
    /** Numeric Cisco AP model fed to the image as AP_TYPE (e.g. 9178 = CW9178I
     *  Wi-Fi 7). The image maps this to the click platform type reported to the
     *  WLC (show ap summary) and derives the radio band plan from it. */
    public $pnq_ap_type = '9178';

    /** Controller the AP tries to CAPWAP-join (apvirtual.env WLC_IP). */
    public $pnq_wlc_ip = '10.10.100.254';

    /** CAPWAP/AP software version string the AP presents; set to match the WLC
     *  release (e.g. 17.18.3.18 for a 9800 running 17.18.03). */
    public $pnq_capwap_ver = '17.18.3.18';

    /** Wi-Fi 7 Multi-Link Operation (only honoured by the image for 9178/9176;
     *  ignored otherwise). '0' or '1'. */
    public $pnq_wifi7_mlo = '0';

    /** Optional explicit radio band override (blank = let the image derive from
     *  AP_TYPE). Accepts the image's tokens e.g. "2.4/5/6GHz", "2.4/5GHz". */
    public $pnq_radio_freq = '';

    function __construct($node)
    {
        parent::__construct($node);
    }

    public function editParams($p)
    {
        // AP_Model — accept only known numeric model ids (mirrors the image's
        // virtApConfig.sh AP_TYPE table); default 9178 on anything unexpected.
        if (isset($p['AP_Model'])) {
            $m = preg_replace('/[^0-9]/', '', (string) $p['AP_Model']);
            if (in_array($m, $this->knownApTypes(), true)) {
                $this->pnq_ap_type = $m;
            }
        }
        if (isset($p['WLC_IP']) && preg_match('/^\d{1,3}(\.\d{1,3}){3}$/', (string) $p['WLC_IP'])) {
            $this->pnq_wlc_ip = (string) $p['WLC_IP'];
        }
        if (isset($p['CAPWAP_VER'])) {
            // Version string: digits and dots only.
            $v = preg_replace('/[^0-9.]/', '', (string) $p['CAPWAP_VER']);
            if ($v !== '') $this->pnq_capwap_ver = $v;
        }
        if (isset($p['AP_WIFI7_MLO'])) {
            $this->pnq_wifi7_mlo = ((string) $p['AP_WIFI7_MLO'] === '1') ? '1' : '0';
        }
        if (isset($p['RADIO_FREQ'])) {
            // Band tokens: digits, dot, slash, G/H/z only (e.g. 2.4/5/6GHz). Blank allowed.
            $this->pnq_radio_freq = preg_replace('/[^0-9.\/GHz]/', '', (string) $p['RADIO_FREQ']);
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
            'AP_Model' => $this->pnq_ap_type,
            'WLC_IP' => $this->pnq_wlc_ip,
            'CAPWAP_VER' => $this->pnq_capwap_ver,
            'AP_WIFI7_MLO' => $this->pnq_wifi7_mlo,
            'RADIO_FREQ' => $this->pnq_radio_freq,
            'Initial_startup_config' => $this->Initial_startup_config
        ]);
    }

    /** Numeric AP_TYPE values the shipped VAP image recognises (from the image's
     *  virtApConfig.sh AP_TYPE→platform table + apply_ap_radio_profile). Anything
     *  outside this set would fall to the image's generic default. */
    protected function knownApTypes()
    {
        return [
            '9178', '9176', '9166', '9164', '9162', '9136', // Wi-Fi 6E / 7 (tri-band)
            '9130', '9124', '9120', '9117', '9115', '9105', '6300', '1840', // Wi-Fi 6
            '4800', '3800', '3700', '2800', '1852', '1815', '1810', '1800', '1560', '1540', '1115', '1105' // Wave 2 / legacy
        ];
    }

    /**
     * Derive guest identity from the already-persisted first wired MAC. PNetLab's
     * wired namespace starts with 50; locally administered/unicast 52 separates
     * radio from wired space. The last wired octet is a NIC index, so normalize it
     * to 00 and reserve offsets 00..0f for the Cisco radio/VIF layout.
     */
    protected function withNodeRadioIdentity($env)
    {
        $wired = strtolower($this->createFirstMac());
        $radioBase = '52' . substr($wired, 2, -2) . '00';
        $serial = 'PNET-' . strtoupper(str_replace(':', '', substr($wired, 3)));

        // These are engine-owned values: a saved startup-config must not be able
        // to reintroduce a duplicate identity.
        $env = preg_replace('/^(RADIO_BASE_MAC|AP_SERIAL)=.*(?:\r?\n|$)/m', '', (string) $env);
        return rtrim($env, "\r\n") . "\n"
            . 'RADIO_BASE_MAC=' . $radioBase . "\n"
            . 'AP_SERIAL=' . $serial . "\n";
    }

    /**
     * Build the apvirtual.env content from the node params. Only keys the user has
     * a value for are emitted; the image derives everything else from AP_TYPE.
     */
    protected function buildApVirtualEnv()
    {
        $lines = [];
        $lines[] = 'AP_TYPE=' . $this->pnq_ap_type;
        $lines[] = 'WLC_IP=' . $this->pnq_wlc_ip;
        if ($this->pnq_capwap_ver !== '') {
            $lines[] = 'CAPWAP_VER=' . $this->pnq_capwap_ver;
        }
        // MLO only means anything on 9178/9176; emit only when enabled to avoid
        // the image logging an "ignored" line for other models.
        if ($this->pnq_wifi7_mlo === '1' && in_array($this->pnq_ap_type, ['9178', '9176'], true)) {
            $lines[] = 'AP_WIFI7_MLO=1';
        }
        if ($this->pnq_radio_freq !== '') {
            $lines[] = 'RADIO_FREQ=' . $this->pnq_radio_freq;
        }
        return $this->withNodeRadioIdentity(implode("\n", $lines) . "\n");
    }

    /**
     * Build the cidata seed ISO (volume label "cidata") in the node running path.
     * The VAP image reads `apvirtual.env` from it (not cloud-init user-data), so we
     * ship exactly that one file.
     */
    private function buildCidata($env)
    {
        $rp = $this->getRunningPath();
        $env = $this->withNodeRadioIdentity($env);
        file_put_contents($rp . '/apvirtual.env', $env);
        $isocmd = 'cd ' . escapeshellarg($rp)
            . ' && mkisofs -J -r -V cidata -o config.iso apvirtual.env';
        exec($isocmd, $o, $rc);
    }

    /**
     * Globally-unique, restart-stable vsock context id for this node, derived from
     * the node UUID. Console ports (getPort()) repeat across labs/tenants, which
     * collides the vsock CID ("unable to set guest cid: Address already in use");
     * the UUID is unique per node and stable across restarts. Mapped into a safe
     * range (>2, well within u32). Matches device_wifiap::guestCid() so this AP's
     * CID is computed the same way every vwifi node's is.
     */
    protected function guestCid()
    {
        return (crc32($this->uuid) % 0x7fff0000) + 0x10000;
    }

    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) return $result;

        // Kill any orphaned qemu bound to this node's run path, then ensure the
        // host RF medium (vwifi-server, vsock) is up — NOT the airduct airhandler;
        // this AP relays over vwifi like wifiap/wifista, not over virtio-serial.
        if (function_exists('broker_call')) {
            @broker_call('node_kill_orphan_qemu', ['run' => $this->getRunningPath()]);
            @broker_call('vwifi_server_ensure', []);
        }

        $rp = $this->getRunningPath();

        // A saved/edited startup-config (a hand-authored apvirtual.env) is delivered
        // verbatim; otherwise build apvirtual.env from the node params.
        if (is_file($rp . '/startup-config') && !is_file($rp . '/.configured')) {
            $this->buildCidata(file_get_contents($rp . '/startup-config'));
        } else if (!is_file($rp . '/.configured') && $this->Initial_startup_config != '0') {
            $this->buildCidata($this->buildApVirtualEnv());
        }

        return 0;
    }

    public function customFlag($flag)
    {
        $rp = $this->getRunningPath();

        // Attach the day-0 cidata CD whenever it exists and the node has not been
        // marked configured. NOT gated on wrapper.txt (that is just qemu's stdout
        // file, recreated every start and left behind by a Wipe, which would
        // suppress the seed on the post-wipe boot). cloud-init/vap-vm-prepare
        // de-dups by instance-id / .configured so an always-present seed only
        // re-provisions after a Wipe clears the disk overlay.
        if (is_file($rp . '/config.iso') && !is_file($rp . '/.configured')
            && ($this->config != 0 || $this->Initial_startup_config != '0')) {
            $flag .= ' -drive file=config.iso,if=ide,media=cdrom,index=3';
        }

        // Attach the vwifi RF-medium transport: a vsock device with a unique
        // guest-cid, relayed by the host-side pnet-vwifi-server (same transport
        // wifiap/wifista use) — replaces cvap's airduct virtio-serial port.
        $flag .= ' -device vhost-vsock-pci,id=vwifi0,guest-cid=' . $this->guestCid();

        // 9p host share, mount tag "hostshare". The image's PID-1 /odp-init.sh
        // unconditionally does `mount -t 9p ... hostshare /share`; without this device
        // the mount fails (kernel logs "9pnet_virtio: no channels available for device
        // hostshare" at boot) and every AP-stack log (odp-ap-stack.log, ap_capwapd.log,
        // ap_hostapd_stock.log, ptkinject-wlan*.log, boot.log) is written into the
        // node's disk overlay where nothing on the host can read it. Pointing it at the
        // node running path reproduces exactly what the gate-side raw-qemu boot scripts
        // (boot-apcvwtest4.sh) provide, so PNetLab nodes are as debuggable as those are.
        $flag .= ' -fsdev local,id=fsdev0,path=' . escapeshellarg($rp)
            . ',security_model=none'
            . ' -device virtio-9p-pci,fsdev=fsdev0,mount_tag=hostshare';

        return $flag;
    }
}
