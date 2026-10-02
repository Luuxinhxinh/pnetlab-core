#!/usr/bin/env python3
"""
airhandler.py — clean-room host-side RF-medium arbiter for the Cisco VAP / CML
wireless-client nodes (the "airhandler" that Cisco's in-guest `airduct` client
talks to over a virtio-serial port).

WHY THIS EXISTS
    Cisco's VAP image (real AP COS firmware) and the CML wireless-client run an
    in-guest Go client, `airduct`, that (1) loads mac80211_hwsim locally, (2)
    connects to a host "airhandler" over /dev/virtio-ports/airduct, (3) asks it to
    assign radio MAC(s) (-> /tmp/ap_macs), and (4) tunnels every simulated 802.11
    frame its radios TX to the airhandler, which floods it to the OTHER nodes'
    radios (and vice-versa). Cisco ships `airduct` inside the images but NOT the
    airhandler. Without it, airduct's startup handshake fails, it exit(1)s, and the
    AP's capwapd/vap-hwsim never come up. So this daemon is required for BOTH:
      * Tier 1 (CAPWAP join): answer macRequest so airduct/vap-hwsim/capwapd proceed.
      * Tier 2 (client association): relay 802.11 frames AP <-> Wireless Client.

PROTOCOL (reverse-engineered from the airduct binaries, byte-verified)
    Transport: single virtio-serial fd, one multiplexed stream. Framing =
    sourcegraph/jsonrpc2 VarintObjectCodec: each message is `uvarint(len) || json`
    where uvarint is Go binary.PutUvarint (unsigned LEB128). Payload is JSON-RPC
    2.0. Both sides send Calls (id + method + params) and replies (id + result).

    airduct -> airhandler (we must answer):
      macRequest      params {"count":N}  -> result {"status":"success","macs":[N MACs]}
      hostnameRequest params {}           -> result {"status":"success","hostname":"..."}
      sendFrame       params "<base64>"   -> result {"status":"success"} (ack), THEN we
                                             flood an injectFrame with the same base64
                                             to every OTHER node in the session.
    airhandler -> airduct (we send, ignore the reply):
      injectFrame     params "<base64>"   (deliver a peer's TX frame into this node)

    Node identity is purely per-connection (no port id on the wire); each
    connection gets its own non-overlapping MAC block. The frame payload is a
    base64 JSON string of the raw 802.11 frame — passed through VERBATIM; airduct
    fabricates RX freq/RSSI locally on injection, so no metadata envelope is needed.

RF DISTANCE MODEL (branch upg/airduct-snr, 2026-07-16 — OPT-IN, default OFF)
    Baseline airduct/airhandler is an all-or-nothing bus: every peer hears every
    frame, and airduct stamps a HARDCODED HWSIM_ATTR_SIGNAL = -50 dBm on injection
    (RE'd: main.(*NetlinkManager).addSignalAttribute, sole caller loads
    `mov $0xffffffce,%esi`). So canvas node placement does NOT affect the RF link.

    This daemon can now model per-(src,dst) signal from canvas distance, using the
    SAME log-distance path-loss model + constants as the Wi-Fi Painter
    (pnetlab-wifi-painter.js): RSSI(d) = TX_DBM - (PL0 + 10*N*log10(d_m)),
    d_m = px * M_PER_PX (>=1), SNR = RSSI - NOISE. Positions are the node canvas
    coords (Node getLeft/getTop, the SAME source the Painter renders from), fed via
    <pos_dir>/<session>/airduct-pos.json = {"<node>": [x, y], ...}.

    TIER 1 (AIRHANDLER_RF=1): airhandler-only. Per-(src,dst) probabilistic frame
      DROP / range cutoff from the modeled RSSI. Gives coverage / roaming /
      dead-zones. The delivered frames still carry airduct's local -50 stamp, so
      station dumps show a flat RSSI — but the LINK itself now tracks distance.
    TIER 2 (AIRHANDLER_RF=2): tier-1 loss PLUS a per-(src,dst) signal carried
      IN-BAND by appending one signed dBm byte to the raw frame (params stay a bare
      base64 string; decoded[-1] = signal). A PATCHED airduct (site 0x6d09b6 /
      file off 0x2d09b6, the `mov $-50,%esi` -> a code-cave that reads the trailing
      byte of HWSIM_ATTR_FRAME) sources HWSIM_ATTR_SIGNAL from that byte instead of
      the -50 constant, so the kernel RX signal (radiotap / station dump /
      getWirelessInfo) shows graded RSSI that tracks node placement (roaming / RRM
      see it). An UNPATCHED airduct just injects a frame one byte longer (harmless
      for the signal readout). Tiers 0/1 send the frame verbatim.

    Default (AIRHANDLER_RF unset / 0) = legacy verbatim flood, byte-identical to the
    pre-branch behavior (no positions read, no drop, bare-string inject). Zero
    regression for existing wireless labs / the cVAP win.

TRANSPORT / TOPOLOGY (PNetLab side)
    device_vap.php attaches the port as a per-node LISTENING unix socket:
        -chardev socket,id=airduct0,path=<runpath>/airduct.sock,server=on,wait=off
    i.e. QEMU listens; THIS daemon connects in as the client. The run path
    /opt/unetlab/tmp/<session>/<node>/ gives a stable node identity and, via
    <session>, an RF-isolation domain: frames flood only among nodes in the same
    lab session (multi-lab hosts stay isolated).

    Runs as a transient systemd unit (broker verb airhandler_ensure), single
    instance, root. Idempotent; safe to (re)spawn on every wireless node prepare().

ENV OVERRIDES (all optional; defaults reproduce the shipped pod behavior)
    AIRHANDLER_RUN_GLOB   glob for airduct.sock discovery
                          (default /opt/unetlab/tmp/*/*/airduct.sock)
    AIRHANDLER_GUARD      abstract single-instance guard name (default pnet-airhandler)
    AIRHANDLER_PING       ping reply form: "object" (default, {"status":"success"})
                          or "string" ("success" — the Jun-11 airduct wants this)
    AIRHANDLER_RF         0/off (default) | 1 (loss) | 2 (loss + in-band signal)
    AIRHANDLER_POS_DIR    positions dir (default = the run-glob base, else /opt/unetlab/tmp)
    AIRHANDLER_RF_*       model overrides: M_PER_PX TX_DBM PL0 N NOISE SENS
    AIRHANDLER_RF_TX_DBM_AP      TX power (dBm) used when the SOURCE node is an AP
                                 (=> downlink RSSI at the client). Default = TX_DBM.
    AIRHANDLER_RF_TX_DBM_CLIENT  TX power (dBm) used when the SOURCE node is a client
                                 (=> uplink RSSI at the AP). Default = TX_DBM.
    AIRHANDLER_RF_AP_NODES       comma/space list of node ids that are APs (their TX
                                 uses TX_DBM_AP). Empty => symmetric (both use TX_DBM).
    AIRHANDLER_RF_SIGNAL_NODES   comma/space list of RECEIVER node ids running a patched
                                 airduct: the in-band signal byte (tier 2) is appended
                                 ONLY on frames delivered to these nodes, so an unpatched
                                 peer's frames stay verbatim (no +1-byte corruption of its
                                 downlink). Empty => append to all peers at tier 2 (legacy).
"""

