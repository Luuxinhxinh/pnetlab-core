# -*- coding: utf-8 -*-
"""Telemetry & Traffic Inspection Operations Module.

Extracted from pnetlab-brokerd.py during Clean Architecture refactoring.
Handles Network Watcher (linkwatch) and Protocol Inspector (prototrace).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import time
from typing import Any, Dict, List, Tuple

BASE = '/opt/unetlab'
TMP_DIR = BASE + '/tmp'

def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)

class Reject(Exception):
    pass

def v_int(args: Dict[str, Any], key: str) -> int:
    v = args.get(key)
    if isinstance(v, bool) or not (isinstance(v, int) or (isinstance(v, str) and v.isdigit())):
        raise Reject('bad arg %s' % key)
    n = int(v)
    if n < 0 or n > 2**31:
        raise Reject('bad arg %s' % key)
    return n

def v_enum(args: Dict[str, Any], key: str, allowed: Any) -> Any:
    v = args.get(key)
    if v not in allowed:
        raise Reject('bad arg %s' % key)
    return v

def v_re(args: Dict[str, Any], key: str, rx: re.Pattern) -> str:
    v = args.get(key)
    if not isinstance(v, str) or not rx.match(v):
        raise Reject('bad arg %s' % key)
    return v

def v_bool(args: Dict[str, Any], key: str) -> int:
    return 1 if args.get(key) in (1, '1', True, 'true', 'yes', 'on') else 0

def run(argv, timeout=60, stderr=None, check_rc=True):
    p = subprocess.run(argv, stdout=subprocess.PIPE,
                       stderr=stderr if stderr is not None else subprocess.PIPE,
                       timeout=timeout)
    out = p.stdout.decode('utf-8', 'replace').splitlines()
    err = '' if stderr is not None else p.stderr.decode('utf-8', 'replace')
    return p.returncode, out, err

def run_quiet(argv, timeout=60):
    try:
        return run(argv, timeout=timeout)[0]
    except subprocess.TimeoutExpired:
        return 124

def spawn_unit(unit, argv, props=(), setenv=()):
    cmd = ['systemd-run', '--collect', '--unit', unit]
    for p in props:
        cmd += ['--property', p]
    for e in setenv:
        cmd += ['--setenv', e]
    cmd += argv
    rc, out, err = run(cmd, timeout=30)
    if rc != 0:
        raise Reject('systemd-run failed: %s' % (err.strip() or rc))
    return unit

LW_DIR = "/dev/shm/pnet-watch"
LW_MAX_IF = 1024          # effectively unlimited links (kept as a sanity bound only)
LW_MAX_FILTERS = 6
LW_HB_TIMEOUT = 180
RE_WATCH_ID = re.compile(r"^\d{1,6}_\d{1,6}$")     # <tenant>_<lab_session>
# Filter id: legacy positional "f0".."f5" OR a Tier-2 client-assigned stable slug
# (e.g. "c7"). Stable ids let a live add/remove preserve per-filter counters: the
# snapshot key and the daemon's socket-diff both hinge on the id surviving a reorder.
RE_FILTER_ID = re.compile(r"^[a-z][a-z0-9]{0,15}$")
RE_ETH_TAP = re.compile(r"^vunl\d+_\d+$")          # ethernet taps only (no ser*)

# Protocol Inspector (prototrace_*): per-link packet ladder for one chosen
# protocol. watch_id = <tenant>_<lab_session>_n<network_id> (one link per trace).
PT_DIR = "/dev/shm/pnet-trace"
PT_HB_TIMEOUT = 180
PT_BUFFER_MAX = 500
# Supported protocols -> capture core. IP cores get the 802.1Q-shifted variant
# appended in _pt_build_expr; the two L2 cores match by dst-MAC / LLC so they
# already cover tagged frames. Reuses the gate-tested Network Watcher BPF.
PT_PROTO_CORE = {
    "bgp":   ("ip", "tcp port 179"),
    "ospf":  ("ip", "ip proto 89"),
    "eigrp": ("ip", "ip proto 88"),
    "gre":   ("ip", "ip proto 47"),
    "stp":   ("l2", "ether dst 01:80:c2:00:00:00 or ether dst 01:00:0c:cc:cc:cd"),
    "isis":  ("l2", "isis"),
}
PT_PROTOS = set(PT_PROTO_CORE)
RE_TRACE_ID = re.compile(r"^\d{1,6}_\d{1,6}_n\d{1,7}$")
# node_show: read-only `show` commands only — never config/exec. Lowercase, a
# bounded charset (digits/dots/slash/colon for prefixes and interface names).
RE_SHOW_CMD = re.compile(r"^show [a-z0-9 ./:_+-]{1,80}$")
SHOW_MODES = {"raw", "bgp-table", "bgp-detail"}
# preset -> libpcap expression. Three shapes:
#   {"l2": expr}         layer-2, version-agnostic (no IPv4/IPv6 split)
#   {"v4":.., "v6":..}   version-split (the UI's v4/v6 dropdown picks one)
#   {"l4": expr}         L4/IP match, prefixed with ip/ip6 when a version is set
# "" (custom l4) = fields-only filter.
LW_PRESETS = {
    # layer-2 control planes. STP matches IEEE (01:80:c2...) AND Cisco PVST+/
    # rapid-PVST SSTP (01:00:0c:cc:cc:cd) — Linux bridges never forward the
    # IEEE group MAC (group_fwd_mask bit 0 is unforwardable), so on emulated
    # Cisco labs the SSTP MAC is the one actually on the wire.
    "stp":   {"l2": "ether dst 01:80:c2:00:00:00 or ether dst 01:00:0c:cc:cc:cd"},
    "cdp":   {"l2": "ether dst 01:00:0c:cc:cc:cc and ether[20:2] = 0x2000"},
    "lldp":  {"l2": "ether proto 0x88cc"},
    "isis":  {"l2": "isis"},
    "dot1q": {"l2": "vlan"},
    # IP routing protocols (IPv4 / IPv6 variants)
    "ospf":  {"v4": "ip proto 89", "v6": "ip6 proto 89"},
    "eigrp": {"v4": "ip proto 88", "v6": "ip6 proto 88"},
    "rip":   {"v4": "udp port 520", "v6": "udp port 521"},
    # ICMP — split so an IPv4 ping watch no longer catches IPv6 RS/ND
    "icmp":  {"v4": "icmp", "v6": "icmp6"},
    "ping":  {"v4": "icmp[icmptype] = 8 or icmp[icmptype] = 0",
              "v6": "icmp6 and (ip6[40] = 128 or ip6[40] = 129)"},
    # L4 / overlay
    "bgp":   {"l4": "tcp port 179"},
    "vxlan": {"l4": "udp port 4789"},
    "lisp":  {"l4": "udp port 4341 or udp port 4342"},
    # tunnels / AAA
    "gre":   {"v4": "ip proto 47", "v6": "ip6 proto 47"},
    "ipsec": {"v4": "ip proto 50 or ip proto 51 or (ip and udp and (port 500 or port 4500))",
              "v6": "ip6 proto 50 or ip6 proto 51 or (ip6 and udp and (port 500 or port 4500))"},
    "radius": {"l4": "udp and (port 1812 or port 1813 or port 1645 or port 1646)"},
    "tacacs": {"l4": "tcp port 49"},
    # catch-all: an empty/always-true L2 core compiles to an accept-all BPF, so
    # the link lights for ANY frame on the tap — any node type (VPCS, firewall,
    # endpoint, router…) and any protocol (ARP, DHCP, L2 control, IP, …).
    "all":   {"l2": "len >= 0"},
    "arp":   {"l2": "arp or rarp"},
    "custom": {"l4": ""},
}


# Per-preset subtype fragments.  Each entry is a dict keyed by subtype slug.
# Values are dicts with some subset of: "v4" (IPv4 fragment), "v6" (IPv6),
# "l2" (L2 fragment, version-agnostic), "arg" (slot needs a numeric subtype_arg),
# "v4_only" (IPv6 not supported for this subtype — Reject if ver==6).
# All fragments MUST compile: verified with `tcpdump -y EN10MB -ddd '<expr>'`.
#
# SKIP list (cBPF can't walk v6 extension headers): IPv6 variants of
# eigrp/bgp/rip/lisp/vxlan subtypes; CDP/LLDP TLVs; dot1q per-VID.
LW_SUBTYPES = {
    "icmp": {
        "echo-req":   {"v4": "icmp[icmptype]=8",   "v6": "icmp6 and ip6[40]=128"},
        "echo-reply": {"v4": "icmp[icmptype]=0",   "v6": "icmp6 and ip6[40]=129"},
        "unreach":    {"v4": "icmp[icmptype]=3",   "v6": "icmp6 and ip6[40]=1"},
        "ttl-exceeded":{"v4": "icmp[icmptype]=11", "v6": "icmp6 and ip6[40]=3"},
        "redirect":   {"v4": "icmp[icmptype]=5",   "v6_skip": True},
    },
    "ping": {
        "echo-req":   {"v4": "icmp[icmptype]=8",   "v6": "icmp6 and ip6[40]=128"},
        "echo-reply": {"v4": "icmp[icmptype]=0",   "v6": "icmp6 and ip6[40]=129"},
    },
    "ospf": {
        # ip[((ip[0]&0xf)<<2)+1] = OSPF type byte
        "hello":  {"v4": "ip proto 89 and ip[((ip[0]&0xf)<<2)+1]=1",
                   "v6": "ip6 proto 89 and ip6[41]=1"},
        "dbd":    {"v4": "ip proto 89 and ip[((ip[0]&0xf)<<2)+1]=2",
                   "v6": "ip6 proto 89 and ip6[41]=2"},
        "lsr":    {"v4": "ip proto 89 and ip[((ip[0]&0xf)<<2)+1]=3",
                   "v6": "ip6 proto 89 and ip6[41]=3"},
        "lsu":    {"v4": "ip proto 89 and ip[((ip[0]&0xf)<<2)+1]=4",
                   "v6": "ip6 proto 89 and ip6[41]=4"},
        "lsack":  {"v4": "ip proto 89 and ip[((ip[0]&0xf)<<2)+1]=5",
                   "v6": "ip6 proto 89 and ip6[41]=5"},
    },
    "eigrp": {
        # v4 only (cBPF cannot walk IPv6 extension headers for EIGRP)
        "update":    {"v4": "ip proto 88 and ip[((ip[0]&0xf)<<2)+1]=1",  "v4_only": True},
        "query":     {"v4": "ip proto 88 and ip[((ip[0]&0xf)<<2)+1]=3",  "v4_only": True},
        "reply":     {"v4": "ip proto 88 and ip[((ip[0]&0xf)<<2)+1]=4",  "v4_only": True},
        "hello-ack": {"v4": "ip proto 88 and ip[((ip[0]&0xf)<<2)+1]=5",  "v4_only": True},
        "sia-query": {"v4": "ip proto 88 and ip[((ip[0]&0xf)<<2)+1]=10", "v4_only": True},
        "sia-reply": {"v4": "ip proto 88 and ip[((ip[0]&0xf)<<2)+1]=11", "v4_only": True},
    },
    "bgp": {
        # Classifies the first message in each TCP segment — acceptable for telemetry.
        # tcp[((tcp[12]&0xf0)>>2)+18] = BGP marker[0] type byte offset.
        # v4 only (BGP over IPv6 uses the same TCP 179 port but cBPF v6 header
        # walk limitations make the type-byte access unsafe).
        "open":         {"v4": "tcp port 179 and tcp[((tcp[12]&0xf0)>>2)+18]=1",  "v4_only": True},
        "update":       {"v4": "tcp port 179 and tcp[((tcp[12]&0xf0)>>2)+18]=2",  "v4_only": True},
        "notification": {"v4": "tcp port 179 and tcp[((tcp[12]&0xf0)>>2)+18]=3",  "v4_only": True},
        "keepalive":    {"v4": "tcp port 179 and tcp[((tcp[12]&0xf0)>>2)+18]=4",  "v4_only": True},
    },
    "stp": {
        # BPDU type byte at fixed offset for untagged; tagged variant adds 4-byte
        # 802.1Q header (ether[25] instead of ether[21]).
        "config": {"l2": "(ether dst 01:80:c2:00:00:00 and ether[20]=0x00) or "
                         "(ether dst 01:00:0c:cc:cc:cd and ether[25]=0x00) or "
                         "(vlan and ether dst 01:00:0c:cc:cc:cd and ether[29]=0x00)"},
        # Topology change: a classic 802.1D TCN BPDU (type 0x80) OR the TC flag
        # (low bit of the flags byte: ether[21]/[26]/[30]) set in a config/RST
        # BPDU — so it also lights on RSTP/MSTP topology changes, not just legacy
        # TCN frames. (Event-driven: only present during an actual port up/down.)
        "tcn":    {"l2": "(ether dst 01:80:c2:00:00:00 and (ether[20]=0x80 or ether[21]&0x1=1)) or "
                         "(ether dst 01:00:0c:cc:cc:cd and (ether[25]=0x80 or ether[26]&0x1=1)) or "
                         "(vlan and ether dst 01:00:0c:cc:cc:cd and (ether[29]=0x80 or ether[30]&0x1=1))"},
        "rstp":   {"l2": "(ether dst 01:80:c2:00:00:00 and ether[20]=0x02) or "
                         "(ether dst 01:00:0c:cc:cc:cd and ether[25]=0x02) or "
                         "(vlan and ether dst 01:00:0c:cc:cc:cd and ether[29]=0x02)"},
    },
    "isis": {
        # IS-IS PDU type = lower 5 bits of ether[21] (Eth frame, after LLC header).
        "hello":  {"l2": "isis and ((ether[21] & 0x1f) = 15 or (ether[21] & 0x1f) = 16 or (ether[21] & 0x1f) = 17)"},
        "lsp":    {"l2": "isis and ((ether[21] & 0x1f) = 18 or (ether[21] & 0x1f) = 20)"},
        "csnp":   {"l2": "isis and ((ether[21] & 0x1f) = 24 or (ether[21] & 0x1f) = 25)"},
        "psnp":   {"l2": "isis and ((ether[21] & 0x1f) = 26 or (ether[21] & 0x1f) = 27)"},
    },
    "rip": {
        # v4 only (RIPng uses UDP 521, out of scope for this subtype)
        "request":  {"v4": "udp port 520 and udp[8]=1",  "v4_only": True},
        "response": {"v4": "udp port 520 and udp[8]=2",  "v4_only": True},
    },
    "lisp": {
        # LISP control port 4342; message type in upper nibble of byte 0
        "map-request":  {"v4": "udp dst port 4342 and (udp[8]&0xf0)=0x10", "v4_only": True},
        "map-reply":    {"v4": "udp dst port 4342 and (udp[8]&0xf0)=0x20", "v4_only": True},
        "map-register": {"v4": "udp dst port 4342 and (udp[8]&0xf0)=0x30", "v4_only": True},
        "map-notify":   {"v4": "udp dst port 4342 and (udp[8]&0xf0)=0x40", "v4_only": True},
    },
    "vxlan": {
        # VNI match: udp[12:4] is the 32-bit VXLAN header; VNI is top 24 bits >> 8.
        # Inner-protocol matching is infeasible in cBPF — not offered.
        "vni": {"l4": "udp port 4789 and (udp[12:4] >> 8) = {arg}", "arg": True},
    },
    "ipsec": {
        "esp":    {"v4": "ip proto 50", "v6": "ip6 proto 50"},
        "ah":     {"v4": "ip proto 51", "v6": "ip6 proto 51"},
        "isakmp": {"l4": "udp and (port 500 or port 4500)"},
    },
    "radius": {
        "auth": {"l4": "udp and (port 1812 or port 1645)"},
        "acct": {"l4": "udp and (port 1813 or port 1646)"},
    },
}


def _lw_subtype_core(preset, f, ver):
    """Return the libpcap core expression for a filter that has a subtype field.
    Raises Reject for unsupported combinations."""
    subtype = f.get("subtype", "")
    ptable = LW_SUBTYPES.get(preset)
    if not ptable:
        raise Reject("preset %s has no subtypes" % preset)
    stdef = ptable.get(subtype)
    if stdef is None:
        raise Reject("unknown subtype %s for preset %s" % (subtype, preset))

    if stdef.get("v4_only") and ver == "6":
        raise Reject("subtype %s not available for IPv6" % subtype)

    if stdef.get("arg"):
        sa = f.get("subtype_arg")
        if not isinstance(sa, int) or sa < 1 or sa > 16777215:
            raise Reject("subtype_arg required for subtype %s" % subtype)
        tpl = stdef.get("v4") or stdef.get("l4") or stdef.get("l2") or ""
        return tpl.replace("{arg}", str(sa))

    if "l2" in stdef:
        return stdef["l2"]

    if "v4" in stdef:
        if ver == "4":
            return stdef["v4"]
        if ver == "6":
            v6 = stdef.get("v6")
            if not v6:
                raise Reject("subtype %s not available for IPv6" % subtype)
            return v6
        # version unset: union v4 + v6 if both available
        v6 = stdef.get("v6")
        if v6:
            return "(%s) or (%s)" % (stdef["v4"], v6)
        return stdef["v4"]

    if "l4" in stdef:
        expr = stdef["l4"]
        if ver == "4":
            return "ip and (%s)" % expr
        if ver == "6":
            return "ip6 and (%s)" % expr
        return expr

    raise Reject("subtype %s has no applicable fragment" % subtype)


def _lw_is_ip(preset):
    return "l2" not in LW_PRESETS[preset]


def _lw_preset_core(preset, ver):
    """Resolve a preset to its libpcap core for the chosen IP version
    (ver = '4' | '6' | '')."""
    p = LW_PRESETS[preset]
    if "l2" in p:
        return p["l2"]
    if "v4" in p:
        if ver == "4":
            return p["v4"]
        if ver == "6":
            return p["v6"]

# ---- Network Watcher (linkwatch) --------------------------------------------

def _lw_build_expr(f):
    """Build the libpcap expression for one filter ENTIRELY broker-side from
    validated structured fields — no free text crosses the trust boundary."""
    preset = v_enum(f, "preset", set(LW_PRESETS))
    ver = ""
    if "version" in f and f["version"] not in ("", None):
        if not isinstance(f["version"], str):
            raise Reject("bad arg version")
        ver = v_enum(f, "version", {"4", "6"})
    terms = []
    if f.get("subtype"):
        core = _lw_subtype_core(preset, f, ver)
    else:
        core = _lw_preset_core(preset, ver)
    if core:
        terms.append("(%s)" % core)
    ip_terms = []
    if "src_ip" in f and f["src_ip"] not in ("", None):
        ip_terms.append(_lw_ip_host_term(f, "src_ip", "src", ver))
    if "dst_ip" in f and f["dst_ip"] not in ("", None):
        ip_terms.append(_lw_ip_host_term(f, "dst_ip", "dst", ver))
    if not ver and len(ip_terms) == 2 and ip_terms[0][0] != ip_terms[1][0]:
        raise Reject("src_ip and dst_ip must use the same IP family")
    terms.extend(term for _, term in ip_terms)
    proto = None
    if f.get("proto"):
        proto = v_enum(f, "proto", {"tcp", "udp", "icmp"})
        if proto == "icmp":
            terms.append("(icmp or icmp6)")
            proto = None
    if f.get("port") is not None:
        port = v_int(f, "port")
        if port < 1 or port > 65535:
            raise Reject("bad arg port")
        terms.append("%s port %d" % (proto, port) if proto else "port %d" % port)
    elif proto:
        terms.append(proto)
    if not terms:
        raise Reject("empty filter")
    expr = " and ".join(terms)
    # 802.1Q-tagged traffic needs the vlan-shifted variant of IP-layer matches
    if _lw_is_ip(preset):
        expr = "(%s) or (vlan and (%s))" % (expr, expr)
    return expr


def _lw_parse(args):
    """Validate a linkwatch start/reload request -> (wid, taps, conf_filters,
    interval, out). Filters are compiled to BPF here (structured fields only; no
    free text crosses the boundary). Shared by linkwatch_start and _reload."""
    wid = v_re(args, "watch_id", RE_WATCH_ID)
    ifaces = v_list(args, "interfaces", LW_MAX_IF)
    taps = [v_re({"t": i}, "t", RE_ETH_TAP) for i in ifaces]
    filters = v_list(args, "filters", LW_MAX_FILTERS)
    out, conf_filters = [], []
    seen = set()
    for f in filters:
        if not isinstance(f, dict):
            raise Reject("bad filter")
        fid = v_re(f, "id", RE_FILTER_ID)
        if fid in seen:
            raise Reject("duplicate filter id")
        seen.add(fid)
        expr = _lw_build_expr(f)
        conf_filters.append({"id": fid, "expr": expr})
        out.append("%s %s" % (fid, expr))
    # snapshot/refresh cadence (s): UI "speed" control, clamped for sanity
    interval = 1.0
    if args.get("interval") is not None:
        try:
            interval = float(args.get("interval"))
        except (TypeError, ValueError):
            raise Reject("bad arg interval")
        if interval < 0.2 or interval > 2.0:
            raise Reject("bad arg interval")
    return wid, taps, conf_filters, interval, out


def _lw_write_conf(wid, taps, conf_filters, interval):
    """Atomically (tmp + rename) write the daemon's conf.json, so a concurrent
    SIGHUP reload never reads a half-written file."""
    os.makedirs(LW_DIR, exist_ok=True)
    os.chmod(LW_DIR, 0o775)
    shutil.chown(LW_DIR, "root", "www-data")   # PHP touches the .hb heartbeat
    conf = {"watch_id": wid, "interfaces": taps, "filters": conf_filters,
            "hb_timeout": LW_HB_TIMEOUT, "interval": interval}
    path = os.path.join(LW_DIR, wid + ".conf.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(conf, f)
    os.replace(tmp, path)


def _lw_unit_active(unit):
    return run_quiet(["systemctl", "is-active", "--quiet", unit + ".service"]) == 0


def _lw_signal_reload(unit):
    """SIGHUP the running daemon so it re-reads conf.json and diffs its sockets."""
    return run_quiet(["systemctl", "kill", "--signal=HUP", unit + ".service"])


def verb_linkwatch_start(args):
    wid, taps, conf_filters, interval, out = _lw_parse(args)
    unit = "pnet-linkwatch-" + wid
    # Tier 2: if the watch is already running, RELOAD in place (rewrite conf +
    # SIGHUP) instead of stop+respawn. The daemon diffs its socket set and keeps
    # surviving (tap x filter) counters, so a live filter add/remove — and the GET
    # self-heal re-arm, and a speed change — no longer reset the user's counters.
    if _lw_unit_active(unit) and os.path.exists(os.path.join(LW_DIR, wid + ".conf.json")):
        _lw_write_conf(wid, taps, conf_filters, interval)
        _lw_signal_reload(unit)
        return 0, out, ""
    # Fresh start: (re)spawn the daemon.
    run_quiet(["systemctl", "stop", unit + ".service"])  # clear any stale unit
    _lw_write_conf(wid, taps, conf_filters, interval)
    # fresh heartbeat so a slow first GET doesn't race the stale check;
    # group-writable so pnq-linkwatch.php (www-data) can touch() it
    hb = os.path.join(LW_DIR, wid + ".hb")
    open(hb, "w").close()
    os.chmod(hb, 0o664)
    shutil.chown(hb, "root", "www-data")
    spawn_unit(unit,
               ["/usr/bin/python3", BASE + "/scripts/pnetlab-linkwatchd.py", wid],
               props=("MemoryMax=64M", "CPUQuota=30%"))
    return 0, out, ""


def verb_linkwatch_reload(args):
    """Tier 2: explicit in-place filter update for an already-running watch. Same
    validated, structured-field contract as linkwatch_start; rewrites conf.json
    and SIGHUPs the daemon (socket-diff, counters preserved). Rejects when the
    watch isn't running (caller should linkwatch_start instead)."""
    wid, taps, conf_filters, interval, out = _lw_parse(args)
    unit = "pnet-linkwatch-" + wid
    if not _lw_unit_active(unit):
        raise Reject("watch not running")
    _lw_write_conf(wid, taps, conf_filters, interval)
    _lw_signal_reload(unit)
    return 0, out, ""


