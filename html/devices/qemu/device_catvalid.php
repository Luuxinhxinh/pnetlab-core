<?php

/**
 * device_catvalid.php — Cisco Catalyst SD-WAN Validator (vBond) day-0 prestage.
 *
 * Identical cidata-seed mechanism as device_catmanager.php (see that file for the rationale);
 * only the base cloud-config differs (startup_configs/sdwan/validator_user-data.txt — vBond
 * personality vedge/vedge-cloud with <vbond><local/></vbond>). Default-ON; opt out per node
 * via Initial_startup_config '0'. Saved startup-config (the Builder path) is delivered verbatim.
 *
 * @author pnetlab-noble sdwan-builder
 * @link https://www.pnetlab.com/
 */

class device_catvalid extends device_qemu
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
     * Label the link-picker interfaces to match the names viptela reports inside
     * the appliance, so wiring in the GUI is unambiguous. vBond is vedge-cloud:
     * the first NIC is the management interface `eth0` (VPN 512); the remaining
     * NICs are the transport interfaces `ge0/0`, `ge0/1`, … (VPN 0). Confirmed by
     * MAC order (net0 = OS eth0 = viptela eth0). This only changes the DISPLAYED
     * name; links still bind by interface index, so the qemu NIC order is unchanged.
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

                // NIC 0 = eth0 (mgmt / VPN 512); NIC 1.. = ge0/0, ge0/1, … (VPN 0).
                $n = ($i == 0) ? 'eth0' : ('ge0/' . ((int) $i - 1));

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

        $rp = $this->getRunningPath();

        if (is_file($rp . '/startup-config') && !is_file($rp . '/.configured')) {
            $this->buildCidata(file_get_contents($rp . '/startup-config'));
        } else if (!is_file($rp . '/.configured') && $this->Initial_startup_config != '0') {
            $file_contents = file_get_contents('/opt/unetlab/startup_configs/sdwan/validator_user-data.txt');
            $file_contents = str_replace('inserthostname-here', $this->name, $file_contents);
            $this->buildCidata($file_contents);
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
        // of the day-0 bring-up runs. With the seed always present, cloud-init de-dups by
        // instance-id and only re-provisions after a Wipe clears the disk overlay.
        if (is_file($rp . '/config.iso') && !is_file($rp . '/.configured')
            && ($this->config != 0 || $this->Initial_startup_config != '0')) {
            $flag .= ' -drive file=config.iso,if=ide,media=cdrom,index=3';
        }
        return $flag;
    }
}