import base64
import glob
import json
import math
import os
import random
import re
import socket
import struct
import sys
import threading
import time
import zlib

# --------------------------------------------------------------------------
# Config (env-overridable; defaults = shipped pod behavior).
# --------------------------------------------------------------------------
RUN_GLOB = os.environ.get("AIRHANDLER_RUN_GLOB", "/opt/unetlab/tmp/*/*/airduct.sock")
GUARD_NAME = os.environ.get("AIRHANDLER_GUARD", "pnet-airhandler")
PING_MODE = os.environ.get("AIRHANDLER_PING", "object").strip().lower()
# AIRHANDLER_RF selects the RF fidelity of the medium. Honest status (2026-07-17):
#   RF=0 (default) -- shipped behavior: verbatim frame flood, BYTE-IDENTICAL to the
#                     pre-RF airhandler. This is what production runs.
#   RF=1           -- Tier 1: distance->loss (log-distance path-loss -> per-(src,dst)
#                     Bernoulli delivery / hard range cutoff). Gives coverage, dead
#                     zones, and range-gated links. PROVEN LIVE on a genuine airduct
#                     association (near = frames flow, far = link starved). This is the
#                     supported RF feature.
#   RF=2           -- Tier 2: graded per-(src,dst) RSSI via an in-band signal byte
#                     appended to the frame + the directional TX-power model.
#                     EXPERIMENTAL / NON-FUNCTIONAL: it depends on a patched airduct
#                     binary reading that byte and stamping HWSIM_ATTR_SIGNAL, but the
#                     signal-site RE (vaddr 0x6d09b6) was LIVE-DISPROVEN -- the kernel
#                     still records -50 dBm and the appended byte does not survive
#                     airduct's frame parse, so RF=2 has NO working receiver-side
#                     consumer. The airhandler side (append + model) is correct and is
#                     kept for a future airduct signal-path re-RE. DO NOT rely on RF=2.
RF_TIER = 0
try:
    _rf = os.environ.get("AIRHANDLER_RF", "0").strip().lower()
    RF_TIER = {"off": 0, "": 0, "0": 0, "1": 1, "2": 2}.get(_rf, int(_rf))
