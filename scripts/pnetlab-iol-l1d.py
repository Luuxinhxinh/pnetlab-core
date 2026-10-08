#!/usr/bin/env python3
"""PNetLab IOL layer-1 link-state relay.

IOL started with "-l" runs the IOU layer-1 keepalive protocol on every
interface: while an interface is up it sends one 8-byte datagram per second
to its NETMAP peer's L1 socket (/tmp/netl1<uid>/L1<peer_id>), it declares the
interface down after ~10 s without receiving one, a single received keepalive
brings a down interface straight back up, and an admin-shut interface neither
sends nor reacts.

Under PNetLab every IOL interface is mapped (NETMAP) to the wrapper's pseudo
instance <iol_id>+512, and the real wiring is a host tap (vunl<session>_<if>)
on a Linux bridge, so IOL's keepalives never reach the far end on their own.
This daemon binds each pseudo instance's L1 socket and closes the loop:

  * IOL <-> IOL: every keepalive an IOL interface sends is relayed to each
    IOL interface on the same bridge (or the far end of a serial link), so a
    peer that is shut down or powered off stops feeding its neighbour, which
    then goes down exactly as it would with native IOU wiring.
  * IOL <-> anything else (QEMU, docker, cloud, cross-host tunnel): one
    keepalive per second is synthesised while at least one other bridge port
    is present and up.
  * Interfaces suspended from the GUI are flagged under STATE_DIR by the
    broker and receive nothing.

Only IOL processes started with "-l" create an L1 socket, so nodes without
the keepalive option are left alone (and count as plain "other" peers).
"""

import errno
import glob
import os
import re
import select
import signal
import socket
import stat
import struct
import sys
import time

UID_BASE = 32768                 # unl<session> == UID_BASE + session
PSEUDO_OFFSET = 512              # iol_wrapper's NETMAP peer id offset
MAX_IOL_ID = 511
HDR = struct.Struct("!HHBBH")    # dst_id, src_id, dst_if, src_if, type
L1_KEEPALIVE = 0x0300
TICK = 1.0
WRAPPER_REFRESH = 10.0
STATE_DIR = "/run/pnetlab/iol-l1"
SYS_NET = "/sys/class/net"
IFF_UP = 0x1

RE_L1DIR = re.compile(r"^/tmp/netl1(\d+)$")
RE_L1SOCK = re.compile(r"^L1(\d+)$")
RE_TAP = re.compile(r"^vunl(\d+)_(\d+)$")
RE_SERIAL = re.compile(r"^(\d+):[^:]+:(\d+):(\d+):(\d+)$")


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


class Node:
    """One running IOL instance that has the L1 keepalive enabled."""

    def __init__(self, uid, iol_id, ino):
        self.uid = uid
        self.iol_id = iol_id
        self.session = uid - UID_BASE
        self.ino = ino
        self.dir = "/tmp/netl1%d" % uid
        self.path = "%s/L1%d" % (self.dir, iol_id)
        self.pseudo_path = "%s/L1%d" % (self.dir, iol_id + PSEUDO_OFFSET)
        self.sock = None
        self.sock_ino = None     # inode of the bound pseudo socket path
        self.serial = {}         # if_id -> (console port, remote if_id)

    def bind(self):
        try:
            os.unlink(self.pseudo_path)
        except FileNotFoundError:
            pass
        s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        s.setblocking(False)
        # IOL runs as the unl<session> user and must be able to send here;
        # create the socket world-writable rather than chmod()ing a path.
        old = os.umask(0)
        try:
            s.bind(self.pseudo_path)
        finally:
            os.umask(old)
        self.sock = s
        self.sock_ino = os.lstat(self.pseudo_path).st_ino

    def pseudo_ok(self):
        try:
            st = os.lstat(self.pseudo_path)
        except OSError:
            return False
        return stat.S_ISSOCK(st.st_mode) and st.st_ino == self.sock_ino

    def close(self):
        if self.sock is not None:
            try:
                if self.pseudo_ok():
                    os.unlink(self.pseudo_path)
            except OSError:
                pass
            self.sock.close()
            self.sock = None


