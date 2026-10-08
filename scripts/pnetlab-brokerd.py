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

try:
    from core import system_ops, netlink_ops, node_ops, plugin_manager, extauth_ops, docker_ops, telemetry_ops, cluster_ops, wireless_ops, network_ops
except ImportError:
    import sys
    sys.path.insert(0, "/opt/unetlab/scripts")
    from core import system_ops, netlink_ops, node_ops, plugin_manager, extauth_ops, docker_ops, telemetry_ops, cluster_ops, wireless_ops, network_ops

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


def verb_fixpermissions(args):
    return system_ops.op_fixpermissions()


def verb_platform(args):
    return system_ops.op_platform()


def verb_ksm_toggle(args):
    raw = args.get("enabled")
    if raw not in (0, 1, False, True, "0", "1"):
        raise Reject("bad arg enabled")
    enabled = raw in (1, True, "1")
    return system_ops.op_ksm(enabled)


def verb_netlink_cleanup(args):
    return netlink_ops.op_netlink_stopall(LABS_DIR)


def verb_plugin_list(args):
    """List loaded plugins and active hooks."""
    plugins_info = {
        name: data["metadata"] for name, data in plugin_manager.plugin_manager.loaded_plugins.items()
    }
    return 0, [json.dumps({"plugins": plugins_info, "hooks": plugin_manager.bus.list_hooks()})], ""


def verb_plugin_reload(args):
    """Rescan and reload all plugins."""
    count, loaded = plugin_manager.plugin_manager.discover_and_load(verbs_dict=VERBS)
    return 0, [f"Reloaded {count} plugins: {loaded}"], ""


def verb_wrapper(args):
    action = args.get("action")

    # Native Python Netlink & System rebroker (TASK-009 & TASK-0013)
    if action == "stopall":
        return netlink_ops.op_netlink_stopall(LABS_DIR)
    elif action == "platform":
        return system_ops.op_platform()
    elif action == "fixpermissions":
        return system_ops.op_fixpermissions()
    elif action == "ksmon":
        return system_ops.op_ksm(True)
    elif action == "ksmoff":
        return system_ops.op_ksm(False)
    elif action == "uksmon":
        return system_ops.op_uksm(True)
    elif action == "uksmoff":
        return system_ops.op_uksm(False)
    elif action == "cpulimiton":
        return verb_qemu_cpu_policy({"enabled": 1})
    elif action == "cpulimitoff":
        return verb_qemu_cpu_policy({"enabled": 0})
    elif action == "ipv6":
        val = v_enum(args, "i", {0, 1, "0", "1"})
        enabled = val in (1, "1")
        return system_ops.op_ipv6(enabled)

    elif action in WRAPPER_LAB_ACTIONS:
        tenant = v_int(args, "tenant")
        session = v_int(args, "session")
        node_id = v_int(args, "node") if args.get("node") is not None else None
        lab = v_path_under(args, "lab", LABS_DIR)
        if not lab.endswith(".unl"):
            raise Reject("lab must be a .unl file")
        return node_ops.op_node_lifecycle(action, tenant, session, lab, node_id)
    else:
        raise Reject("bad action")


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


