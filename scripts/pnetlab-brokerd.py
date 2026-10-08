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
    from core import system_ops, netlink_ops, node_ops, plugin_manager, extauth_ops, docker_ops, telemetry_ops, cluster_ops, wireless_ops
except ImportError:
    import sys
    sys.path.insert(0, "/opt/unetlab/scripts")
    from core import system_ops, netlink_ops, node_ops, plugin_manager, extauth_ops, docker_ops, telemetry_ops, cluster_ops, wireless_ops

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
    "server_netcfg": verb_server_netcfg,
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
