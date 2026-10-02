#!/usr/bin/env python3
# pnetlab-mcp — PNetLab MCP server (AI Lab Builder, Phase P1: read-only tools).
#
# One tool surface, two doors:
#   - EXTERNAL clients (Claude Desktop/Code, any MCP client) dial the Streamable-
#     HTTP endpoint over the network, authenticating with an admin-generated
#     bearer access-token, and bring their OWN model.
#   - the (future, P3) in-app agent dials the same service over localhost.
#
# This file is a thin MCP *protocol* server. All lab parsing/validation happens
# in the real engine: every tool proxies to the localhost PHP bridge
# (html/mcp/bridge.php), authenticated with the shared bridge secret. The bearer
# token resolves to a PNetLab pod/tenant and every read is scoped to it.
#
# Runs as the toggleable pnetlab-mcp.service (disabled by default). Transports:
#   --http   Streamable-HTTP on the configured bind:port  [default]
#   --stdio  stdio transport for a localhost CLI/dev client (trusted, pod 0)
#
# Streaming: the HTTP transport is built json_response=True, so each request gets a
# single JSON body (NOT an incremental SSE stream). Our tools are request/response
# — build/read/lifecycle calls that return one result — so there is nothing to
# stream token-by-token; the simpler single-body path avoids SSE proxy-buffering
# pitfalls. (The Apache example's long timeout is for slow lifecycle tools, not SSE.)
#
# P1 tools (read-only): list_templates, get_lab, list_nodes, get_running_config.

import argparse
import atexit
import contextvars
import hashlib
import hmac
import json
import os
import sys
import threading
import time

CONFIG_PATH = "/opt/unetlab/data/ai/config.json"
BRIDGE_URL = "http://127.0.0.1/mcp/bridge.php"

# Per-request authenticated pod/tenant. Set by the bearer-auth ASGI middleware
# (HTTP); defaults to 0 = admin for the trusted local stdio transport.
current_pod = contextvars.ContextVar("current_pod", default=0)

# Per-request MCP session key — how we tell one client CONNECTION from another so
# concurrent clients sharing a pod don't clobber each other's "open lab" (see the
# bound-lab section below). Set by the ASGI middleware from the client's
# `mcp-session-id` request header; the stdio transport sets a fixed local sentinel.
# Empty ("") means "no per-connection identity available" (see _bindable()).
current_session = contextvars.ContextVar("current_session", default="")

# ---- bound lab: keyed on (pod, session) so same-pod clients are isolated ------
#
# THE GUARANTEE (correctness fix): the "bound lab" — the lab a client is currently
# building into, so its mutating tools can omit lab_path — is keyed on
# (pod, mcp-session-id), NOT on pod alone. Two windows/clients sharing one bearer
# token/pod therefore each get their OWN open-lab binding and can never write into
# each other's lab via an empty lab_path.
#
# Because we run stateless_http=True, the server never MINTS an mcp-session-id (the
# SDK sets mcp_session_id=None per request), so the only per-connection identity we
# get over HTTP is an mcp-session-id the *client* chose to send. When it is absent
# the empty-lab_path convenience is UNSAFE (it would collapse back to a pod-shared
# global), so we DISABLE it for that request: mutating tools then require an
# explicit lab_path (open_lab still returns the lab_path for the model to pass on).
# The trusted-local stdio transport is a single session and is always bindable.
_bound_lab = {}          # (pod, session_key) -> lab_path
_bound_lock = threading.Lock()
_BOUND_CAP = 512         # cap the map so a churn of session ids can't grow it forever


def _bindable():
    """True when this request has a trustworthy per-connection identity, so the
    open-lab convenience (empty lab_path -> bound lab) is safe: the local stdio
    session, or an HTTP request that carries a stable mcp-session-id. A bare
    HTTP request with no session id is NOT bindable (would share a pod-global)."""
    return current_session.get() != ""


def _sess_key():
    return (current_pod.get(), current_session.get())


def _set_bound(lab_path):
    """Record the client's open lab. Returns True if it was actually bound
    (bindable request), False if the caller must keep passing lab_path explicitly."""
    if not lab_path or not _bindable():
        return False
    key = _sess_key()
    with _bound_lock:
        _bound_lab.pop(key, None)      # re-insert to mark most-recently-used
        _bound_lab[key] = lab_path
        while len(_bound_lab) > _BOUND_CAP:
            _bound_lab.pop(next(iter(_bound_lab)))   # evict oldest inserted
    return True


def _get_bound():
    if not _bindable():
        return ""
    with _bound_lock:
        return _bound_lab.get(_sess_key(), "")


# ---- config: cached, mtime+size invalidated, never raises -------------------
_cfg_cache = {"sig": None, "data": {}}   # sig = (st_mtime_ns, st_size)
_cfg_lock = threading.Lock()


def load_config():
    """Parsed /opt/unetlab/data/ai/config.json, cached and only re-read when the
    file's mtime/size changes (the broker rewrites it on token/settings edits, which
    bumps mtime). Fails safe: returns {} (or the last-good copy) if unreadable, so
    every caller's .get(...) chain still works."""
    try:
        st = os.stat(CONFIG_PATH)
        sig = (st.st_mtime_ns, st.st_size)
    except OSError:
        return _cfg_cache["data"]
    if _cfg_cache["sig"] == sig:            # fast path: unchanged, no lock needed
        return _cfg_cache["data"]
    with _cfg_lock:
        if _cfg_cache["sig"] == sig:
            return _cfg_cache["data"]
        try:
            with open(CONFIG_PATH, "r") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return _cfg_cache["data"]
        if not isinstance(data, dict):
            data = {}
        _cfg_cache["data"] = data
        _cfg_cache["sig"] = sig
        return data


