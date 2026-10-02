<?php

/**
 * device_cwificlient.php — Cisco/CML Wireless Client (GRAPHICAL) on the airduct RF medium.
 *
 * Pairs with the cVAP (device_cvap.php): a graphical wireless client that shares the
 * host airhandler medium with the cVAP, so it can scan + associate to the SSID a cVAP
 * beacons once the cVAP has joined a Catalyst 9800. (Our other client node,
 * wifista/wificlient, is on the incompatible vwifi/vsock medium and cannot hear a cVAP.)
 *
 * Image (addons/qemu/cwificlient-<ver>/virtioa.qcow2) = the CML wireless-client refplat
 * (Ubuntu 24.04, native `airduct` + mac80211_hwsim) with a lean openbox desktop +
 * NetworkManager/nm-applet added. airduct is kept NATIVE (it is tightly coupled to the
 * CML kernel's mac80211_hwsim — it fails HWSIM_CMD_REGISTER with -95 on other kernels),
 * so the client MUST be built on this Ubuntu base, booted via UEFI. NetworkManager owns
 * wlan0 (the image's wifi-autoconfig is masked); the user picks the SSID in nm-applet.
 *
 * This handler only wires the medium: it ensures the host airhandler is up and injects
 * the airduct virtio-serial port (/dev/virtio-ports/airduct) as a per-node listening
 * socket the airhandler connects to. No day-0 wpa_supplicant seed — association is
 * NetworkManager-driven in the desktop (a wpa_supplicant seed would fight NM on wlan0).
 * Console is VNC (see cwificlient.yml).
 *
 * @author pnetlab vap-node (cwificlient GUI)
 * @link https://www.pnetlab.com/
 */

class device_cwificlient extends device_qemu
{
    /** Optional: the SSID this client should target (informational; association is
     *  done interactively in nm-applet). Kept for a future NM-keyfile auto-join seed. */
    public $pnq_ssid = '';

    function __construct($node)
    {
        parent::__construct($node);
    }

    public function editParams($p)
    {
        if (isset($p['Wifi_SSID']) && $p['Wifi_SSID'] !== '') {
            $this->pnq_ssid = preg_replace('/[^A-Za-z0-9_\- ]/', '', (string) $p['Wifi_SSID']);
        }
        parent::editParams($p);
    }

    public function getParams()
    {
        $params = parent::getParams();
        return array_replace($params, [
            'Wifi_SSID' => $this->pnq_ssid,
        ]);
    }

    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) return $result;

        // Kill any orphaned qemu bound to this node's run path, then ensure the host
        // airhandler (airduct RF medium) is up — the image's native airduct connects
        // to it for its radio MAC and to exchange 802.11 frames with the cVAP.
        if (function_exists('broker_call')) {
            @broker_call('node_kill_orphan_qemu', ['run' => $this->getRunningPath()]);
            @broker_call('airhandler_ensure', []);
        }

        return 0;
    }

    public function customFlag($flag)
    {
        $rp = $this->getRunningPath();

        // Attach the airduct RF-medium transport (same wiring as the cVAP): a
        // virtio-serial port the guest sees as /dev/virtio-ports/airduct, exposed
        // as a per-node LISTENING socket (server,nowait) so boot never blocks; the
        // host airhandler connects in, assigns this client's radio MAC and relays
        // frames to/from the cVAP.
        $sock = $rp . '/airduct.sock';
        $flag .= ' -device virtio-serial-pci,id=vserairduct';
        $flag .= ' -chardev socket,id=airduct0,path=' . $sock . ',server=on,wait=off';
        $flag .= ' -device virtserialport,bus=vserairduct.0,chardev=airduct0,name=airduct';

        return $flag;
    }
}
