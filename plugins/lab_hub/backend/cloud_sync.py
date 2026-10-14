# -*- coding: utf-8 -*-
"""Community Cloud Hub Sync Engine (TASK-0044).

Enables 24/7 offline-capable lab exchange via Managed Community Catalog.
Provides:
  - fetch_catalog() -> list of community labs
  - publish_to_community(lab_rel_path, meta) -> catalog entry
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from plugins.lab_hub.backend.packager import LabPackager

logger = logging.getLogger("pnetlab.cloud_sync")

DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/pnetlab-hub/community-labs/main/catalog.json"
LOCAL_CACHE_CATALOG = "/opt/unetlab/data/community_catalog.json"


class CloudSyncEngine:
    """Synchronizes labs with the community hub catalog without requiring personal GitHub tokens."""

    @staticmethod
    def fetch_catalog(cache_only: bool = False) -> List[Dict[str, Any]]:
        """Fetch available community lab catalog from Cloud or Local cache."""
        # 1. Try remote fetch if not cache_only
        if not cache_only:
            try:
                req = urllib.request.Request(
                    DEFAULT_CATALOG_URL,
                    headers={"User-Agent": "PNetLab-V8-Client"},
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    if resp.status == 200:
                        data = json.loads(resp.read().decode("utf-8"))
                        # Update local cache
                        os.makedirs(os.path.dirname(LOCAL_CACHE_CATALOG), exist_ok=True)
                        with open(LOCAL_CACHE_CATALOG, "w", encoding="utf-8") as f:
                            json.dump(data, f, indent=2)
                        return data.get("labs", [])
            except Exception as exc:
                logger.warning("Could not reach remote catalog, falling back to local: %s", exc)

        # 2. Fallback to local cache
        if os.path.isfile(LOCAL_CACHE_CATALOG):
            try:
                with open(LOCAL_CACHE_CATALOG, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return data.get("labs", [])
            except Exception:
                pass

        # 3. Default seeded catalog if completely offline
        return [
            {
                "id": "ccna-ospf-basic",
                "title": "CCNA Enterprise - OSPF Multi-Area",
                "author": "PNetLab Academy",
                "version": "1.0.0",
                "difficulty": "Intermediate",
                "tags": ["Cisco", "OSPF", "CCNA"],
                "download_url": "local",
                "description": "Lab thực hành cấu hình định tuyến động OSPF đa vùng với 4 Router Cisco.",
            },
            {
                "id": "pfsense-dmz-firewall",
                "title": "Network Security - pfSense Firewall & DMZ",
                "author": "Cyber Range Team",
                "version": "1.2.0",
                "difficulty": "Advanced",
                "tags": ["Security", "pfSense", "Firewall"],
                "download_url": "local",
                "description": "Mô phỏng hạ tầng mạng doanh nghiệp bảo vệ vùng DMZ qua pfSense.",
            }
        ]

    @staticmethod
    def export_for_sharing(
        lab_rel_path: str,
        title: str,
        author: str,
        description: str,
        tags: Optional[List[str]] = None,
    ) -> Tuple[bool, str, Dict[str, Any]]:
        """Export lab into a shareable bundle with catalog entry."""
        meta = {
            "title": title,
            "author": author,
            "description": description,
            "tags": tags or [],
        }

        ok, archive_path, sha256 = LabPackager.pack(
            lab_rel_path=lab_rel_path,
            output_dir="/opt/unetlab/tmp",
            meta=meta,
        )

        if not ok:
            return False, archive_path, {}

        entry = {
            "title": title,
            "author": author,
            "description": description,
            "tags": tags or [],
            "archive_path": archive_path,
            "file_name": os.path.basename(archive_path),
            "sha256": sha256,
        }

        # Add to local catalog index
        try:
            current_labs = CloudSyncEngine.fetch_catalog(cache_only=True)
            current_labs.append(entry)
            os.makedirs(os.path.dirname(LOCAL_CACHE_CATALOG), exist_ok=True)
            with open(LOCAL_CACHE_CATALOG, "w", encoding="utf-8") as f:
                json.dump({"labs": current_labs}, f, indent=2)
        except Exception as exc:
            logger.warning("Could not append to local catalog: %s", exc)

        return True, archive_path, entry
