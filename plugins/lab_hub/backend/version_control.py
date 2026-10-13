# -*- coding: utf-8 -*-
"""Mini-Git Local Snapshot & Rollback Engine for PNetLab Labs.

Provides local version control for student lab sessions:
  - create_snapshot(lab_path, message) -> snapshot_id
  - rollback_snapshot(lab_path, snapshot_id) -> bool
  - list_snapshots(lab_path) -> list[snapshot_info]
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import os
import shutil
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("pnetlab.lab_version_control")

LABS_ROOT = "/opt/unetlab/labs"


class LabVersionControl:
    """Manages snapshot history and rollback points for lab topologies."""

    @staticmethod
    def _get_history_dir(lab_rel_path: str) -> str:
        lab_rel_path = lab_rel_path.strip("/")
        if not lab_rel_path.endswith(".unl"):
            lab_rel_path += ".unl"
        source_unl = os.path.join(LABS_ROOT, lab_rel_path)
        base_dir = os.path.dirname(source_unl)
        lab_name = os.path.splitext(os.path.basename(lab_rel_path))[0]
        history_dir = os.path.join(base_dir, f".history_{lab_name}")
        os.makedirs(history_dir, exist_ok=True)
        return history_dir

    @classmethod
    def create_snapshot(
        cls,
        lab_rel_path: str,
        message: str = "Autosave Snapshot",
        author: str = "student",
    ) -> Tuple[bool, str, Dict[str, Any]]:
        """Create a new point-in-time snapshot commit of the lab."""
        lab_rel_path = lab_rel_path.strip("/")
        if not lab_rel_path.endswith(".unl"):
            lab_rel_path += ".unl"
        source_unl = os.path.join(LABS_ROOT, lab_rel_path)

        if not os.path.isfile(source_unl):
            return False, "Lab file not found", {}

        history_dir = cls._get_history_dir(lab_rel_path)
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

        # Read content to hash
        with open(source_unl, "rb") as f:
            content = f.read()
        commit_hash = hashlib.sha256(content).hexdigest()[:8]
        snapshot_id = f"{timestamp}_{commit_hash}"

        # Copy lab file into snapshot folder
        snapshot_file = os.path.join(history_dir, f"{snapshot_id}.unl")
        shutil.copy2(source_unl, snapshot_file)

        meta = {
            "snapshot_id": snapshot_id,
            "timestamp": datetime.datetime.now().isoformat(),
            "message": message,
            "author": author,
            "commit_hash": commit_hash,
            "file_size": len(content),
        }

        # Save metadata index
        index_file = os.path.join(history_dir, "index.json")
        history: List[Dict[str, Any]] = []
        if os.path.isfile(index_file):
            try:
                with open(index_file, "r", encoding="utf-8") as f:
                    history = json.load(f)
            except Exception:
                history = []

        history.insert(0, meta)
        with open(index_file, "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2)

        return True, snapshot_id, meta

    @classmethod
    def list_snapshots(cls, lab_rel_path: str) -> List[Dict[str, Any]]:
        """List all snapshots / commit history for a lab."""
        history_dir = cls._get_history_dir(lab_rel_path)
        index_file = os.path.join(history_dir, "index.json")
        if not os.path.isfile(index_file):
            return []
        try:
            with open(index_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

    @classmethod
    def rollback_snapshot(cls, lab_rel_path: str, snapshot_id: str) -> Tuple[bool, str]:
        """Rollback lab file to a specific snapshot commit."""
        lab_rel_path = lab_rel_path.strip("/")
        if not lab_rel_path.endswith(".unl"):
            lab_rel_path += ".unl"
        source_unl = os.path.join(LABS_ROOT, lab_rel_path)

        history_dir = cls._get_history_dir(lab_rel_path)
        target_snapshot = os.path.join(history_dir, f"{snapshot_id}.unl")

        if not os.path.isfile(target_snapshot):
            return False, f"Snapshot not found: {snapshot_id}"

        # Backup current state as safety pre-rollback
        cls.create_snapshot(lab_rel_path, message="Auto pre-rollback backup", author="system")

        # Restore
        shutil.copy2(target_snapshot, source_unl)
        try:
            os.chmod(source_unl, 0o777)
        except OSError:
            pass

        return True, f"Successfully rolled back to snapshot {snapshot_id}"
