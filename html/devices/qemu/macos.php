<?php

/**
 * 
 * @author LIN 
 * @author NEJIBTECH 
 * @copyright pnetlab.com
 * @link https://www.pnetlab.com/
 * 
 */

class macos extends device_qemu
{

    function __construct($node)
    {
        parent::__construct($node);
    }
     public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) return $result;

            if (file_exists('/opt/unetlab/scripts/Mac_os_Guest/OVMF_CODE.fd')) {
                    symlink('/opt/unetlab/scripts/Mac_os_Guest/OVMF_CODE.fd', $this->getRunningPath() . '/OVMF_CODE.fd');
                }
            if (!file_exists( $this->getRunningPath() . '/OVMF_VARS-1024x768.fd')) {
                    copy('/opt/unetlab/scripts/Mac_os_Guest/OVMF_VARS-1024x768.fd', $this->getRunningPath() . '/OVMF_VARS-1024x768.fd');
                }
            if (file_exists('/opt/unetlab/scripts/Mac_os_Guest/OpenCore.qcow2')) {
                    symlink('/opt/unetlab/scripts/Mac_os_Guest/OpenCore.qcow2', $this->getRunningPath() . '/OpenCore.qcow2');
    }

        return 0;
    }

  
}