def verify_bearer(auth_header):
    """Map an `Authorization: Bearer <tok>` header to a PNetLab pod, or None.
    Tokens are stored as sha256 hashes in the 0640 root:pnetlab-mcp config that
    this (unprivileged) service reads."""
    if not auth_header:
        return None
    parts = auth_header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    h = hashlib.sha256(parts[1].strip().encode()).hexdigest()
    tokens = load_config().get("mcp", {}).get("tokens", [])
    for t in tokens:
        if isinstance(t, dict) and t.get("hash") and \
                hmac.compare_digest(str(t["hash"]), h):
            return int(t.get("pod", 0))
    return None


# ---- pooled HTTP client to the loopback bridge (keep-alive) ------------------
# One reused httpx.Client instead of a fresh TCP connection + PHP teardown per
# tool call. httpx.Client is thread-safe for issuing requests, which is all the
# FastMCP stateless_http task model needs (tool bodies run in a worker thread).
_client = None
_client_lock = threading.Lock()


def _get_client():
    global _client
    c = _client
    if c is None:
        with _client_lock:
            if _client is None:
                import httpx     # lazy: keep the stdio path from importing it early
                _client = httpx.Client(
                    limits=httpx.Limits(max_keepalive_connections=8,
                                        keepalive_expiry=30.0),
                    timeout=httpx.Timeout(DEFAULT_TIMEOUT),
                    headers={"Connection": "keep-alive"},
                )
            c = _client
    return c


def _close_client():
    global _client
    with _client_lock:
        if _client is not None:
            try:
                _client.close()
            except Exception:
                pass
            _client = None


atexit.register(_close_client)


# ---- per-action timeout policy ----------------------------------------------
# The bridge's cheap file-level reads return fast; mutations a bit slower; the
# lifecycle/console tools (start/stop/wipe a node, live-scrape or console-push a
# config) can run for minutes. LONG is aligned with the Apache reverse-proxy's
# `timeout=600` in apache-mcp-external.conf.example — keep the two in step.
SHORT_TIMEOUT = 15.0      # reads / inventory
DEFAULT_TIMEOUT = 60.0    # mutations (also the client's fallback)
LONG_TIMEOUT = 600.0      # node lifecycle + console/config scrape (== Apache proxy)
BATCH_TIMEOUT = 180.0     # a whole-topology batch build (many ops, one lock)

_ACTION_TIMEOUT = {
    # reads / inventory (SHORT)
    "list_templates": SHORT_TIMEOUT, "list_node_images": SHORT_TIMEOUT,
    "get_lab": SHORT_TIMEOUT, "open_lab": SHORT_TIMEOUT, "list_nodes": SHORT_TIMEOUT,
    "get_running_config": SHORT_TIMEOUT, "host_capacity": SHORT_TIMEOUT,
    "list_networks_types": SHORT_TIMEOUT, "list_links": SHORT_TIMEOUT,
    "list_configurable_nodes": SHORT_TIMEOUT, "get_node_interfaces": SHORT_TIMEOUT,
    "save_lab": SHORT_TIMEOUT,
    # mutations (DEFAULT/medium)
    "create_lab": DEFAULT_TIMEOUT, "set_lab_documentation": DEFAULT_TIMEOUT,
    "add_text": DEFAULT_TIMEOUT, "add_node": DEFAULT_TIMEOUT,
    "edit_node": DEFAULT_TIMEOUT, "set_node_position": DEFAULT_TIMEOUT,
    "delete_node": DEFAULT_TIMEOUT, "add_network": DEFAULT_TIMEOUT,
    "connect_nodes": DEFAULT_TIMEOUT, "connect_node_to_network": DEFAULT_TIMEOUT,
    "disconnect": DEFAULT_TIMEOUT, "set_link_impairment": DEFAULT_TIMEOUT,
    "link_up": DEFAULT_TIMEOUT, "link_down": DEFAULT_TIMEOUT,
    # long-running lifecycle / console / live-scrape (LONG)
    "apply_config_console": LONG_TIMEOUT, "start_node": LONG_TIMEOUT,
    "stop_node": LONG_TIMEOUT, "wipe_node": LONG_TIMEOUT,
    "export_running_config": LONG_TIMEOUT, "set_startup_config": LONG_TIMEOUT,
    # composite build
    "batch": BATCH_TIMEOUT,
}


# ---- TTL cache for near-static reads ----------------------------------------
# A full engine bootstrap in bridge.php backs every read, so cache the ones whose
# result is effectively static within a build session. NEVER cache reads that
# reflect user-mutable lab state (get_lab/list_nodes/list_links/get_running_config/
# get_node_interfaces/list_configurable_nodes) — a mutation would serve stale data.
_CACHE_TTL = {
    "list_templates": 60.0,        # installed templates change only on Image mgmt ops
    "list_node_images": 60.0,      # ditto (per template)
    "list_networks_types": 60.0,   # a static, hand-coded table in the bridge
    "host_capacity": 4.0,          # dynamic (free RAM), but a short TTL dedups bursts
}
_ttl_cache = {}      # key -> (expires_monotonic, value)
_ttl_lock = threading.Lock()


def _cache_key(action, pod, params):
    return (int(pod), action, repr(sorted(params.items())))


def _bridge_post(payload, timeout):
    """Do the actual keep-alive POST to the bridge and unwrap the JSON envelope."""
    client = _get_client()
    secret = load_config().get("mcp", {}).get("bridge_secret", "")
    resp = client.post(BRIDGE_URL, json=payload,
                       headers={"X-MCP-Bridge": secret}, timeout=timeout)
    if resp.status_code != 200:
        try:
            msg = resp.json().get("error", resp.text)
        except Exception:
            msg = resp.text
        raise RuntimeError("engine bridge: %s" % (msg or resp.status_code))
    data = resp.json()
    if isinstance(data, dict) and "error" in data:
        raise RuntimeError("engine bridge: %s" % data["error"])
    return data


