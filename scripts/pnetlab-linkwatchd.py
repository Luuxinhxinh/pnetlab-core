#!/usr/bin/env python3
# pnetlab-linkwatchd — per-link traffic watcher for the Network Watcher UI.
#
# One process per watch session, spawned by pnetlab-brokerd (linkwatch_start)
# as a transient systemd unit "pnet-linkwatch-<watch_id>". Reads its config
# from /dev/shm/pnet-watch/<watch_id>.conf.json (root-written by brokerd):
#
#   {"watch_id": "1_12",
#    "interfaces": ["vunl3_0", "vunl4_0"],
#    "filters": [{"id": "f0", "expr": "ip proto 89 or (vlan and ip proto 89)"}],
#    "hb_timeout": 180}
#
# For each (interface x filter) it opens an AF_PACKET socket with the filter
# attached IN-KERNEL as classic BPF (compiled in-process via libpcap, attached via
# SO_ATTACH_FILTER) — non-matching traffic never reaches userspace, so the
# steady-state cost is near zero. All sockets sit on one epoll loop. Once a
# second it writes an atomic JSON snapshot consumed by pnq-linkwatch.php:
#
#   {"ts": ..., "watch_id": "1_12", "filters": ["f0"],
#    "taps": {"vunl3_0": {"f0": {
#        "out": {"pps": 2, "total": 120, "last_ts": ..., "last": "summary"},
#        "in":  {...}}}}}
#
# "out" = node -> network, "in" = network -> node. On a host tap the kernel
# tags frames the guest EMITS as PACKET_HOST/BROADCAST/... (they arrive at the
# host over the tap) and frames the bridge DELIVERS to the guest as
# PACKET_OUTGOING — i.e. the intuitive sense is inverted (verified on the
# Noble gate, see docs). DIR_BY_PKTTYPE below is the single switch point.
#
# Lifecycle: exits cleanly (snapshot/conf/hb unlinked) when the heartbeat file
# <watch_id>.hb (touched by pnq-linkwatch.php on every GET) goes stale, when
# every watched tap disappears (lab stopped), or on SIGTERM (linkwatch_stop).
# On SIGHUP (brokerd linkwatch_start / linkwatch_reload on an already-running
# watch) it re-reads conf.json and DIFFS its socket set — opening sockets for
# newly-added (tap x filter) pairs and closing removed ones — while PRESERVING
# the counters of every surviving pair (live filter add/remove, no reset).

import ctypes
import errno
import json
import os
import selectors
import signal
import socket
import struct
import sys
import time

from pnet_bpfcompile import compile_bpf

LW_DIR = "/dev/shm/pnet-watch"
ETH_P_ALL = 0x0003
SO_ATTACH_FILTER = 26
PACKET_OUTGOING = 4
SNAPLEN = 256          # enough for the one-line summary decode
MAX_READS_PER_TICK = 400   # per socket; bounds CPU under floods (counts then
                           # undercount — acceptable for a teaching visual)

PROTO_NAMES = {
    1: "ICMP", 2: "IGMP", 6: "TCP", 17: "UDP", 47: "GRE", 50: "ESP",
    58: "ICMPv6", 88: "EIGRP", 89: "OSPF", 103: "PIM", 112: "VRRP", 132: "SCTP",
}
PORT_NAMES = {
    179: "BGP", 520: "RIP", 521: "RIPng", 4789: "VXLAN", 4341: "LISP",
    4342: "LISP", 646: "LDP", 1985: "HSRP", 3784: "BFD", 67: "DHCP", 68: "DHCP",
    53: "DNS", 123: "NTP", 161: "SNMP", 514: "Syslog",
}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def open_filtered_socket(iface, prog_n, prog_buf):
    """AF_PACKET socket with the cBPF program attached BEFORE bind: protocol 0
    receives nothing, so no unfiltered packets ever queue (no drain race)."""
    s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, 0)
    # keep a reference to the ctypes buffer alive for the setsockopt call
    fprog = struct.pack("HL", prog_n, ctypes.addressof(prog_buf))
    s.setsockopt(socket.SOL_SOCKET, SO_ATTACH_FILTER, fprog)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 131072)
    s.bind((iface, ETH_P_ALL))
    s.setblocking(False)
    return s


# ---- packet summary (rate-limited, stdlib decode) ------------------------------

def _l4(proto, pkt, off):
    name = PROTO_NAMES.get(proto, "proto %d" % proto)
    if proto in (6, 17) and len(pkt) >= off + 4:
        sp, dp = struct.unpack_from("!HH", pkt, off)
        svc = PORT_NAMES.get(dp) or PORT_NAMES.get(sp)
        if svc:
            name = svc
        return name, ":%d > " % sp, ":%d" % dp
    return name, " > ", ""


