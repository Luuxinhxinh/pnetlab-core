#!/bin/bash

# prep_c8000vcm.sh
#
# Config ISO generation script for c8000v in controller mode (cEdge/SD-WAN).
#
# @author Torbjørn Bang <hei@torbjorn.dev>
# @copyright 2023 Torbjørn Bang
# @license BSD-3-Clause https://github.com/torbbang/eve-ng_c8000vcm/blob/main/LICENSE

# Insert eve-ng configscraper user if it doesn't exist
if ! grep -q "username eveconfigscraper" $1/startup-config; then
	sed -i '0,/username \w/s//username eveconfigscraper privilege 15 secret eveconfigscraper\n&/' $1/startup-config
fi

# Check if this is a bootstrap config or a config fetched from the device directly
if grep -q "MIME-Version:" $1/startup-config; then
	cat $1/startup-config > $1/ciscosdwan_cloud_init.cfg
else
	# Build cloud-init with default boot config in cloud-boothook
	cat > "$1/ciscosdwan_cloud_init.cfg" << 'ENDOFMIME'
Content-Type: multipart/mixed; boundary="===================================="
MIME-Version: 1.0
--====================================
#cloud-config
vinitparam:
 - uuid : C8K-00000000-0000-0000-0000-000000000000
 - otp : 00000000000000000000000000000000
 - vbond : 203.0.113.1
 - org : eve-lab
 - rcc : true
ca-certs:
  remove-defaults: false
--====================================
#cloud-boothook
config-transaction
!
logging discriminator GO-AWAY mnemonic drops PLATFORM_ERROR
logging console discriminator GO-AWAY
!
line con 0
 exec-timeout 0 0
 logging synchronous
 stopbits 1
platform console serial
commit
--====================================--
ENDOFMIME

	# Indent any user startup-config and insert it before the closing boundary
	sed -i 's/^/  /g' "$1/startup-config"
	sed -i -e "\$e cat ${1}/startup-config" "$1/ciscosdwan_cloud_init.cfg"
fi

# Generate ISO
mkisofs -o $1/config.iso -l --iso-level 2 $1/ciscosdwan_cloud_init.cfg
