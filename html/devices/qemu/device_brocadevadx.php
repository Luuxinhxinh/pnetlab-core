<?php

/**
 * 
 * @author LIN 
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 * 
 */

class device_brocadevadx extends device_qemu
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
                
                            if ($first > 0) {                                 
                                $n = 'Port ' . ($i + $first );        // Interface name
                            
                            }
                            else {
                                if ($i == 0) {
                                $n = 'Mgmt';           // Interface name
                            } else {
                                $n = 'Port ' . $i;        // Interface name
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
        }

        $this->ethernets = $ethernets;
        return $this->ethernets;
    }
}