except (TypeError, ValueError):
    RF_TIER = 0
# positions dir defaults to the run-glob base ("/a/b/*/*/airduct.sock" -> "/a/b")
_glob_base = RUN_GLOB.split("*", 1)[0].rstrip("/") or "/opt/unetlab/tmp"
POS_DIR = os.environ.get("AIRHANDLER_POS_DIR", _glob_base)
SCAN_INTERVAL = 1.0
LOG_TAG = "airhandler"


def _envf(name, default):
    try:
        return float(os.environ[name])
    except (KeyError, TypeError, ValueError):
        return default


# RF model constants — MUST MATCH pnetlab-wifi-painter.js RF{} so the medium's
# loss/signal agree with what the Painter draws.
RF = {
    "M_PER_PX": _envf("AIRHANDLER_RF_M_PER_PX", 0.07),
    "TX_DBM":   _envf("AIRHANDLER_RF_TX_DBM", 20.0),
    "PL0":      _envf("AIRHANDLER_RF_PL0", 40.0),
    "N":        _envf("AIRHANDLER_RF_N", 2.8),
    "NOISE":    _envf("AIRHANDLER_RF_NOISE", -95.0),
    "SENS":     _envf("AIRHANDLER_RF_SENS", -85.0),
}
# Directional TX power: real Wi-Fi is asymmetric — the AP transmits harder (higher
# power + antenna gain) than the client, so at the same distance the client hears the
# AP (downlink) STRONGER than the AP hears the client (uplink). The received RSSI is
# governed by the TRANSMITTER's effective TX power; pick it from whether the SOURCE
# node is an AP. Defaults fall back to the symmetric TX_DBM (byte-identical behavior
# when AIRHANDLER_RF_AP_NODES is unset).
RF["TX_DBM_AP"] = _envf("AIRHANDLER_RF_TX_DBM_AP", RF["TX_DBM"])
RF["TX_DBM_CLIENT"] = _envf("AIRHANDLER_RF_TX_DBM_CLIENT", RF["TX_DBM"])


def _envset(name):
    """Parse a comma/space-separated env var into a set of stripped tokens."""
    return set(t for t in re.split(r"[,\s]+", os.environ.get(name, "").strip()) if t)


# Node ids (as strings) that are APs — their TX uses TX_DBM_AP (downlink to clients).
AP_NODES = _envset("AIRHANDLER_RF_AP_NODES")
# Receiver node ids running a patched airduct — append the in-band signal byte only
# on frames delivered to these (protects unpatched peers' frames from +1-byte change).
SIGNAL_NODES = _envset("AIRHANDLER_RF_SIGNAL_NODES")


def log(msg):
    sys.stderr.write("[%s] %s\n" % (LOG_TAG, msg))
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# jsonrpc2 VarintObjectCodec framing over a blocking socket.
# ---------------------------------------------------------------------------
def _read_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return bytes(buf)


def read_uvarint(sock):
    """Go binary.ReadUvarint: LEB128, little-endian, MSB = continuation."""
    shift = 0
    result = 0
    while True:
        b = sock.recv(1)
        if not b:
            return None
        byte = b[0]
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return result
        shift += 7
        if shift >= 64:
            raise ValueError("uvarint too long")


def put_uvarint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def read_message(sock):
    """Read one framed JSON object. Returns dict, or None on clean EOF."""
    length = read_uvarint(sock)
    if length is None:
        return None
    data = _read_exact(sock, length)
    if data is None:
        return None
    return json.loads(data.decode("utf-8"))