def summarize(pkt, wirelen):
    """One-line summary like '10.0.0.1 > 224.0.0.5 OSPF 80B'. Never raises."""
    try:
        eth = struct.unpack_from("!H", pkt, 12)[0]
        off = 14
        tag = ""
        if eth == 0x8100 and len(pkt) >= 18:        # 802.1Q
            vid = struct.unpack_from("!H", pkt, 14)[0] & 0x0FFF
            tag = "vlan%d " % vid
            eth = struct.unpack_from("!H", pkt, 16)[0]
            off = 18
        if eth == 0x0800 and len(pkt) >= off + 20:  # IPv4
            ihl = (pkt[off] & 0x0F) * 4
            proto = pkt[off + 9]
            src = socket.inet_ntop(socket.AF_INET, pkt[off + 12:off + 16])
            dst = socket.inet_ntop(socket.AF_INET, pkt[off + 16:off + 20])
            name, sps, dps = _l4(proto, pkt, off + ihl)
            return "%s%s%s%s%s %s %dB" % (tag, src, sps, dst, dps, name, wirelen)
        if eth == 0x86DD and len(pkt) >= off + 40:  # IPv6
            proto = pkt[off + 6]
            src = socket.inet_ntop(socket.AF_INET6, pkt[off + 8:off + 24])
            dst = socket.inet_ntop(socket.AF_INET6, pkt[off + 24:off + 40])
            name, sps, dps = _l4(proto, pkt, off + 40)
            return "%s%s%s%s%s %s %dB" % (tag, src, sps, dst, dps, name, wirelen)
        if eth == 0x0806:                            # ARP
            if len(pkt) >= off + 28:
                spa = socket.inet_ntop(socket.AF_INET, pkt[off + 14:off + 18])
                tpa = socket.inet_ntop(socket.AF_INET, pkt[off + 24:off + 28])
                return "%sARP %s > %s %dB" % (tag, spa, tpa, wirelen)
            return tag + "ARP %dB" % wirelen
        if eth < 0x0600 and len(pkt) >= off + 3:     # 802.3 LLC
            dsap, ssap = pkt[off], pkt[off + 1]
            if dsap == 0x42 and ssap == 0x42:
                return "STP BPDU %dB" % wirelen
            if dsap == 0xFE and ssap == 0xFE:
                return "IS-IS %dB" % wirelen
            if dsap == 0xAA and ssap == 0xAA and len(pkt) >= off + 8:  # SNAP
                oui = pkt[off + 3:off + 6]
                pid = struct.unpack_from("!H", pkt, off + 6)[0]
                if oui == b"\x00\x00\x0c":             # Cisco
                    name = {0x2000: "CDP", 0x010b: "PVST+ BPDU",
                            0x2003: "VTP", 0x2004: "DTP"}.get(pid)
                    if name:
                        return "%s %dB" % (name, wirelen)
                return "SNAP %04x %dB" % (pid, wirelen)
            return "LLC %02x/%02x %dB" % (dsap, ssap, wirelen)
        if eth == 0x88CC:
            return "LLDP %dB"  % wirelen
        if eth == 0x8847:
            return tag + "MPLS %dB" % wirelen
        return "%seth 0x%04x %dB" % (tag, eth, wirelen)
    except Exception:
        return "%dB" % wirelen


# ---- main --------------------------------------------------------------------

