#!/usr/bin/env python3
# pnet_topomap — neighbour-discovery correlation core for the Topology Overlays
# feature (Protocol Inspector sibling; see pnet_bgpparse.py / pnet_protodecode.py).
#
# THE PROBLEM IT SOLVES
#   The router CLI talks in hostnames, router-IDs and next-hop IPs; the PNetLab
#   canvas knows node-ids + node names. PNetLab cannot see in-guest IP addressing,
#   so a protocol overlay (OSPF SPF tree, BGP best-path, EIGRP FS) cannot map a
#   next-hop IP onto a canvas link from topology data alone. The robust binding is
#   the routers' OWN neighbour discovery: CDP (Cisco, on by default) with an LLDP
#   fallback. From `show cdp neighbors detail` / `show lldp neighbors detail` run
#   on every running node we learn, per physical link:
#       (localNode, localInterface) <-> (remoteHostname, remoteInterface, remoteIP)
#   which yields three lookup tables the overlay parsers consume:
#       name_to_node : {hostname_lower -> node_id}     (CDP Device ID / LLDP SysName)
#       ip_to_node   : {ip -> node_id}                 (neighbour Entry/Mgmt address)
#       adjacencies  : [{a_node,a_if, b_node,b_if}]    (physical links, de-duped)
#   The adjacency list is what the SPF/best-path renderer paints onto the jsPlumb
#   connectors; ip_to_node maps OSPF RIDs and next-hops to nodes.
#
# PURE + OFFLINE-TESTABLE: parsing is stdlib-only with no console I/O. The web tier
# (pnq-overlay.php) collects the raw `show` output per node via the broker node_show
# verb and feeds this module a JSON bundle on stdin; `python3 pnet_topomap.py`
# (no stdin / a tty) runs the self-test and exits 0 on success.

import json
import re
import sys


# ── interface-name canonicalisation ──────────────────────────────────────────
# CDP prints long names ("GigabitEthernet0/1"), LLDP often prints short ("Gi0/1"),
# and the two ends of a link may disagree. Canonicalise to "<shortkind><num>" so
# we can dedupe links and match a router's local interface to a CDP/LLDP port id.
_IF_KINDS = [
    ("tengigabitethernet", "Te"), ("fortygigabitethernet", "Fo"),
    ("twentyfivegige", "Twe"), ("hundredgige", "Hu"),
    ("gigabitethernet", "Gi"), ("fastethernet", "Fa"),
    ("ethernet", "Et"), ("serial", "Se"), ("loopback", "Lo"),
    ("port-channel", "Po"), ("management", "Ma"), ("tunnel", "Tu"),
    ("vlan", "Vl"),
]


def canon_if(name):
    """'GigabitEthernet0/1' / 'Gi0/1' / 'gi 0/1' -> 'Gi0/1'. Unknown kinds pass
    through trimmed so we never lose information."""
    if not name:
        return ""
    s = name.strip()
    low = s.lower().replace(" ", "")
    # NX-OS abbreviates Ethernet as "Eth1/1" in some show outputs (spanning-tree)
    # but spells it "Ethernet1/1" in others (CDP/LLDP). "Eth" starts with the
    # short form "Et", so the short-form branch below would strip only 2 chars and
    # leave "Eth1/1" — never matching the "Et1/1" that CDP yields. Fold "Eth<n>"
    # to the long form first so both spellings canonicalise to "Et<n>".
    if low.startswith("eth") and not low.startswith("ethernet"):
        s = "Ethernet" + s[3:].strip()
        low = s.lower().replace(" ", "")
    for long_kind, short in _IF_KINDS:
        if low.startswith(long_kind):
            return short + s[len(long_kind):].strip()
        if low.startswith(short.lower()):
            # already short-ish: normalise the prefix casing, keep the suffix
            return short + s[len(short):].strip()
    return s


def _short_host(dev_id):
    """CDP Device IDs are often FQDNs ('R2.lab.local') or carry a serial in
    parens; LLDP System Names are usually bare. Reduce to the bare hostname."""
    if not dev_id:
        return ""
    h = dev_id.strip()
    h = re.sub(r"\(.*?\)", "", h).strip()          # drop "(FOC1234ABCD)"
    h = h.split()[0] if h.split() else h
    h = h.split(".")[0]                            # drop domain suffix
    return h