def encode_message(obj):
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    return put_uvarint(len(body)) + body


# ---------------------------------------------------------------------------
# MAC allocation — deterministic, per-node, restart-stable, non-overlapping.
# Locally-administered unicast (0x02 first octet); 4 stable bytes from the
# (session,node) key; last byte = radio index. Two distinct nodes -> distinct
# block (crc32 collision negligible); a node keeps its MACs across reconnects.
# ---------------------------------------------------------------------------
def alloc_macs(session, node, count):
    base = zlib.crc32(("%s/%s" % (session, node)).encode()) & 0xFFFFFFFF
    count = max(1, int(count))
    macs = []
    for r in range(count):
        macs.append("02:%02x:%02x:%02x:%02x:%02x" % (
            (base >> 24) & 0xFF, (base >> 16) & 0xFF,
            (base >> 8) & 0xFF, base & 0xFF, r & 0xFF))
    return macs


# ---------------------------------------------------------------------------
# RF distance model — log-distance path-loss, identical to the Wi-Fi Painter.
# ---------------------------------------------------------------------------
def rssi_from_px(dpx, tx_dbm=None):
    """Modeled RX RSSI (dBm) at a canvas pixel distance dpx, given the transmitter's
    effective TX power (defaults to the symmetric TX_DBM)."""
    if tx_dbm is None:
        tx_dbm = RF["TX_DBM"]
    dm = max(1.0, dpx * RF["M_PER_PX"])
    return tx_dbm - (RF["PL0"] + 10.0 * RF["N"] * math.log10(dm))


def deliver_prob(rssi):
    """Bernoulli delivery probability for a frame received at `rssi`.
    Soft 10 dB band centred on sensitivity: >= SENS+5 always, <= SENS-5 never,
    linear between (fuzzy cell edge = flaky link / partial coverage)."""
    hi = RF["SENS"] + 5.0
    lo = RF["SENS"] - 5.0
    if rssi >= hi:
        return 1.0
    if rssi <= lo:
        return 0.0
    return (rssi - lo) / (hi - lo)


def clamp_signal(rssi):
    """Clamp a modeled RSSI to a sane s8 dBm range for HWSIM_ATTR_SIGNAL."""
    return int(round(max(-95.0, min(-20.0, rssi))))


# ---------------------------------------------------------------------------
# PositionStore — per-session node canvas coords, refreshed from
# <POS_DIR>/<session>/airduct-pos.json = {"<node>": [x, y], ...}. The x,y are
# the Node getLeft/getTop canvas px (the SAME source the Wi-Fi Painter renders
# from). Cached by mtime so a live drag (file rewrite) is picked up within a
# scan interval without re-reading on every frame.
# ---------------------------------------------------------------------------
class PositionStore:
    def __init__(self, pos_dir):
        self.pos_dir = pos_dir
        self._lock = threading.Lock()
        self._cache = {}   # session -> (mtime, {node: (x, y)})

    def _path(self, session):
        return os.path.join(self.pos_dir, str(session), "airduct-pos.json")

    def positions(self, session):
        path = self._path(session)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            with self._lock:
                self._cache.pop(session, None)
            return {}
        with self._lock:
            cached = self._cache.get(session)
            if cached and cached[0] == mtime:
                return cached[1]
        pos = {}
        try:
            with open(path, "r") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                for k, v in raw.items():
                    if isinstance(v, (list, tuple)) and len(v) >= 2:
                        pos[str(k)] = (float(v[0]), float(v[1]))
        except Exception as e:
            log("pos parse s=%s failed: %s" % (session, e))
            pos = {}
        with self._lock:
            self._cache[session] = (mtime, pos)
        return pos

    def link(self, session, src_node, dst_node, tx_dbm=None):
        """Return (rssi_dbm, dpx) for src->dst, or None if either lacks a position
        (=> caller fails OPEN: deliver, legacy signal). tx_dbm = the transmitter's
        effective TX power (directional); None => symmetric TX_DBM."""
        pos = self.positions(session)
        a = pos.get(str(src_node))
        b = pos.get(str(dst_node))
        if a is None or b is None:
            return None
        dpx = math.hypot(a[0] - b[0], a[1] - b[1])
        return (rssi_from_px(dpx, tx_dbm), dpx)


