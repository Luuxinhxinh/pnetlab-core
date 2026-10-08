# -*- coding: utf-8 -*-
"""Plugin SPI & Event Hooks Bus Engine (TASK-0033 / Việc 5.5).

Implements Open/Closed Principle (OCP) and Deep Module architecture:
- EventHooksBus: Publish-subscribe event bus for system hooks:
    * node.pre_start / node.post_start
    * node.pre_stop / node.post_stop
    * node.pre_wipe / node.post_wipe
    * lab.open / lab.close
- PluginManager: Discovers, validates, and loads dynamic plugins from /opt/unetlab/plugins/<plugin_id>/
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import sys
from typing import Any, Callable, Dict, List, Tuple

logger = logging.getLogger("pnetlab.plugin_manager")

PLUGINS_DIR = "/opt/unetlab/plugins"

HookCallback = Callable[..., Any]


class EventHooksBus:
    """Publish-subscribe event bus for extensible system lifecycle events."""

    def __init__(self) -> None:
        self._hooks: Dict[str, List[HookCallback]] = {}

    def register(self, event_name: str, callback: HookCallback) -> None:
        """Register a hook callback for a specific event."""
        if event_name not in self._hooks:
            self._hooks[event_name] = []
        if callback not in self._hooks[event_name]:
            self._hooks[event_name].append(callback)
            logger.debug("Registered hook for %s: %s", event_name, callback.__name__)

    def unregister(self, event_name: str, callback: HookCallback) -> None:
        """Unregister a hook callback."""
        if event_name in self._hooks and callback in self._hooks[event_name]:
            self._hooks[event_name].remove(callback)

    def emit(self, event_name: str, *args: Any, **kwargs: Any) -> List[Any]:
        """Emit an event, calling all registered callbacks in order.

        Returns:
            List of return values from the callbacks.
        """
        results: List[Any] = []
        if event_name not in self._hooks:
            return results

        for cb in self._hooks[event_name]:
            try:
                res = cb(*args, **kwargs)
                results.append(res)
            except Exception as exc:
                logger.error("Error executing hook for event '%s' in %s: %s", event_name, cb.__name__, exc)
        return results

    def list_hooks(self) -> Dict[str, int]:
        """Return the count of registered hooks per event."""
        return {event: len(callbacks) for event, callbacks in self._hooks.items()}


class PluginManager:
    """Discovers and manages external plugins under /opt/unetlab/plugins/."""

    def __init__(self, plugins_dir: str = PLUGINS_DIR, event_bus: EventHooksBus | None = None) -> None:
        self.plugins_dir = plugins_dir
        self.event_bus = event_bus or EventHooksBus()
        self.loaded_plugins: Dict[str, Dict[str, Any]] = {}

    def discover_and_load(self, verbs_dict: Dict[str, Any] | None = None) -> Tuple[int, List[str]]:
        """Scan plugins directory and load valid plugins with zero-overhead VERBS registration."""
        if not os.path.exists(self.plugins_dir):
            os.makedirs(self.plugins_dir, exist_ok=True)
            return 0, []

        loaded_names: List[str] = []
        for entry in os.listdir(self.plugins_dir):
            plugin_path = os.path.join(self.plugins_dir, entry)
            if not os.path.isdir(plugin_path) or entry.startswith("."):
                continue

            manifest_path = os.path.join(plugin_path, "manifest.json")
            entrypoint_path = os.path.join(plugin_path, "plugin.py")

            if not os.path.exists(entrypoint_path):
                continue

            metadata = {"name": entry, "version": "1.0.0", "description": ""}
            if os.path.exists(manifest_path):
                try:
                    with open(manifest_path, "r", encoding="utf-8") as f:
                        manifest_data = json.load(f)
                        if isinstance(manifest_data, dict):
                            metadata.update(manifest_data)
                except Exception as exc:
                    logger.warning("Invalid manifest in %s: %s", entry, exc)

            try:
                module_name = f"pnetlab_plugin_{entry}"
                spec = importlib.util.spec_from_file_location(module_name, entrypoint_path)
                if spec is not None and spec.loader is not None:
                    module = importlib.util.module_from_spec(spec)
                    sys.modules[module_name] = module
                    spec.loader.exec_module(module)

                    # Initialize plugin with event bus and optional VERBS dict
                    if hasattr(module, "register"):
                        try:
                            module.register(self.event_bus, verbs_dict=verbs_dict)
                        except TypeError:
                            module.register(self.event_bus)
                    elif hasattr(module, "setup"):
                        try:
                            module.setup(self.event_bus, verbs_dict=verbs_dict)
                        except TypeError:
                            module.setup(self.event_bus)

                    self.loaded_plugins[entry] = {
                        "metadata": metadata,
                        "module": module,
                        "path": plugin_path,
                    }
                    loaded_names.append(entry)
                    logger.info("Successfully loaded plugin: %s", entry)
            except Exception as exc:
                logger.error("Failed to load plugin %s: %s", entry, exc)

        return len(loaded_names), loaded_names


# Global singleton instance for runtime
bus = EventHooksBus()
plugin_manager = PluginManager(PLUGINS_DIR, bus)
