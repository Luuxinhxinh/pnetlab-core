#!/bin/bash

cleanup () {
	echo "Cleaning up..."
	umount -f -q $MNTDIR
	losetup -d $LOOPDEV
	rm -rfv $STAGING
	rm -rfv $MNTDIR
}
cleanup_failed () {
	cleanup;
	rm -rfv $1/virtiob.qcow2
	exit 1
}
STAGING=`mktemp -d -p /var/tmp`
MNTDIR=`mktemp -d -p /var/tmp`
mkdir $STAGING/config
cp -v $1/startup-config $STAGING/config/juniper.conf
qemu-img create -f raw $1/virtiob.qcow2 1M
LOOPDEV=`losetup --show -f $1/virtiob.qcow2`
if [ $? != 0 ]; then
        cleanup_failed;
fi
mkfs.vfat  -v -n "vmm-data" $LOOPDEV
if [ $? != 0 ]; then
        echo "Failed to format disk $LOOPDEV; exiting"
        cleanup_failed;
fi
mount -t vfat $LOOPDEV $MNTDIR
if [ $? != 0 ]; then
        echo "Failed to mount metadisk $LOOPDEV; exiting"
        cleanup_failed;

fi
(cd $STAGING; tar cvzf $MNTDIR/vmm-config.tgz .)
cleanup
echo "Config disk $1/virtiob.qcow2 created"
exit 0

