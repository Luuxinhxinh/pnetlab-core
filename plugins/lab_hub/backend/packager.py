# -*- coding: utf-8 -*-
"""PNetLab Lab Packager Engine (TASK-0043 / .pnetlabz Bundle).

Deep Module architecture:
Small interface:
  - pack(lab_path, output_dir, meta) -> (.pnetlabz file path, sha256)
  - unpack(package_path, target_folder) -> manifest dict

Hides complexity of tar.gz packing, SHA-256 integrity hashing, and path traversal security.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tarfile
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger("pnetlab.lab_packager")

LABS_ROOT = "/opt/unetlab/labs"


def compute_sha256(file_path: str) -> str:
    """Compute SHA-256 hash of a file."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


class LabPackager:
    """Packages and unpackages standalone .pnetlabz lab archives."""

    @staticmethod
    def pack(
        lab_rel_path: str,
        output_dir: str = "/opt/unetlab/tmp",
        meta: Optional[Dict[str, Any]] = None,
    ) -> Tuple[bool, str, str]:
        """Pack a lab (.unl + startup configs + manifest) into a .pnetlabz archive.

        Returns:
            Tuple[ok, archive_path_or_err, sha256_hash]
        """
        lab_rel_path = lab_rel_path.strip("/")
        if not lab_rel_path.endswith(".unl"):
            lab_rel_path += ".unl"

        source_unl = os.path.join(LABS_ROOT, lab_rel_path)
        if not os.path.isfile(source_unl):
            return False, f"Lab file not found: {source_unl}", ""

        lab_base_name = os.path.splitext(os.path.basename(lab_rel_path))[0]
        os.makedirs(output_dir, exist_ok=True)
        archive_path = os.path.join(output_dir, f"{lab_base_name}.pnetlabz")

        # Configs folder associated with this lab if exists
        # In PNetLab, startup-configs are often located in subfolders or database
        manifest_data = {
            "format": "pnetlabz",
            "version": "1.0.0",
            "lab_name": lab_base_name,
            "rel_path": lab_rel_path,
            "metadata": meta or {},
            "unl_sha256": compute_sha256(source_unl),
        }

        try:
            with tarfile.open(archive_path, "w:gz") as tar:
                # Add topology.unl
                tar.add(source_unl, arcname="topology.unl")

                # Add manifest.json
                manifest_bytes = json.dumps(manifest_data, indent=2).encode("utf-8")
                manifest_info = tarfile.TarInfo(name="manifest.json")
                manifest_info.size = len(manifest_bytes)
                import io
                tar.addfile(manifest_info, io.BytesIO(manifest_bytes))

            sha256 = compute_sha256(archive_path)
            return True, archive_path, sha256
        except Exception as exc:
            logger.error("Failed to pack lab %s: %s", lab_rel_path, exc)
            return False, str(exc), ""

    @staticmethod
    def unpack(
        archive_path: str,
        dest_folder: str = "Imported",
    ) -> Tuple[bool, Dict[str, Any], str]:
        """Unpack a .pnetlabz archive safely into /opt/unetlab/labs/<dest_folder>/.

        Returns:
            Tuple[ok, manifest_dict, target_unl_path]
        """
        if not os.path.isfile(archive_path):
            return False, {}, "Archive file not found"

        dest_dir = os.path.join(LABS_ROOT, dest_folder.strip("/"))
        os.makedirs(dest_dir, exist_ok=True)

        try:
            with tarfile.open(archive_path, "r:gz") as tar:
                # Security: prevent path traversal attacks
                for member in tar.getmembers():
                    if member.name.startswith("/") or ".." in member.name:
                        return False, {}, f"Security alert: Malicious tar path detected: {member.name}"

                manifest_file = tar.extractfile("manifest.json")
                if not manifest_file:
                    return False, {}, "Invalid .pnetlabz package: missing manifest.json"

                manifest_data = json.load(manifest_file)
                lab_name = manifest_data.get("lab_name", "imported_lab")
                target_unl = os.path.join(dest_dir, f"{lab_name}.unl")

                # Extract topology.unl
                unl_file = tar.extractfile("topology.unl")
                if not unl_file:
                    return False, {}, "Invalid .pnetlabz package: missing topology.unl"

                with open(target_unl, "wb") as f_out:
                    shutil.copyfileobj(unl_file, f_out)

                # Set proper permissions for webserver
                try:
                    os.chmod(target_unl, 0o777)
                except OSError:
                    pass

                return True, manifest_data, target_unl
        except Exception as exc:
            logger.error("Failed to unpack archive %s: %s", archive_path, exc)
            return False, {}, str(exc)
