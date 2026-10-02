#!/usr/bin/env python3
# pnetlab-labstated — lab-page live-state push server (Tier A, Phase 1).
#
# WHAT IT IS: a localhost WebSocket fan-out that PUSHES lab state to the topology
# page so the browser stops polling /api/labs/session/nodestatus per client. It is
# reached only through Apache's existing wss proxy (ProxyPass /labstate/ ->
# ws://127.0.0.1:8024/, mirroring the telnet/vnc/guac/shell lanes); CSP already
# allows it (connect-src 'self' wss: ws:).
#
# WHAT IT IS NOT: it is NOT brokerd. brokerd is a root request/response privilege
# broker on a unix socket, reachable only by uid0/www-data and never by the
# browser. This daemon holds no privilege: it runs as www-data, the same identity
# the web tier already uses, and only READS the snapshots the engine already
# produces (plus spawns the unprivileged, CLI-only node-state producer).
#
# DATA MODEL (single server-side sampler -> N browsers, the B4 win extended to a
# push): one refresher task per lab_session runs only while >=1 subscriber is
# attached. Each tick it:
#   node.state  - spawns php pnq-nodestate.php <lab_session> (reuses the engine's
#                 own getNodesStatus()), reads /dev/shm/pnet-nodestate/<ls>.json,
#                 broadcasts the CHANGED nids (full set on first send).
#   link.state  - if /dev/shm/pnet-watch/<tenant>_<ls>.json exists (Network Watcher
#                 running), broadcasts it verbatim and touch()es its .hb so
#                 linkwatchd stays alive for subscribers (replaces the per-GET touch
#                 in pnq-linkwatch.php). No-op when no watch is running.
#
# AUTH: the browser first calls the session-gated pnq-labstate-token.php (reuses
# the engine's own indentify::authorization + the user's open lab), which mints a
# single-use token into /dev/shm/pnet-labstate-tokens/<tok> = "<tenant> <ls>". The
# client passes it in the hello frame; we read+unlink the token and scope the whole
# connection to that tenant/lab. A client can never subscribe to a foreign lab.
#
# WIRE PROTOCOL (one JSON object per frame, newline not required):
#   c->s  {"t":"hello","token":"<hex32>"}
#         {"t":"sub","ch":["node.state","link.state"]}
#         {"t":"unsub","ch":[...]}  {"t":"ping"}
#   s->c  {"t":"hello.ok","lab_session":N}
#         {"t":"node.state","ts":..,"nodes":{"<nid>":<statuscode>,...}}   (delta)
#         {"t":"link.state","ts":..,"watch_id":"<t_ls>","taps":{...}}     (verbatim)
#         {"t":"pong"}  {"t":"err","msg":"..."}
#
# Run via pnetlab-labstated.service (User=www-data), shipped in the pnetlab deb.

import asyncio
import json
import os
import re
import time

import websockets

HOST = "127.0.0.1"
PORT = 8024

BASE = "/opt/unetlab"
PHP = "/usr/bin/php"
PRODUCER = BASE + "/html/pnq-nodestate.php"

TOKEN_DIR = "/dev/shm/pnet-labstate-tokens"
NODESTATE_DIR = "/dev/shm/pnet-nodestate"
WATCH_DIR = "/dev/shm/pnet-watch"

TOKEN_TTL = 120          # seconds; token must be fresh at handshake
TICK = 1.0               # refresher cadence (s)
PRODUCER_TIMEOUT = 20    # php producer hard cap (s)
MAX_MSG = 16 * 1024      # inbound frame cap

RE_TOKEN = re.compile(r"^[0-9a-f]{32}$")
RE_IDS = re.compile(r"^\d{1,6}$")
CHANNELS = {"node.state", "link.state"}


def log(msg):
    print(msg, flush=True)


# ---- per-lab subscriber registry + refresher --------------------------------

