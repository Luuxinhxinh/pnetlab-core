<?php

/**
 * 
 * @author LIN 
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 * 
 */

class device_vqfxre extends device_qemu
{

    function __construct($node)
    {
        parent::__construct($node);
    }

    public function createEthernets($quantity)
    {
        $ethernets = [];
        $first = 0 ;
        $bridgeid = 0;
        $addr = 0;

        for ($i = 0; $i < $quantity; $i++) {
            if (!isset($this->ethernets[$i])) {
                    if($i == 0 && $this->first_nic != ''){
                        $flag = '  -device '.$this->first_nic.',netdev=net' . $i . ',mac=' . incMac($this->createFirstMac(), $i);
                        $flag .= ' -netdev tap,id=net' . $i . ',ifname=vunl' . $this->getSession() . '_' . $i . ',script=no';
                    }else {

                        if ( $this->pci_mode == 'Default' || $this->pci_mode == '' ){
                        
                        $flag = ' -device %NICDRIVER%,netdev=net' . $i . ',mac=' . incMac($this->createFirstMac(), $i);

                        $flag .= ' -netdev tap,id=net' . $i . ',ifname=vunl' . $this->getSession() . '_' . $i . ',script=no';
                        }
                        else if ( $this->pci_mode == 'multifunction'  )
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
                            if ($i == 0) {
                                $n = 'em1 / int';              // Interface name
                            } else if ($i == 1) {
                                $n = 'em2 / mgmt';              // Interface name
                            } else {
                                $n = 'xe-0/0/' . ($i - 2);
                            }                    
                    }else {
                            if ($i == 0) {
                                $n = 'em0 / fxp0';                      // Interface name
                            } else if ($i == 1) {
                                $n = 'em1 / int';              // Interface name
                            } else if ($i == 2) {
                                $n = 'em2 / mgmt';              // Interface name
                            } else {
                                $n = 'xe-0/0/' . ($i - 3);
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

    public function customFlag($flag)
    {
        if(is_file($this->getRunningPath() . '/config.iso') && !is_file($this->getRunningPath() . '/.configured') && $this->config != 0) {
            $flag .= ' -drive file=config.iso,if=virtio,media=cdrom,index=2';
        }
        return $flag;
    }

    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) return $result;

        if (is_file($this->getRunningPath() . '/startup-config') && !is_file($this->getRunningPath() . '/.configured')) {
            copy($this->getRunningPath() . '/startup-config',  $this->getRunningPath() . '/juniper.conf');
            $isocmd = 'mkisofs -o ' . $this->getRunningPath() . '/config.iso -l --iso-level 2 ' . $this->getRunningPath() . '/juniper.conf';
            exec($isocmd, $o, $rc);
        }

        return 0;
    }
}
