<?php

/**
 * 
 * @author LIN 
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 * 
 */

class device_catalyst extends device_qemu
{



    function __construct($node)
    {
        parent::__construct($node);
    }
 public function customFlag($flag)
    {
        if(is_file($this->getRunningPath() . '/config.iso') && !is_file($this->getRunningPath() . '/.configured') && $this->config != 0) {
            $flag .= ' -cdrom config.iso';
        }
        return $flag;
    }


    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) return $result;

        if (is_file($this->getRunningPath() . '/startup-config') && !is_file($this->getRunningPath() . '/.configured')) {
            copy($this->getRunningPath() . '/startup-config',  $this->getRunningPath() . '/iosxe_config.txt');
            $isocmd = 'mkisofs -o ' . $this->getRunningPath() . '/config.iso -l --iso-level 2 ' . $this->getRunningPath() . '/iosxe_config.txt';
            exec($isocmd, $o, $rc);
        }

        return 0;
    }
}