VERBS = {
    "ping": verb_ping,
    "qemu_cpu_scope": verb_qemu_cpu_scope,
    "qemu_cpu_policy": verb_qemu_cpu_policy,
    "qemu_cpu_policy_status": verb_qemu_cpu_policy_status,
    "pki": verb_pki,
    "extauth_settings_read": extauth_ops.verb_extauth_settings_read,
    "extauth_settings_write": extauth_ops.verb_extauth_settings_write,
    "extauth_verify": extauth_ops.verb_extauth_verify,
    "extauth_test": extauth_ops.verb_extauth_test,
    "fixpermissions": verb_fixpermissions,
    "platform": verb_platform,
    "ksm_toggle": verb_ksm_toggle,
    "netlink_cleanup": verb_netlink_cleanup,
    "plugin_list": verb_plugin_list,
    "plugin_reload": verb_plugin_reload,
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
    "linkwatch_start": telemetry_ops.verb_linkwatch_start,
    "linkwatch_reload": telemetry_ops.verb_linkwatch_reload,
    "linkwatch_stop": telemetry_ops.verb_linkwatch_stop,
    "linkwatch_status": telemetry_ops.verb_linkwatch_status,
    "linkwatch_probe": telemetry_ops.verb_linkwatch_probe,
    "linkwatch_snapshot": telemetry_ops.verb_linkwatch_snapshot,
    "linkstats": telemetry_ops.verb_linkstats,
    "prototrace_start": telemetry_ops.verb_prototrace_start,
    "prototrace_stop": telemetry_ops.verb_prototrace_stop,
    "prototrace_status": telemetry_ops.verb_prototrace_status,
    "prototrace_snapshot": telemetry_ops.verb_prototrace_snapshot,
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
    "server_netcfg": network_ops.verb_server_netcfg,
    "device_factory_run": verb_device_factory_run,
    "device_factory_kill": verb_device_factory_kill,
    "device_factory_rm": verb_device_factory_rm,
    "qemu_img": verb_qemu_img,
    "fs_op": verb_fs_op,
    "iol_bin_op": verb_iol_bin_op,
    "folder_delete": verb_folder_delete,
    "cluster_psk_new": cluster_ops.verb_cluster_psk_new,
    "cluster_join": cluster_ops.verb_cluster_join,
    "cluster_remove": cluster_ops.verb_cluster_remove,
    "cluster_info": cluster_ops.verb_cluster_info,
    "cluster_call": cluster_ops.verb_cluster_call,
    "cluster_sync_lab": cluster_ops.verb_cluster_sync_lab,
    "cluster_sync_configscripts": cluster_ops.verb_cluster_sync_configscripts,
    "cluster_sync_templdefaults": cluster_ops.verb_cluster_sync_templdefaults,
    "cluster_sync_manifest": cluster_ops.verb_cluster_sync_manifest,
    "cluster_sync_image": cluster_ops.verb_cluster_sync_image,
    "cluster_sync_satellite": cluster_ops.verb_cluster_sync_satellite,
    "cluster_deploy": cluster_ops.verb_cluster_deploy,
    "disk_expand": verb_disk_expand,
    "vxlan_attach": network_ops.verb_vxlan_attach,
    "vxlan_detach": network_ops.verb_vxlan_detach,
    "netem_set": network_ops.verb_netem_set,
    "netem_del": network_ops.verb_netem_del,
    "iface_vlan": network_ops.verb_iface_vlan,
    "iface_linkstate": network_ops.verb_iface_linkstate,
    "qemu_setlink": network_ops.verb_qemu_setlink,
    "iol_keepalive": network_ops.verb_iol_keepalive,
    "net_create": network_ops.verb_net_create,
    "net_delete": network_ops.verb_net_delete,
    "tap_delete": network_ops.verb_tap_delete,
    "router_create": network_ops.verb_router_create,
    "router_apply": network_ops.verb_router_apply,
    "router_get": network_ops.verb_router_get,
    "router_delete": network_ops.verb_router_delete,
    "wifi_cell_apply": wireless_ops.verb_wifi_cell_apply,
    "wifi_cell_get": wireless_ops.verb_wifi_cell_get,
    "wifi_cell_delete": wireless_ops.verb_wifi_cell_delete,
    "wifi_ap_refresh": wireless_ops.verb_wifi_ap_refresh,
    "vwifi_server_ensure": wireless_ops.verb_vwifi_server_ensure,
    "vwifi_ctrl": wireless_ops.verb_vwifi_ctrl,
    "wifi_truth": wireless_ops.verb_wifi_truth,
    "wifi_capture": wireless_ops.verb_wifi_capture,
    "roce_agent_health": wireless_ops.verb_roce_agent_health,
    "roce_workload": wireless_ops.verb_roce_workload,
    "airhandler_ensure": wireless_ops.verb_airhandler_ensure,
    "node_kill_orphan_qemu": wireless_ops.verb_node_kill_orphan_qemu,
    "rxe_kill_orphan_qemu": wireless_ops.verb_rxe_kill_orphan_qemu,
    "docker_inspect": docker_ops.verb_docker_inspect,
    "docker_create": docker_ops.verb_docker_create,
    "docker_start": docker_ops.verb_docker_start,
    "docker_stop": docker_ops.verb_docker_stop,
    "docker_rm": docker_ops.verb_docker_rm,
    "docker_exec": docker_ops.verb_docker_exec,
    "docker_cp": docker_ops.verb_docker_cp,
    "docker_image_pull": docker_ops.verb_docker_image_pull,
    "docker_image_rmi": docker_ops.verb_docker_image_rmi,
    "docker_image_ancestor": docker_ops.verb_docker_image_ancestor,
    "docker_image_ls": docker_ops.verb_docker_image_ls,
    "docker_ps_count": docker_ops.verb_docker_ps_count,
    "docker_stats": docker_ops.verb_docker_stats,
    "docker_version": docker_ops.verb_docker_version,
    "capture_create": docker_ops.verb_capture_create,
    "capture_wifi_create": docker_ops.verb_capture_wifi_create,
    "winbox_create": docker_ops.verb_winbox_create,
    "capture_rm": docker_ops.verb_capture_rm,
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
    # Load plugins and register dynamic verbs directly into VERBS in RAM
    try:
        p_count, p_loaded = plugin_manager.plugin_manager.discover_and_load(verbs_dict=VERBS)
        log("PluginManager loaded %d plugins: %s" % (p_count, p_loaded))
    except Exception as exc:
        log("PluginManager startup warning: %s" % exc)

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
