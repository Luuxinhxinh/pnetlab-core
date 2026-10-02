<?php

/**
 * 
 * @author LIN 
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 * 
 */

class device_timos extends device_qemu
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
            $this->timos_line = empty($p['timos_line'])? 'chassis=VSR-I slot=A card=cpm-v' : (string) $p['timos_line'];
            $this->timos_slot = (preg_match("/slot\s*=\s*([\S]+)/", $p['timos_line'], $output_array)) ? (string) $output_array[1] : 'A';
            $this->timos_chassis = (preg_match("/chassis=\s*([\S]+)/", $p['timos_line'], $output_array)) ? (string) $output_array[1] : 'VSR-I';
        } 
    
        if (isset($p['management_address'])) {
            $this->management_address = empty($p['management_address']) ? '1.1.1.1/24' : $p['management_address'];
        }
    
        if (isset($p['timos_license'])) {
            $this->timos_license = empty($p['timos_license']) ? '' : $p['timos_license'];
        }

        if (isset($p['timos_config'])) {
            $this->timos_config = (string) $p['timos_config'];
        }

        else {
             $this -> timos_config = NULL;
        }
    }

    public function getParams()
    {
        $params = parent::getParams();
        return array_replace($params, [
            'timos_line' => $this-> timos_line,
            'management_address' => $this-> management_address,
            'timos_license' => $this-> timos_license
        ]);
    }

    public function customFlag($flag)
    {

        if (isset($this->timos_license)) {
            $flag .= ' -smbios type=1,product=\"' . 'Timos:' . $this-> timos_line;
            if (($this-> management_address) != '') {
                $flag .= ' address=' . $this-> management_address . '@active';
            }
            if (($this-> timos_license) != '') {
                $flag .= ' license-file=' .  $this-> timos_license;
            }
            $flag .= '\"';
        } elseif (isset($this-> timos_line)) {

            $flag .= ' -smbios type=1,product=\"' . 'Timos:' . $this-> timos_line;
            $flag .= '\"';
        }

        if(is_file($this->getRunningPath() . '/floppy.img') && !is_file($this->getRunningPath() . '/.configured') && $this->config != 0) {
            $flag = preg_replace('/Timos:/', 'Timos: primary-config=cf1:config.cfg ', $flag);
            $flag .= ' -hdb floppy.img';
        }

        return $flag;
    }


    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) return $result;

        if (is_file($this->getRunningPath() . '/startup-config') && !is_file($this->getRunningPath() . '/.configured')) {
            $floppycmd = 'mkdosfs -C ' . $this->getRunningPath() . '/floppy.img 1440';
            exec($floppycmd, $o, $rc);
            $floppycmd = 'mkdir ' . $this->getRunningPath() . '/floppy';
            exec($floppycmd, $o, $rc);
            $floppycmd = 'modprobe loop ; mount ' . $this->getRunningPath() . '/floppy.img ' . $this->getRunningPath() . '/floppy';
            exec($floppycmd, $o, $rc);
            copy($this->getRunningPath() . '/startup-config', $this->getRunningPath() . '/floppy/config.cfg');
            $floppycmd = 'umount ' . $this->getRunningPath() . '/floppy';
            exec($floppycmd, $o, $rc);
        }

        return 0;
    }
}