def bridge_call(action, pod, *, _timeout=None, **params):
    """Proxy one tool call to the localhost engine bridge over the loopback,
    reusing the pooled keep-alive client. The timeout is chosen per action
    (_ACTION_TIMEOUT), overridable via _timeout. Near-static reads are served from
    a short TTL cache (_CACHE_TTL); everything else always hits the engine."""
    clean = {k: v for k, v in params.items() if v is not None and v != ""}
    ttl = _CACHE_TTL.get(action)
    ckey = None
    if ttl is not None:
        ckey = _cache_key(action, pod, clean)
        now = time.monotonic()
        with _ttl_lock:
            hit = _ttl_cache.get(ckey)
            if hit and hit[0] > now:
                return hit[1]
    payload = {"action": action, "pod": int(pod)}
    payload.update(clean)
    timeout = _timeout if _timeout is not None else _ACTION_TIMEOUT.get(action, DEFAULT_TIMEOUT)
    data = _bridge_post(payload, timeout)
    out = data.get("data", data) if isinstance(data, dict) else data
    if ckey is not None:
        with _ttl_lock:
            if len(_ttl_cache) > 256:
                _ttl_cache.clear()      # tiny table; a blunt flush is fine
            _ttl_cache[ckey] = (time.monotonic() + ttl, out)
    return out


def bridge_batch(pod, lab_path, ops, _timeout=None):
    """Run a whole ordered list of build ops in ONE bridge round-trip (one engine
    bootstrap, one lab lock). Returns the bridge's batch envelope:
        {"results": [<per-op result>, ...],   # in op order, up to the failure
         "failed_at": <int index | None>,     # index of the op that failed, or None
         "error": <str | None>}               # that op's message, or None
    See build_topology's docstring / the report for the exact op contract."""
    payload = {"action": "batch", "pod": int(pod), "lab_path": lab_path, "ops": ops}
    timeout = _timeout if _timeout is not None else BATCH_TIMEOUT
    data = _bridge_post(payload, timeout)
    return data.get("data", data) if isinstance(data, dict) else data


# ---- tools -----------------------------------------------------------------

