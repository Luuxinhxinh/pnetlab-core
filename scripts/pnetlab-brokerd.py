#!/usr/bin/env python3
# pnetlab-brokerd — root privilege broker for the PNetLab engine (B1).
#
# Replaces the engine's exec("sudo ...") call sites: a root daemon on a unix
# socket exposing an ALLOWLISTED verb set with per-argument validation. PHP
# talks to it through includes/broker.php. The www-data sudoers grant stays
# until the last call site is ported (store still rides sudo), then drops.
#
# Protocol: one JSON object per connection, newline-terminated.
#   request:  {"verb": "...", "args": {...}}\n
#   response: {"ok": bool, "rc": int, "out": [lines], "err": "..."}\n
# Peer must be uid 0 or www-data (SO_PEERCRED). Every request is logged to
# journald (stderr). Unknown verbs / bad args are rejected, never executed.
#
# Run via pnetlab-brokerd.service (shipped in the pnetlab deb).

import hashlib
import hmac
import ipaddress
import json
import math
import os
import pwd
import re
import secrets
import shlex
import signal
import shutil
import socket
import socketserver
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib

try:
    import yaml
except Exception:      # pragma: no cover - broker refuses docker_create without it
    yaml = None

SOCK_PATH = "/run/pnetlab/broker.sock"
SOCK_GROUP = "www-data"
MAX_REQUEST = 65536

# Native RoCE endpoint controller (v1).  The guest agent has two fixed,
# read-only status resources. Keep the transport limits here rather than
# accepting any request shape, port, path, timeout, or byte cap from PHP.
ROCE_AGENT_PORT = 4050
ROCE_AGENT_TIMEOUT = 2.0
ROCE_AGENT_MAX_RESPONSE = 32768
ROCE_BROKER_API = "rxe-broker/v1"
ROCE_WORKLOAD_API = "rxe-workload/v1"
ROCE_RUN_DIR = "/run/pnetlab/roce"
ROCE_RUN_LIMIT = 64
ROCE_WORKLOAD_LOCK = threading.RLock()
RE_ROCE_RUN = re.compile(r"^[0-9a-f]{32}$")
RE_ROCE_UUID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

BASE = "/opt/unetlab"
LABS_DIR = BASE + "/labs"
TMP_DIR = BASE + "/tmp"
UNL_WRAPPER = BASE + "/wrappers/unl_wrapper"
NSENTER = BASE + "/wrappers/nsenter"
WRAPPER_LOG = BASE + "/data/Logs/unl_wrapper.txt"

# Appliance-wide QEMU CPU policy.  The flag is deliberately kept beside the
# existing /opt/unetlab/ksm and /opt/unetlab/uksm state files.  Per-scope smp
# metadata is runtime-only: it records the authoritative value supplied by
# DeviceQemu at attach time so a policy toggle never has to parse QEMU argv.
CPU_POLICY_FILE = BASE + "/cpulimit"
CPU_SCOPE_ROOT = "/sys/fs/cgroup/pnetlab.slice"
CPU_SCOPE_STATE_DIR = "/run/pnetlab/qemu-cpu"
CPU_PERIOD_US = 100000
CPU_WEIGHT = 100
CPU_QUOTA_PER_VCPU_PERCENT = 50
CPU_QUOTA_HEADROOM_PERCENT = 50
CPU_GRACE_SECONDS = 60
CPU_QUOTA_INFINITY_US = 18446744073709551615
CPU_SCOPE_DISCOVERY_SECONDS = 2.0
CPU_SCOPE_VERIFY_SECONDS = 5.0
CPU_POLICY_LOCK = threading.RLock()

# Traffic-control ownership. TC changes are serialized because discovery then
# mutation is otherwise a race between broker request threads. These fixed IDs
# are an operational contract for broker/non-root callers, not a security
# boundary against trusted root, which can intentionally reuse any TC handle.
TC_LOCK = threading.RLock()
PNET_NETEM_HANDLE = "50ab:"
CAPTURE_FILTERS = {
    "ingress": (49150, "0x504e0001"),
    "egress": (49151, "0x504e0002"),
}

WRAPPER_LAB_ACTIONS = {"start", "stop", "wipe", "export", "delete"}
WRAPPER_BARE_ACTIONS = {
    "fixpermissions", "platform", "stopall",
    "ksmon", "ksmoff", "uksmon", "uksmoff",
    "cpulimiton", "cpulimitoff",
}

# AI Lab Builder / MCP server (P1). data/ai/config.json is 0600 root (holds the
# external access-token hashes, the localhost bridge secret and — from P3 — the
# appliance-wide LLM key). The bridge secret is ALSO mirrored to a 0640
# root:www-data file so the www-data engine shim (html/mcp/bridge.php) can
# validate the loopback call without reading the root-only config.
AI_DIR = BASE + "/data/ai"
AI_CONFIG = AI_DIR + "/config.json"
AI_BRIDGE_SECRET = AI_DIR + "/bridge.secret"
AI_USAGE = AI_DIR + "/usage.json"               # per-day, per-pod token ledger (P3)
AI_PROGRESS_DIR = AI_DIR + "/progress"          # per-pod live build event stream (P7)
AI_AGENT = BASE + "/scripts/mcp/ai_lab_agent.py"
MCP_UNIT = "pnetlab-mcp.service"
MCP_UNIT_SRC = BASE + "/scripts/mcp/pnetlab-mcp.service"
MCP_UNIT_DST = "/etc/systemd/system/pnetlab-mcp.service"
MCP_SERVICE_OPS = {"start", "stop", "restart", "enable", "disable", "status"}
RE_TOKEN_NAME = re.compile(r"^[A-Za-z0-9 _.-]{1,48}$")
RE_LAB_PATH = re.compile(r"^(?!.*(?:^|/)\.\.(?:/|$))/[^\x00]*\.unl$")
AI_PROVIDERS = {"anthropic", "openai", "azure", "local"}
AI_BUILD_MODES = {"plan", "apply"}

# B7 (store ports)
SERVICES = {"apache2", "mysql", "guacd", "docker", "pnetnat"}
FS_JAILS = ("/opt/unetlab/addons", "/opt/unetlab/tmp", "/tmp/commit",
            "/opt/unetlab/html/templates")
RE_FACTORY_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# qemu image commit / save-as (verb_qemu_img).
ADDONS_QEMU = BASE + "/addons/qemu"
# A node's disk file. Mirrors the pattern device_qemu.php matches when it makes
# the linked clone (`^[a-zA-Z0-9]+.qcow2$`), minus that one's unescaped dot.
RE_QEMU_DISK = re.compile(r"^[a-zA-Z0-9]{1,64}\.qcow2$")
# A destination image DIRECTORY NAME — never a path. Dots ARE allowed because
# PNetLab's own qemu image dirs use them by convention
# (vios-adventerprisek9-m.spa.159-3.m8), and a saved image that cannot follow
# the house naming would just get renamed by hand afterwards. Safety comes from
# the first character having to be alphanumeric — so "." and ".." cannot be
# expressed — plus no slash, so the name is always exactly one component under
# addons/qemu, and the broker composes the path itself.
RE_QEMU_IMAGE_DIR = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")

# --- www-data->root exec hardening (Stage 0.5) ------------------------------
# The broker has NO per-verb auth (it trusts the calling PHP), so any verb that
# root-EXECUTES a script www-data can author/overwrite is a straight escalation.
# The worker.sh scripts historically lived in the www-data-owned html tree
# (-rwxr-xr-x www-data www-data), so www-data could rewrite them between
# validation and the root exec. The canonical copies now ship under a root-owned
# directory outside the fixpermissions www-data sweep, and every root-exec of a
# script goes through _require_root_script (root-owned + not group/other-writable).
WORKERS_DIR = BASE + "/scripts/workers"      # root:root 0755, shipped in the deb
IOL_KEYGEN = BASE + "/addons/iol/bin/CiscoIOUKeygen3.py"
# addon dirs the broker root-EXECUTES from: verb_fs_op must never be allowed to
# WRITE here (cp_f/mv_f/chmod/chown), else www-data could plant code that
# verb_iol_keygen then runs as root. Deny-listed inside _fs_jailed.
FS_WRITE_DENY = (BASE + "/addons/iol/bin",)
RE_CLUSTER_USER = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

RE_JOB = re.compile(r"^[0-9a-f]{16}$")
RE_TAP = re.compile(r"^(ser|vunl)\d+_\d+$")
RE_NET = re.compile(r"^[A-Za-z0-9_.-]{1,15}$")
RE_MON = re.compile(r"^/opt/unetlab/tmp/\d+/\d+/monitor\.sock$")
RE_RUNPATH = re.compile(r"^/opt/unetlab/tmp/\d+/\d+$")

# Network Watcher (linkwatch_*): per-link BPF traffic counters for the lab UI
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
        return "(%s) or (%s)" % (p["v4"], p["v6"])
    expr = p["l4"]
    if not expr:
        return ""
    if ver == "4":
        return "ip and (%s)" % expr
    if ver == "6":
        return "ip6 and (%s)" % expr
    return expr


def log(msg):
    print(msg, file=sys.stderr, flush=True)


class Reject(Exception):
    pass


# ---- argument validators ---------------------------------------------------

def v_int(args, key):
    v = args.get(key)
    if isinstance(v, bool) or not (isinstance(v, int) or
                                   (isinstance(v, str) and v.isdigit())):
        raise Reject("bad arg %s" % key)
    n = int(v)
    if n < 0 or n > 2**31:
        raise Reject("bad arg %s" % key)
    return n


def v_enum(args, key, allowed):
    v = args.get(key)
    if v not in allowed:
        raise Reject("bad arg %s" % key)
    return v


def v_re(args, key, rx):
    v = args.get(key)
    if not isinstance(v, str) or not rx.match(v):
        raise Reject("bad arg %s" % key)
    return v


def v_ip(args, key):
    v = args.get(key)
    try:
        ipaddress.IPv4Address(v)
    except Exception:
        raise Reject("bad arg %s" % key)
    return v


def v_ip_any(args, key, version=None):
    """Validate an IP argument and optionally require IPv4 or IPv6 by version.

    Return the canonical spelling so the generated expression has no room for
    pcap parser ambiguity (notably around IPv6 compressed/expanded forms).
    """
    v = args.get(key)
    if not isinstance(v, str) or not v or "%" in v:
        raise Reject("bad arg %s" % key)
    try:
        ip = ipaddress.ip_address(v)
    except Exception:
        raise Reject("bad arg %s" % key)
    if version == "4" and ip.version != 4:
        raise Reject("bad arg %s" % key)
    if version == "6" and ip.version != 6:
        raise Reject("bad arg %s" % key)
    return ip.compressed


def _lw_ip_host_term(f, key, direction, version):
    """Build a family-qualified pcap host term from a validated address."""
    address = v_ip_any(f, key, version)
    ip = ipaddress.ip_address(address)
    family = "ip6" if ip.version == 6 else "ip"
    return ip.version, "%s %s host %s" % (family, direction, address)


def v_ip_list(args, key):
    """Comma-separated list of IPv4 addresses (primary + failover RADIUS servers).
    Returns the normalized "ip,ip,..." string. Blank entries are dropped; at least
    one valid address is required (callers gate on a non-empty raw value)."""
    v = args.get(key)
    if not isinstance(v, str):
        raise Reject("bad arg %s" % key)
    out = []
    for part in v.split(","):
        part = part.strip()
        if part == "":
            continue
        try:
            ipaddress.IPv4Address(part)
        except Exception:
            raise Reject("bad arg %s" % key)
        out.append(part)
    if not out:
        raise Reject("bad arg %s" % key)
    return ",".join(out)


def v_list(args, key, maxlen):
    v = args.get(key)
    if not isinstance(v, list) or len(v) == 0 or len(v) > maxlen:
        raise Reject("bad arg %s" % key)
    return v


def v_vlan_list(args, key):
    """dot1q trunk allowed-VLAN list. Accepts a string of comma-separated VIDs
    and `a-b` ranges (e.g. "10,20,30-39"); returns a sorted list of ints, each
    1-4094, capped at 256 distinct VIDs. Empty/absent -> []."""
    v = args.get(key)
    if v is None or v == "":
        return []
    if not isinstance(v, str):
        raise Reject("bad arg %s" % key)
    vids = set()
    for tok in v.split(","):
        tok = tok.strip()
        if not tok:
            continue
        if "-" in tok:
            lo, _, hi = tok.partition("-")
            if not (lo.isdigit() and hi.isdigit()):
                raise Reject("bad arg %s" % key)
            lo, hi = int(lo), int(hi)
            if lo < 1 or hi > 4094 or lo > hi or hi - lo > 4094:
                raise Reject("arg %s out of range" % key)
            vids.update(range(lo, hi + 1))
        else:
            if not tok.isdigit():
                raise Reject("bad arg %s" % key)
            n = int(tok)
            if n < 1 or n > 4094:
                raise Reject("arg %s out of range" % key)
            vids.add(n)
        if len(vids) > 256:
            raise Reject("arg %s too many vlans" % key)
    return sorted(vids)


def v_path_under(args, key, root):
    v = args.get(key)
    if not isinstance(v, str) or "\x00" in v:
        raise Reject("bad arg %s" % key)
    real = os.path.realpath(v)
    if not (real + "/").startswith(root.rstrip("/") + "/"):
        raise Reject("arg %s escapes %s" % (key, root))
    return real


def v_path_under_any(args, key, roots):
    """Resolve a root-owned payload path against one of a fixed set of jails.

    Satellite sync normally reads /opt/unetlab/data/satellite.  Older masters
    staged only the satellite deb there while retaining the matching optional
    bridge deb in the atomically published bundle (or the verified rollback
    cache), so the bridge source has a small, explicit read-only fallback set.
    Never accept a caller-provided arbitrary path merely because it is readable
    by root: each candidate is still realpath-normalized and jailed here.
    """
    v = args.get(key)
    if not isinstance(v, str) or "\x00" in v:
        raise Reject("bad arg %s" % key)
    real = os.path.realpath(v)
    for root in roots:
        root_real = os.path.realpath(root).rstrip("/")
        if (real + "/").startswith(root_real + "/"):
            return real
    raise Reject("arg %s is outside the trusted satellite payload roots" % key)


def v_bool(args, key):
    """Loose truthy coercion for checkbox-origin flags -> 0/1."""
    return 1 if args.get(key) in (1, "1", True, "true", "yes", "on") else 0


def v_cidr(args, key):
    """IPv4 interface address WITH prefix, e.g. "10.0.0.1/24". Returns the
    normalized "ip/prefix" string. Rejects a bare address (no mask) or a bad
    octet/prefix. Backs the soft-router gateway/uplink fields."""
    v = args.get(key)
    if not isinstance(v, str) or "/" not in v:
        raise Reject("bad arg %s" % key)
    try:
        iface = ipaddress.IPv4Interface(v)
    except Exception:
        raise Reject("bad arg %s" % key)
    return "%s/%d" % (iface.ip, iface.network.prefixlen)


def v_route_list(args, key, maxlen=64):
    """Soft-router static routes: a list of {"dst": "<cidr>|default",
    "gw": "<ipv4>"}. Returns [(dst, gw)] with dst normalized to "net/prefix"
    ("0.0.0.0/0" for default). Empty/absent -> []. Every field validated
    through ipaddress before it can reach an `ip route` argv."""
    v = args.get(key)
    if v is None or v == "":
        return []
    if not isinstance(v, list):
        raise Reject("bad arg %s" % key)
    if len(v) > maxlen:
        raise Reject("arg %s too many routes" % key)
    out = []
    for r in v:
        if not isinstance(r, dict):
            raise Reject("bad arg %s" % key)
        dst, gw = r.get("dst"), r.get("gw")
        if dst in ("default", "0.0.0.0/0", "0/0"):
            dstn = "0.0.0.0/0"
        else:
            try:
                dstn = str(ipaddress.IPv4Network(dst, strict=False))
            except Exception:
                raise Reject("arg %s bad dst" % key)
        try:
            ipaddress.IPv4Address(gw)
        except Exception:
            raise Reject("arg %s bad gw" % key)
        out.append((dstn, gw))
    return out


# ---- exec helpers ----------------------------------------------------------

def run(argv, timeout=60, stderr=None, check_rc=True):
    """Run argv (no shell). Returns (rc, out_lines, err_text)."""
    p = subprocess.run(argv, stdout=subprocess.PIPE,
                       stderr=stderr if stderr is not None else subprocess.PIPE,
                       timeout=timeout)
    out = p.stdout.decode("utf-8", "replace").splitlines()
    err = "" if stderr is not None else p.stderr.decode("utf-8", "replace")
    return p.returncode, out, err


def run_quiet(argv, timeout=60):
    """Best-effort step in a sequence: never raises on rc != 0."""
    try:
        return run(argv, timeout=timeout)[0]
    except subprocess.TimeoutExpired:
        return 124


def spawn_unit(unit, argv, props=(), setenv=()):
    """B5: detach a root worker as a transient systemd unit instead of a bare
    setsid child — journald log per job, systemctl visibility, --collect
    auto-cleanup (even on failure), kill-able via worker_kill.
    setenv: list of "K=V" passed as --setenv. A transient unit does NOT inherit
    brokerd's environment, so anything depending on e.g. HOME must be set here."""
    cmd = ["systemd-run", "--collect", "--unit", unit]
    for p in props:
        cmd += ["--property", p]
    for e in setenv:
        cmd += ["--setenv", e]
    cmd += argv
    rc, out, err = run(cmd, timeout=30)
    if rc != 0:
        raise Reject("systemd-run failed: %s" % (err.strip() or rc))
    return unit


def _require_root_script(path):
    """Refuse to root-EXEC a script that a www-data foothold could have authored:
    it must be a regular file, owned by root, and not group/other-writable. Fails
    CLOSED (the PHP client surfaces the Reject) — used before every root exec of a
    shell/keygen script the engine hands us. Since the shipped copies live under a
    root-owned dir www-data cannot write, this passes for legitimate scripts and
    only trips if one has been tampered with."""
    if not os.path.isfile(path):
        raise Reject("script missing: %s" % os.path.basename(path))
    st = os.stat(path)
    if st.st_uid != 0 or (st.st_mode & 0o022):
        raise Reject("refusing to exec non-root-owned or writable script: %s"
                     % os.path.basename(path))
    return path


def _write_cpu_policy(enabled):
    """Atomically persist the appliance-wide QEMU capping policy."""
    os.makedirs(BASE, mode=0o755, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".cpulimit.", dir=BASE, text=True)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "w", encoding="ascii") as f:
            f.write("1\n" if enabled else "0\n")
        os.replace(tmp, CPU_POLICY_FILE)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _cpu_policy_enabled():
    """Read the durable policy flag; an absent legacy flag defaults to on."""
    try:
        with open(CPU_POLICY_FILE, "r", encoding="ascii") as f:
            value = f.read().strip()
    except FileNotFoundError:
        # Source-only hot deploys can precede postinst.  Materialize the
        # legacy-default policy here so subsequent status reads see a flag.
        _write_cpu_policy(True)
        return True
    except OSError as e:
        raise Reject("cannot read CPU policy: %s" % e)
    if value not in ("0", "1"):
        raise Reject("invalid CPU policy flag")
    return value == "1"


def _qemu_scope_unit(session):
    return "pnetlab-qemu-%d.scope" % session


def _qemu_scope_metadata_path(session):
    return os.path.join(CPU_SCOPE_STATE_DIR, "%d.json" % session)


def _write_qemu_scope_metadata(session, smp, pid, starttime,
                               quota_requested):
    os.makedirs(CPU_SCOPE_STATE_DIR, mode=0o755, exist_ok=True)
    path = _qemu_scope_metadata_path(session)
    fd, tmp = tempfile.mkstemp(prefix=".%d." % session,
                                suffix=".tmp", dir=CPU_SCOPE_STATE_DIR,
                                text=True)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as f:
            json.dump({"session": session, "smp": smp, "pid": pid,
                       "starttime": starttime,
                       "quota_requested": bool(quota_requested)},
                      f, sort_keys=True)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_qemu_scope_smp(session):
    try:
        with open(_qemu_scope_metadata_path(session), "r", encoding="ascii") as f:
            data = json.load(f)
    except (OSError, ValueError):
        raise Reject("missing CPU metadata for QEMU session %d" % session)
    if (not isinstance(data, dict) or data.get("session") != session or
            isinstance(data.get("smp"), bool) or
            not isinstance(data.get("smp"), int) or
            not 1 <= data["smp"] <= 1024):
        raise Reject("invalid CPU metadata for QEMU session %d" % session)
    return data["smp"]


def _read_qemu_scope_quota_requested(session):
    """Return the start-time checkbox state recorded for a live scope.

    Scopes created by the old implementation have no metadata and were only
    created for opted-in QEMU nodes, so treat those migration scopes as opted
    in.  New scopes always carry the explicit boolean from DeviceQemu.
    """
    try:
        with open(_qemu_scope_metadata_path(session), "r", encoding="ascii") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return True
    value = data.get("quota_requested") if isinstance(data, dict) else None
    if value is None:
        return True
    if not isinstance(value, bool):
        raise Reject("invalid quota metadata for QEMU session %d" % session)
    return value


def _read_migrated_qemu_smp(pid, session):
    """Recover smp only for a pre-policy migration scope.

    Normal node starts pass the authoritative DeviceQemu value directly and
    never use this path.  A live guest upgraded from the old shared cgroup has
    no metadata, so this bounded read of the exact argv emitted by QEMU is the
    only way for a later explicit global enable to satisfy the retained-toggle
    contract without guessing a quota.  It is not a ps scrape or a start-path
    classifier.
    """
    ok, _ = _qemu_identity(pid, session)
    if not ok:
        raise Reject("QEMU identity changed for session %d" % session)
    try:
        args = _proc_cmdline(pid)
    except OSError:
        raise Reject("cannot read QEMU argv for session %d" % session)
    values = []
    for index, arg in enumerate(args):
        if arg == b"-smp" and index + 1 < len(args):
            value = args[index + 1]
        elif arg.startswith(b"-smp"):
            value = arg[5:].lstrip(b"=")
        else:
            continue
        match = re.search(rb"(?:^|,)cpus=([0-9]+)(?:,|$)", value)
        if not match and value.isdigit():
            match = re.match(rb"([0-9]+)$", value)
        if match:
            values.append(int(match.group(1)))
    if len(values) != 1 or not 1 <= values[0] <= 1024:
        raise Reject("cannot recover authoritative smp for session %d" % session)
    return values[0]


def _proc_cmdline(pid):
    with open("/proc/%d/cmdline" % pid, "rb") as f:
        return [part for part in f.read().split(b"\0") if part]


def _proc_starttime(pid):
    with open("/proc/%d/stat" % pid, "r", encoding="ascii") as f:
        stat = f.read()
    end = stat.rfind(")")
    if end < 0:
        raise OSError("malformed /proc stat")
    fields = stat[end + 2:].split()
    # fields[0] is field 3 (state), so field 22 (starttime) is index 19.
    if len(fields) <= 19:
        raise OSError("short /proc stat")
    return fields[19]


def _qemu_identity(pid, session):
    """Return (is_exact_qemu, starttime) without using ps or a shell."""
    try:
        exe = os.path.basename(os.readlink("/proc/%d/exe" % pid))
        if not exe.startswith("qemu-system-"):
            return False, None
        args = _proc_cmdline(pid)
        nic_token = ("ifname=vunl%d_" % session).encode("ascii")
        runtime_token = re.compile(
            rb"/opt/unetlab/tmp/[0-9]+/%d/" % session)
        # NIC-less QEMU nodes have no ifname= argument.  Every QEMU still has
        # the monitor/socket paths under its session-specific runtime path.
        if not any(nic_token in arg or runtime_token.search(arg)
                   for arg in args):
            return False, None
        return True, _proc_starttime(pid)
    except (FileNotFoundError, PermissionError, OSError):
        return False, None


def _discover_qemu(session):
    """Find exactly one live QEMU for a node session within two seconds."""
    deadline = time.monotonic() + CPU_SCOPE_DISCOVERY_SECONDS
    while True:
        matches = []
        try:
            proc_names = os.listdir("/proc")
        except OSError as e:
            raise Reject("cannot enumerate /proc: %s" % e)
        for name in proc_names:
            if not name.isdigit():
                continue
            pid = int(name)
            ok, starttime = _qemu_identity(pid, session)
            if ok:
                matches.append((pid, starttime))
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise Reject("multiple QEMU processes match session %d" % session)
        if time.monotonic() >= deadline:
            raise Reject("QEMU process not found for session %d" % session)
        time.sleep(0.05)


def _scope_cgroup_path(unit):
    if not re.fullmatch(r"pnetlab-qemu-[0-9]+\.scope", unit):
        raise Reject("bad QEMU scope unit")
    return os.path.join(CPU_SCOPE_ROOT, unit)


def _proc_cgroup_path(pid):
    with open("/proc/%d/cgroup" % pid, "r", encoding="ascii") as f:
        for line in f:
            fields = line.rstrip("\n").split(":", 2)
            if len(fields) == 3 and fields[0] == "0":
                return fields[2]
    raise OSError("unified cgroup entry missing")


def _read_scope_value(path, name):
    with open(os.path.join(path, name), "r", encoding="ascii") as f:
        return f.read().strip()


def _verify_qemu_scope(pid, session, unit, starttime, cpu_max, weight):
    """Verify PID identity, cgroup membership, and exact controller values."""
    deadline = time.monotonic() + CPU_SCOPE_VERIFY_SECONDS
    expected_path = "/pnetlab.slice/" + unit
    path = _scope_cgroup_path(unit)
    while True:
        ok, current_starttime = _qemu_identity(pid, session)
        try:
            proc_cgroup = _proc_cgroup_path(pid)
            current_max = _read_scope_value(path, "cpu.max")
            current_weight = _read_scope_value(path, "cpu.weight")
            with open(os.path.join(path, "cgroup.procs"), "r",
                      encoding="ascii") as f:
                members = {int(v) for v in f.read().split() if v.isdigit()}
        except (FileNotFoundError, PermissionError, OSError, ValueError):
            ok = False
            proc_cgroup = ""
            current_max = ""
            current_weight = ""
            members = set()
        if (ok and current_starttime == starttime and
                proc_cgroup == expected_path and pid in members and
                current_max == cpu_max and current_weight == weight):
            return path
        if time.monotonic() >= deadline:
            raise Reject("QEMU scope read-back mismatch for session %d" % session)
        time.sleep(0.05)


def _qemu_quota_percent(smp):
    return CPU_QUOTA_PER_VCPU_PERCENT * smp + CPU_QUOTA_HEADROOM_PERCENT


def _qemu_quota_cpu_max(smp):
    # systemd's per-second quota is expressed in microseconds.  With the
    # fixed 100 ms period, the resulting cpu.max quota is percent * 1000.
    return "%d %d" % (_qemu_quota_percent(smp) * 1000, CPU_PERIOD_US)


def _qemu_quota_us(smp):
    return _qemu_quota_percent(smp) * 10000


def _qemu_quota_timer_unit(session):
    return "pnetlab-qemu-%d-quota.timer" % session


def _set_pnetlab_slice_weight():
    rc, out, err = run([
        "systemctl", "set-property", "--runtime", "pnetlab.slice",
        "CPUWeight=%d" % CPU_WEIGHT,
    ], timeout=30, check_rc=False)
    if rc != 0:
        raise Reject("set-property failed for pnetlab.slice: %s" %
                     (err.strip() or rc))
    if _read_scope_value(CPU_SCOPE_ROOT, "cpu.weight") != str(CPU_WEIGHT):
        raise Reject("pnetlab.slice CPUWeight read-back mismatch")


def _run_qemu_scope(unit, pid, session, smp):
    """Adopt an existing QEMU through systemd's StartTransientUnit D-Bus API."""
    argv = [
        "busctl", "call", "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager", "StartTransientUnit",
        "ssa(sv)a(sa(sv))", unit, "fail", "6",
        "PIDs", "au", "1", str(pid),
        "Slice", "s", "pnetlab.slice",
        "CPUQuotaPerSecUSec", "t", str(CPU_QUOTA_INFINITY_US),
        "CPUQuotaPeriodUSec", "t", str(CPU_PERIOD_US),
        "CPUWeight", "t", str(CPU_WEIGHT),
        "CollectMode", "s", "inactive-or-failed",
        "0",
    ]
    rc, out, err = run(argv, timeout=30, check_rc=False)
    if rc != 0:
        raise Reject("StartTransientUnit failed: %s" % (err.strip() or rc))


def _cancel_qemu_quota_timer(session):
    """Cancel a pending grace timer; an absent collected unit is harmless."""
    timer = _qemu_quota_timer_unit(session)
    rc, out, err = run(["systemctl", "stop", timer], timeout=30,
                       check_rc=False)
    if rc not in (0, 5):
        log("WARNING qemu_cpu_scope session=%d timer stop failed: %s" %
            (session, err.strip() or rc))


def _arm_qemu_quota_timer(session, unit, smp):
    """Apply the steady-state quota once the per-node boot grace expires."""
    timer = _qemu_quota_timer_unit(session)
    _cancel_qemu_quota_timer(session)
    quota = "%d%%" % _qemu_quota_percent(smp)
    rc, out, err = run([
        "systemd-run", "--quiet", "--collect", "--on-active=%ds" %
        CPU_GRACE_SECONDS, "--unit=" + timer,
        "/usr/bin/systemctl", "set-property", "--runtime", unit,
        "CPUQuota=" + quota,
        "CPUQuotaPeriodSec=100ms",
        "CPUWeight=%d" % CPU_WEIGHT,
    ], timeout=30, check_rc=False)
    if rc != 0:
        raise Reject("quota grace timer failed: %s" % (err.strip() or rc))
    return timer


def _qemu_scope_warning(session, unit, reason):
    message = ("QEMU CPU scope unavailable; node continues uncapped "
               "(weight-only if attach completed): %s" % reason)
    log("WARNING qemu_cpu_scope session=%d unit=%s %s" %
        (session, unit, message))
    return {
        "code": "qemu_cpu_scope_attach_failed",
        "session": session,
        "unit": unit,
        "policy": "uncapped",
        "message": message,
    }


def verb_qemu_cpu_scope(args):
    """Attach every QEMU to a weighted scope; cap exact-1 nodes after grace."""
    session = v_int(args, "session")
    smp = v_int(args, "smp")
    quota_raw = args.get("quota")
    if quota_raw not in (0, 1, False, True, "0", "1"):
        raise Reject("bad arg quota")
    quota_requested = quota_raw in (1, True, "1")
    if not 1 <= session <= 2**31 or not 1 <= smp <= 1024:
        raise Reject("session/smp out of bounds")
    unit = _qemu_scope_unit(session)
    with CPU_POLICY_LOCK:
        warnings = []
        try:
            policy_enabled = _cpu_policy_enabled()
        except Exception as e:
            policy_enabled = False
            warnings.append(_qemu_scope_warning(session, unit,
                                                "cannot read global policy: %s" % e))
        try:
            pid, starttime = _discover_qemu(session)
            _run_qemu_scope(unit, pid, session, smp)
            _set_pnetlab_slice_weight()
            _verify_qemu_scope(pid, session, unit, starttime,
                               "max %d" % CPU_PERIOD_US,
                               str(CPU_WEIGHT))
            _write_qemu_scope_metadata(session, smp, pid, starttime,
                                       quota_requested)
            if quota_requested and policy_enabled:
                try:
                    timer = _arm_qemu_quota_timer(session, unit, smp)
                    log("qemu_cpu_scope session=%d pid=%d smp=%d "
                        "weight=%d quota=%d%% grace=%ds timer=%s" %
                        (session, pid, smp, CPU_WEIGHT,
                         _qemu_quota_percent(smp), CPU_GRACE_SECONDS, timer))
                except Exception as e:
                    warnings.append(_qemu_scope_warning(
                        session, unit, "quota grace could not be armed: %s" % e))
            else:
                log("qemu_cpu_scope session=%d pid=%d smp=%d weight=%d "
                    "quota=none" % (session, pid, smp, CPU_WEIGHT))
        except Exception as e:
            warnings.append(_qemu_scope_warning(session, unit, str(e)))
        if warnings:
            return 0, [unit], "", warnings
        return 0, [unit], ""


def _iter_qemu_scope_units():
    try:
        names = os.listdir(CPU_SCOPE_ROOT)
    except FileNotFoundError:
        return []
    except OSError as e:
        raise Reject("cannot enumerate QEMU scopes: %s" % e)
    return sorted(name for name in names
                  if re.fullmatch(r"pnetlab-qemu-[0-9]+\.scope", name))


def _scope_qemu_pid(unit, session):
    path = _scope_cgroup_path(unit)
    try:
        with open(os.path.join(path, "cgroup.procs"), "r",
                  encoding="ascii") as f:
            pids = [int(v) for v in f.read().split() if v.isdigit()]
    except (FileNotFoundError, PermissionError, OSError, ValueError):
        return None
    matches = []
    for pid in pids:
        ok, starttime = _qemu_identity(pid, session)
        if ok:
            matches.append((pid, starttime))
    if len(matches) > 1:
        raise Reject("multiple QEMU processes in %s" % unit)
    return matches[0] if matches else None


def _set_qemu_scope_policy(unit, session, smp, enabled, pid, starttime):
    quota = "%d%%" % _qemu_quota_percent(smp) if enabled else "infinity"
    rc, out, err = run([
        "systemctl", "set-property", "--runtime", unit,
        "CPUQuota=" + quota,
        "CPUQuotaPeriodSec=100ms",
        "CPUWeight=%d" % CPU_WEIGHT,
    ], timeout=30, check_rc=False)
    if rc != 0:
        raise Reject("set-property failed for %s: %s" %
                     (unit, err.strip() or rc))
    cpu_max = _qemu_quota_cpu_max(smp) if enabled \
        else "max %d" % CPU_PERIOD_US
    _verify_qemu_scope(pid, session, unit, starttime, cpu_max,
                       str(CPU_WEIGHT))


def verb_qemu_cpu_policy(args):
    """Persist the global flag and reapply it to live policy-created scopes."""
    raw = args.get("enabled")
    if raw not in (0, 1, False, True, "0", "1"):
        raise Reject("bad arg enabled")
    enabled = raw in (1, True, "1")
    with CPU_POLICY_LOCK:
        units = _iter_qemu_scope_units()
        targets = []
        for unit in units:
            session = int(re.fullmatch(r"pnetlab-qemu-([0-9]+)\.scope",
                                       unit).group(1))
            target = _scope_qemu_pid(unit, session)
            if target is None:
                continue  # a collected scope can disappear during enumeration
            pid, starttime = target
            quota_requested = _read_qemu_scope_quota_requested(session)
            if enabled and quota_requested:
                try:
                    smp = _read_qemu_scope_smp(session)
                except Reject as metadata_error:
                    # Upgrade-migrated guests predate broker metadata.  Recover
                    # only their already-emitted -smp value, with no default cap.
                    smp = _read_migrated_qemu_smp(pid, session)
                    log("qemu_cpu_policy: %s; recovered smp=%d from live "
                        "migration scope" % (metadata_error, smp))
            else:
                smp = 1
            targets.append((unit, session, smp, pid, starttime,
                            quota_requested))
        # Validate every live scope before publishing the new policy.  The lock
        # closes the enumerate/reapply/publish race with a concurrent attach.
        for unit, session, smp, pid, starttime, quota_requested in targets:
            apply_quota = enabled and quota_requested
            _cancel_qemu_quota_timer(session)
            _set_qemu_scope_policy(unit, session, smp, apply_quota,
                                   pid, starttime)
        _write_cpu_policy(enabled)
    log("qemu_cpu_policy enabled=%s scopes=%d" % (enabled, len(targets)))
    return 0, ["enabled" if enabled else "disabled"], ""


def verb_qemu_cpu_policy_status(args):
    """Return the durable global policy, materializing the enabled default."""
    return 0, ["enabled" if _cpu_policy_enabled() else "disabled"], ""


def link_exists(name):
    return run_quiet(["ip", "link", "show", name]) == 0


def mac(lab_session, node_id, interface_id, last):
    # byte-for-byte the PHP sprintf('%02x', ...) scheme from functions.php
    return "48:%02x:%02x:%02x:%02x:%02x" % (
        lab_session, int(node_id / 512), node_id % 512, interface_id, last)


# ---- verbs -----------------------------------------------------------------

def verb_ping(args):
    return 0, ["pong"], ""


def verb_wrapper(args):
    action = args.get("action")
    argv = [UNL_WRAPPER, "-a"]
    if action == "ipv6":
        # store System page toggle: unl_wrapper -a ipv6 -i 0|1
        argv += ["ipv6", "-i", str(v_enum(args, "i", {0, 1, "0", "1"}))]
    elif action in WRAPPER_LAB_ACTIONS:
        argv += [action,
                 "-T", str(v_int(args, "tenant")),
                 "-S", str(v_int(args, "session"))]
        if args.get("node") is not None:
            argv += ["-D", str(v_int(args, "node"))]
        lab = v_path_under(args, "lab", LABS_DIR)
        if not lab.endswith(".unl"):
            raise Reject("lab must be a .unl file")
        argv += ["-F", lab]
    elif action in WRAPPER_BARE_ACTIONS:
        argv += [action]
    else:
        raise Reject("bad action")
    os.makedirs(os.path.dirname(WRAPPER_LOG), exist_ok=True)
    with open(WRAPPER_LOG, "ab") as logf:
        rc, out, err = run(argv, timeout=600, stderr=logf)
    return rc, out, err


def verb_worker_import(args):
    job = v_re(args, "job", RE_JOB)
    script = _require_root_script(WORKERS_DIR + "/import.sh")
    unit = spawn_unit(
        "pnet-import-" + job,
        ["/bin/bash", script, job],
        props=("MemoryMax=4G", "IOWeight=50"))
    return 0, ["unit " + unit], ""


def verb_worker_ishare2(args):
    typ = v_enum(args, "type", {"qemu", "iol", "dynamips"})
    nid = v_int(args, "id")
    job = v_re(args, "job", RE_JOB)
    op = v_enum(args, "op", {"download", "delete"})
    script = _require_root_script(WORKERS_DIR + "/ishare2.sh")
    unit = spawn_unit(
        "pnet-ishare2-" + job,
        ["/bin/bash", script, typ, str(nid), job, op],
        props=("MemoryMax=4G", "IOWeight=50"))
    return 0, ["unit " + unit], ""


def verb_worker_sdwan(args):
    # Catalyst SD-WAN control-plane onboarder (html/sdwan/worker.sh). Lightweight
    # (requests + cryptography), so a modest memory cap; it polls vManage for up to
    # an hour while the control plane boots, hence no short timeout here.
    job = v_re(args, "job", RE_JOB)
    script = _require_root_script(WORKERS_DIR + "/sdwan.sh")
    unit = spawn_unit(
        "pnet-sdwan-" + job,
        ["/bin/bash", script, job],
        props=("MemoryMax=512M",))
    return 0, ["unit " + unit], ""


def verb_worker_kill(args):
    kind = v_enum(args, "kind", {"import", "ishare2", "sdwan"})
    job = v_re(args, "job", RE_JOB)
    rc, out, err = run(
        ["systemctl", "stop", "pnet-%s-%s.service" % (kind, job)], timeout=30)
    return rc, out, err


