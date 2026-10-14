# -*- coding: utf-8 -*-
"""Tenant Resource Guard Engine (TASK-0052 / Cgroups v2 Resource Limiting).

Implements Deep Module architecture:
Small interface:
  - apply_tenant_limits(tenant_id, memory_max, cpu_quota, pids_max)
  - attach_process_to_tenant(tenant_id, pid)
  - remove_tenant_limits(tenant_id)

Hides complex Linux Cgroups v2 cgroup.subtree_control and cgroup.procs interactions.
Protects physical server from DoS / OOM crashes when 50+ students run concurrent labs.
"""

from __future__ import annotations

import logging
import os
import shutil
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger("pnetlab.tenant_guard")

CGROUP_ROOT = "/sys/fs/cgroup"
PNET_SLICE = os.path.join(CGROUP_ROOT, "pnetlab-tenants")


class TenantGuard:
    """Manages Linux Cgroups v2 resource quotas for multi-tenant isolation."""

    def __init__(self, base_path: str = PNET_SLICE) -> None:
        self.base_path = base_path
        self._is_cgroup_v2 = self._check_cgroup_v2()
        if self._is_cgroup_v2:
            self._ensure_base_slice()

    def _check_cgroup_v2(self) -> bool:
        """Check if Linux Kernel has unified Cgroups v2 hierarchy mounted."""
        controllers_file = os.path.join(CGROUP_ROOT, "cgroup.controllers")
        return os.path.isfile(controllers_file)

    def _ensure_base_slice(self) -> None:
        """Ensure /sys/fs/cgroup/pnetlab-tenants exists and subtree controllers are enabled."""
        try:
            os.makedirs(self.base_path, exist_ok=True)
            # Enable controllers for child tenant cgroups
            subtree_file = os.path.join(self.base_path, "cgroup.subtree_control")
            if os.path.isfile(subtree_file):
                with open(subtree_file, "w", encoding="utf-8") as f:
                    f.write("+cpu +memory +pids +io\n")
        except (OSError, PermissionError) as exc:
            logger.warning("Failed to enable cgroup subtree_control on %s: %s", self.base_path, exc)

    def get_tenant_cgroup_path(self, tenant_id: str | int) -> str:
        """Get absolute cgroup filesystem directory for tenant."""
        return os.path.join(self.base_path, f"tenant_{tenant_id}")

    def apply_tenant_limits(
        self,
        tenant_id: str | int,
        memory_max: str = "4G",
        cpu_quota: str = "200000 100000",  # 2 vCPUs (200ms per 100ms period)
        pids_max: int = 512,
    ) -> Tuple[bool, str]:
        """Apply resource ceiling (RAM, CPU, Max PIDs) to a student tenant."""
        if not self._is_cgroup_v2:
            return False, "Linux Cgroups v2 not available on host system"

        tenant_dir = self.get_tenant_cgroup_path(tenant_id)
        try:
            os.makedirs(tenant_dir, exist_ok=True)

            # 1. Limit Memory (OOM Killer triggers inside cgroup, protecting host)
            mem_file = os.path.join(tenant_dir, "memory.max")
            with open(mem_file, "w", encoding="utf-8") as f:
                f.write(f"{memory_max}\n")

            # 2. Limit CPU Quota (e.g., 200% = 2 Cores max)
            cpu_file = os.path.join(tenant_dir, "cpu.max")
            with open(cpu_file, "w", encoding="utf-8") as f:
                f.write(f"{cpu_quota}\n")

            # 3. Limit Process/Thread count (Anti Fork-Bomb)
            pids_file = os.path.join(tenant_dir, "pids.max")
            with open(pids_file, "w", encoding="utf-8") as f:
                f.write(f"{pids_max}\n")

            logger.info("Applied Cgroups v2 limits for tenant %s: RAM=%s, CPU=%s, PIDs=%s",
                        tenant_id, memory_max, cpu_quota, pids_max)
            return True, f"Cgroups v2 limits applied for tenant {tenant_id}"
        except (OSError, PermissionError) as exc:
            logger.error("Error applying cgroup limits for tenant %s: %s", tenant_id, exc)
            return False, str(exc)

    def attach_process(self, tenant_id: str | int, pid: int) -> Tuple[bool, str]:
        """Attach a spawned process (QEMU, IOL, or Docker exec) into tenant cgroup."""
        if not self._is_cgroup_v2:
            return False, "Cgroups v2 not active"

        tenant_dir = self.get_tenant_cgroup_path(tenant_id)
        procs_file = os.path.join(tenant_dir, "cgroup.procs")

        if not os.path.isfile(procs_file):
            # Create cgroup with default limits if not exists
            self.apply_tenant_limits(tenant_id)

        try:
            with open(procs_file, "w", encoding="utf-8") as f:
                f.write(f"{pid}\n")
            logger.debug("Attached PID %d to tenant cgroup %s", pid, tenant_id)
            return True, f"PID {pid} attached to tenant {tenant_id}"
        except (OSError, ProcessLookupError, PermissionError) as exc:
            logger.warning("Could not attach PID %d to tenant %s: %s", pid, tenant_id, exc)
            return False, str(exc)

    def get_tenant_stats(self, tenant_id: str | int) -> Dict[str, Any]:
        """Read current live consumption (current RAM, current PIDs) of tenant."""
        tenant_dir = self.get_tenant_cgroup_path(tenant_id)
        if not os.path.isdir(tenant_dir):
            return {"exists": False}

        stats: Dict[str, Any] = {"exists": True}

        # Memory usage
        mem_current = os.path.join(tenant_dir, "memory.current")
        if os.path.isfile(mem_current):
            try:
                with open(mem_current, "r", encoding="utf-8") as f:
                    stats["memory_bytes"] = int(f.read().strip())
            except Exception:
                stats["memory_bytes"] = 0

        # Current PIDs count
        pids_current = os.path.join(tenant_dir, "pids.current")
        if os.path.isfile(pids_current):
            try:
                with open(pids_current, "r", encoding="utf-8") as f:
                    stats["pids_count"] = int(f.read().strip())
            except Exception:
                stats["pids_count"] = 0

        return stats

    def remove_tenant_cgroup(self, tenant_id: str | int) -> bool:
        """Remove tenant cgroup directory when student finishes lab."""
        tenant_dir = self.get_tenant_cgroup_path(tenant_id)
        if os.path.isdir(tenant_dir):
            try:
                os.rmdir(tenant_dir)
                return True
            except OSError:
                return False
        return True


# Global default instance
tenant_guard = TenantGuard()
