#!/usr/bin/env python3
# pnetlab-prototracer — per-link protocol packet ladder for the Protocol
# Inspector UI. Sibling to pnetlab-linkwatchd: same in-kernel-BPF capture, but
# instead of 1s aggregate counters it emits a capped ring buffer of decoded
# per-packet EVENTS (the rows of a ladder/sequence diagram) with plain-English
# annotations from pnet_protodecode.
#
# One process per inspector session, spawned by pnetlab-brokerd (prototrace_start)
# as transient unit "pnet-prototrace-<watch_id>". Config at
# /dev/shm/pnet-trace/<watch_id>.conf.json (root-written by brokerd):
#
#   {"watch_id":"1_12_n3", "interface":"vunl4_0", "flip":false,
#    "proto":"bgp", "expr":"tcp port 179", "buffer_max":500, "hb_timeout":180,
#    "a":"R1", "b":"R2"}
#
# Output snapshot /dev/shm/pnet-trace/<watch_id>.json (atomic):
#   {"ts":..., "watch_id":..., "proto":"bgp", "a":"R1", "b":"R2",
#    "next_seq":42, "dropped":0, "events":[ {seq,ts,dir,proto,kind,label,
#    detail,severity,fields}, ... up to buffer_max ]}
#
# Direction: dir "ab" = side A (lower node_id) -> side B. On a host tap the
# kernel marks frames the guest EMITS as PACKET_HOST and frames the bridge
# DELIVERS as PACKET_OUTGOING (inverted — see linkwatchd). When the watcher had
# to bind the *higher* node's tap (the A side was admin-down), conf "flip" is
# true and the sense swaps. dir_ab = is_out XOR flip.
#
# Lifecycle mirrors linkwatchd: exits (files unlinked) when the heartbeat file
# goes stale, the tap disappears, or on SIGTERM.

import collections
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
from pnet_protodecode import make_decoder, make_fsm

PT_DIR = "/dev/shm/pnet-trace"
ETH_P_ALL = 0x0003
SO_ATTACH_FILTER = 26
PACKET_OUTGOING = 4
SNAPLEN = 1600             # full control-message headers (BGP OPEN/NOTIFICATION)
MAX_READS_PER_TICK = 400


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def open_filtered_socket(iface, prog_n, prog_buf):
    s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, 0)
    fprog = struct.pack("HL", prog_n, ctypes.addressof(prog_buf))
    s.setsockopt(socket.SOL_SOCKET, SO_ATTACH_FILTER, fprog)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 262144)
    s.bind((iface, ETH_P_ALL))
    s.setblocking(False)
    return s


# ---- tracer ------------------------------------------------------------------