def verb_nodestats(args):
    return run(["/bin/bash", BASE + "/html/pnq-nodestats.sh"], timeout=30)


def verb_system_uuid(args):
    return run(["dmidecode", "--string", "system-uuid"], timeout=30)


def _uid_of(args):
    t = v_int(args, "tenant")
    l = v_int(args, "lab_session")
    n = v_int(args, "node_session")
    i = v_int(args, "interface_id")
    return t, l, n, i, "%d_%d_%d_%d" % (t, l, n, i)


def verb_winbox_rdp_attach(args):
    _, lab_session, _, _, uid = _uid_of(args)
    node_id = v_int(args, "node_id")
    iface = v_int(args, "interface_id")
    pid = str(v_int(args, "pid"))
    ip = v_ip(args, "ip")
    if not link_exists("rdp" + uid):
        run_quiet(["ip", "link", "add", "rdp" + uid,
                   "type", "veth", "peer", "name", "dc0" + uid])
        run_quiet(["ip", "link", "set", "dev", "rdp" + uid, "up"])
        run_quiet(["ip", "link", "set", "dev", "dc0" + uid, "up"])
        run_quiet(["ip", "link", "set", "netns", pid, "dc0" + uid,
                   "name", "eth1", "address",
                   mac(lab_session, node_id, iface, 1), "up"])
        run_quiet(["brctl", "addif", "docker0", "rdp" + uid])
        run_quiet([NSENTER, "-t", pid, "-n",
                   "ip", "addr", "add", ip + "/16", "dev", "eth1"])
        run_quiet([NSENTER, "-t", pid, "-n",
                   "ip", "route", "add", "default", "via", ip])
        run_quiet([NSENTER, "-t", pid, "-n", "ip", "link", "delete", "eth0"])
    return 0, [], ""


def verb_winbox_span_attach(args):
    _, lab_session, _, _, uid = _uid_of(args)
    node_id = v_int(args, "node_id")
    iface = v_int(args, "interface_id")
    pid = str(v_int(args, "pid"))
    net = v_re(args, "net", RE_NET)
    if not link_exists("span" + uid):
        run_quiet(["ip", "link", "add", "span" + uid,
                   "type", "veth", "peer", "name", "cap" + uid])
        run_quiet(["ip", "link", "set", "dev", "span" + uid, "up"])
        run_quiet(["ip", "link", "set", "dev", "span" + uid, "mtu", "9000"])
        run_quiet(["ip", "link", "set", "dev", "cap" + uid, "up"])
        run_quiet(["ip", "link", "set", "dev", "cap" + uid, "mtu", "9000"])
        run_quiet(["ip", "link", "set", "netns", pid, "cap" + uid,
                   "name", "eth0", "address",
                   mac(lab_session, node_id, iface, 0), "up"])
        run_quiet(["brctl", "addif", net, "span" + uid])
        run_quiet(["brctl", "setageing", net, "0"])
    return 0, [], ""


def verb_capture_links_del(args):
    uid = _uid_of(args)[4]
    run_quiet(["ip", "link", "del", "rdp" + uid])
    run_quiet(["ip", "link", "del", "cap" + uid])
    return 0, [], ""


def verb_capture_rdp_attach(args):
    uid = _uid_of(args)[4]
    pid = str(v_int(args, "pid"))
    ip = v_ip(args, "ip")
    if not link_exists("rdp" + uid):
        run_quiet(["ip", "link", "add", "rdp" + uid,
                   "type", "veth", "peer", "name", "dc0" + uid])
        run_quiet(["ip", "link", "set", "dev", "rdp" + uid, "up"])
        run_quiet(["ip", "link", "set", "dev", "dc0" + uid, "up"])
        run_quiet(["ip", "link", "set", "netns", pid, "dc0" + uid,
                   "name", "eth1", "up"])
        run_quiet(["brctl", "addif", "docker0", "rdp" + uid])
        run_quiet([NSENTER, "-t", pid, "-n",
                   "ip", "addr", "add", ip + "/16", "dev", "eth1"])
        run_quiet([NSENTER, "-t", pid, "-n", "ip", "link", "set", "eth1", "up"])
    return 0, [], ""


def verb_capture_mirror_attach(args):
    uid = _uid_of(args)[4]
    pid = str(v_int(args, "pid"))
    tap = v_re(args, "tap", RE_TAP)
    target = "cap" + uid
    with TC_LOCK:
        states = {direction: _capture_filter_state(tap, direction, target)
                  for direction in CAPTURE_FILTERS}
        if "foreign" in states.values():
            raise Reject("capture filter ownership conflict on " + tap)
        # Deleting the capture veth first can leave tc's otherwise exact
        # reserved mirror filter reporting to_dev="*".  Converge only that
        # narrowly recognized orphan before recreating its target.
        for direction in CAPTURE_FILTERS:
            if states[direction] == "owned_orphan":
                _capture_filter_delete_exact(tap, direction)
                states[direction] = "absent"
        created_link = False
        created_clsact = False
        created_filters = []
        try:
            if not link_exists(target):
                _tc_step(["ip", "link", "add", target, "type", "veth",
                          "peer", "name", "dcap" + uid])
                created_link = True
                _tc_step(["ip", "link", "set", "dev", target, "up"])
                _tc_step(["ip", "link", "set", "dev", target, "mtu", "9000"])
                _tc_step(["ip", "link", "set", "dev", "dcap" + uid, "up"])
                _tc_step(["ip", "link", "set", "dev", "dcap" + uid,
                          "mtu", "9000"])
                _tc_step(["ip", "link", "set", "netns", pid, "dcap" + uid,
                          "name", "eth0", "up"])
            if not _tc_has_clsact(tap):
                _tc_step(["tc", "qdisc", "add", "dev", tap, "clsact"])
                created_clsact = True
                if not _tc_has_clsact(tap):
                    raise Reject("tc clsact verification failed on " + tap)
            for direction in ("ingress", "egress"):
                if states[direction] == "owned":
                    continue
                pref, handle = CAPTURE_FILTERS[direction]
                _tc_step(["tc", "filter", "add", "dev", tap, direction,
                          "protocol", "all", "pref", str(pref), "handle", handle,
                          "matchall", "action", "mirred", "egress", "mirror",
                          "dev", target])
                created_filters.append(direction)
                if _capture_filter_state(tap, direction, target) != "owned":
                    raise Reject("tc capture filter verification failed on " + tap)
            return 0, [], ""
        except Exception as setup_error:
            cleanup_errors = []
            for direction in reversed(created_filters):
                try:
                    # The add command succeeded in this invocation, so this
                    # exact reserved identifier is ours even if verification
                    # failed because tc returned an unexpected representation.
                    _capture_filter_delete_exact(tap, direction)
                except Exception as e:
                    cleanup_errors.append(str(e))
            if created_clsact:
                try:
                    if _tc_clsact_empty(tap):
                        if run_quiet(["tc", "qdisc", "del", "dev", tap,
                                      "clsact"]) != 0:
                            cleanup_errors.append("clsact cleanup failed")
                except Exception as e:
                    cleanup_errors.append(str(e))
            if created_link:
                if run_quiet(["ip", "link", "del", target]) != 0:
                    cleanup_errors.append("capture veth cleanup failed")
            if cleanup_errors:
                raise Reject("capture setup failed and cleanup failed: " +
                             "; ".join(cleanup_errors)) from setup_error
            raise


def verb_capture_teardown(args):
    uid = _uid_of(args)[4]
    target = "cap" + uid
    with TC_LOCK:
        cleanup_errors = []
        if args.get("tap") is not None:
            tap = v_re(args, "tap", RE_TAP)
            if link_exists(tap):
                states = {direction: _capture_filter_state(tap, direction, target)
                          for direction in CAPTURE_FILTERS}
                if "foreign" in states.values():
                    # Do not strand a foreign mirror action pointing at a deleted
                    # device merely because it occupies PNetLab's reserved pref.
                    raise Reject("capture filter ownership conflict on " + tap)
                for direction in CAPTURE_FILTERS:
                    try:
                        if states[direction] in ("owned", "owned_orphan"):
                            _capture_filter_delete_exact(tap, direction)
                    except Exception as e:
                        cleanup_errors.append(str(e))
                if cleanup_errors:
                    # Keep mirror targets present if any filter remains;
                    # deleting them would create a new to_dev="*" orphan.
                    raise Reject("; ".join(cleanup_errors))
            # A missing tap implies its attached filters are already gone; cap
            # and management veth cleanup must still proceed independently.
        for link in ("rdp" + uid, target):
            if link_exists(link) and run_quiet(["ip", "link", "del", link]) != 0:
                cleanup_errors.append("capture veth cleanup failed: " + link)
        # Deliberately retain clsact even when our filters were the last ones.
        # Once teardown begins we cannot prove no external owner is about to use
        # the shared qdisc, while an empty clsact is harmless and non-root.
        if cleanup_errors:
            raise Reject("; ".join(cleanup_errors))
    return 0, [], ""


def verb_capture_if_del(args):
    t = v_int(args, "tenant")
    l = v_int(args, "lab_session")
    idx = v_int(args, "cap_idx")
    legacy_target = "wc%d_%d_%d" % (t, l, idx)
    target = None
    if "node_session" in args or "interface_id" in args:
        # Both are required together: this reconstructs the exact cap target
        # used by capture_mirror_attach, not a broad lab/node prefix.
        n = v_int(args, "node_session")
        i = v_int(args, "interface_id")
        target = "cap%d_%d_%d_%d" % (t, l, n, i)
    with TC_LOCK:
        cleanup_errors = []
        if target is not None and args.get("tap") is not None:
            tap = v_re(args, "tap", RE_TAP)
            if link_exists(tap):
                states = {direction: _capture_filter_state(tap, direction, target)
                          for direction in CAPTURE_FILTERS}
                if "foreign" in states.values():
                    raise Reject("capture filter ownership conflict on " + tap)
                for direction in CAPTURE_FILTERS:
                    try:
                        if states[direction] in ("owned", "owned_orphan"):
                            _capture_filter_delete_exact(tap, direction)
                    except Exception as e:
                        cleanup_errors.append(str(e))
                if cleanup_errors:
                    # Preserve current and legacy targets until every exact
                    # capture filter has been removed successfully.
                    raise Reject("; ".join(cleanup_errors))
        # The wc link belongs to the older shared-capture lane and is retained
        # as a separate exact cleanup target during migration.
        links = [legacy_target] + ([target] if target is not None else [])
        for link in links:
            if link_exists(link) and run_quiet(["ip", "link", "del", link]) != 0:
                cleanup_errors.append("capture veth cleanup failed: " + link)
        # As in capture_teardown, never infer ownership of the shared clsact
        # qdisc merely because our exact filters are now absent.
        if cleanup_errors:
            raise Reject("; ".join(cleanup_errors))
    return 0, [], ""


def verb_wireshark_container_remove(args):
    t = v_int(args, "tenant")
    s = v_int(args, "session")
    lab_id = "%d_%d" % (t, s)
    run_quiet(["a2disconf", "pnet-capture-" + lab_id])
    try:
        os.unlink("/etc/apache2/conf-available/pnet-capture-%s.conf" % lab_id)
    except OSError:
        pass
    run_quiet(["apache2ctl", "graceful"])
    run_quiet(["ip", "link", "del", "wm" + lab_id])
    return 0, [], ""


def verb_session_cleanup(args):
    s = v_int(args, "session")
    # exact ^vnet<S>_ match — the old "grep vnet$S" pipeline also swept
    # prefix-colliding sessions (vnet1 matched vnet12_*)
    rc, out, _ = run(["brctl", "show"], timeout=30)
    prefix = "vnet%d_" % s
    for line in out:
        br = line.split("\t")[0].strip()
        if br.startswith(prefix):
            run_quiet(["ip", "link", "set", "dev", br, "down"])
            run_quiet(["brctl", "delbr", br])
    # cluster overlays: deleting a bridge only DETACHES its vxlan port — sweep
    # the session's vx<S>_* devices too (exact-prefix match like vnet above)
    vx_prefix = "vx%d_" % s
    rc, links, _ = run(["ip", "-o", "link", "show"], timeout=30)
    for line in links:
        try:
            name = line.split(":", 2)[1].strip().split("@")[0]
        except IndexError:
            continue
        if name.startswith(vx_prefix):
            run_quiet(["ip", "link", "del", name])
    shutil.rmtree("%s/%d" % (TMP_DIR, s), ignore_errors=True)
    # best-effort: stop any link watcher riding this session (any tenant)
    try:
        for fn in os.listdir(LW_DIR):
            if fn.endswith(".conf.json") and fn[:-10].endswith("_%d" % s):
                wid = fn[:-10]
                run_quiet(["systemctl", "stop",
                           "pnet-linkwatch-%s.service" % wid])
                _lw_unlink(wid)
    except OSError:
        pass
    # ...and any Protocol Inspector tracer (wid = <tenant>_<session>_n<net>)
    try:
        for fn in os.listdir(PT_DIR):
            if not fn.endswith(".conf.json"):
                continue
            wid = fn[:-10]
            parts = wid.split("_")
            if len(parts) >= 2 and parts[1] == str(s):
                run_quiet(["systemctl", "stop",
                           "pnet-prototrace-%s.service" % wid])
                _pt_unlink(wid)
    except OSError:
        pass
    return 0, [], ""


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


def verb_node_validate(args):
    """Run one bounded check on this host's separate NetProbe control socket."""
    from pnet_validation_transport import validate_node
    runpath = v_re(args, "runpath", RE_RUNPATH)
    try:
        result = validate_node(runpath, args.get("command"))
    except ValueError as exc:
        raise Reject(str(exc))
    return 0, [json.dumps(result)], ""


def verb_node_show(args):
    """Run one read-only `show` command on a node's serial console and return the
    output (optionally parsed). Backs the BGP best-path waterfall. The command is
    validated against RE_SHOW_CMD so this can never push configuration; the actual
    telnet/expect lives in pnet-showcmd.py.
    NOTE: `host` is trusted as a cluster-internal address — callers (pnq-bgppath.php,
    pnq-overlay.php) must derive it from a node/satellite record, not from raw user
    input. This matches existing web callers and is needed for cluster-member reads."""
    host = v_ip(args, "host")
    port = v_int(args, "port")
    if not (1 <= port <= 65535):
        raise Reject("bad arg port")
    cmd = v_re(args, "cmd", RE_SHOW_CMD)
    mode = v_enum(args, "mode", SHOW_MODES)
    rc, out, err = run(["/usr/bin/python3", BASE + "/scripts/pnet-showcmd.py",
                        "--host", host, "--port", str(port),
                        "--cmd", cmd, "--mode", mode], timeout=70)
    if rc != 0 and not out:
        raise Reject("showcmd: " + (err.strip() or ("rc=%d" % rc)))
    return 0, out, ""                                   # out = one JSON line


