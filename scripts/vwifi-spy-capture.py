#!/usr/bin/env python3
# vwifi-spy-capture — tee the vwifi (mac80211_hwsim) emulated medium to a pcap.
#
# The Raizo62 vwifi-server has a built-in SPY port (default 8213) that streams EVERY
# frame crossing the medium to any receive-only client — no registration handshake.
# The wifi-spike container runs --network host, so the port is reachable at
# 127.0.0.1:8213 on the host. This is the vwifi twin of the airduct airhandler._flood
# tee: connect to the spy port, decode the stream, and write a DLT_IEEE802_11 pcap.
#
# SPY WIRE FORMAT (reverse-engineered from Raizo62/vwifi src, byte-verified):
#   Per frame, repeating:
#     * 1 byte  : TPower (typedef s8) — the medium signal in dBm (approx -123..20).
#     * netlink : a generic-netlink HWSIM_CMD_FRAME message. The first 4 bytes are
#                 nlmsghdr.nlmsg_len (u32 LE) = the WHOLE netlink message length; the
#                 raw 802.11 frame is the HWSIM_ATTR_FRAME (attr type 3) payload,
#                 after nlmsghdr(16) + genlmsghdr(4).
#   (cwifi.cc RecvSignalWithSocket + vwifi-server.cc ForwardData ->
#    SendAllClientsWithoutLoss(power, netlink_msg).)
#
# Invoked by the broker (wifi_capture verb, medium=vwifi) as a transient unit while the
# per-session marker exists; it self-exits when the marker is removed. Writes
# DLT_IEEE802_11 (bare 802.11, matching the airduct tee).
#
# CAVEAT: the vwifi-server medium is HOST-GLOBAL (one shared container for all vwifi
# nodes), and the spy stream carries no session tag — so on a host running MULTIPLE
# vwifi labs at once this pcap includes every lab's vwifi frames. For the common
# single-vwifi-lab case it is exactly that lab's traffic.

import argparse
import os
import socket
import struct
import sys
import time

PCAP_MAGIC = 0xA1B2C3D4
DLT_IEEE802_11 = 105
NLMSG_HDRLEN = 16          # struct nlmsghdr
GENL_HDRLEN = 4            # struct genlmsghdr
HWSIM_ATTR_FRAME = 3
MTU = 65535


def log(msg):
    sys.stderr.write("[vwifi-spy] %s\n" % msg)
    sys.stderr.flush()


def recv_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        try:
            chunk = sock.recv(n - len(buf))
        except socket.timeout:
            return None            # caller re-checks the marker
        if not chunk:
            return b""             # peer closed
        buf += chunk
    return bytes(buf)


def parse_hwsim_frame(nlmsg):
    """Extract the HWSIM_ATTR_FRAME (raw 802.11) payload from a genl netlink message,
    or None if this message carries no frame (e.g. a control message)."""
    off = NLMSG_HDRLEN + GENL_HDRLEN            # attrs start after nlmsghdr + genlmsghdr
    n = len(nlmsg)
    while off + 4 <= n:
        nla_len, nla_type = struct.unpack_from("<HH", nlmsg, off)
        if nla_len < 4:
            break
        atype = nla_type & 0x3FFF               # strip NLA_F_NESTED / byteorder flags
        data_off = off + 4
        data_end = off + nla_len
        if data_end > n:
            break
        if atype == HWSIM_ATTR_FRAME:
            return nlmsg[data_off:data_end]
        off += (nla_len + 3) & ~3               # NLA_ALIGN(4)
    return None


class PcapFile:
    def __init__(self, path):
        self.f = open(path, "wb")
        self.f.write(struct.pack("<IHHiIII", PCAP_MAGIC, 2, 4, 0, 0, MTU, DLT_IEEE802_11))
        self.f.flush()

    def write(self, raw):
        now = time.time()
        sec = int(now)
        usec = int((now - sec) * 1_000_000)
        n = len(raw)
        self.f.write(struct.pack("<IIII", sec, usec, n, n))
        self.f.write(raw)
        self.f.flush()

    def close(self):
        try:
            self.f.close()
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pcap", required=True)
    ap.add_argument("--marker", required=True)
    ap.add_argument("--spy-host", default="127.0.0.1")
    ap.add_argument("--spy-port", type=int, default=8213)
    a = ap.parse_args()

    # Only write while the arm marker exists; exit promptly when it's removed.
    if not os.path.exists(a.marker):
        return 0
    try:
        sock = socket.create_connection((a.spy_host, a.spy_port), timeout=6)
    except OSError as e:
        log("spy connect %s:%d failed: %s" % (a.spy_host, a.spy_port, e))
        return 1
    sock.settimeout(2.0)                        # wake to re-check the marker if idle

    pcap = PcapFile(a.pcap)
    log("capture START -> %s (spy %s:%d)" % (a.pcap, a.spy_host, a.spy_port))
    frames = 0
    try:
        while True:
            if not os.path.exists(a.marker):
                break
            pb = recv_exact(sock, 1)            # TPower (s8)
            if pb is None:
                continue                        # idle timeout -> loop re-checks marker
            if pb == b"":
                break                           # peer closed
            hdr = recv_exact(sock, NLMSG_HDRLEN)
            if not hdr:
                break
            nlmsg_len = struct.unpack_from("<I", hdr, 0)[0]
            if nlmsg_len < NLMSG_HDRLEN or nlmsg_len > MTU:
                break                           # desync / bad length
            rest = recv_exact(sock, nlmsg_len - NLMSG_HDRLEN)
            if not rest:
                break
            frame = parse_hwsim_frame(hdr + rest)
            if frame:
                pcap.write(frame)
                frames += 1
    except Exception as e:                      # noqa: BLE001
        log("loop error: %s" % e)
    finally:
        pcap.close()
        try:
            sock.close()
        except OSError:
            pass
        log("capture STOP (%d frames)" % frames)
    return 0


if __name__ == "__main__":
    sys.exit(main())
