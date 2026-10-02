#!/usr/bin/env python3
# p2_build_test.py — P2 acceptance driver for the PNetLab AI Lab Builder.
#
# Authenticates to the MCP service with a bearer token (the same way an external
# MCP client would), then builds a fixed topology entirely through the write
# tools — NO LLM — and reads it back to prove the programmatic build path:
#
#   create_lab -> add 3 routers + 1 PC -> a shared LAN bridge ->
#   connect all four to it -> day-0 startup-config on the config_capable routers
#   -> set lab documentation -> get_lab / list_nodes reflect everything.
#
# Usage:
#   python3 p2_build_test.py <bearer-token> [http://127.0.0.1:5701/mcp]
#
# Reads tool results from result.structuredContent (FastMCP json_response).

import asyncio
import json
import sys

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


def sc(result):
    """Pull the structured payload out of a CallToolResult. Prefer
    structuredContent; fall back to the JSON text content (older/newer SDKs
    differ on whether a bare dict return populates structuredContent)."""
    data = getattr(result, "structuredContent", None)
    if isinstance(data, dict):
        # FastMCP may wrap a bare return under {"result": ...}
        return data.get("result", data)
    for c in (getattr(result, "content", None) or []):
        text = getattr(c, "text", None)
        if text:
            try:
                return json.loads(text)
            except ValueError:
                return text
    return data


async def call(session, tool, **args):
    res = await session.call_tool(tool, args)
    if getattr(res, "isError", False):
        text = ""
        for c in (res.content or []):
            text += getattr(c, "text", "")
        raise RuntimeError(f"{tool} failed: {text}")
    return sc(res)


async def main(token, url):
    headers = {"Authorization": f"Bearer {token}"}
    async with streamablehttp_client(url, headers=headers) as (r, w, _):
        async with ClientSession(r, w) as session:
            await session.initialize()

            tools = await session.list_tools()
            names = sorted(t.name for t in tools.tools)
            print(f"[tools] {len(names)}: {', '.join(names)}")

            # ---- pick installed, buildable templates --------------------------
            tpls = await call(session, "list_templates")
            templates = tpls["templates"]
            slugs = {t["slug"] for t in templates}
            # a router we can actually place AND give a day-0 config to
            buildable_cfg = [t["slug"] for t in templates
                             if t.get("config_capable") and t.get("image_available")]
            router = ("vios" if "vios" in buildable_cfg
                      else (buildable_cfg[0] if buildable_cfg else None))
            if router is None:
                raise SystemExit("no config_capable template with an installed image "
                                 "— cannot test day-0 config on this server")
            pc = "vpcs" if "vpcs" in slugs else None
            print(f"[templates] router={router}  pc={pc}  "
                  f"buildable_config_capable={len(buildable_cfg)}")

            # ---- build --------------------------------------------------------
            lab = await call(session, "create_lab", name="AI-P2-Demo")
            lab_path = lab["lab_path"]
            print(f"[create_lab] {lab_path}  id={lab['id']}")

            await call(session, "set_lab_documentation",
                       objectives="P2 scripted-build acceptance: a 3-router triangle "
                                   "around a shared LAN with a PC, day-0 hostnames preloaded.",
                       tasks=["Verify all nodes present",
                              "Verify LAN bridge connects all four",
                              "Verify day-0 configs stored on routers"])

            # 3 routers
            rids = []
            for i, (nm, x, y) in enumerate(
                    [("R1", 120, 120), ("R2", 360, 120), ("R3", 240, 320)]):
                n = await call(session, "add_node", template=router, name=nm, left=x, top=y)
                rids.append(n["id"])
                print(f"[add_node] {nm} -> id {n['id']} ({n['name']})")

            # 1 PC (vpcs if available, else another router)
            pc_tpl = pc or router
            pcn = await call(session, "add_node", template=pc_tpl, name="PC1", left=240, top=480)
            pc_id = pcn["id"]
            print(f"[add_node] PC1 -> id {pc_id} (template {pc_tpl})")

            # shared LAN bridge, everyone on if0
            net = await call(session, "add_network", type="bridge", name="LAN", left=240, top=240)
            net_id = net["id"]
            print(f"[add_network] LAN -> id {net_id}")
            for nid in rids + [pc_id]:
                await call(session, "connect_node_to_network", node_id=nid, iface=0, net_id=net_id)
            print(f"[connect] {len(rids)+1} nodes -> LAN net {net_id}")

            # a point-to-point R1<->R2 on if1 (exercise connect_nodes too)
            link = await call(session, "connect_nodes", a_id=rids[0], a_if=1, b_id=rids[1], b_if=1)
            print(f"[connect_nodes] R1.e1 <-> R2.e1 via net {link['net_id']}")

            # day-0 configs on the routers (config_capable)
            for nid, nm in zip(rids, ["R1", "R2", "R3"]):
                cfgtext = f"hostname {nm}\n!\nend\n"
                r = await call(session, "set_startup_config", node_id=nid, config_text=cfgtext)
                print(f"[set_startup_config] {nm} id {nid}: {r['bytes']} bytes")

            # ---- read back & verify ------------------------------------------
            full = await call(session, "get_lab")
            nodes = full["nodes"]
            nets = full["networks"]
            cfgs = await call(session, "get_running_config")
            configs = cfgs["configs"]

            print("\n=== VERIFY ===")
            print(f"lab name: {full['name']}")
            print(f"description: {full['description'][:60]}...")
            print(f"nodes: {len(nodes)}  networks: {len(nets)}")
            ok = True
            if len(nodes) != 4:
                ok = False; print(f"  !! expected 4 nodes, got {len(nodes)}")
            for nid, nm in zip(rids, ["R1", "R2", "R3"]):
                got = configs.get(str(nid), "")
                marker = f"hostname {nm}"
                status = "ok" if marker in got else "MISSING"
                if marker not in got:
                    ok = False
                print(f"  node {nid} {nm}: day-0 {status}")
            print("\nRESULT:", "PASS" if ok else "FAIL")
            print("lab_path:", lab_path)
            return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    tok = sys.argv[1]
    u = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:5701/mcp"
    sys.exit(asyncio.run(main(tok, u)))
