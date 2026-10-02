#!/bin/bash
if [ ! -e /opt/unetlab/nicorder ] ; then \
	exit 0
fi

. /opt/unetlab/nicorder


LIVE_ID_NET_NAME_MAC=$(cat /sys/class/net/${!ID_NET_NAME_MAC}/address | sed -e 's/://g' -e 's/^/enx/')



if [ $LIVE_ID_NET_NAME_MAC = $ID_NET_NAME_MAC ] ; then exit 0 ; fi


if [ -n "${!ID_NET_NAME_MAC}" -a  "${!ID_NET_NAME_MAC}" !=  "$INTERFACE" ] ; then \
	ip link set $INTERFACE name ${!ID_NET_NAME_MAC}
	if [ $? -ne 0 ] ; then \
		ip link set $INTERFACE name ${!ID_NET_NAME_MAC}-new
	fi
	# try set evry interface
	 ls -d /sys/class/net/eth* | sed -e 's,.*/,,' | grep new | while read IF 
	 	do TIF=$(echo $IF | sed -e 's/-new//') 
			ip link set $IF name $TIF
		done
	echo "rename $INTERFACE to  ${!ID_NET_NAME_MAC}" >> /root/nicorder.log
fi

#if [ "$ID_NET_NAME_MAC" == "$PRIMARY" -a "$INTERFACE" != "eth0" ] ; then \
#	ip link set eth0 name evehold
#	ip link set $INTERFACE name eth0
#	ip link set evehold name $INTERFACE
#	echo "rename $INTERFACE to eth0" >> /root/setprimary.log
#fi
