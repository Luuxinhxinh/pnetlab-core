#!/usr/bin/env python3
# pnet_racklayout — rack-view geometry builder for the Topology Overlays feature
# (Protocol Inspector sibling; see pnet_topomap.py / pnet_routeoverlay.py).
#
# THE PROJECTION IT PRODUCES
#   Lays the lab's nodes out as faceplates mounted in equipment racks, so a
#   learner sees how the topology looks patched into real rack hardware: labelled
#   switch faces with their cabled ports lit green, jumpers within a rack, and
#   inter-site cables between racks in different locations.
#
#   WIRING SOURCE = THE LAB MODEL (.unl), NOT CDP. Unlike the protocol overlays —
#   which must use CDP/LLDP to bind in-guest IPs/router-IDs/hostnames (invisible
#   to PNetLab) onto canvas nodes — a rack view is purely structural. The .unl
#   already holds every interface's name + network_id, so the web tier derives the
#   wiring directly: no console reads, works on a stopped lab, covers every node
#   type (docker/host/non-Cisco/L2-only) and every link, including ones where no
#   neighbour adjacency forms.
#
#   Network OBJECTS (clouds / NAT / management / shared bridges) become PATCH
#   PANELS named after the network; a hidden two-member private bridge is just a
#   point-to-point cable. The web tier classifies these and hands us:
#     nodes      : [{id,name,template,image,interfaces:[{name,connected}]}]
#     adjacencies: [{a_node,a_if,b_node,b_if}]            (p2p cables, node↔node)
#     segments   : [{net_id,name,type,members:[{node,ifname}]}]  (patch panels)
#     rack_map   : {key: {rack,location,u}}   key = "<node_id>" or "net:<net_id>"
#
#   Output (JSON on stdout):
#     racks  : [{id, location, units:[{node,name,u,faceplate}]}]
#                faceplate = {vendor, kind, border, port_count,
#                             ports:[{slot, ifname, cabled}]}   kind∈
#                {switch,router,firewall,generic,network}; node=int or "net:<id>"
#     cables : [{a_node,a_slot,b_node,b_slot, a_rack,b_rack, scope}]  intra|inter
#     warnings : [str]
#
# PURE + OFFLINE-TESTABLE: stdlib only, no console I/O. `python3 pnet_racklayout.py`
# with no stdin (or a tty) runs the self-test and exits 0 on success.

import json
import re
import sys


# ── vendor / kind / border classification ─────────────────────────────────────
# Match against the node's template + image (lower-cased). Firewalls first (the
# only vendor-coloured borders); everything else maps to a platform label on a
# neutral generic faceplate. Order matters: viosl2 before vios, etc.
def classify(template, image=""):
    """-> (vendor_label, kind, border_hex_or_None). kind in
    {switch, router, firewall, generic}."""
    t = (template or "").lower()
    img = (image or "").lower()
    hay = t + " " + img

    if "paloalto" in hay or "panos" in hay or "pa-vm" in hay:
        return ("Palo Alto", "firewall", "#ff7a1a")
    if "forti" in hay:
        return ("FortiGate", "firewall", "#ee2e24")
    if "asav" in hay or "-asa" in hay or t == "asa" or t.startswith("asa"):
        return ("ASA", "firewall", "#5b7a99")
    if "vsrx" in hay or "srx" in hay:
        return ("vSRX", "firewall", "#0f9d8a")
    if "checkpoint" in hay or "cpsg" in hay or "gaia" in hay:
        return ("Check Point", "firewall", "#c0398b")

    if "viosl2" in t or ("vios" in t and "l2" in img):
        return ("IOSvL2", "switch", None)
    if "vios" in t:
        return ("IOSv", "router", None)
    if t.startswith("iol") or "iol" in t:
        kind = "switch" if ("l2" in img or "l2" in t) else "router"
        return (("IOL-L2" if kind == "switch" else "IOL"), kind, None)
    if "nxos" in hay or "titanium" in hay or "n9k" in hay or "nexus" in hay:
        return ("Nexus", "switch", None)
    if "cat9k" in hay or "c9k" in hay:
        return ("Catalyst 9K", "switch", None)
    if "csr1000v" in t or t.startswith("csr"):
        return ("CSR1000v", "router", None)
    if "c8000v" in t or "c8kv" in t:
        return ("Cat8000v", "router", None)
    if "xrv" in t or "iosxr" in hay:
        return ("IOS-XR", "router", None)

    if "veos" in t or "arista" in hay:
        return ("Arista", "switch", None)
    if "vmx" in t or "vqfx" in t or "juniper" in hay or "junos" in hay:
        return ("Juniper", "router", None)

    if "sw" in t or "switch" in hay:
        return ("Switch", "switch", None)
    return ("Node", "generic", None)


