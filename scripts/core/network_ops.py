# -*- coding: utf-8 -*-
"""PNetLab Network Operations Module (Clean Architecture Domain Module).

Extracted from pnetlab-brokerd.py to provide modular domain logic for:
- Server management network config (/etc/network/interfaces & resolved)
- Lab bridges (vnet bridges, vlan filtering, ageing, group_fwd_mask)
- Netem impairments (loss, latency, jitter, corrupt, duplicate)
- Interface link state & VLAN configuration
- QEMU setlink & IOL keepalive
- Soft-router (netns NAT & routing gateways)
- Multi-host VXLAN stitch (attach/detach)
"""

import os
import re
import sys
import json
import time
import shutil
import socket
import struct
import ipaddress
import subprocess
from typing import Any, Dict, List, Tuple

BASE = '/opt/unetlab'
RUN_DIR = '/run/pnetlab'

def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)

class Reject(Exception):
    pass

def link_exists(name):
    return os.path.exists('/sys/class/net/%s' % name)

def v_int(args, key):
    v = args.get(key)
    if not isinstance(v, int):
        raise Reject('bad arg %s' % key)
    return v

def v_str(args, key):
    v = args.get(key)
    if not isinstance(v, str) or not v:
        raise Reject('bad arg %s' % key)
    return v

def v_enum(args, key, allowed):
    v = args.get(key)
    if v not in allowed:
        raise Reject('bad arg %s' % key)
    return v

def v_ip(args, key):
    v = args.get(key)
    if not isinstance(v, str):
        raise Reject('bad arg %s' % key)
    try:
        ipaddress.IPv4Address(v)
    except Exception:
        raise Reject('bad arg %s' % key)
    return v

def v_list(args, key, minlen=0):
    v = args.get(key)
    if not isinstance(v, list) or len(v) < minlen:
        raise Reject('bad arg %s' % key)
    return v

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


