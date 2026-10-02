#!/usr/bin/env python3
# pnet_routeoverlay — compute the protocol forwarding picture to paint on the
# PNetLab canvas (Topology Overlays feature; sibling to pnet_bgpparse.py /
# pnet_protodecode.py / pnet_topomap.py). v1 = OSPF SPF tree.
#
# WHY THIS APPROACH (no LSDB / no router-ID correlation):
#   The classic way to get an SPF tree is to parse Router/Network LSAs and run
#   Dijkstra over router-IDs. But OSPF router-IDs are loopbacks that CDP/LLDP do
#   NOT advertise, so mapping an LSA back to a canvas node is fragile. Instead we
#   build the graph over the CDP NODE adjacency (from pnet_topomap) and weight
#   each directed edge with the *outbound* OSPF interface cost from
#   `show ip ospf interface brief`. That is exactly what OSPF Dijkstra sums along
#   a path, so the resulting tree + path costs match the router's own SPF, while
#   every edge is already a canvas node-pair (nothing to correlate by RID).
#
#   Per-interface cost can be asymmetric (cost is set per interface/direction);
#   we keep both directions and Dijkstra uses the cost in the direction of travel.
#   On a shared LAN with >2 routers each peer is a separate CDP adjacency at the
#   same outbound cost, which reproduces the pseudonode's path costs (segment->
#   router = 0) for path selection.
#
# PURE + OFFLINE-TESTABLE: stdlib only, no console I/O. The web tier
# (pnq-overlay.php) gathers the raw `show` output and feeds a JSON bundle on
# stdin; `python3 pnet_routeoverlay.py` with no/non-JSON stdin runs the self-test.

import heapq
import json
import re
import sys

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import pnet_topomap  # noqa: E402  (canon_if + build_map)

canon_if = pnet_topomap.canon_if


# ── `show ip ospf interface brief` ────────────────────────────────────────────
# IOS:    Interface  PID  Area  IP Address/Mask  Cost  State  Nbrs F/C
#         Gi0/2      1    0     25.1.1.5/24      1     BDR    1/1
# NX-OS:  Interface  ID   Area      Cost  State    Neighbors  Status   (no IP/Mask
#         Eth1/3     1    0.0.0.0   40    DROTHER  3          up        column; the
#         cost sits one column earlier, and the area is dotted)
def parse_ospf_if_brief(raw):
    """-> {canon_if: {"cost": int, "area": str, "state": str, "nbrs": str}}.
    Handles both the IOS and NX-OS column layouts (NX-OS drops the IP/Mask column
    so Cost shifts left)."""
    out = {}
    for ln in (raw or "").splitlines():
        toks = ln.split()
        if len(toks) < 5:
            continue
        low0 = toks[0].lower()
        if low0.startswith("interface") or low0 in ("ospf", "total"):  # headers
            continue
        if not toks[1].isdigit():                 # col 1 = PID / process id
            continue
        # IOS carries an IP/Mask column at toks[3] (dotted, often with /'); NX-OS
        # does not, so its Cost lands at toks[3]. Pick the cost column accordingly.
        if "/" in toks[3] or re.match(r"\d{1,3}(?:\.\d{1,3}){3}$", toks[3]):
            ci = 4                                 # IOS: cost after IP/Mask
        elif toks[3].isdigit():
            ci = 3                                 # NX-OS: cost right after Area
        else:
            continue
        if ci >= len(toks) or not toks[ci].isdigit():
            continue
        out[canon_if(toks[0])] = {
            "cost": int(toks[ci]), "area": toks[2],
            "state": toks[ci + 1] if ci + 1 < len(toks) else "",
            "nbrs": toks[ci + 2] if ci + 2 < len(toks) else "",
        }
    return out


def _edge_costs(adjacencies, if_cost_by_node):
    """Directed cost map from CDP adjacencies + per-interface OSPF cost.
    Returns ({(u,v): cost}, notes). A *directed* cost is recorded only when that
    end knows its interface cost (OSPF up on that side); Dijkstra then naturally
    can't traverse a link missing a cost. The output-edge list (built by the
    caller from ALL adjacencies) is separate, so a non-OSPF link still renders as
    discovered topology."""
    directed, notes = {}, []
    _cost = lambda c: (c["cost"] if isinstance(c, dict) else c)
    # A node with NO OSPF interface anywhere is a transparent L2 transit (a
    # switch): OSPF neighbours form ACROSS it on one broadcast segment. Model it
    # as a 0-cost OSPF transit network — a router ENTERS the switch at its own
    # interface cost and LEAVES the switch toward the other routers for free
    # (OSPF charges the egress interface only). That makes the segment usable and
    # paints the physical legs, instead of every switched link being "cost missing".
    no_ospf = lambda n: not if_cost_by_node.get(n)
    for e in adjacencies:
        a, b = e["a_node"], e["b_node"]
        ca = if_cost_by_node.get(a, {}).get(e.get("a_if", ""))
        cb = if_cost_by_node.get(b, {}).get(e.get("b_if", ""))
        # HONESTY GUARD (F1): an OSPF interface can carry a cost yet have formed NO
        # adjacency (mismatched hello/dead timers, subnet/mask, MTU, area or auth,
        # or `passive-interface`). Such a link is NOT a usable SPF path — OSPF never
        # runs its own SPF across it — so drop the side that shows 0 neighbours.
        # Without this the tree paints a first hop the router would never take (the
        # teaching hazard). Uses the F/C neighbour count already parsed from
        # `show ip ospf interface brief`; a side with no neighbour data (bare int /
        # blank column) is left untouched so legacy/self-test inputs are unaffected.
        noadj = False
        if ca is not None and not _if_has_adj(ca):
            notes.append("link %s-%s: %s has an OSPF cost but 0 adjacencies "
                         "(no OSPF neighbour) — excluded from SPF"
                         % (a, b, e.get("a_if")))
            ca, noadj = None, True
        if cb is not None and not _if_has_adj(cb):
            notes.append("link %s-%s: %s has an OSPF cost but 0 adjacencies "
                         "(no OSPF neighbour) — excluded from SPF"
                         % (a, b, e.get("b_if")))
            cb, noadj = None, True
        if ca is not None and cb is None and no_ospf(b):
            directed[(a, b)] = _cost(ca)         # router -> switch: egress cost
            directed[(b, a)] = 0                 # switch -> router: free
            continue
        if cb is not None and ca is None and no_ospf(a):
            directed[(b, a)] = _cost(cb)
            directed[(a, b)] = 0
            continue
        if (ca is None or cb is None) and not noadj:
            notes.append("link %s-%s: OSPF cost missing (%s/%s) — not in SPF graph"
                         % (a, b, e.get("a_if"), e.get("b_if")))
        if ca is not None:
            directed[(a, b)] = _cost(ca)
        if cb is not None:
            directed[(b, a)] = _cost(cb)
    return directed, notes


def _if_has_adj(c):
    """Does this parsed `show ip ospf interface brief` record show at least one
    OSPF neighbour? `c` is the parse_ospf_if_brief dict ({"cost","nbrs",...}) or a
    bare int (legacy/self-test inputs with no neighbour data -> assume adjacency).
    The Nbrs field is IOS "F/C" (Full/Config count) or an NX-OS plain integer; the
    FULL count (the token before any '/') is the number of usable adjacencies. When
    the column is absent or unparseable we conservatively assume adjacency so we
    never drop a link on ambiguous data."""
    if not isinstance(c, dict):
        return True                      # no neighbour data -> don't second-guess
    nb = c.get("nbrs")
    if nb is None or str(nb).strip() == "":
        return True                      # column absent -> assume adjacent (legacy)
    head = str(nb).split("/", 1)[0].strip()
    if not head.isdigit():
        return True                      # unparseable -> conservative include
    return int(head) > 0