def build_server():
    from mcp.server.fastmcp import FastMCP
    # stateless_http: every request is handled in its own task, so the bearer-auth
    # contextvars set in the ASGI middleware reliably reach the tool call.
    # json_response: return one JSON body per request (no SSE). The SDK's stateless
    # transport mints no mcp-session-id, so per-connection identity comes only from
    # a client-sent mcp-session-id header (see current_session / _bindable()).
    mcp = FastMCP("pnetlab", stateless_http=True, json_response=True)

    @mcp.tool()
    def list_templates() -> dict:
        """List the PNetLab node templates installed on this server. Each entry
        has slug, description, type, config_capable, and image_available.
        config_capable marks the config_script family (vIOS / vIOSL2 / IOL / XRd /
        NX-OSv9k / Catalyst-SDWAN / CSR) that supports day-0 config import/export;
        image_available is true only when a node of that template can actually be
        placed (an image is installed, or it is vpcs). Build with templates that
        are image_available. IOL templates also report roles (switch and/or router)
        when an L2 and/or L3 image is installed."""
        return bridge_call("list_templates", current_pod.get())

    @mcp.tool()
    def list_node_images(template: str) -> dict:
        """List the installed images for a template. Each entry is {name, default,
        and (for IOL) role}. For IOL an L2 image has role 'switch' and an L3 image
        has role 'router' — use this to pick a specific image, or just pass
        role='switch'/'router' to add_node."""
        return bridge_call("list_node_images", current_pod.get(), template=template)

    def _soft(lab_path=""):
        """Resolve the lab to read: an explicit lab_path wins, else the lab THIS
        client (pod+session) open_lab'd / create_lab'd, else "" (the bridge then
        tries the pod's interactive web session)."""
        return lab_path or _get_bound()

    @mcp.tool()
    def get_lab(lab_path: str = "") -> dict:
        """Read a lab's full topology: id, name, the description/body
        documentation, all nodes and all networks. lab_path is relative to the
        labs root (e.g. "/Folder/My Lab.unl"); leave empty to use the lab this
        client currently has open."""
        return bridge_call("get_lab", current_pod.get(), lab_path=_soft(lab_path))

    @mcp.tool()
    def list_nodes(lab_path: str = "") -> dict:
        """List the nodes in a lab (id, name, template, type, status,
        interfaces). lab_path is relative to the labs root; empty = the open
        lab."""
        return bridge_call("list_nodes", current_pod.get(), lab_path=_soft(lab_path))

    @mcp.tool()
    def get_running_config(node_id: int = 0, lab_path: str = "") -> dict:
        """Get the saved startup-configuration for the lab's nodes (all nodes,
        or a single node_id). lab_path is relative to the labs root; empty = the
        open lab. (Live device-scrape of a running node is added at the agent
        level in a later phase.)"""
        return bridge_call("get_running_config", current_pod.get(),
                           lab_path=_soft(lab_path), node_id=(node_id or None))

    # ---- write tools (P2): bind a lab, then build into it -------------------

    def _bound(lab_path=""):
        """Resolve the lab a mutating tool should target: an explicit lab_path
        wins, else the lab THIS client (pod+session) open_lab'd / create_lab'd.
        Raises a clear error when neither is set — including the case where an
        external client without a per-connection mcp-session-id must pass lab_path
        explicitly (the open-lab convenience is unsafe to share across such
        clients)."""
        lp = lab_path or _get_bound()
        if not lp:
            if not _bindable():
                raise ValueError(
                    "pass lab_path explicitly: your MCP client sent no mcp-session-id, "
                    "so the open-lab convenience is disabled to keep concurrent "
                    "same-token clients from writing into each other's lab "
                    "(open_lab/create_lab return the lab_path to pass back)")
            raise ValueError("no lab is open — call open_lab or create_lab first")
        return lp

    @mcp.tool()
    def create_lab(name: str, path: str = "") -> dict:
        """Create a new empty lab and bind this client to it. name is the lab
        title (no path/extension); path is an optional folder under the labs root
        (defaults to your own workspace). Returns the new lab_path and a `bound`
        flag: if bound is false, your client has no session id, so pass that
        lab_path explicitly to every later build tool. (Mutating.)"""
        res = bridge_call("create_lab", current_pod.get(), name=name, path=path)
        lp = res.get("lab_path", "") if isinstance(res, dict) else ""
        if lp and isinstance(res, dict):
            res["bound"] = _set_bound(lp)   # False => caller must pass lab_path back
        return res

    @mcp.tool()
    def open_lab(lab_path: str) -> dict:
        """Open an existing lab (relative to the labs root, e.g.
        "/Folder/My Lab.unl") and bind this client to it, so later build tools
        default to it. Returns the lab's current topology plus a `bound` flag: if
        bound is false, your client has no session id, so pass lab_path explicitly
        to every later build tool."""
        res = bridge_call("open_lab", current_pod.get(), lab_path=lab_path)
        bound = _set_bound(lab_path)
        if isinstance(res, dict):
            res["bound"] = bound   # False => pass lab_path on subsequent calls
        return res

    @mcp.tool()
    def save_lab(lab_path: str = "") -> dict:
        """Persist the open lab to disk. Each build tool already saves, so this is
        normally a no-op for explicit completeness. (Mutating.)"""
        return bridge_call("save_lab", current_pod.get(), lab_path=_bound(lab_path))

    @mcp.tool()
    def set_lab_documentation(objectives: str = "", tasks: list = None,
                              lab_path: str = "") -> dict:
        """Set the lab's documentation: a short objectives summary (the lab
        description) and an ordered list of task strings (the lab body).
        (Mutating.)"""
        return bridge_call("set_lab_documentation", current_pod.get(),
                           lab_path=_bound(lab_path),
                           objectives=objectives, tasks=(tasks or []))

    @mcp.tool()
    def add_text(text: str, left: int = 60, top: int = 60, font_size: int = 14,
                 color: str = "", name: str = "", lab_path: str = "") -> dict:
        """Place a TEXT ANNOTATION directly on the topology canvas (a draggable
        text box on the lab layout), e.g. a title, legend, or the lab details/notes.
        left/top position it; font_size/color style it; name labels it. This is
        DIFFERENT from set_lab_documentation, which only fills the Lab-details info
        panel — use add_text when the user wants text shown ON the canvas. Returns
        the new text object id. (Mutating.)"""
        return bridge_call("add_text", current_pod.get(), lab_path=_bound(lab_path),
                           text=text, left=left, top=top, font_size=font_size,
                           color=(color or None), name=(name or None))

    @mcp.tool()
    def add_node(template: str, name: str = "", left: int = 0, top: int = 0,
                 ram: int = 0, cpu: int = 0, ethernet: int = 0,
                 role: str = "", image: str = "", lab_path: str = "") -> dict:
        """Add a node to the open lab. template is a slug from list_templates;
        name is the node hostname (auto-uniquified); left/top place it on the
        canvas. ram/cpu/ethernet override the template defaults when > 0. For IOL,
        role='switch' picks an L2 image (Ethernet switch) and role='router' picks an
        L3 image (router); or pass an explicit image name from list_node_images.
        Returns the new node id (and the chosen image/role). (Mutating.)"""
        return bridge_call("add_node", current_pod.get(), lab_path=_bound(lab_path),
                           template=template, name=name, left=left, top=top,
                           ram=(ram or None), cpu=(cpu or None),
                           ethernet=(ethernet or None),
                           role=(role or None), image=(image or None))

    @mcp.tool()
    def edit_node(id: int, params: dict, lab_path: str = "") -> dict:
        """Edit an existing node's parameters (e.g. {"name":"R1","ram":1024}).
        params keys mirror the node edit form. (Mutating.)"""
        return bridge_call("edit_node", current_pod.get(), lab_path=_bound(lab_path),
                           id=id, params=(params or {}))

    @mcp.tool()
    def set_node_position(id: int, left: int, top: int, lab_path: str = "") -> dict:
        """Move a node to canvas coordinates (left, top). (Mutating.)"""
        return bridge_call("set_node_position", current_pod.get(),
                           lab_path=_bound(lab_path), id=id, left=left, top=top)

    @mcp.tool()
    def delete_node(id: int, confirm: bool = False, lab_path: str = "") -> dict:
        """Delete a node from the open lab. Destructive — pass confirm=true to
        proceed. (Mutating, destructive.)"""
        return bridge_call("delete_node", current_pod.get(), lab_path=_bound(lab_path),
                           id=id, confirm=bool(confirm))

    @mcp.tool()
    def add_network(type: str = "bridge", name: str = "Net",
                    left: int = 0, top: int = 0, lab_path: str = "") -> dict:
        """Add a network to the open lab. type is bridge (isolated L2), cloud
        (pnet0 management bridge), nat, or an explicit pnetN/natN/dot1q/wireless.
        Returns the new network id. (Mutating.)"""
        return bridge_call("add_network", current_pod.get(), lab_path=_bound(lab_path),
                           type=type, name=name, left=left, top=top)

    @mcp.tool()
    def connect_nodes(a_id: int, b_id: int, a_if: int = -1, b_if: int = -1,
                      lab_path: str = "") -> dict:
        """Create a DIRECT point-to-point link between two nodes (drawn as a line,
        no cloud icon). Omit a_if/b_if (or pass -1) to auto-use each node's first
        free interface; pass explicit 0-based indexes to choose a specific port.
        Do NOT use add_network just to join two devices. (Mutating.)"""
        return bridge_call("connect_nodes", current_pod.get(), lab_path=_bound(lab_path),
                           a_id=a_id, a_if=a_if, b_id=b_id, b_if=b_if)

    @mcp.tool()
    def connect_node_to_network(node_id: int, iface: int, net_id: int,
                                lab_path: str = "") -> dict:
        """Connect a node's interface (iface, 0-based) to an existing network
        (net_id from add_network / get_lab). (Mutating.)"""
        return bridge_call("connect_node_to_network", current_pod.get(),
                           lab_path=_bound(lab_path),
                           node_id=node_id, **{"if": iface}, net_id=net_id)

    @mcp.tool()
    def disconnect(node_id: int, iface: int, lab_path: str = "") -> dict:
        """Unlink a node's interface (iface, 0-based) from whatever network it is
        attached to. (Mutating.)"""
        return bridge_call("disconnect", current_pod.get(), lab_path=_bound(lab_path),
                           node_id=node_id, **{"if": iface})

    @mcp.tool()
    def set_startup_config(node_id: int, config_text: str,
                           lab_path: str = "") -> dict:
        """Set a node's day-0 startup-configuration and flag it for delivery at
        next boot. Only works on config_capable templates (see list_templates);
        refuses others. (Mutating.)"""
        return bridge_call("set_startup_config", current_pod.get(),
                           lab_path=_bound(lab_path),
                           node_id=node_id, config_text=config_text)

    @mcp.tool()
    def provide_config(node_name: str, config_text: str) -> dict:
        """Offer a node's day-0 config to the USER as a downloadable .txt to paste
        into the node's console themselves — the PREFERRED way to configure IOS-family
        nodes (vIOS, IOL, ...). It does NOT import/modify the node, so the device
        boots clean instead of waiting out autoinstall like set_startup_config does.
        The lab-view AI panel shows a Download button per node; the user starts the
        node, skips the setup dialog / autoinstall, and pastes the file. Call this for
        each config_capable node instead of set_startup_config."""
        # Local tool: the config travels in this call's args, which the side pane
        # turns into a download. No engine/lab mutation.
        return {"ok": True, "node": node_name, "bytes": len(config_text or "")}

    # ---- inventory / read tools (P6) ----------------------------------------

    @mcp.tool()
    def host_capacity() -> dict:
        """Host resources for sizing a build: cpu_count, ram_total_mb,
        ram_free_mb, plus this user's per-user caps (max_cpu, max_ram_mb; 0 =
        unlimited). The engine refuses a node start that would exceed the caps, so
        plan a lab that fits."""
        return bridge_call("host_capacity", current_pod.get())

    @mcp.tool()
    def list_networks_types() -> dict:
        """List the network types add_network accepts (bridge, cloud, nat, dot1q,
        wireless) with a one-line description of each."""
        return bridge_call("list_networks_types", current_pod.get())

    @mcp.tool()
    def list_links(lab_path: str = "") -> dict:
        """List every link in the lab, derived from node interfaces and the
        networks they attach to: each entry has the network id/name/type, whether
        it is a point-to-point link, and its endpoints. lab_path empty = open
        lab."""
        return bridge_call("list_links", current_pod.get(), lab_path=_soft(lab_path))

    @mcp.tool()
    def list_configurable_nodes(lab_path: str = "") -> dict:
        """List the lab's nodes that accept a day-0 startup-config (the
        config_capable templates) — the ones set_startup_config / export_running_
        config can target. lab_path empty = open lab."""
        return bridge_call("list_configurable_nodes", current_pod.get(),
                           lab_path=_soft(lab_path))

    @mcp.tool()
    def get_node_interfaces(id: int, lab_path: str = "") -> dict:
        """List one node's interfaces (0-based index, name, type, the network it
        is connected to, and whether it is connected) — use it to pick free
        interfaces before wiring links. lab_path empty = open lab."""
        return bridge_call("get_node_interfaces", current_pod.get(),
                           lab_path=_soft(lab_path), id=id)

    # ---- run / observe / fault-inject tools (P6) ----------------------------
    # These act on the lab you currently have OPEN in the lab view (a running
    # session); lab_path does not apply. Not available in plan mode.

    @mcp.tool()
    def start_node(id: int, confirm: bool = False) -> dict:
        """Start a node in the open lab. Consumes CPU/RAM — pass confirm=true. The
        engine refuses the start if it would exceed your per-user CPU/RAM cap (see
        host_capacity). (Mutating; running session required.)"""
        return bridge_call("start_node", current_pod.get(), id=id, confirm=bool(confirm))

    @mcp.tool()
    def stop_node(id: int) -> dict:
        """Stop a running node in the open lab. (Mutating; running session
        required.)"""
        return bridge_call("stop_node", current_pod.get(), id=id)

    @mcp.tool()
    def wipe_node(id: int, confirm: bool = False) -> dict:
        """Wipe a node's NVRAM/working dir back to its day-0 state. Destructive —
        pass confirm=true. (Mutating; running session required.)"""
        return bridge_call("wipe_node", current_pod.get(), id=id, confirm=bool(confirm))

    @mcp.tool()
    def export_running_config(node_id: int) -> dict:
        """Scrape the LIVE running-configuration off a started, config_capable node
        (config_<x>.py -a get) and return it as text. This is the export half of
        the import/export pair (set_startup_config is import). (Running session
        required.)"""
        return bridge_call("export_running_config", current_pod.get(), node_id=node_id)

    @mcp.tool()
    def apply_config_console(node_id: int, save: bool = True,
                             config_text: str = "") -> dict:
        """Apply a node's day-0 config the RELIABLE way: drive the running node's
        serial console like a human — abort autoinstall / the setup dialog, log in,
        paste the config in config mode, and (save=true) 'write memory' then export
        the running-config back into the lab. Use this AFTER set_startup_config +
        start_node instead of waiting out the slow unattended startup-config import
        (IOS otherwise sits on autoinstall for minutes; IOL on the setup dialog).
        Pastes the node's stored config unless config_text is given. Works for
        telnet-console IOS-family nodes (vIOS, IOL, ...). (Running session required;
        the node must be started.)"""
        return bridge_call("apply_config_console", current_pod.get(),
                           node_id=node_id, save=save,
                           config_text=(config_text or None))

    @mcp.tool()
    def set_link_impairment(node_id: int, iface: int,
                            delay: int = -1, jitter: int = -1, loss: int = -1,
                            rate: int = -1, advanced: dict = None) -> dict:
        """Apply WAN impairment (netem) to a running node's interface (iface,
        0-based). delay/jitter in ms, loss in %, rate in Kbit. Any knob you omit
        (leave -1) is cleared — this replaces the interface's whole impairment, so
        pass all the knobs you want active. advanced is an optional dict of the
        extra netem knobs: dist (uniform|normal|pareto|paretonormal), loss_mode
        (random|gemodel), delay_corr, loss_corr, duplicate, dup_corr, corrupt,
        reorder, reorder_corr, gap, limit. (Mutating; running session required.)"""
        params = {"node_id": node_id, "iface": iface}
        if delay >= 0:  params["delay"] = delay
        if jitter >= 0: params["jitter"] = jitter
        if loss >= 0:   params["loss"] = loss
        if rate >= 0:   params["rate"] = rate
        if isinstance(advanced, dict):
            for k, v in advanced.items():
                if v is not None and v != "":
                    params[k] = v
        return bridge_call("set_link_impairment", current_pod.get(), **params)

    @mcp.tool()
    def link_up(node_id: int, iface: int) -> dict:
        """Bring a running node's interface (iface, 0-based) administratively UP
        (un-suspend the link). (Mutating; running session required.)"""
        return bridge_call("link_up", current_pod.get(), node_id=node_id, iface=iface)

    @mcp.tool()
    def link_down(node_id: int, iface: int) -> dict:
        """Bring a running node's interface (iface, 0-based) administratively DOWN
        (suspend the link) to simulate a cable pull / failure. (Mutating; running
        session required.)"""
        return bridge_call("link_down", current_pod.get(), node_id=node_id, iface=iface)

    # ---- composite build (P6): whole topology in ONE bridge round-trip -------

    @mcp.tool()
    def build_topology(nodes: list, networks: list = None, links: list = None,
                       documentation: dict = None, lab_path: str = "") -> dict:
        """Build a WHOLE topology (many nodes, networks, links, and the lab docs)
        in ONE call — one engine bootstrap, one lab lock, one HTTP round-trip —
        instead of dozens of add_node/connect_* calls. This is the efficient way to
        realise an LLM-designed lab; use the individual add_node/connect_* tools only
        for incremental edits afterwards. Open or create the lab first (open_lab /
        create_lab), or pass lab_path.

        The ops run IN ORDER (all nodes, then networks, then links, then docs) under
        one lock, and STOP AT THE FIRST FAILURE: you get the results built so far,
        the index of the item that failed, and its error message — so you can fix and
        re-send just the remainder.

        nodes: list of node objects. Each:
            {"template": "<slug from list_templates>",   # REQUIRED, image_available
             "name": "R1",                                # optional hostname
             "left": 300, "top": 200,                     # optional canvas x/y
             "ram": 1024, "cpu": 2, "ethernet": 4,        # optional overrides (>0)
             "role": "switch"|"router",                   # optional, IOL only
             "image": "<image name>"}                     # optional explicit image
          A node is referenced elsewhere by its 0-based INDEX in this list, or by its
          "name" (if that name is unique across the list).
          A link's node reference may ALSO name a node that ALREADY EXISTS in this
          lab (added by an earlier build_topology/add_node call) — give its engine
          id (an integer) or its exact name (a string). This is how you build a lab
          bigger than one 200-op batch: open_lab the lab, then send further
          build_topology calls with links pointing at nodes already on the canvas.
          A same-call index/name always wins over an existing-node match of the
          same value.

        networks: optional list of network objects. Each:
            {"type": "bridge"|"cloud"|"nat"|"dot1q"|"wireless",   # default "bridge"
             "name": "LAN1", "left": 600, "top": 200}
          Referenced by its 0-based INDEX in this list, or by unique "name".
          NOTE: for a plain point-to-point link between two devices you do NOT need a
          network — use a node-to-node link (below); it draws a direct line.

        links: optional list. Two shapes:
          - node-to-node (a direct p2p line):
                {"a": <node ref>, "b": <node ref>,        # index or name
                 "a_if": 0, "b_if": 1}                     # optional; omit to auto-pick
          - node-to-network (attach a node port to a shared segment):
                {"node": <node ref>, "iface": 0, "network": <network ref>}
          <network ref> = the integer index into networks, its unique "name", or an
          already-existing engine network id.
          <node ref> = the integer index into nodes[], its unique "name" in this
          call, OR (for a node built in an earlier call) that node's existing
          engine id (int) or exact name (string).

        documentation: optional {"objectives": "<summary>", "tasks": ["step 1", ...]}.

        Returns a summary that maps every handle to the engine id the batch created:
            {"lab_path": "...", "ok": true,
             "nodes":    [{"index":0,"name":"R1","id":1}, ...],
             "networks": [{"index":0,"name":"LAN1","id":1}, ...],
             "links_created": 3,
             "failed_at": null, "error": null}
          On a failure you get "ok": false, the already-created nodes/networks, and
          failed_at = {"stage":"node"|"network"|"link"|"documentation","index":N,
          "detail":<the offending item>} plus "error" = the engine message."""
        lab = _bound(lab_path)
        nodes = nodes or []
        networks = networks or []
        links = links or []

        # handle registries: index -> handle, and unique name -> handle
        node_handles = {}      # i -> "n{i}"
        node_names = {}        # name -> handle  (None marks an ambiguous duplicate)
        net_handles = {}
        net_names = {}
        ops = []
        meta = []              # parallel to ops: (stage, source_index, handle_or_None)

        def _reg_name(table, name, handle):
            if not name:
                return
            table[name] = None if name in table else handle

        def _node_ref(ref, prefix):
            """Resolve a link's node reference to the op keys bridge.php expects,
            prefixed for that op's role: "a"/"b" (connect_nodes) or "node"
            (connect_node_to_network). A same-call index/name (this batch's
            node_handles/node_names) always wins and becomes {prefix}_handle. A
            ref that is NOT a same-call handle is treated as an ALREADY-EXISTING
            engine node — an int becomes {prefix}_id (literal engine node id), a
            string becomes {prefix}_name (resolved by bridge.php against the
            currently-open lab). Mirrors _net_ref's existing-engine fallback."""
            if isinstance(ref, bool):
                raise ValueError("bad node reference: %r" % (ref,))
            if isinstance(ref, int):
                if ref in node_handles:
                    return {prefix + "_handle": node_handles[ref]}
                # not a batch index -- treat as an existing engine node id
                return {prefix + "_id": int(ref)}
            s = str(ref)
            if s in node_names:
                if node_names[s] is None:
                    raise ValueError(
                        "link references ambiguous node name %r "
                        "(duplicated among this call's nodes)" % (ref,))
                return {prefix + "_handle": node_names[s]}
            if s.isdigit():
                idx = int(s)
                if idx in node_handles:
                    return {prefix + "_handle": node_handles[idx]}
                return {prefix + "_id": idx}
            # not created in this call -- treat as an existing lab node's name
            return {prefix + "_name": s}

        def _net_ref(ref):
            if isinstance(ref, int) and not isinstance(ref, bool):
                if ref in net_handles:
                    return {"network_handle": net_handles[ref]}
                # not a batch index — treat as an existing engine network id
                return {"net_id": int(ref)}
            s = str(ref)
            if s in net_names and net_names[s]:
                return {"network_handle": net_names[s]}
            if s.isdigit():
                idx = int(s)
                if idx in net_handles:
                    return {"network_handle": net_handles[idx]}
                return {"net_id": idx}
            raise ValueError("link references unknown network %r" % (ref,))

        try:
            # 1) nodes
            for i, n in enumerate(nodes):
                if not isinstance(n, dict) or not n.get("template"):
                    raise ValueError("nodes[%d] needs a 'template'" % i)
                h = "n%d" % i
                node_handles[i] = h
                _reg_name(node_names, n.get("name"), h)
                op = {"op": "add_node", "handle": h, "template": str(n["template"])}
                if n.get("name"):  op["name"] = str(n["name"])
                op["left"] = int(n.get("left", 0))
                op["top"] = int(n.get("top", 0))
                for k in ("ram", "cpu", "ethernet"):
                    if n.get(k):     op[k] = int(n[k])
                for k in ("role", "image"):
                    if n.get(k):     op[k] = str(n[k])
                ops.append(op); meta.append(("node", i, h))
            # 2) networks
            for j, w in enumerate(networks):
                w = w if isinstance(w, dict) else {}
                h = "net%d" % j
                net_handles[j] = h
                _reg_name(net_names, w.get("name"), h)
                op = {"op": "add_network", "handle": h,
                      "type": str(w.get("type", "bridge")),
                      "name": str(w.get("name", "Net")),
                      "left": int(w.get("left", 0)), "top": int(w.get("top", 0))}
                ops.append(op); meta.append(("network", j, h))
            # 3) links
            for li, lk in enumerate(links):
                if not isinstance(lk, dict):
                    raise ValueError("links[%d] must be an object" % li)
                if "network" in lk:
                    op = {"op": "connect_node_to_network",
                          "if": int(lk.get("iface", 0))}
                    op.update(_node_ref(lk.get("node"), "node"))
                    op.update(_net_ref(lk.get("network")))
                else:
                    op = {"op": "connect_nodes"}
                    op.update(_node_ref(lk.get("a"), "a"))
                    op.update(_node_ref(lk.get("b"), "b"))
                    if lk.get("a_if") is not None and int(lk["a_if"]) >= 0:
                        op["a_if"] = int(lk["a_if"])
                    if lk.get("b_if") is not None and int(lk["b_if"]) >= 0:
                        op["b_if"] = int(lk["b_if"])
                ops.append(op); meta.append(("link", li, None))
            # 4) documentation
            if isinstance(documentation, dict) and \
                    (documentation.get("objectives") or documentation.get("tasks")):
                ops.append({"op": "set_lab_documentation",
                            "objectives": str(documentation.get("objectives", "")),
                            "tasks": list(documentation.get("tasks") or [])})
                meta.append(("documentation", 0, None))
        except ValueError as e:
            # translation error — nothing was sent to the engine
            return {"lab_path": lab, "ok": False, "error": str(e),
                    "failed_at": {"stage": "translation", "detail": str(e)}}

        batch = bridge_batch(current_pod.get(), lab, ops)
        results = batch.get("results", []) if isinstance(batch, dict) else []
        failed_at = batch.get("failed_at") if isinstance(batch, dict) else None
        err = batch.get("error") if isinstance(batch, dict) else "no batch response"

        # map handles -> engine ids from the per-op results (same order as ops)
        node_out, net_out, links_created = [], [], 0
        for k, res in enumerate(results):
            if k >= len(meta):
                break
            stage, idx, handle = meta[k]
            rid = res.get("id") if isinstance(res, dict) else None
            if stage == "node":
                node_out.append({"index": idx, "handle": handle,
                                 "name": (nodes[idx].get("name") if isinstance(nodes[idx], dict) else None),
                                 "id": rid})
            elif stage == "network":
                net_out.append({"index": idx, "handle": handle,
                                "name": (networks[idx].get("name") if isinstance(networks[idx], dict) else None),
                                "id": rid})
            elif stage == "link":
                links_created += 1

        out = {"lab_path": lab, "ok": failed_at is None,
               "nodes": node_out, "networks": net_out,
               "links_created": links_created,
               "failed_at": None, "error": None}
        if failed_at is not None:
            fstage, fidx, _ = meta[failed_at] if failed_at < len(meta) else ("?", failed_at, None)
            src = None
            if fstage == "node" and fidx < len(nodes):       src = nodes[fidx]
            elif fstage == "network" and fidx < len(networks): src = networks[fidx]
            elif fstage == "link" and fidx < len(links):     src = links[fidx]
            out["error"] = err
            out["failed_at"] = {"op_index": failed_at, "stage": fstage,
                                "index": fidx, "detail": src}
        return out

    @mcp.tool()
    def usage_status() -> dict:
        """Report this user's AI token usage today and the per-user daily cap
        (0 = unlimited), so a large build can be sized against what is left."""
        return _usage_status(current_pod.get())

    return mcp


