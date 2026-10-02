cp $1/startup-config $1/iosxe_config.txt 2>/dev/null || touch $1/iosxe_config.txt
mkisofs -o $1/config.iso -l --iso-level 2 $1/iosxe_config.txt