def verb_node_config_push(args):
    """Paste a day-0 config into a RUNNING node's serial console (host:port) like a
    human would: abort autoinstall / the setup dialog, log in, enter conf-t, send the
    config, and optionally `write memory`. Backs the AI Lab Builder's
    apply_config_console tool — the reliable alternative to the unattended
    startup-config import that leaves IOS waiting on autoinstall. The config text is
    passed in args and handed to pnet-pushconfig.py on STDIN (off the process table).
    host is ALWAYS forced to 127.0.0.1 regardless of what the caller supplies; this
    verb only targets consoles local to this host."""
    host = "127.0.0.1"  # force local — any caller-supplied host is intentionally ignored
    port = v_int(args, "port")
    if not (1 <= port <= 65535):
        raise Reject("bad arg port")
    cfg = args.get("config")
    if not isinstance(cfg, str) or not cfg.strip():
        raise Reject("config required")
    if len(cfg) > 262144:
        raise Reject("config too long")
    save = bool(v_bool(args, "save")) if "save" in args else False
    cmd = ["/usr/bin/python3", BASE + "/scripts/pnet-pushconfig.py",
           "--host", host, "--port", str(port)]
    if save:
        cmd.append("--save")
    try:
        p = subprocess.run(cmd, input=cfg.encode(),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    except subprocess.TimeoutExpired:
        raise Reject("config push timed out")
    out = p.stdout.decode("utf-8", "replace").splitlines()
    if p.returncode != 0 and not out:
        raise Reject("pushconfig: " + (p.stderr.decode("utf-8", "replace").strip()
                                       or ("rc=%d" % p.returncode)))
    return 0, out, ""                                   # out = one JSON line


SHOW_MANY_MAX = 40


def verb_node_show_many(args):
    """Batch read-only `show` reads across many LOCAL node consoles in parallel
    (backs the Topology Overlay gather for satellite-placed nodes: the engine
    relays the satellite-local jobs here via cluster_call). Runs the unprivileged
    pnet_showmany.py helper. Every command is validated show-only and every read
    is FORCED to 127.0.0.1, so a relayed call can only read this host's own
    consoles — never an arbitrary address."""
    jobs = args.get("jobs")
    if not isinstance(jobs, list) or not (1 <= len(jobs) <= SHOW_MANY_MAX):
        raise Reject("bad arg jobs")
    clean = []
    for j in jobs:
        if not isinstance(j, dict):
            raise Reject("bad job")
        port = j.get("port")
        if not isinstance(port, int) or not (1 <= port <= 65535):
            raise Reject("bad job port")
        cmds = j.get("cmds")
        if not isinstance(cmds, list) or not (1 <= len(cmds) <= 8):
            raise Reject("bad job cmds")
        for c in cmds:
            if not isinstance(c, str) or not RE_SHOW_CMD.match(c):
                raise Reject("bad show command")
        key = j.get("key")
        if not isinstance(key, (str, int)):
            raise Reject("bad job key")
        clean.append({"key": str(key), "host": "127.0.0.1", "port": port,
                      "cmds": cmds, "timeout": 60})
    p = subprocess.run(
        ["/usr/bin/python3", BASE + "/scripts/pnet_showmany.py"],
        input=json.dumps(clean).encode(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    out = p.stdout.decode("utf-8", "replace").splitlines()
    if p.returncode != 0 and not out:
        raise Reject("show_many: " + (
            p.stderr.decode("utf-8", "replace").strip() or
            ("rc=%d" % p.returncode)))
    return 0, out, ""


def verb_node_kill_workspace(args):
    ws = v_path_under(args, "workspace", TMP_DIR)
    # with the space the PHP concat lost ("-n file"."/path" was a no-op)
    run_quiet(["fuser", "-k", "-n", "file", ws])
    return 0, [], ""


def _node_dir(args):
    path = "%s/%d/%d" % (TMP_DIR, v_int(args, "lab_session"),
                         v_int(args, "node_session"))
    return path


def verb_config_reset(args):
    d = _node_dir(args)
    cfg = d + "/startup-config"
    for f in (cfg, d + "/.configured"):
        try:
            os.unlink(f)
        except OSError:
            pass
    try:
        open(cfg, "w").close()
        shutil.chown(cfg, "www-data", "www-data")
    except OSError as e:
        return 1, [], str(e)
    return 0, [], ""


def verb_node_unlock(args):
    try:
        os.unlink(_node_dir(args) + "/.lock")
    except OSError:
        pass
    return 0, [], ""


# ---- B7: store-side verbs ----------------------------------------------------

def verb_service_restart(args):
    name = v_enum(args, "name", SERVICES)
    return run(["systemctl", "restart", name], timeout=120)


def verb_system_power(args):
    op = v_enum(args, "op", {"reboot", "shutdown"})
    spawn_unit("pnet-power-" + op,
               ["systemctl", "poweroff" if op == "shutdown" else "reboot"])
    return 0, [], ""


def verb_numa_balancing(args):
    state = str(v_enum(args, "state", {0, 1, "0", "1"}))
    return run(["sysctl", "-w", "kernel.numa_balancing=" + state], timeout=30)


def verb_cpu_affinity(args):
    # store "CPU dedicate" toggle: reserve cores 0-1 for the host in
    # /etc/systemd/system.conf + pin docker to the rest. The docker.service
    # sed historically ran WITHOUT sudo (silently failed as www-data) — the
    # verb makes the feature actually take effect.
    state = str(v_enum(args, "state", {0, 1, "0", "1"}))
    on = state == "1"
    rc1 = run_quiet(["sed", "-i",
                     "s/.*CPUAffinity=.*/%sCPUAffinity=0,1/g" % ("" if on else "#"),
                     "/etc/systemd/system.conf"])
    rc2 = run_quiet(["sed", "-i", "-e",
                     "s/.*CPUAffinity=.*/%sCPUAffinity=2-8191/" % ("" if on else "#"),
                     "/lib/systemd/system/docker.service"])
    return (rc1 or rc2), [], ""


def verb_iol_keygen(args):
    # Exec-side guard (defense in depth with the FS_WRITE_DENY jail exclusion in
    # _fs_jailed): refuse to root-run a keygen script that isn't root-owned / is
    # writable, so a planted CiscoIOUKeygen3.py can never execute as root.
    keygen = _require_root_script(IOL_KEYGEN)
    return run(["python3", keygen], timeout=60)


def verb_time_sync(args):
    # replaces the store's dead `sudo ntpdate` (absent on Noble; chrony is in)
    return run(["chronyc", "makestep"], timeout=30)


RE_PROXY_HOST = re.compile(r"^[A-Za-z0-9._-]{1,253}$")
RE_PROXY_CRED = re.compile(r"^[A-Za-z0-9._%+-]{1,64}$")


def verb_apt_proxy_set(args):
    # build the Acquire lines broker-side from validated parts; empty host
    # clears the proxy file (parity with the store's setProxy helper)
    host = args.get("host") or ""
    content = ""
    if host != "":
        host = v_re({"host": host}, "host", RE_PROXY_HOST)
        addr = "%s:%d" % (host, v_int(args, "port"))
        if args.get("user"):
            addr = "%s:%s@%s" % (v_re(args, "user", RE_PROXY_CRED),
                                 v_re(args, "pass", RE_PROXY_CRED), addr)
        content = "".join(
            'Acquire::%s::Proxy "http://%s/";\n' % (s, addr)
            for s in ("http", "https", "ftp"))
    with open("/etc/apt/apt.conf.d/00proxy", "w") as f:
        f.write(content)
    return 0, [], ""


def _factory_path(args):
    # catalog device ids are slugs, not guaranteed numeric
    return "/tmp/pnet_device_factory_" + v_re(args, "id", RE_FACTORY_ID)


def verb_device_factory_run(args):
    # Device-store install scripts: www-data-authored, root-executed — exact
    # parity with the old sudo path (no privilege change), but now id-jailed,
    # journald-logged and kill-able. Real hardening needs vetted/signed
    # scripts from the store catalog; tracked in docs/03 B7 notes.
    script = _factory_path(args)
    # Path is already id-jailed to ^/tmp/pnet_device_factory_<slug>$ (RE_FACTORY_ID,
    # no traversal). Additionally refuse a SYMLINK at either the script or its _log:
    # /tmp is sticky but www-data authors these files, so a symlink swap would make
    # the following chmod / the child's `> _log` redirect land on an arbitrary
    # root-owned target. islink() also catches broken links.
    logpath = script + "_log"
    if os.path.islink(script) or os.path.islink(logpath):
        raise Reject("factory script/log is a symlink (refused)")
    if not os.path.isfile(script):
        raise Reject("no factory script")
    run_quiet(["dos2unix", script])
    os.chmod(script, 0o755)
    nid = v_re(args, "id", RE_FACTORY_ID)
    # Device-store install scripts run `mysql pnetlab_db ...` relying on root's
    # /root/.my.cnf. A transient systemd unit starts with HOME unset, so mysql
    # never reads that file -> ERROR 1045 (root@localhost, using password: NO) on
    # docker image installs. Set HOME=/root so the credential-less root mysql the
    # installer set up actually works.
    # SECURITY (Stage 0.5): HOME=/root is RETAINED deliberately. The child script
    # body is www-data-authored yet root-executed — that is the load-bearing hole
    # here, and it can't be closed without breaking the factory (see RESIDUAL). But
    # because the script ALREADY runs as root it can read /root/.my.cnf directly
    # regardless of HOME, so pointing HOME elsewhere removes no privilege while it
    # DOES break the mysql install path. systemd-run gives the unit a clean env
    # (no brokerd env inherited), so no other sensitive env leaks in; we add only
    # HOME. Path/symlink hardening above bounds the tmp-file vectors.
    # RESIDUAL (deferred): www-data still controls the executed script BODY, so a
    # www-data foothold reaching this verb runs arbitrary code as root. A full fix
    # requires the device-factory to stop exec'ing www-data-authored scripts —
    # e.g. treat the catalog install steps as validated DATA, or ship signed
    # store-catalog scripts from a root-owned dir — which is out of scope for this
    # stage (would need the store DevicesController + catalog format reworked).
    spawn_unit("pnet-factory-" + nid,
               ["/bin/bash", "-c",
                "%s > %s_log 2>&1" % (script, script)],
               setenv=("HOME=/root",))
    return 0, [], ""


def _factory_cleanup(args):
    # Remove BOTH the install/delete script AND its `_log`. The script is
    # www-data-authored but the `_log` is created by THIS root-run unit
    # (`> ..._log`), so it is root-owned. /tmp is sticky, so when the store
    # DevicesController (www-data) later tries to unlink that stale `_log`
    # before the next install/delete, it gets "Operation not permitted" ->
    # 500 -> the GUI shows a blank "Install failed". Clearing it here (as
    # root) means the controller's own is_file()/unlink() are no-ops.
    base = _factory_path(args)
    for p in (base, base + "_log"):
        try:
            os.unlink(p)
        except OSError:
            pass


def verb_device_factory_kill(args):
    nid = v_re(args, "id", RE_FACTORY_ID)
    run_quiet(["systemctl", "stop", "pnet-factory-%s.service" % nid])
    run_quiet(["pkill", "-f", "pnet_device_factory_" + nid])
    # The controller always calls kill right before rewriting the script, so
    # also drop the stale root-owned tmp files here (see _factory_cleanup).
    _factory_cleanup(args)
    return 0, [], ""


def verb_device_factory_rm(args):
    _factory_cleanup(args)
    return 0, [], ""


def _qemu_overlay(args, key):
    """A node's RUNNING disk overlay. Jailed to /opt/unetlab/tmp, never BASE.

    This used to jail to BASE, which also covers /opt/unetlab/addons — so a
    caller could have pointed `commit` at a base image and folded it into
    ITS backing file. Every write op here takes a node overlay, and node
    overlays only ever live under tmp/<session>/<node>/, so the narrower jail
    costs nothing and closes that. The basename is re-validated against the
    same pattern device_qemu.php uses when it creates the linked clone.
    """
    p = v_path_under(args, key, TMP_DIR)
    if not RE_QEMU_DISK.match(os.path.basename(p)):
        raise Reject("arg %s is not a qemu disk name" % key)
    return p


def _qemu_dest_dir(args, key):
    """Destination image directory under addons/qemu, composed BROKER-SIDE.

    The caller supplies a NAME, never a path: the directory is built here from
    a strict regex match, so no traversal, absolute path or symlink component
    can reach the filesystem call. Refuses an existing directory outright —
    silently overwriting a base image that other labs are cloned from would be
    unrecoverable, so this fails closed and the caller picks another name.
    """
    name = args.get(key)
    if not isinstance(name, str) or not RE_QEMU_IMAGE_DIR.match(name):
        raise Reject("bad arg %s" % key)
    dest = ADDONS_QEMU + "/" + name
    if os.path.exists(dest):
        raise Reject("image %s already exists" % name)
    return dest


def verb_qemu_img(args):
    op = v_enum(args, "op", {"info_chain", "commit", "rebase", "save_as"})
    if op == "info_chain":
        # Read-only, and legitimately used against base images too, so this one
        # keeps the wider jail.
        return run(["qemu-img", "info", "--backing-chain",
                    v_path_under(args, "file", BASE)], timeout=120)

    f = _qemu_overlay(args, "file")

    # NOTE (do not "fix" by adding -U): qemu-img takes an image lock, so every
    # op below FAILS CLOSED while the node's qemu still holds the overlay open.
    # That lock is the load-bearing guard against committing or converting a
    # live disk, which yields a torn image rather than an error. The PHP caller
    # also refuses a running node; this is the half that cannot be bypassed by
    # a caller that forgets. `-U`/`--force-share` would defeat both.
    if op == "commit":
        return run(["qemu-img", "commit", f], timeout=1800)

    if op == "save_as":
        dest_dir = _qemu_dest_dir(args, "dest")
        dest = dest_dir + "/" + os.path.basename(f)
        # Space: `convert` writes a STANDALONE image, so the whole backing
        # chain gets flattened into the destination. Size it from the chain's
        # virtual size, not the overlay's allocated size, and keep a margin —
        # filling /opt takes the appliance down, not just this operation.
        need = _qemu_virtual_size(f) + (256 * 1024 * 1024)
        free = shutil.disk_usage(ADDONS_QEMU).free
        if free < need:
            raise Reject("not enough space: need ~%dMB, have %dMB"
                         % (need // 1048576, free // 1048576))
        os.makedirs(dest_dir, exist_ok=True)
        rc, out, err = run(["qemu-img", "convert", "-O", "qcow2", f, dest],
                           timeout=3600)
        if rc != 0:
            # Never leave a half-written image behind: a truncated qcow2 in
            # addons/qemu is indistinguishable from a good one in the template
            # list, and nodes would be cloned from it.
            shutil.rmtree(dest_dir, ignore_errors=True)
            return rc, out, err
        run(["chown", "-R", "www-data:www-data", dest_dir], timeout=300)
        os.chmod(dest_dir, 0o755)
        os.chmod(dest, 0o644)
        return rc, out, err

    backing = v_path_under(args, "backing", ADDONS_QEMU)
    return run(["qemu-img", "rebase", "-b", backing, f], timeout=1800)


def _qemu_virtual_size(f):
    """Virtual size of an image chain, in bytes; 0 when it cannot be read."""
    rc, out, _ = run(["qemu-img", "info", "--output=json", f], timeout=120)
    if rc != 0:
        return 0
    try:
        return int(json.loads("\n".join(out)).get("virtual-size") or 0)
    except (ValueError, TypeError, AttributeError):
        return 0


def _fs_jailed(args, key):
    v = args.get(key)
    if not isinstance(v, str) or "\x00" in v:
        raise Reject("bad arg %s" % key)
    # realpath the parent (target may not exist yet for mkdir/cp/mv)
    parent = os.path.realpath(os.path.dirname(v.rstrip("/")) or "/")
    real = parent + "/" + os.path.basename(v.rstrip("/"))
    if not any((real + "/").startswith(j + "/") for j in FS_JAILS):
        raise Reject("arg %s escapes fs jails" % key)
    # SECURITY (Stage 0.5): even though these dirs sit INSIDE the writable jail
    # (/opt/unetlab/addons), refuse any fs_op that targets a path the broker later
    # root-EXECUTES (the IOL keygen bin dir). Otherwise a www-data caller could
    # cp_f/mv_f a payload onto CiscoIOUKeygen3.py (legitimately in-jail) and then
    # trigger verb_iol_keygen to run it as root. Legit keygen install goes through
    # the ishare2/import worker (direct root cp), never this verb, so denying the
    # dir here does not break image installs.
    if any((real + "/").startswith(d + "/") for d in FS_WRITE_DENY):
        raise Reject("arg %s targets a root-executed path (refused)" % key)
    # SECURITY (2026-07-12): the PARENT is realpath'd but the final component is
    # deliberately not (the target may not exist yet for mkdir/cp/mv). A symlink
    # whose NAME is the final component therefore passes the jail check above and
    # is then dereferenced by the following cp/chown/chmod — letting a www-data
    # caller (the jails /opt/unetlab/{addons,tmp}+/tmp/commit are www-data-
    # writable) escape the jail and write/chown/chmod an arbitrary root-owned
    # file (e.g. a component named `dst` symlinked to /etc/cron.d/x). Refuse a
    # symlink final component outright — jailed fs ops never legitimately target
    # one (islink() is true for broken links too, so this covers not-yet-
    # resolvable targets). When the target already exists as a real path, also
    # re-check the FULLY resolved path against the jails as belt-and-suspenders.
    # (A narrow TOCTOU remains: a www-data caller could race a symlink into place
    # between this check and the coreutils op; the coreutils calls default to
    # not traversing symlinks during -R recursion, which bounds it.)
    if os.path.islink(real):
        raise Reject("arg %s is a symlink (refused)" % key)
    if os.path.exists(real):
        realfull = os.path.realpath(real)
        if not any((realfull + "/").startswith(j + "/") for j in FS_JAILS):
            raise Reject("arg %s escapes fs jails" % key)
    return real


def verb_fs_op(args):
    # root file ops for the store's image-commit flows, jailed to
    # /opt/unetlab/{addons,tmp} + /tmp/commit
    op = v_enum(args, "op",
                {"mkdir_p", "rm_rf", "cp_f", "mv_f", "chown_www", "chmod_755"})
    p = _fs_jailed(args, "path")
    if op == "mkdir_p":
        os.makedirs(p, exist_ok=True)
        return 0, [], ""
    if op == "rm_rf":
        shutil.rmtree(p, ignore_errors=True)
        try:
            os.unlink(p)
        except OSError:
            pass
        return 0, [], ""
    if op == "chown_www":
        return run(["chown", "-R", "www-data:www-data", p], timeout=300)
    if op == "chmod_755":
        return run(["chmod", "-R", "755", p], timeout=300)
    dst = _fs_jailed(args, "dst")
    if op == "cp_f":
        return run(["cp", "-f", p, dst], timeout=1800)
    return run(["mv", "-f", p, dst], timeout=300)


# addons/iol/bin write-deny carve-out (Stage 0.5): verb_fs_op refuses ALL
# writes into this dir via FS_WRITE_DENY, because it's where verb_iol_keygen
# root-execs CiscoIOUKeygen3.py from — a generic mv_f/cp_f there would let
# www-data plant a payload over that script. Legitimate .bin image
# install/rename/delete (GUI image manager, images-manage/api.php) still need
# to land here, so this is a narrow, filename-locked carve-out: every path
# this verb touches is composed broker-side from a whitelisted bare filename
# (never a caller-supplied path), and the keygen script's own name is
# explicitly refused.
RE_IOL_BIN_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.bin$")
IOL_BIN_DIR = BASE + "/addons/iol/bin"


def _iol_bin_name(args, key):
    name = args.get(key)
    if not isinstance(name, str) or not RE_IOL_BIN_NAME.match(name):
        raise Reject("bad arg %s" % key)
    if name.lower() == os.path.basename(IOL_KEYGEN).lower():
        raise Reject("arg %s refused" % key)
    return name


def verb_iol_bin_op(args):
    op = v_enum(args, "op", {"install", "rename", "delete"})
    os.makedirs(IOL_BIN_DIR, exist_ok=True)
    if op == "install":
        # src must already be inside a www-data-writable jail (FS_JAILS) —
        # e.g. the upload assembly dir under /opt/unetlab/tmp/uploads/.
        src = _fs_jailed(args, "src")
        name = _iol_bin_name(args, "name")
        if not os.path.isfile(src) or os.path.islink(src):
            raise Reject("bad src")
        dest = IOL_BIN_DIR + "/" + name
        if os.path.islink(dest):
            raise Reject("dest is a symlink (refused)")
        shutil.move(src, dest)
        os.chmod(dest, 0o755)
        return 0, [dest], ""

    name = _iol_bin_name(args, "name")
    target = IOL_BIN_DIR + "/" + name
    if os.path.islink(target):
        raise Reject("target is a symlink (refused)")
    if not os.path.isfile(target):
        raise Reject("target not found")

    if op == "delete":
        os.remove(target)
        return 0, [], ""

    # rename
    newname = _iol_bin_name(args, "newname")
    dest = IOL_BIN_DIR + "/" + newname
    if os.path.islink(dest):
        raise Reject("dest is a symlink (refused)")
    os.rename(target, dest)
    return 0, [dest], ""


def verb_folder_delete(args):
    # Root rm -rf of ONE lab folder, for the web tier's apiDeleteFolder retry when
    # a plain www-data rm fails on root-owned content (AI-builder-written labs).
    # Jailed STRICTLY under /opt/unetlab/labs: never the labs root itself, no
    # traversal, must be an existing directory.
    path = v_path_under(args, "path", LABS_DIR)
    if (path + "/") == (LABS_DIR.rstrip("/") + "/"):
        raise Reject("refusing to delete the labs root")
    if not os.path.isdir(path):
        raise Reject("not a directory")
    shutil.rmtree(path)
    return 0, [], ""


# ---- server network config (management bridge + DNS) -----------------------
# Edits the appliance's own networking: the pnet0 management bridge stanza in
# /etc/network/interfaces (ifupdown) and DNS/search-domain via the systemd-
# resolved drop-in PNetLab already ships. Every write timestamps a backup first.
# Applying a pnet0 address change bounces the management link — the caller opts
# into that with apply=1; DNS-only changes never bounce (just restart resolved).

NETCFG_INTERFACES = "/etc/network/interfaces"
NETCFG_RESOLVED = "/etc/systemd/resolved.conf.d/pnetlab.conf"
NETCFG_BACKUP_DIR = BASE + "/data/netcfg-backups"
RE_NETCFG_DOMAIN = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?$")


def _netcfg_valid_netmask(mask):
    """True for a contiguous dotted IPv4 netmask (255.255.255.0 etc.)."""
    try:
        bits = bin(int(ipaddress.IPv4Address(mask)))[2:].zfill(32)
    except Exception:
        return False
    return "01" not in bits          # all ones then all zeros = contiguous mask


def _netcfg_read_interfaces():
    mode, address, netmask, gateway = "dhcp", "", "", ""
    try:
        with open(NETCFG_INTERFACES) as f:
            lines = f.read().split("\n")
    except OSError:
        return {"mode": mode, "address": "", "netmask": "", "gateway": ""}
    in_pnet0 = False
    for ln in lines:
        s = ln.strip()
        if s in ("auto pnet0", "allow-hotplug pnet0"):   # accept either stanza marker
            in_pnet0 = True
            continue
        if in_pnet0:
            if s.startswith("auto ") or s.startswith("iface ") and "pnet0" not in s:
                break
            m = re.match(r"iface pnet0 inet (\w+)", s)
            if m:
                mode = m.group(1)
            elif s.startswith("address "):
                address = s.split(None, 1)[1].strip()
            elif s.startswith("netmask "):
                netmask = s.split(None, 1)[1].strip()
            elif s.startswith("gateway "):
                gateway = s.split(None, 1)[1].strip()
    # address may carry a CIDR prefix instead of a separate netmask line
    if "/" in address and not netmask:
        try:
            iface = ipaddress.IPv4Interface(address)
            address, netmask = str(iface.ip), str(iface.netmask)
        except Exception:
            pass
    return {"mode": mode, "address": address, "netmask": netmask, "gateway": gateway}


def _netcfg_read_resolved():
    dns, domain = [], ""
    try:
        with open(NETCFG_RESOLVED) as f:
            for ln in f:
                s = ln.strip()
                if s.startswith("DNS="):
                    dns = s[4:].split()
                elif s.startswith("Domains="):
                    domain = s[8:].strip()
    except OSError:
        pass
    return {"dns": dns, "domain": domain}


def _netcfg_build_pnet0(mode, address, netmask, gateway):
    # allow-hotplug (not auto): pnet0 is brought up by the udev event from the
    # pnet-bridges oneshot creating the bridge, so networking.service's `ifup -a`
    # doesn't block on it — removes the ~90s boot wait. (Editor Apply reboots, so
    # the new stanza takes effect cleanly on the way up.)
    out = ["allow-hotplug pnet0",
           "iface pnet0 inet %s" % mode,
           "    pre-up ip link set dev eth0 up",
           "    bridge_ports eth0",
           "    bridge_stp off"]
    if mode == "static":
        out.append("    address %s" % address)
        out.append("    netmask %s" % netmask)
        if gateway:
            out.append("    gateway %s" % gateway)
    return out


def _netcfg_replace_pnet0(content, new_stanza):
    """Surgically swap ONLY the pnet0 stanza, preserving every other interface
    (pnet1-9, nat0, etc.) verbatim. A stanza runs from its `auto pnet0` line to
    the next top-level `auto ` line."""
    lines = content.split("\n")
    out, i, n, done = [], 0, len(lines), False
    while i < n:
        if lines[i].strip() in ("auto pnet0", "allow-hotplug pnet0"):
            out.extend(new_stanza)
            out.append("")                     # single blank before the next stanza
            i += 1
            while i < n and not lines[i].lstrip().startswith("auto "):
                i += 1                          # drop the old body (incl. trailing blank)
            done = True
        else:
            out.append(lines[i])
            i += 1
    if not done:
        raise Reject("pnet0 stanza not found in %s" % NETCFG_INTERFACES)
    return "\n".join(out)


def _netcfg_backup(ts):
    d = NETCFG_BACKUP_DIR + "/" + ts
    os.makedirs(d, mode=0o700, exist_ok=True)
    for src in (NETCFG_INTERFACES, NETCFG_RESOLVED):
        if os.path.isfile(src):
            shutil.copy2(src, d + "/" + os.path.basename(src))
    return d


def verb_server_netcfg(args):
    op = v_enum(args, "op", {"get", "set"})
    if op == "get":
        data = _netcfg_read_interfaces()
        data.update(_netcfg_read_resolved())
        return 0, [json.dumps(data)], ""

    # ---- set ----
    mode = v_enum(args, "mode", {"dhcp", "static"})
    address = netmask = gateway = ""
    if mode == "static":
        address = v_ip(args, "address")
        netmask = args.get("netmask")
        if not _netcfg_valid_netmask(netmask):
            raise Reject("bad arg netmask")
        gateway = args.get("gateway") or ""
        if gateway == "":
            raise Reject("a gateway is required for a static management address")
        ipaddress.IPv4Address(gateway)        # raises on bad gw
        # Gateway sanity: it must live in the address's own subnet, otherwise the
        # route is unusable and the box would be stranded. Catches the common
        # transposed-digit typo synchronously, before anything is written.
        try:
            gw_net = ipaddress.IPv4Interface("%s/%s" % (address, netmask)).network
        except Exception:
            raise Reject("invalid address/netmask combination")
        if ipaddress.IPv4Address(gateway) not in gw_net:
            raise Reject("gateway %s is not in the %s subnet" % (gateway, gw_net))

    # DNS list + search domain (independent of mode; both optional)
    dns = []
    raw_dns = args.get("dns") or []
    if not isinstance(raw_dns, list) or len(raw_dns) > 6:
        raise Reject("bad arg dns")
    for ip in raw_dns:
        ipaddress.IPv4Address(ip)             # raises on bad entry
        dns.append(str(ip))
    domain = (args.get("domain") or "").strip()
    if domain and not RE_NETCFG_DOMAIN.match(domain):
        raise Reject("bad arg domain")

    apply_net = v_bool(args, "apply")

    # backup first, always
    ts = time.strftime("%Y%m%d-%H%M%S")
    backup = _netcfg_backup(ts)

    # rewrite /etc/network/interfaces (pnet0 stanza only)
    try:
        with open(NETCFG_INTERFACES) as f:
            old = f.read()
    except OSError as e:
        raise Reject("cannot read %s: %s" % (NETCFG_INTERFACES, e))
    new = _netcfg_replace_pnet0(old, _netcfg_build_pnet0(mode, address, netmask, gateway))
    iface_changed = (new != old)
    if iface_changed:
        tmp = NETCFG_INTERFACES + ".pnq.tmp"
        with open(tmp, "w") as f:
            f.write(new)
        os.chmod(tmp, 0o644)
        os.replace(tmp, NETCFG_INTERFACES)

    # rewrite the resolved drop-in (DNS + search domain)
    res = "[Resolve]\n"
    if dns:
        res += "DNS=%s\n" % " ".join(dns)
    if domain:
        res += "Domains=%s\n" % domain
    os.makedirs(os.path.dirname(NETCFG_RESOLVED), mode=0o755, exist_ok=True)
    rtmp = NETCFG_RESOLVED + ".pnq.tmp"
    with open(rtmp, "w") as f:
        f.write(res)
    os.chmod(rtmp, 0o644)
    os.replace(rtmp, NETCFG_RESOLVED)
    run_quiet(["systemctl", "restart", "systemd-resolved"], timeout=30)

    rebooting = False
    if iface_changed and apply_net:
        # Applying a management-INTERFACE change reliably requires a clean boot. Every
        # live method tried on this ifupdown bridge stranded the appliance: `ifup` no-ops
        # on stale /run/network/ifstate; `ifup --force` rebuilds pnet0 without re-enslaving
        # eth0; `systemctl restart networking` leaves a changed default route stale; an
        # addr/route flush + restart drops pnet0 entirely. Only a reboot re-applies
        # /etc/network/interfaces cleanly (bridge rebuilt, eth0 bridged, correct default
        # route). The new config is already on disk, so it takes effect on the way up.
        # Reboot is scheduled a few seconds out, detached, so this call's HTTP response
        # reaches the browser before the box goes down. (DNS/domain-only changes don't
        # set iface_changed, so they apply live via the resolved restart above — no
        # reboot.) The pre-apply gateway-in-subnet check above already rejects the obvious
        # typo before we get here.
        run_quiet([
            "systemd-run", "--no-block", "--collect",
            "--unit=pnet-netcfg-reboot",
            "/bin/sh", "-c", "sleep 3; systemctl reboot",
        ], timeout=15)
        rebooting = True

    return 0, [json.dumps({
        "ok": True, "iface_changed": iface_changed, "rebooting": rebooting,
        "backup": backup,
    })], ""


# ---- cluster (multi-host) ----------------------------------------------------
# Master-side verbs for the 1-master + up-to-5-satellite cluster. The PSK and
# satellite registry live under /etc/pnetlab/cluster (root 0600) so www-data
# never sees them: PHP asks the broker, the broker owns the TLS+HMAC transport
# to each satellite's pnetlab-satd (port 9050). All verbs are inert until an
# admin generates a PSK (cluster_psk_new).

CLUSTER_DIR = "/etc/pnetlab/cluster"
CLUSTER_PSK = CLUSTER_DIR + "/psk"
CLUSTER_HOSTS = CLUSTER_DIR + "/hosts.json"
CLUSTER_KEY = CLUSTER_DIR + "/id_ed25519"
CLUSTER_MYSQL_CNF = "/etc/mysql/mysql.conf.d/zz-pnetlab-cluster.cnf"
SATD_PORT = 9050
RE_CERT_FP = re.compile(r"^sha256:[0-9a-f]{64}$")
RE_HOST_NAME = re.compile(r"^[A-Za-z0-9 ._-]{1,64}$")
JOIN_TS_WINDOW = 300


def _canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _cluster_psk():
    try:
        with open(CLUSTER_PSK) as f:
            return f.read().strip()
    except OSError:
        raise Reject("no cluster PSK generated")


def _cluster_load_hosts():
    try:
        with open(CLUSTER_HOSTS) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"self_ip": "", "hosts": {}}


def _cluster_save_hosts(data):
    os.makedirs(CLUSTER_DIR, mode=0o700, exist_ok=True)
    tmp = CLUSTER_HOSTS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CLUSTER_HOSTS)


def _mysql(sql):
    """Root SQL on the local pnetlab_db; password via env, never argv."""
    env = dict(os.environ)
    env["MYSQL_PWD"] = "pnetlab"
    p = subprocess.run(["mysql", "--user=root", "pnetlab_db"],
                       input=sql.encode(), stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, env=env, timeout=30)
    if p.returncode != 0:
        raise Reject("mysql: " + p.stderr.decode(errors="replace").strip()[:200])


def verb_cluster_psk_new(args):
    os.makedirs(CLUSTER_DIR, mode=0o700, exist_ok=True)
    psk = secrets.token_hex(32)
    fd = os.open(CLUSTER_PSK, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(psk + "\n")
    return 0, [psk], ""


def verb_cluster_join(args):
    body = args.get("body")
    mac = args.get("hmac")
    if not isinstance(body, dict) or not isinstance(mac, str):
        raise Reject("bad join request")
    psk = _cluster_psk()
    expect = hmac.new(psk.encode(), _canonical(body).encode(),
                      hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expect):
        raise Reject("join auth failed")
    ts = body.get("ts")
    if not isinstance(ts, int) or abs(time.time() - ts) > JOIN_TS_WINDOW:
        raise Reject("join timestamp outside window")
    host_id = v_enum(body, "host_id", {1, 2, 3, 4, 5})
    name = v_re(body, "name", RE_HOST_NAME)
    ip = v_ip(body, "ip")
    cert_fp = v_re(body, "cert_fp", RE_CERT_FP)
    version = str(body.get("version", ""))[:48]

    # first join: expose mysqld on the LAN (host-scoped grants do the gating)
    if not os.path.isfile(CLUSTER_MYSQL_CNF):
        with open(CLUSTER_MYSQL_CNF, "w") as f:
            f.write("# pnetlab cluster: satellites connect to the master DB\n"
                    "[mysqld]\nbind-address = 0.0.0.0\n"
                    "mysqlx-bind-address = 127.0.0.1\n")
        run_quiet(["systemctl", "restart", "mysql"], timeout=120)

    data = _cluster_load_hosts()
    self_ip = args.get("self_ip")
    if isinstance(self_ip, str) and self_ip:
        try:
            ipaddress.IPv4Address(self_ip)
            data["self_ip"] = self_ip
        except Exception:
            pass

    # rotate the per-satellite DB credential; drop a stale grant if the
    # satellite moved IP since the last join
    prev = data["hosts"].get(str(host_id))
    db_pass = secrets.token_urlsafe(18)
    if prev and prev.get("ip") and prev["ip"] != ip:
        _mysql("DROP USER IF EXISTS 'pnetlab'@'%s';" % prev["ip"])
    _mysql(
        "DROP USER IF EXISTS 'pnetlab'@'{ip}';"
        "CREATE USER 'pnetlab'@'{ip}' IDENTIFIED BY '{pw}';"
        "GRANT ALL PRIVILEGES ON pnetlab_db.* TO 'pnetlab'@'{ip}';"
        "FLUSH PRIVILEGES;".format(ip=ip, pw=db_pass))

    if not os.path.isfile(CLUSTER_KEY):
        rc, _, err = run(["ssh-keygen", "-t", "ed25519", "-N", "",
                          "-C", "pnetlab-cluster", "-f", CLUSTER_KEY],
                         timeout=30)
        if rc != 0:
            raise Reject("ssh-keygen failed: " + err.strip()[:200])
    with open(CLUSTER_KEY + ".pub") as f:
        rsync_pubkey = f.read().strip()

    data["hosts"][str(host_id)] = {
        "ip": ip, "name": name, "cert_fp": cert_fp, "version": version,
        "joined": int(time.time()),
    }
    _cluster_save_hosts(data)
    log("cluster: host %d (%s, %s) joined" % (host_id, name, ip))
    return 0, [json.dumps({"db_pass": db_pass, "rsync_pubkey": rsync_pubkey})], ""


def verb_cluster_remove(args):
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    data = _cluster_load_hosts()
    prev = data["hosts"].pop(str(host_id), None)
    if prev and prev.get("ip"):
        try:
            _mysql("DROP USER IF EXISTS 'pnetlab'@'%s';" % prev["ip"])
        except Reject:
            pass  # grant cleanup is best-effort; registry removal is the point
    _cluster_save_hosts(data)
    return 0, [], ""


def verb_cluster_info(args):
    # registry only — the PSK never leaves its root-0600 file
    data = _cluster_load_hosts()
    data["psk_set"] = os.path.isfile(CLUSTER_PSK)
    return 0, [json.dumps(data)], ""


def _vxlan_names(args):
    s = v_int(args, "session")
    n = v_int(args, "net_id")
    vx = "vx%d_%d" % (s, n)
    if len(vx) > 15:
        raise Reject("vxlan device name too long")
    return vx, "vnet%d_%d" % (s, n)


def _ensure_lab_bridge(br):
    """Create-if-missing AND (re-)configure a lab bridge: shared by the
    vxlan path (a satellite can carry only the REMOTE side of a network, so
    no local node start ever creates it) and verb_net_create (cli.php
    addBridge — the web context has no sudo since B7 and a setcap'd
    /bin/ip is useless because iproute2 drops file caps for everything but
    "ip vrf exec"). The config tail runs UNCONDITIONALLY, not just on
    create: that idempotently heals any bridge an older engine left
    admin-DOWN with group_fwd_mask 0 (every port stuck in "state disabled"
    — no STP/CDP/LACP forwards, both switches elect themselves root)."""
    if link_exists(br):
        # The name is allowlisted below, but an existing host interface can
        # still collide with that namespace.  Never treat a non-bridge as an
        # idempotent lab bridge: the following sysfs writes and link-up would
        # otherwise operate on an unrelated host interface.
        _require_bridge(br)
    else:
        rc, out, err = run(["brctl", "addbr", br], timeout=30)
        if rc != 0:
            raise Reject("brctl addbr %s: %s" % (br, err.strip()[:120]))
    run_quiet(["sysctl", "-w", "net.ipv6.conf.%s.disable_ipv6=1" % br])
    mask = "/sys/class/net/%s/bridge/group_fwd_mask" % br
    for val in ("65535", "65528"):    # dkms full mask, stock-kernel fallback
        try:
            with open(mask, "w") as f:
                f.write(val)
            break
        except OSError:
            continue
    try:
        with open("/sys/devices/virtual/net/%s/bridge/multicast_snooping" % br,
                  "w") as f:
            f.write("0")
    except OSError:
        pass
    run_quiet(["ip", "link", "set", "dev", br, "up"])


# Names emitted by __network.php::getSysName().  The vnet form is per-lab;
# internal/private forms are deliberately shared by session or pod and are
# therefore not interchangeable with a vnet name.  Keep the vocabulary
# closed, use ASCII digits, and enforce Linux IFNAMSIZ (15 visible chars).
LAB_BRIDGE_RE = re.compile(
    r"^(?=.{1,15}$)(?:"
    r"vnet[0-9]{1,6}_[0-9]{1,6}|"
    r"(?:internal|internal2|internal3|private|private2|private3)_[0-9]{1,6}"
    r")$"
)
# Shared internal/private bridges must not be removed by the generic lab
# teardown path.  Their PHP caller intentionally keeps them alive; only
# per-lab vnet bridges are eligible for net_delete.
LAB_BRIDGE_DELETE_RE = re.compile(r"^(?=.{1,15}$)vnet[0-9]{1,6}_[0-9]{1,6}$")
LAB_TAP_RE = re.compile(r"^vunl\d{1,6}_\d{1,6}(_\d{1,6})?$")


def _require_bridge(br):
    """Require an existing Linux bridge, not merely an interface by that name."""
    if not link_exists(br):
        raise Reject("bridge missing")
    if not os.path.isdir("/sys/class/net/%s/bridge" % br):
        raise Reject("bridge name collides with non-bridge interface")


def _v_name(args, rx, what):
    name = args.get("name")
    if not isinstance(name, str) or not rx.match(name):
        raise Reject("bad %s name" % what)
    return name


def verb_net_create(args):
    """cli.php addBridge(): create + up + configure a lab bridge as root.
    ageing0=1 mirrors the engine's count<3 point-to-point tuning.
    vlan_filtering=1 turns the bridge into a dot1q switch (per-port VLANs
    via verb_iface_vlan); default_pvid sets the bridge's default PVID."""
    br = _v_name(args, LAB_BRIDGE_RE, "bridge")
    _ensure_lab_bridge(br)
    if args.get("ageing0"):
        run_quiet(["brctl", "setageing", br, "0"])
        try:
            with open("/sys/class/net/%s/bridge/multicast_router" % br,
                      "w") as f:
                f.write("2")
        except OSError:
            pass
    if args.get("vlan_filtering"):
        run_quiet(["ip", "link", "set", br, "type", "bridge",
                   "vlan_filtering", "1"])
        if args.get("default_pvid") is not None:
            pvid = v_int(args, "default_pvid")
            if 1 <= pvid <= 4094:
                run_quiet(["ip", "link", "set", br, "type", "bridge",
                           "vlan_default_pvid", str(pvid)])
    return 0, [], ""


def verb_net_delete(args):
    """cli.php delBridge(): cloud bridges (pnet*/nat*) never match the
    vnet regex, so they cannot be deleted through this verb."""
    br = _v_name(args, LAB_BRIDGE_DELETE_RE, "bridge")
    if link_exists(br):
        _require_bridge(br)
        return run(["ip", "link", "del", br], timeout=30)
    return 0, [], ""


def verb_tap_delete(args):
    """cli.php delTap(): web-context tap teardown (tunctl is gone and ip
    drops file caps; both legacy paths silently no-oped as www-data)."""
    tap = _v_name(args, LAB_TAP_RE, "tap")
    if link_exists(tap):
        return run(["ip", "link", "del", tap], timeout=30)
    return 0, [], ""


def _v_num_opt(args, key, lo, hi):
    """Optional non-negative numeric arg (delay/jitter/loss/rate). Returns the
    validated number as a str, or '' when absent/empty. Accepts ints and
    decimals (loss can be fractional %)."""
    v = args.get(key)
    if v is None or v == "":
        return ""
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise Reject("bad arg %s" % key)
    if n < lo or n > hi:
        raise Reject("arg %s out of range" % key)
    # keep integers integer-formatted so tc gets "10ms" not "10.0ms"
    return str(int(n)) if n == int(n) else str(n)


def _tc_json(argv):
    rc, out, err = run(["tc", "-j"] + argv, timeout=30)
    if rc != 0:
        raise Reject("tc query failed: " + (err.strip() or "rc=%d" % rc))
    try:
        value = json.loads("\n".join(out) or "[]")
    except ValueError:
        raise Reject("tc returned invalid JSON")
    if not isinstance(value, list):
        raise Reject("tc returned invalid result")
    return value


def _tc_step(argv):
    rc, out, err = run(argv, timeout=30)
    if rc != 0:
        raise Reject("tc setup failed: " + (err.strip() or "rc=%d" % rc))
    return out


def _tc_root_qdisc(tap):
    for item in _tc_json(["qdisc", "show", "dev", tap]):
        if item.get("kind") not in ("clsact", "ingress") and item.get("root"):
            return item
    return None


def _tc_root_state(tap):
    root = _tc_root_qdisc(tap)
    if root is None or str(root.get("handle", "0:")) in ("0", "0:"):
        return "default"
    if root.get("kind") == "netem" and root.get("handle") == PNET_NETEM_HANDLE:
        return "owned"
    return "foreign"


def _tc_has_clsact(tap):
    return any(q.get("kind") == "clsact"
               for q in _tc_json(["qdisc", "show", "dev", tap]))


def _capture_filter_entries(tap, direction, pref=None):
    argv = ["filter", "show", "dev", tap, direction]
    if pref is not None:
        argv += ["pref", str(pref)]
    return _tc_json(argv)


def _capture_filter_owned(entry, pref, handle, target):
    # `tc filter show ... pref N` omits pref from the selected records on
    # iproute2 6.17. The query itself already constrained N, so a missing value
    # means the requested pref; an explicitly different value is still foreign.
    try:
        entry_pref = int(entry.get("pref", pref))
        chain = int(entry.get("chain", -1))
    except (TypeError, ValueError):
        return False
    if (entry_pref != pref or entry.get("kind") != "matchall"
            or entry.get("protocol") != "all" or chain != 0):
        return False
    options = entry.get("options") or {}
    actual_handle = options.get("handle", entry.get("handle"))
    try:
        # tc -j emits matchall handles as JSON numbers, while command input and
        # older fixtures commonly use hexadecimal strings. Compare their value.
        actual_handle = (actual_handle if isinstance(actual_handle, int)
                         else int(str(actual_handle), 0))
        expected_handle = int(handle, 0)
    except (TypeError, ValueError):
        return False
    if actual_handle != expected_handle:
        return False
    for action in options.get("actions", []):
        if (action.get("kind") == "mirred" and action.get("direction") == "egress"
                and action.get("mirred_action", action.get("eaction")) == "mirror"
                and action.get("to_dev") == target):
            return True
    return False


def _capture_filter_summary(entry, pref):
    """Recognize tc's optionless same-pref matchall summary object."""
    try:
        entry_pref = int(entry.get("pref", pref))
        chain = int(entry.get("chain", -1))
    except (TypeError, ValueError):
        return False
    return (entry_pref == pref and entry.get("kind") == "matchall"
            and entry.get("protocol") == "all" and chain == 0
            and "options" not in entry and "handle" not in entry)


def _capture_filter_owned_orphan(entry, pref, handle, target):
    """Recognize an exact reserved mirror whose deleted target prints as `*`."""
    if link_exists(target):
        return False
    try:
        entry_pref = int(entry.get("pref", pref))
        entry_chain = int(entry.get("chain", -1))
    except (TypeError, ValueError):
        return False
    if (entry_pref != pref or entry_chain != 0
            or entry.get("protocol") != "all"
            or entry.get("kind") != "matchall"):
        return False
    options = entry.get("options") or {}
    actual_handle = options.get("handle", entry.get("handle"))
    try:
        actual_handle = (actual_handle if isinstance(actual_handle, int)
                         else int(str(actual_handle), 0))
    except (TypeError, ValueError):
        return False
    if actual_handle != int(handle, 0):
        return False
    actions = options.get("actions")
    if not isinstance(actions, list) or len(actions) != 1:
        return False
    action = actions[0]
    return (isinstance(action, dict) and action.get("kind") == "mirred"
            and action.get("direction") == "egress"
            and action.get("mirred_action", action.get("eaction")) == "mirror"
            and action.get("to_dev") == "*")


def _capture_filter_state(tap, direction, target):
    pref, handle = CAPTURE_FILTERS[direction]
    entries = _capture_filter_entries(tap, direction, pref)
    if not entries:
        return "absent"
    owned = [entry for entry in entries
             if _capture_filter_owned(entry, pref, handle, target)]
    summaries = [entry for entry in entries
                 if _capture_filter_summary(entry, pref)]
    if len(owned) == 1 and len(owned) + len(summaries) == len(entries):
        return "owned"
    orphans = [entry for entry in entries
               if _capture_filter_owned_orphan(entry, pref, handle, target)]
    if len(orphans) == 1 and len(orphans) + len(summaries) == len(entries):
        return "owned_orphan"
    return "foreign"


def _capture_filter_delete(tap, direction, target):
    if _capture_filter_state(tap, direction, target) != "owned":
        return
    _capture_filter_delete_exact(tap, direction)


def _capture_filter_delete_exact(tap, direction):
    pref, handle = CAPTURE_FILTERS[direction]
    rc, _, err = run(["tc", "filter", "del", "dev", tap, direction,
                      "protocol", "all", "pref", str(pref), "handle", handle,
                      "matchall"], timeout=30)
    if rc != 0:
        raise Reject("tc capture cleanup failed: " + (err.strip() or "rc=%d" % rc))


def _tc_clsact_empty(tap):
    return not (_capture_filter_entries(tap, "ingress")
                or _capture_filter_entries(tap, "egress"))


def verb_netem_set(args):
    """interfc.php applyQuality(): per-link WAN impairment via `tc qdisc replace
    ... netem`. Was `sudo tc qdisc` in the engine and silently no-oped as
    www-data post-B7. Builds the netem command broker-side from validated args.

    Basic (back-compat): rate(Kbit) delay(ms) jitter(ms) loss(%). Advanced (all
    optional): dist (jitter distribution uniform|normal|pareto|paretonormal),
    delay_corr/loss_corr/dup_corr/reorder_corr (%), loss_mode (random|gemodel),
    duplicate/corrupt/reorder (%), gap (pkts), limit (queue pkts). The kernel
    netem qdisc supports all of these; tc validates impossible combos (e.g.
    reorder needs a delay) and we pre-check that ourselves so the GUI gets a
    precise Reject instead of a raw tc parse error.

    All-blank apply (every knob absent/empty) means "no impairment" and must
    be a clean success: `tc qdisc del ... root` errors ("Cannot delete qdisc
    with handle of zero") when the interface is already at its default qdisc
    (nothing to remove) -- that is NOT a failure, the desired end state (no
    netem) already holds, so it's treated as success too."""
    tap = _v_name(args, LAB_TAP_RE, "tap")
    if not link_exists(tap):
        return 0, [], ""
    rate = _v_num_opt(args, "rate", 0, 100_000_000)   # Kbit
    delay = _v_num_opt(args, "delay", 0, 600_000)     # ms
    jitter = _v_num_opt(args, "jitter", 0, 600_000)   # ms
    loss = _v_num_opt(args, "loss", 0, 100)           # %
    delay_corr = _v_num_opt(args, "delay_corr", 0, 100)
    loss_corr = _v_num_opt(args, "loss_corr", 0, 100)
    dup = _v_num_opt(args, "duplicate", 0, 100)
    dup_corr = _v_num_opt(args, "dup_corr", 0, 100)
    corrupt = _v_num_opt(args, "corrupt", 0, 100)
    reorder = _v_num_opt(args, "reorder", 0, 100)
    reorder_corr = _v_num_opt(args, "reorder_corr", 0, 100)
    gap = _v_num_opt(args, "gap", 0, 1_000_000)
    limit = _v_num_opt(args, "limit", 0, 10_000_000)
    dist_value = args.get("dist", "")
    loss_mode_value = args.get("loss_mode", "random")
    if dist_value is None:
        dist_value = ""
    if loss_mode_value in (None, ""):
        loss_mode_value = "random"
    if not isinstance(dist_value, str):
        raise Reject("bad distribution")
    if not isinstance(loss_mode_value, str):
        raise Reject("bad loss_mode")
    dist = dist_value.strip().lower()
    loss_mode = loss_mode_value.strip().lower()
    if dist and dist not in ("uniform", "normal", "pareto", "paretonormal"):
        raise Reject("bad distribution")
    if loss_mode not in ("random", "gemodel"):
        raise Reject("bad loss_mode")

    netem = []
    if limit:
        netem += ["limit", limit]
    if delay:
        netem += ["delay", delay + "ms"]
        if jitter:
            netem += [jitter + "ms"]
            if delay_corr:
                netem += [delay_corr + "%"]
            if dist and dist != "uniform":
                netem += ["distribution", dist]
    if loss:
        if loss_mode == "gemodel":
            netem += ["loss", "gemodel", loss + "%"]
        else:
            netem += ["loss", loss + "%"]
            if loss_corr:
                netem += [loss_corr + "%"]
    if corrupt:
        netem += ["corrupt", corrupt + "%"]
    if dup:
        netem += ["duplicate", dup + "%"]
        if dup_corr:
            netem += [dup_corr + "%"]
    if reorder:
        # tc/the kernel rejects `reorder` without a `delay` ("reordering not
        # possible without specifying some delay"). Catch it here with a
        # precise, GUI-friendly message instead of surfacing tc's raw usage
        # dump, and ONLY when reorder is actually set (>0) -- a blank/zero
        # reorder must never trip this.
        if not delay:
            raise Reject("reorder needs a delay: set a Delay (ms) value, "
                         "or clear Reorder to apply without one")
        netem += ["reorder", reorder + "%"]
        if reorder_corr:
            netem += [reorder_corr + "%"]
        if gap:
            netem += ["gap", gap]
    if rate:
        netem += ["rate", rate + "Kbit"]
    with TC_LOCK:
        state = _tc_root_state(tap)
        if state == "foreign":
            raise Reject("foreign root qdisc on " + tap)
        if not netem:
            if state == "default":
                return 0, [], ""
            _tc_step(["tc", "qdisc", "del", "dev", tap, "root",
                      "handle", PNET_NETEM_HANDLE])
            if _tc_root_state(tap) != "default":
                raise Reject("tc default qdisc restoration failed on " + tap)
            return 0, [], ""
        initial_state = state
        _tc_step(["tc", "qdisc", "replace", "dev", tap, "root", "handle",
                  PNET_NETEM_HANDLE, "netem"] + netem)
        if _tc_root_state(tap) != "owned":
            if initial_state == "default":
                # This invocation introduced the exact fixed handle, so it is
                # safe to compensate even when the verification representation
                # was unexpected. Verify that the kernel default returns.
                rc, _, err = run(["tc", "qdisc", "del", "dev", tap, "root",
                                  "handle", PNET_NETEM_HANDLE], timeout=30)
                if rc != 0 or _tc_root_state(tap) != "default":
                    raise Reject("tc netem verification failed and compensation "
                                 "failed on %s: %s" % (tap, err.strip()))
            # A prior owned netem's complete option vector is not reliably
            # reconstructable from tc JSON across iproute2 versions. Do not
            # invent a persistent registry in this bounded slice; surface the
            # limitation rather than pretending rollback was possible.
            if initial_state == "owned":
                raise Reject("tc netem verification failed on %s; prior owned "
                             "options could not be reconstructed" % tap)
            raise Reject("tc netem verification failed on " + tap)
        return 0, [], ""


def verb_netem_del(args):
    """Delete only PNetLab's exact netem root and verify kernel default."""
    tap = _v_name(args, LAB_TAP_RE, "tap")
    if not link_exists(tap):
        return 0, [], ""
    with TC_LOCK:
        state = _tc_root_state(tap)
        if state == "foreign":
            raise Reject("foreign root qdisc on " + tap)
        if state == "default":
            return 0, [], ""
        _tc_step(["tc", "qdisc", "del", "dev", tap, "root",
                  "handle", PNET_NETEM_HANDLE])
        if _tc_root_state(tap) != "default":
            raise Reject("tc default qdisc restoration failed on " + tap)
        return 0, [], ""


def verb_iface_linkstate(args):
    """interfc.php setLinkState(): bring a lab tap (vunl<s>_<n>) admin up/down.
    Was `sudo ip link set <vunl> up|down` from the web context and silently
    no-oped as www-data post-B7 (no sudo), so a live interface rewire/suspend
    on a running node left the veth admin-DOWN — bridged but with no carrier,
    so no traffic passed even though both endpoints reported the link up."""
    tap = _v_name(args, LAB_TAP_RE, "tap")
    state = v_enum(args, "state", {"up", "down"})
    if not link_exists(tap):
        return 0, [], ""
    run_quiet(["ip", "link", "set", "dev", tap, state])
    return 0, [], ""


def verb_qemu_setlink(args):
    """interfc.php setLinkState() qemu branch: was `sudo nc -U monitor.sock`
    (HMP `info network` -> `set_link netN on|off`), a silent no-op as www-data
    post-B7, so a live interface suspend/rewire never reached the QEMU monitor.
    Drive the monitor as root instead. The socket path and tap are strictly
    regex-validated, so the embedded shell pipeline has no injection surface."""
    mon = v_re(args, "mon", RE_MON)
    tap = v_re(args, "tap", RE_TAP)
    state = v_enum(args, "state", {"up", "down"})
    if not os.path.exists(mon):
        return 0, [], ""
    onoff = "on" if state == "up" else "off"
    rc, out, _ = run(["bash", "-c",
        "echo 'info network' | nc -U %s -q 0 | grep %s "
        "| sed 's/.*\\(net[0-9]\\+\\):.*/\\1/g'" % (mon, tap)],
        timeout=12, check_rc=False)
    idx = out[0].strip() if out else ""
    if re.match(r"^net\d+$", idx):
        run_quiet(["bash", "-c",
            "echo 'set_link %s %s' | nc -U %s -q 0" % (idx, onoff, mon)],
            timeout=12)
    return 0, [], ""


def verb_iol_keepalive(args):
    """interfc.php setLinkState() iol branch (only when L1 keepalive is on):
    was `sudo php .../wrapper 32768 <uid> 'perl keepalive.pl ...'` to start the
    per-interface keepalive and `sudo kill -9` to stop it — both silent no-ops
    as www-data post-B7. The start lane is now intentionally DISABLED (user
    decision 2026-07-04): keepalive.pl pins IOL at 100% CPU (same pathology as
    the removed `-l` wrapper flag), and its store-side setuid shim was retired
    with the Laravel store. The "down" lane still reaps stray keepalive.pl
    processes from older installs."""
    runpath = v_re(args, "runpath", RE_RUNPATH)
    state = v_enum(args, "state", {"up", "down"})
    session = v_int(args, "session")
    if_id = v_int(args, "if_id")
    tag = "%d_%d" % (session, if_id)
    if state == "up":
        pass  # intentionally no-op — see docstring
    else:
        rc, out, _ = run(["pgrep", "-f", "keepalive.*-n %s" % tag],
                         timeout=10, check_rc=False)
        for pid in out:
            pid = pid.strip()
            if pid.isdigit():
                run_quiet(["kill", "-9", pid], timeout=5)
    return 0, [], ""


def verb_iface_vlan(args):
    """interfc.php applyVlan()/unapplyVlan(): per-interface 802.1Q via the
    bridge's vlan_filtering + `bridge vlan` PVID rules. Was `sudo ip link`/
    `sudo bridge` and silently no-oped as www-data post-B7. action=set takes
    a bridge (vnet<s>_<n>), a tap (vunl<s>_<n>) and vid 0-4094 (0 = access
    VLAN 1, trunk the rest); action=clear turns filtering back off.

    dot1q switch ports pass mode=access|trunk instead of a bare vid:
      access: pvid=<vlan>          -> untagged access port on that VLAN
      trunk:  native=<vlan> vlans=<allowed-list> -> native untagged, rest
              tagged. An empty allowed list trunks all of 1-4094."""
    br = _v_name({"name": args.get("bridge")}, LAB_BRIDGE_RE, "bridge")
    tap = _v_name({"name": args.get("tap")}, LAB_TAP_RE, "tap")
    action = v_enum(args, "action", {"set", "clear"})
    _require_bridge(br)
    if not link_exists(tap):
        return 0, [], ""
    if action == "clear":
        run_quiet(["ip", "link", "set", br, "type", "bridge",
                   "vlan_filtering", "0"])
        run_quiet(["bridge", "vlan", "del", "vid", "1-4094", "dev", tap])
        return 0, [], ""

    run_quiet(["ip", "link", "set", br, "type", "bridge",
               "vlan_filtering", "1"])

    mode = args.get("mode")
    if mode is not None:
        # dot1q switch port
        mode = v_enum(args, "mode", {"access", "trunk"})
        run_quiet(["bridge", "vlan", "del", "vid", "1-4094", "dev", tap])
        if mode == "access":
            pvid = v_int(args, "pvid") if args.get("pvid") is not None else 1
            if pvid < 1 or pvid > 4094:
                raise Reject("bad pvid")
            run_quiet(["bridge", "vlan", "add", "dev", tap, "vid", str(pvid),
                       "pvid", "untagged"])
        else:
            native = (v_int(args, "native")
                      if args.get("native") is not None else 1)
            if native < 1 or native > 4094:
                raise Reject("bad native")
            allowed = v_vlan_list(args, "vlans")
            run_quiet(["bridge", "vlan", "add", "dev", tap, "vid",
                       str(native), "pvid", "untagged"])
            if allowed:
                for vid in allowed:
                    if vid != native:
                        run_quiet(["bridge", "vlan", "add", "dev", tap,
                                   "vid", str(vid)])
            else:
                # no explicit list -> trunk everything except the native vid
                run_quiet(["bridge", "vlan", "add", "dev", tap, "vid",
                           "1-4094"])
        return 0, [], ""

    # legacy single-vid path (smart bridge): 0 = access VLAN 1 + trunk rest
    vid = v_int(args, "vid")
    if vid < 0 or vid > 4094:
        raise Reject("bad vid")
    if vid != 0:
        run_quiet(["bridge", "vlan", "del", "vid", "1-4094", "dev", tap])
        run_quiet(["bridge", "vlan", "add", "dev", tap, "vid", str(vid),
                   "pvid", "untagged"])
    else:
        run_quiet(["bridge", "vlan", "del", "vid", "2-4094", "dev", tap])
        run_quiet(["bridge", "vlan", "add", "dev", tap, "vid", "1",
                   "pvid", "untagged"])
        run_quiet(["bridge", "vlan", "add", "dev", tap, "vid", "2-4094"])
    return 0, [], ""


# ---- soft-router (netns NAT/route gateway) ---------------------------------
# A `router` lab network is a normal vnet bridge PLUS a per-network Linux
# network namespace that acts as an L3 gateway: a `lan` veth on the bridge
# (downlink gateway IP + dnsmasq pool), an optional `wan` veth (host-egress
# MASQUERADE via the default-route iface, or enslaved to another lab bridge),
# net.ipv4.ip_forward=1, an optional NAT, and a manual static-route table.
# All host-side state is keyed by session/net_id so every verb is idempotent
# and verb_router_delete tears it down with no leak across lab restarts.

RUN_DIR = "/run/pnetlab"


def _router_names(args):
    s = v_int(args, "session")
    n = v_int(args, "net_id")
    if s < 0 or s > 999999 or n < 0 or n >= 16384:
        raise Reject("session/net_id out of range")
    h_lan, h_wan = "rl%d_%d" % (s, n), "rw%d_%d" % (s, n)
    if len(h_lan) > 15 or len(h_wan) > 15:
        raise Reject("router iface name too long")
    return s, n, "vnet%d_%d" % (s, n), "pnr%d_%d" % (s, n), h_lan, h_wan


def _wan_link(n):
    """Deterministic /30 in CGNAT space (100.64.0.0/10) for the router<->host
    uplink veth. Returns (host_ip, ns_ip, prefix, network/30)."""
    base = n * 4
    o3, o4 = (base // 256) & 0xFF, base % 256
    return ("100.64.%d.%d" % (o3, o4 + 1), "100.64.%d.%d" % (o3, o4 + 2),
            30, "100.64.%d.%d/30" % (o3, o4))


def _host_egress_iface():
    rc, out, _ = run(["ip", "-o", "route", "show", "default"], timeout=10)
    if rc == 0:
        for line in out:
            m = re.search(r"\bdev\s+(\S+)", line)
            if m:
                return m.group(1)
    return "pnet0"


def _netns_exists(ns):
    return any(os.path.exists(p + "/" + ns)
               for p in ("/run/netns", "/var/run/netns"))


def _ns_exec(ns, argv):
    return run_quiet(["ip", "netns", "exec", ns] + argv)


def _dnsmasq_pidfile(ns):
    return "%s/dnsmasq-%s.pid" % (RUN_DIR, ns)


def _kill_dnsmasq(ns):
    pf = _dnsmasq_pidfile(ns)
    try:
        with open(pf) as f:
            os.kill(int(f.read().strip()), 15)
    except (OSError, ValueError):
        pass
    try:
        os.unlink(pf)
    except OSError:
        pass


def _router_state_path(s, n):
    return "%s/router-%d_%d.json" % (RUN_DIR, s, n)


def _router_save_state(s, n, cfg):
    os.makedirs(RUN_DIR, exist_ok=True)
    tmp = _router_state_path(s, n) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f)
    os.replace(tmp, _router_state_path(s, n))


def _router_load_state(s, n):
    try:
        with open(_router_state_path(s, n)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _router_normalize(args):
    """Validate a Configure-dialog payload into a JSON-safe, fully-checked cfg
    dict. Every field passes through ipaddress/enum validators here, so the
    persisted state and the live apply share one source of truth. Reused to
    re-validate state on restore — bad state can never reach an argv."""
    cfg = {
        "gw_cidr": v_cidr(args, "gw_cidr"),
        "nat": v_bool(args, "nat"),
        "uplink": (v_enum(args, "uplink", {"none", "host", "net"})
                   if args.get("uplink") is not None else "none"),
        "routes": [{"dst": d, "gw": g}
                   for d, g in v_route_list(args, "routes")],
        "dhcp": v_bool(args, "dhcp"),
    }
    if cfg["uplink"] == "net":
        cfg["uplink_net_id"] = v_int(args, "uplink_net_id")
        cfg["uplink_cidr"] = v_cidr(args, "uplink_cidr")
        cfg["uplink_gw"] = (v_ip(args, "uplink_gw")
                            if args.get("uplink_gw") else "")
    if cfg["dhcp"]:
        cfg["dhcp_start"] = v_ip(args, "dhcp_start")
        cfg["dhcp_end"] = v_ip(args, "dhcp_end")
        cfg["dhcp_dns"] = (v_ip(args, "dhcp_dns")
                           if args.get("dhcp_dns") else "")
    return cfg


def _apply_router(s, n, cfg):
    """Declaratively push a normalized cfg into the live namespace. Idempotent:
    flushes the lan address, NAT table, manual routes and default route, then
    rewrites them, and (re)spawns dnsmasq. No-op if the netns isn't up yet."""
    _, _, _, ns, h_lan, h_wan = _router_names({"session": s, "net_id": n})
    if not _netns_exists(ns):
        return
    gw = cfg["gw_cidr"]
    iface = ipaddress.IPv4Interface(gw)

    # --- downlink address (flush + set) ---
    _ns_exec(ns, ["ip", "addr", "flush", "dev", "lan"])
    _ns_exec(ns, ["ip", "addr", "add", gw, "dev", "lan"])
    _ns_exec(ns, ["ip", "link", "set", "lan", "up"])

    # --- clean slate for uplink/NAT/manual routes ---
    egress = _host_egress_iface()
    h_ip, ns_ip, plen, wan_net = _wan_link(n)
    while run_quiet(["iptables", "-t", "nat", "-D", "POSTROUTING", "-s",
                     wan_net, "-o", egress, "-j", "MASQUERADE"]) == 0:
        pass
    _ns_exec(ns, ["iptables", "-t", "nat", "-F"])
    _ns_exec(ns, ["ip", "route", "flush", "proto", "static"])
    _ns_exec(ns, ["ip", "route", "del", "default"])

    uplink, nat = cfg["uplink"], cfg["nat"]
    if uplink == "host":
        # wan veth: ns 'wan' <-> host h_wan on a CGNAT /30; default route in
        # the ns via the host end; root MASQUERADEs the /30 out the egress
        # iface (mirrors ovfstartup.sh's 10.0.137.0/24 rule).
        if not link_exists(h_wan):
            run_quiet(["ip", "link", "add", h_wan, "type", "veth",
                       "peer", "name", "wan", "netns", ns])
        run_quiet(["ip", "addr", "flush", "dev", h_wan])
        run_quiet(["ip", "addr", "add", "%s/%d" % (h_ip, plen), "dev", h_wan])
        run_quiet(["ip", "link", "set", h_wan, "up"])
        _ns_exec(ns, ["ip", "addr", "flush", "dev", "wan"])
        _ns_exec(ns, ["ip", "addr", "add", "%s/%d" % (ns_ip, plen),
                      "dev", "wan"])
        _ns_exec(ns, ["ip", "link", "set", "wan", "up"])
        _ns_exec(ns, ["ip", "route", "add", "default", "via", h_ip])
        if run_quiet(["iptables", "-t", "nat", "-C", "POSTROUTING", "-s",
                      wan_net, "-o", egress, "-j", "MASQUERADE"]) != 0:
            run_quiet(["iptables", "-t", "nat", "-A", "POSTROUTING", "-s",
                       wan_net, "-o", egress, "-j", "MASQUERADE"])
        if nat:
            _ns_exec(ns, ["iptables", "-t", "nat", "-A", "POSTROUTING",
                          "-o", "wan", "-j", "MASQUERADE"])
    elif uplink == "net":
        up_br = "vnet%d_%d" % (s, cfg["uplink_net_id"])
        if not link_exists(h_wan):
            run_quiet(["ip", "link", "add", h_wan, "type", "veth",
                       "peer", "name", "wan", "netns", ns])
        run_quiet(["ip", "link", "set", h_wan, "master", up_br])
        run_quiet(["ip", "link", "set", h_wan, "up"])
        _ns_exec(ns, ["ip", "addr", "flush", "dev", "wan"])
        _ns_exec(ns, ["ip", "addr", "add", cfg["uplink_cidr"], "dev", "wan"])
        _ns_exec(ns, ["ip", "link", "set", "wan", "up"])
        if cfg.get("uplink_gw"):
            _ns_exec(ns, ["ip", "route", "add", "default", "via",
                          cfg["uplink_gw"]])
        if nat:
            _ns_exec(ns, ["iptables", "-t", "nat", "-A", "POSTROUTING",
                          "-o", "wan", "-j", "MASQUERADE"])
    elif link_exists(h_wan):
        run_quiet(["ip", "link", "del", h_wan])

    # --- manual static routes (proto static, flushed above) ---
    for r in cfg["routes"]:
        tgt = ["default"] if r["dst"] == "0.0.0.0/0" else [r["dst"]]
        _ns_exec(ns, ["ip", "route", "replace"] + tgt +
                 ["via", r["gw"], "proto", "static"])

    # --- dnsmasq DHCP on the downlink ---
    _kill_dnsmasq(ns)
    if cfg["dhcp"] and shutil.which("dnsmasq"):
        os.makedirs(RUN_DIR, exist_ok=True)
        dns = cfg.get("dhcp_dns") or str(iface.ip)
        run_quiet(["ip", "netns", "exec", ns, "dnsmasq",
                   "--interface=lan", "--bind-interfaces",
                   "--except-interface=lo",
                   "--dhcp-range=%s,%s,%s,12h" % (cfg["dhcp_start"],
                                                  cfg["dhcp_end"],
                                                  iface.netmask),
                   "--dhcp-option=3,%s" % iface.ip,
                   "--dhcp-option=6,%s" % dns,
                   "--pid-file=%s" % _dnsmasq_pidfile(ns),
                   "--leasefile-ro", "--no-resolv", "--no-hosts"])


def verb_router_create(args):
    """cli.php addNetwork case 'router': stand up the netns + downlink veth,
    then auto-restore the persisted config (so a lab restart re-applies NAT/
    DHCP/routes with no extra plumbing). Idempotent; bridge created by
    _ensure_lab_bridge."""
    s, n, br, ns, h_lan, h_wan = _router_names(args)
    _ensure_lab_bridge(br)
    if not _netns_exists(ns):
        run_quiet(["ip", "netns", "add", ns])
        if not _netns_exists(ns):
            raise Reject("netns add %s failed" % ns)
    _ns_exec(ns, ["sysctl", "-q", "-w", "net.ipv4.ip_forward=1"])
    _ns_exec(ns, ["ip", "link", "set", "lo", "up"])
    # downlink veth: host end enslaved to the lab bridge, ns end renamed 'lan'
    if not link_exists(h_lan):
        run_quiet(["ip", "link", "add", h_lan, "type", "veth",
                   "peer", "name", "lan", "netns", ns])
    run_quiet(["ip", "link", "set", h_lan, "master", br])
    run_quiet(["ip", "link", "set", h_lan, "up"])
    _ns_exec(ns, ["ip", "link", "set", "lan", "up"])
    cfg = _router_load_state(s, n)
    if cfg:
        # re-validate persisted state through the same checks before any argv
        _apply_router(s, n, _router_normalize(cfg))
    return 0, [], ""


def verb_router_apply(args):
    """api.php network/manage: validate + persist the Configure-dialog payload,
    then live-apply it (the proven 'apply to a running entity' path). Persisting
    even before lab start means verb_router_create restores it at start."""
    s, n = v_int(args, "session"), v_int(args, "net_id")
    _router_names(args)
    cfg = _router_normalize(args)
    _router_save_state(s, n, cfg)
    _apply_router(s, n, cfg)
    return 0, [], ""


def verb_router_get(args):
    """api_networks.php manage response: return the saved router cfg as one
    JSON line so the Configure dialog round-trips the saved values. '{}' when
    nothing is persisted yet."""
    s, n = v_int(args, "session"), v_int(args, "net_id")
    _router_names(args)
    cfg = _router_load_state(s, n) or {}
    return 0, [json.dumps(cfg)], ""


def verb_router_delete(args):
    """cli.php delBridge() for a router net: tear everything down — dnsmasq,
    veths, the root-ns MASQUERADE, and the namespace itself. No-op if absent.
    Deleting the netns removes its 'lan'/'wan' ends; deleting a host-side veth
    removes its peer — so either path leaves nothing behind."""
    s, n, br, ns, h_lan, h_wan = _router_names(args)
    _kill_dnsmasq(ns)
    egress = _host_egress_iface()
    _, _, _, wan_net = _wan_link(n)
    while run_quiet(["iptables", "-t", "nat", "-D", "POSTROUTING", "-s",
                     wan_net, "-o", egress, "-j", "MASQUERADE"]) == 0:
        pass
    for dev in (h_lan, h_wan):
        if link_exists(dev):
            run_quiet(["ip", "link", "del", dev])
    if _netns_exists(ns):
        run_quiet(["ip", "netns", "del", ns])
    # config is per-run: drop the persisted state so a reused net_id (PNetLab
    # recycles the lowest free id) never inherits a previous router's config.
    try:
        os.unlink(_router_state_path(s, n))
    except OSError:
        pass
    return 0, [], ""


# ---- wireless cell WLAN list (VLAN-trunk multi-SSID) -----------------------
# A Wireless cell hosts one or more SSIDs, each mapped to a VLAN; the cell is a
# vlan_filtering bridge (the dot1q-switch plumbing). The WLAN list is config the
# AP bakes into its hostapd multi-BSS at start, so — like the soft-router — it
# lives broker-side keyed by session+net_id, validated once here so persisted
# state and the AP's generated config share one source of truth.

RE_SSID = re.compile(r"^[A-Za-z0-9 _.-]{1,32}$")


def _wificell_state_path(s, n):
    return "%s/wificell-%d_%d.json" % (RUN_DIR, s, n)


def _wificell_save_state(s, n, cfg):
    os.makedirs(RUN_DIR, exist_ok=True)
    tmp = _wificell_state_path(s, n) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f)
    os.replace(tmp, _wificell_state_path(s, n))


def _wificell_load_state(s, n):
    try:
        with open(_wificell_state_path(s, n)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _wificell_normalize(args):
    """Validate a Wireless-cell Configure-dialog payload into a JSON-safe cfg:
    {mgmt_vlan, wlans:[{ssid,vlan,security,psk?,radius_server?,radius_secret?,
    mode,lan_cidr?}]}. SSIDs and VLANs must be unique within the cell. Every
    field passes the shared validators here, so bad state can never reach the
    AP's hostapd config; re-validated on restore too."""
    raw = args.get("wlans")
    if not isinstance(raw, list) or len(raw) > 16:
        raise Reject("bad arg wlans")
    seen_ssid, seen_vlan, wlans = set(), set(), []
    for w in raw:
        if not isinstance(w, dict):
            raise Reject("bad wlan entry")
        ssid = v_re(w, "ssid", RE_SSID)
        vlan = v_int(w, "vlan")
        if vlan < 1 or vlan > 4094:
            raise Reject("bad wlan vlan")
        sec = v_enum(w, "security",
                     {"open", "wpa2-psk", "wpa3-sae", "wpa-eap"})
        if ssid in seen_ssid:
            raise Reject("duplicate ssid")
        if vlan in seen_vlan:
            raise Reject("duplicate vlan")
        seen_ssid.add(ssid)
        seen_vlan.add(vlan)
        entry = {"ssid": ssid, "vlan": vlan, "security": sec,
                 "mode": (v_enum(w, "mode", {"bridge", "routed"})
                          if w.get("mode") is not None else "bridge")}
        if sec in ("wpa2-psk", "wpa3-sae"):
            psk = w.get("psk")
            if not isinstance(psk, str) or not (8 <= len(psk) <= 63):
                raise Reject("bad wlan psk")
            entry["psk"] = psk
        if sec == "wpa-eap":
            entry["radius_server"] = (v_ip_list(w, "radius_server")
                                      if w.get("radius_server") else "")
            rs = w.get("radius_secret", "pnetlab-radius")
            if not isinstance(rs, str) or not (1 <= len(rs) <= 64):
                raise Reject("bad radius secret")
            entry["radius_secret"] = rs
        if entry["mode"] == "routed":
            entry["lan_cidr"] = v_cidr(w, "lan_cidr")
        wlans.append(entry)
    mgmt = (v_int(args, "mgmt_vlan")
            if args.get("mgmt_vlan") is not None else 1)
    if mgmt < 1 or mgmt > 4094:
        raise Reject("bad mgmt_vlan")
    return {"mgmt_vlan": mgmt, "wlans": wlans}


def verb_wifi_cell_apply(args):
    """api.php network/manage for a wireless cell: validate + persist the WLAN
    list so the AP bakes its hostapd multi-BSS config from it at start and the
    Configure dialog round-trips. Persisting before lab start means a freshly
    dropped AP picks the WLANs up on first boot."""
    s, n = v_int(args, "session"), v_int(args, "net_id")
    cfg = _wificell_normalize(args)
    _wificell_save_state(s, n, cfg)
    return 0, [], ""


def verb_wifi_cell_get(args):
    """api_networks.php manage response: the saved WLAN cfg as one JSON line so
    the Configure dialog reopens populated. '{}' when nothing is persisted yet.
    Also the AP handler's source for the multi-BSS config at start."""
    s, n = v_int(args, "session"), v_int(args, "net_id")
    cfg = _wificell_load_state(s, n) or {}
    return 0, [json.dumps(cfg)], ""


def verb_wifi_cell_delete(args):
    """cli.php delBridge() for a wireless cell: drop the per-run WLAN state so a
    recycled net_id never inherits a previous cell's SSIDs. No-op if absent."""
    s, n = v_int(args, "session"), v_int(args, "net_id")
    try:
        os.unlink(_wificell_state_path(s, n))
    except OSError:
        pass
    return 0, [], ""


def verb_wifi_ap_refresh(args):
    """Clear a wireless AP's auto-generated cidata + first-boot markers so the next
    start regenerates the hostapd multi-BSS config from the (updated) cell WLAN
    list. Backs the cell Configure 'Save -> live-apply to running APs' path
    (api.php restarts the cabled AP around this). Only the auto-generated artifacts
    are removed; a user-saved startup-config is left untouched (the caller already
    skips manually-configured APs). No-op on any file that isn't there."""
    d = _node_dir(args)
    for f in ("config.iso", "user-data", "meta-data", "wrapper.txt", ".configured"):
        try:
            os.unlink(d + "/" + f)
        except OSError:
            pass
    return 0, [], ""


def verb_vxlan_attach(args):
    """Stitch one lab network across hosts: a vxlan device (unicast head-end
    replication towards every peer host) enslaved to the local vnet bridge.
    Idempotent — re-running replaces the peer list. Runs on master AND
    satellites (the master calls it locally via broker_call and remotely via
    cluster_call -> satd)."""
    vx, br = _vxlan_names(args)
    vni = v_int(args, "vni")
    if vni <= 0 or vni >= 1 << 24:
        raise Reject("bad vni")
    local_ip = v_ip(args, "local_ip")
    peers = v_list(args, "peers", 2)
    for p in peers:
        try:
            ipaddress.IPv4Address(p)
        except Exception:
            raise Reject("bad peer ip")
    mtu = v_int(args, "mtu") if args.get("mtu") is not None else 1450
    if mtu < 576 or mtu > 9216:
        raise Reject("bad mtu")

    _ensure_lab_bridge(br)
    if not link_exists(vx):
        rc, out, err = run(
            ["ip", "link", "add", vx, "type", "vxlan", "id", str(vni),
             "dstport", "4789", "local", local_ip, "ttl", "16"],
            timeout=30)
        if rc != 0:
            return rc, out, err
    run_quiet(["ip", "link", "set", vx, "mtu", str(mtu)])

    # head-end replication: replace-all of the 00:.. flood entries
    rc, out, _ = run(["bridge", "fdb", "show", "dev", vx], timeout=30)
    for line in out:
        parts = line.split()
        if parts and parts[0] == "00:00:00:00:00:00" and "dst" in parts:
            dst = parts[parts.index("dst") + 1]
            run_quiet(["bridge", "fdb", "del", "00:00:00:00:00:00",
                       "dev", vx, "dst", dst])
    for p in peers:
        run_quiet(["bridge", "fdb", "append", "00:00:00:00:00:00",
                   "dev", vx, "dst", p])

    run_quiet(["brctl", "addif", br, vx])     # tolerates "already a member"
    run_quiet(["ip", "link", "set", vx, "up"])
    log("vxlan: %s vni=%d on %s peers=%s mtu=%d" %
        (vx, vni, br, ",".join(peers), mtu))
    return 0, [], ""


def verb_vxlan_detach(args):
    vx, _ = _vxlan_names(args)
    if link_exists(vx):
        return run(["ip", "link", "del", vx], timeout=30)
    return 0, [], ""


def verb_cluster_sync_lab(args):
    """Ship a lab .unl master->satellite (push: before any remote wrapper run)
    or satellite->master (pull: after a remote export wrote configs into the
    satellite's copy). Rides the join-time ssh key, rrsync-jailed to
    /opt/unetlab on the satellite; -R recreates the labs/... subdirs."""
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    direction = v_enum(args, "direction", {"push", "pull"})
    lab = v_path_under(args, "lab", LABS_DIR)
    if not lab.endswith(".unl"):
        raise Reject("lab must be a .unl file")
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    rel = os.path.relpath(lab, BASE)            # labs/<dir>/<file>.unl
    ssh = ("ssh -i %s -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
           % CLUSTER_KEY)
    if direction == "push":
        if not os.path.isfile(lab):
            raise Reject("lab file missing on master")
        # the /./ marker sets where -R's relative part starts, so the file
        # lands at <jail>/labs/<dir>/<file>.unl with subdirs auto-created
        rc, out, err = run(
            ["rsync", "-a", "-R", "-e", ssh,
             BASE + "/./" + rel, "root@%s:." % h["ip"]],
            timeout=120, check_rc=False)
    else:
        rc, out, err = run(
            ["rsync", "-a", "-e", ssh,
             "root@%s:%s" % (h["ip"], rel), lab],
            timeout=120, check_rc=False)
        if rc == 0:
            # the engine (www-data) must keep write access to the lab file
            shutil.chown(lab, "www-data", "www-data")
    return rc, out, err


def verb_cluster_sync_configscripts(args):
    """Push /opt/unetlab/config_scripts master->satellite so device prep/config
    scripts (template `prep:`/`config_script:`, e.g. SD-WAN prep_c8000vcm.sh that
    builds the cEdge day-0 config.iso) exist on the satellite that runs the node.
    These scripts are not deb-owned (placed by the bundle/SD-WAN install) so a
    joined satellite can otherwise lag the master. Additive rsync (no --delete),
    same join-time ssh key + rrsync jail (/opt/unetlab) as cluster_sync_lab."""
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    if not os.path.isdir(BASE + "/config_scripts"):
        return 0, [], ""
    ssh = ("ssh -i %s -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
           % CLUSTER_KEY)
    # /./ marker: -R lands the tree at <jail>/config_scripts/ (subdirs created)
    rc, out, err = run(
        ["rsync", "-a", "-R", "-e", ssh,
         BASE + "/./config_scripts/", "root@%s:." % h["ip"]],
        timeout=120, check_rc=False)
    return rc, out, err


def verb_cluster_sync_templdefaults(args):
    """Mirror /opt/unetlab/data/template-defaults master->satellite so admin-saved
    per-template Add-Node defaults follow the cluster. A full mirror (--delete)
    keeps both saves AND reverts in lockstep — a reverted (deleted) override
    disappears on the satellite too. Dedicated dir, so --delete is safe. Same
    join-time ssh key + rrsync jail (/opt/unetlab) as cluster_sync_lab."""
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    src = BASE + "/data/template-defaults/"
    if not os.path.isdir(src):
        # nothing saved yet (or all reverted) — create an empty dir so the mirror
        # still runs and --delete clears any stale overrides on the satellite.
        try:
            os.makedirs(src, mode=0o775, exist_ok=True)
        except OSError:
            return 0, [], ""
    ssh = ("ssh -i %s -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
           % CLUSTER_KEY)
    # explicit dest subpath (not -R) so --delete prunes ONLY within
    # data/template-defaults/ on the satellite; data/ exists there already.
    rc, out, err = run(
        ["rsync", "-a", "--delete", "-e", ssh,
         src, "root@%s:data/template-defaults/" % h["ip"]],
        timeout=120, check_rc=False)
    return rc, out, err


def verb_cluster_sync_manifest(args):
    """Push the shipped docker-template capability manifest
    (/opt/unetlab/scripts/docker-template-manifest.sha256) master->satellite.
    The satellite's broker gates dangerous/free-form docker templates on this
    root-owned manifest (_manifest_trusted/_manifest_hashes): it ships inside
    the pnetlab-satellite deb but is REGENERATED on the master by
    gen-template-manifest.sh whenever a shipped template's bytes change, so a
    joined satellite would otherwise fail-closed on those templates. Same
    join-time ssh key + rrsync jail (/opt/unetlab) as cluster_sync_lab; rsync
    runs as root through the jail (root:root ownership, temp-file + rename so
    a broken transfer never leaves a partial file) and --chmod pins 0644 so
    the satellite's _manifest_trusted not-group/other-writable check passes.
    Missing/empty master manifest -> graceful no-op (the satellite keeps its
    deb-shipped copy; pushing an empty file would fail-closed EVERY dangerous
    template there)."""
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    try:
        if os.path.getsize(SHIPPED_MANIFEST) == 0:
            log("cluster_sync_manifest: manifest empty on master — skipped")
            return 0, ["manifest empty on master — skipped"], ""
    except OSError:
        log("cluster_sync_manifest: manifest missing on master — skipped")
        return 0, ["manifest missing on master — skipped"], ""
    ssh = ("ssh -i %s -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
           % CLUSTER_KEY)
    rel = os.path.relpath(SHIPPED_MANIFEST, BASE)
    # /./ marker: -R lands the file at <jail>/scripts/docker-template-
    # manifest.sha256 (scripts/ is deb-owned and already root:root there).
    rc, out, err = run(
        ["rsync", "-a", "-R", "--chmod=F0644", "-e", ssh,
         BASE + "/./" + rel, "root@%s:." % h["ip"]],
        timeout=60, check_rc=False)
    return rc, out, err


RE_IMAGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,127}$")


def verb_cluster_sync_image(args):
    """Detach a pnet-imgsync worker pushing one image to a satellite (B5
    transient-unit pattern; progress JSON polled via cluster/api.php)."""
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    typ = v_enum(args, "type", {"qemu", "iol", "dynamips", "docker"})
    img = v_re(args, "image", RE_IMAGE)
    if ".." in img:
        raise Reject("bad arg image")
    job = v_re(args, "job", RE_JOB)
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    unit = spawn_unit(
        "pnet-imgsync-" + job,
        ["/bin/bash", BASE + "/scripts/pnet-imgsync.sh",
         h["ip"], typ, img, job],
        props=("IOWeight=50",))
    return 0, ["unit " + unit], ""


def verb_cluster_deploy(args):
    """Detach a pnet-satdeploy worker: push the satellite bundle to a fresh
    Ubuntu 24.04 host over SSH (admin-supplied credentials in the 0600
    jobs/<job>.req, import-worker pattern), install it and join it."""
    job = v_re(args, "job", RE_JOB)
    req = BASE + "/html/cluster/jobs/" + job + ".req"
    if not os.path.isfile(req):
        raise Reject("deploy request missing")
    # SECURITY (Stage 0.5): the .req carries an admin-supplied "user" that
    # pnet-satdeploy.sh places into an ssh destination ("${SUSER}@${IP}"). An
    # unvalidated value like "-oProxyCommand=..." would be read by ssh as an
    # OPTION and run a command as root. Fail-fast here so an obviously-forged
    # user never even spawns the worker. NOTE: www-data owns/writes the .req, so
    # this pre-check is racy against a rewrite between here and the worker's
    # read+shred; the AUTHORITATIVE validation lives in pnet-satdeploy.sh (the
    # consumer), which also passes user/host to ssh after "--" (end-of-options).
    try:
        with open(req) as f:
            ruser = (json.load(f) or {}).get("user", "")
    except (OSError, ValueError):
        raise Reject("deploy request unreadable")
    if not RE_CLUSTER_USER.match(str(ruser)):
        raise Reject("bad ssh user in deploy request")
    unit = spawn_unit(
        "pnet-satdeploy-" + job,
        ["/bin/bash", BASE + "/scripts/pnet-satdeploy.sh", job],
        props=("MemoryMax=2G",))
    return 0, ["unit " + unit], ""


# verbs that stay usable across an engine version skew (monitoring + the
# image probe), so the Cluster page can still show what's wrong
SKEW_SAFE_VERBS = {"ping", "sysinfo", "image_check", "image_list"}
_MASTER_VERSION = None


def _master_version():
    global _MASTER_VERSION
    if _MASTER_VERSION is None:
        rc, out, _ = run(["dpkg-query", "-W", "-f", "${Version}", "pnetlab"],
                         timeout=15)
        _MASTER_VERSION = out[0].strip() if rc == 0 and out else ""
    return _MASTER_VERSION


def _ver_core(v):
    m = re.match(r"(\d+\.\d+\.\d+)", v or "")
    return m.group(1) if m else (v or "")


def verb_cluster_call(args):
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    verb = args.get("verb")
    vargs = args.get("args") or {}
    if not isinstance(verb, str) or not isinstance(vargs, dict):
        raise Reject("bad cluster_call request")
    timeout = min(900, max(5, v_int(args, "timeout"))) \
        if args.get("timeout") is not None else 60

    psk = _cluster_psk()
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)

    try:
        raw = socket.create_connection((h["ip"], SATD_PORT), timeout=10)
    except OSError as e:
        return 255, [], "satellite %d (%s) unreachable: %s" % (
            host_id, h["ip"], e)
    try:
        ctx = ssl._create_unverified_context()
        tls = ctx.wrap_socket(raw)
        der = tls.getpeercert(binary_form=True)
        fp = "sha256:" + hashlib.sha256(der).hexdigest()
        if fp != h["cert_fp"]:
            return 253, [], "satellite %d cert fingerprint mismatch" % host_id
        tls.settimeout(timeout + 10)
        f = tls.makefile("rwb")
        hello = json.loads(f.readline(MAX_REQUEST))
        nonce = hello.get("nonce", "")
        # refuse lifecycle/network verbs across an engine version skew —
        # wrapper/vxlan behaviour must match on both ends of a lab
        if verb not in SKEW_SAFE_VERBS:
            sat_ver = str(hello.get("version", ""))
            mv = _master_version()
            if mv and sat_ver and _ver_core(sat_ver) != _ver_core(mv):
                return 254, [], ("version skew: satellite %d runs %s, master %s"
                                 % (host_id, sat_ver, mv))
        mac = hmac.new(
            psk.encode(),
            (nonce + "\n" + _canonical({"args": vargs, "verb": verb})).encode(),
            hashlib.sha256).hexdigest()
        f.write((json.dumps({"verb": verb, "args": vargs, "hmac": mac})
                 + "\n").encode())
        f.flush()
        line = f.readline(MAX_REQUEST)
        if not line:
            return 255, [], "satellite %d: no response" % host_id
        resp = json.loads(line)
        return (int(resp.get("rc", 255)), list(resp.get("out", [])),
                str(resp.get("err", "")))
    except (OSError, ValueError, ssl.SSLError) as e:
        return 255, [], "satellite %d (%s) error: %s" % (host_id, h["ip"], e)
    finally:
        try:
            raw.close()
        except OSError:
            pass


#: Canonical name of the vwifi RF-medium image. It matches the shipped tarball
#: filename (docker-store/pnet-wifi-spike-1-0.tar.gz) and the pin in
#: debs/oci-images.lock. NEVER run the medium under any other reference.
VWIFI_MEDIUM_IMAGE = "pnet-wifi-spike:1.0"
#: The pre-6.8.64 tag. The bytes are identical (same image ID) — only the name
#: was wrong: the tarball's RepoTags said "wifi-spike:latest" while its filename,
#: bundle.manifest and every doc said pnet-wifi-spike:1.0.
VWIFI_MEDIUM_IMAGE_LEGACY = "wifi-spike:latest"


def _vwifi_medium_image():
    """Resolve the vwifi medium image, migrating the legacy tag forward once.

    Returns VWIFI_MEDIUM_IMAGE if it is present, or if only the legacy
    wifi-spike:latest is present (in which case it is retagged to the canonical
    name first, so the caller always runs the canonical reference). Returns None
    when neither exists. This is a one-shot rename migration, NOT a fallback to
    an unpinned reference: nothing is ever *run* under the legacy name."""
    rc, _, _ = run(["docker", "image", "inspect", VWIFI_MEDIUM_IMAGE], check_rc=False)
    if rc == 0:
        return VWIFI_MEDIUM_IMAGE
    rc, _, _ = run(["docker", "image", "inspect", VWIFI_MEDIUM_IMAGE_LEGACY], check_rc=False)
    if rc != 0:
        return None
    rc, _, _ = run(["docker", "tag", VWIFI_MEDIUM_IMAGE_LEGACY, VWIFI_MEDIUM_IMAGE],
                   check_rc=False)
    return VWIFI_MEDIUM_IMAGE if rc == 0 else None


def verb_vwifi_server_ensure(args):
    """Ensure the host-side vwifi medium server is running (the emulated RF medium for
    the Wireless AP/STA nodes). vwifi-server stitches the per-VM mac80211_hwsim radios
    over vsock; -u keys clients by their unique guest-cid. One server serves all local
    wireless cells in P1a (per-cell servers arrive with the Wireless-cell net type, P1b).
    Idempotent — safe to call on every wireless node prepare()."""
    run_quiet(["modprobe", "vhost_vsock"])
    rc, out, _ = run(["docker", "inspect", "-f", "{{.State.Running}}",
                      "pnet-vwifi-server"], check_rc=False)
    if rc == 0 and out and out[0].strip() == "true":
        _vwifi_autoplace_ensure()
        return 0, ["already-running"], ""
    run_quiet(["docker", "rm", "-f", "pnet-vwifi-server"])
    image = _vwifi_medium_image()
    if image is None:
        return 1, [], ("vwifi medium image %s not installed (and no legacy %s to "
                       "rename) — load docker-store/pnet-wifi-spike-1-0.tar.gz or "
                       "install it from Dashboard > Docker Devices"
                       % (VWIFI_MEDIUM_IMAGE, VWIFI_MEDIUM_IMAGE_LEGACY))
    # NOTE: NO -u. `-u`/--use-port-in-hash is a Docker-NAT demux hack (many TCP
    # clients behind one NAT IP); over vsock each node has a unique guest-cid, so
    # -u is unnecessary AND the recompiled (Raizo62) server mis-keys vsock clients
    # under -u so only ONE stays registered at a time (others silently drop -> a
    # client never hears the AP's beacons). Plain `vwifi-server` keys by CID and
    # holds all nodes.
    rc, out, err = run(["docker", "run", "-d", "--name", "pnet-vwifi-server",
                        "--privileged", "--network", "host", "--restart", "unless-stopped",
                        image, "vwifi-server"], check_rc=False)
    if rc != 0:
        return rc, out, "vwifi-server start failed: " + err.strip()
    _vwifi_autoplace_ensure()
    return 0, ["started"], ""


def _vwifi_autoplace_ensure():
    """Ensure the auto-placer loop is running so newly-joined wireless nodes link
    without manual placement (P2 canvas-coupling overrides per-node coords later)."""
    rc, _, _ = run(["systemctl", "is-active", "pnet-vwifi-autoplace.service"],
                   check_rc=False)
    if rc == 0:
        return
    try:
        spawn_unit("pnet-vwifi-autoplace",
                   ["/bin/bash", "/opt/unetlab/scripts/vwifi-autoplace.sh"])
    except Exception:
        pass


def verb_airhandler_ensure(args):
    """Ensure the host-side airhandler is running — the clean-room RF-medium
    arbiter for the Cisco VAP (and CML wireless-client) nodes. Their in-guest
    `airduct` client connects over a per-node virtio-serial unix socket
    (/opt/unetlab/tmp/<s>/<n>/airduct.sock, qemu listens) to request radio MACs
    and relay 802.11 frames; without it airduct exit(1)s and capwapd never joins.
    Runs as a transient systemd unit (single-instance-guarded by the daemon).
    Idempotent — called from every VAP/wireless node prepare()."""
    rc, _, _ = run(["systemctl", "is-active", "pnet-airhandler.service"],
                   check_rc=False)
    if rc == 0:
        return 0, ["already-running"], ""
    try:
        spawn_unit("pnet-airhandler",
                   ["/usr/bin/python3", "/opt/unetlab/scripts/airhandler.py"])
    except Exception as e:
        return 1, [], "airhandler start failed: %s" % e
    return 0, ["started"], ""


def verb_vwifi_ctrl(args):
    """Drive vwifi-ctrl against the running medium server: node placement (positions),
    naming, packet-loss + scale toggles, and listing. The canvas RF coupling / Wi-Fi
    Painter (P2) maps node left/top -> set <cid> x y z through this verb."""
    sub = v_enum(args, "cmd", ["ls", "set", "setname", "loss", "scale", "distance"])
    cargv = ["docker", "exec", "pnet-vwifi-server", "vwifi-ctrl", sub]
    # CIDs are the node guest-cid = crc32(uuid)%0x7fff0000 + 0x10000, up to ~2.1e9
    # (10 digits). The old 9-digit cap silently rejected every real set/setname/
    # distance, so vwifi node placement never took effect. Allow 10.
    cidrx = re.compile(r"^[0-9]{1,10}$")
    intrx = re.compile(r"^-?[0-9]{1,9}$")
    namerx = re.compile(r"^[A-Za-z0-9_\- ]{1,32}$")
    scalerx = re.compile(r"^[0-9]+(\.[0-9]+)?$")
    if sub == "set":
        cargv += [v_re(args, "cid", cidrx), v_re(args, "x", intrx),
                  v_re(args, "y", intrx), v_re(args, "z", intrx)]
    elif sub == "setname":
        cargv += [v_re(args, "cid", cidrx), v_re(args, "name", namerx)]
    elif sub == "loss":
        cargv += [v_enum(args, "value", ["yes", "no"])]
    elif sub == "scale":
        cargv += [v_re(args, "value", scalerx)]
    elif sub == "distance":
        cargv += [v_re(args, "cid", cidrx), v_re(args, "cid2", cidrx)]
    rc, out, err = run(cargv, check_rc=False)
    return rc, out, err


def verb_wifi_capture(args):
    """Start/stop/status the OPT-IN 802.11 pcap tee for a lab session. The airhandler
    writes every frame crossing the medium to /opt/unetlab/tmp/<session>/wifi-<s>.pcap
    ONLY while the marker /opt/unetlab/tmp/<session>/wifi-capture exists, so this verb
    just touches/removes the marker (no unconditional disk burn) and reports the pcap
    path + whether it has frames yet. Backs a 'Capture Wi-Fi' control that hands the
    pcap to Wireshark (download / web-capture)."""
    session = v_int(args, "session")
    if session <= 0:
        raise Reject("bad arg session")
    action = v_enum(args, "action", ["start", "stop", "status"])
    # medium selects which tee's marker/pcap this arms: airduct (airhandler _flood tee,
    # cvap/cwificlient) or vwifi (vwifi-server spy-port tee, wifiap/wifista). Distinct
    # marker + pcap names so both can be armed in one lab.
    medium = (v_enum(args, "medium", ["airduct", "vwifi"])
              if args.get("medium") is not None else "airduct")
    sdir = "/opt/unetlab/tmp/%d" % session
    if medium == "vwifi":
        marker = sdir + "/wifi-vwifi-capture"
        pcap = sdir + "/wifi-vwifi-%d.pcap" % session
    else:
        marker = sdir + "/wifi-capture"
        pcap = sdir + "/wifi-%d.pcap" % session
    unit = "pnet-wifi-spy-%d" % session          # vwifi spy-tee transient unit
    if action == "start":
        if not os.path.isdir(sdir):
            raise Reject("no such session dir")
        try:
            open(marker, "a").close()
        except OSError as e:
            raise Reject("cannot arm capture: %s" % e)
        # airduct is teed inside the always-running airhandler (marker is enough).
        # vwifi needs a dedicated process connected to the vwifi-server SPY port;
        # spawn it as a transient unit — it self-exits when the marker is removed.
        if medium == "vwifi":
            run_quiet(["systemctl", "reset-failed", unit + ".service"])
            try:
                spawn_unit(unit, ["/usr/bin/python3",
                                  BASE + "/scripts/vwifi-spy-capture.py",
                                  "--pcap", pcap, "--marker", marker])
            except Exception as e:                # noqa: BLE001
                raise Reject("cannot start vwifi spy capture: %s" % e)
    elif action == "stop":
        try:
            os.unlink(marker)                    # the spy process self-exits on this
        except OSError:
            pass
        if medium == "vwifi":
            run_quiet(["systemctl", "stop", unit + ".service"])
    armed = os.path.exists(marker)
    size = os.path.getsize(pcap) if os.path.exists(pcap) else 0
    return 0, [json.dumps({"armed": armed, "pcap": pcap, "bytes": size})], ""


def verb_wifi_truth(args):
    """Read the REAL 802.11 association state of ONE wireless node over its serial
    console and return it as one JSON line. Backs the Wi-Fi Painter's truth overlay
    (pnq-wifi.php ?truth=1): the painter's association/RSSI is MODELLED, so this lets
    it flag model-vs-actual divergence (e.g. a wrong-PSK station that "looks"
    connected but never completed the 4-way handshake). The telnet/expect + parsing
    lives in pnet-wifi-truth.py; only a fixed whitelist of read-only query commands
    (wpa_cli status / hostapd_cli all_sta / cat of /proc+/sys) is ever run.
    host is ALWAYS forced to 127.0.0.1 — this verb only reads consoles local to this
    host (same policy as node_config_push)."""
    role = v_enum(args, "role", ["ap", "sta"])
    ifc = args.get("ifc", "wlan0")
    if not (isinstance(ifc, str) and re.match(r"^wlan[0-9](_[0-9]+)?$", ifc)):
        raise Reject("bad arg ifc")
    # Prefer the qemu console UNIX socket (always present while a node runs); the TCP
    # telnet port only listens when the on-demand web-console bridge is up, so it is an
    # unreliable target for an unattended read. `sock` must be a node console.sock under
    # the tmp tree — never an arbitrary path.
    argv = ["/usr/bin/python3", BASE + "/scripts/pnet-wifi-truth.py",
            "--role", role, "--ifc", ifc]
    sock = args.get("sock")
    if sock is not None:
        if not (isinstance(sock, str)
                and re.match(r"^/opt/unetlab/tmp/\d+/\d+/console\.sock$", sock)):
            raise Reject("bad arg sock")
        argv += ["--sock", sock]
    else:
        port = v_int(args, "port")
        if not (1 <= port <= 65535):
            raise Reject("bad arg port")
        argv += ["--host", "127.0.0.1", "--port", str(port)]
    rc, out, err = run(argv, timeout=45)
    if rc != 0 and not out:
        raise Reject("wifi-truth: " + (err.strip() or ("rc=%d" % rc)))
    return 0, out, ""                                   # out = one JSON line


def _roce_agent_get(cid, resource):
    """GET one controller-owned resource; ``resource`` never comes from a request."""
    if resource not in ("/v1/health", "/v1/inventory"):
        raise Reject("bad RoCE agent resource")
    request = ("GET %s HTTP/1.1\r\n" % resource).encode("ascii") + (
        b"Host: vsock\r\n"
        b"Accept: application/json\r\n"
        b"Connection: close\r\n\r\n")
    chunks = []
    total = 0
    wire_limit = ROCE_AGENT_MAX_RESPONSE + 8192
    deadline = time.monotonic() + ROCE_AGENT_TIMEOUT
    sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try:
        sock.settimeout(max(0.001, deadline - time.monotonic()))
        sock.connect((cid, ROCE_AGENT_PORT))
        sock.settimeout(max(0.001, deadline - time.monotonic()))
        sock.sendall(request)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Reject("agent probe timed out")
            sock.settimeout(remaining)
            chunk = sock.recv(min(4096, wire_limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > wire_limit:
                raise Reject("agent HTTP response exceeded its bound")
    except (OSError, socket.timeout):
        raise Reject("agent probe failed")
    finally:
        sock.close()

    raw = b"".join(chunks)
    head, sep, body = raw.partition(b"\r\n\r\n")
    if not sep or len(head) > 8192:
        raise Reject("agent returned malformed HTTP")
    if len(body) > ROCE_AGENT_MAX_RESPONSE:
        raise Reject("agent JSON response exceeded 32768 bytes")
    lines = head.split(b"\r\n")
    if not lines or lines[0] not in (b"HTTP/1.1 200 OK", b"HTTP/1.0 200 OK"):
        raise Reject("agent request was not successful")
    headers = {}
    for line in lines[1:]:
        name, colon, value = line.partition(b":")
        if not colon:
            raise Reject("agent returned malformed HTTP headers")
        try:
            key = name.decode("ascii").strip().lower()
            val = value.decode("ascii").strip()
        except UnicodeDecodeError:
            raise Reject("agent returned malformed HTTP headers")
        if key in headers:
            raise Reject("agent returned duplicate HTTP headers")
        headers[key] = val
    if headers.get("transfer-encoding"):
        raise Reject("agent response must not be transfer encoded")
    if not headers.get("content-type", "").lower().startswith("application/json"):
        raise Reject("agent response is not JSON")
    if "content-length" in headers:
        if not re.match(r"^[0-9]{1,5}$", headers["content-length"]):
            raise Reject("agent returned invalid content length")
        if int(headers["content-length"]) != len(body):
            raise Reject("agent returned incomplete document")
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Reject("agent returned invalid JSON")
    if not isinstance(document, dict):
        raise Reject("agent JSON must be an object")
    if document.get("api_version") != "rxe-agent/v1":
        raise Reject("agent API version mismatch")
    return document


def _roce_agent_post(cid, resource, document):
    allowed = {"/v1/prepare", "/v1/start-server", "/v1/readiness",
               "/v1/start-client", "/v1/status", "/v1/cancel", "/v1/result"}
    if resource not in allowed or not isinstance(document, dict):
        raise Reject("bad RoCE workload request")
    body = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(body) > 8192:
        raise Reject("RoCE workload request exceeded its bound")
    request = (("POST %s HTTP/1.1\r\n" % resource).encode("ascii") +
               b"Host: vsock\r\nAccept: application/json\r\nContent-Type: application/json\r\n" +
               ("Content-Length: %d\r\n" % len(body)).encode("ascii") +
               b"Connection: close\r\n\r\n" + body)
    chunks, total = [], 0
    deadline = time.monotonic() + 5.0
    sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try:
        sock.settimeout(5.0); sock.connect((cid, ROCE_AGENT_PORT)); sock.sendall(request)
        while True:
            sock.settimeout(max(0.001, deadline - time.monotonic()))
            chunk = sock.recv(min(4096, ROCE_AGENT_MAX_RESPONSE + 8193 - total))
            if not chunk: break
            chunks.append(chunk); total += len(chunk)
            if total > ROCE_AGENT_MAX_RESPONSE + 8192: raise Reject("agent HTTP response exceeded its bound")
    except (OSError, socket.timeout): raise Reject("agent workload request failed")
    finally: sock.close()
    raw = b"".join(chunks); head, sep, response_body = raw.partition(b"\r\n\r\n")
    if not sep or len(head) > 8192 or len(response_body) > ROCE_AGENT_MAX_RESPONSE: raise Reject("agent returned malformed workload HTTP")
    lines = head.split(b"\r\n")
    if lines[0] not in (b"HTTP/1.1 200 OK", b"HTTP/1.0 200 OK"): raise Reject("agent workload operation was rejected")
    headers = {}
    for line in lines[1:]:
        name, colon, value = line.partition(b":")
        if not colon: raise Reject("agent returned malformed workload headers")
        try: key, val = name.decode("ascii").strip().lower(), value.decode("ascii").strip()
        except UnicodeDecodeError: raise Reject("agent returned malformed workload headers")
        if key in headers: raise Reject("agent returned duplicate workload headers")
        headers[key] = val
    if headers.get("transfer-encoding") or not headers.get("content-type", "").lower().startswith("application/json"): raise Reject("agent returned invalid workload encoding")
    if not re.fullmatch(r"[0-9]{1,5}", headers.get("content-length", "")) or int(headers["content-length"]) != len(response_body): raise Reject("agent returned incomplete workload document")
    try: result = json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError): raise Reject("agent returned invalid workload JSON")
    if not isinstance(result, dict) or result.get("api_version") != ROCE_WORKLOAD_API: raise Reject("agent workload API version mismatch")
    return result


def _roce_cid(node_session, node_uuid):
    return (zlib.crc32(("%d:%s" % (node_session, node_uuid)).encode()) % 0x7fff0000) + 0x10000


def _roce_owned_qemu(lab_session, node_session, cid, node_uuid):
    runtime = "/opt/unetlab/tmp/%d/%d/" % (lab_session, node_session)
    cid_arg = re.compile(r"(?:^|,)guest-cid=%d(?:,|$)" % cid)
    for pid in os.listdir("/proc"):
        if not pid.isdigit(): continue
        try:
            exe = os.path.basename(os.readlink("/proc/%s/exe" % pid))
            with open("/proc/%s/stat" % pid, "rb") as f: stat_tail = f.read(4096).rpartition(b") ")[2]
            with open("/proc/%s/cmdline" % pid, "rb") as f: argv = [p.decode("ascii", "ignore") for p in f.read(262144).split(b"\0") if p]
        except OSError: continue
        uuid_match = any(arg == "-uuid=" + node_uuid for arg in argv)
        uuid_match = uuid_match or any(argv[i] == "-uuid" and i + 1 < len(argv) and argv[i + 1] == node_uuid for i in range(len(argv)))
        if (exe.startswith("qemu-system-") and stat_tail and stat_tail[:1] != b"Z" and uuid_match and
                any(runtime in arg for arg in argv) and any(cid_arg.search(arg) for arg in argv)): return True
    return False


def _roce_endpoint(args, key, lab_session):
    value = args.get(key)
    if not isinstance(value, dict) or set(value) != {"node_session", "node_uuid"}: raise Reject("bad RoCE prepare shape")
    node_session, node_uuid = value.get("node_session"), value.get("node_uuid")
    if isinstance(node_session, bool) or not isinstance(node_session, int) or not 1 <= node_session <= 0x7fffffff: raise Reject("bad %s node_session" % key)
    if not isinstance(node_uuid, str) or not RE_ROCE_UUID.fullmatch(node_uuid): raise Reject("bad %s node_uuid" % key)
    cid = _roce_cid(node_session, node_uuid)
    if not _roce_owned_qemu(lab_session, node_session, cid, node_uuid): raise Reject("no live node-runtime QEMU owns %s" % key)
    health, inventory = _roce_agent_get(cid, "/v1/health"), _roce_agent_get(cid, "/v1/inventory")
    iface, addresses = inventory.get("data_interface"), []
    for item in inventory.get("interfaces", []):
        if isinstance(item, dict) and item.get("name") == iface:
            for candidate in item.get("addresses", []):
                try: parsed = ipaddress.ip_interface(candidate)
                except ValueError: continue
                if parsed.version == 4 and not parsed.ip.is_unspecified and not parsed.ip.is_loopback and not parsed.ip.is_multicast: addresses.append(str(parsed.ip))
    addresses = sorted(set(addresses))
    devices = inventory.get("rdma", {}).get("devices", [])
    rxe0 = [d for d in devices if isinstance(d, dict) and d.get("name") == "rxe0"]
    rxe0_ready = False
    if len(rxe0) == 1:
        for port in rxe0[0].get("ports", []):
            active = "ACTIVE" in str(port.get("state", "")).upper().split()
            attached_gid = any(gid.get("netdev") == iface and gid.get("value") not in ("", "::") for gid in port.get("gids", []) if isinstance(gid, dict))
            rxe0_ready = rxe0_ready or (active and attached_gid)
    if len(addresses) != 1 or not rxe0_ready or not inventory.get("rdma", {}).get("rxe_ready"): raise Reject("%s endpoint is not unambiguously RXE ready" % key)
    if not health.get("boot_id") or not health.get("instance_id"): raise Reject("%s agent identity is incomplete" % key)
    return {"node_session": node_session, "node_uuid": node_uuid, "cid": cid, "boot_id": health["boot_id"], "instance_id": health["instance_id"], "local_ip": addresses[0], "data_interface": iface, "rxe_device": "rxe0"}


def _roce_revalidate(record, side):
    endpoint = record[side]
    if not _roce_owned_qemu(record["lab_session"], endpoint["node_session"], endpoint["cid"], endpoint["node_uuid"]): raise Reject("RoCE runtime identity changed")
    probe = {side: {"node_session": endpoint["node_session"], "node_uuid": endpoint["node_uuid"]}}
    current = _roce_endpoint(probe, side, record["lab_session"])
    for key in ("cid", "boot_id", "instance_id", "local_ip", "data_interface", "rxe_device"):
        if current.get(key) != endpoint.get(key): raise Reject("RoCE endpoint identity changed")


def _roce_run_path(run_id):
    if not isinstance(run_id, str) or not RE_ROCE_RUN.fullmatch(run_id): raise Reject("bad arg run_id")
    return os.path.join(ROCE_RUN_DIR, run_id + ".json")


def _roce_ensure_run_dir():
    parent = os.path.dirname(ROCE_RUN_DIR)
    if os.path.islink(parent): raise Reject("invalid RoCE state parent")
    os.makedirs(ROCE_RUN_DIR, mode=0o700, exist_ok=True)
    st = os.lstat(ROCE_RUN_DIR)
    if os.path.islink(ROCE_RUN_DIR) or not os.path.isdir(ROCE_RUN_DIR) or st.st_uid != 0 or (st.st_mode & 0o077): raise Reject("invalid RoCE state directory")


def _roce_write_run(record):
    _roce_ensure_run_dir(); path = _roce_run_path(record["run_id"])
    fd, tmp = tempfile.mkstemp(prefix="." + record["run_id"], dir=ROCE_RUN_DIR, text=True)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f: json.dump(record, f, sort_keys=True, separators=(",", ":")); f.write("\n"); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try: os.close(fd)
        except OSError: pass
        try: os.unlink(tmp)
        except OSError: pass
        raise


def _roce_read_run(run_id):
    _roce_ensure_run_dir()
    path = _roce_run_path(run_id)
    try:
        st = os.lstat(path)
        if os.path.islink(path) or st.st_size > 65536: raise Reject("invalid RoCE run record")
        with open(path, "r", encoding="utf-8") as f: record = json.load(f)
    except (OSError, ValueError): raise Reject("unknown RoCE run")
    if not isinstance(record, dict) or record.get("run_id") != run_id: raise Reject("invalid RoCE run record")
    return record


def _roce_agent_body(record, side, prepare=False):
    endpoint = record[side]
    body = {"api_version": ROCE_WORKLOAD_API, "run_id": record["run_id"], "owner": {"lab_session": record["lab_session"], "node_session": endpoint["node_session"], "boot_id": endpoint["boot_id"], "cid": endpoint["cid"]}}
    if prepare:
        other = record["client" if side == "server" else "server"]
        body.update({"tool": record["tool"], "role": side, "local_ip": endpoint["local_ip"], "peer_ip": other["local_ip"], "lease_seconds": record["lease_seconds"]})
    return body


def _roce_pair_pass(record):
    for side in ("server", "client"):
        result, endpoint = record.get("roles", {}).get(side, {}), record[side]; cleanup = result.get("cleanup", {})
        exit_code = result.get("exit_code")
        hashes = ("rdma_before_sha256", "rdma_after_sha256", "qdisc_before_sha256", "qdisc_after_sha256")
        raw_pairs = (("rdma_before", "rdma_after", "rdma_before_sha256", "rdma_after_sha256"), ("qdisc_before", "qdisc_after", "qdisc_before_sha256", "qdisc_after_sha256"))
        if (result.get("api_version") != ROCE_WORKLOAD_API or result.get("run_id") != record["run_id"] or result.get("role") != side or result.get("tool") != record["tool"] or
                result.get("state") != "succeeded" or isinstance(exit_code, bool) or exit_code != 0 or result.get("forced") is not False or result.get("truncated") is not False or
                result.get("boot_id") != endpoint["boot_id"] or result.get("instance_id") != endpoint["instance_id"] or cleanup.get("complete") is not True or
                cleanup.get("processes_remaining") is not False or cleanup.get("rdma_unchanged") is not True or cleanup.get("qdisc_unchanged") is not True or
                any(not isinstance(cleanup.get(k), str) or not re.fullmatch(r"[0-9a-f]{64}", cleanup[k]) for k in hashes) or
                cleanup["rdma_before_sha256"] != cleanup["rdma_after_sha256"] or cleanup["qdisc_before_sha256"] != cleanup["qdisc_after_sha256"] or
                result.get("pid", 0) != 0 or result.get("error", "") != "" or cleanup.get("error", "") != "" or
                any(not isinstance(cleanup.get(before), str) or cleanup.get(before) != cleanup.get(after) or hashlib.sha256(cleanup[before].encode()).hexdigest() != cleanup.get(before_hash) or hashlib.sha256(cleanup[after].encode()).hexdigest() != cleanup.get(after_hash) for before, after, before_hash, after_hash in raw_pairs) or
                not _roce_output_valid(record["tool"], result.get("output", ""))): return False
    return True


def _roce_output_valid(tool, output):
    if not isinstance(output, str) or len(output.encode("utf-8")) > 8192: return False
    if tool == "rping": return "ping data: rdma-ping-0:" in output
    expected, minimum = (64, 7) if tool == "ib_write_lat" else (4096, 5)
    for line in output.splitlines():
        fields = line.split()
        if len(fields) < minimum or fields[:2] != [str(expected), "100"]: continue
        try: values = [float(v) for v in fields[2:]]
        except ValueError: continue
        if all(math.isfinite(v) and v >= 0 for v in values) and any(v > 0 for v in values): return True
    return False


def _roce_outcome_state(record, states, default="failed", cleanup_failed=False):
    """Apply the immutable pair-outcome precedence in one place."""
    outcome_lock = record.get("outcome_lock")
    if cleanup_failed or outcome_lock == "cleanup_failed" or "cleanup_failed" in states:
        return "cleanup_failed"
    if outcome_lock in ("failed", "cancelled"):
        return outcome_lock
    if "failed" in states:
        return "failed"
    if "cancelled" in states:
        return "cancelled"
    return default


def _roce_reconciled_state(record):
    """Keep a latched outcome when an expired endpoint can be released safely."""
    states = [record.get("state")]
    states.extend(role.get("state") for role in record.get("roles", {}).values())
    return _roce_outcome_state(record, states)


def _roce_public_payload(record):
    public = {k: v for k, v in record.items() if k not in ("server", "client", "roles")}
    public["server"] = {"node_session": record["server"]["node_session"], "result": record["roles"].get("server")}
    public["client"] = {"node_session": record["client"]["node_session"], "result": record["roles"].get("client")}
    payload = json.dumps(public, sort_keys=True, separators=(",", ":"))
    if len(payload.encode("utf-8")) > 60000: raise Reject("RoCE broker response exceeded its bound")
    return payload


def verb_roce_workload(args):
    if not isinstance(args, dict) or args.get("api_version") != ROCE_BROKER_API: raise Reject("bad RoCE broker API version")
    operation = args.get("operation")
    with ROCE_WORKLOAD_LOCK:
        if operation == "reset-pair":
            if set(args) != {"api_version", "operation", "lab_session", "server", "client"}: raise Reject("bad RoCE reset shape")
            lab_session = v_int(args, "lab_session")
            if not 1 <= lab_session <= 0x7fffffff: raise Reject("bad RoCE bounds")
            server = _roce_endpoint(args, "server", lab_session); client = _roce_endpoint(args, "client", lab_session)
            if server["node_session"] == client["node_session"] or server["cid"] == client["cid"]: raise Reject("RoCE endpoints must be distinct")
            selected = {server["node_session"], client["node_session"]}
            _roce_ensure_run_dir()
            names = [n for n in os.listdir(ROCE_RUN_DIR) if n.endswith(".json") and RE_ROCE_RUN.fullmatch(n[:-5])]
            reset_count, attention = 0, 0
            for name in names:
                prior = _roce_read_run(name[:-5])
                involved = any(prior.get(side, {}).get("node_session") in selected for side in ("server", "client"))
                if prior.get("lab_session") != lab_session or prior.get("terminal") or not involved: continue
                try:
                    _, out, _ = verb_roce_workload({"api_version": ROCE_BROKER_API, "operation": "cancel",
                                                     "lab_session": lab_session, "run_id": prior["run_id"]})
                    result = json.loads(out[0])
                    if result.get("terminal") is True and result.get("state") in ("passed", "failed", "cancelled"):
                        reset_count += 1
                    else:
                        attention += 1
                except Exception:
                    attention += 1
            state = "reset" if attention == 0 else "attention"
            payload = {"api_version": ROCE_BROKER_API, "state": state, "terminal": attention == 0,
                       "reset_count": reset_count, "attention_count": attention}
            if attention:
                payload["error"] = "One or more owned workloads could not prove clean terminal cleanup; reservations remain protected."
            return 0, [json.dumps(payload, sort_keys=True, separators=(",", ":"))], ""
        if operation == "prepare":
            if set(args) != {"api_version", "operation", "lab_session", "server", "client", "tool", "lease_seconds"}: raise Reject("bad RoCE prepare shape")
            lab_session, lease = v_int(args, "lab_session"), v_int(args, "lease_seconds")
            if not 1 <= lab_session <= 0x7fffffff or not 1 <= lease <= 120: raise Reject("bad RoCE bounds")
            tool = v_enum(args, "tool", {"rping", "ib_write_lat", "ib_write_bw"}); server = _roce_endpoint(args, "server", lab_session); client = _roce_endpoint(args, "client", lab_session)
            if server["node_session"] == client["node_session"] or server["cid"] == client["cid"]: raise Reject("RoCE endpoints must be distinct")
            _roce_ensure_run_dir(); records = [n for n in os.listdir(ROCE_RUN_DIR) if n.endswith(".json") and RE_ROCE_RUN.fullmatch(n[:-5])]
            if len(records) >= ROCE_RUN_LIMIT:
                clean = sorted((_roce_read_run(n[:-5]) for n in records), key=lambda r: r.get("created_at", 0))
                for prior in clean:
                    if len(records) < ROCE_RUN_LIMIT // 2: break
                    if prior.get("terminal") and prior.get("state") in ("passed", "failed", "cancelled"):
                        roles = prior.get("roles", {})
                        if set(roles) == {"server", "client"} and all(v.get("cleanup", {}).get("complete") is True for v in roles.values()):
                            os.unlink(_roce_run_path(prior["run_id"])); records.remove(prior["run_id"] + ".json")
            if len(records) >= ROCE_RUN_LIMIT: raise Reject("RoCE run retention limit reached")
            for name in records:
                prior = _roce_read_run(name[:-5])
                if not prior.get("terminal") and time.time() >= prior.get("created_at", 0) + prior.get("lease_seconds", 120) + 5:
                    present = [_roce_owned_qemu(prior["lab_session"], prior[s]["node_session"], prior[s]["cid"], prior[s]["node_uuid"]) for s in ("server", "client")]
                    if not any(present):
                        prior["state"], prior["terminal"] = _roce_reconciled_state(prior), True
                        prior["error"] = "lease expired after endpoints stopped"
                        _roce_write_run(prior)
                    else:
                        try:
                            stale, clean = False, True
                            for index, side in enumerate(("server", "client")):
                                if not present[index]: continue
                                health = _roce_agent_get(prior[side]["cid"], "/v1/health")
                                if health.get("boot_id") != prior[side]["boot_id"] or health.get("instance_id") != prior[side]["instance_id"]: stale = True; continue
                                prior["roles"][side] = _roce_agent_post(prior[side]["cid"], "/v1/status", _roce_agent_body(prior, side))
                                clean = clean and prior["roles"][side].get("cleanup", {}).get("complete") is True and prior["roles"][side].get("state") in ("succeeded", "failed", "cancelled")
                            if stale or clean:
                                prior["state"], prior["terminal"] = _roce_reconciled_state(prior), True
                                prior["error"] = "stale endpoint identity" if stale else "broker lease reconciliation"
                                _roce_write_run(prior)
                        except Reject: pass
                if not prior.get("terminal") and any(prior.get(side, {}).get("node_session") in (server["node_session"], client["node_session"]) for side in ("server", "client")): raise Reject("RoCE endpoint already reserved")
            run_id = secrets.token_hex(16); record = {"api_version": ROCE_BROKER_API, "run_id": run_id, "lab_session": lab_session, "tool": tool, "lease_seconds": lease, "server": server, "client": client, "roles": {}, "state": "preparing", "terminal": False, "created_at": time.time()}; _roce_write_run(record)
            try:
                for side in ("server", "client"): record["roles"][side] = _roce_agent_post(record[side]["cid"], "/v1/prepare", _roce_agent_body(record, side, True))
                record["state"] = "prepared"
            except Exception:
                for side in record["roles"]:
                    try: _roce_agent_post(record[side]["cid"], "/v1/cancel", _roce_agent_body(record, side))
                    except Exception: pass
                record["state"], record["terminal"] = "failed", False; _roce_write_run(record); raise
        else:
            if set(args) != {"api_version", "operation", "lab_session", "run_id"} or operation not in {"start-server", "readiness", "start-client", "status", "cancel", "result"}: raise Reject("bad RoCE workload operation shape")
            lab_session, record = v_int(args, "lab_session"), _roce_read_run(args.get("run_id"))
            if record.get("lab_session") != lab_session: raise Reject("RoCE run ownership mismatch")
            if record.get("terminal"):
                if operation in ("start-server", "readiness", "start-client"): raise Reject("RoCE run is terminal")
                return 0, [_roce_public_payload(record)], ""
            for side in ("server", "client"): _roce_revalidate(record, side)
            if operation == "start-client":
                ready = _roce_agent_post(record["server"]["cid"], "/v1/readiness", _roce_agent_body(record, "server"))
                record["roles"]["server"] = ready
                if ready.get("state") != "ready": _roce_write_run(record); raise Reject("RoCE server listener is not ready")
            targets = ("server", "client") if operation in ("status", "cancel", "result") else (("client",) if operation == "start-client" else ("server",))
            if operation == "cancel":
                for side in ("server", "client"):
                    record["roles"][side] = _roce_agent_post(record[side]["cid"], "/v1/status", _roce_agent_body(record, side))
                prior_states = [record["roles"][side].get("state") for side in ("server", "client")]
                if not record.get("outcome_lock") and all(state == "succeeded" for state in prior_states) and _roce_pair_pass(record):
                    record["pair_pass"], record["state"], record["terminal"] = True, "passed", True
                    _roce_write_run(record)
                    return 0, [_roce_public_payload(record)], ""
                record["outcome_lock"] = _roce_outcome_state(record, prior_states, default="cancelled")
                record["state"] = "cancel_requested"; record["cancel_requested"] = True; _roce_write_run(record)
            for side in targets:
                record["roles"][side] = _roce_agent_post(record[side]["cid"], "/v1/" + operation, _roce_agent_body(record, side))
            if operation == "status":
                observed = [record["roles"].get(side, {}).get("state") for side in ("server", "client")]
                if any(state in ("failed", "cancelled", "cleanup_failed") for state in observed):
                    # One role cannot make progress after its peer has failed.
                    # Latch the outcome before transport cleanup so a partial
                    # cancel failure can never be relabelled as a later PASS.
                    record["outcome_lock"] = _roce_outcome_state(record, observed)
                    record["state"] = "peer_cleanup"
                    _roce_write_run(record)
                    for side in ("server", "client"):
                        state = record["roles"].get(side, {}).get("state")
                        if state not in ("succeeded", "failed", "cancelled", "cleanup_failed"):
                            record["roles"][side] = _roce_agent_post(
                                record[side]["cid"], "/v1/cancel", _roce_agent_body(record, side))
            record["state"] = operation
            states = [record["roles"].get(side, {}).get("state") for side in ("server", "client")]
            clean = all(record["roles"].get(side, {}).get("cleanup", {}).get("complete") is True for side in ("server", "client"))
            if operation == "result":
                record["pair_pass"] = not record.get("outcome_lock") and _roce_pair_pass(record)
                if record["pair_pass"]: record["state"] = "passed"
                else: record["state"] = _roce_outcome_state(record, states, cleanup_failed=not clean)
                record["terminal"] = clean
            elif operation in ("cancel", "status") and ("cleanup_failed" in states or record.get("outcome_lock") == "cleanup_failed"):
                record["state"], record["pair_pass"], record["terminal"] = "cleanup_failed", False, False
            elif operation == "status" and clean and all(state in ("succeeded", "failed", "cancelled") for state in states):
                record["pair_pass"] = not record.get("outcome_lock") and _roce_pair_pass(record)
                record["state"] = "passed" if record["pair_pass"] else _roce_outcome_state(record, states)
                record["terminal"] = True
            elif operation in ("cancel", "status") and record.get("outcome_lock") and clean and all(state in ("succeeded", "failed", "cancelled") for state in states):
                record["state"] = record["outcome_lock"]
                record["pair_pass"], record["terminal"] = False, True
        _roce_write_run(record)
        return 0, [_roce_public_payload(record)], ""


def verb_roce_agent_health(args):
    """Read one RXE guest's typed health + inventory over host -> guest vsock.

    PHP derives both session IDs and ``cid`` from an authenticated active-lab node
    whose template is exactly ``rxe``. The vsock port, two HTTP resources,
    timeout and per-response ceiling are fixed here. It never invokes a shell,
    subprocess, URL parser, or caller path.
    """
    if set(args) != {"lab_session", "node_session", "cid"}:
        raise Reject("roce_agent_health accepts only lab_session, node_session and cid")
    lab_session = v_int(args, "lab_session")
    node_session = v_int(args, "node_session")
    if not (1 <= lab_session <= 0x7fffffff):
        raise Reject("bad arg lab_session")
    if not (1 <= node_session <= 0x7fffffff):
        raise Reject("bad arg node_session")
    cid = v_int(args, "cid")
    if not (0x10000 <= cid <= 0x7fffffff):
        raise Reject("bad arg cid")
    if not hasattr(socket, "AF_VSOCK"):
        return 1, [], "vsock is not supported by this host Python"
    runtime = "/opt/unetlab/tmp/%d/%d/" % (lab_session, node_session)
    cid_arg = re.compile(r"(?:^|,)guest-cid=%d(?:,|$)" % cid)
    owned_qemu = False
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        proc = "/proc/" + pid
        try:
            exe = os.path.basename(os.readlink(proc + "/exe"))
            if not exe.startswith("qemu-system-"):
                continue
            with open(proc + "/stat", "rb") as f:
                stat_tail = f.read(4096).rpartition(b") ")[2]
            if not stat_tail or stat_tail[:1] == b"Z":
                continue
            with open(proc + "/cmdline", "rb") as f:
                argv = [part.decode("ascii", "ignore")
                        for part in f.read(262144).split(b"\0") if part]
        except OSError:
            continue
        has_runtime = any(runtime in arg for arg in argv)
        if has_runtime and any(cid_arg.search(arg) for arg in argv):
            owned_qemu = True
            break
    if not owned_qemu:
        return 1, [], "no live node-runtime QEMU has that guest CID"
    try:
        health = _roce_agent_get(cid, "/v1/health")
        inventory = _roce_agent_get(cid, "/v1/inventory")
    except Reject as e:
        return 1, [], str(e)
    return 0, [json.dumps({"health": health, "inventory": inventory},
                          separators=(",", ":"), sort_keys=True)], ""


def verb_node_kill_orphan_qemu(args):
    """Kill any leftover qemu still bound to this node's running path BEFORE the
    node (re)starts. PNetLab can leave an orphaned qemu when a node is deleted/
    recreated or restarted; for a Wireless node that orphan keeps its radio on the
    shared vwifi medium and beacons a STALE SSID (ghost network) even after the
    config is fixed. Called only from a wireless node's prepare() — i.e. before
    that node's own qemu launches — so any qemu whose cmdline references this run
    path is by definition stale and safe to kill. Matches the node run dir
    (/opt/unetlab/tmp/<s>/<n>) in the qemu cmdline."""
    run_path = v_re(args, "run", RE_RUNPATH)
    needle = run_path + "/"
    killed = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as f:
                cmd = f.read().replace(b"\x00", b" ").decode("latin-1", "replace")
        except OSError:
            continue
        if "qemu-system" in cmd and needle in cmd:
            try:
                os.kill(int(pid), 9)
                killed.append(pid)
            except OSError:
                pass
    return 0, [json.dumps({"killed": killed})], ""


def verb_rxe_kill_orphan_qemu(args):
    """Retire only the QEMU bound to an RXE node's exact runtime path.

    RXE uses a stable AF_VSOCK CID. An orphan from the same runtime session can
    retain that CID after its directory is removed, so wait for complete process
    exit before allowing the replacement launch. This dedicated verb is called
    only by device_rxe::prepare() and does not alter other QEMU node lifecycles.
    """
    if set(args) != {"run"}:
        raise Reject("bad args")
    run_path = v_re(args, "run", RE_RUNPATH)
    needle = run_path + "/"

    def matching_qemu_pids():
        matches = []
        for pid_text in os.listdir("/proc"):
            if not pid_text.isdigit():
                continue
            try:
                exe = os.path.basename(os.readlink("/proc/%s/exe" % pid_text))
                with open("/proc/%s/cmdline" % pid_text, "rb") as f:
                    argv = [part.decode("latin-1", "replace")
                            for part in f.read().split(b"\x00") if part]
            except OSError:
                continue
            if exe.startswith("qemu-system-") and any(needle in arg for arg in argv):
                matches.append(int(pid_text))
        return matches

    session = int(run_path.rsplit("/", 1)[1])
    unit = _qemu_scope_unit(session)
    _cancel_qemu_quota_timer(session)
    # A managed QEMU normally lives in this exact per-session transient scope.
    # Stopping it first lets systemd clean up its cgroup; the PID scan below also
    # handles pre-scope launch failures and legacy unmanaged processes.
    run_quiet(["systemctl", "stop", unit], timeout=5)

    killed = []
    for pid in matching_qemu_pids():
        try:
            os.kill(pid, signal.SIGKILL)
            killed.append(str(pid))
        except ProcessLookupError:
            pass
        except OSError as e:
            raise Reject("cannot retire orphaned QEMU: %s" % e)

    deadline = time.monotonic() + 5.0
    remaining = matching_qemu_pids()
    while remaining and time.monotonic() < deadline:
        time.sleep(0.05)
        remaining = matching_qemu_pids()
    if remaining:
        raise Reject("orphaned QEMU did not exit")

    run_quiet(["systemctl", "reset-failed", unit], timeout=5)
    return 0, [json.dumps({"killed": killed, "scope": unit})], ""


# ---- Lab PKI (pki) ----------------------------------------------------------
# Thin dispatch to the cryptography-backed CA engine. The engine runs as root
# (brokerd is root), owns /opt/unetlab/data/pki (CA keys 0600), and prints ONE
# JSON line. www-data never touches the store — artifacts return through here.
PKI_HELPER = BASE + "/scripts/pki/pnet-pki.py"
RE_PKI_ID = re.compile(r"^[0-9a-f]{12}$")
PKI_ACTIONS = {"profiles", "ca_create", "list", "issue", "sign_csr",
               "export", "revoke", "crl", "delete_ca"}
PKI_PROFILES = {"server", "client", "server_client", "radius_eap",
                "ipsec", "https", "device"}
PKI_KEYTYPES = {"rsa2048", "rsa4096", "ec256", "ec384"}
PKI_FORMATS = {"cert", "key", "chain", "fullchain", "ca", "p12", "der"}


def _pki_text(args, key, maxlen):
    """Copy a printable, length-capped string field (or skip if absent)."""
    v = args.get(key)
    if v is None:
        return None
    if not isinstance(v, str):
        raise Reject("bad arg %s" % key)
    return "".join(c for c in v if 32 <= ord(c) < 127)[:maxlen]


def verb_pki(args):
    action = v_enum(args, "action", PKI_ACTIONS)
    p = {}
    # ids first — path-traversal defense (the engine re-checks, belt+suspenders)
    if args.get("ca_id") is not None:
        p["ca_id"] = v_re(args, "ca_id", RE_PKI_ID)
    if args.get("cert_id") is not None:
        p["cert_id"] = v_re(args, "cert_id", RE_PKI_ID)
    if action in ("issue", "sign_csr"):
        p["profile"] = v_enum(args, "profile", PKI_PROFILES)
    if action in ("ca_create", "issue"):
        p["key_type"] = v_enum(args, "key_type", PKI_KEYTYPES) \
            if args.get("key_type") is not None else "rsa2048"
    if args.get("days") is not None:
        p["days"] = v_int(args, "days")          # engine bounds the range
    if action == "export":
        p["format"] = v_enum(args, "format", PKI_FORMATS)
    # capped free-text subject fields (engine sanitizes again before X.509)
    for k, ml in (("name", 64), ("org", 64), ("ou", 64), ("country", 2),
                  ("cn", 253), ("lab", 64)):
        t = _pki_text(args, k, ml)
        if t is not None:
            p[k] = t
    if args.get("two_tier") is not None:
        p["two_tier"] = v_bool(args, "two_tier")
    if args.get("p12_pass") is not None:
        p["p12_pass"] = _pki_text(args, "p12_pass", 128)
    if args.get("sans") is not None:
        sans = v_list(args, "sans", 64)
        p["sans"] = [s for s in
                     ("".join(c for c in str(x) if 32 <= ord(c) < 127)[:253]
                      for x in sans) if s]
    if action == "sign_csr":
        csr = args.get("csr")
        if not isinstance(csr, str) or len(csr) > 32768 or \
                "BEGIN CERTIFICATE REQUEST" not in csr:
            raise Reject("bad csr")
        p["csr"] = csr
    proc = subprocess.run(["/usr/bin/python3", PKI_HELPER, action],
                          input=json.dumps(p).encode(),
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=60)
    out = proc.stdout.decode("utf-8", "replace").splitlines()
    if proc.returncode != 0 and not out:
        raise Reject("pki: " + (proc.stderr.decode("utf-8", "replace").strip()
                                or ("rc=%d" % proc.returncode)))
    return 0, out, ""                               # out = one JSON line


# ---- AI Lab Builder / MCP server (P1) --------------------------------------

def _ai_default_config():
    return {
        "mcp": {
            "enabled": False,
            "bind": "127.0.0.1",
            "port": 5701,
            "bridge_secret": secrets.token_hex(32),
            "tokens": [],            # [{name, hash, pod, tenant, role, created}]
        },
        # P3 placeholders — present but unused until the in-app agent lands.
        "provider": {
            "provider": "anthropic",
            "base_url": "",
            "model": "claude-opus-4-8",
            "api_key": "",
        },
        "limits": {
            "per_user_daily_tokens": 200000,
            "ai_allowed_roles": [],
        },
    }


def _ai_load_config():
    """Load data/ai/config.json, creating a default (with a fresh bridge secret)
    on first use. Always re-mirrors the bridge secret to the www-data-readable
    file so the engine shim can authenticate the loopback call."""
    cfg = None
    try:
        with open(AI_CONFIG, "r") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        cfg = None
    if not isinstance(cfg, dict):
        cfg = _ai_default_config()
        _ai_save_config(cfg)
    else:
        # backfill any missing keys without clobbering existing ones
        d = _ai_default_config()
        for sect, defv in d.items():
            if not isinstance(cfg.get(sect), dict):
                cfg[sect] = defv
            elif isinstance(defv, dict):
                for k, v in defv.items():
                    cfg[sect].setdefault(k, v)
        if not cfg["mcp"].get("bridge_secret"):
            cfg["mcp"]["bridge_secret"] = secrets.token_hex(32)
        _ai_save_config(cfg)
    return cfg


def _ai_apply_owner(path, group, mode):
    """chmod + chown root:<group>, tolerating a not-yet-created group. If a config
    write ever races ahead of the postinst that creates the pnetlab-mcp user (or on
    an old box mid-upgrade), this degrades to root:root instead of crashing the
    broker — the MCP service just can't read until the user exists, and the next
    save (post-upgrade) fixes the owner."""
    os.chmod(path, mode)
    try:
        shutil.chown(path, "root", group)
    except (LookupError, PermissionError, OSError):
        try:
            shutil.chown(path, "root", "root")
        except OSError:
            pass


def _ai_save_config(cfg):
    os.makedirs(AI_DIR, exist_ok=True)
    # 0751 root:www-data — BOTH readers must TRAVERSE this dir: www-data (the engine
    # shim) reads the 0640 bridge.secret via its group, and pnetlab-mcp (the
    # unprivileged MCP service) reads the 0640 config.json/usage.json. www-data keeps
    # group traversal; pnetlab-mcp traverses via the other-execute bit. No secret
    # leaks — the dir is NOT other-readable (no listing) and every file inside is
    # individually group-locked 0640. MUST re-apply on every rewrite: the chmod is
    # what keeps traversal working after an os.replace resets nothing here (the dir
    # is not replaced, but re-asserting is cheap and self-heals an old 0750 box).
    os.chmod(AI_DIR, 0o751)
    shutil.chown(AI_DIR, "root", "www-data")
    # config.json: 0640 root:pnetlab-mcp so the unprivileged MCP service can READ
    # the token hashes / bridge secret / LLM key it needs, without those secrets
    # becoming readable to www-data or the world. MUST re-apply owner+mode on EVERY
    # rewrite (set on the temp file so the published inode is correct atomically):
    # a plain temp+rename would leave it root:root 0600 and the service would then
    # 401 on its next config read.
    tmp = AI_CONFIG + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(cfg, fh, indent=2)
    _ai_apply_owner(tmp, "pnetlab-mcp", 0o640)
    os.replace(tmp, AI_CONFIG)
    # mirror the bridge secret for the www-data engine shim (0640 root:www-data).
    # pnetlab-mcp does NOT read this file — it takes bridge_secret from config.json —
    # so it stays www-data-only (least privilege: the service never touches it).
    secret = cfg.get("mcp", {}).get("bridge_secret", "")
    tmp2 = AI_BRIDGE_SECRET + ".tmp"
    with open(tmp2, "w") as fh:
        fh.write(secret)
    _ai_apply_owner(tmp2, "www-data", 0o640)
    os.replace(tmp2, AI_BRIDGE_SECRET)


def _ai_redacted(cfg):
    """Browser-safe projection: no secrets, tokens reduced to name+pod+created."""
    m = cfg.get("mcp", {})
    p = cfg.get("provider", {})
    return {
        "mcp": {
            "enabled": bool(m.get("enabled")),
            "bind": m.get("bind", "127.0.0.1"),
            "port": int(m.get("port", 5701)),
            "tokens": [
                {"name": t.get("name", ""), "pod": int(t.get("pod", 0)),
                 "role": t.get("role", "admin"), "created": int(t.get("created", 0))}
                for t in m.get("tokens", []) if isinstance(t, dict)
            ],
        },
        "provider": {
            "provider": p.get("provider", "anthropic"),
            "base_url": p.get("base_url", ""),
            "model": p.get("model", ""),
            "api_key_set": bool(p.get("api_key")),
        },
        "limits": {
            "per_user_daily_tokens": int(cfg.get("limits", {}).get("per_user_daily_tokens", 0)),
            "ai_allowed_roles": [
                str(r) for r in cfg.get("limits", {}).get("ai_allowed_roles", [])
                if isinstance(r, (str, int))
            ],
        },
    }


def _mcp_ensure_unit():
    """Install / refresh the unit into /etc/systemd/system on demand (it ships as
    a data file so it is NOT auto-enabled at deb install). daemon-reload only when
    the file actually changed. Returns True if a reload happened."""
    try:
        want = open(MCP_UNIT_SRC).read()
    except OSError:
        raise Reject("mcp unit source missing")
    have = ""
    try:
        have = open(MCP_UNIT_DST).read()
    except OSError:
        have = ""
    if have == want:
        return False
    tmp = MCP_UNIT_DST + ".tmp"
    with open(tmp, "w") as fh:
        fh.write(want)
    os.chmod(tmp, 0o644)
    os.replace(tmp, MCP_UNIT_DST)
    run_quiet(["systemctl", "daemon-reload"])
    return True


def verb_mcp_service(args):
    """systemctl toggle for the (toggleable) pnetlab-mcp.service — modelled on the
    status page's ksm|uksm|cpulimit broker hops. The unit is installed on the
    first enable/start (ships disabled by default). `status` returns a JSON line."""
    op = v_enum(args, "op", MCP_SERVICE_OPS)
    if op in ("enable", "start", "restart"):
        _mcp_ensure_unit()
    if op == "status":
        rc_a, out_a, _ = run(["systemctl", "is-active", MCP_UNIT], timeout=15)
        rc_e, out_e, _ = run(["systemctl", "is-enabled", MCP_UNIT], timeout=15)
        cfg = _ai_load_config()["mcp"]
        st = {
            "active": (out_a and out_a[0].strip() == "active"),
            "active_state": (out_a[0].strip() if out_a else "unknown"),
            "enabled": (out_e[0].strip() if out_e else "unknown"),
            "bind": cfg.get("bind", "127.0.0.1"),
            "port": int(cfg.get("port", 5701)),
            "configured": bool(cfg.get("tokens")),
        }
        return 0, [json.dumps(st)], ""
    rc, out, err = run(["systemctl", op, MCP_UNIT], timeout=60)
    return rc, out, err


def verb_mcp_health(args):
    """Liveness probe for the MCP listener: is the unit active and is the
    configured bind:port accepting TCP connections. Returns a JSON line."""
    cfg = _ai_load_config()["mcp"]
    bind = cfg.get("bind", "127.0.0.1")
    port = int(cfg.get("port", 5701))
    probe_host = "127.0.0.1" if bind in ("0.0.0.0", "::") else bind
    rc_a, out_a, _ = run(["systemctl", "is-active", MCP_UNIT], timeout=15)
    active = bool(out_a and out_a[0].strip() == "active")
    listening = False
    try:
        with socket.create_connection((probe_host, port), timeout=3):
            listening = True
    except OSError:
        listening = False
    return 0, [json.dumps({
        "active": active, "listening": listening,
        "bind": bind, "port": port,
    })], ""


def verb_ai_settings_read(args):
    """Redacted config for the admin dashboard (no secrets ever leave root)."""
    return 0, [json.dumps(_ai_redacted(_ai_load_config()))], ""


def verb_ai_settings_write(args):
    """Merge-write data/ai/config.json. Only the supplied fields change, so
    saving the bind/port never wipes the token list or the (future) LLM key."""
    cfg = _ai_load_config()
    m = cfg["mcp"]
    if "bind" in args:
        m["bind"] = v_enum(args, "bind", {"127.0.0.1", "0.0.0.0"})
    if "port" in args:
        port = v_int(args, "port")
        if port < 1024 or port > 65535:
            raise Reject("port out of range")
        m["port"] = port
    if "enabled" in args:
        m["enabled"] = bool(v_bool(args, "enabled"))
    # P3 provider fields — accepted now so the config has one shape, used later.
    p = cfg["provider"]
    if "provider" in args:
        p["provider"] = v_enum(args, "provider", AI_PROVIDERS)
    if "base_url" in args and isinstance(args["base_url"], str):
        if len(args["base_url"]) > 512:
            raise Reject("base_url too long")
        p["base_url"] = args["base_url"]
    if "model" in args and isinstance(args["model"], str):
        if len(args["model"]) > 128:
            raise Reject("model too long")
        p["model"] = args["model"]
    if args.get("api_key"):                       # only overwrite when non-empty
        if not isinstance(args["api_key"], str) or len(args["api_key"]) > 512:
            raise Reject("bad api_key")
        p["api_key"] = args["api_key"]
    if args.get("clear_api_key"):
        p["api_key"] = ""
    # Allowed-role list for the in-app AI Lab Builder (empty = admins only).
    if "ai_allowed_roles" in args:
        roles_raw = args["ai_allowed_roles"]
        if not isinstance(roles_raw, list):
            raise Reject("ai_allowed_roles must be a list")
        if len(roles_raw) > 64:
            raise Reject("ai_allowed_roles: too many entries (max 64)")
        cfg.setdefault("limits", {})["ai_allowed_roles"] = [str(r) for r in roles_raw]
    # Per-user daily token cap (0 = unlimited). Enforced in verb_ai_lab_build.
    if "per_user_daily_tokens" in args:
        cap = v_int(args, "per_user_daily_tokens")
        if cap < 0 or cap > 1000000000:
            raise Reject("per_user_daily_tokens out of range (0 = unlimited)")
        cfg.setdefault("limits", {})["per_user_daily_tokens"] = cap
    _ai_save_config(cfg)
    return 0, [json.dumps(_ai_redacted(cfg))], ""


def verb_mcp_token_new(args):
    """Generate a bearer access token for an external MCP client. The plaintext
    is returned ONCE; only its sha256 is stored. Bound to a PNetLab pod/tenant."""
    name = v_re(args, "name", RE_TOKEN_NAME)
    # pod == a PNetLab user id (the users PK). The dashboard (mcp/api.php) supplies
    # the minting admin's own pod when the request omits one; a literal 0 here is a
    # non-user and the bridge will reject it ("unknown pod"), so callers should
    # always pass a real pod.
    pod = v_int(args, "pod") if "pod" in args else 0
    cfg = _ai_load_config()
    toks = cfg["mcp"]["tokens"]
    if any(t.get("name") == name for t in toks):
        raise Reject("token name already exists")
    if len(toks) >= 32:
        raise Reject("too many tokens")
    secret = secrets.token_urlsafe(32)
    toks.append({
        "name": name,
        "hash": hashlib.sha256(secret.encode()).hexdigest(),
        "pod": pod, "tenant": pod, "role": "admin",
        "created": int(time.time()),
    })
    _ai_save_config(cfg)
    return 0, [json.dumps({"name": name, "pod": pod, "token": secret})], ""


def verb_mcp_token_del(args):
    name = v_re(args, "name", RE_TOKEN_NAME)
    cfg = _ai_load_config()
    toks = cfg["mcp"]["tokens"]
    n0 = len(toks)
    cfg["mcp"]["tokens"] = [t for t in toks if t.get("name") != name]
    if len(cfg["mcp"]["tokens"]) == n0:
        raise Reject("no such token")
    _ai_save_config(cfg)
    return 0, [json.dumps({"deleted": name})], ""


def _ai_usage_today(pod):
    """Return (day, ledger, tokens-used-by-pod-today)."""
    import datetime
    day = datetime.date.today().isoformat()
    try:
        with open(AI_USAGE) as fh:
            led = json.load(fh)
    except (OSError, ValueError):
        led = {}
    if not isinstance(led, dict):
        led = {}
    used = int(led.get(day, {}).get(str(pod), 0)) if isinstance(led.get(day), dict) else 0
    return day, led, used


def _ai_usage_add(pod, tokens):
    day, led, used = _ai_usage_today(pod)
    led.setdefault(day, {})[str(pod)] = used + int(tokens)
    # keep only the most recent ~14 days
    for k in sorted(led.keys())[:-14]:
        led.pop(k, None)
    os.makedirs(AI_DIR, exist_ok=True)
    tmp = AI_USAGE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(led, fh)
    # 0640 root:pnetlab-mcp so the unprivileged MCP service can READ the ledger for
    # its usage_status tool (the service never writes it — only the root broker
    # does). Same re-apply requirement as config.json: a plain temp+rename would
    # leave it root:root 0600 and the service's usage read would silently see 0.
    _ai_apply_owner(tmp, "pnetlab-mcp", 0o640)
    os.replace(tmp, AI_USAGE)


def verb_ai_lab_build(args):
    """Run the in-app AI Lab Builder agent (root) against a user's open lab.
    Spawns scripts/mcp/ai_lab_agent.py, which connects to the MCP tool surface
    over stdio bound to the pod and drives the appliance-configured provider.
    The NL prompt is fed on stdin (kept off the process table). Returns the
    agent's JSONL event stream as `out`."""
    pod = v_int(args, "pod")
    mode = v_enum(args, "mode", AI_BUILD_MODES) if args.get("mode") else "apply"
    lab_path = v_re(args, "lab_path", RE_LAB_PATH) if args.get("lab_path") else ""
    prompt = args.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise Reject("prompt required")
    if len(prompt) > 8000:
        raise Reject("prompt too long")

    cfg = _ai_load_config()
    if not cfg["mcp"].get("enabled"):
        raise Reject("MCP service is disabled — enable it in the dashboard")
    prov = cfg.get("provider", {})
    if prov.get("provider") in ("anthropic", "openai", "azure") and not prov.get("api_key"):
        raise Reject("no LLM API key configured — set one in the dashboard AI settings")

    limit = int(cfg.get("limits", {}).get("per_user_daily_tokens", 0))
    _day, _led, used = _ai_usage_today(pod)
    if limit and used >= limit:
        raise Reject("daily AI token cap reached (%d) — try again tomorrow" % limit)

    cmd = ["/usr/bin/python3", AI_AGENT, "--pod", str(pod), "--mode", mode]
    if lab_path:
        cmd += ["--lab-path", lab_path]

    # Tee the agent's JSONL stdout to a per-pod progress file (truncated at start)
    # so the side pane can poll ai_progress_read for a live feel while the long
    # build POST is still in flight. The full event list is still returned at the
    # end (authoritative), so a missed poll is harmless.
    try:
        os.makedirs(AI_PROGRESS_DIR, exist_ok=True)
        os.chmod(AI_PROGRESS_DIR, 0o750)
        try:
            shutil.chown(AI_PROGRESS_DIR, "root", "www-data")
        except (LookupError, PermissionError, OSError):
            pass
    except OSError:
        pass
    prog_path = os.path.join(AI_PROGRESS_DIR, "%d.jsonl" % pod)
    out = []
    prog_fh = None
    try:
        prog_fh = open(prog_path, "w")
        os.chmod(prog_path, 0o640)
        try:
            shutil.chown(prog_path, "root", "www-data")
        except (LookupError, PermissionError, OSError):
            pass
    except OSError:
        prog_fh = None

    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        if prog_fh:
            prog_fh.close()
        raise Reject("agent spawn failed: %s" % e)

    try:
        proc.stdin.write(prompt.encode())
        proc.stdin.close()
        deadline = time.time() + 600
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if line == "":
                continue
            out.append(line)
            if prog_fh:
                try:
                    prog_fh.write(line + "\n")
                    prog_fh.flush()
                except OSError:
                    pass
            if time.time() > deadline:
                proc.kill()
                break
        proc.wait(timeout=10)
    except Exception:                                          # noqa: BLE001
        try:
            proc.kill()
        except OSError:
            pass
    finally:
        if prog_fh:
            try:
                prog_fh.write('{"type":"_eof"}\n')             # poll sees running=false
                prog_fh.flush()
                prog_fh.close()
            except OSError:
                pass

    stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""

    spent = 0
    best_effort = 0  # fallback if no `done` event carries usage (error/abort paths)
    for line in out:
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        u = ev.get("usage") or {}
        if ev.get("type") == "done":
            # Authoritative charge: NET tokens (gross input minus cached share + output).
            # The agent computes this as `billed`; fall back to the formula for older agents.
            if "billed" in u:
                spent = int(u.get("billed", 0))
            else:
                spent = max(0, int(u.get("input", 0)) - int(u.get("cache_read", 0))) \
                    + int(u.get("output", 0))
            best_effort = 0  # done wins; discard the fallback accumulator
            break
        elif u:
            # Best-effort: accumulate usage from any non-done event (e.g. error events)
            # so runs that abort before `done` still charge the tokens they consumed.
            candidate = int(u.get("billed", 0)) or (
                max(0, int(u.get("input", 0)) - int(u.get("cache_read", 0)))
                + int(u.get("output", 0)))
            if candidate > best_effort:
                best_effort = candidate
    if not spent and best_effort:
        spent = best_effort
    if spent:
        _ai_usage_add(pod, spent)

    if proc.returncode not in (0, None) and not out:
        raise Reject("agent: " + (stderr.strip() or ("rc=%d" % proc.returncode)))
    return 0, out, ""


def verb_ai_progress_read(args):
    """Return the live build-progress events for a pod since `offset` lines, plus
    the new offset and a `running` flag. Backs the side pane's ~800ms poll while a
    build POST is in flight (the file is the broker's tee of the agent JSONL). The
    final build POST still returns the authoritative event list."""
    pod = v_int(args, "pod")
    offset = int(args.get("offset", 0) or 0)
    prog_path = os.path.join(AI_PROGRESS_DIR, "%d.jsonl" % pod)
    events = []
    running = False
    try:
        with open(prog_path) as fh:
            lines = fh.read().splitlines()
    except OSError:
        lines = []
    total = len(lines)
    saw_eof = False
    for line in lines[offset:]:
        try:
            ev = json.loads(line)
        except ValueError:
            continue                # tolerate a partial last line mid-flush
        if ev.get("type") == "_eof":
            saw_eof = True
            continue                # internal end marker, not a UI event
        events.append(ev)
    # the broker writes a final _eof line when the agent exits; until then a
    # non-empty file means the build is still running.
    if not saw_eof:
        saw_eof = any(l.lstrip().startswith('{"type":"_eof"') for l in lines)
    running = total > 0 and not saw_eof
    return 0, [json.dumps({"events": events, "offset": total,
                           "running": running})], ""


def verb_ai_usage_read(args):
    """Return the AI token-usage ledger for the dashboard: the last ~14 days of
    per-pod token totals plus the configured per-user daily cap. Read-only; the
    ledger (data/ai/usage.json) is root-only so this is the only way the admin UI
    can see it."""
    try:
        with open(AI_USAGE) as fh:
            led = json.load(fh)
    except (OSError, ValueError):
        led = {}
    if not isinstance(led, dict):
        led = {}
    import datetime
    today = datetime.date.today().isoformat()
    # totals per day across all pods, for a compact dashboard summary
    by_day = {}
    for day, pods in led.items():
        if isinstance(pods, dict):
            by_day[day] = sum(int(v or 0) for v in pods.values())
    cap = int(_ai_load_config().get("limits", {}).get("per_user_daily_tokens", 0))
    return 0, [json.dumps({
        "today": today,
        "per_user_daily_cap": cap,
        "by_day": by_day,
        "ledger": led,
    })], ""


def verb_disk_expand(args):
    """Detect or expand the root filesystem.

    op=detect — probe root partition layout (plain vs LVM), filesystem size,
    disk total, and growable free space.  Returns rc0 + out[0]=JSON.

    op=expand — run the detected expansion steps (growpart + resize2fs/xfs_growfs
    for plain; pvresize + lvextend + grow for LVM).  Returns rc0 + out[0]=JSON
    with before/after sizes.  Idempotent: if no space is available returns
    ok:true with a note.
    """
    op = v_enum(args, "op", {"detect", "expand"})

    # ---- helpers ----
    def _gb(nbytes):
        return round(nbytes / (1024 ** 3), 2)

    def _df_bytes():
        """Return (fs_size_bytes, fs_used_bytes) for the root mount."""
        rc2, out2, _ = run(["df", "-B1", "--output=size,used", "/"], timeout=30)
        for line in out2:
            parts = line.split()
            if len(parts) == 2 and parts[0].isdigit():
                return int(parts[0]), int(parts[1])
        raise Reject("df failed")

    def _lsblk_size(dev):
        """Return device size in bytes via lsblk -b."""
        rc2, out2, _ = run(["lsblk", "-b", "-d", "-n", "-o", "SIZE", dev], timeout=30)
        for line in out2:
            s = line.strip()
            if s.isdigit():
                return int(s)
        raise Reject("lsblk size failed for %s" % dev)

    # ---- detect root device ----
    rc, out, err = run(["findmnt", "-no", "SOURCE", "/"], timeout=30)
    if rc != 0 or not out:
        raise Reject("findmnt failed: %s" % err.strip()[:120])
    root_source = out[0].strip()   # e.g. /dev/sda1 or /dev/mapper/ubuntu--vg-ubuntu--lv

    # ---- detect fstype ----
    rc, out2, _ = run(["findmnt", "-no", "FSTYPE", "/"], timeout=30)
    fstype = (out2[0].strip() if out2 else "ext4")

    # ---- LVM detection ----
    is_lvm = root_source.startswith("/dev/mapper/") or root_source.startswith("/dev/dm-")
    vg, lv = "", ""
    part = root_source
    disk = ""
    part_num = ""

    if is_lvm:
        # Resolve LV name -> VG/LV
        rc2, lv_out, _ = run(["lvs", "--noheadings", "-o", "vg_name,lv_name",
                               root_source], timeout=30)
        for line in lv_out:
            cols = line.split()
            if len(cols) >= 2:
                vg, lv = cols[0], cols[1]
                break
        # Find the underlying PV (first one, enough for single-disk setups)
        rc2, pv_out, _ = run(["pvs", "--noheadings", "-o", "pv_name,vg_name"],
                              timeout=30)
        for line in pv_out:
            cols = line.split()
            if len(cols) >= 2 and cols[1] == vg:
                part = cols[0]    # e.g. /dev/sda3
                break
    else:
        part = root_source        # e.g. /dev/sda1

    # Strip partition number to get the disk device (e.g. /dev/sda1 -> /dev/sda, num=1)
    # Handles /dev/sdaN, /dev/nvme0n1pN, /dev/vdaN
    import re as _re
    m = _re.match(r"^(/dev/(?:nvme\d+n\d+|[a-z]+))p?(\d+)$", part)
    if m:
        disk = m.group(1)
        part_num = m.group(2)
    else:
        # Fallback: disk = part (whole-disk or unknown layout; no growpart possible)
        disk = part
        part_num = ""

    # ---- sizes ----
    try:
        fs_bytes, fs_used = _df_bytes()
    except Reject:
        fs_bytes, fs_used = 0, 0

    disk_bytes = 0
    if disk:
        try:
            disk_bytes = _lsblk_size(disk)
        except Reject:
            pass

    # For LVM: growable = VG free extents (vgs reports in the requested unit)
    growable_bytes = 0
    if is_lvm and vg:
        rc2, vg_out, _ = run(["vgs", "--noheadings", "--units", "b",
                               "-o", "vg_free", vg], timeout=30)
        for line in vg_out:
            s = line.strip().rstrip("B").rstrip("b")
            try:
                growable_bytes = int(float(s))
                break
            except ValueError:
                pass
        if growable_bytes == 0 and part and disk and part_num:
            # VG free is zero — underlying partition may still have unallocated disk space
            part_bytes = 0
            try:
                part_bytes = _lsblk_size(part)
            except Reject:
                pass
            growable_bytes = max(0, disk_bytes - part_bytes)
    else:
        # Plain: growable = disk - partition
        part_bytes = 0
        if part and part != disk:
            try:
                part_bytes = _lsblk_size(part)
            except Reject:
                pass
        growable_bytes = max(0, disk_bytes - part_bytes)

    expandable = growable_bytes > (512 * 1024 * 1024)   # >512 MiB free

    # ---- build human-readable commands ----
    commands = []
    if expandable and part_num and disk:
        if is_lvm:
            commands = [
                "growpart %s %s" % (disk, part_num),
                "pvresize %s" % part,
                "lvextend -l +100%%FREE /dev/%s/%s" % (vg, lv),
                ("resize2fs /dev/%s/%s" % (vg, lv)) if fstype in ("ext2", "ext3", "ext4")
                else ("xfs_growfs /"),
            ]
        else:
            commands = [
                "growpart %s %s" % (disk, part_num),
                ("resize2fs %s" % part) if fstype in ("ext2", "ext3", "ext4")
                else ("xfs_growfs /"),
            ]
    elif expandable:
        if is_lvm and vg and lv:
            commands = [
                "pvresize %s" % part,
                "lvextend -l +100%%FREE /dev/%s/%s" % (vg, lv),
                ("resize2fs /dev/%s/%s" % (vg, lv)) if fstype in ("ext2", "ext3", "ext4")
                else ("xfs_growfs /"),
            ]

    info = {
        "root_mount": "/",
        "dev": root_source,
        "part": part,
        "fstype": fstype,
        "is_lvm": is_lvm,
        "vg": vg,
        "lv": lv,
        "fs_size_gb": _gb(fs_bytes),
        "disk_total_gb": _gb(disk_bytes),
        "growable_gb": _gb(growable_bytes),
        "expandable": expandable,
        "commands": commands,
    }

    if op == "detect":
        return 0, [json.dumps(info)], ""

    # ---- op == expand ----
    before_gb = _gb(fs_bytes)
    steps = []

    if not expandable:
        return 0, [json.dumps({
            "ok": True, "before_gb": before_gb, "after_gb": before_gb,
            "steps": ["nothing to grow (growable_gb=%.2f)" % _gb(growable_bytes)],
        })], ""

    if not commands:
        return 0, [json.dumps({
            "ok": False, "before_gb": before_gb, "after_gb": before_gb,
            "steps": ["could not determine expansion commands"],
        })], ""

    ok = True
    for cmd_str in commands:
        argv = cmd_str.split()
        try:
            rc2, out2, err2 = run(argv, timeout=120, check_rc=False)
            steps.append({"cmd": cmd_str, "rc": rc2,
                           "out": out2[:10], "err": err2.strip()[:200]})
            if rc2 != 0:
                # growpart rc=1 means "no space to grow" — treat as non-fatal
                if argv[0] == "growpart" and rc2 == 1:
                    steps[-1]["note"] = "partition already at disk edge"
                else:
                    ok = False
                    break
        except Exception as exc:
            steps.append({"cmd": cmd_str, "rc": -1, "err": str(exc)[:200]})
            ok = False
            break

    # after size
    try:
        after_bytes, _ = _df_bytes()
    except Reject:
        after_bytes = fs_bytes
    after_gb = _gb(after_bytes)

    return 0, [json.dumps({
        "ok": ok, "before_gb": before_gb, "after_gb": after_gb, "steps": steps,
    })], ""


def verb_cluster_sync_satellite(args):
    """Detach a pnet-satdeb worker pushing a matching satellite/bridge pair.

    The PHP caller selects the pair from root-owned, read-only staging paths;
    the broker repeats the path jail before passing either path to the root
    worker.  This keeps the compatibility fallback useful for old masters
    without turning the new bridge argument into a root path primitive.
    """
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    job = v_re(args, "job", RE_JOB)
    sync_deb_roots = (
        "/opt/unetlab/data/satellite",
        "/opt/unetlab/cluster-bundle",
        "/var/cache/pnetlab/debs",
    )
    deb_source = v_path_under_any(args, "deb_source", sync_deb_roots)
    bridge_deb_source = v_path_under_any(args, "bridge_deb_source", sync_deb_roots)
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    sat_ip = h["ip"]
    unit = spawn_unit(
        "pnet-satdeb-" + job,
        ["/bin/bash", BASE + "/scripts/pnet-satdeb-push.sh",
         sat_ip, deb_source, bridge_deb_source, job],
        props=("IOWeight=50",))
    return 0, ["unit " + unit], ""


# ---- docker rebroker (Stage 1) ----------------------------------------------
# Container names are always DERIVED broker-side from typed integer ids — PHP
# never passes a free-form name. Node containers are docker<node_session>;
# per-interface capture containers are
# Capture_<tenant>_<lab_session>_<node_session>_<interface_id> (node_session
# 901/902 = the Wi-Fi airduct/vwifi synthetic capture nodes — real names, must
# be accepted); the legacy shared per-lab capture container is
# Capture_<tenant>_<lab_session>. RE_CTR covers all three shapes for any later
# verb that receives a name (e.g. echoed back from `docker ps`) instead of ids.
# Stage 7: the tcp://127.0.0.1:4243 endpoint is GONE (pnetlab-docker 6.0.0-31
# binds unix:///var/run/docker.sock only). The broker runs as root, so it dials
# the unix socket directly; every verb below inherits this single constant.
DOCKER_HOST = "unix:///var/run/docker.sock"
# A network OS runs thousands of threads. With the systemd cgroup driver an
# omitted (or -1) create limit can inherit DefaultTasksMax, only 1550 on a small
# fresh VM. Use an explicit, bounded per-node budget with room for convergence
# and larger images; no host-wide systemd setting or caller-controlled limit.
DOCKER_NODE_PIDS_LIMIT = 16384
RE_CTR = re.compile(r"^(?:docker\d+|Capture_\d+_\d+(?:_\d+_\d+)?)$")
# The only --format templates the engine's read-only inspect sites use.
# Anything else is rejected — no free-form Go-template passthrough.
DOCKER_INSPECT_FORMATS = {
    "{{ .State.Running }}",
    "{{ .State.Pid }}",
    "{{json .State}}",
}


def _docker_name(node_session):
    """docker<node_session> — the engine's node-container name
    (device_docker.php --name=docker<getSession()>)."""
    return "docker%d" % v_int({"node_session": node_session}, "node_session")


def _capture_name(tenant, lab_session, node_session, interface_id):
    """Capture_<t>_<l>_<ns>_<if> — per-interface capture container name.
    node_session 901/902 (Wi-Fi synthetic capture nodes) are ordinary ints
    here and pass through like any other — do NOT special-case them."""
    return "Capture_%d_%d_%d_%d" % (
        v_int({"tenant": tenant}, "tenant"),
        v_int({"lab_session": lab_session}, "lab_session"),
        v_int({"node_session": node_session}, "node_session"),
        v_int({"interface_id": interface_id}, "interface_id"))


def _capture_shared_name(tenant, lab_session):
    """Capture_<t>_<l> — legacy shared per-lab capture container name
    (functions.php Capture_<labId> / Capture_<t>_<l> sites)."""
    return "Capture_%d_%d" % (
        v_int({"tenant": tenant}, "tenant"),
        v_int({"lab_session": lab_session}, "lab_session"))


def verb_docker_inspect(args):
    """READ-ONLY `docker inspect` on a container whose name is derived HERE
    from typed integer ids (never accepted as a string from the caller).
    format, when present, must be one of the allowlisted templates above.
    Fails closed (Reject) on any bad id/kind/format."""
    kind = v_enum(args, "kind", {"node", "capture", "capture_shared"})
    if kind == "node":
        name = _docker_name(args.get("node_session"))
    elif kind == "capture":
        name = _capture_name(args.get("tenant"), args.get("lab_session"),
                             args.get("node_session"), args.get("interface_id"))
    else:
        name = _capture_shared_name(args.get("tenant"), args.get("lab_session"))
    argv = ["docker", "-H=" + DOCKER_HOST, "inspect"]
    if args.get("format") is not None:
        argv += ["--format", v_enum(args, "format", DOCKER_INSPECT_FORMATS)]
    argv.append(name)
    return run(argv, timeout=30)


# ---- docker rebroker (Stage 2): typed-capability container lifecycle --------
# The `docker create` command used to be assembled as a FREE-FORM ROOT SHELL
# STRING in www-data PHP (device_{docker,ceos,srlinux}.php) and exec()'d. That
# string carried every dangerous capability (--privileged, --cap-add, --device,
# --mount, --sysctl, -u, entrypoint) directly, so a www-data foothold that could
# influence it was root-equivalent on the host.
#
# Stage 2 moves the whole builder here. The broker ROOT-READS the node's
# template YAML itself, extracts the capability set from it (never from the
# caller), maps each capability to a FIXED flag token with per-value validation,
# and executes a docker argv ARRAY (never `sh -c`, never a joined string).
# www-data PHP passes only typed, already-user-settable, validated leaf values
# (image, node name, ram/cpu ints, console publish ports derived engine-side).
#
# Template capability input has two forms:
#   1. A typed `docker:` schema block (preferred) -> _docker_build_typed().
#   2. Legacy free-form `dock_args`/`docker_options` strings -> accepted ONLY if
#      the template FILE's sha256 is in the shipped root:root manifest
#      (/opt/unetlab/scripts/docker-template-manifest.sha256, integrity-verified
#      root-owned by _manifest_trusted). The SAME in-memory buffer is hashed and
#      yaml-parsed (no re-read -> no TOCTOU). shlex.split -> per-token allowlist.
#   On a manifest miss the create FAILS CLOSED with a conversion/sign message.
#
# ceos/srlinux carry their dangerous flags as driver-hardcoded strings in PHP
# (their templates have no dock_args); those become root-authored broker profiles
# here (family=ceos/srlinux) taking only charset/int/bool leaf values.

TEMPLATES_DIR = BASE + "/html/templates"
# The shipped free-form template manifest lives OUTSIDE /opt/unetlab/html on
# purpose: fixpermissions chowns the html tree to www-data, so a manifest under
# html was www-data-writable on a running box and www-data could self-sign its
# own --privileged/-v:/host template (reopening the closed www-data->root path).
# /opt/unetlab/scripts is a root-owned dir the fixpermissions sweep never chowns
# to www-data; _manifest_hashes() also verifies root-ownership fail-closed.
SHIPPED_MANIFEST = BASE + "/scripts/docker-template-manifest.sha256"

RE_TEMPLATE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
RE_DEV = re.compile(r"^/dev/[a-z0-9/_-]+$")
RE_ENVKEY = re.compile(r"^[A-Z0-9_]+$")
RE_SHM = re.compile(r"^[0-9]+[kKmMgG]?$")
RE_USER = re.compile(r"^[0-9]+(:[0-9]+)?$")
RE_LEAF = re.compile(r"^[A-Za-z0-9_.-]+$")          # ETBA / EOS_PLATFORM / Card_Type
RE_MOUNT_TARGET = re.compile(r"^/[A-Za-z0-9_./-]+$")

CAP_ALLOW = {"NET_ADMIN", "NET_RAW", "SYS_ADMIN"}
# CAPABILITY TIERS (docker-rebroker fix1). The host-root-equivalent tier below
# is only honoured when the template's exact bytes are in the shipped manifest
# (i.e. signed) — the SAME gate the legacy free-form dock_args path enforces.
# The benign subset (net none/bridge, publish, env, mem/cpu, shm, sysctls,
# NET_ADMIN/NET_RAW, runpath-jailed mounts) stays usable UNSIGNED so future
# nodes need no signing.
CAP_DANGEROUS = {"SYS_ADMIN"}          # host-root-equivalent cap -> signed-only
DEV_ALLOW = {"/dev/fuse"}
NET_ALLOW = {"none", "bridge"}         # unsigned-allowed network modes
NET_DANGEROUS = {"host"}               # host namespace -> signed-only
RESTART_ALLOW = {"no", "on-failure", "always", "unless-stopped"}
# The six srlinux sysctl keys (device_srlinux.php:210). Values must be "0"/"1".
SYSCTL_ALLOW = {
    "net.ipv6.conf.all.disable_ipv6",
    "net.ipv4.ip_forward",
    "net.ipv6.conf.all.accept_dad",
    "net.ipv6.conf.default.accept_dad",
    "net.ipv6.conf.all.autoconf",
    "net.ipv6.conf.default.autoconf",
}
# -v host bind sources: a fixed SHIPPED allowlist (root-owned, read-only paths).
SHIPPED_VOL_ALLOW = {
    "/opt/unetlab/startup_configs/Docker/SR_linux/license.key",
}
HOSTPORT_FLOOR = 1024
RE_IMG_ID_SUFFIX = re.compile(r":[0-9a-f]{12}$|:[0-9a-f]{64}$")


def _docker_platform():
    """Mirror includes/init.php: /opt/unetlab/platform == 'svm' -> amd else intel."""
    try:
        with open(BASE + "/platform") as f:
            fam = f.read().strip()
    except Exception:
        fam = ""
    return "amd" if fam == "svm" else "intel"


def _docker_read_template(template):
    """Root-read the node template YAML ONCE. Returns (raw_bytes, parsed_dict,
    path). The raw bytes back both the manifest hash and the yaml parse so the
    legacy free-form gate has no TOCTOU. Fails closed on a bad name / missing
    file / unparseable yaml."""
    if yaml is None:
        raise Reject("docker_create: PyYAML unavailable in broker")
    name = v_re({"template": template}, "template", RE_TEMPLATE)
    if ".." in name or "/" in name:
        raise Reject("bad arg template")
    path = "%s/%s/%s.yml" % (TEMPLATES_DIR, _docker_platform(), name)
    if os.path.islink(path):
        raise Reject("template: refuse symlinked template file")
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except Exception:
        raise Reject("template not found: %s" % name)
    try:
        tpl = yaml.safe_load(raw)
    except Exception:
        raise Reject("template: unparseable yaml")
    if not isinstance(tpl, dict):
        raise Reject("template: not a mapping")
    return raw, tpl, path


def _manifest_trusted(path):
    """FAIL-CLOSED integrity gate for the shipped manifest. The manifest
    authorises host-root-equivalent docker flags, so it is trusted ONLY when
    BOTH the file AND its parent dir are root-owned (uid 0) and not
    group/other-writable. This defeats the www-data self-sign path: if
    fixpermissions (or any tampering) ever flips the manifest or its dir to
    www-data-owned/writable, or the file is mislocated, this returns False and
    _manifest_hashes() yields the empty set -> every dangerous/free-form
    template is refused rather than silently honoured."""
    try:
        st = os.stat(path)
    except Exception as e:
        log("manifest: refusing untrusted manifest %s: unreadable/missing (%s)" % (path, e))
        return False
    if st.st_uid != 0:
        log("manifest: refusing untrusted manifest %s: not root-owned (uid=%d)" % (path, st.st_uid))
        return False
    if st.st_mode & 0o022:
        log("manifest: refusing untrusted manifest %s: group/other-writable (mode=%o)" % (path, st.st_mode & 0o777))
        return False
    parent = os.path.dirname(path) or "/"
    try:
        pst = os.stat(parent)
    except Exception as e:
        log("manifest: refusing untrusted manifest %s: parent dir unstatable (%s)" % (path, e))
        return False
    if pst.st_uid != 0:
        log("manifest: refusing untrusted manifest %s: parent dir %s not root-owned (uid=%d)" % (path, parent, pst.st_uid))
        return False
    if pst.st_mode & 0o022:
        log("manifest: refusing untrusted manifest %s: parent dir %s group/other-writable (mode=%o)" % (path, parent, pst.st_mode & 0o777))
        return False
    return True


def _manifest_hashes():
    """The set of sha256 hex digests in the shipped manifest. The manifest MUST
    be root-owned and not group/other-writable, and so must its parent dir
    (verified by _manifest_trusted); otherwise -> empty set (every free-form /
    dangerous template refused). Absent/unreadable manifest -> empty set too."""
    if not _manifest_trusted(SHIPPED_MANIFEST):
        return set()
    hashes = set()
    try:
        with open(SHIPPED_MANIFEST) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                h = line.split()[0].lower()
                if re.match(r"^[0-9a-f]{64}$", h):
                    hashes.add(h)
    except Exception:
        pass
    return hashes


def _resolve_runpath_file(runpath, spec):
    """Resolve a template-supplied bind/env-file SOURCE to a path under the
    node runningPath jail. Only the basename is honoured (template writes
    './eve_env.txt', 'startup-config', '<card>.yml'). lstat-rejects a symlink
    and realpath-rejects any escape. RESIDUAL: runningPath lives under the
    www-data-writable /opt/unetlab/tmp, so www-data authors the file BYTES
    (not the path) — hence :ro is preferred by callers and symlink/escape are
    closed here."""
    base = os.path.basename(spec.rstrip("/"))
    if base in ("", ".", ".."):
        raise Reject("template: bad bind source %r" % spec)
    p = os.path.join(runpath, base)
    if os.path.islink(p):
        raise Reject("template: refuse symlinked bind source %r" % base)
    real = os.path.realpath(p)
    if real != runpath and not (real + "/").startswith(runpath.rstrip("/") + "/"):
        raise Reject("template: bind source escapes runningPath")
    return p


def _ff_take(tokens, i, tok):
    """Return (value, new_index) for a `--flag=value` or `--flag value` form."""
    if "=" in tok and tok.startswith("--"):
        return tok.split("=", 1)[1], i
    if i + 1 >= len(tokens):
        raise Reject("template: flag %s missing value" % tok)
    return tokens[i + 1], i + 1


def _parse_mount_spec(val, runpath):
    """type=bind,source=<runpath-jailed>,target=<abs>[,readonly|,ro]. Rejects
    any type other than bind and any non-basename escape."""
    parts = [p for p in val.split(",") if p != ""]
    kv = {}
    flags = []
    for p in parts:
        if "=" in p:
            k, v = p.split("=", 1)
            kv[k.strip()] = v.strip()
        else:
            flags.append(p.strip())
    if kv.get("type") != "bind":
        raise Reject("template: only type=bind mounts allowed")
    src = kv.get("source") or kv.get("src")
    tgt = kv.get("target") or kv.get("destination") or kv.get("dst")
    if not src or not tgt:
        raise Reject("template: mount missing source/target")
    if not RE_MOUNT_TARGET.match(tgt):
        raise Reject("template: bad mount target")
    real = _resolve_runpath_file(runpath, src)
    ro = ("readonly" in flags) or ("ro" in flags) or (kv.get("readonly") == "true")
    spec = "type=bind,source=%s,target=%s" % (real, tgt)
    if ro:
        spec += ",readonly"
    return spec


def _parse_volume_spec(val, runpath):
    """-v SRC:DST[:opts]. SRC is either a SHIPPED_VOL_ALLOW path (forced :ro) or
    a runningPath-jailed basename."""
    bits = val.split(":")
    if len(bits) < 2:
        raise Reject("template: bad -v spec")
    src, dst = bits[0], bits[1]
    opts = bits[2] if len(bits) > 2 else ""
    if not RE_MOUNT_TARGET.match(dst):
        raise Reject("template: bad -v target")
    real_src = os.path.realpath(src)
    if real_src in SHIPPED_VOL_ALLOW:
        return "%s:%s:ro" % (real_src, dst)
    jailed = _resolve_runpath_file(runpath, src)
    ro = "ro" in opts.split(",")
    return "%s:%s%s" % (jailed, dst, ":ro" if ro else "")


def _parse_freeform(text, runpath, allow_publish_net):
    """shlex-split a legacy dock_args/docker_options STRING and rebuild a
    VALIDATED docker argv list. Every recognised token maps to a fixed flag;
    anything unrecognised fails closed with a conversion/sign hint."""
    tokens = shlex.split(text)
    out = []
    i = 0
    n = len(tokens)
    while i < n:
        t = tokens[i]
        if t == "--privileged":
            out.append(t)
        elif t in ("-it", "-ti", "-i", "-t", "-d"):
            out.append(t)
        elif t == "--cap-add" or t.startswith("--cap-add="):
            v, i = _ff_take(tokens, i, t)
            if v not in CAP_ALLOW:
                raise Reject("template: cap %r not allowed" % v)
            out.append("--cap-add=" + v)
        elif t == "--device" or t.startswith("--device="):
            v, i = _ff_take(tokens, i, t)
            if not RE_DEV.match(v) or v not in DEV_ALLOW:
                raise Reject("template: device %r not allowed" % v)
            out += ["--device", v]
        elif t in ("--net", "--network") or t.startswith("--net=") or t.startswith("--network="):
            v, i = _ff_take(tokens, i, t)
            # free-form only reaches here after the shipped-manifest gate in
            # _docker_capabilities (i.e. signed), so the dangerous net=host mode
            # is permitted here — the signature is the authorization.
            if v not in (NET_ALLOW | NET_DANGEROUS):
                raise Reject("template: net mode %r not allowed" % v)
            out.append("--net=" + v)
        elif t == "--shm-size" or t.startswith("--shm-size="):
            v, i = _ff_take(tokens, i, t)
            if not RE_SHM.match(v):
                raise Reject("template: bad --shm-size %r" % v)
            out += ["--shm-size", v]
        elif t in ("-u", "--user") or t.startswith("--user="):
            v, i = _ff_take(tokens, i, t)
            if not RE_USER.match(v):
                raise Reject("template: bad --user %r" % v)
            out += ["-u", v]
        elif t in ("-e", "--env") or t.startswith("--env="):
            v, i = _ff_take(tokens, i, t)
            key = v.split("=", 1)[0]
            if not RE_ENVKEY.match(key):
                raise Reject("template: bad env key %r" % key)
            if "\x00" in v:
                raise Reject("template: bad env value")
            out += ["-e", v]
        elif t == "--env-file" or t.startswith("--env-file="):
            v, i = _ff_take(tokens, i, t)
            out += ["--env-file", _resolve_runpath_file(runpath, v)]
        elif t == "--sysctl" or t.startswith("--sysctl="):
            v, i = _ff_take(tokens, i, t)
            key = v.split("=", 1)[0]
            if key not in SYSCTL_ALLOW:
                raise Reject("template: sysctl %r not allowed" % key)
            out += ["--sysctl", v]
        elif t == "--restart" or t.startswith("--restart="):
            v, i = _ff_take(tokens, i, t)
            if v not in RESTART_ALLOW:
                raise Reject("template: bad --restart %r" % v)
            out.append("--restart=" + v)
        elif t == "--mount" or t.startswith("--mount="):
            v, i = _ff_take(tokens, i, t)
            out += ["--mount", _parse_mount_spec(v, runpath)]
        elif t in ("-v", "--volume") or t.startswith("--volume="):
            v, i = _ff_take(tokens, i, t)
            out += ["-v", _parse_volume_spec(v, runpath)]
        elif t == "--shm-size":
            raise Reject("template: --shm-size missing value")
        else:
            raise Reject(
                "template: unsupported docker flag %r — convert the template to "
                "the typed docker: schema or sign it with pnetlab-template-sign" % t)
        i += 1
    return out


def _docker_build_typed(block, runpath, signed):
    """Map a template `docker:` schema block to a validated docker argv list.
    Unknown keys / out-of-enum values fail closed.

    CAPABILITY-TIERED SIGNING (docker-rebroker fix1): host-root-equivalent
    features (privileged, cap SYS_ADMIN, net=host, any --device, any host bind
    outside the shipped safe allowlist) are only honoured when `signed` is True
    — i.e. the template's exact bytes are in the shipped manifest, the SAME gate
    the legacy free-form dock_args path enforces. `signed` is derived by the
    caller from a sha256 over the very buffer this block was parsed from, so
    there is no re-read and no TOCTOU. The benign subset stays usable unsigned."""
    if not isinstance(block, dict):
        raise Reject("template: docker: block not a mapping")
    known = {"privileged", "cap_add", "devices", "net", "shm_size", "user",
             "env", "env_file", "mounts", "volumes", "sysctls", "restart",
             "entrypoint"}
    # Fail closed on any key outside the known schema — in particular the
    # namespace/escape keys (pid, ipc, userns, security_opt, cgroup_parent,
    # runtime, device_cgroup_rule, volumes_from, ...) are NOT emitted by any
    # shipped template and MUST NOT be, signed or not.
    unknown = set(block) - known
    if unknown:
        raise Reject("template: unknown docker: keys %s" % sorted(unknown))

    # `privileged` is emitted only on the bool True (identity), so a YAML-truthy
    # non-bool (`1`, `"true"`, `yes`->parsed non-bool) would SILENTLY drop
    # privilege on a SIGNED template — safe security-wise but a footgun for the
    # author. Fail loud instead of silently ignoring it.
    if "privileged" in block and not isinstance(block["privileged"], bool):
        raise Reject("template: docker: privileged must be a boolean (true/false)")

    def need_sign(feature):
        if not signed:
            raise Reject(
                "template requests %s but its bytes are not in the shipped "
                "manifest; convert to the safe subset or have an admin sign it: "
                "sudo pnetlab-template-sign" % feature)

    out = []
    if block.get("privileged") is True:
        need_sign("privileged")
        out.append("--privileged")
    for c in block.get("cap_add", []) or []:
        if c not in CAP_ALLOW:
            raise Reject("template: cap %r not allowed" % c)
        if c in CAP_DANGEROUS:
            need_sign("cap %s" % c)
        out.append("--cap-add=" + c)
    for d in block.get("devices", []) or []:
        if not RE_DEV.match(str(d)) or d not in DEV_ALLOW:
            raise Reject("template: device %r not allowed" % d)
        need_sign("device %s" % d)
        out += ["--device", d]
    if "net" in block:
        nv = block["net"]
        if nv in NET_DANGEROUS:
            need_sign("net=%s" % nv)
        elif nv not in NET_ALLOW:
            raise Reject("template: net mode not allowed")
        out.append("--net=" + nv)
    if "shm_size" in block:
        if not RE_SHM.match(str(block["shm_size"])):
            raise Reject("template: bad shm_size")
        out += ["--shm-size", str(block["shm_size"])]
    if "user" in block:
        if not RE_USER.match(str(block["user"])):
            raise Reject("template: bad user")
        out += ["-u", str(block["user"])]
    for k, val in (block.get("env") or {}).items():
        if not RE_ENVKEY.match(str(k)):
            raise Reject("template: bad env key %r" % k)
        out += ["-e", "%s=%s" % (k, val)]
    if "env_file" in block:
        out += ["--env-file", _resolve_runpath_file(runpath, str(block["env_file"]))]
    for m in block.get("mounts", []) or []:
        src = m.get("source")
        tgt = m.get("target")
        if not src or not tgt or not RE_MOUNT_TARGET.match(str(tgt)):
            raise Reject("template: bad mount")
        real = _resolve_runpath_file(runpath, str(src))
        spec = "type=bind,source=%s,target=%s" % (real, tgt)
        if m.get("ro", True):
            spec += ",readonly"
        out += ["--mount", spec]
    for v in block.get("volumes", []) or []:
        src = os.path.realpath(str(v.get("source", "")))
        tgt = v.get("target")
        if not tgt or not RE_MOUNT_TARGET.match(str(tgt)):
            raise Reject("template: bad volume target")
        if src in SHIPPED_VOL_ALLOW:
            out += ["-v", "%s:%s:ro" % (src, tgt)]
        else:
            # a host bind outside the shipped safe allowlist is host-root-reach
            # -> dangerous-tier, permitted only for a signed template.
            need_sign("host bind %s" % src)
            ro = ":ro" if v.get("ro", True) else ""
            out += ["-v", "%s:%s%s" % (src, tgt, ro)]
    for k, val in (block.get("sysctls") or {}).items():
        if k not in SYSCTL_ALLOW:
            raise Reject("template: sysctl %r not allowed" % k)
        out += ["--sysctl", "%s=%s" % (k, val)]
    if "restart" in block:
        if block["restart"] not in RESTART_ALLOW:
            raise Reject("template: bad restart")
        out.append("--restart=" + block["restart"])
    return out, list(block.get("entrypoint") or [])


def _docker_capabilities(tpl, raw, runpath, allow_publish_net):
    """Return (cap_argv, entrypoint_argv) sourced from the template. BOTH the
    typed docker: block and the legacy free-form strings are gated on the shipped
    manifest for the host-root-equivalent capability tier: `signed` is a sha256
    over the SAME in-memory `raw` buffer that produced `tpl` (no re-read -> no
    TOCTOU), matched against the root-owned manifest. The typed path honours the
    benign subset unsigned and requires the signature only for dangerous caps;
    the free-form path requires the signature for ANY dock_args (it cannot be
    tier-inspected)."""
    digest = hashlib.sha256(raw).hexdigest()
    signed = digest in _manifest_hashes()
    if isinstance(tpl.get("docker"), dict):
        return _docker_build_typed(tpl["docker"], runpath, signed)
    free = (tpl.get("dock_args") or "").strip() or (tpl.get("docker_options") or "").strip()
    entry = []
    dock_cmd = (tpl.get("dock_cmd") or "").strip()
    if dock_cmd:
        entry = shlex.split(dock_cmd)
    if not free:
        return [], entry
    if not signed:
        raise Reject(
            "template not in shipped manifest (sha256=%s): convert its "
            "dock_args/docker_options to the typed docker: schema, or an admin "
            "must sign it with /opt/unetlab/scripts/pnetlab-template-sign" % digest)
    return _parse_freeform(free, runpath, allow_publish_net), entry


def _docker_console_publish(args):
    """Build `--net=bridge -p H:G ...` from the caller's typed publish pairs.
    Host ports are engine-assigned ints (>=1024); guest is the console port."""
    pub = args.get("publish")
    if not pub:
        return []
    if not isinstance(pub, list) or len(pub) > 4:
        raise Reject("bad arg publish")
    out = ["--net=bridge"]
    for p in pub:
        if not isinstance(p, dict):
            raise Reject("bad arg publish")
        host = v_int(p, "host")
        guest = v_int(p, "guest")
        if host < HOSTPORT_FLOOR or host > 65535 or guest < 1 or guest > 65535:
            raise Reject("publish port out of range")
        out += ["-p", "%d:%d" % (host, guest)]
    return out


def _docker_image(args):
    """Strip a trailing :<imageid> (12/64 hex) — mirrors the PHP drivers — then
    validate against RE_IMAGE."""
    img = args.get("image")
    if not isinstance(img, str):
        raise Reject("bad arg image")
    img = RE_IMG_ID_SUFFIX.sub("", img)
    if not RE_IMAGE.match(img) or ".." in img:
        raise Reject("bad arg image")
    return img


def _docker_hostname(args):
    """The -h hostname is the node name — an option-argument (single argv token,
    no shell), so it cannot inject a flag. Reject only NUL/newline and cap len."""
    v = args.get("name")
    if not isinstance(v, str) or v == "" or len(v) > 64:
        raise Reject("bad arg name")
    if "\x00" in v or "\n" in v or "\r" in v:
        raise Reject("bad arg name")
    return v


def verb_docker_create(args):
    """Build a `docker create` argv from typed leaf values + the ROOT-READ
    template capability set, and execute it as an array (never a shell string).
    Container name is derived here as docker<session>.

    family:
      docker  -- device_docker.php. Two branches selected by the template:
                 dock_args non-empty -> network-OS branch (no console publish);
                 else GUI branch (GDK/QT env + console publish). Both cap memory
                 (--memory <ram>M) and, if cpu>0, --cpus.
      ceos    -- device_ceos.php driver profile (fixed cEOS env + /sbin/init
                 setenv entrypoint; ETBA/EOS_PLATFORM are charset-validated leaf
                 values). No resource caps.
      srlinux -- device_srlinux.php driver profile (fixed sysctls + -u 0:0 +
                 --net=none + card-topology mount + optional startup-config mount
                 + optional license -v; sr_linux entrypoint). No resource caps."""
    session = v_int(args, "session")
    lab_session = v_int(args, "lab_session")
    family = v_enum(args, "family", {"docker", "ceos", "srlinux"})
    template = args.get("template")
    name = _docker_hostname(args)
    image = _docker_image(args)
    runpath = "%s/%d/%d" % (TMP_DIR, lab_session, session)
    cname = "docker%d" % session

    argv = ["docker", "-H=" + DOCKER_HOST, "create",
            "--pids-limit=%d" % DOCKER_NODE_PIDS_LIMIT]

    if family == "docker":
        raw, tpl, _ = _docker_read_template(template)
        dock_args = (tpl.get("dock_args") or "").strip()
        gui = not dock_args and not isinstance(tpl.get("docker"), dict)
        caps, entry = _docker_capabilities(tpl, raw, runpath, allow_publish_net=gui)
        if gui:
            argv += ["--env", "GDK_SCALE=2", "--env", "QT_SCALE_FACTOR=1.5"]
        argv.append("-ti")
        ram = args.get("ram")
        if ram is not None:
            argv += ["--memory", "%dM" % v_int(args, "ram")]
        cpu = int(v_int(args, "cpu")) if args.get("cpu") is not None else 0
        if cpu > 0:
            argv.append("--cpus=%d" % cpu)
        argv += caps
        if gui:
            argv += _docker_console_publish(args)
        if args.get("firstboot"):
            fb = _resolve_runpath_file(runpath, "firstboot.cfg")
            argv += ["-v", "%s:/firstboot.cfg:ro" % fb]
        argv += ["--name=" + cname, "-h", name, image]
        argv += entry

    elif family == "ceos":
        etba = v_re(args, "etba", RE_LEAF)
        eos_platform = v_re(args, "eos_platform", RE_LEAF)
        # device_ceos.php: fixed env + --net=none --privileged, then the
        # /sbin/init systemd.setenv entrypoint appended after the image.
        argv += [
            "-e", "INTFTYPE=eth", "-e", "ETBA=" + etba,
            "-e", "SKIP_ZEROTOUCH_BARRIER_IN_SYSDBINIT=1", "-e", "CEOS=1",
            "-e", "EOS_PLATFORM=" + eos_platform, "-e", "container=docker",
            "--net=none", "--privileged",
        ]
        argv += _docker_console_publish(args)
        argv += ["--name=" + cname, "-h", name, image]
        argv += [
            "/sbin/init", "systemd.setenv=INTFTYPE=eth",
            "systemd.setenv=ETBA=" + etba,
            "systemd.setenv=SKIP_ZEROTOUCH_BARRIER_IN_SYSDBINIT=1",
            "systemd.setenv=CEOS=1",
            "systemd.setenv=EOS_PLATFORM=" + eos_platform,
            "systemd.setenv=container=docker", "systemd.setenv=MAPETH0=1",
            "systemd.setenv=MGMT_INTF=eth0",
        ]

    else:  # srlinux
        card_type = v_re(args, "card_type", RE_LEAF)
        clab_intfs = v_int(args, "clab_intfs")
        # device_srlinux.php: startup-config mount (if present), clab_intfs env,
        # fixed sysctls + --net=none -u 0:0, card-topology mount, optional
        # license -v, then the sr_linux entrypoint.
        if args.get("has_startup"):
            src = _resolve_runpath_file(runpath, "startup-config")
            argv += ["--mount", "type=bind,source=%s,target=/startup-config" % src]
        argv += ["-e", "clab_intfs=%d" % clab_intfs]
        for k in ("net.ipv6.conf.all.disable_ipv6=0", "net.ipv4.ip_forward=0",
                  "net.ipv6.conf.all.accept_dad=0",
                  "net.ipv6.conf.default.accept_dad=0",
                  "net.ipv6.conf.all.autoconf=0",
                  "net.ipv6.conf.default.autoconf=0"):
            argv += ["--sysctl", k]
        argv += ["--net=none", "-u", "0:0"]
        topo = _resolve_runpath_file(runpath, card_type + ".yml")
        argv += ["--mount",
                 "type=bind,source=%s,target=/tmp/topology.yml,readonly" % topo]
        if v_bool(args, "sr_license"):
            lic = "/opt/unetlab/startup_configs/Docker/SR_linux/license.key"
            if os.path.realpath(lic) in SHIPPED_VOL_ALLOW:
                argv += ["-v", "%s:/opt/srlinux/etc/license.key:ro" % lic]
        argv += _docker_console_publish(args)
        argv += ["--name=" + cname, "-h", name, image]
        argv += ["sudo", "bash", "/opt/srlinux/bin/sr_linux"]

    log("docker_create %s family=%s image=%s" % (cname, family, image))
    return run(argv, timeout=120)


# ---- docker rebroker (Stage 3): exec + cp with fixed allowlists -------------
# The drivers used to exec() free-form `docker exec` / `docker cp` ROOT SHELL
# STRINGS built in PHP from engine state. Stage 3 replaces them with two verbs:
#
#   docker_exec — the command comes from the fixed enum below (every current
#     driver exec shape, enumerated by grep), never from the caller. The one
#     parameterised entry (ethtool_offload_e1) takes only a typed int. The
#     attach_* entries are the console-attach commands consumed today by the
#     ROOT-run console bridge (docker_console.sh/.py, docker_wrapper — launched
#     by the root unl_wrapper phase, NOT by www-data); they are in the enum so
#     the attach set is broker-authoritative and a later console stage can
#     route the PTY launch here without widening the allowlist. Anything not
#     in the enum is Rejected — there is NO free-form passthrough.
#
#   docker_cp — sources/dests come from the fixed selector map below: shipped
#     root-owned wrapper binaries pushed in from /opt/unetlab/wrappers (owner
#     verified uid 0, symlink-rejected), runningPath-jailed engine files pushed
#     in (basename-only, lstat symlink-reject + realpath jail — Stage 2 mount
#     discipline), and the two config-export out-copies whose DEST is jailed
#     the same way. RESIDUAL (same as Stage 2 mounts): the runningPath IN-copy
#     files (node_shell.sh, startup-config, initial-config) are www-data-
#     authored, so the BYTES are attacker-influenceable; only the path/name
#     is pinned here.
#
# Interactive vs one-shot: each enum entry carries the exact flags its call
# site used (-u root / -i / -it). The capture lane's one exec shape
# (raise_wireshark_window) rides this verb too — see the Stage 6 note in
# verb_docker_exec.

WRAPPERS_DIR = BASE + "/wrappers"

# cmd -> (exec flags, command argv) — exact current driver shapes.
DOCKER_EXEC_CMDS = {
    # one-shot maintenance/config execs
    "umount_resolv": (["-u", "root"], ["umount", "/etc/resolv.conf"]),
    "chmod_node_shell": ([], ["chmod", "+x", "/node_shell.sh"]),
    "ls_bin_bash": (["-i"], ["ls", "/bin/bash"]),
    "busybox_ln_bash": ([], ["/bash-static", "-c",
                             "/busybox ls /bin/bash 2>/dev/null || "
                             "/busybox ln /bash-static /bin/bash"]),
    "ethtool_offload_docker0": ([], ["sudo", "ethtool", "--offload", "docker0",
                                     "rx", "off", "tx", "off"]),
    # ethtool_offload_e1 is parameterised on a typed interface_id int — see verb.
    "sr_cli_source_startup": ([], ["sr_cli", "source", "startup-config",
                                   "auto-commit"]),
    "sr_cli_export": (["-u", "root"], ["bash", "-c",
                                       "sr_cli info flat from state  | more > "
                                       "export-config"]),
    # interactive console-attach commands (per family)
    "attach_node_shell": (["-it"], ["/node_shell.sh"]),   # docker_shell templates (XRd etc.)
    "attach_sh": (["-it"], ["sh"]),                       # generic docker fallback
    "attach_bin_bash": (["-it"], ["/bin/bash"]),          # generic docker (bash present)
    "attach_bash": (["-it"], ["bash"]),                   # ceos/srlinux bash console
    "attach_cli": (["-it"], ["Cli"]),                     # cEOS primary console
    "attach_sr_cli": (["-it"], ["sr_cli"]),               # SR Linux primary console
}

# file selector -> handled in verb_docker_cp. Wrapper pushes copy these shipped
# root-owned files from /opt/unetlab/wrappers into the container root.
DOCKER_CP_WRAPPERS = {
    "wrapper_busybox": "busybox",
    "wrapper_profile": "profile.sh",
    "wrapper_udhcpc": "udhcpc.script",
    "wrapper_bash_static": "bash-static",
}
# runningPath-jailed IN-copies: selector -> (runpath basename, container dest)
DOCKER_CP_RUNPATH_IN = {
    "node_shell": ("node_shell.sh", "/node_shell.sh"),
    "ceos_startup": ("startup-config", "/mnt/flash/"),
    "ceos_initial": ("initial-config", "/mnt/flash/startup-config"),
}
# container->host OUT-copies: selector -> (container src, runpath dest basename)
DOCKER_CP_OUT = {
    "ceos_export": ("/mnt/flash/startup-config", "export-config"),
    "srlinux_export": ("export-config", "export-config"),
}


def _docker_runpath(args):
    """The node runningPath jail — same derivation as verb_docker_create."""
    return "%s/%d/%d" % (TMP_DIR, v_int(args, "lab_session"),
                         v_int(args, "node_session"))


def verb_docker_exec(args):
    """`docker exec [flags] docker<node_session> <cmd...>` where <cmd...> is a
    fixed enum entry (or the typed-int-parameterised ethtool e1 shape). Name is
    derived here from the typed id; executed as an argv array, never sh -c.
    Unknown commands are Rejected — fail closed, no passthrough.

    Stage 6 adds ONE capture-lane entry: raise_wireshark_window runs the fixed
    xdotool raise/maximize command inside the legacy SHARED per-lab capture
    container (Capture_<t>_<l>, name derived here from typed ints). The window
    title is built HERE from a typed cap_idx int and shlex-quoted — nothing
    free-form crosses into the sh -c string."""
    if args.get("cmd") == "raise_wireshark_window":
        name = _capture_shared_name(args.get("tenant"), args.get("lab_session"))
        idx = v_int(args, "cap_idx")
        inner = ("DISPLAY=:1 xdotool search --name %s windowactivate --sync "
                 "windowsize 100%% 100%% windowmove 0 0"
                 % shlex.quote("Capturing from cap%d" % idx))
        log("docker_exec %s cmd=raise_wireshark_window idx=%d" % (name, idx))
        return run(["docker", "-H=" + DOCKER_HOST, "exec", name,
                    "sh", "-c", inner], timeout=90, check_rc=False)
    name = _docker_name(args.get("node_session"))
    if args.get("cmd") == "ethtool_offload_e1":
        ifid = v_int(args, "interface_id")
        flags, cmd = [], ["sudo", "ethtool", "--offload", "e1-%d" % ifid,
                          "rx", "off", "tx", "off"]
        sel = "ethtool_offload_e1"
    else:
        sel = v_enum(args, "cmd", set(DOCKER_EXEC_CMDS))
        flags, cmd = DOCKER_EXEC_CMDS[sel]
    log("docker_exec %s cmd=%s" % (name, sel))
    return run(["docker", "-H=" + DOCKER_HOST, "exec"] + flags + [name] + cmd,
               timeout=90, check_rc=False)


def _docker_cp_out(name, ctr_src, dst):
    """Container->host copy WITHOUT ever letting root `docker cp` write directly
    to the www-data-owned runningPath dest (docker-rebroker fix2: TOCTOU — between
    the resolve-time symlink check and the root copy, www-data could swap `dst`
    for a symlink and steer root's write outside the jail). Instead: `docker cp`
    the container source to a PRIVATE root-owned staging file under RUN_DIR, then
    place it at `dst` through an O_NOFOLLOW|O_CREAT|O_EXCL open — which refuses a
    symlink (ELOOP) or any file swapped in at the final path (EEXIST), so root
    never follows a symlink. Result is root:root 0644, matching the prior
    docker-cp-created export file (www-data reads it read-only)."""
    os.makedirs(RUN_DIR, exist_ok=True)
    fd, stage = tempfile.mkstemp(prefix="cp-stage-", dir=RUN_DIR)
    os.close(fd)
    try:
        r = run(["docker", "-H=" + DOCKER_HOST, "cp", name + ":" + ctr_src, stage],
                timeout=90, check_rc=False)
        if r[0] != 0:
            # docker cp failed (e.g. source absent) — surface the rc, leave the
            # existing dest untouched, place nothing.
            return r
        # Clear our own prior export (the engine expects to overwrite it); then
        # create the dest fresh. O_NOFOLLOW+O_EXCL fail closed if www-data has
        # planted a symlink or a file at dst after the unlink.
        try:
            if not os.path.islink(dst):
                os.unlink(dst)
        except FileNotFoundError:
            pass
        except OSError:
            pass
        dfd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            with open(stage, "rb") as s:
                while True:
                    chunk = s.read(1 << 16)
                    if not chunk:
                        break
                    os.write(dfd, chunk)
            os.fchmod(dfd, 0o644)
            try:
                os.fchown(dfd, 0, 0)
            except OSError:
                pass
        finally:
            os.close(dfd)
        return r
    finally:
        try:
            os.unlink(stage)
        except OSError:
            pass


def verb_docker_cp(args):
    """`docker cp` with both endpoints fixed by the file selector: wrapper
    pushes (shipped root-owned /opt/unetlab/wrappers files), runningPath-jailed
    IN-copies (basename-only, symlink-reject, realpath jail), and the two
    config-export OUT-copies. Name derived from the typed id. Anything else —
    unknown selector, symlink, escape — Rejects.

    OUT-copies do NOT let root docker cp write to the www-data dest directly;
    they stage to a private root file and place it via O_NOFOLLOW — see
    _docker_cp_out (fix2)."""
    name = _docker_name(args.get("node_session"))
    sel = v_enum(args, "file", set(DOCKER_CP_WRAPPERS)
                 | set(DOCKER_CP_RUNPATH_IN) | set(DOCKER_CP_OUT))
    if sel in DOCKER_CP_WRAPPERS:
        src = os.path.join(WRAPPERS_DIR, DOCKER_CP_WRAPPERS[sel])
        if os.path.islink(src) or not os.path.isfile(src):
            raise Reject("docker_cp: wrapper %s missing/symlinked" % sel)
        if os.stat(src).st_uid != 0:
            raise Reject("docker_cp: wrapper %s not root-owned" % sel)
        pair = [src, name + ":/"]
    elif sel in DOCKER_CP_RUNPATH_IN:
        base, dst = DOCKER_CP_RUNPATH_IN[sel]
        src = _resolve_runpath_file(_docker_runpath(args), base)
        if not os.path.isfile(src):
            raise Reject("docker_cp: %s not present in runningPath" % base)
        pair = [src, name + ":" + dst]
    else:
        ctr_src, base = DOCKER_CP_OUT[sel]
        dst = _resolve_runpath_file(_docker_runpath(args), base)
        log("docker_cp %s file=%s (out, staged)" % (name, sel))
        return _docker_cp_out(name, ctr_src, dst)
    log("docker_cp %s file=%s" % (name, sel))
    return run(["docker", "-H=" + DOCKER_HOST, "cp"] + pair,
               timeout=90, check_rc=False)


def _docker_target_name(args):
    """Stage 6: start/stop/rm gained the capture lane. The target container
    name is STILL derived here from typed integer ids — 'kind' only selects
    WHICH derivation ('node' -> docker<ns>, 'capture' -> Capture_<t>_<l>_<ns>_<if>,
    'capture_shared' -> Capture_<t>_<l>). Absent kind = 'node' (the Stage 2
    callers pass no kind and keep their exact behavior)."""
    kind = args.get("kind")
    if kind is None:
        kind = "node"
    kind = v_enum({"kind": kind}, "kind", {"node", "capture", "capture_shared"})
    if kind == "node":
        return _docker_name(args.get("node_session"))
    if kind == "capture":
        return _capture_name(args.get("tenant"), args.get("lab_session"),
                             args.get("node_session"), args.get("interface_id"))
    return _capture_shared_name(args.get("tenant"), args.get("lab_session"))


def verb_docker_start(args):
    """`docker start <derived-name>` — name derived from the typed ids."""
    name = _docker_target_name(args)
    # Existing node containers survive package upgrades. Correct their inherited
    # PID ceiling before boot as well, without recreating disks or changing any
    # memory/CPU settings. An update failure must not proceed to a broken start.
    if name.startswith("docker"):
        result = run(["docker", "-H=" + DOCKER_HOST, "update",
                      "--pids-limit=%d" % DOCKER_NODE_PIDS_LIMIT, name], timeout=30)
        if result[0] != 0:
            return result
    return run(["docker", "-H=" + DOCKER_HOST, "start", name], timeout=60)


def verb_docker_stop(args):
    """`docker stop <derived-name>` — name derived from the typed ids."""
    name = _docker_target_name(args)
    return run(["docker", "-H=" + DOCKER_HOST, "stop", name],
               timeout=60, check_rc=False)


def verb_docker_rm(args):
    """`docker rm [--force] <derived-name>` — name derived from the typed ids."""
    name = _docker_target_name(args)
    argv = ["docker", "-H=" + DOCKER_HOST, "rm"]
    if v_bool(args, "force"):
        argv.append("--force")
    argv.append(name)
    return run(argv, timeout=60, check_rc=False)


# ---- docker rebroker (Stage 4): image lifecycle ------------------------------
# devices-factory/api.php (admin-only) used to dial :4243 directly from
# www-data for pull / rmi / ancestor-lookup / image-list. Those now ride these
# verbs: the image REFERENCE is the only caller input, validated against the
# same strict grammar api.php enforces client-side (RE_IMAGE_REF, mirrored from
# its PNQ_REF_RE — no whitespace, no shell metacharacters), and every docker
# call is an argv ARRAY. `docker import`/`docker load` in root-context config
# scripts are NOT here — they never ran as www-data (Stage 7 repoints them).

# Strict docker image reference: optional registry[:port]/, repo path segments,
# optional :tag, optional @sha256:digest. Mirror of api.php's PNQ_REF_RE — keep
# both in sync.
RE_IMAGE_REF = re.compile(
    r"^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?/)?"
    r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*"
    r"(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*"
    r"(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?"
    r"(?:@sha256:[a-f0-9]{64})?$")
# Docker's short/long image id: bare lowercase hex (rmi/ancestor accept either).
RE_IMAGE_ID = re.compile(r"^[a-f0-9]{12,64}$")


def _image_ref(args, allow_id=False):
    ref = args.get("ref")
    if not isinstance(ref, str) or not (0 < len(ref) <= 256):
        raise Reject("bad image ref")
    if RE_IMAGE_REF.match(ref) or (allow_id and RE_IMAGE_ID.match(ref)):
        return ref
    raise Reject("bad image ref")


def verb_docker_image_pull(args):
    """Detached `docker pull <ref>` on the device-factory lane. The job id,
    logfile and end-of-job process_device row cleanup keep the exact contract
    api.php's process-polling expects (jobId = 'custom'+md5(ref)[:12], log at
    /tmp/pnet_device_factory_<job>_log, unit pnet-factory-<job> so
    device_factory_kill/rm still apply) — but the script body is authored HERE
    from the validated ref, no longer a www-data-written /tmp file."""
    ref = _image_ref(args)
    job = "custom" + hashlib.md5(ref.encode()).hexdigest()[:12]
    logpath = "/tmp/pnet_device_factory_%s_log" % job
    # Drop any pre-existing file/symlink at the log path (www-data could have
    # planted a symlink; `set -C` below additionally refuses to create through
    # one if it reappears — the unit then fails closed).
    if os.path.islink(logpath) or os.path.exists(logpath):
        os.unlink(logpath)
    q = shlex.quote(ref)   # belt-and-braces; the ref grammar has no metachars
    body = ("set -C; { "
            "echo \"Pulling %s from Docker Hub...\"; "
            "docker -H=%s pull %s; RC=$?; "
            "if [ \"$RC\" = \"0\" ]; then echo \"Done. %s is ready.\"; "
            "else echo \"FAILED to pull %s (rc=$RC)\"; fi; "
            "mysql pnetlab_db -e \"DELETE FROM process_device WHERE "
            "process_device_id='%s'\"; } > %s 2>&1"
            % (q, DOCKER_HOST, q, q, q, job, logpath))
    log("docker_image_pull %s job=%s" % (ref, job))
    spawn_unit("pnet-factory-" + job, ["/bin/bash", "-c", body],
               setenv=("HOME=/root",))
    return 0, [job], ""


def verb_docker_image_rmi(args):
    """`docker rmi <ref-or-id>` — NEVER -f/force: an image still referenced by
    any container (running or stopped) fails with Docker's own error, which is
    the in-use protection api.php surfaces back to the admin verbatim-ish."""
    ref = _image_ref(args, allow_id=True)
    log("docker_image_rmi %s" % ref)
    return run(["docker", "-H=" + DOCKER_HOST, "rmi", ref],
               timeout=120, check_rc=False)


def verb_docker_image_ancestor(args):
    """`docker ps -a --filter ancestor=<ref> --format {{.Names}}` — the
    read-only in-use lookup the catalog delete action guards with."""
    ref = _image_ref(args, allow_id=True)
    return run(["docker", "-H=" + DOCKER_HOST, "ps", "-a",
                "--filter", "ancestor=" + ref, "--format", "{{.Names}}"],
               timeout=60, check_rc=False)


def verb_docker_image_ls(args):
    """Read-only local image-store listings (no caller input beyond a fixed
    mode): images_json = `docker images --format {{json .}}` (one JSON object
    per line), used = `docker ps -a --format {{.Image}}` (in-use hint), refs =
    `docker images --format {{.Repository}}:{{.Tag}}` (for the template image
    picker in devices/functions.php — that read caller ports over in Stage 5)."""
    mode = v_enum(args, "mode", {"images_json", "used", "refs"})
    if mode == "images_json":
        argv = ["docker", "-H=" + DOCKER_HOST, "images", "--format", "{{json .}}"]
    elif mode == "used":
        argv = ["docker", "-H=" + DOCKER_HOST, "ps", "-a", "--format", "{{.Image}}"]
    else:
        argv = ["docker", "-H=" + DOCKER_HOST, "images",
                "--format", "{{.Repository}}:{{.Tag}}"]
    return run(argv, timeout=60, check_rc=False)


# ---- docker rebroker (Stage 5): read-only status / stats / health -----------
# api_status.php + status/api.php (running-container count, server version),
# pnq-nodestats.php (per-container cpu/mem) and doctor.php (engine
# reachability) used to dial :4243 directly from www-data. These verbs take NO
# free caller input (the one optional 'format' echo is an allowlist of one),
# and the old `ps -q | wc -l` shell pipe becomes a Python line count — no
# shell, argv arrays only. When the tcp socket closes in Stage 7 only the
# broker's DOCKER_HOST moves; every one of these callers stays green.

# The ONLY stats format the engine uses (pnq-nodestats.php) — allowlist of one.
DOCKER_STATS_FORMAT = "{{.Name}};{{.CPUPerc}};{{.MemUsage}}"


def verb_docker_ps_count(args):
    """Running-container count: `docker ps -q` root-side, the id lines counted
    HERE (no `| wc -l` pipe). out = [str(count)]."""
    rc, out, err = run(["docker", "-H=" + DOCKER_HOST, "ps", "-q"],
                       timeout=30, check_rc=False)
    if rc != 0:
        return rc, ["0"], err
    return 0, [str(sum(1 for l in out if l.strip()))], ""


def verb_docker_stats(args):
    """Read-only `docker stats --no-stream` with the FIXED format string above
    (one 'name;cpu%;mem' line per running container). A caller-supplied
    'format', when present, must equal it exactly — no free-form Go-template
    passthrough."""
    if args.get("format") is not None:
        v_enum(args, "format", {DOCKER_STATS_FORMAT})
    return run(["docker", "-H=" + DOCKER_HOST, "stats", "--no-stream",
                "--format", DOCKER_STATS_FORMAT], timeout=60, check_rc=False)


def verb_docker_version(args):
    """Docker engine reachability + server version:
    `docker version --format {{.Server.Version}}`. rc!=0 / empty out means the
    engine endpoint is down. doctor.php keys its docker health check off THIS
    verb instead of curling :4243/_ping, so the check stays truthful when the
    tcp socket closes in Stage 7."""
    return run(["docker", "-H=" + DOCKER_HOST, "version",
                "--format", "{{.Server.Version}}"], timeout=30, check_rc=False)


# ---- docker rebroker (Stage 6): capture + winbox container lane -------------
# functions.php (addWinboxSystem / addWiresharkSystem / addWifiCaptureWeb /
# deleteWireshark / removeWiresharkContainer / focusWiresharkWindow) and
# api.php's capture image check were the LAST www-data :4243 docker callers in
# the web tree. Their container profiles differ from lab nodes (NET_ADMIN
# capture sidecar, read-only pcap bind, winbox --privileged), so instead of
# widening the Stage 2 typed template builder, each shape gets its own NARROW
# verb whose entire argv is FIXED here: the only caller inputs are typed ints
# (names/hostnames/paths all derived broker-side), one enum (medium), and — in
# exactly one place, capture_rm — a container NAME bounded by RE_CAPTURE_NAME
# (the ws_dc_name stale-session teardown, whose value is server-derived and
# prepared-statement-stored, but which by design no longer matches the ids).

# Capture-container names ONLY (both the per-interface and the legacy shared
# per-lab shape). Deliberately EXCLUDES docker<n> node containers — capture_rm
# must never be able to rm a lab node.
RE_CAPTURE_NAME = re.compile(r"^Capture_\d{1,10}_\d{1,10}(?:_\d{1,10}_\d{1,10})?$")
CAPTURE_IMAGE = "pnet-capture-web:1.0"
WINBOX_IMAGE = "alexhorner/winbox-dockerised"


def verb_capture_create(args):
    """Create the live per-interface capture sidecar:
    `docker create --shm-size 1G --cap-add=NET_ADMIN -ti --net=none
       --name=Capture_<t>_<l>_<ns>_<if> -h <tap> pnet-capture-web:1.0`
    Name AND -h hostname (the node tap: vunl<ns>_<if> / ser<ns>_<if>, selected
    by the typed 'serial' flag) are derived here from typed ints; image and
    every flag are fixed. --net=none: eth0/eth1 are attached afterwards by the
    already-brokered capture_rdp_attach / capture_mirror_attach verbs."""
    name = _capture_name(args.get("tenant"), args.get("lab_session"),
                         args.get("node_session"), args.get("interface_id"))
    host = ("ser" if v_bool(args, "serial") else "vunl") + "%d_%d" % (
        v_int(args, "node_session"), v_int(args, "interface_id"))
    log("capture_create %s" % name)
    return run(["docker", "-H=" + DOCKER_HOST, "create",
                "--shm-size", "1G", "--cap-add=NET_ADMIN", "-ti", "--net=none",
                "--name=" + name, "-h", host, CAPTURE_IMAGE],
               timeout=120, check_rc=False)


def verb_capture_wifi_create(args):
    """FILE-MODE capture viewer for the session Wi-Fi pcap (addWifiCaptureWeb).
    Same fixed profile as capture_create plus a READ-ONLY bind of the pcap and
    CAPTURE_FILE env. The pcap PATH is derived HERE from the typed lab_session
    + medium enum — /opt/unetlab/tmp/<l>/wifi[-vwifi]-<l>.pcap — with symlink
    reject + realpath jail; no path crosses the socket. node_session is the
    reserved synthetic Wi-Fi capture node (airduct=901, vwifi=902), forced
    here, so the container name cannot collide with a real node's capture."""
    tenant = v_int(args, "tenant")
    session = v_int(args, "lab_session")
    medium = v_enum(args, "medium", {"airduct", "vwifi"})
    syn_node = 902 if medium == "vwifi" else 901
    name = _capture_name(tenant, session, syn_node, 0)
    base = "%s/%d" % (TMP_DIR, session)
    pcap = "%s/%s%d.pcap" % (base, "wifi-vwifi-" if medium == "vwifi" else "wifi-",
                             session)
    if os.path.islink(pcap):
        raise Reject("capture_wifi_create: refuse symlinked pcap")
    real = os.path.realpath(pcap)
    if not (real + "/").startswith(base.rstrip("/") + "/") and \
            not real.startswith(base.rstrip("/") + "/"):
        raise Reject("capture_wifi_create: pcap escapes session tmp")
    if not os.path.isfile(real):
        raise Reject("capture_wifi_create: pcap missing")
    log("capture_wifi_create %s medium=%s" % (name, medium))
    return run(["docker", "-H=" + DOCKER_HOST, "create",
                "--shm-size", "1G", "--cap-add=NET_ADMIN", "-ti", "--net=none",
                "--name=" + name,
                "-e", "CAPTURE_FILE=/wifi/cap.pcap",
                "-v", "%s:/wifi/cap.pcap:ro" % real,
                "-h", "wifi-" + medium, CAPTURE_IMAGE],
               timeout=120, check_rc=False)


def verb_winbox_create(args):
    """Create the Mikrotik winbox container (addWinboxSystem) — argv moved here
    FAITHFULLY from the PHP string, including its two pre-existing quirks:
    `--cpu=2 --entrypoint wine /winbox64` sits AFTER the image (so it is
    container argv, not docker flags) and --privileged remains (the image is
    unavailable to profile a minimal cap set — see the functions.php TODO).
    Name is the same Capture_<t>_<l>_<ns>_<if> shape, derived from typed ints;
    the -h hostname (<node>_<iface>) is an option-argument single token — it
    cannot become a flag — validated only for NUL/newline/length."""
    name = _capture_name(args.get("tenant"), args.get("lab_session"),
                         args.get("node_session"), args.get("interface_id"))
    host = args.get("hostname")
    if not isinstance(host, str) or host == "" or len(host) > 128:
        raise Reject("bad arg hostname")
    if "\x00" in host or "\n" in host or "\r" in host:
        raise Reject("bad arg hostname")
    log("winbox_create %s" % name)
    return run(["docker", "-H=" + DOCKER_HOST, "create",
                "--shm-size", "1G", "--net=bridge", "--privileged", "-ti",
                "--env", "VNC_BUILTIN_WIDTH=800",
                "--env", "VNC_BUILTIN_HEIGHT=600",
                "--env", "GDK_SCALE=2", "--env", "QT_SCALE_FACTOR=1.5",
                "--name=" + name, "-h", host, WINBOX_IMAGE,
                "--cpu=2", "--entrypoint", "wine", "/winbox64"],
               timeout=120, check_rc=False)


def verb_capture_rm(args):
    """`docker rm -f <name>` for a CAPTURE container addressed BY NAME — the one
    name-argument verb in the docker lane, needed because deleteWireshark /
    addWiresharkSystem must tear down the wiresharks row's RECORDED ws_dc_name
    when a node restart changed node_session (the id-derived name no longer
    matches the actual container). The name is server-derived + prepared-
    statement-stored on the PHP side and re-bounded HERE by RE_CAPTURE_NAME,
    which matches ONLY Capture_<ints> shapes — a lab node (docker<n>) or any
    other container name Rejects."""
    name = args.get("name")
    if not isinstance(name, str) or len(name) > 64 \
            or not RE_CAPTURE_NAME.match(name):
        raise Reject("bad arg name")
    log("capture_rm %s" % name)
    return run(["docker", "-H=" + DOCKER_HOST, "rm", "-f", name],
               timeout=60, check_rc=False)


# ---- external authentication (RADIUS / LDAP) --------------------------------
# Credentials are validated HERE (root) because the RADIUS shared secret and
# the LDAP service-account bind password live root-only in
# data/extauth/config.json (0600) — www-data must never read them. The user
# password transits the local unix socket once per login (same trust boundary
# as the DB write) and is NEVER logged: the dispatch _LOG_REDACT covers the
# top-level "password" arg and the whole "radius"/"ldap" sub-objects, and every
# log line in this section carries username + source + result only.
#
# Protocol clients are VETTED LIBRARIES, not hand-rolled:
#   RADIUS — pyrad 2.5.4 (BSD), vendored under scripts/vendor/pyrad so it ships
#            with the deb payload and works airgapped (stdlib-only imports).
#   LDAP   — python-ldap (libldap-backed), from the python3-ldap package.
#            NOT vendored (C extension); release follow-up: add python3-ldap
#            to the offline apt pool / installer package list.
#
# RADIUS hardening (CVE-2024-3596 "BlastRADIUS" class):
#   * a Message-Authenticator is MANDATORY on every Access-Request
#     (Client(enforce_ma=True) adds it to the request),
#   * the Response Authenticator is ALWAYS verified (pyrad VerifyReply inside
#     SendPacket drops replies failing the MD5 check),
#   * the reply MUST carry a VALID Message-Authenticator — enforced explicitly
#     below; replies missing or failing it are DROPPED (treated as no reply).
# LDAP hardening:
#   * empty/whitespace passwords are rejected BEFORE any bind (RFC 4513: a
#     simple bind with a DN and a zero-length password is an UNAUTHENTICATED
#     bind most servers answer "success" — the classic bypass),
#   * authenticated-bind flow: service bind -> search the user -> re-bind AS
#     the user DN with the supplied password; a search filter is built with
#     ldap.filter.escape_filter_chars (injection guard),
#   * TLS certificate verification defaults ON; verify=false / plaintext
#     ldap:// are explicit opt-ins that log a warning on every use.

EXTAUTH_DIR = BASE + "/data/extauth"
EXTAUTH_CONFIG = EXTAUTH_DIR + "/config.json"
EXTAUTH_VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
EXTAUTH_RADIUS_DICT = os.path.join(EXTAUTH_VENDOR, "pyrad", "dictionary.pnet")
RE_EXTAUTH_USER = re.compile(r"^[A-Za-z0-9@._\\-]{1,64}$")
RE_EXTAUTH_HOST = re.compile(r"^[A-Za-z0-9._-]{1,255}$")
RE_EXTAUTH_URI = re.compile(r"^ldaps?://[A-Za-z0-9._-]{1,255}(:[0-9]{1,5})?/?$")
RE_EXTAUTH_NASID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
EXTAUTH_USER_ATTRS = {"uid", "sAMAccountName", "cn", "mail", "userPrincipalName"}
EXTAUTH_GROUP_ATTRS = {"memberOf", "member"}
EXTAUTH_MODES = {"radius", "ldap", "both"}


def _extauth_default_config():
    return {
        "enabled": False,
        # both = RADIUS primary, LDAP consulted only when RADIUS is unreachable
        "mode": "ldap",
        # default OFF: enabling lets EVERY external user fall back to their
        # (possibly stale) local hash whenever the directory is unreachable —
        # a deliberate availability-over-strictness tradeoff the admin opts
        # into; every fallback event is loudly logged by the engine.
        "fallback_local": False,
        "radius": {"primary_host": "", "primary_port": 1812,
                   "secondary_host": "", "secondary_port": 1812,
                   "secret": "", "timeout": 3, "nas_identifier": "pnetlab"},
        "ldap": {"uri": "", "starttls": False, "verify": True,
                 "bind_dn": "", "bind_pw": "", "base_dn": "",
                 "user_attr": "sAMAccountName", "group_attr": "memberOf",
                 "timeout": 5},
        "group_map": [],       # [{group, role, prio}] — role may NEVER be admin
        "default_role": None,  # role name applied when no group matches (never admin)
    }


def _extauth_load_config():
    cfg = None
    try:
        with open(EXTAUTH_CONFIG, "r") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        cfg = None
    d = _extauth_default_config()
    if not isinstance(cfg, dict):
        return d
    for sect, defv in d.items():
        if isinstance(defv, dict):
            if not isinstance(cfg.get(sect), dict):
                cfg[sect] = defv
            else:
                for k, v in defv.items():
                    cfg[sect].setdefault(k, v)
        else:
            cfg.setdefault(sect, defv)
    return cfg


def _extauth_save_config(cfg):
    os.makedirs(EXTAUTH_DIR, exist_ok=True)
    os.chmod(EXTAUTH_DIR, 0o700)              # root-only: holds shared secrets
    tmp = EXTAUTH_CONFIG + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(cfg, fh, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, EXTAUTH_CONFIG)


def _extauth_redacted(cfg):
    """Config view for the admin dashboard — secrets never leave root."""
    r = dict(cfg.get("radius", {}))
    l = dict(cfg.get("ldap", {}))
    r_secret = r.pop("secret", "")
    l_pw = l.pop("bind_pw", "")
    r["secret_set"] = bool(r_secret)
    l["bind_pw_set"] = bool(l_pw)
    return {
        "enabled": bool(cfg.get("enabled")),
        "mode": cfg.get("mode", "ldap"),
        "fallback_local": bool(cfg.get("fallback_local")),
        "radius": r,
        "ldap": l,
        "group_map": cfg.get("group_map", []),
        "default_role": cfg.get("default_role"),
    }


def _extauth_role_forbidden(role):
    """HARD DENYLIST: a directory group may NEVER resolve to the built-in
    admin role (name 'admin' or role id 0). Admin stays local-only."""
    return str(role).strip().lower() in ("admin", "0")


def _extauth_radius_verify(cfg, username, password):
    """Returns (True, groups) on Access-Accept, (False, []) on Access-Reject,
    (None, []) when no server produced an AUTHENTIC reply (unreachable)."""
    rcfg = cfg.get("radius", {})
    secret = rcfg.get("secret", "")
    if not rcfg.get("primary_host") or not secret:
        log("extauth: radius not configured")
        return None, []
    if EXTAUTH_VENDOR not in sys.path:
        sys.path.insert(0, EXTAUTH_VENDOR)
    try:
        from pyrad.client import Client, Timeout
        from pyrad.dictionary import Dictionary
        from pyrad import packet as radpacket
    except Exception as e:
        log("extauth: vendored pyrad unavailable: %r" % e)
        return None, []
    try:
        rdict = Dictionary(EXTAUTH_RADIUS_DICT)
    except Exception as e:
        log("extauth: radius dictionary unreadable: %r" % e)
        return None, []
    timeout = min(max(int(rcfg.get("timeout", 3) or 3), 1), 10)
    servers = [(rcfg.get("primary_host"), int(rcfg.get("primary_port", 1812) or 1812))]
    if rcfg.get("secondary_host"):
        servers.append((rcfg.get("secondary_host"),
                        int(rcfg.get("secondary_port", 1812) or 1812)))
    for host, port in servers:
        # enforce_ma=True -> the Access-Request ALWAYS carries a
        # Message-Authenticator (mandatory, not optional).
        srv = Client(server=host, authport=port,
                     secret=secret.encode("utf-8", "surrogateescape"),
                     dict=rdict, retries=2, timeout=timeout, enforce_ma=True)
        req = srv.CreateAuthPacket(code=radpacket.AccessRequest,
                                   User_Name=username)
        req["User-Password"] = req.PwCrypt(password)
        nasid = rcfg.get("nas_identifier") or "pnetlab"
        req["NAS-Identifier"] = nasid
        try:
            # SendPacket verifies the Response Authenticator (MD5 over
            # code+id+len+RequestAuth+attrs+secret) and silently drops
            # non-verifying datagrams until timeout.
            reply = srv.SendPacket(req)
        except Timeout:
            log("extauth: radius %s:%d timeout" % (host, port))
            continue
        except OSError as e:
            log("extauth: radius %s:%d socket error: %r" % (host, port, e))
            continue
        finally:
            try:
                srv._CloseSocket()
            except Exception:
                pass
        # Reply Message-Authenticator is REQUIRED and VERIFIED; a reply
        # missing or failing it is DROPPED (treated as if no reply arrived).
        try:
            ma_ok = (reply.message_authenticator is not None and
                     reply.verify_message_authenticator(
                         original_authenticator=req.authenticator))
        except Exception:
            ma_ok = False
        if not ma_ok:
            log("extauth: radius %s:%d reply without valid "
                "Message-Authenticator DROPPED" % (host, port))
            continue
        if reply.code == radpacket.AccessAccept:
            groups = []
            for attr in ("Filter-Id", "Class"):
                try:
                    vals = reply[attr]
                except KeyError:
                    vals = []
                for v in vals:
                    if isinstance(v, bytes):
                        v = v.decode("utf-8", "replace")
                    v = str(v).strip()
                    if v:
                        groups.append(v)
            return True, groups
        return False, []
    return None, []


def _extauth_ldap_conn(ldap, lcfg):
    uri = lcfg.get("uri", "")
    timeout = min(max(int(lcfg.get("timeout", 5) or 5), 1), 30)
    conn = ldap.initialize(uri)
    conn.set_option(ldap.OPT_PROTOCOL_VERSION, 3)
    conn.set_option(ldap.OPT_REFERRALS, 0)
    conn.set_option(ldap.OPT_NETWORK_TIMEOUT, timeout)
    conn.set_option(ldap.OPT_TIMEOUT, timeout)
    starttls = bool(lcfg.get("starttls"))
    if uri.startswith("ldaps://") or starttls:
        if lcfg.get("verify", True):
            conn.set_option(ldap.OPT_X_TLS_REQUIRE_CERT, ldap.OPT_X_TLS_DEMAND)
        else:
            # explicit admin opt-in — the settings UI shows a persistent
            # warning banner; log every use so the posture is auditable
            conn.set_option(ldap.OPT_X_TLS_REQUIRE_CERT, ldap.OPT_X_TLS_NEVER)
            log("extauth: WARNING ldap TLS certificate verification DISABLED "
                "(explicit opt-in)")
        conn.set_option(ldap.OPT_X_TLS_NEWCTX, 0)
    elif uri.startswith("ldap://"):
        log("extauth: WARNING plaintext ldap:// bind in use (explicit opt-in, "
            "no transport encryption)")
    if starttls and uri.startswith("ldap://"):
        conn.start_tls_s()
    return conn


def _extauth_ldap_verify(cfg, username, password):
    """Service bind -> search user -> bind AS the user DN with the supplied
    password. Returns (True, groups) / (False, []) / (None, []) like radius."""
    # Belt & braces: the verb already rejects empty/whitespace passwords, but
    # NEVER let one reach a bind from here either (unauthenticated-bind bypass).
    if not isinstance(password, str) or password.strip() == "":
        return False, []
    lcfg = cfg.get("ldap", {})
    if not lcfg.get("uri") or not lcfg.get("base_dn"):
        log("extauth: ldap not configured")
        return None, []
    try:
        import ldap
        import ldap.filter
    except Exception as e:
        log("extauth: python3-ldap not installed: %r" % e)
        return None, []
    user_attr = lcfg.get("user_attr", "sAMAccountName")
    group_attr = lcfg.get("group_attr", "memberOf")
    if user_attr not in EXTAUTH_USER_ATTRS or group_attr not in EXTAUTH_GROUP_ATTRS:
        log("extauth: ldap attrs invalid")
        return None, []
    try:
        conn = _extauth_ldap_conn(ldap, lcfg)
        conn.simple_bind_s(lcfg.get("bind_dn", ""), lcfg.get("bind_pw", ""))
    except ldap.INVALID_CREDENTIALS:
        log("extauth: ldap SERVICE bind rejected — check bind_dn/bind_pw")
        return None, []
    except ldap.LDAPError as e:
        log("extauth: ldap unreachable (service bind): %s" % type(e).__name__)
        return None, []
    try:
        flt = "(%s=%s)" % (user_attr, ldap.filter.escape_filter_chars(username))
        res = conn.search_s(lcfg.get("base_dn", ""), ldap.SCOPE_SUBTREE,
                            flt, [group_attr])
    except ldap.LDAPError as e:
        log("extauth: ldap search failed: %s" % type(e).__name__)
        try:
            conn.unbind_s()
        except Exception:
            pass
        return None, []
    entries = [(dn, at) for dn, at in res if dn]
    if len(entries) != 1:
        log("extauth: ldap user=%s -> %d matches (denied)" % (username, len(entries)))
        try:
            conn.unbind_s()
        except Exception:
            pass
        return False, []
    user_dn, attrs = entries[0]
    groups = []
    if group_attr == "memberOf":
        for v in attrs.get("memberOf", []) or []:
            groups.append(v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v))
    else:
        # group objects list members: search groups whose member = the user DN
        try:
            gflt = "(member=%s)" % ldap.filter.escape_filter_chars(user_dn)
            gres = conn.search_s(lcfg.get("base_dn", ""), ldap.SCOPE_SUBTREE,
                                 gflt, ["cn"])
            for gdn, gat in gres:
                if gdn:
                    groups.append(gdn)
        except ldap.LDAPError:
            pass
    try:
        conn.unbind_s()
    except Exception:
        pass
    # Authenticated bind AS the user — the ONLY step that proves the password.
    # A fresh connection so no state leaks from the service bind.
    try:
        conn2 = _extauth_ldap_conn(ldap, lcfg)
        conn2.simple_bind_s(user_dn, password)
        conn2.unbind_s()
    except ldap.INVALID_CREDENTIALS:
        return False, []
    except ldap.UNWILLING_TO_PERFORM:
        return False, []
    except ldap.LDAPError as e:
        log("extauth: ldap unreachable (user bind): %s" % type(e).__name__)
        return None, []
    return True, groups


def _extauth_verify_core(cfg, username, password, pref=None):
    """Tri-state verification driving the engine's fallback decision.

    mode precedence (documented contract):
      radius — RADIUS only.
      ldap   — LDAP only.
      both   — the user's own flag (users.ext_auth, passed as `pref`) is the
               PRIMARY protocol; the OTHER protocol is consulted ONLY when
               every server of the primary is unreachable (no pref -> RADIUS
               first). A hard "denied" from the primary is FINAL — it never
               falls through to the secondary, so one login attempt can never
               become two independent guesses against two directories.
    """
    mode = cfg.get("mode", "ldap")
    if mode == "both":
        order = ["radius", "ldap"]
        if pref in order:
            order.remove(pref)
            order.insert(0, pref)
    else:
        order = [mode]
    for proto in order:
        if proto == "radius":
            ok, groups = _extauth_radius_verify(cfg, username, password)
        else:
            ok, groups = _extauth_ldap_verify(cfg, username, password)
        if ok is True:
            log("extauth: verify user=%s source=%s result=accept" % (username, proto))
            return {"ok": True, "groups": groups, "source": proto}
        if ok is False:
            log("extauth: verify user=%s source=%s result=denied" % (username, proto))
            return {"ok": False, "reason": "denied"}
        log("extauth: verify user=%s source=%s result=unreachable" % (username, proto))
    return {"ok": False, "reason": "unreachable"}


def verb_extauth_settings_read(args):
    """Redacted external-auth config for the admin dashboard."""
    return 0, [json.dumps(_extauth_redacted(_extauth_load_config()))], ""


def verb_extauth_settings_write(args):
    """Merge-write data/extauth/config.json (0600 root). Secrets are
    write-only: radius.secret / ldap.bind_pw overwrite only when non-empty
    (same posture as ai_settings_write's api_key)."""
    cfg = _extauth_load_config()
    if "enabled" in args:
        cfg["enabled"] = bool(v_bool(args, "enabled"))
    if "fallback_local" in args:
        cfg["fallback_local"] = bool(v_bool(args, "fallback_local"))
    if "mode" in args:
        cfg["mode"] = v_enum(args, "mode", EXTAUTH_MODES)
    if "default_role" in args:
        dr = args.get("default_role")
        if dr in (None, ""):
            cfg["default_role"] = None
        else:
            if not isinstance(dr, str) or len(dr) > 64:
                raise Reject("bad arg default_role")
            if _extauth_role_forbidden(dr):
                raise Reject("default_role may not be the built-in admin role")
            cfg["default_role"] = dr
    if "radius" in args:
        rin = args.get("radius")
        if not isinstance(rin, dict):
            raise Reject("bad arg radius")
        r = cfg["radius"]
        for hk in ("primary_host", "secondary_host"):
            if hk in rin:
                hv = rin.get(hk)
                if hv in (None, ""):
                    r[hk] = ""
                elif isinstance(hv, str) and RE_EXTAUTH_HOST.match(hv):
                    r[hk] = hv
                else:
                    raise Reject("bad arg radius.%s" % hk)
        for pk in ("primary_port", "secondary_port"):
            if pk in rin:
                pv = v_int(rin, pk)
                if pv < 1 or pv > 65535:
                    raise Reject("radius.%s out of range" % pk)
                r[pk] = pv
        if "timeout" in rin:
            tv = v_int(rin, "timeout")
            if tv < 1 or tv > 10:
                raise Reject("radius.timeout out of range (1..10)")
            r["timeout"] = tv
        if "nas_identifier" in rin:
            nv = rin.get("nas_identifier")
            if not isinstance(nv, str) or not RE_EXTAUTH_NASID.match(nv):
                raise Reject("bad arg radius.nas_identifier")
            r["nas_identifier"] = nv
        if rin.get("secret"):
            sv = rin.get("secret")
            if not isinstance(sv, str) or len(sv) > 128:
                raise Reject("bad arg radius.secret")
            r["secret"] = sv
        if rin.get("clear_secret"):
            r["secret"] = ""
    if "ldap" in args:
        lin = args.get("ldap")
        if not isinstance(lin, dict):
            raise Reject("bad arg ldap")
        l = cfg["ldap"]
        if "uri" in lin:
            uv = lin.get("uri")
            if uv in (None, ""):
                l["uri"] = ""
            elif isinstance(uv, str) and RE_EXTAUTH_URI.match(uv):
                l["uri"] = uv.rstrip("/")
            else:
                raise Reject("bad arg ldap.uri (ldap://host[:port] or ldaps://host[:port])")
        for bk in ("starttls", "verify"):
            if bk in lin:
                l[bk] = bool(v_bool(lin, bk))
        for dk in ("bind_dn", "base_dn"):
            if dk in lin:
                dv = lin.get(dk)
                if not isinstance(dv, str) or len(dv) > 512 or "\x00" in dv:
                    raise Reject("bad arg ldap.%s" % dk)
                l[dk] = dv
        if "user_attr" in lin:
            l["user_attr"] = v_enum(lin, "user_attr", EXTAUTH_USER_ATTRS)
        if "group_attr" in lin:
            l["group_attr"] = v_enum(lin, "group_attr", EXTAUTH_GROUP_ATTRS)
        if "timeout" in lin:
            tv = v_int(lin, "timeout")
            if tv < 1 or tv > 30:
                raise Reject("ldap.timeout out of range (1..30)")
            l["timeout"] = tv
        if lin.get("bind_pw"):
            pv = lin.get("bind_pw")
            if not isinstance(pv, str) or len(pv) > 128:
                raise Reject("bad arg ldap.bind_pw")
            l["bind_pw"] = pv
        if lin.get("clear_bind_pw"):
            l["bind_pw"] = ""
    if "group_map" in args:
        gin = args.get("group_map")
        if not isinstance(gin, list) or len(gin) > 64:
            raise Reject("bad arg group_map (list, max 64)")
        gmap = []
        for ent in gin:
            if not isinstance(ent, dict):
                raise Reject("bad group_map entry")
            grp = ent.get("group")
            role = ent.get("role")
            if not isinstance(grp, str) or not grp.strip() or len(grp) > 256:
                raise Reject("bad group_map group")
            if not isinstance(role, str) or not role.strip() or len(role) > 64:
                raise Reject("bad group_map role")
            # HARD DENYLIST — no directory group may ever mint an admin.
            if _extauth_role_forbidden(role):
                raise Reject("group_map may not map to the built-in admin role")
            prio = v_int(ent, "prio") if "prio" in ent else 100
            if prio > 100000:
                raise Reject("group_map prio out of range")
            gmap.append({"group": grp.strip(), "role": role.strip(), "prio": prio})
        gmap.sort(key=lambda e: e["prio"])
        cfg["group_map"] = gmap
    _extauth_save_config(cfg)
    return 0, [json.dumps(_extauth_redacted(cfg))], ""


def verb_extauth_verify(args):
    """Verify one username/password against the configured directory.
    Returns exactly one JSON line:
      {"ok":true,"groups":[...],"source":"radius|ldap"}
      {"ok":false,"reason":"denied"}        — authoritative reject
      {"ok":false,"reason":"unreachable"}   — no directory answered
    The password is never logged anywhere (dispatch redacts it; this section
    logs username + source + result only)."""
    username = v_re(args, "username", RE_EXTAUTH_USER)
    password = args.get("password")
    if not isinstance(password, str) or len(password) > 128:
        raise Reject("bad arg password")
    # SECURITY: an empty/whitespace password is an immediate deny BEFORE any
    # network exchange — never let it reach an LDAP simple bind (RFC 4513
    # unauthenticated bind) or a RADIUS request.
    if password.strip() == "":
        log("extauth: verify user=%s result=denied (empty password)" % username)
        return 0, [json.dumps({"ok": False, "reason": "denied"})], ""
    # optional: the user's own directory flag (users.ext_auth) — selects the
    # primary protocol when mode is "both" (see _extauth_verify_core).
    pref = v_enum(args, "proto", {"radius", "ldap"}) if args.get("proto") else None
    cfg = _extauth_load_config()
    if not cfg.get("enabled"):
        return 0, [json.dumps({"ok": False, "reason": "denied"})], ""
    return 0, [json.dumps(_extauth_verify_core(cfg, username, password, pref))], ""


def verb_extauth_test(args):
    """Admin 'Test connection' button: verify against ONE protocol and return
    diagnostic detail (never any secret)."""
    proto = v_enum(args, "proto", {"radius", "ldap"})
    username = v_re(args, "username", RE_EXTAUTH_USER)
    password = args.get("password")
    if not isinstance(password, str) or len(password) > 128:
        raise Reject("bad arg password")
    if password.strip() == "":
        return 0, [json.dumps({"ok": False, "reason": "denied",
                               "detail": "empty password is always rejected"})], ""
    cfg = _extauth_load_config()
    if proto == "radius":
        ok, groups = _extauth_radius_verify(cfg, username, password)
    else:
        ok, groups = _extauth_ldap_verify(cfg, username, password)
    if ok is True:
        res = {"ok": True, "groups": groups, "source": proto,
               "detail": "authenticated; %d group value(s) returned" % len(groups)}
    elif ok is False:
        res = {"ok": False, "reason": "denied",
               "detail": "the directory rejected the credentials"}
    else:
        res = {"ok": False, "reason": "unreachable",
               "detail": "no authentic reply from the %s server(s) — check "
                         "host/port/secret and the broker journal" % proto}
    log("extauth: test proto=%s user=%s result=%s" %
        (proto, username, "accept" if ok is True else res["reason"]))
    return 0, [json.dumps(res)], ""


VERBS = {
    "ping": verb_ping,
    "qemu_cpu_scope": verb_qemu_cpu_scope,
    "qemu_cpu_policy": verb_qemu_cpu_policy,
    "qemu_cpu_policy_status": verb_qemu_cpu_policy_status,
    "pki": verb_pki,
    "mcp_service": verb_mcp_service,
    "mcp_health": verb_mcp_health,
    "ai_settings_read": verb_ai_settings_read,
    "ai_settings_write": verb_ai_settings_write,
    "extauth_settings_read": verb_extauth_settings_read,
    "extauth_settings_write": verb_extauth_settings_write,
    "extauth_verify": verb_extauth_verify,
    "extauth_test": verb_extauth_test,
    "ai_lab_build": verb_ai_lab_build,
    "ai_progress_read": verb_ai_progress_read,
    "ai_usage_read": verb_ai_usage_read,
    "mcp_token_new": verb_mcp_token_new,
    "mcp_token_del": verb_mcp_token_del,
    "wrapper": verb_wrapper,
    "worker_import": verb_worker_import,
    "worker_ishare2": verb_worker_ishare2,
    "worker_sdwan": verb_worker_sdwan,
    "worker_kill": verb_worker_kill,
    "nodestats": verb_nodestats,
    "system_uuid": verb_system_uuid,
    "winbox_rdp_attach": verb_winbox_rdp_attach,
    "winbox_span_attach": verb_winbox_span_attach,
    "capture_links_del": verb_capture_links_del,
    "capture_rdp_attach": verb_capture_rdp_attach,
    "capture_mirror_attach": verb_capture_mirror_attach,
    "capture_teardown": verb_capture_teardown,
    "capture_if_del": verb_capture_if_del,
    "wireshark_container_remove": verb_wireshark_container_remove,
    "session_cleanup": verb_session_cleanup,
    "linkwatch_start": verb_linkwatch_start,
    "linkwatch_reload": verb_linkwatch_reload,
    "linkwatch_stop": verb_linkwatch_stop,
    "linkwatch_status": verb_linkwatch_status,
    "linkwatch_probe": verb_linkwatch_probe,
    "linkwatch_snapshot": verb_linkwatch_snapshot,
    "linkstats": verb_linkstats,
    "prototrace_start": verb_prototrace_start,
    "prototrace_stop": verb_prototrace_stop,
    "prototrace_status": verb_prototrace_status,
    "prototrace_snapshot": verb_prototrace_snapshot,
    "node_show": verb_node_show,
    "node_validate": verb_node_validate,
    "node_config_push": verb_node_config_push,
    "node_show_many": verb_node_show_many,
    "node_kill_workspace": verb_node_kill_workspace,
    "config_reset": verb_config_reset,
    "node_unlock": verb_node_unlock,
    "service_restart": verb_service_restart,
    "system_power": verb_system_power,
    "numa_balancing": verb_numa_balancing,
    "cpu_affinity": verb_cpu_affinity,
    "iol_keygen": verb_iol_keygen,
    "time_sync": verb_time_sync,
    "apt_proxy_set": verb_apt_proxy_set,
    "server_netcfg": verb_server_netcfg,
    "device_factory_run": verb_device_factory_run,
    "device_factory_kill": verb_device_factory_kill,
    "device_factory_rm": verb_device_factory_rm,
    "qemu_img": verb_qemu_img,
    "fs_op": verb_fs_op,
    "iol_bin_op": verb_iol_bin_op,
    "folder_delete": verb_folder_delete,
    "cluster_psk_new": verb_cluster_psk_new,
    "cluster_join": verb_cluster_join,
    "cluster_remove": verb_cluster_remove,
    "cluster_info": verb_cluster_info,
    "cluster_call": verb_cluster_call,
    "cluster_sync_lab": verb_cluster_sync_lab,
    "cluster_sync_configscripts": verb_cluster_sync_configscripts,
    "cluster_sync_templdefaults": verb_cluster_sync_templdefaults,
    "cluster_sync_manifest": verb_cluster_sync_manifest,
    "cluster_sync_image": verb_cluster_sync_image,
    "cluster_sync_satellite": verb_cluster_sync_satellite,
    "cluster_deploy": verb_cluster_deploy,
    "disk_expand": verb_disk_expand,
    "vxlan_attach": verb_vxlan_attach,
    "vxlan_detach": verb_vxlan_detach,
    "netem_set": verb_netem_set,
    "netem_del": verb_netem_del,
    "iface_vlan": verb_iface_vlan,
    "iface_linkstate": verb_iface_linkstate,
    "qemu_setlink": verb_qemu_setlink,
    "iol_keepalive": verb_iol_keepalive,
    "net_create": verb_net_create,
    "net_delete": verb_net_delete,
    "tap_delete": verb_tap_delete,
    "router_create": verb_router_create,
    "router_apply": verb_router_apply,
    "router_get": verb_router_get,
    "router_delete": verb_router_delete,
    "wifi_cell_apply": verb_wifi_cell_apply,
    "wifi_cell_get": verb_wifi_cell_get,
    "wifi_cell_delete": verb_wifi_cell_delete,
    "wifi_ap_refresh": verb_wifi_ap_refresh,
    "vwifi_server_ensure": verb_vwifi_server_ensure,
    "vwifi_ctrl": verb_vwifi_ctrl,
    "wifi_truth": verb_wifi_truth,
    "wifi_capture": verb_wifi_capture,
    "roce_agent_health": verb_roce_agent_health,
    "roce_workload": verb_roce_workload,
    "airhandler_ensure": verb_airhandler_ensure,
    "node_kill_orphan_qemu": verb_node_kill_orphan_qemu,
    "rxe_kill_orphan_qemu": verb_rxe_kill_orphan_qemu,
    "docker_inspect": verb_docker_inspect,
    "docker_create": verb_docker_create,
    "docker_start": verb_docker_start,
    "docker_stop": verb_docker_stop,
    "docker_rm": verb_docker_rm,
    "docker_exec": verb_docker_exec,
    "docker_cp": verb_docker_cp,
    "docker_image_pull": verb_docker_image_pull,
    "docker_image_rmi": verb_docker_image_rmi,
    "docker_image_ancestor": verb_docker_image_ancestor,
    "docker_image_ls": verb_docker_image_ls,
    "docker_ps_count": verb_docker_ps_count,
    "docker_stats": verb_docker_stats,
    "docker_version": verb_docker_version,
    "capture_create": verb_capture_create,
    "capture_wifi_create": verb_capture_wifi_create,
    "winbox_create": verb_winbox_create,
    "capture_rm": verb_capture_rm,
}


# ---- server ----------------------------------------------------------------

WWW_DATA_UID = pwd.getpwnam("www-data").pw_uid


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        creds = self.connection.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("iii"))
        _, uid, _ = struct.unpack("iii", creds)
        if uid not in (0, WWW_DATA_UID):
            log("DENY uid=%d (not root/www-data)" % uid)
            return
        # Keys whose values must never appear in logs (API keys, device configs,
        # etc.). "radius"/"ldap" are whole sub-objects (extauth_settings_write
        # nests radius.secret / ldap.bind_pw inside them — the redaction is
        # top-level-key based, so the entire object is masked).
        _LOG_REDACT = frozenset({
            "api_key", "config", "prompt", "psk", "password",
            "secret", "bridge_secret", "base_url",
            "bind_pw", "radius", "ldap",
        })
        raw = b""
        verb = None
        args = {}
        try:
            raw = self.rfile.readline(MAX_REQUEST)
            req = json.loads(raw)
            verb = req.get("verb")
            args = req.get("args") or {}
            if not isinstance(args, dict) or verb not in VERBS:
                raise Reject("unknown verb")
            result = VERBS[verb](args)
            if len(result) == 4:
                rc, out, err, warnings = result
            else:
                rc, out, err = result
                warnings = []
            resp = {"ok": rc == 0, "rc": rc, "out": out, "err": err}
            if warnings:
                resp["warnings"] = warnings
        except Reject as e:
            # Log verb+redacted-args when parsing succeeded; fall back to safe stub.
            if verb is not None:
                safe = {k: ("***" if k in _LOG_REDACT else v) for k, v in args.items()}
                log("REJECT uid=%d verb=%s args=%s: %s" % (
                    uid, verb, json.dumps(safe, sort_keys=True)[:300], e))
            else:
                log("REJECT uid=%d (parse error): %s" % (uid, e))
            resp = {"ok": False, "rc": 254, "out": [], "err": str(e)}
        except Exception as e:
            if verb is not None:
                safe = {k: ("***" if k in _LOG_REDACT else v) for k, v in args.items()}
                log("ERROR uid=%d verb=%s args=%s: %r" % (
                    uid, verb, json.dumps(safe, sort_keys=True)[:300], e))
            else:
                log("ERROR uid=%d (parse error): %r" % (uid, e))
            resp = {"ok": False, "rc": 255, "out": [], "err": "broker error"}
        else:
            safe = {k: ("***" if k in _LOG_REDACT else v) for k, v in args.items()}
            log("uid=%d verb=%s args=%s -> rc=%d warnings=%d" %
                (uid, verb, json.dumps(safe, sort_keys=True)[:300], rc,
                 len(warnings)))
        try:
            self.wfile.write((json.dumps(resp) + "\n").encode())
        except BrokenPipeError:
            pass


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    os.makedirs(os.path.dirname(SOCK_PATH), exist_ok=True)
    try:
        os.unlink(SOCK_PATH)
    except OSError:
        pass
    srv = Server(SOCK_PATH, Handler)
    os.chmod(SOCK_PATH, 0o660)
    shutil.chown(SOCK_PATH, "root", SOCK_GROUP)
    log("pnetlab-brokerd listening on %s (%d verbs)" %
        (SOCK_PATH, len(VERBS)))
    srv.serve_forever()


if __name__ == "__main__":
    main()