class Watcher:
    def __init__(self, watch_id):
        self.watch_id = watch_id
        conf_path = os.path.join(LW_DIR, watch_id + ".conf.json")
        with open(conf_path) as f:
            conf = json.load(f)
        self.conf_path = conf_path
        self.snap_path = os.path.join(LW_DIR, watch_id + ".json")
        self.hb_path = os.path.join(LW_DIR, watch_id + ".hb")
        self.hb_timeout = int(conf.get("hb_timeout", 180))
        # snapshot cadence (s); also drives the per-key summary rate-limit
        self.interval = max(0.2, min(2.0, float(conf.get("interval", 1.0))))
        self.interfaces = list(conf["interfaces"])
        self.filters = list(conf["filters"])  # [{"id","expr"}]
        self.sel = selectors.DefaultSelector()
        # sockmap[(iface, fid)] = {"sock", "expr", "buf"} — one AF_PACKET socket per
        # (tap x filter). Keyed so a SIGHUP reload can DIFF the desired set against
        # the live set: keep survivors (stats preserved), close removed, open new.
        self.sockmap = {}
        # stats[(iface, fid, dir)] = {"total","win","last_ts","last","last_sum_ts"}
        self.stats = {}
        self.start_ts = time.time()
        self.stopping = False
        # Set by the SIGHUP handler; drained in the run loop (signal-safe). Tier 2:
        # brokerd rewrites conf.json then SIGHUPs us for an in-place filter add/
        # remove/edit, so surviving (tap x filter) counters never reset.
        self.reload_pending = False

    def _compile_progs(self, filters):
        """Compile each distinct filter expression to (n, cBPF-buffer), tolerating
        a bad expr (broker-built, so this is defensive). Returns {expr: (n, buf)}.
        The kernel COPIES the program at SO_ATTACH_FILTER time, so one buffer can
        back sockets on many taps."""
        compiled = {}
        for f in filters:
            expr = f["expr"]
            if expr in compiled:
                continue
            try:
                n, raw = compile_bpf(expr)
                compiled[expr] = (n, ctypes.create_string_buffer(raw, len(raw)))
            except Exception as e:
                log("compile failed for %r: %s" % (expr, e))
        return compiled

    def _open_pair(self, iface, fid, expr, prog):
        """Open + register one (tap x filter) socket. prog = (n, buf). Idempotent:
        a pair already in sockmap is left untouched (its stats survive)."""
        if (iface, fid) in self.sockmap:
            return False
        n, buf = prog
        try:
            s = open_filtered_socket(iface, n, buf)
        except OSError as e:
            log("skip %s/%s: %s" % (iface, fid, e))
            return False
        self.sel.register(s, selectors.EVENT_READ, (iface, fid))
        self.sockmap[(iface, fid)] = {"sock": s, "expr": expr, "buf": buf}
        return True

    def _drop_stats(self, iface, fid):
        for d in ("in", "out"):
            self.stats.pop((iface, fid, d), None)

    def setup(self):
        compiled = self._compile_progs(self.filters)
        opened = 0
        for iface in self.interfaces:
            for f in self.filters:
                prog = compiled.get(f["expr"])
                if prog and self._open_pair(iface, f["id"], f["expr"], prog):
                    opened += 1
        log("watch %s: %d sockets (%d ifaces x %d filters)"
            % (self.watch_id, opened, len(self.interfaces), len(self.filters)))
        return opened

    def reload(self):
        """SIGHUP handler body: re-read conf.json and DIFF the socket set against
        the live one. Surviving (tap x filter) pairs whose expr is UNCHANGED keep
        their socket AND their counters; pairs that were removed (or whose expr
        changed) are closed and their stats dropped; genuinely-new pairs are
        opened fresh. This is what makes a live filter add/remove non-destructive
        to the counters the user is watching."""
        try:
            with open(self.conf_path) as f:
                conf = json.load(f)
        except (OSError, ValueError) as e:
            log("reload: bad conf, keeping current set: %s" % e)
            return
        new_ifaces = list(conf.get("interfaces", []))
        new_filters = list(conf.get("filters", []))   # [{"id","expr"}]
        if not new_ifaces or not new_filters:
            log("reload: empty interfaces/filters, ignoring")
            return
        compiled = self._compile_progs(new_filters)
        # desired[(iface, fid)] = expr — only for exprs that compiled.
        desired = {}
        for iface in new_ifaces:
            for f in new_filters:
                if f["expr"] in compiled:
                    desired[(iface, f["id"])] = f["expr"]
        # Close removed or expr-changed pairs (drop their stats).
        removed = 0
        for key, ent in list(self.sockmap.items()):
            want = desired.get(key)
            if want is None or want != ent["expr"]:
                self.drop_socket(ent["sock"])
                self._drop_stats(key[0], key[1])
                removed += 1
        # Open new (or expr-changed) pairs; survivors are skipped by _open_pair.
        added = 0
        for (iface, fid), expr in desired.items():
            if self._open_pair(iface, fid, expr, compiled[expr]):
                added += 1
        self.interfaces = new_ifaces
        self.filters = [f for f in new_filters if f["expr"] in compiled]
        try:
            self.interval = max(0.2, min(2.0, float(conf.get("interval", self.interval))))
        except (TypeError, ValueError):
            pass
        log("watch %s reloaded: +%d -%d sockets, %d live (%d ifaces x %d filters)"
            % (self.watch_id, added, removed, len(self.sockmap),
               len(self.interfaces), len(self.filters)))

    def _key(self, iface, fid, direction):
        k = (iface, fid, direction)
        st = self.stats.get(k)
        if st is None:
            st = self.stats[k] = {"total": 0, "win": 0, "last_ts": 0.0,
                                  "last": "", "last_sum_ts": 0.0}
        return st

    def drain(self, sock, iface, fid):
        now = time.time()
        for _ in range(MAX_READS_PER_TICK):
            try:
                pkt, addr = sock.recvfrom(SNAPLEN)
            except BlockingIOError:
                return True
            except OSError as e:
                # Only a genuinely removed tap ends the watch. ENETDOWN here is a
                # one-shot pending error (the tap was admin-down at bind time, or a
                # link flap) that recvfrom delivers once and clears — consume it and
                # keep watching, else a single blip kills the whole watch and the UI
                # shows "Watch ended (engine side)".
                if e.errno in (errno.ENODEV, errno.ENXIO):
                    return False                   # tap gone
                return True
            # inverted on host taps: PACKET_OUTGOING = bridge -> guest ("in")
            direction = "in" if addr[2] == PACKET_OUTGOING else "out"
            st = self._key(iface, fid, direction)
            st["total"] += 1
            st["win"] += 1
            st["last_ts"] = now
            if now - st["last_sum_ts"] >= self.interval:
                st["last_sum_ts"] = now
                st["last"] = summarize(pkt, len(pkt))
        return True

    def drop_socket(self, sock):
        try:
            self.sel.unregister(sock)
        except Exception:
            pass
        try:
            sock.close()
        except Exception:
            pass
        for key, ent in list(self.sockmap.items()):
            if ent["sock"] is sock:
                del self.sockmap[key]
                break

    def write_snapshot(self, dt):
        taps = {}
        for (iface, fid, direction), st in self.stats.items():
            ent = taps.setdefault(iface, {}).setdefault(fid, {})
            ent[direction] = {
                "pps": round(st["win"] / dt, 1) if dt > 0 else 0,
                "total": st["total"],
                "last_ts": round(st["last_ts"], 1),
                "last": st["last"],
            }
            st["win"] = 0
        snap = {"ts": round(time.time(), 1), "watch_id": self.watch_id,
                "filters": [f["id"] for f in self.filters], "taps": taps}
        tmp = self.snap_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(snap, f, separators=(",", ":"))
        os.chmod(tmp, 0o644)
        os.replace(tmp, self.snap_path)

    def heartbeat_stale(self):
        try:
            hb = os.stat(self.hb_path).st_mtime
        except OSError:
            hb = self.start_ts
        return time.time() - hb > self.hb_timeout

    def cleanup(self):
        for ent in list(self.sockmap.values()):
            self.drop_socket(ent["sock"])
        # Only remove the snapshot/sidecar on a genuine SELF-exit (all taps gone /
        # heartbeat stale). On SIGTERM we are being stopped OR re-armed by brokerd
        # (linkwatch_start = stop+respawn): deleting the snapshot here opens a gap
        # where GET sees active:false and the client ends the watch ("Watch ended")
        # on every add/delete. A real stop owns deletion itself (brokerd _lw_unlink
        # + pnq-linkwatch stop); a re-arm's new watcher just overwrites the snapshot.
        if self.stopping:
            return
        links_sidecar = os.path.join(LW_DIR, self.watch_id + ".links.json")
        for p in (self.snap_path, self.conf_path, self.hb_path, links_sidecar):
            try:
                os.unlink(p)
            except OSError:
                pass

    def run(self):
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "stopping", True))
        signal.signal(signal.SIGHUP, lambda *_: setattr(self, "reload_pending", True))
        if self.setup() == 0:
            log("no sockets opened, exiting")
            self.cleanup()
            return 1
        last_tick = time.time()
        while not self.stopping:
            if self.reload_pending:
                self.reload_pending = False
                self.reload()
            for key, _ in self.sel.select(timeout=self.interval):
                sock = key.fileobj
                iface, fid = key.data
                if not self.drain(sock, iface, fid):
                    log("tap %s gone, dropping" % iface)
                    self.drop_socket(sock)
            now = time.time()
            if now - last_tick >= self.interval:
                self.write_snapshot(now - last_tick)
                last_tick = now
                if not self.sockmap:
                    log("all taps gone, exiting")
                    break
                if self.heartbeat_stale():
                    log("heartbeat stale (> %ds), exiting" % self.hb_timeout)
                    break
        self.cleanup()
        log("watch %s done" % self.watch_id)
        return 0


def main():
    if len(sys.argv) != 2:
        log("usage: pnetlab-linkwatchd.py <watch_id>")
        return 2
    return Watcher(sys.argv[1]).run()


if __name__ == "__main__":
    sys.exit(main())