def _usage_status(pod):
    """Today's token usage for a pod + the configured per-user daily cap. The
    ledger/config are 0640 root:pnetlab-mcp, so this unprivileged service reads
    them directly (the root broker owns all writes)."""
    import datetime
    day = datetime.date.today().isoformat()
    used = 0
    try:
        with open("/opt/unetlab/data/ai/usage.json") as fh:
            led = json.load(fh)
        if isinstance(led.get(day), dict):
            used = int(led[day].get(str(pod), 0))
    except (OSError, ValueError):
        pass
    cap = 0
    try:
        cap = int(load_config().get("limits", {}).get("per_user_daily_tokens", 0))
    except (OSError, ValueError):
        pass
    return {"pod": pod, "day": day, "tokens_today": used,
            "per_user_daily_cap": cap,
            "remaining": (cap - used if cap else None)}


# ---- HTTP app with bearer-token auth + per-IP failed-auth throttling --------
#
# Lightweight, memory-only lockout so a leaked/guessed endpoint can't be brute-
# forced: FAIL_MAX failed auths from one source IP inside FAIL_WINDOW seconds ->
# HTTP 429 + Retry-After for FAIL_BLOCK seconds. A success clears the IP's record.
# The table is bounded (FAIL_CAP, oldest-first eviction) so it can't itself become
# a memory-DoS. Each record is [count, first_ts, blocked_until] (monotonic clock).
_LOOPBACK = ("127.0.0.1", "::1", "::ffff:127.0.0.1")
FAIL_MAX = 8
FAIL_WINDOW = 60.0
FAIL_BLOCK = 60.0
FAIL_CAP = 2048
_fail = {}
_fail_lock = threading.Lock()


