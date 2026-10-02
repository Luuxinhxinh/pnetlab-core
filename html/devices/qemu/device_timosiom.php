<?php

/**
 * 
 * @author LIN 
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 * 
 */

class device_timosiom extends device_qemu
{

    function __construct($node)
    {
        parent::__construct($node);
    }

    public function editParams($p)
    {
        parent::editParams($p);
                #TimosLine
        if (isset($p['timos_line'])){
            $this->timos_line = empty($p['timos_line'])? 'slot=1 chassis=SR-12 card=iom3-xp-b mda/1=m10-1gb-sfp-b mda/2=isa-bb' : (string) $p['timos_line'];
            $this->timos_slot = (preg_match("/slot\s*=\s*([\S]+)/", $p['timos_line'], $output_array)) ? (string) $output_array[1] : '1';
            $this->timos_chassis = (preg_match("/chassis=\s*([\S]+)/", $p['timos_line'], $output_array)) ? (string) $output_array[1] : 'SR-12';
        }

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

                if ($i == 0) {                // management
                    $n = 'Mgmt';
                } else if ($i == 1) {        // Switch Fabric
                    $n = 'SF';
                } else {
                    $n = $this-> timos_slot . '/1/' . ($i - 1);         // Interface name

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

    public function getParams()
    {

        $params = parent::getParams();
        return array_replace($params, [
            'timos_line' => $this->timos_line,
            'timos_license' => $this->timos_license,
            'management_address' => $this->management_address,

        ]);
    }

    public function customFlag($flag)
    {

        if (isset($this->timos_license)) {
            $flag .= ' -smbios type=1,product=\"' . 'Timos:' . $this->timos_line;
            if (($this->management_address) != '') {
                $flag .= ' address=' . $this->management_address . '@active';
            }
            if (($this->timos_license) != '') {
                $flag .= ' license-file=' .  $this->timos_license;
            }
            $flag .= '\"';
        } elseif (isset($this->timos_line)) {

            $flag .= ' -smbios type=1,product=\"' . 'Timos:' . $this->timos_line;
            $flag .= '\"';
        }

        return $flag;
    }
}
