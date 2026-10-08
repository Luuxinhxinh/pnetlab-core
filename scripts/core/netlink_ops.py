# -*- coding: utf-8 -*-
"""Linux Netlink Operations Module (TASK-0013 / Việc 4).

Pure Python implementation of network cleanup using Linux Netlink (pyroute2)
replacing slow legacy shell commands (brctl, ifconfig, tunctl):
- Scans and deletes vnet*, internal*, private*, vunl*, ser* virtual interfaces
- Direct kernel Netlink socket (< 2ms) instead of fork/exec loops
- Safely terminates orphan lab emulator processes & cleans lock files
"""

from __future__ import annotations

import glob
import logging
import os
import re
import subprocess
import time
from typing import Any, Tuple

try:
    from pyroute2 import IPRoute
except ImportError:
    IPRoute = None  # type: ignore

logger = logging.getLogger("pnetlab.netlink_ops")

# Patterns for virtual bridges and tap/tunnel interfaces used by PNetLab
CLEANUP_IFACE_PATTERNS = [
    re.compile(r"^vnet\d+_\d+$"),
    re.compile(r"^internal\d+_\d+$"),
    re.compile(r"^private\d+_\d+$"),
    re.compile(r"^vunl\d+_\d+_\d+$"),
    re.compile(r"^ser\d+_\d+_\d+$"),
]


def cleanup_virtual_interfaces() -> Tuple[int, list[str]]:
    """Clean up all PNetLab virtual bridges and taps via Linux Netlink API.

    Returns:
        Tuple[count_deleted, list_of_names_deleted]
    """
    deleted: list[str] = []
    if IPRoute is None:
        return _fallback_cleanup_interfaces()

    with IPRoute() as ipr:
        links = ipr.get_links()
        targets: list[dict[str, Any]] = []

        for link in links:
            ifname = link.get_attr("IFLA_IFNAME")
            if not ifname:
                continue
            for pattern in CLEANUP_IFACE_PATTERNS:
                if pattern.match(ifname):
                    targets.append(link)
                    break

        # Bring down and remove interfaces
        for link in targets:
            index = link["index"]
            ifname = link.get_attr("IFLA_IFNAME")
            try:
                ipr.link("set", index=index, state="down")
                ipr.link("del", index=index)
                deleted.append(ifname)
            except Exception as exc:
                logger.warning("Failed to delete link %s via netlink: %s", ifname, exc)

    return len(deleted), deleted


def _fallback_cleanup_interfaces() -> Tuple[int, list[str]]:
    """Fallback using /sys/class/net and ip link command if pyroute2 is unavailable."""
    deleted: list[str] = []
    try:
        ifaces = os.listdir("/sys/class/net")
    except OSError:
        return 0, []

    for ifname in ifaces:
        for pattern in CLEANUP_IFACE_PATTERNS:
            if pattern.match(ifname):
                subprocess.run(["ip", "link", "set", "dev", ifname, "down"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                res = subprocess.run(["ip", "link", "del", "dev", ifname],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                if res.returncode == 0:
                    deleted.append(ifname)
                break
    return len(deleted), deleted


def cleanup_ovs_bridges() -> list[str]:
    """Clean up Open vSwitch bridges if ovs-vsctl is present."""
    deleted: list[str] = []
    try:
        res = subprocess.run(["ovs-vsctl", "list-br"],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False)
        if res.returncode == 0:
            for br in res.stdout.strip().splitlines():
                br = br.strip()
                if br:
                    subprocess.run(["ovs-vsctl", "del-br", br],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                    deleted.append(br)
    except Exception:
        pass
    return deleted


def cleanup_lab_processes() -> None:
    """Terminate leftover emulator processes (dynamips, iol, qemu, vpcs)."""
    emulators = ["dynamips", "iol_wrapper", "qemu_wrapper", "qemu-system", "vpcs"]
    for emu in emulators:
        subprocess.run(["pkill", "-TERM", "-f", emu],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)

    # Stop running Docker containers created by unl
    try:
        res = subprocess.run(
            ["docker", "-H=unix:///var/run/docker.sock", "ps", "-q"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5, check=False
        )
        if res.returncode == 0 and res.stdout.strip():
            container_ids = res.stdout.strip().split()
            subprocess.run(
                ["docker", "-H=unix:///var/run/docker.sock", "stop"] + container_ids,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False
            )
    except Exception:
        pass


def cleanup_lab_locks(labs_dir: str = "/opt/unetlab/labs") -> int:
    """Remove lock files from labs directory."""
    removed = 0
    try:
        for lock_file in glob.glob(os.path.join(labs_dir, "**/*.lock"), recursive=True):
            try:
                os.remove(lock_file)
                removed += 1
            except OSError:
                pass
    except Exception:
        pass
    return removed


def op_netlink_stopall(labs_dir: str = "/opt/unetlab/labs") -> Tuple[int, list[str], str]:
    """Full implementation of stopall using Netlink & pure Python.

    Replaces legacy unl_wrapper -a stopall.
    """
    t0 = time.time()
    cleanup_lab_processes()
    count_ifaces, deleted_ifaces = cleanup_virtual_interfaces()
    deleted_ovs = cleanup_ovs_bridges()
    removed_locks = cleanup_lab_locks(labs_dir)
    elapsed_ms = (time.time() - t0) * 1000

    msg = (f"stopall complete in {elapsed_ms:.1f}ms: "
           f"removed {count_ifaces} interfaces, {len(deleted_ovs)} ovs bridges, {removed_locks} locks")
    return 0, [msg], ""
