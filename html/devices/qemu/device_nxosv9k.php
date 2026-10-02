<?php

/**
 * 
 * @author LIN 
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 * 
 */

class device_nxosv9k extends device_qemu
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

    public function createEthernets($quantity)
    {
        $ethernets = [];
        $first = 0 ;
        $bridgeid = 0;
        $addr = 0;

            if ($this->inject_as_first_nic == 1) {
                         /*FOR CUSTOM COSNOLES */
                        if ($this->console == 'http' || $this->console_2nd == 'http' ){   
                                        $ethernets[$quantity] = new Interfc( $this, array('name' => 'Mgmt http', 'type' => 'ethernet',), $quantity);
                                        $first ++;
                                }
                        if ($this->console == 'https' || $this->console_2nd == 'https' ){   
                                        $ethernets[$quantity + 1 ] = new Interfc( $this, array('name' => 'Mgmt https', 'type' => 'ethernet',), $quantity + 1);
                                        $first ++;
                        }
                        if ($this->console == 'ssh' || $this->console_2nd == 'ssh' ){   
                                         $ethernets[$quantity + 2 ] = new Interfc( $this, array('name' => 'Mgmt ssh', 'type' => 'ethernet',), $quantity + 2);
                                         $first ++;
                        }
                        /*FOR CUSTOM COSNOLES */
            }

        for ($i = 0; $i < $quantity; $i++) {

            if (!isset($this->ethernets[$i])) {
                    if($i == 0 && $this->first_nic != ''){
                        $flag = '  -device '.$this->first_nic.',netdev=net' . $i . ',mac=' . incMac($this->createFirstMac(), $i);
                        $flag .= ' -netdev tap,id=net' . $i . ',ifname=vunl' . $this->getSession() . '_' . $i . ',script=no';
                    }else {
                        if ( $this->pci_mode == 'multifunction' || $this->pci_mode == '' || $this->pci_mode == 'Default')
                        {
                            $flag = ' -device  %NICDRIVER%,addr=' . ((int) ($i / 8) + 4) . '.' . ($i % 8) . ',multifunction=on,netdev=net' . $i . ',mac=' . incMac($this->createFirstMac(), $i);
                            $flag .= ' -netdev tap,id=net' . $i . ',ifname=vunl' . $this->getSession() . '_' . $i . ',script=no';
                        }
                        else if ( $this->pci_mode == 'Pci_Bridge') {
                            if ($i <= 23)
                                {
                                    $flag = ' -device %NICDRIVER%,netdev=net' . $i . ',mac=' . incMac($this->createFirstMac(), $i);
                                    $flag .= ' -netdev tap,id=net' . $i . ',ifname=vunl' . $this->getSession() . '_' . $i . ',script=no';

                                }
                            else {
                                    if ($i % 24 == 0){
                                            $addr = 0;
                                            $bridgeid++;
                                            $flag = '-device pci-bridge,id=pci_bridge'.$bridgeid.',bus=dmi_pci_bridge,chassis_nr=0x1,addr=0x'.$bridgeid.',shpc=off ';
                                            $flag .= ' -device %NICDRIVER%,netdev=net'. $i.',mac=' . incMac($this->createFirstMac(), $i) . ',bus=pci_bridge'.$bridgeid.',addr=0x' . sprintf("%02x\n",$addr) ;

                                            } else {
                                                    $addr++;
                                            $flag = ' -device %NICDRIVER%,netdev=net'. $i.',mac=' . incMac($this->createFirstMac(), $i) . ',bus=pci_bridge'.$bridgeid.',addr=0x' . sprintf("%02x\n",$addr) ;

                                     }
                                    $flag .= ' -netdev tap,id=net' . $i . ',ifname=vunl' . $this->getSession() . '_' . $i . ',script=no';
                                }
                        }
                    }
                    if ($first > 0 ) { 
                                $n = 'E1/' . ($i + $first);          // Interface name
                    }else {
                            if ($i == 0) {
                                $n = 'Mgmt0';           // Interface name
                            } else {
                                $n = 'E1/' . $i;          // Interface name
                            }
                    }

                try {
                    $ethernets[$i] = new Interfc( $this, array('name' => $n, 'type' => 'ethernet', 'flag' => $flag), $i);
                } catch (Exception $e) {
                    error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][40020]);
                    error_log(date('M d H:i:s ') . (string) $e);
                    return false;
                }
            } else {
                $ethernets[$i] = $this->ethernets[$i];
            }
            // Setting CMD flags (virtual device and map to TAP device)

        }

        $this->ethernets = $ethernets;
        return $this->ethernets;
    }

    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) return $result;

        if (is_file($this->getRunningPath() . '/startup-config') && !is_file($this->getRunningPath() . '/.configured')) {
            copy($this->getRunningPath() . '/startup-config',  $this->getRunningPath() . '/nxos_config.txt');
            $isocmd = 'mkisofs -o ' . escapeshellarg($this->getRunningPath() . '/config.iso') . ' -l --iso-level 2 -V disk ' . escapeshellarg($this->getRunningPath() . '/nxos_config.txt');
            exec($isocmd, $o, $rc);
        }
        // Fresh node (no saved config): deliver the CML-style day-0 config so the node
        // autoboots past the loader> prompt (EEM BOOTCONFIG applet sets "boot nxos" on first
        // config apply, persisting across reloads), comes up with hostname = node name, and
        // has a usable admin/cisco login. Default-ON; opt out per node via Initial_startup_config '0'.
        else if (!is_file($this->getRunningPath() . '/.configured') && $this->Initial_startup_config != '0') {
            $nxos_cfg = $this->getRunningPath() . '/nxos_config.txt';
            $file_contents = file_get_contents('/opt/unetlab/startup_configs/nxos/nxos_base_startup-config.txt');
            $file_contents = str_replace('inserthostname-here', $this->name, $file_contents);
            file_put_contents($nxos_cfg, $file_contents);
            $isocmd = 'mkisofs -o ' . escapeshellarg($this->getRunningPath() . '/config.iso') . ' -l --iso-level 2 -V disk ' . escapeshellarg($nxos_cfg);
            exec($isocmd, $o, $rc);
        }

        return 0;
    }

    public function customFlag($flag)
    {
        // Attach the day-0 cidata CD whenever it exists and the node has not been marked
        // configured (saved-config OR default base seed). NOT gated on wrapper.txt: that is
        // just qemu's stdout file (recreated on every start) and a Wipe can leave it behind,
        // which would suppress the seed on the post-wipe boot -> NX-OS boots to loader> with
        // no day-0 config. With the seed always present, NX-OS re-runs the bootstrap only
        // after a Wipe clears the disk overlay (a configured node ignores the config CD).
        if (is_file($this->getRunningPath() . '/config.iso') && !is_file($this->getRunningPath() . '/.configured')
            && ($this->config != 0 || $this->Initial_startup_config != '0')) {
            $flag .= ' -drive file=config.iso,if=ide,media=cdrom,index=3';
        }
        return $flag;
    }
}
