# -*- coding: utf-8 -*-
"""Node Lifecycle Native Operations Module (TASK-0027 / Việc 5).

Replaces legacy unl_wrapper binary for node operations:
- start: execute node startup sequence via CLI engine
- stop: execute node termination sequence
- wipe: remove temporary workspace files
- export: dump device startup/running configs
- delete: purge lab temporary directory
"""

from __future__ import annotations

import glob
import logging
import os
import shutil
import subprocess
from typing import Any, Tuple

logger = logging.getLogger("pnetlab.node_ops")

BASE_DIR = "/opt/unetlab"
TMP_DIR = os.path.join(BASE_DIR, "tmp")
LABS_DIR = os.path.join(BASE_DIR, "labs")
PHP_CLI = "/usr/bin/php"
ENGINE_RUNNER = os.path.join(BASE_DIR, "scripts/core/engine_runner.php")


def op_node_wipe(tenant: int, session: int, lab_id: str, node_id: int | None = None) -> Tuple[int, list[str], str]:
    """Wipe node or lab temporary state without calling unl_wrapper."""
    try:
        # Stop docker container if node is docker
        if node_id is not None:
            node_dir = os.path.join(TMP_DIR, str(tenant), lab_id, str(node_id))
            if os.path.exists(node_dir):
                shutil.rmtree(node_dir, ignore_errors=True)
            return 0, [f"Node {node_id} wiped"], ""
        else:
            lab_dir = os.path.join(TMP_DIR, str(tenant), lab_id)
            if os.path.exists(lab_dir):
                shutil.rmtree(lab_dir, ignore_errors=True)
            return 0, ["Lab wiped"], ""
    except Exception as exc:
        return 13, [], f"Wipe failed: {exc}"


def op_node_delete(lab_id: str, node_id: int | None = None) -> Tuple[int, list[str], str]:
    """Delete lab temporary data across all tenants."""
    try:
        pattern = os.path.join(TMP_DIR, "*", lab_id)
        if node_id is not None:
            pattern = os.path.join(pattern, str(node_id))
        for p in glob.glob(pattern):
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
        return 0, ["Deleted successfully"], ""
    except Exception as exc:
        return 13, [], f"Delete failed: {exc}"


def op_node_lifecycle(action: str, tenant: int, session: int, lab_path: str, node_id: int | None = None) -> Tuple[int, list[str], str]:
    """Execute node start/stop/export directly via pure PHP engine runner with Event Hooks Bus support."""
    from core.plugin_manager import bus

    event_data = {
        "action": action,
        "tenant": tenant,
        "session": session,
        "lab": lab_path,
        "node_id": node_id,
    }

    # Emit pre-hook (e.g. node.pre_start, node.pre_stop)
    bus.emit(f"node.pre_{action}", event_data)

    if action == "wipe":
        lab_id = os.path.splitext(os.path.basename(lab_path))[0]
        rc, out, err = op_node_wipe(tenant, session, lab_id, node_id)
        bus.emit("node.post_wipe", event_data, rc=rc)
        return rc, out, err
    elif action == "delete":
        lab_id = os.path.splitext(os.path.basename(lab_path))[0]
        rc, out, err = op_node_delete(lab_id, node_id)
        bus.emit("node.post_delete", event_data, rc=rc)
        return rc, out, err

    # For start, stop, export: run CLI engine worker directly
    cmd = [
        PHP_CLI,
        ENGINE_RUNNER,
        "-a", action,
        "-T", str(tenant),
        "-S", str(session),
        "-F", lab_path,
    ]
    if node_id is not None:
        cmd += ["-D", str(node_id)]

    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=600, check=False)
    out_lines = [line for line in res.stdout.splitlines() if line]
    err_str = res.stderr.strip()

    # Emit post-hook (e.g. node.post_start, node.post_stop)
    bus.emit(f"node.post_{action}", event_data, rc=res.returncode)

    return res.returncode, out_lines, err_str