def _client_ip(scope, headers):
    """Best-effort source IP from the ASGI scope. The immediate peer is normally
    the Apache reverse proxy on loopback (apache-mcp-external.conf.example), so when
    the peer IS loopback we honor the LAST X-Forwarded-For hop (the real client that
    Apache saw). Otherwise the socket peer is the client. Assumption: only a trusted
    loopback proxy is allowed to set XFF — direct (non-loopback) callers can't spoof
    their throttle identity because we ignore their XFF."""
    peer = ""
    cl = scope.get("client")
    if isinstance(cl, (tuple, list)) and cl:
        peer = str(cl[0])
    xff = headers.get("x-forwarded-for", "")
    if xff and peer in _LOOPBACK:
        hop = xff.split(",")[-1].strip()
        if hop:
            return hop
    return peer or "?"


def _throttle_retry(ip):
    """Seconds the caller must wait (0 if not currently blocked)."""
    now = time.monotonic()
    with _fail_lock:
        rec = _fail.get(ip)
        if rec and rec[2] and now < rec[2]:
            return int(rec[2] - now) + 1
    return 0


def _throttle_fail(ip):
    now = time.monotonic()
    with _fail_lock:
        rec = _fail.get(ip)
        if not rec or (now - rec[1]) > FAIL_WINDOW:
            rec = [0, now, 0.0]
        rec[0] += 1
        if rec[0] >= FAIL_MAX:
            rec[2] = now + FAIL_BLOCK
        _fail[ip] = rec
        if len(_fail) > FAIL_CAP:
            oldest = min(_fail, key=lambda k: _fail[k][1])
            _fail.pop(oldest, None)


