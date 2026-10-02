#!/bin/bash
env >> /tmp/setprimary.log

if [ -e /opt/unetlab/primary ] ; then \
	PRIMARY=$(cat /opt/unetlab/primary)
else
	exit 0
fi
if [ "$ID_NET_NAME_MAC" == "$PRIMARY" -a "$INTERFACE" != "eth0" ] ; then \
	ip link set eth0 name evehold
	ip link set $INTERFACE name eth0
	ip link set evehold name $INTERFACE
fi