POS = PositionStore(POS_DIR)


# ---------------------------------------------------------------------------
# CaptureManager — OPT-IN per-session .pcap tee of the 802.11 frames crossing the
# medium. Every airduct sendFrame carries a raw 802.11 frame (the airhandler is the
# only place they exist — there is no host interface to tc-mirror like the wired
# capture flow), so this writes them straight to a libpcap file the user can open in
# Wireshark. Gated by a per-session marker <POS_DIR>/<session>/wifi-capture (the broker
# wifi_capture verb touches/removes it), so nothing is written unless capture was
# explicitly requested — no unconditional disk burn. Link type = DLT_IEEE802_11 (105):
# bare 802.11, no radiotap (airduct frames carry no PHY header).
# ---------------------------------------------------------------------------
PCAP_MAGIC = 0xA1B2C3D4
DLT_IEEE802_11 = 105


class CaptureManager:
    def __init__(self, base_dir):
        self.base_dir = base_dir
        self._lock = threading.Lock()
        self._files = {}       # session -> open file handle (global header written)
        self._checked = {}     # session -> (mtime_of_marker_dir_check, enabled_bool)

    def _marker(self, session):
        return os.path.join(self.base_dir, str(session), "wifi-capture")

    def _pcap_path(self, session):
        return os.path.join(self.base_dir, str(session), "wifi-%s.pcap" % session)

    def _enabled(self, session):
        """Marker present? Cached ~1s so we don't stat on every frame."""
        now = time.time()
        c = self._checked.get(session)
        if c and (now - c[0]) < 1.0:
            return c[1]
        en = os.path.exists(self._marker(session))
        self._checked[session] = (now, en)
        if not en:
            self._close(session)
        return en

    def _open(self, session):
        f = self._files.get(session)
        if f is not None:
            return f
        try:
            f = open(self._pcap_path(session), "wb")
            # libpcap global header: magic, ver 2.4, thiszone 0, sigfigs 0,
            # snaplen 65535, network = DLT_IEEE802_11.
            f.write(struct.pack("<IHHiIII", PCAP_MAGIC, 2, 4, 0, 0, 65535,
                                DLT_IEEE802_11))
            f.flush()
            self._files[session] = f
            log("capture START s=%s -> %s" % (session, self._pcap_path(session)))
            return f
        except OSError as e:
            log("capture open s=%s failed: %s" % (session, e))
            return None

    def _close(self, session):
        f = self._files.pop(session, None)
        if f is not None:
            try:
                f.close()
                log("capture STOP s=%s" % session)
            except OSError:
                pass

    def write(self, session, raw):
        """Append one 802.11 frame (raw bytes) to the session pcap, if capture is on."""
        if not self._enabled(session):
            return
        with self._lock:
            f = self._open(session)
            if f is None:
                return
            now = time.time()
            sec = int(now)
            usec = int((now - sec) * 1_000_000)
            n = len(raw)
            try:
                f.write(struct.pack("<IIII", sec, usec, n, n))
                f.write(raw)
                f.flush()
            except OSError as e:
                log("capture write s=%s failed: %s" % (session, e))
                self._close(session)


CAP = CaptureManager(POS_DIR)


# ---------------------------------------------------------------------------
# MediumBus — per-session RF domain: fan a TX frame from one node out to every
# OTHER node in the same session.
# ---------------------------------------------------------------------------
class MediumBus:
    def __init__(self):
        self._lock = threading.Lock()
        self._members = {}   # session -> set(NodeLink)

    def join(self, link):
        with self._lock:
            self._members.setdefault(link.session, set()).add(link)
        log("join s=%s n=%s (%d in session)"
            % (link.session, link.node, len(self._members.get(link.session, ()))))

    def leave(self, link):
        with self._lock:
            peers = self._members.get(link.session)
            if peers:
                peers.discard(link)
                if not peers:
                    self._members.pop(link.session, None)
        log("leave s=%s n=%s" % (link.session, link.node))

    def peers(self, link):
        with self._lock:
            return [p for p in self._members.get(link.session, ()) if p is not link]


BUS = MediumBus()