def _lw_unlink(wid):
    for suffix in (".json", ".conf.json", ".hb"):
        try:
            os.unlink(os.path.join(LW_DIR, wid + suffix))
        except OSError:
            pass


def verb_linkwatch_stop(args):
    wid = v_re(args, "watch_id", RE_WATCH_ID)
    run_quiet(["systemctl", "stop", "pnet-linkwatch-%s.service" % wid])
    _lw_unlink(wid)
    return 0, [], ""


def verb_linkwatch_status(args):
    wid = v_re(args, "watch_id", RE_WATCH_ID)
    rc = run_quiet(["systemctl", "is-active", "--quiet",
                    "pnet-linkwatch-%s.service" % wid])
    age = -1
    try:
        age = int(time.time() - os.stat(
            os.path.join(LW_DIR, wid + ".json")).st_mtime)
    except OSError:
        pass
    return 0, ["active" if rc == 0 else "inactive", str(age)], ""


def verb_linkwatch_probe(args):
    """Return the subset of the given taps that exist and are admin-UP on THIS
    host. The engine calls it per-satellite so the cross-host link/direction
    selection can use the same liveness the master gets locally from
    /sys/class/net. out = the live tap names."""
    ifaces = v_list(args, "interfaces", LW_MAX_IF)
    live = []
    for i in ifaces:
        t = v_re({"t": i}, "t", RE_ETH_TAP)
        try:
            with open("/sys/class/net/%s/flags" % t) as f:
                if int(f.read().strip(), 16) & 1:               # IFF_UP
                    live.append(t)
        except (OSError, ValueError):
            pass
    return 0, live, ""