# ── faceplate port layout ─────────────────────────────────────────────────────
_ROW_SIZES = [8, 12, 16, 24, 48]


def _round_ports(n):
    """Smallest realistic faceplate size that holds n ports."""
    for s in _ROW_SIZES:
        if n <= s:
            return s
    return ((n + 7) // 8) * 8


def _natkey(s):
    """Natural sort key so Gi0/2 sorts before Gi0/10."""
    parts = re.split(r"(\d+)", s or "")
    return [int(p) if p.isdigit() else p for p in parts]


def _port_num(ifname):
    """Trailing port ordinal of a canonical ifname: Gi0/1 -> 1, Gi1/0/24 -> 24."""
    nums = re.findall(r"\d+", ifname or "")
    return int(nums[-1]) if nums else None


def build_faceplate(node):
    """Build a device faceplate from the node's real interface list. Places each
    interface at the slot implied by its port number (collision-bumped), marks it
    green when connected. Returns (faceplate, ifname_to_slot)."""
    vendor, kind, border = classify(node.get("template"), node.get("image"))
    ifaces = node.get("interfaces") or []

    used = {}                                   # slot -> interface record
    if_to_slot = {}
    next_free = 0
    for it in sorted(ifaces, key=lambda x: _natkey(x.get("name", ""))):
        nm = it.get("name", "")
        p = _port_num(nm)
        slot = p if p is not None else next_free
        while slot in used:
            slot += 1
        used[slot] = it
        if_to_slot[nm] = slot
        next_free = max(next_free, slot + 1)

    max_slot = max(used) if used else -1
    port_count = _round_ports(max(len(ifaces), max_slot + 1, 1))

    ports = []
    for slot in range(port_count):
        it = used.get(slot)
        if it:
            conn = bool(it.get("connected"))
            state = ("free" if not conn
                     else ("suspended" if it.get("suspend") else "active"))
            ports.append({"slot": slot, "ifname": it.get("name", ""),
                          "cabled": conn, "state": state})
        else:
            ports.append({"slot": slot, "ifname": "", "cabled": False, "state": "free"})

    return ({"vendor": vendor, "kind": kind, "border": border,
             "port_count": port_count, "ports": ports}, if_to_slot)


def build_panel(seg, name_of):
    """Build a PATCH PANEL faceplate from a shared/cloud network segment. One port
    per member drop, labelled with the node it patches to, all green (cabled)."""
    members = seg.get("members") or []
    ports = []
    for i, m in enumerate(members):
        label = (name_of(m.get("node")) + " " + (m.get("ifname") or "")).strip()
        ports.append({"slot": i, "ifname": label, "cabled": True, "state": "active"})
    return {"vendor": seg.get("name") or ("Net " + str(seg.get("net_id"))),
            "kind": "network", "border": None, "nettype": seg.get("type", ""),
            "port_count": max(len(members), 1), "ports": ports}


# ── rack assembly ─────────────────────────────────────────────────────────────
def _keynode(key):
    """Cable endpoint id: int for a device, the "net:<id>" string for a panel."""
    return key if str(key).startswith("net:") else int(key)


def _seg_class(seg):
    """external = a cloud/NAT/management uplink (its own top patch panel);
    internal = a shared private bridge (co-located in a rack)."""
    c = seg.get("class")
    if c:
        return c
    t = (seg.get("type") or "bridge").lower()
    return "internal" if t.startswith("bridge") else "external"


def build_layout(nodes, adjacencies, segments, rack_map):
    nodes = nodes or []
    adjacencies = adjacencies or []
    segments = segments or []
    rack_map = rack_map or {}
    warnings = []

    by_id = {int(n["id"]): n for n in nodes}

    def name_of(nid):
        n = by_id.get(int(nid)) if nid is not None else None
        return str(n.get("name", "")) if n else ("node " + str(nid))

    # Faceplates: devices keyed by "<id>", patch panels keyed by "net:<id>".
    slot_index = {}
    unit_meta = {}
    for nid, n in by_id.items():
        fp, if2slot = build_faceplate(n)
        key = str(nid)
        slot_index[key] = if2slot
        unit_meta[key] = {"node": nid, "name": str(n.get("name", "")), "faceplate": fp}
    for seg in segments:
        key = "net:" + str(seg["net_id"])
        unit_meta[key] = {"node": key, "name": seg.get("name") or key,
                          "faceplate": build_panel(seg, name_of)}

    ext_segs = [s for s in segments if _seg_class(s) == "external"]
    int_segs = [s for s in segments if _seg_class(s) == "internal"]

    # Placement. Devices first (so an auto-placed internal panel can co-locate to a
    # member's rack). Unmapped devices park in "Unassigned"; internal panels follow
    # their first member; external (cloud/NAT/management) panels go in a dedicated
    # top "Uplinks" band, not in any rack.
    placement = {}
    uplink_keys = set()
    unassigned_u = 0
    for nid in by_id:
        key = str(nid)
        m = rack_map.get(key)
        if isinstance(m, dict) and m.get("rack"):
            placement[key] = (str(m.get("location", "")), str(m["rack"]), int(m.get("u", 0)))
        else:
            unassigned_u += 1
            placement[key] = ("Unassigned", "Unassigned", unassigned_u)
            warnings.append("node %d (%s) has no rack mapping — parked in Unassigned"
                            % (nid, by_id[nid].get("name", "")))
    for seg in int_segs:
        key = "net:" + str(seg["net_id"])
        m = rack_map.get(key)
        if isinstance(m, dict) and m.get("rack"):
            placement[key] = (str(m.get("location", "")), str(m["rack"]), int(m.get("u", 0)))
        else:
            loc = rack = None
            for mem in (seg.get("members") or []):
                pk = str(mem.get("node"))
                if pk in placement:
                    loc, rack, _ = placement[pk]
                    break
            if rack is None:
                loc, rack = ("Cabling", "Patch Panels")
            placement[key] = (loc, rack, 99)     # high U -> sorts below the devices
    for i, seg in enumerate(sorted(ext_segs, key=lambda s: (s.get("name") or "", s["net_id"]))):
        key = "net:" + str(seg["net_id"])
        placement[key] = ("__uplinks__", "Uplinks", i)
        uplink_keys.add(key)

    # Group devices + internal panels into racks; external panels into the band.
    rack_units = {}
    for key, (loc, rack, u) in placement.items():
        if key in uplink_keys:
            continue
        rack_units.setdefault((loc, rack), []).append({"key": key, "u": u})
    racks = []
    for (loc, rack) in sorted(rack_units, key=lambda lr: (lr[0], lr[1])):
        units = sorted(rack_units[(loc, rack)],
                       key=lambda x: (x["u"], unit_meta[x["key"]]["name"]))
        racks.append({"id": rack, "location": loc, "units": [
            {"node": unit_meta[u["key"]]["node"], "name": unit_meta[u["key"]]["name"],
             "u": u["u"], "faceplate": unit_meta[u["key"]]["faceplate"]} for u in units]})

    uplinks = []
    for key in sorted(uplink_keys, key=lambda k: placement[k][2]):
        m = unit_meta[key]
        uplinks.append({"node": m["node"], "name": m["name"], "faceplate": m["faceplate"]})

    # Cables: p2p (node↔node) + segment drops (node↔patch panel). scope = intra
    # when both endpoints share a rack, else inter (cross-rack / inter-site).
    cables = []

    def push(akey, a_slot, bkey, b_slot):
        if a_slot is None or b_slot is None:
            return
        if akey not in placement or bkey not in placement:
            return
        if akey in uplink_keys or bkey in uplink_keys:
            scope = "uplink"                       # drop to a top external panel
        else:
            scope = "intra" if placement[akey][:2] == placement[bkey][:2] else "inter"
        cables.append({"a_node": _keynode(akey), "a_slot": a_slot,
                       "b_node": _keynode(bkey), "b_slot": b_slot,
                       "a_rack": placement[akey][1], "b_rack": placement[bkey][1],
                       "scope": scope})

    for e in adjacencies:
        a, b = str(int(e["a_node"])), str(int(e["b_node"]))
        push(a, slot_index.get(a, {}).get(e.get("a_if", "")),
             b, slot_index.get(b, {}).get(e.get("b_if", "")))
    for seg in segments:
        key = "net:" + str(seg["net_id"])
        for i, m in enumerate(seg.get("members") or []):
            nk = str(int(m["node"]))
            push(nk, slot_index.get(nk, {}).get(m.get("ifname", ""), None), key, i)

    return {"racks": racks, "uplinks": uplinks, "cables": cables, "warnings": warnings}


# ── self-test ─────────────────────────────────────────────────────────────────
def _selftest():
    # Two Cisco switches + a Palo Alto firewall in rack 01 (DC-East); a Nexus + a
    # generic router in rack 02 (DC-West). Wiring as the lab model would give it:
    # p2p bridges -> adjacencies, a management cloud -> a patch panel segment.
    def ifs(names, connected):
        return [{"name": n, "connected": n in connected} for n in names]
    g8 = ["Gi0/0", "Gi0/1", "Gi0/2", "Gi0/3", "Gi0/4", "Gi0/5", "Gi0/6", "Gi0/7"]
    nodes = [
        {"id": 1, "name": "Core-SW1", "template": "iol", "image": "...l2...",
         "interfaces": ifs(g8, {"Gi0/0", "Gi0/1", "Gi0/5", "Gi0/7"})},
        {"id": 2, "name": "Acc-SW2", "template": "iol", "image": "...l2...",
         "interfaces": ifs(g8, {"Gi0/0", "Gi0/7"})},
        {"id": 3, "name": "FW1", "template": "paloalto", "image": "panos",
         "interfaces": ifs(["Gi0/0", "Gi0/1", "Gi0/2", "Gi0/3"], {"Gi0/0"})},
        {"id": 4, "name": "Dist-N9K", "template": "nxosv9k", "image": "nxos",
         "interfaces": ifs(["Gi0/0", "Gi0/1"], {"Gi0/0", "Gi0/1"})},
        {"id": 5, "name": "Edge-R5", "template": "vios", "image": "",
         "interfaces": ifs(["Gi0/0", "Gi0/7"], {"Gi0/0", "Gi0/7"})},
    ]
    adjacencies = [
        {"a_node": 1, "a_if": "Gi0/0", "b_node": 2, "b_if": "Gi0/0"},   # intra rack 01
        {"a_node": 1, "a_if": "Gi0/1", "b_node": 3, "b_if": "Gi0/0"},   # intra rack 01
        {"a_node": 1, "a_if": "Gi0/5", "b_node": 4, "b_if": "Gi0/1"},   # inter-site
        {"a_node": 4, "a_if": "Gi0/0", "b_node": 5, "b_if": "Gi0/0"},   # intra rack 02
    ]
    # A management cloud patches Core-SW1, Acc-SW2 and Edge-R5 -> a 3-drop panel.
    segments = [
        {"net_id": 9, "name": "Management0", "type": "pnet0", "members": [
            {"node": 1, "ifname": "Gi0/7"}, {"node": 2, "ifname": "Gi0/7"},
            {"node": 5, "ifname": "Gi0/7"}]},
    ]
    rack_map = {
        "1": {"rack": "Rack 01", "location": "DC-East", "u": 1},
        "2": {"rack": "Rack 01", "location": "DC-East", "u": 2},
        "3": {"rack": "Rack 01", "location": "DC-East", "u": 4},
        "4": {"rack": "Rack 02", "location": "DC-West", "u": 1},
        # node 5 + the Management0 panel intentionally unmapped
    }
    res = build_layout(nodes, adjacencies, segments, rack_map)
    ok = True

    def check(cond, label):
        nonlocal ok
        print(("  ok  " if cond else "  FAIL") + " " + label)
        ok = ok and cond

    racks = {(r["location"], r["id"]): r for r in res["racks"]}
    check(("DC-East", "Rack 01") in racks, "Rack 01 / DC-East assembled")
    check(("DC-West", "Rack 02") in racks, "Rack 02 / DC-West assembled")
    check(("Unassigned", "Unassigned") in racks, "unmapped device parked in Unassigned")

    r1 = racks[("DC-East", "Rack 01")]
    names1 = [u["name"] for u in r1["units"]]
    check(names1 == ["Core-SW1", "Acc-SW2", "FW1"],
          "Rack 01 holds only devices, ordered by U (no uplink panel)")

    # Management0 is a pnet0 cloud -> external uplink, in the top band, NOT a rack.
    up = {u["name"]: u for u in res["uplinks"]}
    check("Management0" in up and up["Management0"]["node"] == "net:9",
          "Management0 cloud rendered in the top Uplinks band")
    check(up.get("Management0", {}).get("faceplate", {}).get("port_count") == 3,
          "uplink patch panel sized to its 3 drops")
    check(not any(u["faceplate"]["kind"] == "network"
                  for r in res["racks"] for u in r["units"]),
          "no external panel leaked into a rack")
    check(_seg_class({"type": "bridge"}) == "internal"
          and _seg_class({"type": "pnet0"}) == "external",
          "_seg_class: bridge=internal, pnet0=external")

    fp1 = r1["units"][0]["faceplate"]
    check(fp1["vendor"] == "IOL-L2" and fp1["port_count"] == 8,
          "Core-SW1 = IOL-L2, 8-port face from its interface list")
    green = {p["slot"] for p in fp1["ports"] if p["cabled"]}
    check(green == {0, 1, 5, 7}, "Core-SW1 green ports at slots 0,1,5,7 (network_id>0)")
    fpfw = next(u for u in r1["units"] if u["name"] == "FW1")["faceplate"]
    check(fpfw["border"] == "#ff7a1a", "Palo Alto firewall keeps its orange border")

    cables = res["cables"]
    intra = [c for c in cables if c["scope"] == "intra"]
    inter = [c for c in cables if c["scope"] == "inter"]
    check(any({c["a_node"], c["b_node"]} == {1, 2} for c in intra),
          "Core-SW1<->Acc-SW2 intra-rack cable")
    check(any({c["a_node"], c["b_node"]} == {1, 4} for c in inter),
          "Core-SW1<->Dist-N9K inter-site cable")
    c14 = next(c for c in cables if {c["a_node"], c["b_node"]} == {1, 4})
    end1 = c14["a_slot"] if c14["a_node"] == 1 else c14["b_slot"]
    check(end1 == 5, "Core-SW1 end of the N9K cable lands on slot 5 (Gi0/5)")
    panel_cables = [c for c in cables if c["a_node"] == "net:9" or c["b_node"] == "net:9"]
    check(len(panel_cables) == 3, "3 drop cables from the Management0 patch panel")
    check(all(c["scope"] == "uplink" for c in panel_cables),
          "uplink panel drops tagged scope=uplink")
    check(any("Edge-R5" in w for w in res["warnings"]),
          "unmapped device surfaced as a warning")

    print("PASS" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    data = ""
    if not sys.stdin.isatty():
        try:
            data = sys.stdin.read()
        except Exception:
            data = ""
    if data.strip():
        try:
            b = json.loads(data)
            print(json.dumps(build_layout(b.get("nodes", []), b.get("adjacencies", []),
                                          b.get("segments", []), b.get("rack_map", {})),
                             separators=(",", ":")))
            sys.exit(0)
        except (ValueError, KeyError, TypeError) as e:
            print(json.dumps({"error": "bad input bundle: %s" % e}))
            sys.exit(2)
    sys.exit(_selftest())