def _throttle_ok(ip):
    if not ip:
        return
    with _fail_lock:
        _fail.pop(ip, None)


def make_http_app(mcp):
    inner = mcp.streamable_http_app()

    async def app(scope, receive, send):
        if scope.get("type") != "http":
            await inner(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode()
                   for k, v in (scope.get("headers") or [])}
        ip = _client_ip(scope, headers)

        retry = _throttle_retry(ip)
        if retry:
            body = b'{"error":"too many failed auth attempts, slow down"}'
            await send({"type": "http.response.start", "status": 429,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"retry-after", str(retry).encode())]})
            await send({"type": "http.response.body", "body": body})
            return

        pod = verify_bearer(headers.get("authorization", ""))
        if pod is None:
            _throttle_fail(ip)
            body = b'{"error":"missing or invalid bearer token"}'
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"),
                                    (b"www-authenticate", b"Bearer")]})
            await send({"type": "http.response.body", "body": body})
            return
        _throttle_ok(ip)

        # Per-connection identity for the bound-lab isolation (see current_session):
        # only what the client volunteered — the stateless transport mints none.
        tokp = current_pod.set(pod)
        toks = current_session.set(headers.get("mcp-session-id", ""))
        try:
            await inner(scope, receive, send)
        finally:
            current_pod.reset(tokp)
            current_session.reset(toks)

    return app