def verb_linkwatch_snapshot(args):
    """Return the current snapshot JSON for a watch on THIS host and refresh its
    heartbeat. Backs the cross-host snapshot merge: the master web tier is the
    only poller, so this keep-alive stands in for the .hb touch a local GET does.
    out = one JSON line ({} when no snapshot yet)."""
    wid = v_re(args, "watch_id", RE_WATCH_ID)
    try:
        os.utime(os.path.join(LW_DIR, wid + ".hb"), None)       # keep-alive
    except OSError:
        pass
    try:
        with open(os.path.join(LW_DIR, wid + ".json")) as f:
            return 0, [f.read()], ""
    except OSError:
        return 0, ["{}"], ""


def verb_linkstats(args):
    """Per-tap rx/tx packet totals for the given taps on THIS host (sysfs).
    Backs the always-on interface-label egress glow for satellite-placed nodes:
    the engine enumerates a satellite's expected taps from the lab XML and
    relays them here. out = one JSON line {tap: {rx, tx, rxb, txb}} (live taps
    only). rxb/txb are the BYTE counters (additive keys) backing the island's
    per-link utilization labels for satellite-placed nodes."""
    ifaces = v_list(args, "interfaces", 512)
    res = {}
    for i in ifaces:
        t = v_re({"t": i}, "t", RE_ETH_TAP)
        base = "/sys/class/net/%s/statistics/" % t
        try:
            with open(base + "rx_packets") as f:
                rx = int(f.read().strip())
            with open(base + "tx_packets") as f:
                tx = int(f.read().strip())
            with open(base + "rx_bytes") as f:
                rxb = int(f.read().strip())
            with open(base + "tx_bytes") as f:
                txb = int(f.read().strip())
            res[t] = {"rx": rx, "tx": tx, "rxb": rxb, "txb": txb}
        except (OSError, ValueError):
            pass
    return 0, [json.dumps(res)], ""