def spf_tree(nodes, adjacencies, if_cost_by_node, root):
    """Dijkstra from `root` over the node graph; mark tree edges + ECMP.

    Returns:
      {"root": root,
       "edges":[{a,b,cost_ab,cost_ba,in_tree,ecmp,dir}],   (a<b, matches canvas)
       "dist":{node:cost}, "unreachable":[node], "notes":[str]}
    `dir` is "a2b"/"b2a"/None — which way the tree traverses the edge (for an
    arrowhead); ecmp flags an edge that is one of several equal-cost tree paths."""
    root = int(root)
    directed, notes = _edge_costs(adjacencies, if_cost_by_node)

    # Dijkstra graph = only links that form a real OSPF adjacency (both ends
    # advertise an OSPF cost); a one-sided cost is not a usable SP edge.
    adj = {}
    for e in adjacencies:
        a, b = e["a_node"], e["b_node"]
        if (a, b) in directed and (b, a) in directed:
            adj.setdefault(a, []).append((b, directed[(a, b)]))
            adj.setdefault(b, []).append((a, directed[(b, a)]))

    node_ids = {int(n["id"]) for n in (nodes or [])}
    node_ids |= {e["a_node"] for e in adjacencies} | {e["b_node"]
                                                      for e in adjacencies}

    INF = float("inf")
    dist = {n: INF for n in node_ids}
    dist[root] = 0
    # parents[n] = set of immediate predecessors on a shortest path (ECMP-aware)
    parents = {n: set() for n in node_ids}
    pq = [(0, root)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist[u]:
            continue
        for v, w in adj.get(u, []):
            nd = d + w
            if nd < dist[v]:
                dist[v] = nd
                parents[v] = {u}
                heapq.heappush(pq, (nd, v))
            elif nd == dist[v]:
                parents[v].add(u)            # equal-cost path -> ECMP

    # tree edges = every (parent -> child) pair on a shortest path
    tree_dir = {}        # (a,b) undirected -> "a2b"/"b2a"
    tree_ecmp = set()
    for child, preds in parents.items():
        if child == root or not preds:
            continue
        ecmp = len(preds) > 1
        for p in preds:
            a, b = (p, child) if p < child else (child, p)
            tree_dir[(a, b)] = "a2b" if p < child else "b2a"
            if ecmp or len(parents.get(child, set())) > 1:
                tree_ecmp.add((a, b))

    # Output one edge per PHYSICAL link (all CDP adjacencies), annotated. Links
    # without OSPF simply come back in_tree=false / cost=null so the client can
    # still draw the discovered topology.
    edges, seen = [], set()
    for e in adjacencies:
        a, b = e["a_node"], e["b_node"]
        a, b = (a, b) if a < b else (b, a)
        if (a, b) in seen:
            continue
        seen.add((a, b))
        edges.append({
            "a": a, "b": b,
            "cost_ab": directed.get((a, b)),
            "cost_ba": directed.get((b, a)),
            "in_tree": (a, b) in tree_dir,
            "ecmp": (a, b) in tree_ecmp,
            "dir": tree_dir.get((a, b)),
        })

    # only OSPF-reachable matters; nodes with no OSPF link at all aren't "in" SPF
    in_graph = set(adj.keys())
    unreachable = sorted(n for n in node_ids
                         if n != root and n in in_graph and dist[n] == INF)
    return {"root": root, "edges": edges,
            "dist": {str(k): (None if v == INF else v) for k, v in dist.items()},
            "unreachable": unreachable, "notes": notes}


# ── OSPF truth-source guard: cross-check the computed SPF tree vs the root's RIB ─
# The SPF tree above is COMPUTED by us (Dijkstra over interface costs), so it can
# diverge from what the router actually installed — e.g. a link that carries costs
# but no adjacency (caught by _if_has_adj), or a multi-area preference our flat
# Dijkstra doesn't model. One cheap, robust check closes most of that gap: read
# `show ip route ospf` on the ROOT and confirm every tree edge LEAVING the root
# uses an egress interface the router really forwards OSPF traffic out of. First
# hop only — we don't have every node's RIB — but that is exactly where a painted
# lie (a hop out a non-forwarding interface) is most misleading.
def parse_ospf_rib(raw):
    """`show ip route ospf` on one node -> {"egress": set(canon_if),
    "nexthops": set(ip), "routes": int}. Handles the IOS layout
    ('O[ IA|E2|..]  10.0.0.0/24 [110/20] via 10.1.12.2, 00:.., GigabitEthernet0/1'
    with ECMP/continuation 'via' lines) and the NX-OS layout
    ('*via 10.1.12.2, Eth1/1, [110/20], .., ospf-1, ..'). Since the command is
    already filtered to OSPF, every 'via' line is an OSPF forwarding hop."""
    egress, nexthops, n = set(), set(), 0
    _IFACE = r"([A-Za-z][A-Za-z.-]*\d[\w./-]*)"     # Gi0/1, Ethernet0/0, Eth1/1, Se0/0
    for ln in (raw or "").splitlines():
        s = ln.strip()
        # NX-OS best-path line: "*via <ip>, <iface>, [110/..], .., ospf.., .."
        m = re.match(r"\*via\s+(\d{1,3}(?:\.\d{1,3}){3}),\s*" + _IFACE, s)
        if m:
            nexthops.add(m.group(1))
            egress.add(canon_if(m.group(2)))
            n += 1
            continue
        # IOS route header begins a route ("O", "O IA", "O E2", "O*E1", ...).
        if re.match(r"^O[\s*A-Z0-9]", s):
            n += 1
        # IOS next-hop line (header OR ECMP continuation): "... via <ip>, .., <iface>"
        mv = re.search(r"via\s+(\d{1,3}(?:\.\d{1,3}){3})", s)
        if mv:
            nexthops.add(mv.group(1))
            me = re.search(r",\s*" + _IFACE + r"\s*$", s)
            if me:
                egress.add(canon_if(me.group(1)))
    return {"egress": egress, "nexthops": nexthops, "routes": n}


def annotate_ospf_rib(res, adjacencies, root, rib):
    """Cross-check the computed SPF tree (res from spf_tree) against the root's real
    OSPF RIB (parse_ospf_rib output). For every in_tree edge INCIDENT TO THE ROOT,
    resolve the root's local egress interface (from the CDP adjacency) and mark the
    edge rib_ok / rib_diverge by whether that interface appears in the RIB's egress
    set. Adds `rib_checked`, `rib_routes`, and a divergence note. Skips silently
    when the RIB has no OSPF routes (nothing to verify — every edge would else
    false-flag). Mutates and returns res."""
    res["rib_checked"] = False
    if not rib or rib.get("routes", 0) == 0:
        return res
    root = int(root)
    egress = rib.get("egress") or set()
    diverged = []
    for e in res.get("edges", []):
        if not e.get("in_tree"):
            continue
        a, b = e["a"], e["b"]
        if root not in (a, b):
            continue                     # only first-hop edges are RIB-verifiable
        rif = None
        for adj in adjacencies:
            if {adj["a_node"], adj["b_node"]} == {a, b}:
                rif = adj["a_if"] if adj["a_node"] == root else adj["b_if"]
                break
        if rif is None:
            continue
        rif = canon_if(rif)
        ok = rif in egress
        e["rib_ok"] = ok
        if not ok:
            e["rib_diverge"] = True
            diverged.append(rif)
    res["rib_checked"] = True
    res["rib_routes"] = rib.get("routes", 0)
    if diverged:
        ifs = sorted(set(diverged))
        res.setdefault("notes", []).append(
            "SPF vs RIB: the computed tree forwards out %s, but the root's actual "
            "OSPF routing table never uses %s — the tree diverges from the router's "
            "RIB here (the adjacency may be down)."
            % (", ".join(ifs),
               "that interface" if len(ifs) == 1 else "those interfaces"))
    return res


# ── BGP best-path: follow CEF hop-by-hop ──────────────────────────────────────
# `show ip cef <prefix>` gives the *resolved* forwarding decision per node — the
# outgoing interface(s) for the prefix, recursion already collapsed by CEF. That
# sidesteps iBGP next-hop-self / loopback next-hops (which `show ip route` leaves
# unresolved): the outgoing interface maps straight to a physical link via the CDP
# adjacency, so we never need to chase a next-hop IP through the IGP ourselves.
#   nexthop 12.1.1.2 Ethernet0/0     -> forward out Et0/0 (ECMP = several)
#   attached to Ethernet0/0          -> prefix is directly connected here (egress)
#   receive (for Loopback0)          -> prefix is local to this node (origin)
def parse_cef(raw):
    """-> {"nexthops":[{ip,iface}], "attached":[iface], "local":bool}."""
    res = {"nexthops": [], "attached": [], "local": False}
    for ln in (raw or "").splitlines():
        s = ln.strip()
        m = re.match(r"nexthop\s+(\d+\.\d+\.\d+\.\d+)\s+(\S+)", s)
        if m:
            res["nexthops"].append({"ip": m.group(1), "iface": canon_if(m.group(2))})
            continue
        m = re.match(r"attached to\s+(\S+)", s, re.I)
        if m:
            res["attached"].append(canon_if(m.group(1)))
            continue
        if re.match(r"receive\b", s, re.I):
            res["local"] = True
    return res


# NX-OS has no `show ip cef <prefix>`; `show ip route <prefix>` is the forwarding
# truth. Same shape as parse_cef so trace_bgp can use either. NX-OS leaves a
# routed (bgp/ospf/…) next-hop's egress interface IMPLICIT — only the next-hop IP
# is given (recursive) — so iface is often None and the caller resolves the IP to
# the owning node via an interface-IP map (ip2node):
#   1.1.1.1/32, ubest/mbest: 1/0
#       *via 10.0.0.5, [20/0], 00:01:40, bgp-1, external, tag 2   <- recursive nh
#   10.0.0.0/24, ubest/mbest: 1/0, attached
#       *via 10.0.0.3, Eth1/3, [0/0], 00:14:47, direct            <- connected (egress)
def parse_route(raw):
    """NX-OS `show ip route <prefix>` -> {nexthops:[{ip,iface}], attached:[iface],
    local:bool}. Only `*via` (best ucast) lines are forwarding; several = ECMP.
    `direct` -> the prefix is connected here (egress/origin); `local`/`receive`
    -> the prefix is the node's own address; anything else is a routed next-hop
    (iface present = resolved egress, else recursive -> resolve ip via ip2node)."""
    res = {"nexthops": [], "attached": [], "local": False}
    for ln in (raw or "").splitlines():
        s = ln.strip()
        if not s.startswith("*via"):
            continue
        m = re.match(r"\*via\s+(\d+\.\d+\.\d+\.\d+)(?:,\s*([A-Za-z][\w./-]*))?", s)
        if not m:
            continue
        ip, iface = m.group(1), m.group(2)
        low = s.lower()
        if re.search(r",\s*direct\b", low):
            if iface:
                res["attached"].append(canon_if(iface))
            continue
        if re.search(r",\s*(local|receive|broadcast)\b", low):
            res["local"] = True
            continue
        res["nexthops"].append({"ip": ip,
                                "iface": canon_if(iface) if iface else None})
    return res


def parse_route_table(raw):
    """`show ip route` (the WHOLE table, IOS or NX-OS) -> [{prefix, proto, via}],
    one row per destination — the protocol-agnostic Route-Path picker. Lists every
    installed prefix regardless of which protocol put it there (O/B/D/S/C/local…).
    Lenient on the IOS mask (a subnetted host line may omit /len) — the trace does
    a longest-match lookup anyway."""
    out, seen, cur = [], set(), None
    for ln in (raw or "").splitlines():
        s = ln.rstrip()
        # NX-OS: "<prefix>, ubest/mbest: N/M[, attached]" then "*via …, <proto>…"
        m = re.match(r"^(\d{1,3}(?:\.\d{1,3}){3}/\d{1,2}),\s+ubest", s)
        if m:
            cur = m.group(1)
            if cur not in seen:
                seen.add(cur); out.append({"prefix": cur, "proto": "", "via": ""})
            continue
        if cur:
            mv = re.match(r"\s*\*via\s+(\d{1,3}(?:\.\d{1,3}){3})[, ].*?,\s*"
                          r"([a-z][\w-]*)\b", s)
            if mv:
                for r in out:
                    if r["prefix"] == cur and not r["proto"]:
                        r["proto"] = mv.group(2); r["via"] = mv.group(1)
                        break
                continue
        # IOS: "<code…>  <prefix>[/len] [ad/m] via <nh>" / "is directly connected"
        mi = re.match(r"^([A-Z][A-Z0-9* ]{0,4}?)\s+"
                      r"(\d{1,3}(?:\.\d{1,3}){3}(?:/\d{1,2})?)\b", s)
        if mi and mi.group(1).strip() not in ("VRF",):
            pfx = mi.group(2)
            if pfx not in seen:
                seen.add(pfx)
                vh = re.search(r"via\s+(\d{1,3}(?:\.\d{1,3}){3})", s)
                out.append({"prefix": pfx, "proto": mi.group(1).strip(),
                            "via": vh.group(1) if vh else ""})
    return out


# `show ip interface brief` — used to map a next-hop IP (incl. a tunnel-overlay
# address) back to the node that OWNS it, so an off-canvas/tunnel forwarding hop
# can be drawn as a virtual link to the right canvas node. CDP can't do this for
# a DMVPN/GRE tunnel (it doesn't run over the overlay), but every node's own
# interface list does.
#   Interface              IP-Address      OK? Method Status   Protocol
#   Tunnel100              10.1.1.1        YES NVRAM  up       up
#   GigabitEthernet0/1     unassigned      YES NVRAM  up       up
def parse_ip_brief(raw):
    """-> [(canon_if, ip)] for interfaces with an assigned IPv4 address."""
    out = []
    for ln in (raw or "").splitlines():
        toks = ln.split()
        if len(toks) < 2:
            continue
        if toks[0].lower().startswith("interface"):
            continue
        if re.match(r"\d{1,3}(?:\.\d{1,3}){3}$", toks[1]):
            out.append((canon_if(toks[0]), toks[1]))
    return out


def trace_bgp(nodes, adjacencies, cef_by_node, prefix, root,
              nos_by_node=None, ip2node=None):
    """Walk the forwarding path for `prefix` from `root` across the canvas.

    IOS reads `show ip cef <prefix>` (resolved egress interface); NX-OS reads
    `show ip route <prefix>` (recursive next-hop IP, no cef) — parse_route gives
    the next-hop, and a next-hop with no egress interface is resolved to its
    owning node via ip2node (each node's `show ip interface brief`). Returns the
    same edge shape as spf_tree but with in_path/order/ecmp, plus `origin` (nodes
    that own/deliver the prefix)."""
    root = int(root)
    nos_by_node = nos_by_node or {}
    ip2node = ip2node or {}
    # (node, canon_if) -> peer node from the CDP adjacency; plus an undirected
    # node graph used to path THROUGH transit L2 switches that transparently
    # bridge a next-hop's subnet (router -> switch -> next-hop owner).
    ifpeer, adjg = {}, {}
    for e in adjacencies:
        ifpeer[(e["a_node"], e.get("a_if", ""))] = e["b_node"]
        ifpeer[(e["b_node"], e.get("b_if", ""))] = e["a_node"]
        adjg.setdefault(e["a_node"], set()).add(e["b_node"])
        adjg.setdefault(e["b_node"], set()).add(e["a_node"])

    def _bfs_path(src, dst):
        """Shortest node path src->dst over the adjacency, as consecutive (x,y)
        forwarding pairs (or [] if unreachable). One hop when directly adjacent;
        multi-hop when the next-hop owner sits behind a transit L2 switch."""
        if src == dst:
            return []
        prev, q = {src: None}, [src]
        while q:
            u = q.pop(0)
            for v in adjg.get(u, ()):
                if v in prev:
                    continue
                prev[v] = u
                if v == dst:
                    seg, cur = [], v
                    while prev[cur] is not None:
                        seg.append((prev[cur], cur)); cur = prev[cur]
                    return list(reversed(seg))
                q.append(v)
        return []

    path_dir, path_order, ecmp_edges, origin = {}, {}, set(), set()
    notes, visited = [], set()
    queue = [(root, 0)]
    while queue:
        node, hop = queue.pop(0)
        if node in visited:
            continue
        visited.add(node)
        raw = cef_by_node.get(str(node), cef_by_node.get(node, ""))
        nos = nos_by_node.get(str(node), nos_by_node.get(node, "ios"))
        cef = parse_route(raw) if nos == "nxos" else parse_cef(raw)
        if cef["local"] or cef["attached"]:
            origin.add(node)            # prefix terminates here
        nh = cef["nexthops"]
        is_ecmp = len(nh) > 1
        for h in nh:
            # Resolve to the node that OWNS the next-hop IP (so a switch in
            # between gets pathed through), preferring ip2node; fall back to the
            # CEF egress interface -> directly-connected peer (IOS w/o ipbrief).
            peer = ip2node.get(h["ip"]) if h.get("ip") else None
            if peer is None and h.get("iface"):
                peer = ifpeer.get((node, h["iface"]))
            if peer is None:
                notes.append("node %s forwards %s to a next-hop not on the canvas"
                             % (node, h.get("iface") or h.get("ip") or "?"))
                continue
            seg = _bfs_path(node, peer)
            if not seg:
                notes.append("node %s next-hop %s not reachable across the canvas"
                             % (node, h.get("ip") or peer))
                continue
            for (x, y) in seg:                 # light each leg (incl. switch legs)
                a, b = (x, y) if x < y else (y, x)
                if (a, b) not in path_dir:
                    path_dir[(a, b)] = "a2b" if x < y else "b2a"
                    path_order[(a, b)] = hop
                if is_ecmp:
                    ecmp_edges.add((a, b))
            if peer not in visited:
                queue.append((peer, hop + 1))

    edges, seen = [], set()
    for e in adjacencies:
        a, b = e["a_node"], e["b_node"]
        a, b = (a, b) if a < b else (b, a)
        if (a, b) in seen:
            continue
        seen.add((a, b))
        edges.append({"a": a, "b": b, "in_path": (a, b) in path_dir,
                      "order": path_order.get((a, b)), "dir": path_dir.get((a, b)),
                      "ecmp": (a, b) in ecmp_edges})
    return {"root": root, "prefix": prefix, "edges": edges,
            "origin": sorted(origin), "notes": notes}


# ── EIGRP successor / feasible-successor: DUAL over `show ip eigrp topology` ────
# The default topology TABLE (no <prefix> arg) already lists, per prefix, only the
# successor(s) + feasible successor(s) — routes that fail feasibility need
# `all-links`, so every via we see is a candidate. One command per node feeds both
# the picker and the overlay; we re-derive the DUAL classification ourselves so
# the teaching is honest rather than trusting "it's in the table".
#
#   P 9.9.9.0/24, 1 successors, FD is 200
#           via 10.1.2.2 (200/100), GigabitEthernet0/1      <- TD/RD, local egress
#           via 10.1.3.3 (300/100), GigabitEthernet0/2
#   P 10.1.2.0/24, 1 successors, FD is 2816
#           via Connected, GigabitEthernet0/1               <- originated here
#           via Redistributed (130816/0)                    <- (no interface)
#
#   successor          : TD == FD
#   feasible successor  : TD != FD  AND  RD < FD   (the feasibility condition)
#   origin             : a Connected/Redistributed via (prefix is local here)
_EIG_HDR = re.compile(
    r"(\d{1,3}(?:\.\d{1,3}){3}/\d{1,2}),\s*(\d+)\s+successors?,\s+FD is (\d+)")
_EIG_VIA = re.compile(
    r"^\s*via\s+(\S+?),?\s*(?:\((\d+)/(\d+)\))?(?:,\s*(\S+))?\s*$", re.I)


def parse_eigrp_topology(raw):
    """-> {prefix: {"fd": int, "succ_count": int, "connected": bool,
                    "blocks": [{"nexthop": ip, "iface": canon_if,
                                "td": int|None, "rd": int|None}]}}.
    Only IP-next-hop blocks land in "blocks"; Connected/Redistributed set the
    entry's "connected" (origin) flag instead (they have no canvas peer)."""
    out, cur = {}, None
    for ln in (raw or "").splitlines():
        m = _EIG_HDR.search(ln)
        if m:
            cur = {"fd": int(m.group(3)), "succ_count": int(m.group(2)),
                   "connected": False, "blocks": []}
            out[m.group(1)] = cur
            continue
        if cur is None:
            continue
        v = _EIG_VIA.match(ln)
        if not v:
            continue
        nh = v.group(1)
        if re.match(r"\d{1,3}(?:\.\d{1,3}){3}$", nh):
            cur["blocks"].append({
                "nexthop": nh, "iface": canon_if(v.group(4) or ""),
                "td": int(v.group(2)) if v.group(2) is not None else None,
                "rd": int(v.group(3)) if v.group(3) is not None else None,
            })
        elif nh.lower() in ("connected", "redistributed", "rstatic", "summary"):
            cur["connected"] = True
    return out


def _iface_kind(iface):
    """Classify a (canon) interface so the UI can explain an off-canvas exit.
    DMVPN/GRE successors leave via Tunnel, summaries via Null0 — none of which is
    a CDP link, so the forwarding hop has no canvas peer. Returns one of
    tunnel/loopback/vlan/portchannel/null/physical."""
    s = (iface or "").lower()
    if s.startswith("tu"):
        return "tunnel"
    if s.startswith("lo"):
        return "loopback"
    if s.startswith("vl"):
        return "vlan"
    if s.startswith("po"):
        return "portchannel"
    if s.startswith("null") or s.startswith("nu"):
        return "null"
    return "physical"


def _eigrp_classify(entry):
    """Split an entry's IP blocks into (successors, feasible_successors,
    non_feasible). FD from the header (fallback: min TD).
        successor      : TD == FD
        feasible succ  : TD != FD  AND  RD <  FD     (passes feasibility)
        non-feasible   : TD != FD  AND  RD >= FD     (FAILS feasibility — only
                         visible with `show ip eigrp topology all-links`)
    Blocks missing a metric are ignored for selection."""
    blocks = [b for b in entry["blocks"] if b.get("td") is not None]
    if not blocks:
        return [], [], []
    fd = entry.get("fd")
    if fd is None:
        fd = min(b["td"] for b in blocks)
    succ = [b for b in blocks if b["td"] == fd]
    fs = [b for b in blocks if b["td"] != fd
          and b.get("rd") is not None and b["rd"] < fd]
    nf = [b for b in blocks if b["td"] != fd
          and b.get("rd") is not None and b["rd"] >= fd]
    return succ, fs, nf


def trace_eigrp(nodes, adjacencies, eigrp_by_node, cef_by_node, prefix, root,
                ip2node=None):
    """Map the EIGRP forwarding picture for `prefix` from `root`.

    FORWARDING TRUTH = `show ip cef <prefix>` — the FIB already reflects EIGRP
    variance unequal-cost load balancing AND the feasibility filter (a feasible
    successor within variance*FD is installed; one that fails RD<FD never is, even
    if its metric is within variance). The EIGRP topology table supplies each
    link's DUAL role (S/FS) + composite metric. So a variance-installed feasible
    successor renders as an ACTIVE (solid) load-balancing path labelled FS, while
    a feasible successor that is only a backup (variance off, or beyond it) stays
    dashed. With no CEF on a node we fall back to the topology successors, i.e.
    the plain best-path (pre-variance) view.

    Edge shape: {a,b, forwarding, backup, infeasible, role:'S'|'FS'|'X'|'', lb,
    order, dir, metric, rd, fd}.  forwarding=solid, backup=dashed,
    infeasible=red-dashed (RD>=FD, fails feasibility); `lb`=this edge is one of
    several forwarding next-hops at its upstream node (load balancing);
    `role`/`metric` drive the per-link "S · <FD>" / "FS · <TD>" label, while an
    infeasible edge labels its violation "RD <rd> >= FD <fd>".

    A successor / FS that exits an interface with no canvas peer (a DMVPN/GRE
    Tunnel, a Null0 summary, or an off-canvas neighbour) can't be drawn as a
    link, so it's reported in `offcanvas` instead — surfaced in the legend so the
    path doesn't just silently stop."""
    root = int(root)
    ip2node = ip2node or {}
    ifpeer = {}
    for e in adjacencies:
        ifpeer[(e["a_node"], e.get("a_if", ""))] = e["b_node"]
        ifpeer[(e["b_node"], e.get("b_if", ""))] = e["a_node"]

    fwd_dir, fwd_order, role, metric, edge_rd, edge_fd = {}, {}, {}, {}, {}, {}
    lb_edges, backup_dir, infeasible_dir, origin = set(), {}, {}, set()
    notes, offcanvas, visited = [], [], set()

    def _offcanvas(node, iface, nh, r):
        """Record a successor/FS that leaves via a non-canvas interface. Dedup on
        (node, iface, nexthop) so a multipoint tunnel (DMVPN: several NHRP peers
        out one Tunnel) shows every spoke. `peer` = the canvas node that OWNS the
        next-hop IP (from `show ip interface brief`), letting the client draw a
        virtual link to it even though there's no CDP adjacency for the tunnel."""
        nh = nh or ""
        for o in offcanvas:
            if o["node"] == node and o["iface"] == iface and o["nexthop"] == nh:
                return
        peer = ip2node.get(nh)
        if peer == node:          # never point a hop back at the forwarding node
            peer = None
        offcanvas.append({"node": node, "iface": iface, "kind": _iface_kind(iface),
                          "nexthop": nh, "role": r, "peer": peer})

    queue = [(root, 0)]
    while queue:
        node, hop = queue.pop(0)
        if node in visited:
            continue
        visited.add(node)
        # DUAL role + metric per outbound interface, from the topology table
        entry = eigrp_by_node.get(str(node), eigrp_by_node.get(node, {})).get(prefix)
        s_blocks, fs_blocks, nf_blocks, roles = [], [], [], {}
        node_fd = entry.get("fd") if entry else None
        if entry:
            if entry.get("connected"):
                origin.add(node)
            s_blocks, fs_blocks, nf_blocks = _eigrp_classify(entry)
            for b in s_blocks:
                roles[b["iface"]] = ("S", b["td"])
            for b in fs_blocks:
                roles[b["iface"]] = ("FS", b["td"])
        # forwarding next-hops: CEF (variance-aware) else topology successors
        cef = parse_cef(cef_by_node.get(str(node), cef_by_node.get(node, "")))
        if cef["local"] or cef["attached"]:
            origin.add(node)
        # (iface, next-hop ip) pairs — keep each next-hop distinct even when two
        # exit the same interface (DMVPN: several NHRP peers out one Tunnel).
        fwd_hops = ([(h["iface"], h["ip"]) for h in cef["nexthops"]]
                    or [(b["iface"], b.get("nexthop")) for b in s_blocks])
        fwd_ifaces = [iface for iface, _ in fwd_hops]
        is_lb = len(fwd_hops) > 1
        for iface, nhip in fwd_hops:
            peer = ifpeer.get((node, iface))
            if peer is None:
                r = roles.get(iface)
                _offcanvas(node, iface, nhip, r[0] if r else "S")
                continue
            a, c = (node, peer) if node < peer else (peer, node)
            if (a, c) not in fwd_dir:
                fwd_dir[(a, c)] = "a2b" if node < peer else "b2a"
                fwd_order[(a, c)] = hop
                r = roles.get(iface)
                if r:
                    role[(a, c)] = r[0]
                    metric[(a, c)] = r[1]
            if is_lb:
                lb_edges.add((a, c))
            if peer not in visited:
                queue.append((peer, hop + 1))
        # feasible successors NOT in the forwarding set -> dashed backups
        for b in fs_blocks:
            if b["iface"] in fwd_ifaces:
                continue
            peer = ifpeer.get((node, b["iface"]))
            if peer is None:
                _offcanvas(node, b["iface"], b.get("nexthop"), "FS")
                continue
            a, c = (node, peer) if node < peer else (peer, node)
            backup_dir.setdefault((a, c), "a2b" if node < peer else "b2a")
            metric.setdefault((a, c), b["td"])
            role.setdefault((a, c), "FS")
        # non-feasible neighbours (all-links): RD>=FD — show WHY they're excluded.
        # Off-canvas non-feasible vias are skipped (no link, and they're not even
        # candidates — clutter); only drawable ones teach the feasibility check.
        for b in nf_blocks:
            peer = ifpeer.get((node, b["iface"]))
            if peer is None:
                continue
            a, c = (node, peer) if node < peer else (peer, node)
            if (a, c) in fwd_dir or (a, c) in backup_dir:
                continue
            infeasible_dir.setdefault((a, c), "a2b" if node < peer else "b2a")
            metric.setdefault((a, c), b["td"])
            edge_rd.setdefault((a, c), b.get("rd"))
            if node_fd is not None:
                edge_fd.setdefault((a, c), node_fd)
            role.setdefault((a, c), "X")

    edges, seen = [], set()
    for e in adjacencies:
        a, b = e["a_node"], e["b_node"]
        a, b = (a, b) if a < b else (b, a)
        if (a, b) in seen:
            continue
        seen.add((a, b))
        fwd = (a, b) in fwd_dir
        bkp = (a, b) in backup_dir and not fwd
        edges.append({
            "a": a, "b": b,
            "forwarding": fwd,
            "backup": bkp,
            "infeasible": (a, b) in infeasible_dir and not fwd and not bkp,
            "role": role.get((a, b), ""),
            "lb": (a, b) in lb_edges,
            "order": fwd_order.get((a, b)),
            "dir": (fwd_dir.get((a, b)) or backup_dir.get((a, b))
                    or infeasible_dir.get((a, b))),
            "metric": metric.get((a, b)),
            "rd": edge_rd.get((a, b)),
            "fd": edge_fd.get((a, b)),
        })
    return {"root": root, "prefix": prefix, "edges": edges,
            "loadbalance": bool(lb_edges), "offcanvas": offcanvas,
            "origin": sorted(origin), "notes": notes}


# ── STP port roles: `show spanning-tree vlan <id>` ────────────────────────────
# Per VLAN, each bridge reports the Root ID, its own Bridge ID, and a per-port
# Role/State table. We re-derive the spanning tree picture purely from these:
#   root bridge   = the node whose Bridge ID address == the common Root ID address
#   per link      = colour by the COMBINED state of its two ends (each end is one
#                   port): both FWD = forwarding tree; an Altn/Back/BLK end = the
#                   STP-blocked redundant link; an LIS/LRN end = still converging.
#   port role     = Root / Desg / Altn / Back (highlighted per end).
#
#   Root ID    Priority    24586
#              Address     aabb.cc00.0100
#              This bridge is the root            <- (only on the root)
#   Bridge ID  Priority    32778  (priority 32768 sys-id-ext 10)
#              Address     aabb.cc00.0200
#   Interface           Role Sts Cost      Prio.Nbr Type
#   Gi0/1               Root FWD 4         128.1    P2p
#   Gi0/2               Altn BLK 4         128.3    P2p
_STP_ADDR = re.compile(r"Address\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})")
_STP_PORT = re.compile(
    r"^(\S+)\s+(Root|Desg|Altn|Back|Mstr|Disa\w*|Boun\w*)\s+"
    r"(FWD|BLK|LIS|LRN|DIS|BKN)\b\s*(\d+)?", re.I)


def parse_stp(raw):
    """One `show spanning-tree vlan <id>` -> {root_addr, bridge_addr, is_root,
    root_prio, bridge_prio, root_cost, ports:{canon_if:{role,state,cost}}}.
    root_cost = this bridge's cost to the root (the Root ID block's "Cost" line;
    absent / 0 on the root itself)."""
    root_addr = bridge_addr = root_prio = bridge_prio = root_cost = None
    is_root = False
    section = None
    ports = {}
    for ln in (raw or "").splitlines():
        s = ln.strip()
        m = re.match(r"Root ID\s+Priority\s+(\d+)", s, re.I)
        if m:
            section = "root"
            root_prio = int(m.group(1))
            continue
        m = re.match(r"Bridge ID\s+Priority\s+(\d+)", s, re.I)
        if m:
            section = "bridge"
            bridge_prio = int(m.group(1))
            continue
        if re.search(r"this bridge is the root", s, re.I):
            is_root = True
            continue
        if section == "root":
            mc = re.match(r"Cost\s+(\d+)", s, re.I)
            if mc:
                root_cost = int(mc.group(1))
                continue
        m = _STP_ADDR.search(s)
        if m:
            if section == "root" and root_addr is None:
                root_addr = m.group(1).lower()
            elif section == "bridge" and bridge_addr is None:
                bridge_addr = m.group(1).lower()
            continue
        m = _STP_PORT.match(s)
        if m:
            ports[canon_if(m.group(1))] = {
                "role": m.group(2).title()[:4],     # Root/Desg/Altn/Back/Disa/Boun
                "state": m.group(3).upper(),
                "cost": int(m.group(4)) if m.group(4) else None,
            }
    if root_addr and bridge_addr and root_addr == bridge_addr:
        is_root = True
    return {"root_addr": root_addr, "bridge_addr": bridge_addr,
            "is_root": is_root, "root_prio": root_prio,
            "bridge_prio": bridge_prio, "root_cost": root_cost, "ports": ports}


def parse_stp_vlans(raw):
    """`show spanning-tree` (all VLANs) -> sorted unique VLAN ids for the picker."""
    seen = set()
    for m in re.finditer(r"\bVLAN0*(\d+)\b", raw or ""):
        seen.add(int(m.group(1)))
    return [{"vlan": v} for v in sorted(seen)]


def parse_stp_all(raw):
    """`show spanning-tree` (every VLAN) -> {vlan_int: parse_stp(section)}.
    Split before each VLANxxxx header so each chunk is one VLAN's instance."""
    out = {}
    for sec in re.split(r"(?m)^(?=\s*VLAN0*\d+\b)", raw or ""):
        m = re.match(r"\s*VLAN0*(\d+)\b", sec)
        if m:
            out[int(m.group(1))] = parse_stp(sec)
    return out


def compare_stp_roots(nodes, stp_all_by_node):
    """Per-VLAN root bridge across all nodes -> [{vlan, root, root_prio,
    root_addr}] sorted by vlan. `root` = node id owning the root bridge (or None
    if the root is off-canvas). Drives the per-VLAN root-comparison table (spot
    PVST+ load-balancing: different VLANs rooted on different switches)."""
    vlans = set()
    for rec in stp_all_by_node.values():
        vlans |= set(rec.keys())
    rows = []
    for v in sorted(vlans):
        addr2node, root_addr, root_prio, root = {}, None, None, None
        for nid_str, rec in stp_all_by_node.items():
            e = rec.get(v)
            if not e:
                continue
            if e.get("bridge_addr"):
                addr2node[e["bridge_addr"]] = int(nid_str)
            if e.get("root_addr"):
                root_addr, root_prio = e["root_addr"], e.get("root_prio")
            if e.get("is_root"):
                root = int(nid_str)
        if root is None and root_addr:
            root = addr2node.get(root_addr)
        rows.append({"vlan": v, "root": root, "root_prio": root_prio,
                     "root_addr": root_addr})
    return rows


# `show spanning-tree vlan <id> detail` — why a port blocks. Each port is a block:
#   Port 5 (Ethernet0/1) of VLAN0010 is alternate blocking
#     Port path cost 100, Port priority 128, Port Identifier 128.5.
#     Designated root has priority 24586, address aabb.cc00.0001
#     Designated bridge has priority 32778, address bbbb.0000.0002
#     Designated port id is 128.2, designated path cost 0
#
# MST `show spanning-tree mst <n> detail` uses a DIFFERENT layout (no "Port N (..)"
# wrapper; fields packed onto the Designated lines):
#     Ethernet1/0 of MST1 is alternate blocking
#     Port info             port id   128.5  priority 128  cost 2000000
#     Designated root       address aabb.cc00.0100  priority 24577  cost 0
#     Designated bridge     address aabb.cc00.0100  priority 24577  port id 128.4
# A block starts at the "<iface> of <inst> is <role> <state>" header (either form).
_STP_DET_HDR = re.compile(
    r"^(?:Port\s+\d+\s+\(([^)]+)\)|(\S+))\s+of\s+\S+\s+is\s+(\w+)\s+(\w+)", re.I)


def parse_stp_detail(raw):
    """All ports from `show spanning-tree vlan|mst … detail` ->
    [{iface,role,state,port_cost,port_id,des_root_*,des_bridge_*,des_cost,
    des_port_id}]. Handles BOTH the PVST and MST detail layouts. We need ALL ports
    (not just the blocked one) to compare the blocked port to this bridge's ROOT
    port and report the real tiebreak."""
    ports, cur = [], None
    for ln in (raw or "").splitlines():
        m = _STP_DET_HDR.match(ln.strip())
        if m:
            cur = {"iface": canon_if(m.group(1) or m.group(2)),
                   "role": m.group(3).lower(), "state": m.group(4).lower(),
                   "port_cost": None, "port_id": None,
                   "des_root_prio": None, "des_root_addr": None,
                   "des_bridge_prio": None, "des_bridge_addr": None,
                   "des_cost": None, "des_port_id": None}
            ports.append(cur)
            continue
        if cur is None:
            continue
        s = ln.strip()
        # port path cost + own port id (PVST "Port path cost"/"Port Identifier"
        # OR MST "Port info … cost …/… port id …")
        mm = (re.search(r"Port path cost\s+(\d+)", s, re.I)
              or re.search(r"Port info\b.*?\bcost\s+(\d+)", s, re.I))
        if mm:
            cur["port_cost"] = int(mm.group(1))
        mm = (re.search(r"Port Identifier\s+([\d.]+)", s, re.I)
              or re.search(r"Port info\b.*?\bport id\s+([\d.]+)", s, re.I))
        if mm:
            cur["port_id"] = mm.group(1).rstrip(".")
        # designated root — PVST "has priority P, address A"; MST "address A
        # priority P cost C" (C = the root path cost advertised on this segment)
        mm = re.search(r"Designated root has priority\s+(\d+),\s*address\s+([0-9a-fA-F.]+)", s, re.I)
        if mm:
            cur["des_root_prio"] = int(mm.group(1)); cur["des_root_addr"] = mm.group(2).lower()
        mm = re.search(r"Designated root\s+address\s+([0-9a-fA-F.]+)\s+priority\s+(\d+)(?:\s+cost\s+(\d+))?", s, re.I)
        if mm:
            cur["des_root_addr"] = mm.group(1).lower(); cur["des_root_prio"] = int(mm.group(2))
            if mm.group(3) is not None:
                cur["des_cost"] = int(mm.group(3))
        # designated bridge — PVST "has priority P, address A"; MST "address A
        # priority P port id PID" (PID = the sender/designated port id)
        mm = re.search(r"Designated bridge has priority\s+(\d+),\s*address\s+([0-9a-fA-F.]+)", s, re.I)
        if mm:
            cur["des_bridge_prio"] = int(mm.group(1)); cur["des_bridge_addr"] = mm.group(2).lower()
        mm = re.search(r"Designated bridge\s+address\s+([0-9a-fA-F.]+)\s+priority\s+(\d+)(?:\s+port id\s+([\d.]+))?", s, re.I)
        if mm:
            cur["des_bridge_addr"] = mm.group(1).lower(); cur["des_bridge_prio"] = int(mm.group(2))
            if mm.group(3) is not None:
                cur["des_port_id"] = mm.group(3).rstrip(".")
        # PVST-only lines
        mm = re.search(r"designated path cost\s+(\d+)", s, re.I)
        if mm:
            cur["des_cost"] = int(mm.group(1))
        mm = re.search(r"Designated port id is\s+([\d.]+)", s, re.I)
        if mm:
            cur["des_port_id"] = mm.group(1).rstrip(".")
    return ports


def _pid_tuple(pid):
    try:
        return tuple(int(x) for x in str(pid).split("."))
    except (ValueError, AttributeError):
        return (1 << 31,)


def analyze_stp_why(raw, iface):
    """Explain why `iface` is blocked, by comparing it to this bridge's ROOT port.
    Reports the REAL discriminating tiebreak (root cost > designated bridge ID >
    designated port ID > local port ID) instead of the misleading "a superior
    BPDU arrived" — every BPDU from the root is superior, so on multiple links to
    the root the loser is decided by the designated PORT ID, not the BPDU."""
    ports = parse_stp_detail(raw)
    want = canon_if(iface) if iface else None
    tgt = next((p for p in ports if p["iface"] == want), None) or (ports[0] if ports else None)
    if tgt is None:
        return {"why": None}
    rp = next((p for p in ports if p["role"] == "root"), None)
    blocked = tgt["role"] in ("alternate", "backup") or tgt["state"] in ("blocking", "broken")
    basis, reason = "unknown", None
    if not blocked:
        basis, reason = "not-blocked", ("This port is %s (%s) — it is in the active "
                                        "topology, not blocked." % (tgt["role"], tgt["state"]))
    elif tgt["role"] == "backup":
        basis, reason = "backup", ("Backup port: a second connection to a segment this "
                                   "bridge is ALREADY designated on — it backs up that "
                                   "designated port and stays blocked.")
    elif rp is None:
        reason = "This port is %s; no root port found on this bridge to compare against." % tgt["role"]
    else:
        tcost = (tgt["des_cost"] or 0) + (tgt["port_cost"] or 0)
        rcost = (rp["des_cost"] or 0) + (rp["port_cost"] or 0)
        tbid = (tgt["des_bridge_prio"] if tgt["des_bridge_prio"] is not None else 1 << 31,
                tgt["des_bridge_addr"] or "")
        rbid = (rp["des_bridge_prio"] if rp["des_bridge_prio"] is not None else 1 << 31,
                rp["des_bridge_addr"] or "")
        if tcost != rcost:
            basis = "cost"
            reason = ("Higher cost to the root via this link (%d) than via the root "
                      "port %s (%d) — so this port is Alternate (blocked)."
                      % (tcost, rp["iface"], rcost))
        elif tbid != rbid:
            basis = "bridge-id"
            reason = ("Same root cost, but the root port %s reaches the root through a "
                      "neighbour with a lower bridge ID; this link's upstream bridge "
                      "loses, so this port is Alternate (blocked)." % rp["iface"])
        else:
            basis = "port-id"
            reason = ("Both links reach the same root through the SAME neighbour at "
                      "equal cost — a tie. STP breaks it on the neighbour's "
                      "(designated) port ID: the root port %s received a lower sender "
                      "port-ID (%s) than this port (%s), so %s is the root port and "
                      "this one is Alternate (blocked)."
                      % (rp["iface"], rp.get("des_port_id"), tgt.get("des_port_id"),
                         rp["iface"]))
    return {"why": {
        "role": tgt["role"], "state": tgt["state"],
        "port_cost": tgt["port_cost"], "port_id": tgt["port_id"],
        "des_bridge_prio": tgt["des_bridge_prio"], "des_bridge_addr": tgt["des_bridge_addr"],
        "des_cost": tgt["des_cost"], "des_port_id": tgt.get("des_port_id"),
        "this_cost": (tgt["des_cost"] or 0) + (tgt["port_cost"] or 0),
        "root_port": rp["iface"] if rp else None,
        "root_port_des_port_id": rp.get("des_port_id") if rp else None,
        "root_port_des_bridge_addr": rp.get("des_bridge_addr") if rp else None,
        "root_port_des_bridge_prio": rp.get("des_bridge_prio") if rp else None,
        "root_port_cost": ((rp["des_cost"] or 0) + (rp["port_cost"] or 0)) if rp else None,
        "basis": basis, "reason": reason,
    }}


# `show etherchannel summary` — member interface -> its Port-channel. STP runs on
# the LOGICAL Po, not the members, so a bundled physical link has no per-member
# STP role; we resolve it to the Po's role instead (both members share it).
#   Group  Port-channel  Protocol    Ports
#   1      Po1(SU)         LACP      Et0/2(P)    Et0/3(P)
def parse_etherchannel(raw):
    """-> {member_canon_if: po_canon_if}."""
    out, cur_po = {}, None
    for ln in (raw or "").splitlines():
        m = re.match(r"\s*\d+\s+(Po\d+)\(", ln)
        if m:
            cur_po = canon_if(m.group(1))
        if cur_po:
            for mm in re.finditer(r"([A-Za-z]{2,}[\d/.:]+)\(\w+\)", ln):
                tok = mm.group(1)
                if not tok.lower().startswith("po"):
                    out[canon_if(tok)] = cur_po
    return out


def trace_stp(nodes, adjacencies, stp_by_node, vlan, ec_by_node=None):
    """Map the spanning tree for one VLAN onto the canvas.

    Edge shape: {a,b, a_role,a_state,b_role,b_state, forwarding, blocked,
    transitioning, a_cost,b_cost, a_po,b_po, bundled}. forwarding=both ends FWD
    (green tree); blocked=an Altn/Back/BLK end (red dashed redundant link);
    transitioning=an LIS/LRN end (amber); bundled=a member resolved via its
    Port-channel. `root` = the root-bridge node id."""
    ec_by_node = ec_by_node or {}
    addr2node = {}
    for nid_str, rec in stp_by_node.items():
        if rec.get("bridge_addr"):
            addr2node[rec["bridge_addr"]] = int(nid_str)

    root, root_addr, root_prio = None, None, None
    for nid_str, rec in stp_by_node.items():
        if rec.get("root_addr"):
            root_addr = rec["root_addr"]
            root_prio = rec.get("root_prio")
        if rec.get("is_root"):
            root = int(nid_str)
    if root is None and root_addr:
        root = addr2node.get(root_addr)

    def port(node, iface):
        """STP role for a port; if the physical iface is an EtherChannel member,
        fall back to its Port-channel's role (tagged with `po`)."""
        ports = stp_by_node.get(str(node), {}).get("ports", {})
        p = ports.get(iface)
        if p:
            return p
        po = ec_by_node.get(str(node), {}).get(iface)
        if po and ports.get(po):
            q = dict(ports[po]); q["po"] = po
            return q
        return None

    # ONE edge per physical adjacency (topomap keys by interface, so parallel
    # links between the same switch pair are distinct rows) — STP's whole point is
    # that one of a redundant pair forwards and the other blocks, so we must NOT
    # collapse by node pair. a_if/b_if let the client map each edge to the RIGHT
    # connector. (build_map guarantees a_node < b_node.)
    edges, notes = [], []
    for e in adjacencies:
        A, B = e["a_node"], e["b_node"]
        aif, bif = e.get("a_if", ""), e.get("b_if", "")
        PA, PB = port(A, aif) or {}, port(B, bif) or {}
        a_state, b_state = PA.get("state"), PB.get("state")
        a_role, b_role = PA.get("role"), PB.get("role")
        a_po, b_po = PA.get("po"), PB.get("po")
        trans = a_state in ("LIS", "LRN") or b_state in ("LIS", "LRN")
        fwd = (a_state == "FWD" and b_state == "FWD")
        blocked = (a_state == "BLK" or b_state == "BLK"
                   or a_role in ("Altn", "Back") or b_role in ("Altn", "Back"))
        edges.append({
            "a": A, "b": B, "a_if": aif, "b_if": bif,
            "a_role": a_role, "a_state": a_state,
            "b_role": b_role, "b_state": b_state,
            "forwarding": fwd and not trans,
            "blocked": blocked and not trans,
            "transitioning": trans,
            "a_cost": PA.get("cost"), "b_cost": PB.get("cost"),
            "a_po": a_po, "b_po": b_po, "bundled": bool(a_po or b_po),
        })
    if root is None:
        notes.append("root bridge for VLAN %s is not on this canvas "
                     "(root address %s)" % (vlan, root_addr or "unknown"))
    # Win reason — the classic root election: lowest Bridge ID wins, and the
    # Bridge ID is (priority, MAC), compared priority-first then MAC as the
    # tiebreak. Surface the priority + MAC that made THIS bridge the root so the
    # panel/crown can explain "why this switch won".
    root_reason = None
    if root_prio is not None or root_addr:
        parts = []
        if root_prio is not None:
            parts.append("priority %d" % root_prio)
        if root_addr:
            parts.append("MAC %s" % root_addr)
        root_reason = "Lowest bridge ID" + (" — " + ", ".join(parts) if parts else "")
    return {"vlan": vlan, "root": root, "root_addr": root_addr,
            "root_prio": root_prio, "root_reason": root_reason,
            "edges": edges, "notes": notes,
            "addr2node": {a: n for a, n in addr2node.items()}}


# ── MST (802.1s) ──────────────────────────────────────────────────────────────
# `show spanning-tree mst configuration` — region name, revision, instance->VLANs:
#   Name      [region1]
#   Revision  1     Instances configured 2
#   Instance  Vlans mapped
#   --------  -------------------------------------------------------------------
#   0         2-4094
#   1         1
def parse_mst_config(raw):
    """-> {name, revision, instances:[{instance:int, vlans:str}]}."""
    name, rev, insts = None, None, []
    for ln in (raw or "").splitlines():
        m = re.match(r"\s*Name\s+\[?\s*([^\]\r\n]+?)\s*\]?\s*$", ln)
        if m:
            name = m.group(1).strip()
            continue
        m = re.match(r"\s*Revision\s+(\d+)", ln, re.I)
        if m:
            rev = int(m.group(1))
            continue
        m = re.match(r"\s*(\d+)\s+([\d,\-]+)\s*$", ln)        # instance  vlans
        if m:
            insts.append({"instance": int(m.group(1)), "vlans": m.group(2)})
            continue
        m = re.match(r"\s+([\d,\-]+)\s*$", ln)                # wrapped vlan list
        if m and insts:
            insts[-1]["vlans"] += "," + m.group(1)
    return {"name": name, "revision": rev, "instances": insts}


# `show spanning-tree mst <n>` — one instance's tree (different header style):
#   ##### MST1    vlans mapped:   1
#   Bridge        address aabb.cc00.0200  priority  32769 (32768 sysid 1)
#   Root          this switch for MST1               <- (or)
#   Root          address aabb.cc00.0100  priority  32769 (32768 sysid 1)
#                 port    Et0/1            cost   2000   rem hops 19
#   Interface        Role Sts Cost      Prio.Nbr Type
#   Et0/1            Root FWD 2000      128.1    P2p
_MST_HDR = re.compile(r"#+\s*MST(\d+)\s+vlans mapped:\s*(\S.*)?", re.I)
_MST_BRIDGE = re.compile(r"Bridge\s+address\s+([0-9a-fA-F.]+)\s+priority\s+(\d+)", re.I)
_MST_ROOT_ADDR = re.compile(r"Root\s+address\s+([0-9a-fA-F.]+)\s+priority\s+(\d+)", re.I)


def parse_stp_mst(raw):
    """One `show spanning-tree mst <n>` -> same shape as parse_stp (+ instance,
    vlans) so trace_stp can paint it unchanged."""
    out = {"root_addr": None, "bridge_addr": None, "is_root": False,
           "root_prio": None, "bridge_prio": None, "root_cost": None,
           "instance": None, "vlans": None, "ports": {}}
    for ln in (raw or "").splitlines():
        m = _MST_HDR.search(ln)
        if m:
            out["instance"] = int(m.group(1))
            out["vlans"] = (m.group(2) or "").strip() or None
            continue
        m = _MST_BRIDGE.search(ln)
        if m:
            out["bridge_addr"] = m.group(1).lower(); out["bridge_prio"] = int(m.group(2))
            continue
        m = _MST_ROOT_ADDR.search(ln)
        if m:
            out["root_addr"] = m.group(1).lower(); out["root_prio"] = int(m.group(2))
            continue
        if re.search(r"Root\s+this switch", ln, re.I):
            out["is_root"] = True
            continue
        m = re.search(r"\bcost\s+(\d+)\s+rem hops", ln, re.I)
        if m:
            out["root_cost"] = int(m.group(1))
            continue
        m = _STP_PORT.match(ln.strip())
        if m:
            out["ports"][canon_if(m.group(1))] = {
                "role": m.group(2).title()[:4], "state": m.group(3).upper(),
                "cost": int(m.group(4)) if m.group(4) else None}
    if out["is_root"] and not out["root_addr"]:
        out["root_addr"] = out["bridge_addr"]
    if out["root_addr"] and out["bridge_addr"] and out["root_addr"] == out["bridge_addr"]:
        out["is_root"] = True
    return out


def build_overlay(bundle):
    """Web-tier entry. Dispatches on bundle['proto']:
        ospf  -> SPF tree   (needs ospf_if:{node:raw})
        bgp   -> best-path  (needs prefix + cef:{node:raw `show ip cef <prefix>`})
        eigrp -> successor/FS (needs prefix + eigrp:{node:raw `show ip eigrp
                 topology`} + cef:{node:raw `show ip cef <prefix>`} for the
                 variance-aware forwarding truth)
        eigrp-prefixes -> {prefixes:[{prefix,paths,fd}]} from one node's table
                 (needs topo_raw); used to populate the prefix picker.
    Common inputs: root, nodes:[{id,name}], cdp:{node:raw}, lldp:{node:raw}."""
    proto = bundle.get("proto", "ospf")
    # picker: parse a single node's topology table into a prefix list (no topomap)
    if proto == "eigrp-prefixes":
        topo = parse_eigrp_topology(bundle.get("topo_raw", ""))
        prefixes = [{"prefix": p, "paths": len(e["blocks"]) or e["succ_count"],
                     "fd": e.get("fd")}
                    for p, e in sorted(topo.items())]
        return {"prefixes": prefixes}
    # picker: every prefix in a node's `show ip route` (protocol-agnostic)
    if proto == "route-prefixes":
        return {"prefixes": parse_route_table(bundle.get("topo_raw", ""))}
    # picker: parse one node's `show spanning-tree` into a VLAN list (no topomap)
    if proto == "stp-vlans":
        return {"vlans": parse_stp_vlans(bundle.get("stp_raw", ""))}
    # per-VLAN root comparison: parse every node's `show spanning-tree` (no topomap)
    if proto == "stp-roots":
        nodes0 = bundle.get("nodes", [])
        stp_all = {}
        for nd in nodes0:
            nid = int(nd["id"])
            raw = bundle.get("stp", {}).get(str(nid), bundle.get("stp", {}).get(nid, ""))
            stp_all[str(nid)] = parse_stp_all(raw)
        return {"roots": compare_stp_roots(nodes0, stp_all),
                "names": {str(int(n["id"])): n.get("name", "") for n in nodes0}}
    # why a port blocks: analyze `show spanning-tree … detail` vs the root port
    if proto == "stp-why":
        return analyze_stp_why(bundle.get("why_raw", ""), bundle.get("iface"))
    # MST instance picker: parse one node's `show spanning-tree mst configuration`
    if proto == "mst-instances":
        cfg = parse_mst_config(bundle.get("mst_raw", ""))
        return {"region": cfg["name"], "revision": cfg["revision"],
                "instances": cfg["instances"]}
    nodes = bundle.get("nodes", [])
    topo = pnet_topomap.build_map(nodes, bundle.get("cdp", {}),
                                  bundle.get("lldp", {}))
    if proto == "ospf":
        if_cost = {}
        for nd in nodes:
            nid = int(nd["id"])
            raw = bundle.get("ospf_if", {}).get(str(nid),
                                                bundle.get("ospf_if", {}).get(nid, ""))
            if_cost[nid] = parse_ospf_if_brief(raw)
        res = spf_tree(nodes, topo["adjacencies"], if_cost, bundle.get("root"))
        # Truth-source guard (F1): if the root's `show ip route ospf` was read,
        # cross-check the computed first hops against the router's real OSPF RIB.
        res = annotate_ospf_rib(res, topo["adjacencies"], bundle.get("root"),
                                parse_ospf_rib(bundle.get("ospf_rib", "")))
    elif proto in ("bgp", "route"):
        # Protocol-agnostic forwarding trace (the "route" proto and the BGP map
        # share it — the trace follows the FIB, not BGP attributes). NX-OS
        # recursive next-hops are resolved to their owning node via each node's
        # interface-IP map (`show ip interface brief`); IOS uses CEF's egress
        # interface and ignores this.
        ip2node = {}
        for nd in nodes:
            nid = int(nd["id"])
            ipraw = bundle.get("ipbrief", {}).get(str(nid),
                                                  bundle.get("ipbrief", {}).get(nid, ""))
            for _if, ip in parse_ip_brief(ipraw):
                ip2node.setdefault(ip, nid)
        res = trace_bgp(nodes, topo["adjacencies"], bundle.get("cef", {}),
                        bundle.get("prefix", ""), bundle.get("root"),
                        bundle.get("nos", {}), ip2node)
    elif proto == "eigrp":
        eig, ip2node = {}, {}
        for nd in nodes:
            nid = int(nd["id"])
            raw = bundle.get("eigrp", {}).get(str(nid),
                                              bundle.get("eigrp", {}).get(nid, ""))
            eig[str(nid)] = parse_eigrp_topology(raw)
            # map every IP this node owns -> the node (resolves tunnel next-hops)
            ipraw = bundle.get("ipbrief", {}).get(str(nid),
                                                  bundle.get("ipbrief", {}).get(nid, ""))
            for _if, ip in parse_ip_brief(ipraw):
                ip2node.setdefault(ip, nid)
        res = trace_eigrp(nodes, topo["adjacencies"], eig, bundle.get("cef", {}),
                          bundle.get("prefix", ""), bundle.get("root"), ip2node)
    elif proto == "stp":
        stp, ec = {}, {}
        for nd in nodes:
            nid = int(nd["id"])
            raw = bundle.get("stp", {}).get(str(nid),
                                            bundle.get("stp", {}).get(nid, ""))
            stp[str(nid)] = parse_stp(raw)
            ecraw = bundle.get("ec", {}).get(str(nid), bundle.get("ec", {}).get(nid, ""))
            ec[str(nid)] = parse_etherchannel(ecraw)
        res = trace_stp(nodes, topo["adjacencies"], stp, bundle.get("vlan", ""), ec)
    elif proto == "mst":
        stp, ec = {}, {}
        for nd in nodes:
            nid = int(nd["id"])
            stp[str(nid)] = parse_stp_mst(bundle.get("stp", {}).get(str(nid),
                                          bundle.get("stp", {}).get(nid, "")))
            ec[str(nid)] = parse_etherchannel(bundle.get("ec", {}).get(str(nid),
                                              bundle.get("ec", {}).get(nid, "")))
        inst = bundle.get("mst_inst", "")
        res = trace_stp(nodes, topo["adjacencies"], stp, inst, ec)
        res["mst"] = True
        res["instance"] = inst
        cfg = parse_mst_config(bundle.get("mst_cfg", ""))
        res["region"] = cfg["name"]
        res["revision"] = cfg["revision"]
        for s in stp.values():
            if s.get("vlans"):
                res["vlans_mapped"] = s["vlans"]
                break
    else:
        return {"error": "unsupported proto: %s" % proto,
                "adjacencies": topo["adjacencies"]}
    res["proto"] = proto
    res["adjacencies"] = topo["adjacencies"]
    res["warnings"] = topo["warnings"] + res.pop("notes", [])
    res["names"] = {str(int(n["id"])): n.get("name", "") for n in nodes}
    # any free-text warning that still says "node <id>" -> use the node name
    _nm = res["names"]
    res["warnings"] = [re.sub(r"node (\d+)",
                              lambda m: _nm.get(m.group(1), m.group(0)), w)
                       for w in res["warnings"]]
    return res


# ── self-test: square + diagonal => an ECMP destination ───────────────────────
def _ifb(pairs):
    """tiny helper: build a `show ip ospf interface brief` text from
    [(iface, cost)] or [(iface, cost, nbrs)] so the parser is exercised, not
    bypassed. nbrs (the F/C column) defaults to "1/1" (one adjacency)."""
    head = "Interface    PID   Area   IP Address/Mask   Cost  State Nbrs F/C\n"
    body = ""
    for row in pairs:
        i, c = row[0], row[1]
        nbrs = row[2] if len(row) > 2 else "1/1"
        body += "%-12s 1     0      10.0.0.1/24       %-5d P2P   %s\n" % (i, c, nbrs)
    return head + body


def _selftest():
    # Topology (square + long diagonal):
    #   R1-R2 (10), R1-R3 (10), R2-R4 (10), R3-R4 (10), R1-R4 (30 direct)
    # From R1 to R4: R1-R2-R4 = 20 and R1-R3-R4 = 20 (ECMP), both beat 30.
    nodes = [{"id": i, "name": "R%d" % i} for i in (1, 2, 3, 4)]
    adjacencies = [
        {"a_node": 1, "a_if": "Gi0/1", "b_node": 2, "b_if": "Gi0/1"},
        {"a_node": 1, "a_if": "Gi0/2", "b_node": 3, "b_if": "Gi0/1"},
        {"a_node": 2, "a_if": "Gi0/2", "b_node": 4, "b_if": "Gi0/1"},
        {"a_node": 3, "a_if": "Gi0/2", "b_node": 4, "b_if": "Gi0/2"},
        {"a_node": 1, "a_if": "Gi0/3", "b_node": 4, "b_if": "Gi0/3"},
    ]
    if_cost = {
        1: parse_ospf_if_brief(_ifb([("Gi0/1", 10), ("Gi0/2", 10), ("Gi0/3", 30)])),
        2: parse_ospf_if_brief(_ifb([("Gi0/1", 10), ("Gi0/2", 10)])),
        3: parse_ospf_if_brief(_ifb([("Gi0/1", 10), ("Gi0/2", 10)])),
        4: parse_ospf_if_brief(_ifb([("Gi0/1", 10), ("Gi0/2", 10), ("Gi0/3", 30)])),
    }
    spf = spf_tree(nodes, adjacencies, if_cost, root=1)
    edge = {(e["a"], e["b"]): e for e in spf["edges"]}
    ok = True

    def check(c, label):
        nonlocal ok
        print(("  ok  " if c else "  FAIL") + " " + label)
        ok = ok and c

    check(parse_ospf_if_brief(_ifb([("GigabitEthernet0/1", 10)])).get("Gi0/1",
          {}).get("cost") == 10, "if-brief parser reads cost + canon interface")
    # NX-OS layout: no IP/Mask column, dotted area, cost one column left, "Eth"
    _nxob = (" OSPF Process ID 1 VRF default\n Total number of interface: 1\n"
             " Interface               ID     Area            Cost   State"
             "    Neighbors Status\n"
             " Eth1/3                  1      0.0.0.0         40     DROTHER"
             "  3         up\n")
    check(parse_ospf_if_brief(_nxob).get("Et1/3", {}).get("cost") == 40,
          "if-brief parser reads NX-OS layout (Eth1/3 cost 40, no IP/Mask col)")
    # OSPF over a transit L2 switch (no OSPF on the switch): NXOS1 -- SW3 -- R5/R6
    # on one segment. The SPF tree must form across the switch.
    swadj = [{"a_node": 1, "a_if": "Et1/3", "b_node": 9, "b_if": "Et0/0"},
             {"a_node": 5, "a_if": "Et0/0", "b_node": 9, "b_if": "Et0/2"},
             {"a_node": 6, "a_if": "Et0/0", "b_node": 9, "b_if": "Et0/3"}]
    swcost = {1: parse_ospf_if_brief(_ifb([("Et1/3", 40)])),
              5: parse_ospf_if_brief(_ifb([("Et0/0", 1)])),
              6: parse_ospf_if_brief(_ifb([("Et0/0", 1)]))}   # node 9 = no OSPF
    swspf = spf_tree([{"id": 1}, {"id": 5}, {"id": 6}, {"id": 9}],
                     swadj, swcost, root=1)
    swe = {(e["a"], e["b"]): e for e in swspf["edges"]}
    check(swe[(1, 9)]["in_tree"] and swe[(5, 9)]["in_tree"]
          and swe[(6, 9)]["in_tree"],
          "OSPF over transit switch: NXOS1<->SW3<->R5/R6 legs in the SPF tree")
    check(swspf["dist"]["5"] == 40 and swspf["dist"]["6"] == 40,
          "OSPF over switch: R5/R6 reached at NXOS1's egress cost (40) via segment")
    check(spf["dist"]["4"] == 20, "R4 distance = 20 (via R2 or R3, not direct 30)")
    check(edge[(1, 2)]["in_tree"] and edge[(1, 3)]["in_tree"],
          "R1-R2 and R1-R3 both in SPF tree")
    check(edge[(2, 4)]["in_tree"] and edge[(3, 4)]["in_tree"]
          and edge[(2, 4)]["ecmp"] and edge[(3, 4)]["ecmp"],
          "R4 reached by ECMP (both R2-R4 and R3-R4 in tree, flagged ecmp)")
    check(not edge[(1, 4)]["in_tree"], "direct R1-R4 (cost 30) NOT in tree")
    check(edge[(1, 2)]["dir"] == "a2b", "tree direction recorded (R1->R2 = a2b)")
    check(edge[(1, 2)]["cost_ab"] == 10 and edge[(1, 2)]["cost_ba"] == 10,
          "both directed costs present on an edge")
    # asymmetric-cost check: make R3->R1 expensive; root R3 should avoid R1 direct
    if_cost[3] = parse_ospf_if_brief(_ifb([("Gi0/1", 100), ("Gi0/2", 10)]))
    spf3 = spf_tree(nodes, adjacencies, if_cost, root=3)
    e3 = {(e["a"], e["b"]): e for e in spf3["edges"]}
    check(not e3[(1, 3)]["in_tree"],
          "asymmetric: from R3, expensive R3->R1 (100) dropped from tree")
    check(spf3["dist"]["1"] == 30, "from R3, R1 reached at 30 (R3-R4-R2-R1)")
    check(len(spf["unreachable"]) == 0, "no unreachable nodes in connected graph")

    # degradation: a link with NO OSPF cost on either end still renders as a
    # discovered-topology edge (in_tree False, cost None) — not dropped.
    noospf = spf_tree([{"id": 1, "name": "A"}, {"id": 2, "name": "B"}],
                      [{"a_node": 1, "a_if": "Gi0/0", "b_node": 2, "b_if": "Gi0/0"}],
                      {1: {}, 2: {}}, root=1)
    check(len(noospf["edges"]) == 1 and not noospf["edges"][0]["in_tree"]
          and noospf["edges"][0]["cost_ab"] is None,
          "no-OSPF link still emitted as a topology edge (in_tree False, cost None)")

    # ── honesty guard (F1): OSPF cost present but 0 adjacencies -> not a SPF path ──
    gapadj = [{"a_node": 1, "a_if": "Gi0/0", "b_node": 2, "b_if": "Gi0/0"}]
    gapcost = {                       # R1 has a neighbour; R2's side is 0/0 (no adj)
        1: parse_ospf_if_brief(_ifb([("Gi0/0", 10)])),
        2: parse_ospf_if_brief(_ifb([("Gi0/0", 10, "0/0")])),
    }
    gap = spf_tree([{"id": 1, "name": "A"}, {"id": 2, "name": "B"}],
                   gapadj, gapcost, root=1)
    check(_if_has_adj(parse_ospf_if_brief(_ifb([("Gi0/0", 10, "0/0")]))["Gi0/0"])
          is False and _if_has_adj(parse_ospf_if_brief(_ifb([("Gi0/0", 10)]))
                                   ["Gi0/0"]) is True,
          "adjacency guard: 0/0 -> no adjacency, 1/1 -> adjacency")
    check(not gap["edges"][0]["in_tree"] and gap["dist"]["2"] is None,
          "0-adjacency link excluded from SPF (edge not in tree, node unreachable)")
    check(any("0 adjacencies" in w for w in gap["notes"]),
          "0-adjacency link produces an explanatory note")
    # NX-OS neighbour count is a plain integer (not F/C): 0 -> no adjacency
    check(_if_has_adj({"cost": 40, "nbrs": "0"}) is False
          and _if_has_adj({"cost": 40, "nbrs": "3"}) is True,
          "adjacency guard: NX-OS plain-integer neighbour count honoured")

    # ── truth-source guard (F4): SPF first hop vs the root's real OSPF RIB ────────
    rib_ios = ("O    2.2.2.2/32 [110/11] via 10.12.0.2, 00:05:00, GigabitEthernet0/1\n"
               "O IA 4.4.4.0/24 [110/30] via 10.12.0.2, 00:05:00, GigabitEthernet0/1\n"
               "                         [110/30] via 10.13.0.3, 00:05:00, GigabitEthernet0/2\n")
    prib = parse_ospf_rib(rib_ios)
    check(prib["routes"] == 2 and prib["egress"] == {"Gi0/1", "Gi0/2"}
          and "10.13.0.3" in prib["nexthops"],
          "OSPF RIB parser (IOS): routes, ECMP-continuation egress + next-hops")
    rib_nx = ('IP Route Table for VRF "default"\n'
              "2.2.2.2/32, ubest/mbest: 1/0\n"
              "    *via 10.12.0.2, Eth1/1, [110/11], 00:05:00, ospf-1, intra\n")
    pribx = parse_ospf_rib(rib_nx)
    check(pribx["routes"] == 1 and pribx["egress"] == {"Et1/1"},
          "OSPF RIB parser (NX-OS): *via egress interface")
    # Tree R1->R2 out Gi0/1 (in RIB) is OK; a fabricated R1->R3 out Gi0/2 that the
    # RIB never uses is flagged rib_diverge.
    ta = [{"a_node": 1, "a_if": "Gi0/1", "b_node": 2, "b_if": "Gi0/1"},
          {"a_node": 1, "a_if": "Gi0/2", "b_node": 3, "b_if": "Gi0/1"}]
    tres = {"root": 1, "edges": [
        {"a": 1, "b": 2, "in_tree": True}, {"a": 1, "b": 3, "in_tree": True}]}
    ribonly = {"egress": {"Gi0/1"}, "nexthops": {"10.12.0.2"}, "routes": 1}
    annotate_ospf_rib(tres, ta, 1, ribonly)
    te = {(e["a"], e["b"]): e for e in tres["edges"]}
    check(te[(1, 2)].get("rib_ok") is True and te[(1, 3)].get("rib_diverge") is True,
          "RIB guard: Gi0/1 hop confirmed, fabricated Gi0/2 hop flagged diverging")
    check(any("diverges from the router" in w for w in tres.get("notes", [])),
          "RIB guard: divergence produces a warning note")
    # empty RIB -> can't verify -> nothing flagged
    tres2 = {"root": 1, "edges": [{"a": 1, "b": 2, "in_tree": True}]}
    annotate_ospf_rib(tres2, ta, 1, {"egress": set(), "nexthops": set(), "routes": 0})
    check(tres2["rib_checked"] is False
          and "rib_diverge" not in tres2["edges"][0],
          "RIB guard: empty RIB is not checked (no false positives)")

    # ── BGP best-path trace: diamond R1-{R2,R4}-R3, prefix on R3 (ECMP from R1) ──
    bnodes = [{"id": i, "name": "R%d" % i} for i in (1, 2, 3, 4)]
    badj = [
        {"a_node": 1, "a_if": "Et0/0", "b_node": 2, "b_if": "Et0/0"},
        {"a_node": 1, "a_if": "Et0/1", "b_node": 4, "b_if": "Et0/0"},
        {"a_node": 2, "a_if": "Et0/1", "b_node": 3, "b_if": "Et0/0"},
        {"a_node": 3, "a_if": "Et0/1", "b_node": 4, "b_if": "Et0/1"},
    ]

    def _cef(lines):
        return "\n".join(["3.3.3.3/32"] + ["  " + l for l in lines])
    cef = {
        "1": _cef(["nexthop 12.1.1.2 Ethernet0/0", "nexthop 14.1.1.4 Ethernet0/1"]),
        "2": _cef(["nexthop 23.1.1.3 Ethernet0/1"]),
        "4": _cef(["nexthop 34.1.1.3 Ethernet0/1"]),
        "3": _cef(["receive for Loopback0"]),
    }
    bt = trace_bgp(bnodes, badj, cef, "3.3.3.3/32", root=1)
    be = {(e["a"], e["b"]): e for e in bt["edges"]}
    check(be[(1, 2)]["in_path"] and be[(1, 4)]["in_path"]
          and be[(2, 3)]["in_path"] and be[(3, 4)]["in_path"],
          "BGP: full forwarding path (all 4 diamond links) lit")
    check(be[(1, 2)]["ecmp"] and be[(1, 4)]["ecmp"]
          and not be[(2, 3)]["ecmp"], "BGP: R1's two equal next-hops flagged ECMP")
    check(be[(1, 2)]["order"] == 0 and be[(2, 3)]["order"] == 1,
          "BGP: hop order recorded along the path")
    check(bt["origin"] == [3], "BGP: origin = R3 (CEF receive)")
    check(parse_cef("1.1.1.0/24\n  attached to Ethernet0/0")["attached"] == ["Et0/0"],
          "CEF parser reads 'attached to' (connected egress)")
    # a prefix only on R3's side: from R2, single path R2->R3, R1/R4 not on it
    bt2 = trace_bgp(bnodes, badj, {"2": _cef(["nexthop 23.1.1.3 Ethernet0/1"]),
                                   "3": _cef(["receive"])}, "3.3.3.3/32", root=2)
    be2 = {(e["a"], e["b"]): e for e in bt2["edges"]}
    check(be2[(2, 3)]["in_path"] and not be2[(1, 2)]["in_path"]
          and not be2[(1, 4)]["in_path"], "BGP: from R2 only the R2-R3 hop is lit")

    # ── NX-OS BGP route trace (no `show ip cef`; recursive nh -> ip2node) ──────
    def _nxr(lines):
        return "\n".join(['IP Route Table for VRF "default"', ""]
                         + ["    " + l for l in lines])
    nxadj = [
        {"a_node": 1, "a_if": "Et1/1", "b_node": 2, "b_if": "Et1/1"},
        {"a_node": 2, "a_if": "Et1/2", "b_node": 3, "b_if": "Et1/1"},
    ]
    nxnodes = [{"id": 1, "name": "N1"}, {"id": 2, "name": "N2"}, {"id": 3, "name": "N3"}]
    nxcef = {
        "1": _nxr(["*via 10.12.0.2, [20/0], 00:01, bgp-1, external, tag 2"]),
        "2": _nxr(["*via 10.23.0.3, [20/0], 00:01, bgp-1, external, tag 2"]),
        "3": _nxr(["*via 1.1.1.1, Lo0, [0/0], 00:05, local"]),
    }
    nxnos = {"1": "nxos", "2": "nxos", "3": "nxos"}
    nxip2 = {"10.12.0.2": 2, "10.23.0.3": 3}     # owning-node map (from ipbrief)
    nbt = trace_bgp(nxnodes, nxadj, nxcef, "1.1.1.1/32", root=1,
                    nos_by_node=nxnos, ip2node=nxip2)
    nbe = {(e["a"], e["b"]): e for e in nbt["edges"]}
    check(nbe[(1, 2)]["in_path"] and nbe[(2, 3)]["in_path"],
          "NX-OS BGP route trace: recursive next-hops resolved via ip2node R1->R2->R3")
    check(nbt["origin"] == [3], "NX-OS BGP: origin = R3 (local route)")
    check(parse_route(_nxr(["*via 10.0.0.3, Eth1/3, [0/0], 00:14, direct"]))
          ["attached"] == ["Et1/3"],
          "parse_route: 'direct' via with iface -> attached (connected egress)")
    pr = parse_route(_nxr(["*via 10.0.0.5, [20/0], 00:01, bgp-1, external"]))
    check(pr["nexthops"] and pr["nexthops"][0]["ip"] == "10.0.0.5"
          and pr["nexthops"][0]["iface"] is None,
          "parse_route: recursive bgp via -> next-hop IP, no iface")
    check(parse_route(_nxr([" via 10.0.0.9, [200/0], bgp-1"]))["nexthops"] == [],
          "parse_route: non-best (no *) via is ignored")
    # next-hop reached THROUGH an L2 switch: router -> switch -> next-hop owner.
    # The recursive next-hop resolves to R6, which sits behind SW3 (not directly
    # adjacent), so both switched legs must light.
    swadj = [{"a_node": 1, "a_if": "Et1/3", "b_node": 9, "b_if": "Et0/0"},
             {"a_node": 9, "a_if": "Et0/3", "b_node": 6, "b_if": "Et0/0"}]
    swnodes = [{"id": 1, "name": "NXOS1"}, {"id": 9, "name": "SW3"},
               {"id": 6, "name": "R6"}]
    swcef = {"1": _nxr(["*via 10.0.0.5, [20/0], 00:01, bgp-1, external"]),
             "6": "1.1.1.1/32\n  receive for Loopback0"}
    sbt = trace_bgp(swnodes, swadj, swcef, "1.1.1.1/32", root=1,
                    nos_by_node={"1": "nxos", "6": "ios", "9": "ios"},
                    ip2node={"10.0.0.5": 6})
    sbe = {(e["a"], e["b"]): e for e in sbt["edges"]}
    check(sbe[(1, 9)]["in_path"] and sbe[(6, 9)]["in_path"],
          "BGP via L2 switch: NXOS1->SW3->R6 both legs lit (transit switch pathed)")
    check(sbt["origin"] == [6], "BGP via switch: origin = R6 behind the switch")

    # ── protocol-agnostic route-table picker (IOS + NX-OS) ────────────────────
    nxrt = ('IP Route Table for VRF "default"\n'
            '8.8.8.8/32, ubest/mbest: 2/0\n'
            '    *via 10.0.0.4, Eth1/3, [110/41], 00:51, ospf-1, intra\n'
            '    *via 10.0.0.5, Eth1/3, [110/41], 00:52, ospf-1, intra\n'
            '10.0.0.0/24, ubest/mbest: 1/0, attached\n'
            '    *via 10.0.0.3, Eth1/3, [0/0], 00:53, direct\n')
    rtp = {r["prefix"]: r for r in parse_route_table(nxrt)}
    check(rtp.get("8.8.8.8/32", {}).get("proto") == "ospf-1",
          "route picker (NX-OS): 8.8.8.8/32 listed via ospf-1")
    check(rtp.get("10.0.0.0/24", {}).get("proto") == "direct",
          "route picker (NX-OS): connected prefix listed")
    iosrt = ("Gateway of last resort is not set\n"
             "      8.0.0.0/32 is subnetted, 1 subnets\n"
             "O        8.8.8.8 [110/41] via 10.0.0.4, 00:51:57, Ethernet0/0\n"
             "B     1.1.1.1/32 [20/0] via 10.0.0.5, 00:10:00\n"
             "C        10.0.0.0/24 is directly connected, Ethernet0/0\n")
    rti = {r["prefix"]: r for r in parse_route_table(iosrt)}
    check(rti.get("8.8.8.8", {}).get("proto") == "O"
          and "1.1.1.1/32" in rti and "10.0.0.0/24" in rti,
          "route picker (IOS): O/B/C prefixes all listed (mixed protocols)")

    # ── EIGRP successor/FS: diamond R1->{R2 succ, R3 FS}->R4 (connected origin) ──
    enodes = [{"id": i, "name": "R%d" % i} for i in (1, 2, 3, 4, 5)]
    eadj = [
        {"a_node": 1, "a_if": "Gi0/1", "b_node": 2, "b_if": "Gi0/1"},
        {"a_node": 1, "a_if": "Gi0/2", "b_node": 3, "b_if": "Gi0/1"},
        {"a_node": 1, "a_if": "Gi0/4", "b_node": 5, "b_if": "Gi0/1"},
        {"a_node": 2, "a_if": "Gi0/2", "b_node": 4, "b_if": "Gi0/1"},
        {"a_node": 3, "a_if": "Gi0/2", "b_node": 4, "b_if": "Gi0/2"},
    ]
    P = "9.9.9.0/24"

    def _etop(prefix, succ_n, fd, vias):
        """build a `show ip eigrp topology` table entry; vias=[(nh,td,rd,iface)]
        with nh='Connected' (or an ip) — exercises the real parser."""
        head = "P %s, %d successors, FD is %d\n" % (prefix, succ_n, fd)
        body = ""
        for nh, td, rd, iface in vias:
            if nh in ("Connected", "Redistributed"):
                body += "        via %s, %s\n" % (nh, iface)
            else:
                body += "        via %s (%d/%d), %s\n" % (nh, td, rd, iface)
        return head + body
    # Topology table is the SAME regardless of variance (variance changes the FIB,
    # not the DUAL classification): R2 successor (TD 200==FD), R3 feasible (TD 300,
    # RD 100<200), R5 fails feasibility (RD 250 !< 200), R4 owns the prefix.
    eig = {
        "1": parse_eigrp_topology(_etop(P, 1, 200, [
            ("10.1.2.2", 200, 100, "Gi0/1"),
            ("10.1.3.3", 300, 100, "Gi0/2"),
            ("10.1.5.5", 400, 250, "Gi0/4")])),
        "2": parse_eigrp_topology(_etop(P, 1, 100, [("10.2.4.4", 100, 0, "Gi0/2")])),
        "3": parse_eigrp_topology(_etop(P, 1, 100, [("10.3.4.4", 100, 0, "Gi0/2")])),
        "4": parse_eigrp_topology(_etop(P, 1, 1, [("Connected", 0, 0, "Gi0/3")])),
    }

    def _ecef(prefix, hops):     # hops=[(nh_ip, iface)] -> a `show ip cef` body
        return "\n".join([prefix] + ["  nexthop %s %s" % (ip, i) for ip, i in hops])

    # ── variance OFF: FIB has only the successor (R2); R3 stays a dashed backup ──
    cef_novar = {
        "1": _ecef(P, [("10.1.2.2", "Gi0/1")]),
        "2": _ecef(P, [("10.2.4.4", "Gi0/2")]),
        "4": P + "\n  attached to Gi0/3",
    }
    et = trace_eigrp(enodes, eadj, eig, cef_novar, P, root=1)
    ee = {(e["a"], e["b"]): e for e in et["edges"]}
    check(ee[(1, 2)]["forwarding"] and ee[(1, 2)]["role"] == "S"
          and not ee[(1, 2)]["lb"], "EIGRP: R1->R2 successor forwards (solid 'S')")
    check(ee[(1, 3)]["backup"] and not ee[(1, 3)]["forwarding"]
          and ee[(1, 3)]["role"] == "FS",
          "EIGRP: R1->R3 feasible successor is a dashed backup (variance off)")
    check(not ee[(1, 5)]["forwarding"] and not ee[(1, 5)]["backup"]
          and ee[(1, 5)]["infeasible"] and ee[(1, 5)]["role"] == "X",
          "EIGRP: R1->R5 fails feasibility — drawn infeasible (red), role 'X'")
    check(ee[(1, 5)]["rd"] == 250 and ee[(1, 5)]["fd"] == 200,
          "EIGRP: infeasible link carries RD(250) >= FD(200) for the label")
    check(ee[(2, 4)]["forwarding"], "EIGRP: forwarding path chains R2->R4")
    check(not ee[(3, 4)]["forwarding"] and not ee[(3, 4)]["backup"],
          "EIGRP: backup branch is NOT walked (R3->R4 stays off-path)")
    check(et["origin"] == [4], "EIGRP: origin = R4 (CEF attached + Connected)")
    check(ee[(1, 2)]["order"] == 0 and ee[(2, 4)]["order"] == 1,
          "EIGRP: forwarding hop order recorded along the path")
    check(ee[(1, 2)]["metric"] == 200 and ee[(1, 3)]["metric"] == 300
          and ee[(1, 2)]["dir"] == "a2b",
          "EIGRP: both successor (FD) and FS (TD) carry a metric + direction")
    check(not et["loadbalance"], "EIGRP: single path => not load-balancing")

    # ── variance ON: FIB load-balances over R2 (S) AND R3 (FS); R4 still excluded
    #    by feasibility (its metric is within variance but RD>=FD, so not in CEF) ──
    cef_var = {
        "1": _ecef(P, [("10.1.2.2", "Gi0/1"), ("10.1.3.3", "Gi0/2")]),
        "2": _ecef(P, [("10.2.4.4", "Gi0/2")]),
        "3": _ecef(P, [("10.3.4.4", "Gi0/2")]),
        "4": P + "\n  attached to Gi0/3",
    }
    etv = trace_eigrp(enodes, eadj, eig, cef_var, P, root=1)
    eev = {(e["a"], e["b"]): e for e in etv["edges"]}
    check(eev[(1, 2)]["forwarding"] and eev[(1, 2)]["role"] == "S"
          and eev[(1, 2)]["lb"],
          "EIGRP variance: R1->R2 successor forwards + flagged load-balancing")
    check(eev[(1, 3)]["forwarding"] and not eev[(1, 3)]["backup"]
          and eev[(1, 3)]["role"] == "FS" and eev[(1, 3)]["lb"],
          "EIGRP variance: R1->R3 feasible successor is now an ACTIVE solid path")
    check(eev[(1, 3)]["metric"] == 300,
          "EIGRP variance: the active FS link still shows its TD metric")
    check(eev[(2, 4)]["forwarding"] and eev[(3, 4)]["forwarding"],
          "EIGRP variance: both load-balanced branches walked to origin R4")
    check(not eev[(1, 5)]["forwarding"] and not eev[(1, 5)]["backup"]
          and eev[(1, 5)]["infeasible"],
          "EIGRP variance: R5-via still excluded as infeasible (feasibility "
          "beats variance)")
    check(etv["loadbalance"], "EIGRP variance: load-balancing flagged on result")

    # ── no CEF on any node: fall back to topology successors (pre-variance view) ──
    etf = trace_eigrp(enodes, eadj, eig, {}, P, root=1)
    eef = {(e["a"], e["b"]): e for e in etf["edges"]}
    check(eef[(1, 2)]["forwarding"] and eef[(1, 3)]["backup"],
          "EIGRP: no-CEF fallback uses topology successor (R2 solid, R3 dashed)")

    # parser detail: header FD + via TD/RD + Connected/Redistributed origin flag
    top = parse_eigrp_topology(_etop(P, 1, 2816, [("Redistributed", 0, 0, "")]))
    check(top[P]["connected"] and top[P]["fd"] == 2816,
          "EIGRP parser: reads FD + flags Redistributed as origin")
    # picker: build_overlay eigrp-prefixes lists the table's prefixes
    pick = build_overlay({"proto": "eigrp-prefixes",
                          "topo_raw": _etop(P, 1, 200,
                                            [("10.1.2.2", 200, 100, "Gi0/1")])})
    check(pick["prefixes"] and pick["prefixes"][0]["prefix"] == P
          and pick["prefixes"][0]["fd"] == 200,
          "EIGRP picker: build_overlay('eigrp-prefixes') lists prefix + FD")

    # ── _iface_kind: classify off-canvas exit interfaces ──────────────────────
    check(_iface_kind("Tu100") == "tunnel" and _iface_kind("Lo0") == "loopback"
          and _iface_kind("Null0") == "null" and _iface_kind("Vl10") == "vlan"
          and _iface_kind("Po1") == "portchannel"
          and _iface_kind("Gi0/1") == "physical",
          "EIGRP: _iface_kind classifies tunnel/loopback/null/vlan/po/physical")

    # ── off-canvas successor: R1's successor exits a DMVPN Tunnel (no CDP peer) ──
    # Only R1<->R3 is a real canvas link here; R1's CEF forwards out Tu100 to a
    # hub that isn't drawn -> no forwarding link, but a structured offcanvas entry.
    onodes = [{"id": i, "name": "R%d" % i} for i in (1, 3)]
    oadj = [{"a_node": 1, "a_if": "Gi0/2", "b_node": 3, "b_if": "Gi0/1"}]
    oeig = {"1": parse_eigrp_topology(_etop(P, 1, 200, [
        ("172.16.0.5", 200, 100, "Tu100")]))}
    ocef = {"1": _ecef(P, [("172.16.0.5", "Tu100")])}
    ot = trace_eigrp(onodes, oadj, oeig, ocef, P, root=1)
    check(len(ot["offcanvas"]) == 1
          and ot["offcanvas"][0]["kind"] == "tunnel"
          and ot["offcanvas"][0]["iface"] == "Tu100"
          and ot["offcanvas"][0]["nexthop"] == "172.16.0.5"
          and ot["offcanvas"][0]["role"] == "S",
          "EIGRP: tunnel/off-canvas successor reported in offcanvas (kind+nh+role)")
    check(not any(e["forwarding"] for e in ot["edges"]),
          "EIGRP: off-canvas successor draws no phantom forwarding link")
    # DMVPN multipoint: two NHRP next-hops out one Tunnel -> two offcanvas rows
    odm = trace_eigrp(onodes, oadj, {}, {"1": _ecef(P, [
        ("10.1.1.3", "Tu100"), ("10.1.1.4", "Tu100")])}, P, root=1)
    nhs = sorted(o["nexthop"] for o in odm["offcanvas"])
    check(len(odm["offcanvas"]) == 2 and nhs == ["10.1.1.3", "10.1.1.4"],
          "EIGRP: DMVPN multipoint (2 next-hops, 1 tunnel) yields 2 offcanvas rows")
    # ip2node: resolve each tunnel next-hop IP to the canvas node that OWNS it,
    # so the client can draw a virtual link (R1 ->tunnel-> R3) even with no CDP.
    onodes2 = [{"id": i, "name": "R%d" % i} for i in (1, 3, 4)]
    ip2node = {"10.1.1.3": 3, "10.1.1.4": 4, "10.1.1.1": 1}  # R3/R4 tunnel IPs
    odr = trace_eigrp(onodes2, oadj, {}, {"1": _ecef(P, [
        ("10.1.1.3", "Tu100"), ("10.1.1.4", "Tu100")])}, P, root=1,
        ip2node=ip2node)
    peers = sorted(o["peer"] for o in odr["offcanvas"])
    check(peers == [3, 4],
          "EIGRP: off-canvas next-hop IPs resolve to owning nodes (R3, R4)")
    check(parse_ip_brief(
        "Interface IP-Address OK?\nTunnel100 10.1.1.1 YES up up\n"
        "GigabitEthernet0/1 unassigned YES up up") == [("Tu100", "10.1.1.1")],
        "parse_ip_brief: reads assigned IP, skips 'unassigned' + header")

    # ── STP port roles: triangle SW1(root)-SW2-SW3, SW2-SW3 redundant blocked ──
    snodes = [{"id": i, "name": "SW%d" % i} for i in (1, 2, 3)]
    sadj = [
        {"a_node": 1, "a_if": "Gi0/1", "b_node": 2, "b_if": "Gi0/1"},
        {"a_node": 2, "a_if": "Gi0/2", "b_node": 3, "b_if": "Gi0/1"},
        {"a_node": 1, "a_if": "Gi0/2", "b_node": 3, "b_if": "Gi0/2"},
    ]
    RA = "aaaa.0000.0001"

    def _stp(root_addr, root_prio, br_addr, br_prio, is_root, ports):
        """build a `show spanning-tree vlan 10` body; ports=[(iface,role,state,cost)]"""
        L = ["VLAN0010", "  Spanning tree enabled protocol rstp",
             "  Root ID    Priority    %d" % root_prio,
             "             Address     %s" % root_addr]
        if is_root:
            L.append("             This bridge is the root")
        L += ["  Bridge ID  Priority    %d  (priority %d sys-id-ext 10)"
              % (br_prio, br_prio - 10),
              "             Address     %s" % br_addr,
              "  Interface           Role Sts Cost      Prio.Nbr Type",
              "  ------------------- ---- --- --------- -------- ----"]
        for iface, role, state, cost in ports:
            L.append("  %-19s %-4s %-3s %-9d 128.1    P2p"
                     % (iface, role, state, cost))
        return "\n".join(L)

    stp = {
        "1": parse_stp(_stp(RA, 24586, RA, 24586, True,
                            [("Gi0/1", "Desg", "FWD", 4), ("Gi0/2", "Desg", "FWD", 4)])),
        "2": parse_stp(_stp(RA, 24586, "bbbb.0000.0002", 32778, False,
                            [("Gi0/1", "Root", "FWD", 4), ("Gi0/2", "Desg", "FWD", 4)])),
        "3": parse_stp(_stp(RA, 24586, "cccc.0000.0003", 32778, False,
                            [("Gi0/2", "Root", "FWD", 4), ("Gi0/1", "Altn", "BLK", 4)])),
    }
    st = trace_stp(snodes, sadj, stp, "10")
    se = {(e["a"], e["b"]): e for e in st["edges"]}
    check(st["root"] == 1, "STP: root bridge identified (SW1, Bridge==Root addr)")
    check(se[(1, 2)]["forwarding"] and se[(1, 3)]["forwarding"],
          "STP: root's links to SW2 and SW3 forwarding (green tree)")
    check(se[(2, 3)]["blocked"] and not se[(2, 3)]["forwarding"],
          "STP: redundant SW2-SW3 link blocked (an Altn/BLK end)")
    check(se[(2, 3)]["a_role"] == "Desg" and se[(2, 3)]["b_role"] == "Altn"
          and se[(2, 3)]["b_state"] == "BLK",
          "STP: per-end roles oriented to nodes (SW2 Desg / SW3 Altn-BLK)")
    check(se[(1, 2)]["a_role"] == "Desg" and se[(1, 2)]["b_role"] == "Root",
          "STP: SW1 end Designated, SW2 end Root port")
    check(stp["3"]["is_root"] is False and stp["3"]["root_addr"] == RA
          and stp["3"]["bridge_addr"] == "cccc.0000.0003"
          and stp["3"]["ports"]["Gi0/1"]["role"] == "Altn",
          "STP parser: non-root reads Root/Bridge addr + port roles")
    # converging: SW3's blocked port is mid-transition (LRN) -> transitioning
    stp3lrn = dict(stp)
    stp3lrn["3"] = parse_stp(_stp(RA, 24586, "cccc.0000.0003", 32778, False,
                             [("Gi0/2", "Root", "FWD", 4), ("Gi0/1", "Altn", "LRN", 4)]))
    stl = {(e["a"], e["b"]): e for e in trace_stp(snodes, sadj, stp3lrn, "10")["edges"]}
    check(stl[(2, 3)]["transitioning"] and not stl[(2, 3)]["blocked"]
          and not stl[(2, 3)]["forwarding"],
          "STP: an LRN end marks the link transitioning (listen/learn convergence)")
    # parallel links SW1=SW2: one forwards (Root/Desg FWD), the redundant one
    # blocks (Altn BLK) — both must survive as distinct edges (the original bug
    # collapsed them by node pair, so the second link got no role).
    padj = [
        {"a_node": 1, "a_if": "Gi0/1", "b_node": 2, "b_if": "Gi0/1"},
        {"a_node": 1, "a_if": "Gi0/2", "b_node": 2, "b_if": "Gi0/2"},
    ]
    pstp = {
        "1": parse_stp(_stp(RA, 24586, RA, 24586, True,
                            [("Gi0/1", "Desg", "FWD", 4), ("Gi0/2", "Desg", "FWD", 4)])),
        "2": parse_stp(_stp(RA, 24586, "bbbb.0000.0002", 32778, False,
                            [("Gi0/1", "Root", "FWD", 4), ("Gi0/2", "Altn", "BLK", 4)])),
    }
    pt = trace_stp([{"id": 1, "name": "SW1"}, {"id": 2, "name": "SW2"}], padj, pstp, "10")
    pbif = {e["a_if"]: e for e in pt["edges"]}
    check(len(pt["edges"]) == 2 and "Gi0/1" in pbif and "Gi0/2" in pbif,
          "STP parallel links: both kept as distinct edges (a_if carried)")
    check(pbif["Gi0/1"]["forwarding"] and not pbif["Gi0/1"]["blocked"]
          and pbif["Gi0/2"]["blocked"] and pbif["Gi0/2"]["b_role"] == "Altn",
          "STP parallel links: one forwards, the redundant one blocks (Altn)")
    # root bridge off-canvas -> root None + a note
    stp_off = {"2": parse_stp(_stp("dddd.0000.0009", 4096, "bbbb.0000.0002", 32778,
               False, [("Gi0/1", "Root", "FWD", 4)]))}
    sto = trace_stp([{"id": 2, "name": "SW2"}], [], stp_off, "10")
    check(sto["root"] is None and sto["notes"],
          "STP: root bridge not on canvas -> root None + warning note")
    # picker: build_overlay stp-vlans lists VLAN ids from `show spanning-tree`
    vp = build_overlay({"proto": "stp-vlans",
                        "stp_raw": "VLAN0001\n...\nVLAN0010\n...\nVLAN0020\n"})
    check([x["vlan"] for x in vp["vlans"]] == [1, 10, 20],
          "STP picker: build_overlay('stp-vlans') lists VLAN ids")

    # ── per-VLAN root comparison (PVST+ load-balancing: VLAN10->SW1, VLAN20->SW2)
    def _stpv(vlan, root_addr, root_prio, br_addr, br_prio, is_root, ports, cost=None):
        L = ["VLAN%04d" % vlan, "  Spanning tree enabled protocol rstp",
             "  Root ID    Priority    %d" % root_prio,
             "             Address     %s" % root_addr]
        if cost is not None:
            L.append("             Cost        %d" % cost)
        if is_root:
            L.append("             This bridge is the root")
        L += ["  Bridge ID  Priority    %d  (priority %d sys-id-ext %d)"
              % (br_prio, br_prio - vlan, vlan),
              "             Address     %s" % br_addr,
              "  Interface           Role Sts Cost      Prio.Nbr Type",
              "  ------------------- ---- --- --------- -------- ----"]
        for iface, role, state, c in ports:
            L.append("  %-19s %-4s %-3s %-9d 128.1    P2p" % (iface, role, state, c))
        return "\n".join(L)
    RB = "bbbb.0000.0002"
    n1all = (_stpv(10, RA, 24586, RA, 24586, True, [("Gi0/1", "Desg", "FWD", 4)])
             + "\n\n" + _stpv(20, RB, 24596, RA, 32788, False,
                              [("Gi0/1", "Root", "FWD", 4)], cost=4))
    n2all = (_stpv(10, RA, 24586, RB, 32778, False, [("Gi0/1", "Root", "FWD", 4)], cost=4)
             + "\n\n" + _stpv(20, RB, 24596, RB, 24596, True, [("Gi0/1", "Desg", "FWD", 4)]))
    pa = parse_stp_all(n1all)
    check(set(pa.keys()) == {10, 20} and pa[10]["is_root"]
          and pa[20]["root_addr"] == RB and pa[20]["root_cost"] == 4,
          "parse_stp_all: splits VLANs, reads per-VLAN root + this-bridge Cost")
    rr = build_overlay({"proto": "stp-roots",
                        "nodes": [{"id": 1, "name": "SW1"}, {"id": 2, "name": "SW2"}],
                        "stp": {"1": n1all, "2": n2all}})
    rmap = {r["vlan"]: r["root"] for r in rr["roots"]}
    check(rmap == {10: 1, 20: 2} and rr["names"]["2"] == "SW2",
          "STP root comparison: VLAN10 root=SW1, VLAN20 root=SW2 (load-balanced)")
    # trace_stp now returns addr2node so the client can name the designated bridge
    check(st.get("addr2node", {}).get("aaaa.0000.0001") == 1,
          "trace_stp: returns bridge-addr -> node map")

    # ── why a port blocked (BPDU from the designated bridge) ──────────────────
    def _det(iface, role, state, pcost, pid, dbprio, dbaddr, dcost, dpid):
        return ("\n Port 1 (%s) of VLAN0010 is %s %s\n"
                "   Port path cost %d, Port priority 128, Port Identifier %s.\n"
                "   Designated root has priority 32768, address cccc.0000.0006\n"
                "   Designated bridge has priority %d, address %s\n"
                "   Designated port id is %s, designated path cost %d\n"
                % (iface, role, state, pcost, pid, dbprio, dbaddr, dpid, dcost))
    # TWO links to the SAME root (SW6 = cccc), equal cost -> tie broken by the
    # neighbour's DESIGNATED PORT ID (the user's SW2 e0/3 case), NOT "superior BPDU"
    detP = (_det("Ethernet0/1", "root", "forwarding", 100, "128.1", 32768, "cccc.0000.0006", 0, "128.1")
            + _det("Ethernet0/3", "alternate", "blocking", 100, "128.3", 32768, "cccc.0000.0006", 0, "128.3"))
    wy = build_overlay({"proto": "stp-why", "why_raw": detP, "iface": "Et0/3"})["why"]
    check(wy["role"] == "alternate" and wy["basis"] == "port-id"
          and wy["root_port"] == "Et0/1"
          and "128.1" in wy["reason"] and "128.3" in wy["reason"],
          "STP why-blocked: parallel links to root -> tiebreak on designated PORT ID")
    # different cost path -> basis 'cost'
    detC = (_det("Ethernet0/1", "root", "forwarding", 100, "128.1", 32768, "cccc.0000.0006", 0, "128.1")
            + _det("Ethernet0/2", "alternate", "blocking", 100, "128.2", 32769, "dddd.0000.0009", 100, "128.1"))
    wy2 = build_overlay({"proto": "stp-why", "why_raw": detC, "iface": "Et0/2"})["why"]
    check(wy2["basis"] == "cost" and wy2["role"] == "alternate",
          "STP why-blocked: higher-cost alternate -> basis 'cost'")
    check(parse_stp_detail(detP)[0]["des_port_id"] == "128.1"
          and parse_stp_detail(detP)[0]["role"] == "root",
          "parse_stp_detail: reads all ports incl. designated port id")

    # ── Port-channel: two physical links bundled into Po1 share the Po's role ──
    ecraw = ("Flags:  D - down  P - bundled in port-channel\n"
             "Group  Port-channel  Protocol    Ports\n"
             "------+-------------+-----------+--------------------------------\n"
             "1      Po1(SU)         LACP      Et0/2(P)    Et0/3(P)\n")
    ecm = parse_etherchannel(ecraw)
    check(ecm.get("Et0/2") == "Po1" and ecm.get("Et0/3") == "Po1",
          "parse_etherchannel: bundled members -> Po1")
    pcadj = [{"a_node": 1, "a_if": "Et0/2", "b_node": 2, "b_if": "Et0/2"},
             {"a_node": 1, "a_if": "Et0/3", "b_node": 2, "b_if": "Et0/3"}]
    pcstp = {"1": parse_stp(_stp(RA, 24586, RA, 24586, True, [("Po1", "Desg", "FWD", 4)])),
             "2": parse_stp(_stp(RA, 24586, "bbbb.0000.0002", 32778, False, [("Po1", "Root", "FWD", 4)]))}
    pct = trace_stp([{"id": 1, "name": "SW1"}, {"id": 2, "name": "SW2"}], pcadj,
                    pcstp, "1", {"1": ecm, "2": ecm})
    check(len(pct["edges"]) == 2 and all(
            e["bundled"] and e["a_po"] == "Po1" and e["forwarding"] for e in pct["edges"]),
          "STP port-channel: both member links inherit Po1 role (bundled, forwarding)")

    # ── MST: region/instance config + per-instance tree ───────────────────────
    mstcfg = ("Name      [region1]\n"
              "Revision  1     Instances configured 2\n"
              "Instance  Vlans mapped\n"
              "--------  --------------------------------\n"
              "0         2-4094\n"
              "1         1\n")
    mc = parse_mst_config(mstcfg)
    check(mc["name"] == "region1" and mc["revision"] == 1
          and any(i["instance"] == 1 and i["vlans"] == "1" for i in mc["instances"]),
          "parse_mst_config: region name/revision + instance->VLAN mapping")

    def _mst(inst, vlans, br_addr, br_prio, is_root, root_addr, root_cost, ports):
        L = ["##### MST%d    vlans mapped:   %s" % (inst, vlans),
             "Bridge        address %s  priority  %d (%d sysid %d)"
             % (br_addr, br_prio, br_prio - inst, inst)]
        if is_root:
            L.append("Root          this switch for MST%d" % inst)
        else:
            L.append("Root          address %s  priority  %d (%d sysid %d)"
                     % (root_addr, br_prio, br_prio - inst, inst))
            L.append("              port    %s            cost   %d   rem hops 19"
                     % (ports[0][0], root_cost))
        L += ["Interface        Role Sts Cost      Prio.Nbr Type",
              "---------------- ---- --- --------- -------- ----"]
        for iface, role, state, c in ports:
            L.append("%-16s %-4s %-3s %-9d 128.1    P2p" % (iface, role, state, c))
        return "\n".join(L)
    m1 = parse_stp_mst(_mst(1, "1", "aaaa.0000.0001", 24577, True, None, None,
                            [("Et0/1", "Desg", "FWD", 2000)]))
    m2 = parse_stp_mst(_mst(1, "1", "bbbb.0000.0002", 32769, False, "aaaa.0000.0001",
                            2000, [("Et0/1", "Root", "FWD", 2000)]))
    check(m1["instance"] == 1 and m1["is_root"] and m1["ports"]["Et0/1"]["role"] == "Desg",
          "parse_stp_mst: instance + 'this switch is root' + port role")
    check(m2["root_addr"] == "aaaa.0000.0001" and m2["root_cost"] == 2000
          and not m2["is_root"] and m2["ports"]["Et0/1"]["role"] == "Root",
          "parse_stp_mst: non-root reads root addr + cost + root port")
    mt = trace_stp([{"id": 1, "name": "SW1"}, {"id": 2, "name": "SW2"}],
                   [{"a_node": 1, "a_if": "Et0/1", "b_node": 2, "b_if": "Et0/1"}],
                   {"1": m1, "2": m2}, "1")
    check(mt["root"] == 1 and mt["edges"][0]["forwarding"],
          "MST: trace_stp paints an instance tree (root SW1, link forwarding)")
    mi = build_overlay({"proto": "mst-instances", "mst_raw": mstcfg})
    check(mi["region"] == "region1" and any(i["instance"] == 1 for i in mi["instances"]),
          "MST picker: build_overlay('mst-instances') lists region + instances")
    # MST why-blocked: the MST `… mst <n> detail` layout differs from PVST (real
    # SW6 output) — two ports to the root, tie broken on the designated port ID.
    mst_detail = (
        "##### MST1    vlans mapped:   1\n"
        "Bridge        address aabb.cc00.0500  priority      32769 (32768 sysid 1)\n"
        "Root          address aabb.cc00.0100  priority      24577 (24576 sysid 1)\n"
        "\n"
        "Ethernet0/0 of MST1 is root forwarding \n"
        "Port info             port id          128.1  priority    128  cost     2000000\n"
        "Designated root       address aabb.cc00.0100  priority  24577  cost           0\n"
        "Designated bridge     address aabb.cc00.0100  priority  24577  port id    128.2\n"
        "\n"
        "Ethernet1/0 of MST1 is alternate blocking \n"
        "Port info             port id          128.5  priority    128  cost     2000000\n"
        "Designated root       address aabb.cc00.0100  priority  24577  cost           0\n"
        "Designated bridge     address aabb.cc00.0100  priority  24577  port id    128.4\n")
    pd = {p["iface"]: p for p in parse_stp_detail(mst_detail)}
    check(pd["Et1/0"]["role"] == "alternate" and pd["Et1/0"]["port_cost"] == 2000000
          and pd["Et1/0"]["des_cost"] == 0 and pd["Et1/0"]["des_port_id"] == "128.4"
          and pd["Et0/0"]["role"] == "root",
          "parse_stp_detail: reads the MST detail layout (cost/port-id on Designated lines)")
    wm = build_overlay({"proto": "stp-why", "why_raw": mst_detail, "iface": "Et1/0"})["why"]
    check(wm and wm["basis"] == "port-id" and wm["root_port"] == "Et0/0"
          and wm["des_port_id"] == "128.4" and wm["root_port_des_port_id"] == "128.2",
          "MST why-blocked: port-id tiebreak (root Et0/0 sender 128.2 < this 128.4)")

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
            print(json.dumps(build_overlay(json.loads(data)),
                             separators=(",", ":")))
            sys.exit(0)
        except (ValueError, KeyError, TypeError) as e:
            print(json.dumps({"error": "bad input bundle: %s" % e}))
            sys.exit(2)
    sys.exit(_selftest())
