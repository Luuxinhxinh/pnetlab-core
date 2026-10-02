#!/bin/bash
#Create vswitch UADP
if [ ! -e  $1/conf/vswitch.xml ] ; then \
mkdir $1/conf
cat >> $1/conf/vswitch.xml << EOF
<?xml version="1.0"?>
          <switch>
            <board_id>20612</board_id>
EOF
SERIAL=$(openssl rand -hex 6 | tr a-z A-Z)
echo "            <prod_serial_number>$SERIAL</prod_serial_number>" >> $1/conf/vswitch.xml
echo "            <port_count>8</port_count>" >> $1/conf/vswitch.xml
for i in $(seq 1 25) ; do \
	echo "            <port lpn=\"$i\">" >>  $1/conf/vswitch.xml
	echo "             <asic_id>0</asic_id>" >>  $1/conf/vswitch.xml
	echo "             <asic_ifg>0</asic_ifg>" >>  $1/conf/vswitch.xml
	echo "             <asic_slice>0</asic_slice>" >>  $1/conf/vswitch.xml
	echo "            </port>" >>  $1/conf/vswitch.xml
done
echo "          </switch>" >>  $1/conf/vswitch.xml
mkisofs -o $1/config.iso -l --iso-level 2 $1/conf
fi