# ---------------------------------------------------------------------------
# NodeLink — one connected node (one airduct.sock). Runs the jsonrpc2 loop:
# answer airduct's Calls (macRequest/hostnameRequest/sendFrame) and, on
# sendFrame, flood injectFrame to session peers. Peers push RX in via inject().
# ---------------------------------------------------------------------------
class NodeLink:
    def __init__(self, path, session, node):
        self.path = path
        self.session = session
        self.node = node
        self.sock = None
        self.bus = BUS
        self._wlock = threading.Lock()
        self._next_id = 1
        self._alive = True

    # -- outbound to this node --------------------------------------------
    def _send(self, obj):
        if not self._alive or self.sock is None:
            return False
        try:
            data = encode_message(obj)
            with self._wlock:
                self.sock.sendall(data)
            return True
        except Exception as e:
            log("send s=%s n=%s failed: %s" % (self.session, self.node, e))
            self.close()
            return False

    def _ping_result(self):
        # The Jun-11 airduct unmarshals the ping result into a Go string and
        # tears the link down on a type error, so it needs "success" (string);
        # older ones took the object. Selectable; default preserves pod behavior.
        return "success" if PING_MODE == "string" else {"status": "success"}

    def _reply(self, mid, result):
        if mid is None:
            return
        self._send({"jsonrpc": "2.0", "id": mid, "result": result})

    def _reply_error(self, mid, code, message):
        if mid is None:
            return
        self._send({"jsonrpc": "2.0", "id": mid,
                    "error": {"code": code, "message": message}})

    def inject(self, b64frame, signal_dbm=None):
        """Deliver a peer's TX frame into this node (RX). Fire-and-forget Call;
        airduct's response is ignored by our read loop.

        params are ALWAYS a bare base64 string (an unpatched airduct unmarshals
        the param into a Go string, so the object form would break it). At tier 2
        the per-link signal is carried IN-BAND by APPENDING one signed dBm byte to
        the raw frame before base64: decoded[-1] = signal. A patched airduct
        (site 0x6d09b6 -> code-cave) reads that trailing byte of HWSIM_ATTR_FRAME
        and stamps it as HWSIM_ATTR_SIGNAL instead of the hardcoded -50; an
        unpatched airduct just injects a frame one byte longer (harmless for the
        RX-signal readout). tiers 0/1 send the frame verbatim."""
        if signal_dbm is not None:
            try:
                raw = base64.b64decode(b64frame)
                raw += bytes([int(signal_dbm) & 0xFF])   # signed dBm as one byte
                b64frame = base64.b64encode(raw).decode("ascii")
            except Exception as e:
                log("inject signal-append s=%s n=%s failed: %s"
                    % (self.session, self.node, e))
        with self._wlock:
            mid = self._next_id
            self._next_id += 1
        self._send({"jsonrpc": "2.0", "id": mid,
                    "method": "injectFrame", "params": b64frame})

    # -- inbound handling --------------------------------------------------
    def _flood(self, b64):
        """Fan a TX frame out to session peers, applying the RF distance model."""
        # OPT-IN pcap tee: capture the transmitted 802.11 frame ONCE per TX (here, not
        # per-peer, so the pcap has one record per over-the-air frame). No-op unless the
        # session's wifi-capture marker is set, so zero cost / disk for normal labs.
        try:
            CAP.write(self.session, base64.b64decode(b64))
        except Exception as e:
            log("capture decode s=%s failed: %s" % (self.session, e))
        # TX power depends on the SOURCE (this node): AP transmits harder than a client.
        tx_dbm = RF["TX_DBM_AP"] if str(self.node) in AP_NODES else RF["TX_DBM_CLIENT"]
        for peer in self.bus.peers(self):
            # Append the in-band signal byte only for patched receivers (or all, if
            # SIGNAL_NODES unset). Protects an unpatched peer's frames from the +1 byte.
            sig_ok = (not SIGNAL_NODES) or (str(peer.node) in SIGNAL_NODES)
            if RF_TIER <= 0:
                peer.inject(b64)            # legacy verbatim flood
                continue
            link = POS.link(self.session, self.node, peer.node, tx_dbm)
            if link is None:
                # No canvas position for one endpoint -> fail OPEN (no regression):
                # deliver; legacy signal at tier 2 (only to patched receivers).
                peer.inject(b64, signal_dbm=(-50 if (RF_TIER >= 2 and sig_ok) else None))
                continue
            rssi, dpx = link
            if random.random() > deliver_prob(rssi):
                continue                    # frame lost (out of / at edge of range)
            if RF_TIER >= 2 and sig_ok:
                peer.inject(b64, signal_dbm=clamp_signal(rssi))
            else:
                peer.inject(b64)

    def _handle_request(self, method, mid, params):
        if method == "macRequest":
            count = 1
            if isinstance(params, dict):
                try:
                    count = int(params.get("count", 1))
                except (TypeError, ValueError):
                    count = 1
            macs = alloc_macs(self.session, self.node, count)
            self._reply(mid, {"status": "success", "macs": macs})
        elif method == "hostnameRequest":
            self._reply(mid, {"status": "success",
                              "hostname": "pnet-%s-%s" % (self.session, self.node)})
        elif method == "sendFrame":
            # params is a base64 string of the raw 802.11 frame. Ack, then flood.
            self._reply(mid, {"status": "success"})
            if isinstance(params, str) and params:
                self._flood(params)
        elif method == "injectFrame":
            # Not expected at the handler, but ack defensively.
            self._reply(mid, {"status": "success"})
        elif method == "getWirelessInfo":
            self._reply(mid, {"status": "success", "interfaces": []})
        elif method == "ping":
            # jsonrpc2 keepalive from newer airduct binaries (2026-06-11+).
            # Must return a non-error result or airduct treats the keepalive as a
            # dead link, tears the jsonrpc2 connection down, and reconnects without
            # ever advancing to sendFrame -> no 802.11 frames reach the medium and
            # every wireless client scan is empty. Ack it (form is PING_MODE).
            self._reply(mid, self._ping_result())
        else:
            self._reply_error(mid, -32601, "unknown method: %s" % method)

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(10)
        s.connect(self.path)     # QEMU is the listener (server=on)
        s.settimeout(None)
        self.sock = s

    def run(self):
        try:
            self.connect()
            self.bus.join(self)
            while self._alive:
                msg = read_message(self.sock)
                if msg is None:
                    break
                if not isinstance(msg, dict):
                    continue
                if "method" in msg:
                    self._handle_request(msg.get("method"), msg.get("id"),
                                         msg.get("params"))
                # else: a response to our injectFrame -> ignore.
        except Exception as e:
            log("link error s=%s n=%s: %s" % (self.session, self.node, e))
        finally:
            self.bus.leave(self)
            self.close()

    def close(self):
        self._alive = False
        if self.sock is not None:
            try:
                self.sock.close()
            except Exception:
                pass
            self.sock = None