# ---- Protocol Inspector (prototrace) ----------------------------------------

def _pt_build_expr(proto):
    """libpcap expression for the chosen protocol, built broker-side only.
    IP protocols also get the 802.1Q-shifted variant so tagged links match;
    L2 protocols (stp/isis) match by dst-MAC / LLC and need no vlan wrap."""
    entry = PT_PROTO_CORE.get(proto)
    if entry is None:
        raise Reject("unknown proto")
    kind, core = entry
    if kind == "l2":
        return core
    return "(%s) or (vlan and (%s))" % (core, core)


def _pt_label(args, key):
    """Sanitise a display node-name from the PHP side: printable ASCII, <=48."""
    v = args.get(key)
    if not isinstance(v, str):
        return ""
    v = "".join(c for c in v if 32 <= ord(c) < 127)
    return v[:48]


def _pt_unlink(wid):
    for suffix in (".json", ".conf.json", ".hb"):
        try:
            os.unlink(os.path.join(PT_DIR, wid + suffix))
        except OSError:
            pass


def verb_prototrace_start(args):
    wid = v_re(args, "watch_id", RE_TRACE_ID)
    iface = v_re(args, "interface", RE_ETH_TAP)
    proto = v_enum(args, "proto", PT_PROTOS)
    flip = bool(args.get("flip"))
    buffer_max = PT_BUFFER_MAX
    if args.get("buffer_max") is not None:
        try:
            buffer_max = int(args.get("buffer_max"))
        except (TypeError, ValueError):
            raise Reject("bad arg buffer_max")
        buffer_max = max(50, min(2000, buffer_max))
    expr = _pt_build_expr(proto)
    os.makedirs(PT_DIR, exist_ok=True)
    os.chmod(PT_DIR, 0o775)
    shutil.chown(PT_DIR, "root", "www-data")    # PHP touches the .hb heartbeat
    unit = "pnet-prototrace-" + wid
    run_quiet(["systemctl", "stop", unit + ".service"])  # last start wins
    conf = {"watch_id": wid, "interface": iface, "flip": flip, "proto": proto,
            "expr": expr, "buffer_max": buffer_max, "hb_timeout": PT_HB_TIMEOUT,
            "a": _pt_label(args, "a"), "b": _pt_label(args, "b")}
    with open(os.path.join(PT_DIR, wid + ".conf.json"), "w") as f:
        json.dump(conf, f)
    hb = os.path.join(PT_DIR, wid + ".hb")
    open(hb, "w").close()
    os.chmod(hb, 0o664)
    shutil.chown(hb, "root", "www-data")
    spawn_unit(unit,
               ["/usr/bin/python3", BASE + "/scripts/pnetlab-prototracer.py", wid],
               props=("MemoryMax=64M", "CPUQuota=30%"))
    return 0, [expr], ""


