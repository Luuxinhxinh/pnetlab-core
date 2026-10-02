<?php

/**
 * PNetLab native RXE endpoint.
 *
 * The guest has one fabric/data NIC.  The controller reaches the restricted
 * read-only guest agent on virtio-vsock, so no management NIC is added.  Keep
 * the CID derivation identical to pnq-roce.php: it is stable for a server-owned
 * node session plus UUID and does not depend on browser-provided identity.
 */
class device_rxe extends device_qemu
{
    public function __construct($node)
    {
        parent::__construct($node);
    }

    /**
     * Map the node UUID into the safe guest-CID range used by PNetLab's
     * existing vsock-backed QEMU appliances.
     */
    protected function guestCid()
    {
        $identity = (string) $this->getSession() . ':' . (string) $this->uuid;
        return (crc32($identity) % 0x7fff0000) + 0x10000;
    }

    /**
     * Retire a QEMU orphan from an earlier incarnation of this runtime before
     * launching a replacement.  A stale RXE QEMU keeps its AF_VSOCK guest CID
     * even after the runtime directory is removed, making every later start
     * fail with "guest cid: Address already in use".
     */
    public function prepare()
    {
        $result = parent::prepare();
        if ($result != 0) {
            return $result;
        }

        if (!function_exists('broker_call')) {
            error_log(date('M d H:i:s ') . 'ERROR: RXE orphan cleanup broker unavailable');
            return 1;
        }

        $cleanup = broker_call(
            'rxe_kill_orphan_qemu',
            ['run' => $this->getRunningPath()],
            10
        );
        if (empty($cleanup['ok'])) {
            error_log(date('M d H:i:s ') . 'ERROR: RXE orphan cleanup failed');
            return 1;
        }

        return 0;
    }

    /**
     * Add the one and only control-plane device.  The RXE template deliberately
     * has no vsock option of its own, so this stays the sole injection point.
     */
    public function customFlag($flag)
    {
        return $flag . ' -device vhost-vsock-pci,id=rxe0,guest-cid=' . $this->guestCid();
    }
}
