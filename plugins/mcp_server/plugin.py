# -*- coding: utf-8 -*-
"""MCP Server & AI Lab Builder Plugin Module (TASK-0033 / Việc 5.6).

Zero-Overhead Memory Registration:
Registers AI verbs directly into VERBS dictionary in RAM.
Zero performance penalty, O(1) dictionary dispatching on broker socket.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import os
import re
import secrets
import socket
import subprocess
import time
from typing import Any, Dict, List, Tuple

logger = logging.getLogger("pnetlab.plugins.mcp_server")

BASE_DIR = "/opt/unetlab"
AI_DIR = os.path.join(BASE_DIR, "data/ai")
AI_CONFIG = os.path.join(AI_DIR, "config.json")
AI_BRIDGE_SECRET = os.path.join(AI_DIR, "bridge.secret")
AI_USAGE = os.path.join(AI_DIR, "usage.json")
AI_PROGRESS_DIR = os.path.join(AI_DIR, "progress")
AI_AGENT = os.path.join(BASE_DIR, "scripts/mcp/ai_lab_agent.py")

MCP_UNIT = "pnetlab-mcp.service"
MCP_UNIT_SRC = os.path.join(BASE_DIR, "scripts/mcp/pnetlab-mcp.service")
MCP_UNIT_DST = "/etc/systemd/system/pnetlab-mcp.service"
MCP_SERVICE_OPS = {"start", "stop", "restart", "enable", "disable", "status"}
RE_TOKEN_NAME = re.compile(r"^[A-Za-z0-9 _.-]{1,48}$")
AI_PROVIDERS = {"anthropic", "openai", "azure", "local"}
AI_BUILD_MODES = {"plan", "apply"}


def _run_cmd(cmd: List[str], timeout: int = 30) -> Tuple[int, List[str], str]:
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout, check=False)
        out = [line for line in res.stdout.splitlines() if line]
        return res.returncode, out, res.stderr.strip()
    except Exception as exc:
        return 1, [], str(exc)


def _ai_load_config() -> Dict[str, Any]:
    os.makedirs(AI_DIR, exist_ok=True)
    if os.path.exists(AI_CONFIG):
        try:
            with open(AI_CONFIG, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    # Default initial configuration
    secret = secrets.token_hex(32)
    default_cfg = {
        "mcp": {
            "enabled": True,
            "bind": "0.0.0.0",
            "port": 8090,
            "tokens": [],
        },
        "provider": {
            "provider": "anthropic",
            "base_url": "",
            "model": "claude-3-5-sonnet-20241022",
            "api_key": "",
        },
        "limits": {
            "ai_allowed_roles": ["admin"],
            "per_user_daily_tokens": 1000000,
        },
    }
    _ai_save_config(default_cfg)
    return default_cfg


def _ai_save_config(cfg: Dict[str, Any]) -> None:
    os.makedirs(AI_DIR, exist_ok=True)
    tmp = AI_CONFIG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, AI_CONFIG)

    # Sync bridge secret if present
    if not os.path.exists(AI_BRIDGE_SECRET):
        secret = secrets.token_hex(32)
        with open(AI_BRIDGE_SECRET, "w", encoding="utf-8") as f:
            f.write(secret)
        os.chmod(AI_BRIDGE_SECRET, 0o640)


def _ai_redacted(cfg: Dict[str, Any]) -> Dict[str, Any]:
    red = json.loads(json.dumps(cfg))
    if "provider" in red and "api_key" in red["provider"]:
        key = red["provider"]["api_key"]
        red["provider"]["api_key"] = ("***" + key[-4:]) if len(key) >= 8 else ("***" if key else "")
    return red


def _mcp_ensure_unit() -> bool:
    if not os.path.exists(MCP_UNIT_SRC):
        return False
    try:
        with open(MCP_UNIT_SRC, "r", encoding="utf-8") as sf:
            content = sf.read()
        tmp = MCP_UNIT_DST + ".tmp"
        with open(tmp, "w", encoding="utf-8") as df:
            df.write(content)
        os.chmod(tmp, 0o644)
        os.replace(tmp, MCP_UNIT_DST)
        _run_cmd(["systemctl", "daemon-reload"])
        return True
    except Exception:
        return False


def verb_mcp_service(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    op = str(args.get("op", "status"))
    if op not in MCP_SERVICE_OPS:
        return 254, [], "Invalid op"
    if op in ("enable", "start", "restart"):
        _mcp_ensure_unit()
    if op == "status":
        _, out_a, _ = _run_cmd(["systemctl", "is-active", MCP_UNIT], timeout=15)
        _, out_e, _ = _run_cmd(["systemctl", "is-enabled", MCP_UNIT], timeout=15)
        cfg = _ai_load_config().get("mcp", {})
        st = {
            "active": bool(out_a and out_a[0].strip() == "active"),
            "active_state": (out_a[0].strip() if out_a else "unknown"),
            "enabled": (out_e[0].strip() if out_e else "unknown"),
            "bind": cfg.get("bind", "0.0.0.0"),
            "port": int(cfg.get("port", 8090)),
            "configured": bool(cfg.get("tokens")),
        }
        return 0, [json.dumps(st)], ""
    return _run_cmd(["systemctl", op, MCP_UNIT], timeout=60)


def verb_mcp_health(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    cfg = _ai_load_config().get("mcp", {})
    bind = cfg.get("bind", "0.0.0.0")
    port = int(cfg.get("port", 8090))
    probe_host = "127.0.0.1" if bind in ("0.0.0.0", "::") else bind
    _, out_a, _ = _run_cmd(["systemctl", "is-active", MCP_UNIT], timeout=15)
    active = bool(out_a and out_a[0].strip() == "active")
    listening = False
    try:
        with socket.create_connection((probe_host, port), timeout=3):
            listening = True
    except OSError:
        listening = False
    return 0, [json.dumps({"active": active, "listening": listening, "bind": bind, "port": port})], ""


def verb_ai_settings_read(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    return 0, [json.dumps(_ai_redacted(_ai_load_config()))], ""


def verb_ai_settings_write(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    cfg = _ai_load_config()
    m = cfg.setdefault("mcp", {})
    if "bind" in args and args["bind"] in ("127.0.0.1", "0.0.0.0"):
        m["bind"] = args["bind"]
    if "port" in args:
        port = int(args["port"])
        if 1024 <= port <= 65535:
            m["port"] = port
    if "enabled" in args:
        m["enabled"] = bool(args["enabled"])

    p = cfg.setdefault("provider", {})
    if "provider" in args and args["provider"] in AI_PROVIDERS:
        p["provider"] = args["provider"]
    if "base_url" in args and isinstance(args["base_url"], str):
        p["base_url"] = args["base_url"][:512]
    if "model" in args and isinstance(args["model"], str):
        p["model"] = args["model"][:128]
    if args.get("api_key") and isinstance(args["api_key"], str):
        p["api_key"] = args["api_key"][:512]
    if args.get("clear_api_key"):
        p["api_key"] = ""

    _ai_save_config(cfg)
    return 0, [json.dumps(_ai_redacted(cfg))], ""


def verb_mcp_token_new(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    name = str(args.get("name", ""))
    if not RE_TOKEN_NAME.match(name):
        return 254, [], "Invalid token name"
    pod = int(args.get("pod", 0))
    cfg = _ai_load_config()
    toks = cfg.setdefault("mcp", {}).setdefault("tokens", [])
    if any(t.get("name") == name for t in toks):
        return 254, [], "Token name already exists"
    secret = secrets.token_urlsafe(32)
    toks.append({
        "name": name,
        "hash": hashlib.sha256(secret.encode()).hexdigest(),
        "pod": pod, "tenant": pod, "role": "admin",
        "created": int(time.time()),
    })
    _ai_save_config(cfg)
    return 0, [json.dumps({"name": name, "pod": pod, "token": secret})], ""


def verb_mcp_token_del(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    name = str(args.get("name", ""))
    cfg = _ai_load_config()
    toks = cfg.setdefault("mcp", {}).setdefault("tokens", [])
    n0 = len(toks)
    cfg["mcp"]["tokens"] = [t for t in toks if t.get("name") != name]
    if len(cfg["mcp"]["tokens"]) == n0:
        return 254, [], "No such token"
    _ai_save_config(cfg)
    return 0, [json.dumps({"deleted": name})], ""


def verb_ai_progress_read(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    pod = int(args.get("pod", 0))
    offset = int(args.get("offset", 0) or 0)
    prog_path = os.path.join(AI_PROGRESS_DIR, f"{pod}.jsonl")
    events: List[Dict[str, Any]] = []
    lines: List[str] = []
    try:
        with open(prog_path, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        pass
    total = len(lines)
    for line in lines[offset:]:
        try:
            ev = json.loads(line)
            if ev.get("type") != "_eof":
                events.append(ev)
        except ValueError:
            continue
    running = total > 0 and not any(l.lstrip().startswith('{"type":"_eof"') for l in lines)
    return 0, [json.dumps({"events": events, "offset": total, "running": running})], ""


def verb_ai_usage_read(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    led: Dict[str, Any] = {}
    try:
        with open(AI_USAGE, "r", encoding="utf-8") as fh:
            led = json.load(fh)
    except Exception:
        pass
    today = datetime.date.today().isoformat()
    by_day = {day: sum(int(v or 0) for v in pods.values()) for day, pods in led.items() if isinstance(pods, dict)}
    cap = int(_ai_load_config().get("limits", {}).get("per_user_daily_tokens", 0))
    return 0, [json.dumps({"today": today, "per_user_daily_cap": cap, "by_day": by_day, "ledger": led})], ""


def register(event_bus: Any, verbs_dict: Dict[str, Any] | None = None) -> None:
    """Plugin entry point: zero-overhead direct memory registration into VERBS dict."""
    mcp_verbs = {
        "mcp_service": verb_mcp_service,
        "mcp_health": verb_mcp_health,
        "mcp_token_new": verb_mcp_token_new,
        "mcp_token_del": verb_mcp_token_del,
        "ai_settings_read": verb_ai_settings_read,
        "ai_settings_write": verb_ai_settings_write,
        "ai_progress_read": verb_ai_progress_read,
        "ai_usage_read": verb_ai_usage_read,
    }

    if verbs_dict is not None:
        verbs_dict.update(mcp_verbs)
        logger.info("Registered %d MCP/AI verbs directly into VERBS dictionary in RAM", len(mcp_verbs))

    # Event hook for node lifecycle tracking
    def _on_node_event(event_data: Dict[str, Any], rc: int = 0) -> None:
        action = event_data.get("action")
        node_id = event_data.get("node_id")
        logger.debug("[MCP Plugin] Observed node event: %s on node %s (rc=%d)", action, node_id, rc)

    event_bus.register("node.post_start", _on_node_event)
    event_bus.register("node.post_stop", _on_node_event)