class Lab:
    """All connections scoped to one (tenant, lab_session) plus the single
    refresher task that samples on their behalf."""
    def __init__(self, tenant, ls):
        self.tenant = tenant
        self.ls = ls
        self.wid = "%d_%d" % (tenant, ls)
        self.conns = set()          # Conn objects
        self.task = None            # asyncio.Task (the refresher)
        self.node_state = {}        # last full {nid: status} we computed

    def start(self):
        if self.task is None or self.task.done():
            self.task = asyncio.ensure_future(self._refresh_loop())

    def stop(self):
        if self.task and not self.task.done():
            self.task.cancel()
        self.task = None

    async def _refresh_loop(self):
        try:
            while self.conns:
                await self._tick()
                await asyncio.sleep(TICK)
        except asyncio.CancelledError:
            pass
        except Exception as e:                              # never let it die silently
            log("lab %s refresher error: %r" % (self.wid, e))

    async def _tick(self):
        want_nodes = any("node.state" in c.subs for c in self.conns)
        want_links = any("link.state" in c.subs for c in self.conns)
        # Isolate the two channels: a malformed link snapshot (or any tick error)
        # must NOT propagate up and permanently kill this lab's refresher (which
        # would silently stop node.state delivery too, until a client resubscribes).
        if want_nodes:
            try:
                await self._tick_nodes()
            except Exception as e:
                log("lab %s node tick error: %r" % (self.wid, e))
        if want_links:
            try:
                await self._tick_links()
            except Exception as e:
                log("lab %s link tick error: %r" % (self.wid, e))

    async def _tick_nodes(self):
        # spawn the CLI-only producer; it (re)writes the snapshot for this lab
        try:
            proc = await asyncio.create_subprocess_exec(
                PHP, PRODUCER, str(self.ls),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL)
            await asyncio.wait_for(proc.wait(), timeout=PRODUCER_TIMEOUT)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            return
        except Exception as e:
            log("lab %s producer spawn failed: %r" % (self.wid, e))
            return
        snap = _read_json(os.path.join(NODESTATE_DIR, "%d.json" % self.ls))
        if not isinstance(snap, dict):
            return
        nodes = snap.get("nodes")
        if not isinstance(nodes, dict):
            return
        ts = snap.get("ts", round(time.time(), 1))
        for c in list(self.conns):
            if "node.state" not in c.subs:
                continue
            if c.node_state_primed:
                delta = {k: v for k, v in nodes.items()
                         if c.node_state.get(k) != v}
            else:
                delta = dict(nodes)               # first send = full
            if delta or not c.node_state_primed:
                c.node_state = dict(nodes)
                c.node_state_primed = True
                await c.send({"t": "node.state", "ts": ts, "nodes": delta})
        self.node_state = dict(nodes)

    async def _tick_links(self):
        path = os.path.join(WATCH_DIR, self.wid + ".json")
        snap = _read_json(path)
        if not isinstance(snap, dict):
            return
        # keep linkwatchd alive for our subscribers (the .hb touch pnq-linkwatch.php
        # would otherwise have done on each poll); group-writable, we are www-data
        try:
            os.utime(os.path.join(WATCH_DIR, self.wid + ".hb"), None)
        except OSError:
            pass
        mtime = snap.get("ts")
        for c in list(self.conns):
            if "link.state" not in c.subs:
                continue
            if c.link_ts == mtime:
                continue                          # unchanged since last send
            c.link_ts = mtime
            # AWAIT the send (like _tick_nodes) rather than fire-and-forget with
            # ensure_future: a slow/backgrounded client would otherwise accumulate
            # one detached, never-awaited send Task per tick forever — a real
            # slow-consumer task/memory leak. Serialized sends apply the websockets
            # library's own send-buffer backpressure instead.
            await c.send(
                {"t": "link.state", "ts": mtime, "watch_id": self.wid,
                 "taps": snap.get("taps", {})})


LABS = {}                # (tenant, ls) -> Lab


def _lab_for(tenant, ls):
    key = (tenant, ls)
    lab = LABS.get(key)
    if lab is None:
        lab = LABS[key] = Lab(tenant, ls)
    return lab


def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


# ---- per-connection ----------------------------------------------------------

class Conn:
    def __init__(self, ws):
        self.ws = ws
        self.lab = None
        self.subs = set()
        self.node_state = {}
        self.node_state_primed = False
        self.link_ts = None

    async def send(self, obj):
        try:
            await self.ws.send(json.dumps(obj, separators=(",", ":")))
        except Exception:
            pass


def _validate_token(token):
    """Read+unlink a single-use token; return (tenant, ls) or None."""
    if not RE_TOKEN.match(token or ""):
        return None
    path = os.path.join(TOKEN_DIR, token)
    try:
        st = os.stat(path)
        if time.time() - st.st_mtime > TOKEN_TTL:
            os.unlink(path)
            return None
        with open(path) as f:
            body = f.read().strip()
        os.unlink(path)                 # single-use
    except OSError:
        return None
    parts = body.split()
    if len(parts) != 2 or not RE_IDS.match(parts[0]) or not RE_IDS.match(parts[1]):
        return None
    return int(parts[0]), int(parts[1])


async def handler(ws, *args):
    conn = Conn(ws)
    try:
        async for raw in ws:
            if len(raw) > MAX_MSG:
                await conn.send({"t": "err", "msg": "frame too large"})
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                await conn.send({"t": "err", "msg": "bad json"})
                continue
            t = msg.get("t")
            if t == "hello":
                if conn.lab is not None:
                    continue
                res = _validate_token(msg.get("token"))
                if res is None:
                    await conn.send({"t": "err", "msg": "bad token"})
                    await ws.close()
                    return
                tenant, ls = res
                conn.lab = _lab_for(tenant, ls)
                conn.lab.conns.add(conn)
                await conn.send({"t": "hello.ok", "lab_session": ls})
            elif t == "sub":
                if conn.lab is None:
                    await conn.send({"t": "err", "msg": "hello first"})
                    continue
                for ch in msg.get("ch", []):
                    if ch in CHANNELS:
                        conn.subs.add(ch)
                conn.node_state_primed = False        # force a full resend
                conn.link_ts = None
                conn.lab.start()
            elif t == "unsub":
                for ch in msg.get("ch", []):
                    conn.subs.discard(ch)
            elif t == "ping":
                await conn.send({"t": "pong"})
            # unknown verbs ignored
    except websockets.ConnectionClosed:
        pass
    except Exception as e:
        log("conn error: %r" % e)
    finally:
        lab = conn.lab
        if lab is not None:
            lab.conns.discard(conn)
            if not lab.conns:
                lab.stop()
                LABS.pop((lab.tenant, lab.ls), None)


async def main():
    for d in (TOKEN_DIR, NODESTATE_DIR):
        try:
            os.makedirs(d, exist_ok=True)
            # 0700 not 0770: the daemon and the token-mint / node-state producer all
            # run as the SAME www-data uid, so group-write buys nothing and only
            # widens the blast radius if another service ever joins the www-data
            # group. The token dir holds single-use tenant/lab tokens.
            os.chmod(d, 0o700)
        except OSError:
            pass
    log("pnetlab-labstated listening on %s:%d" % (HOST, PORT))
    async with websockets.serve(handler, HOST, PORT, max_size=MAX_MSG,
                                ping_interval=30, ping_timeout=30):
        await asyncio.Future()          # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
