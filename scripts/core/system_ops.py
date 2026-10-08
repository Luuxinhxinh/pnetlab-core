# -*- coding: utf-8 -*-
"""System Operations Module (TASK-009).

Pure Python implementation of system verbs originally invoked via unl_wrapper C binary:
- platform: hardware identification (DMI / cpuinfo)
- fixpermissions: directory/file permissions according to PNetLab specs
- ksm: Kernel Samepage Merging run control
- uksm: Ultra KSM run control
- ipv6: system IPv6 enable/disable
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
from typing import Any, Tuple


def op_platform() -> Tuple[int, list[str], str]:
    """Detect CPU virtualization capabilities and system product name.

    Equivalent to:
    (egrep vmx /proc/cpuinfo | grep -q ept && echo vmx) + dmidecode system-product-name
    """
    out_lines: list[str] = []
    prefix = ""

    # Check vmx with ept in /proc/cpuinfo
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore") as f:
            cpuinfo = f.read()
            if "vmx" in cpuinfo and "ept" in cpuinfo:
                prefix = "vmx"
    except Exception:
        pass

    # Read system product name from sysfs or fallback to dmidecode
    product_name = ""
    sysfs_dmi = "/sys/class/dmi/id/product_name"
    if os.path.exists(sysfs_dmi):
        try:
            with open(sysfs_dmi, "r", encoding="utf-8", errors="ignore") as f:
                product_name = f.read().strip()
        except Exception:
            product_name = ""

    if not product_name:
        try:
            res = subprocess.run(
                ["/usr/sbin/dmidecode", "-s", "system-product-name"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=5,
                check=False,
            )
            if res.returncode == 0:
                product_name = res.stdout.strip()
        except Exception:
            product_name = "KVM/Standard PC"

    full_output = f"{prefix}{product_name}"
    out_lines.append(full_output)
    return 0, out_lines, ""


def op_ksm(enable: bool) -> Tuple[int, list[str], str]:
    """Toggle Linux Kernel Samepage Merging (KSM)."""
    val = "1\n" if enable else "0\n"
    ksm_run = "/sys/kernel/mm/ksm/run"
    ksm_flag = "/opt/unetlab/ksm"

    try:
        if os.path.exists(ksm_run):
            with open(ksm_run, "w", encoding="utf-8") as f:
                f.write(val)
        with open(ksm_flag, "w", encoding="utf-8") as f:
            f.write(val)
        return 0, [f"KSM {'enabled' if enable else 'disabled'}"], ""
    except Exception as exc:
        return 13, [], f"Failed to toggle KSM: {exc}"


def op_uksm(enable: bool) -> Tuple[int, list[str], str]:
    """Toggle Ultra KSM (UKSM)."""
    val = "1\n" if enable else "0\n"
    uksm_run = "/sys/kernel/mm/uksm/run"
    uksm_flag = "/opt/unetlab/uksm"

    try:
        if os.path.exists(uksm_run):
            with open(uksm_run, "w", encoding="utf-8") as f:
                f.write(val)
        with open(uksm_flag, "w", encoding="utf-8") as f:
            f.write(val)
        return 0, [f"UKSM {'enabled' if enable else 'disabled'}"], ""
    except Exception as exc:
        return 13, [], f"Failed to toggle UKSM: {exc}"


def op_ipv6(enable: bool) -> Tuple[int, list[str], str]:
    """Toggle system IPv6 precedence and disable flags."""
    disable_val = "0" if enable else "1"
    try:
        subprocess.run(
            ["sysctl", "-w", f"net.ipv6.conf.all.disable_ipv6={disable_val}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
            check=False,
        )
        # Update gai.conf if it exists
        gai_conf = "/etc/gai.conf"
        if os.path.exists(gai_conf):
            with open(gai_conf, "r", encoding="utf-8") as f:
                content = f.read()
            if enable:
                new_content = re.sub(
                    r"^precedence\s+::ffff:0:0/96\s+100",
                    "#precedence ::ffff:0:0/96  100",
                    content,
                    flags=re.MULTILINE,
                )
            else:
                new_content = re.sub(
                    r"^#\s*precedence\s+::ffff:0:0/96\s+100",
                    "precedence ::ffff:0:0/96  100",
                    content,
                    flags=re.MULTILINE,
                )
            if new_content != content:
                with open(gai_conf, "w", encoding="utf-8") as f:
                    f.write(new_content)
        return 0, [f"IPv6 {'enabled' if enable else 'disabled'}"], ""
    except Exception as exc:
        return 1, [], f"Failed to toggle IPv6: {exc}"


def _chmod_files(pattern: str, mode: int) -> None:
    for path in glob.glob(pattern):
        try:
            os.chmod(path, mode)
        except OSError:
            pass


def _safe_chown_tree(path: str, user: str, group: str) -> None:
    if os.path.exists(path):
        subprocess.run(
            ["chown", "-R", f"{user}:{group}", path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
            check=False,
        )


def _safe_chmod_tree(path: str, mode_str: str) -> None:
    if os.path.exists(path):
        subprocess.run(
            ["chmod", "-R", mode_str, path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
            check=False,
        )


def op_fixpermissions() -> Tuple[int, list[str], str]:
    """Execute filesystem permission standardization according to PNetLab unl_wrapper specs."""
    try:
        # 1. Scripts executable
        _safe_chmod_tree("/opt/unetlab/scripts", "755")

        # 2. Labs & data owned by www-data
        _safe_chown_tree("/opt/unetlab/data", "www-data", "www-data")
        _safe_chown_tree("/opt/unetlab/labs", "www-data", "www-data")

        # 3. External auth secrets protected root:root 0600
        extauth_dir = "/opt/unetlab/data/extauth"
        if os.path.exists(extauth_dir):
            _safe_chown_tree(extauth_dir, "root", "root")
            try:
                os.chmod(extauth_dir, 0o700)
                cfg = os.path.join(extauth_dir, "config.json")
                if os.path.exists(cfg):
                    os.chmod(cfg, 0o600)
            except OSError:
                pass

        # 4. /opt/unetlab/tmp
        tmp_dir = "/opt/unetlab/tmp"
        if os.path.exists(tmp_dir):
            _safe_chown_tree(tmp_dir, "root", "unl")
            _safe_chmod_tree(tmp_dir, "777")

        # 5. /tmp
        try:
            shutil.chown("/tmp", user="root", group="root")
            os.chmod("/tmp", 0o1777)
        except OSError:
            pass

        # 6. /opt/unetlab/users
        users_dir = "/opt/unetlab/users"
        if os.path.exists(users_dir):
            _safe_chown_tree(users_dir, "root", "unl")
            _safe_chmod_tree(users_dir, "2775")

        # 7. /opt/unetlab/addons
        addons_dir = "/opt/unetlab/addons"
        if os.path.exists(addons_dir):
            _safe_chmod_tree(addons_dir, "755")

        # 8. Wrappers
        _chmod_files("/opt/unetlab/wrappers/nsenter", 0o755)
        _chmod_files("/opt/unetlab/wrappers/*_wrapper*", 0o755)
        _chmod_files("/opt/unetlab/wrappers/bash-static", 0o755)
        _chmod_files("/opt/unetlab/wrappers/busybox", 0o755)
        _chmod_files("/opt/unetlab/wrappers/profile.sh", 0o755)

        # 9. html directory
        html_dir = "/opt/unetlab/html"
        if os.path.exists(html_dir):
            _safe_chown_tree(html_dir, "www-data", "www-data")
            _safe_chmod_tree(html_dir, "755")
            store_dir = os.path.join(html_dir, "store")
            if os.path.exists(store_dir):
                _safe_chmod_tree(store_dir, "777")

        return 0, ["Permissions fixed successfully"], ""
    except Exception as exc:
        return 1, [], f"fixpermissions failed: {exc}"