# ---------------------------------------------------------------------------
# Discovery loop — attach a NodeLink per live airduct.sock; reap on qemu exit.
# session/node = the last two path components before airduct.sock (works for the
# default /opt/unetlab/tmp/<s>/<n>/ and any <base>/<s>/<n>/ isolated bus).
# ---------------------------------------------------------------------------
def parse_runpath(path):
    parts = path.split("/")
    if len(parts) < 3 or parts[-1] != "airduct.sock":
        return None
    return parts[-3], parts[-2]   # (session, node)


def discovery_loop():
    links = {}   # path -> (NodeLink, Thread)
    log("started; scanning %s every %.1fs (RF tier=%d pos_dir=%s ping=%s)"
        % (RUN_GLOB, SCAN_INTERVAL, RF_TIER, POS_DIR, PING_MODE))
    while True:
        try:
            present = set(glob.glob(RUN_GLOB))
        except Exception:
            present = set()

        for path in list(links.keys()):
            link, th = links[path]
            if not th.is_alive() or path not in present:
                link.close()
                if not th.is_alive():
                    links.pop(path, None)

        for path in present:
            if path in links:
                continue
            sn = parse_runpath(path)
            if not sn:
                continue
            session, node = sn
            link = NodeLink(path, session, node)
            th = threading.Thread(target=link.run,
                                  name="link-%s-%s" % (session, node), daemon=True)
            links[path] = (link, th)
            th.start()

        time.sleep(SCAN_INTERVAL)


def main():
    # Single-instance guard via an abstract unix socket (no file to clean up).
    guard = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        guard.bind("\0" + GUARD_NAME)
    except OSError:
        log("another airhandler (%s) is already running; exiting" % GUARD_NAME)
        return 0
    try:
        discovery_loop()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