class Tracer:
    def __init__(self, watch_id):
        self.watch_id = watch_id
        conf_path = os.path.join(PT_DIR, watch_id + ".conf.json")
        with open(conf_path) as f:
            conf = json.load(f)
        self.conf_path = conf_path
        self.snap_path = os.path.join(PT_DIR, watch_id + ".json")
        self.hb_path = os.path.join(PT_DIR, watch_id + ".hb")
        self.iface = conf["interface"]
        self.expr = conf["expr"]
        self.flip = bool(conf.get("flip", False))
        self.proto = conf.get("proto", "bgp")
        self.a = conf.get("a", "A")
        self.b = conf.get("b", "B")
        self.buffer_max = max(50, min(2000, int(conf.get("buffer_max", 500))))
        self.hb_timeout = int(conf.get("hb_timeout", 180))
        self.interval = 0.5            # snapshot flush cadence (s)
        self.sel = selectors.DefaultSelector()
        self.sock = None
        self.decode = make_decoder(self.proto)
        # Derived FSM (Convergence Timeline): consumes the same decoded events
        # and tracks the protocol state machine. Transitions are rare vs packets,
        # so they get their own deep ring buffer that survives event eviction.
        self.fsm = make_fsm(self.proto)
        self.transitions = collections.deque(maxlen=256)
        self.events = collections.deque(maxlen=self.buffer_max)
        self.next_seq = 0
        self.dropped = 0
        self.dirty = True              # write an (empty) snapshot promptly
        self.last_write = 0.0          # liveness: refresh ts even when idle
        self.start_ts = time.time()
        self.stopping = False

    def setup(self):
        n, raw = compile_bpf(self.expr)
        self._buf = ctypes.create_string_buffer(raw, len(raw))
        self.sock = open_filtered_socket(self.iface, n, self._buf)
        self.sel.register(self.sock, selectors.EVENT_READ)
        log("trace %s: %s on %s (%r)"
            % (self.watch_id, self.proto, self.iface, self.expr))
        return True

    def drain(self):
        now = time.time()
        for _ in range(MAX_READS_PER_TICK):
            try:
                pkt, addr = self.sock.recvfrom(SNAPLEN)
            except BlockingIOError:
                return True
            except OSError as e:
                if e.errno in (errno.ENODEV, errno.ENXIO):
                    return False               # tap genuinely gone
                return True                    # transient (ENETDOWN): keep going
            is_out = addr[2] != PACKET_OUTGOING
            dir_ab = is_out ^ self.flip
            try:
                evs = self.decode(pkt, len(pkt), dir_ab, now)
            except Exception as e:               # a decoder bug must never crash
                log("decode error: %s" % e)
                evs = []
            for ev in evs:
                ev["seq"] = self.next_seq
                self.next_seq += 1
                if len(self.events) == self.events.maxlen:
                    self.dropped += 1            # ring overwrote the oldest
                self.events.append(ev)
                if self.fsm is not None:         # derive FSM transitions in step
                    tr = self.fsm.observe(ev)
                    if tr is not None:
                        self.transitions.append(tr)
                self.dirty = True
        return True

    def write_snapshot(self):
        snap = {"ts": round(time.time(), 2), "watch_id": self.watch_id,
                "proto": self.proto, "a": self.a, "b": self.b,
                "next_seq": self.next_seq, "dropped": self.dropped,
                "events": list(self.events)}
        if self.fsm is not None:
            snap["fsm"] = {"model": self.fsm.model, "current": self.fsm.current,
                           "seeded": self.fsm.seeded,
                           "transitions": list(self.transitions)}
        tmp = self.snap_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(snap, f, separators=(",", ":"))
        os.chmod(tmp, 0o644)
        os.replace(tmp, self.snap_path)
        self.dirty = False
        self.last_write = time.time()

    def heartbeat_stale(self):
        try:
            hb = os.stat(self.hb_path).st_mtime
        except OSError:
            hb = self.start_ts
        return time.time() - hb > self.hb_timeout

    def cleanup(self):
        try:
            self.sel.unregister(self.sock)
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass
        for p in (self.snap_path, self.conf_path, self.hb_path):
            try:
                os.unlink(p)
            except OSError:
                pass

    def run(self):
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "stopping", True))
        try:
            self.setup()
        except Exception as e:
            log("setup failed: %s" % e)
            self.cleanup()
            return 1
        last_tick = time.time()
        tap_gone = False
        while not self.stopping:
            for _ in self.sel.select(timeout=self.interval):
                if not self.drain():
                    tap_gone = True
                    break
            now = time.time()
            if tap_gone:
                log("tap %s gone, exiting" % self.iface)
                break
            if now - last_tick >= self.interval:
                last_tick = now
                # write on new events, and at least every 3s so the UI's
                # snapshot-age liveness check stays fresh on a quiet session.
                if self.dirty or now - self.last_write >= 3.0:
                    self.write_snapshot()
                if self.heartbeat_stale():
                    log("heartbeat stale (> %ds), exiting" % self.hb_timeout)
                    break
        self.cleanup()
        log("trace %s done" % self.watch_id)
        return 0


def main():
    if len(sys.argv) != 2:
        log("usage: pnetlab-prototracer.py <watch_id>")
        return 2
    return Tracer(sys.argv[1]).run()


if __name__ == "__main__":
    sys.exit(main())
