<?php

/**
 * device_catmanager.php — Cisco Catalyst SD-WAN Manager (vManage) day-0 prestage.
 *
 * Mirrors device_nxosv9k.php, but the day-0 config is delivered as a cloud-init
 * "cidata" seed ISO (volume label `cidata`, files `user-data` + `meta-data`) instead
 * of the NX-OS single-file label-`disk` ISO — viptela appliances bootstrap from
 * cloud-init, exactly as CML provisions them (cat-sdwan-manager node-def:
 * provisioning.volume_name = cidata, media_type = iso).
 *
 * - Fresh node, no saved config: the base cloud-config from
 *   startup_configs/sdwan/manager_user-data.txt is used as user-data, with the node
 *   name substituted for the `inserthostname-here` token, so a hand-dropped vManage
 *   boots past the setup dialog with hostname + admin/admin + DHCP mgmt.
 * - Saved startup-config present (the path the "Cisco SDWAN Lab Builder" uses): the
 *   saved config IS the full rendered cloud-config (root-CA/org/vBond/system-ip/...),
 *   and it is wrapped verbatim as user-data.
 *
 * Default-ON; opt out per node via Initial_startup_config '0'.
 *
 * @author pnetlab-noble sdwan-builder
 * @link https://www.pnetlab.com/
 */

class device_catmanager extends device_qemu
{

    function __construct($node)
    {
        parent::__construct($node);
    }

    public function editParams($p)
    {
        if (isset($p['Initial_startup_config'])) {
            $this->Initial_startup_config = (string) $p['Initial_startup_config'];
        }

        parent::editParams($p);
    }

    public function getParams()
    {
        $params = parent::getParams();

        return array_replace($params, [
            'Initial_startup_config' => $this->Initial_startup_config
        ]);
    }

    /**
     * Label the link-picker interfaces eth0..ethN to match the names vManage
     * reports inside the appliance (eth0 = mgmt/VPN 512, eth1 = VPN 0 transport,
     * …). Display-only — links still bind by interface index.
     */
    public function createEthernets($quantity)
    {
        $ethernets = [];

        for ($i = 0; $i < $quantity; $i++) {

            if (!isset($this->ethernets[$i])) {

                if ($i == 0 && $this->first_nic != '') {
                    $flag = ' -device ' . $this->first_nic . ',netdev=net' . $i . ',mac=' . incMac($this->createFirstMac(), $i);
                } else {
                    $flag = ' -device %NICDRIVER%,netdev=net' . $i . ',mac=' . incMac($this->createFirstMac(), $i);
                }
                $flag .= ' -netdev tap,id=net' . $i . ',ifname=vunl' . $this->getSession() . '_' . $i . ',script=no';

                $n = 'eth' . ((int) $i);

                try {
                    $ethernets[$i] = new Interfc($this, array('name' => $n, 'type' => 'ethernet', 'flag' => $flag), $i);
                } catch (Exception $e) {
                    error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][40020]);
                    error_log(date('M d H:i:s ') . (string) $e);
                    return false;
                }
            } else {
                $ethernets[$i] = $this->ethernets[$i];
            }
        }

        $this->ethernets = $ethernets;
        return $this->ethernets;
    }

    /**
     * Build the cidata seed ISO (user-data + meta-data) in the node running path.
     * $userdata holds the cloud-config to deliver as user-data.
     */
    private function buildCidata($userdata)
    {
        $rp = $this->getRunningPath();
        file_put_contents($rp . '/user-data', $userdata);
        // cloud-init NoCloud: instance-id + local-hostname keyed on the node name.
        file_put_contents(
            $rp . '/meta-data',
            "instance-id: " . $this->name . "\nlocal-hostname: " . $this->name . "\n"
        );
        // Both files MUST sit at the ISO root and the volume MUST be labelled `cidata`.
        // cd into the running path so the entries are added by basename, not full path.
        $isocmd = 'cd ' . escapeshellarg($rp)
            . ' && mkisofs -J -r -V cidata -o config.iso user-data meta-data';
        exec($isocmd, $o, $rc);
    }

    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) return $result;

        $rp = $this->getRunningPath();

        if (is_file($rp . '/startup-config') && !is_file($rp . '/.configured')) {
            // Saved config (Builder path or user-edited): deliver it verbatim as user-data.
            $this->buildCidata(file_get_contents($rp . '/startup-config'));
        }
        // Fresh node (no saved config): deliver the standalone base cloud-config so the
        // appliance boots past the first-boot setup dialog with hostname = node name and
        // a usable admin/admin login on a DHCP management interface.
        else if (!is_file($rp . '/.configured') && $this->Initial_startup_config != '0') {
            $file_contents = file_get_contents('/opt/unetlab/startup_configs/sdwan/manager_user-data.txt');
            $file_contents = str_replace('inserthostname-here', $this->name, $file_contents);
            $this->buildCidata($file_contents);
        }

        return 0;
    }

    public function customFlag($flag)
    {
        $rp = $this->getRunningPath();
        // Attach the day-0 cidata CD whenever it exists and the node has not been marked
        // configured (saved-config OR default base seed). NOT gated on wrapper.txt: that is
        // just qemu's stdout file (recreated on every start) and a Wipe can leave it behind,
        // which would suppress the seed on the post-wipe boot -> cloud-init finds no
        // datasource (reports "disabled") -> none of the day-0 bring-up runs. With the seed
        // always present, cloud-init de-dups by instance-id and only re-provisions after a
        // Wipe clears the disk overlay.
        if (is_file($rp . '/config.iso') && !is_file($rp . '/.configured')
            && ($this->config != 0 || $this->Initial_startup_config != '0')) {
            $flag .= ' -drive file=config.iso,if=ide,media=cdrom,index=3';
        }
        return $flag;
    }
}