def verb_prototrace_stop(args):
    wid = v_re(args, "watch_id", RE_TRACE_ID)
    run_quiet(["systemctl", "stop", "pnet-prototrace-%s.service" % wid])
    _pt_unlink(wid)
    return 0, [], ""


def verb_prototrace_status(args):
    wid = v_re(args, "watch_id", RE_TRACE_ID)
    rc = run_quiet(["systemctl", "is-active", "--quiet",
                    "pnet-prototrace-%s.service" % wid])
    age = -1
    try:
        age = int(time.time() - os.stat(
            os.path.join(PT_DIR, wid + ".json")).st_mtime)
    except OSError:
        pass
    return 0, ["active" if rc == 0 else "inactive", str(age)], ""


def verb_prototrace_snapshot(args):
    """Return the current tracer snapshot JSON for a trace on THIS host and
    refresh its heartbeat. Backs the cross-host Protocol Inspector poll when the
    selected link end lives on a satellite. out = one JSON line ({} if none)."""
    wid = v_re(args, "watch_id", RE_TRACE_ID)
    try:
        os.utime(os.path.join(PT_DIR, wid + ".hb"), None)       # keep-alive
    except OSError:
        pass
    try:
        with open(os.path.join(PT_DIR, wid + ".json")) as f:
            return 0, [f.read()], ""
    except OSError:
        return 0, ["{}"], ""




VERBS = {
    'linkwatch_start': verb_linkwatch_start,
    'linkwatch_reload': verb_linkwatch_reload,
    'linkwatch_stop': verb_linkwatch_stop,
    'linkwatch_status': verb_linkwatch_status,
    'linkwatch_probe': verb_linkwatch_probe,
    'linkwatch_snapshot': verb_linkwatch_snapshot,
    'linkstats': verb_linkstats,
    'prototrace_start': verb_prototrace_start,
    'prototrace_stop': verb_prototrace_stop,
    'prototrace_status': verb_prototrace_status,
    'prototrace_snapshot': verb_prototrace_snapshot,
}
