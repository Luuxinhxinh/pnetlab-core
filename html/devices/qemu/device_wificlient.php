<?php

/**
 * device_wificlient.php — PNetLab Wireless Client (GUI).
 *
 * A graphical end-user laptop on the emulated 802.11 plane: same QEMU +
 * mac80211_hwsim + vwifi-over-vsock radio as device_wifista, but the image
 * (addons/qemu/wificlient-<version>/) is an XFCE desktop where NetworkManager
 * owns wlan0 and the user picks SSIDs from nm-applet, browses, and runs ping/ip
 * from a terminal — rendered through the VNC console. Because the user normally
 * drives Wi-Fi from the GUI there is no day-0 wpa_supplicant role config.
 *
 * What this handler adds on top of device_qemu: certificate-based 802.1X
 * (EAP-TLS) onboarding driven entirely from the Startup-config editor. The user
 * pastes their CA cert / client cert / client key into the node's Startup-config
 * (pre-filled with an EAP-TLS #cloud-config template) and on start we deliver it
 * verbatim as a NoCloud cidata ISO. cloud-init drops the certs into /etc/pnet-eap/
 * and writes one NetworkManager keyfile connection (autoconnect) so the desktop
 * EAP-TLS-associates to a WPA-EAP cell — no manual file copying, no change to node
 * startup (a bad/blank cert only fails EAP; the desktop still boots).
 *
 * The mechanism is the same "cidata envelope" already trusted by device_wifista /
 * device_wifiap; the difference is the payload is a user-pasted cloud-config rather
 * than a param-rendered wpa_supplicant role.
 *
 * @author pnetlab vwifi wireless-emulation (P5 / EAP-TLS cert onboarding)
 * @link https://www.pnetlab.com/
 */

class device_wificlient extends device_qemu
{
    /**
     * SSID a seeded NM keyfile targets (must match the WPA-EAP/secured cell). BLANK by
     * default: with no SSID the desktop auto-joins the strongest OPEN SSID via the baked
     * pnet-wifi-autojoin helper, and no keyfile is seeded. Set this (node param
     * `Wifi_SSID`, e.g. from the Wi-Fi Painter) for a cert-based EAP-TLS connection.
     */
    public $pnq_ssid = '';

    /** 802.1X identity presented in the client certificate (EAP-TLS). */
    public $pnq_eap_identity = 'pnetuser';

    /** Deliver the EAP-TLS seed on a fresh node (and expose the Startup-config editor). */
    public $Initial_startup_config = '1';

    function __construct($node)
    {
        parent::__construct($node);
    }

    public function editParams($p)
    {
        parent::editParams($p);

        if (isset($p['Wifi_SSID']) && $p['Wifi_SSID'] !== '') {
            $this->pnq_ssid = preg_replace('/[^A-Za-z0-9_\- ]/', '', (string) $p['Wifi_SSID']);
        }
        if (isset($p['EAP_Identity']) && $p['EAP_Identity'] !== '') {
            $this->pnq_eap_identity = preg_replace('/[^A-Za-z0-9_.@\-]/', '', (string) $p['EAP_Identity']);
        }
        if (isset($p['Initial_startup_config'])) {
            $this->Initial_startup_config = (string) $p['Initial_startup_config'];
        }

        // Pre-fill the Startup-config editor with the EAP-TLS template (obvious cert
        // slots) when this node has no saved config yet and the feature is enabled.
        // getConfigData() returns this verbatim, so the editor opens ready to paste
        // certs into; once the user saves, config_data carries their edited version.
        if (($this->config_data === null || $this->config_data === '')
            && $this->Initial_startup_config != '0'
        ) {
            $this->config_data = $this->renderSeed();
        }
    }

    public function getParams()
    {
        $params = parent::getParams();

        return array_replace($params, [
            'Wifi_SSID' => $this->pnq_ssid,
            'EAP_Identity' => $this->pnq_eap_identity,
            'Initial_startup_config' => $this->Initial_startup_config
        ]);
    }

    /**
     * Render the EAP-TLS cloud-config seed with the node's SSID + EAP identity
     * substituted (cert/key placeholders left intact for the user to paste over).
     * Shared by the editor pre-fill and the no-saved-config boot path so both show
     * the same template.
     */
    protected function renderSeed()
    {
        $tpl = @file_get_contents('/opt/unetlab/startup_configs/wireless/client_user-data.txt');
        if ($tpl === false) return '';
        // With no SSID set the desktop auto-joins the strongest OPEN SSID (baked helper),
        // so drop the keyfile block — a keyfile with an empty SSID would be invalid.
        if ($this->pnq_ssid === '') {
            $tpl = preg_replace(
                '/[ \t]*# --8<-- wifi-keyfile.*?# --8<-- end wifi-keyfile[^\n]*\n/s',
                '',
                $tpl
            );
        }
        $tpl = str_replace('insert-ssid-here', $this->pnq_ssid, $tpl);
        $tpl = str_replace('insert-eap-identity-here', $this->pnq_eap_identity, $tpl);
        return $tpl;
    }

    /**
     * Globally-unique, restart-stable vsock context id derived from the node
     * UUID (console ports repeat across labs -> vsock "cid already in use").
     * Same derivation as device_wifiap/wifista so the painter's crc32(uuid)
     * mapping matches.
     */
    protected function guestCid()
    {
        return (crc32($this->uuid) % 0x7fff0000) + 0x10000;
    }

    /**
     * Build the NoCloud cidata ISO (user-data + meta-data) the GUI client reads on
     * first boot. cidata files MUST be named exactly user-data/meta-data. Identical
     * to device_wifista::buildCidata.
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

        // Kill any orphaned qemu still bound to this node's run path before our own
        // qemu starts (a deleted/restarted client can otherwise leave a ghost radio
        // on the medium), then ensure the host RF medium is up.
        if (function_exists('broker_call')) {
            @broker_call('node_kill_orphan_qemu', ['run' => $this->getRunningPath()]);
            @broker_call('vwifi_server_ensure', []);
        }

        $rp = $this->getRunningPath();

        // First-boot only (gated by .configured / wrapper.txt like the AP/STA), so we
        // never stomp changes the user makes live in the desktop.
        if (is_file($rp . '/startup-config') && !is_file($rp . '/.configured')) {
            // User has a saved Startup-config (the pasted EAP-TLS cloud-config) — base
            // device::prepare() wrote it to startup-config. Deliver it verbatim.
            $this->buildCidata(file_get_contents($rp . '/startup-config'));
        } else if (!is_file($rp . '/.configured') && $this->Initial_startup_config != '0') {
            // No saved config in use: deliver the rendered EAP-TLS seed (cert slots are
            // placeholders, so NM simply skips the invalid connection -> plain desktop).
            $this->buildCidata($this->renderSeed());
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