_IPV4 = re.compile(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b")


def _first_ip(text):
    m = _IPV4.search(text or "")
    return m.group(1) if m else ""


# ── CDP: `show cdp neighbors detail` ──────────────────────────────────────────
# Records are separated by a line of dashes. Fields we use:
#   Device ID: <hostname>
#   Entry address(es): \n   IP address: <ip>
#   Interface: <localIf>,  Port ID (outgoing port): <remoteIf>
def parse_cdp_detail(raw):
    """-> [{remote_host, remote_ip, local_if, remote_if}] (one per neighbour)."""
    neighbours = []
    # split on dashed separators (>=3 dashes on their own-ish line)
    blocks = re.split(r"(?m)^-{3,}\s*$", raw or "")
    for blk in blocks:
        if "Device ID" not in blk:
            continue
        host = ip = local_if = remote_if = ""
        m = re.search(r"Device ID:\s*(.+)", blk)
        if m:
            host = _short_host(m.group(1))
        # IP address may sit on the line after "Entry address(es):"
        m = re.search(r"IP(?:v4)? address:\s*([\d.]+)", blk)
        if m:
            ip = m.group(1)
        m = re.search(r"Interface:\s*([^,]+),\s*Port ID \(outgoing port\):\s*(.+)",
                      blk)
        if m:
            local_if = canon_if(m.group(1))
            remote_if = canon_if(m.group(2))
        if host or ip:
            neighbours.append({"remote_host": host, "remote_ip": ip,
                               "local_if": local_if, "remote_if": remote_if})
    return neighbours


# ── LLDP: `show lldp neighbors detail` ────────────────────────────────────────
#   Local Intf: <localIf>
#   Port id: <remoteIf>           (sometimes a MAC; Port Description has the name)
#   System Name: <hostname>
#   Management Addresses: \n    IP: <ip>
def parse_lldp_detail(raw):
    neighbours = []
    blocks = re.split(r"(?m)^-{3,}\s*$", raw or "")
    for blk in blocks:
        if "Local Intf" not in blk and "Local Interface" not in blk:
            continue
        host = ip = local_if = remote_if = ""
        m = re.search(r"Local In(?:tf|terface):\s*(.+)", blk)
        if m:
            local_if = canon_if(m.group(1))
        m = re.search(r"System Name:\s*(.+)", blk)
        if m:
            host = _short_host(m.group(1))
        # Prefer a human Port Description (a name) over a raw Port id (often MAC)
        m = re.search(r"Port Description:\s*(.+)", blk)
        if m and re.search(r"[A-Za-z]", m.group(1)):
            remote_if = canon_if(m.group(1))
        else:
            m = re.search(r"Port id:\s*(.+)", blk)
            if m:
                remote_if = canon_if(m.group(1))
        m = re.search(r"Management Addresses?:\s*(?:\n\s*IP:\s*)?([\d.]+)", blk)
        if not m:
            m = re.search(r"\bIP:\s*([\d.]+)", blk)
        if m:
            ip = m.group(1)
        if host or ip:
            neighbours.append({"remote_host": host, "remote_ip": ip,
                               "local_if": local_if, "remote_if": remote_if})
    return neighbours


def _resolve(remote_host, remote_ip, name_index, prelim_ip_to_node):
    """Map a neighbour record to a node_id: by hostname first, then by IP."""
    if remote_host:
        nid = name_index.get(remote_host.lower())
        if nid is not None:
            return nid
    if remote_ip:
        nid = prelim_ip_to_node.get(remote_ip)
        if nid is not None:
            return nid
    return None


def build_map(nodes, cdp_by_node, lldp_by_node=None):
    """Correlation core.

    nodes        : [{"id": int, "name": str}]  (running console nodes)
    cdp_by_node  : {node_id(str|int): raw `show cdp neighbors detail`}
    lldp_by_node : {node_id: raw `show lldp neighbors detail`} (fallback per node)

    Returns:
      {"name_to_node": {host_lower: id},
       "ip_to_node":   {ip: id},
       "adjacencies":  [{a_node,a_if,b_node,b_if,via}],  (a_node < b_node)
       "warnings":     [str]}
    """
    nodes = nodes or []
    name_index = {}
    id_to_name = {}
    for nd in nodes:
        nid = int(nd["id"])
        nm = str(nd.get("name", "")).strip()
        id_to_name[nid] = nm
        if nm:
            name_index[nm.lower()] = nid
            name_index[_short_host(nm).lower()] = nid

    warnings = []
    # Per-node neighbour lists, preferring CDP, falling back to LLDP where CDP
    # yielded nothing (mixed Cisco / non-Cisco labs).
    per_node = {}
    cdp_by_node = cdp_by_node or {}
    lldp_by_node = lldp_by_node or {}
    for nd in nodes:
        nid = int(nd["id"])
        cdp_raw = cdp_by_node.get(str(nid), cdp_by_node.get(nid, ""))
        nbrs = parse_cdp_detail(cdp_raw) if cdp_raw else []
        via = "cdp"
        if not nbrs:
            lldp_raw = lldp_by_node.get(str(nid), lldp_by_node.get(nid, ""))
            if lldp_raw:
                nbrs = parse_lldp_detail(lldp_raw)
                via = "lldp"
        if not nbrs:
            warnings.append("no CDP/LLDP neighbours discovered on node %d (%s)"
                            % (nid, id_to_name.get(nid, "?")))
        per_node[nid] = (nbrs, via)

    # First pass: hostname-only IP table (so the IP fallback can resolve a
    # neighbour even when its Device ID didn't match a node name).
    prelim_ip_to_node = {}
    for nid, (nbrs, _via) in per_node.items():
        for nb in nbrs:
            host_nid = (name_index.get(nb["remote_host"].lower())
                        if nb["remote_host"] else None)
            if host_nid is not None and nb["remote_ip"]:
                prelim_ip_to_node[nb["remote_ip"]] = host_nid

    ip_to_node = dict(prelim_ip_to_node)
    adj_seen = set()
    adjacencies = []
    for nid, (nbrs, via) in per_node.items():
        for nb in nbrs:
            peer = _resolve(nb["remote_host"], nb["remote_ip"],
                            name_index, prelim_ip_to_node)
            if peer is None:
                if nb["remote_host"]:
                    warnings.append("unmapped neighbour '%s' seen from node %d"
                                    % (nb["remote_host"], nid))
                continue
            if peer == nid:
                continue
            if nb["remote_ip"]:
                ip_to_node.setdefault(nb["remote_ip"], peer)
            a, b = (nid, peer) if nid < peer else (peer, nid)
            a_if, b_if = ((nb["local_if"], nb["remote_if"]) if nid < peer
                          else (nb["remote_if"], nb["local_if"]))
            key = (a, b, a_if, b_if)
            if key in adj_seen:
                continue
            adj_seen.add(key)
            adjacencies.append({"a_node": a, "a_if": a_if,
                                "b_node": b, "b_if": b_if, "via": via})

    name_to_node = {h: i for h, i in name_index.items()}
    return {"name_to_node": name_to_node, "ip_to_node": ip_to_node,
            "adjacencies": adjacencies, "warnings": warnings}


# ── CLI: read a JSON bundle on stdin, emit the map; no stdin => self-test ──────
def _main_stdin():
    bundle = json.load(sys.stdin)
    res = build_map(bundle.get("nodes", []),
                    bundle.get("cdp", {}),
                    bundle.get("lldp", {}))
    print(json.dumps(res, separators=(",", ":")))
    return 0


# ── self-test ─────────────────────────────────────────────────────────────────
_CDP_R1 = """\
-------------------------
Device ID: R2.lab.local
Entry address(es):
  IP address: 10.0.12.2
Platform: cisco IOSv,  Capabilities: Router
Interface: GigabitEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/0
Holdtime : 135 sec

-------------------------
Device ID: R3
Entry address(es):
  IP address: 10.0.13.3
Platform: cisco IOSv,  Capabilities: Router Switch IGMP
Interface: GigabitEthernet0/2,  Port ID (outgoing port): GigabitEthernet0/0
Holdtime : 121 sec
"""

_CDP_R2 = """\
-------------------------
Device ID: R1
Entry address(es):
  IP address: 10.0.12.1
Platform: cisco IOSv,  Capabilities: Router
Interface: GigabitEthernet0/0,  Port ID (outgoing port): GigabitEthernet0/1
Holdtime : 130 sec

-------------------------
Device ID: R4
Entry address(es):
  IP address: 10.0.24.4
Platform: cisco IOSv,  Capabilities: Router
Interface: GigabitEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/0
"""

# R4 also speaks CDP (every running router runs neighbour discovery).
_CDP_R4 = """\
-------------------------
Device ID: R2
Entry address(es):
  IP address: 10.0.24.2
Platform: cisco IOSv,  Capabilities: Router
Interface: GigabitEthernet0/0,  Port ID (outgoing port): GigabitEthernet0/1
Holdtime : 140 sec

-------------------------
Device ID: R3
Entry address(es):
  IP address: 10.0.34.3
Platform: cisco IOSv,  Capabilities: Router
Interface: GigabitEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/1
"""

# R3 speaks LLDP only (CDP off) — exercises the fallback + a Port-Description name
# and a stray switch neighbour that maps to no node (unmapped-warning path).
_LLDP_R3 = """\
------------------------------------------------
Local Intf: Gi0/0
Chassis id: 5000.0003.0000
Port id: Gi0/2
Port Description: GigabitEthernet0/2
System Name: R1
Management Addresses:
    IP: 10.0.13.1
------------------------------------------------
Local Intf: Gi0/1
Port id: Gi0/1
System Name: R4
Management Addresses:
    IP: 10.0.34.4
------------------------------------------------
Local Intf: Gi0/3
Port id: Gi1/0/24
System Name: ACCESS-SW1
Management Addresses:
    IP: 10.99.99.9
"""


def _selftest():
    nodes = [{"id": 1, "name": "R1"}, {"id": 2, "name": "R2"},
             {"id": 3, "name": "R3"}, {"id": 4, "name": "R4"}]
    res = build_map(
        nodes,
        cdp_by_node={"1": _CDP_R1, "2": _CDP_R2, "4": _CDP_R4},
        lldp_by_node={"3": _LLDP_R3},
    )
    ok = True

    def check(cond, label):
        nonlocal ok
        print(("  ok  " if cond else "  FAIL") + " " + label)
        ok = ok and cond

    adj = {(e["a_node"], e["b_node"]): e for e in res["adjacencies"]}
    check((1, 2) in adj, "R1<->R2 link discovered (CDP both ends, de-duped)")
    check((1, 3) in adj, "R1<->R3 link discovered (R1 CDP + R3 LLDP)")
    check((2, 4) in adj, "R2<->R4 link discovered (CDP both ends)")
    check((3, 4) in adj, "R3<->R4 link discovered (R3 LLDP + R4 CDP)")
    check(adj.get((1, 2), {}).get("a_if") == "Gi0/1"
          and adj.get((1, 2)).get("b_if") == "Gi0/0",
          "interfaces canonicalised + oriented to a_node<b_node")
    check(res["ip_to_node"].get("10.0.12.2") == 2, "ip_to_node 10.0.12.2 -> R2")
    check(res["ip_to_node"].get("10.0.24.4") == 4, "ip_to_node 10.0.24.4 -> R4")
    # R3 (LLDP-only) is processed before R4 (CDP) -> the R3<->R4 link is tagged
    # with R3's discovery source; R1<->R3 is tagged from R1's earlier CDP pass.
    check(adj.get((1, 3), {}).get("via") == "cdp"
          and adj.get((3, 4), {}).get("via") == "lldp",
          "via reflects CDP vs LLDP discovery source")
    check(canon_if("gigabitethernet0/1") == "Gi0/1"
          and canon_if("Gi 0/1") == "Gi0/1", "canon_if normalises long+short")
    check(len(res["adjacencies"]) == 4, "exactly 4 unique links (no duplicates)")
    check(any("ACCESS-SW1" in w for w in res["warnings"]),
          "non-node neighbour (ACCESS-SW1) surfaced as an unmapped warning")

    print("PASS" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    # A non-empty JSON bundle on stdin => run the correlation (the web-tier path).
    # Anything else (tty, empty, or non-JSON) => run the self-test. We never crash
    # on junk stdin, since callers (and ssh sessions) can leak unrelated bytes in.
    data = ""
    if not sys.stdin.isatty():
        try:
            data = sys.stdin.read()
        except Exception:
            data = ""
    if data.strip():
        try:
            b = json.loads(data)
            print(json.dumps(build_map(b.get("nodes", []), b.get("cdp", {}),
                                       b.get("lldp", {})),
                             separators=(",", ":")))
            sys.exit(0)
        except (ValueError, KeyError, TypeError) as e:
            print(json.dumps({"error": "bad input bundle: %s" % e}))
            sys.exit(2)
    sys.exit(_selftest())