def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def port_alive(name):
    """A non-IOL bridge port counts as a live peer while it is admin-up.
    Tap devices (QEMU, IOL without -l, dynamips) report no useful carrier,
    so only veths/physical/tunnel ports are also held to their operstate."""
    flags = read("%s/%s/flags" % (SYS_NET, name))
    if flags is None or not int(flags, 16) & IFF_UP:
        return False
    if os.path.exists("%s/%s/tun_flags" % (SYS_NET, name)):
        return True
    return read("%s/%s/operstate" % (SYS_NET, name)) in ("up", "unknown")


def suspended(session, if_id):
    return os.path.exists("%s/%d_%d" % (STATE_DIR, session, if_id))


class Relay:

    def __init__(self):
        self.nodes = {}          # (uid, iol_id) -> Node
        self.by_session = {}     # session -> Node
        self.by_port = {}        # console port -> session (any IOL wrapper)
        self.peers = {}          # (session, if) -> ([(Node, if)], other_alive)
        self.signature = {}      # (session, if) -> frozenset of peer ids
        self.tx = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        self.tx.setblocking(False)
        self.wrappers_at = 0.0

    # ---- discovery -------------------------------------------------------

    def scan_sockets(self):
        seen = {}
        for d in glob.glob("/tmp/netl1*"):
            m = RE_L1DIR.match(d)
            if not m:
                continue
            uid = int(m.group(1))
            if uid < UID_BASE:
                continue
            try:
                st = os.lstat(d)
                if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid:
                    continue
                entries = os.listdir(d)
            except OSError:
                continue
            for e in entries:
                m = RE_L1SOCK.match(e)
                if not m or int(m.group(1)) > MAX_IOL_ID:
                    continue
                try:
                    est = os.lstat("%s/%s" % (d, e))
                except OSError:
                    continue
                if stat.S_ISSOCK(est.st_mode) and est.st_uid == uid:
                    seen[(uid, int(m.group(1)))] = est.st_ino
        changed = False
        for key in list(self.nodes):
            n = self.nodes[key]
            if key not in seen or seen[key] != n.ino:
                n.close()
                del self.nodes[key]
                changed = True
                log("IOL session %d (id %d) gone" % (n.session, n.iol_id))
        for key, ino in seen.items():
            n = self.nodes.get(key)
            if n is not None:
                if not n.pseudo_ok():
                    n.close()
                    self.bind(n)
                continue
            n = Node(key[0], key[1], ino)
            if self.bind(n):
                self.nodes[key] = n
                changed = True
                log("IOL session %d (id %d) attached" % (n.session, n.iol_id))
        if changed:
            self.by_session = {n.session: n for n in self.nodes.values()}
        return changed

    def bind(self, n):
        try:
            n.bind()
            return True
        except OSError as e:
            log("cannot bind %s: %s" % (n.pseudo_path, e))
            return False

    def scan_wrappers(self):
        """Console port and serial wiring come from the iol_wrapper argv."""
        by_port = {}
        serial = {}
        for p in os.listdir("/proc"):
            if not p.isdigit():
                continue
            try:
                with open("/proc/%s/cmdline" % p, "rb") as f:
                    argv = f.read().split(b"\0")
            except OSError:
                continue
            if not argv or not argv[0].endswith(b"/iol_wrapper"):
                continue
            args = [a.decode("utf-8", "replace") for a in argv[1:]]
            if "--" in args:
                args = args[:args.index("--")]
            opts = {}
            links = []
            for i in range(len(args) - 1):
                if args[i] == "-l":
                    links.append(args[i + 1])
                elif args[i] in ("-S", "-P"):
                    opts[args[i]] = args[i + 1]
            try:
                session = int(opts["-S"])
                port = int(opts["-P"])
            except (KeyError, ValueError):
                continue
            by_port[port] = session
            for spec in links:
                m = RE_SERIAL.match(spec)
                if m:
                    serial.setdefault(session, {})[int(m.group(1))] = \
                        (int(m.group(4)), int(m.group(3)))
        self.by_port = by_port
        for n in self.nodes.values():
            n.serial = serial.get(n.session, {})
        self.wrappers_at = time.monotonic()

    def topology(self):
        """Rebuild (session, if) -> peers from bridge membership + serials."""
        peers = {}
        taps = {}
        for dev in os.listdir(SYS_NET):
            m = RE_TAP.match(dev)
            if m and int(m.group(1)) in self.by_session:
                taps.setdefault(int(m.group(1)), []).append(
                    (dev, int(m.group(2))))
        for n in self.nodes.values():
            for tap, if_id in taps.get(n.session, ()):
                try:
                    br = os.path.basename(
                        os.readlink("%s/%s/master" % (SYS_NET, tap)))
                    ports = os.listdir("%s/%s/brif" % (SYS_NET, br))
                except OSError:
                    continue
                iol, other, sig = [], False, set()
                for p in ports:
                    if p == tap:
                        continue
                    m = RE_TAP.match(p)
                    peer = self.by_session.get(int(m.group(1))) if m else None
                    if peer is not None:
                        pif = int(m.group(2))
                        iol.append((peer, pif))
                        sig.add(p + ("!" if suspended(peer.session, pif)
                                     else ""))
                    elif port_alive(p):
                        other = True
                        sig.add(p)
                if suspended(n.session, if_id):
                    sig.add("!")
                peers[(n.session, if_id)] = (iol, other, frozenset(sig))
            for if_id, (rport, rif) in n.serial.items():
                rsession = self.by_port.get(rport)
                if rsession is None:
                    continue
                peer = self.by_session.get(rsession)
                tag = "ser%d_%d" % (rsession, rif)
                if suspended(rsession, rif) or suspended(n.session, if_id):
                    tag += "!"
                if peer is not None:
                    peers[(n.session, if_id)] = (
                        [(peer, rif)], False, frozenset([tag]))
                else:
                    peers[(n.session, if_id)] = ([], True, frozenset([tag]))
        return peers

    # ---- datapath --------------------------------------------------------

    def send(self, n, if_id, kind=L1_KEEPALIVE, extra=b""):
        if suspended(n.session, if_id):
            return
        pkt = HDR.pack(n.iol_id, n.iol_id + PSEUDO_OFFSET, if_id, if_id,
                       kind) + extra
        try:
            self.tx.sendto(pkt, n.path)
        except OSError as e:
            if e.errno not in (errno.ENOENT, errno.ECONNREFUSED,
                               errno.EAGAIN, errno.ENOBUFS):
                log("send to %s failed: %s" % (n.path, e))

    def receive(self, n):
        while True:
            try:
                data = n.sock.recv(2048)
            except BlockingIOError:
                return
            except OSError:
                return
            if len(data) < HDR.size:
                continue
            _dst, _src, _dif, sif, kind = HDR.unpack_from(data)
            if suspended(n.session, sif):
                continue
            entry = self.peers.get((n.session, sif))
            if not entry:
                continue
            for peer, pif in entry[0]:
                self.send(peer, pif, kind, data[HDR.size:])

    def tick(self):
        changed = self.scan_sockets()
        if changed or time.monotonic() - self.wrappers_at > WRAPPER_REFRESH:
            self.scan_wrappers()
        self.peers = self.topology()
        for key, (iol, other, sig) in self.peers.items():
            n = self.by_session.get(key[0])
            if n is None:
                continue
            if other:
                self.send(n, key[1])
            elif iol and self.signature.get(key) != sig:
                # A link was (re)plugged or resumed, or the daemon restarted:
                # both ends may already have timed out and gone silent, so wake
                # this end once; if its peer is up the relay takes over.
                self.send(n, key[1])
        self.signature = {k: v[2] for k, v in self.peers.items()}

    def run(self):
        log("IOL L1 relay started")
        nxt = time.monotonic()
        while True:
            now = time.monotonic()
            if now >= nxt:
                self.tick()
                nxt = now + TICK
            socks = {n.sock: n for n in self.nodes.values() if n.sock}
            try:
                ready, _, _ = select.select(list(socks), [], [],
                                            max(0.0, nxt - time.monotonic()))
            except InterruptedError:
                continue
            for s in ready:
                self.receive(socks[s])

    def shutdown(self):
        for n in self.nodes.values():
            n.close()


def main():
    relay = Relay()

    def stop(_sig, _frm):
        relay.shutdown()
        sys.exit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    relay.run()


if __name__ == "__main__":
    main()
