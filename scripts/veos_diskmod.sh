#!/bin/sh

if [ -x /opt/qemu/bin/qemu-nbd ]; then
	QEMUNBD=/opt/qemu/bin/qemu-nbd
else
	QEMUNBD=/opt/qemu-5.2.0/bin/qemu-nbd
fi

wait_nbd() {
	n=0
	while [ "$(blockdev --getsize64 /dev/nbd${1} 2>/dev/null || echo 0)" -eq 0 ]; do
		sleep 0.1
		n=$((n + 1))
		[ "$n" -gt 100 ] && return 1
	done
	partprobe /dev/nbd${1} 2>/dev/null || true
	udevadm settle --timeout=10 2>/dev/null || true
	n=0
	while [ ! -b /dev/nbd${1}p1 ] && [ ! -b /dev/nbd${1}p2 ]; do
		sleep 0.1
		n=$((n + 1))
		[ "$n" -gt 100 ] && return 1
	done
	return 0
}

cd $1
rmmod nbd
modprobe nbd nbds_max=128 max_part=16
for i in $(seq 0 127)
do  fuser -s  /dev/nbd${i} && continue
        $QEMUNBD -c /dev/nbd${i} *.qcow2 || continue
        wait_nbd $i || { $QEMUNBD -d /dev/nbd${i}; continue; }
        mkdir disk
        mount /dev/nbd${i}p1 disk && ( sleep 1 && cp startup-config disk/startup-config )
        if [ $? -ne 0 ] ; then
                umount disk
                mount /dev/nbd${i}p2 disk
                sleep 1
                cp startup-config disk/startup-config
                echo "DISABLE=True" > disk/zerotouch-config
        fi
        umount disk
        $QEMUNBD -d /dev/nbd${i}
        rm -fr disk
        break
done