def main():
    ap = argparse.ArgumentParser(description="PNetLab MCP server")
    ap.add_argument("--stdio", action="store_true",
                    help="stdio transport (trusted local client)")
    ap.add_argument("--http", action="store_true",
                    help="Streamable-HTTP transport (default)")
    ap.add_argument("--pod", type=int, default=0,
                    help="pod/tenant to bind the stdio session to (the in-app "
                         "agent, spawned by root, passes the lab owner's pod)")
    ap.add_argument("--bind", default=None, help="override bind address")
    ap.add_argument("--port", type=int, default=None, help="override port")
    args = ap.parse_args()

    mcp = build_server()

    if args.stdio:
        # No bearer middleware on stdio — the caller is trusted-local (the broker
        # spawns it as root). Bind the whole session to the supplied pod so the
        # in-app agent's tools are tenant-scoped exactly like an HTTP client. This
        # is a single trusted session, so it is always "bindable": the open-lab
        # convenience works without a client-supplied session id.
        current_pod.set(args.pod)
        current_session.set("stdio")
        try:
            mcp.run(transport="stdio")
        finally:
            _close_client()
        return

    import uvicorn
    cfg = load_config().get("mcp", {})
    bind = args.bind or cfg.get("bind", "127.0.0.1")
    port = args.port or int(cfg.get("port", 5701))
    sys.stderr.write("pnetlab-mcp: Streamable-HTTP on %s:%d (path /mcp)\n"
                     % (bind, port))
    sys.stderr.flush()
    try:
        uvicorn.run(make_http_app(mcp), host=bind, port=port, log_level="info")
    finally:
        _close_client()


if __name__ == "__main__":
    main()
