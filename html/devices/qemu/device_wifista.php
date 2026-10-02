<?php

/**
 * device_wifista.php — PNetLab Wireless Station/Client (emulated 802.11).
 *
 * Sibling of device_wifiap.php (see that file for the substrate rationale). Same QEMU +
 * mac80211_hwsim + vwifi-over-vsock model and the same unique-guest-cid injection; the
 * only difference is the day-0 role: this node writes /home/cisco/wpa_supplicant.conf so
 * the image's wifi-autoconfig.service runs wpa_supplicant and associates to the cell's
 * AP (default SSID `pnet-wifi`, Open). WPA2/WPA3/EAP land in P3.
 *
 * @author pnetlab vwifi wireless-emulation (P1a)
 * @link https://www.pnetlab.com/
 */

class device_wifista extends device_qemu
{
    /**
     * SSID to associate to. BLANK by default: the STA then auto-associates to the
     * strongest OPEN SSID at boot (lowest BSSID wins a signal tie). Set this (node
     * param `Wifi_SSID`, e.g. from the Wi-Fi Painter "Connect a station" picker) to
     * force a strict association to a specific SSID with its configured security.
     */
    public $pnq_ssid = '';

    /** P3 — security to match the AP: 'open' | 'wpa2-psk' | 'wpa3-sae' | 'wpa-eap'. */
    public $pnq_security = 'open';

    /** PSK/SAE passphrase (must match the AP's). */
    public $pnq_wpa_psk = 'pnetlab123';

    /** 802.1X (PEAP/MSCHAPv2) credentials for wpa-eap. */
    public $pnq_eap_identity = 'pnetuser';
    public $pnq_eap_password = 'pnetpass';

    function __construct($node)
    {
        parent::__construct($node);
    }

    /**
     * Shared 8–63-char PSK check for the interactive node-edit path, mirroring
     * device_wifiap::validateWpaPsk and the broker's wireless-cell validation. A
     * too-short/long PSK makes wpa_supplicant reject the network{} block so the STA
     * never associates; surface it as a real 400 (from api.php) instead. NOT called
     * from editParams() — that also runs on .unl load where a throw would abort the
     * whole lab open. Returns an error string, or '' when OK.
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
        if (isset($p['Security']) && in_array($p['Security'], ['open', 'wpa2-psk', 'wpa3-sae', 'wpa-eap'], true)) {
            $this->pnq_security = (string) $p['Security'];
        }
        if (isset($p['WPA_Passphrase'])) {
            $this->pnq_wpa_psk = (string) $p['WPA_Passphrase'];
        }
        if (isset($p['EAP_Identity'])) {
            $this->pnq_eap_identity = preg_replace('/[^A-Za-z0-9_.@\-]/', '', (string) $p['EAP_Identity']);
        }
        if (isset($p['EAP_Password'])) {
            $this->pnq_eap_password = (string) $p['EAP_Password'];
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
            'Security' => $this->pnq_security,
            'WPA_Passphrase' => $this->pnq_wpa_psk,
            'EAP_Identity' => $this->pnq_eap_identity,
            'EAP_Password' => $this->pnq_eap_password,
            'Initial_startup_config' => $this->Initial_startup_config
        ]);
    }

    /**
     * The full wpa_supplicant.conf body delivered via cidata. With an explicit SSID we
     * emit a fixed network{} block (strict associate with the configured security). With
     * a blank SSID we emit only the control header + update_config and pnet-wifi-sta.sh
     * scans + joins the strongest OPEN SSID (lowest BSSID on a tie) at boot.
     */
    protected function buildWpaConf()
    {
        $conf = "ctrl_interface=/var/run/wpa_supplicant\nupdate_config=1\n";
        if ($this->pnq_ssid !== '') {
            $conf .= "network={\n    ssid=\"" . $this->pnq_ssid . "\"\n";
            foreach (explode("\n", $this->buildSupplicantNetwork()) as $l) {
                $conf .= "    " . $l . "\n";
            }
            $conf .= "}\n";
        }
        return rtrim($conf, "\n");
    }

    /**
     * P3 — the wpa_supplicant network{} body matching the AP's security. The script
     * wraps this in `network={ ... }`, so return only the inner key=value lines.
     */
    protected function buildSupplicantNetwork()
    {
        $psk = str_replace(["\n", "\r", '"'], '', $this->pnq_wpa_psk);
        switch ($this->pnq_security) {
            case 'wpa2-psk':
                return "key_mgmt=WPA-PSK\npsk=\"" . $psk . "\"";
            case 'wpa3-sae':
                return "key_mgmt=SAE\nieee80211w=2\npsk=\"" . $psk . "\"";
            case 'wpa-eap':
                $id = $this->pnq_eap_identity;
                $pw = str_replace(["\n", "\r", '"'], '', $this->pnq_eap_password);
                return "key_mgmt=WPA-EAP\neap=PEAP\nidentity=\"" . $id . "\"\npassword=\"" . $pw
                    . "\"\nphase2=\"auth=MSCHAPV2\"";
            default:
                return "key_mgmt=NONE";
        }
    }

    /**
     * Globally-unique, restart-stable vsock context id derived from the node UUID
     * (console ports repeat across labs -> vsock "cid already in use"). See
     * device_wifiap.php for the rationale.
     */
    protected function guestCid()
    {
        return (crc32($this->uuid) % 0x7fff0000) + 0x10000;
    }

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

        // Kill any orphaned qemu still bound to this node's run path before our
        // own qemu starts (prevents a deleted/restarted STA leaving a ghost radio
        // on the medium), then ensure the host RF medium is running.
        if (function_exists('broker_call')) {
            @broker_call('node_kill_orphan_qemu', ['run' => $this->getRunningPath()]);
            @broker_call('vwifi_server_ensure', []);
        }

        $rp = $this->getRunningPath();

        if (is_file($rp . '/startup-config') && !is_file($rp . '/.configured')) {
            $this->buildCidata(file_get_contents($rp . '/startup-config'));
        } else if (!is_file($rp . '/.configured') && $this->Initial_startup_config != '0') {
            $tpl = file_get_contents('/opt/unetlab/startup_configs/wireless/sta_user-data.txt');
            $tpl = str_replace('inserthostname-here', $this->name, $tpl);
            // Whole wpa_supplicant.conf body (network{} block when an SSID is set, else
            // just the control header for auto-associate). Each line carries the 6-space
            // cloud-config indent; the placeholder line already supplies the first.
            $conf = $this->buildWpaConf();
            $tpl = str_replace('insert-wpa-conf-here', str_replace("\n", "\n      ", $conf), $tpl);
            $this->buildCidata($tpl);
        }

        return 0;
    }

    public function customFlag($flag)
    {
        $rp = $this->getRunningPath();

        // Attach the day-0 cidata CD whenever it exists and the node has not been marked
        // configured. NOT gated on wrapper.txt: that is just qemu's stdout file (recreated
        // on every start) and a Wipe can leave it behind, which would suppress the seed on
        // the post-wipe boot -> cloud-init finds no datasource (reports "disabled") -> none
        // of the bring-up runs. With the seed always present, cloud-init de-dups by
        // instance-id and only re-provisions after a Wipe clears the disk overlay.
        if (is_file($rp . '/config.iso') && !is_file($rp . '/.configured')
            && ($this->config != 0 || $this->Initial_startup_config != '0')) {
            $flag .= ' -drive file=config.iso,if=ide,media=cdrom,index=3';
        }

        $flag .= ' -device vhost-vsock-pci,id=vwifi0,guest-cid=' . $this->guestCid();

        return $flag;
    }
}
