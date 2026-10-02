# pnet_bgpparse — stdlib parser for Cisco IOS / IOS-XE `show ip bgp` output.
#
# Stage 1 of the BGP best-path waterfall (Protocol Inspector sibling). Turns the
# columnar BGP table dump into a structured prefix->paths index that drives the
# prefix PICKER. Stage 2 (the per-prefix waterfall) is fed by the verbose
# `show ip bgp <prefix>` detail and lives elsewhere.
#
# WHY A DEDICATED PARSER, AND WHY COLUMN-ANCHORED
# -----------------------------------------------
# The table is whitespace-columnar, and the Metric and LocPrf columns are
# routinely BLANK:
#
#      Network          Next Hop            Metric LocPrf Weight Path
#   *> 10.0.0.0/24      10.1.12.1                0             0 65010 65020 i
#   *                   10.1.13.1                0             0 65010 65030 65020 i
#   * i                 10.1.14.4                0    100      0 65040 65020 i
#   *> 10.0.1.0/24      10.1.12.1                              0 i
#
# Two facts make naive parsing wrong:
#   1. Additional paths to the same prefix have a BLANK Network column — the
#      prefix must be carried forward from the previous line.
#   2. Because Metric/LocPrf can be blank, you CANNOT tell from tokens alone
#      whether "0  0" is (metric, weight) or (locprf, weight). Token counting is
#      ambiguous. The only robust disambiguation is COLUMN POSITION, so we read
#      the header line once, capture each column's start offset, and slice every
#      data line by those offsets. Values are stripped, so small per-version
#      indentation drift is tolerated as long as columns keep their padding.
#
# Public API:
#   parse(text)            -> {"router_id","table_version","prefixes":[...],"error"?}
#   picker_rows(parsed)    -> [{prefix,paths,best_next_hop,rib_failure,multipath}]
#
# Each prefix: {"prefix","paths":[path,...],"best_index","installed"}
# Each path:   {"valid","best","internal","multipath","rib_failure","stale",
#               "suppressed","damped","history","backup","best_external",
#               "next_hop","metric","local_pref","weight","as_path","origin",
#               "source"}  (source = "ibgp" if internal else "ebgp")
#
# IPv4 unicast is the v1 target (matches the lab's IOS/IOL images). IPv6/VPNv4
# prefix-wrap onto a second line is handled defensively (a network-only line sets
# the carry-forward prefix and contributes no path) but not heavily exercised.

import re

ORIGIN_CODE = {"i": "igp", "e": "egp", "?": "incomplete"}


def _columns(header):
    """Map the column title offsets from the table header line. Returns a dict of
    start positions, or None if this is not the BGP table header."""
    if "Network" not in header or "Next Hop" not in header or "Path" not in header:
        return None
    cols = {}
    for key, title in (("net", "Network"), ("nh", "Next Hop"),
                       ("metric", "Metric"), ("locprf", "LocPrf"),
                       ("weight", "Weight"), ("path", "Path")):
        cols[key] = header.find(title)
    # Metric / LocPrf are absent from some address-family headers; tolerate it by
    # collapsing a missing numeric column onto the next one (slice becomes empty).
    if cols["metric"] < 0:
        cols["metric"] = cols["locprf"] if cols["locprf"] >= 0 else cols["weight"]
    if cols["locprf"] < 0:
        cols["locprf"] = cols["weight"]
    return cols


def _slice(line, a, b):
    """Column slice [a:b) of a line, stripped. b may run past EOL (returns less)."""
    if a < 0:
        return ""
    return line[a:b].strip() if b is not None else line[a:].strip()


def _int_or_none(s):
    s = s.strip()
    return int(s) if s.isdigit() else None


def _decode_status(code):
    """Decode the leading status-code field into boolean flags. Case matters:
    lowercase 's' suppressed vs uppercase 'S' Stale, lowercase 'i' internal vs
    uppercase RPKI 'I' invalid. '=' / 'm' both mean multipath across versions."""
    ch = set(code)
    return {
        "valid": "*" in ch,
        "best": ">" in ch,
        "internal": "i" in ch,                 # learned from an iBGP peer
        "multipath": ("=" in ch) or ("m" in ch),
        "suppressed": "s" in ch,
        "damped": "d" in ch,
        "history": "h" in ch,
        "rib_failure": "r" in ch,              # best in BGP, not installed in RIB
        "stale": "S" in ch,
        "backup": "b" in ch,
        "best_external": "x" in ch,
    }


def _parse_path(path_str):
    """Split the Path field into (as_path, origin). The trailing token is the
    origin code (i/e/?); the rest are AS numbers, with AS_SET '{...}' and confed
    '(...)' segments preserved as strings. A locally originated route has an empty
    path (just the origin code)."""
    toks = path_str.split()
    if not toks:
        return [], None
    origin = ORIGIN_CODE.get(toks[-1])
    body = toks[:-1] if origin else toks
    as_path = []
    for t in body:
        as_path.append(int(t) if t.isdigit() else t)
    return as_path, origin


def parse(text):
    """Parse `show ip bgp` (or `show bgp ipv4 unicast`) columnar output."""
    out = {"router_id": None, "table_version": None, "prefixes": []}

    # IOS: "local router ID is 1.1.1.1"; NX-OS: "Local Router ID is 1.1.1.1".
    m = re.search(r"local router id is (\S+)", text, re.IGNORECASE)
    if m:
        out["router_id"] = m.group(1).rstrip(",")
    m = re.search(r"BGP table version is (\d+)", text)
    if m:
        out["table_version"] = int(m.group(1))

    lines = text.splitlines()
    cols = hidx = None
    for i, ln in enumerate(lines):
        c = _columns(ln)
        if c is not None:
            cols, hidx = c, i
            break
    if cols is None:
        out["error"] = "no BGP table header found"
        return out

    groups = {}            # prefix -> group dict (merge repeated prefixes)
    order = []             # preserve first-seen prefix order
    cur_prefix = None

    for ln in lines[hidx + 1:]:
        if not ln.strip():
            continue
        if ln.lstrip().startswith("Total number"):
            break
        # Network + status. IOS aligns the prefix under the Network header and puts
        # the status codes in the left margin. NX-OS glues the status codes AND the
        # path-type letter (i/e/c/l/r) directly onto the prefix — "*>e10.0.0.0/24",
        # "* i10.0.0.0/24" — which bleeds LEFT of the Network column, so header-offset
        # slicing would truncate it. Peel the prefix with a regex from the line head
        # (status flags + optional type letter, then the prefix); a genuine prefix
        # sits LEFT of the Next-Hop column, so require that to avoid matching a
        # carry-forward line's next-hop IP. Fall back to header slicing otherwise
        # (IOS blank carry-forward lines have no network of their own).
        _typ = ""
        mnx = re.match(
            r"^([sSdhxr*>=&|\s]*?)([a-zA-Z]?)"
            r"(\d{1,3}(?:\.\d{1,3}){3}(?:/\d{1,2})?)(?=\s|$)", ln)
        if mnx and mnx.start(3) < cols["nh"] and mnx.start(3) >= 0:
            status = mnx.group(1)
            _typ = mnx.group(2)
            network = mnx.group(3)
        else:
            status = ln[:cols["net"]] if cols["net"] > 0 else ""
            network = _slice(ln, cols["net"], cols["nh"])
        next_hop = _slice(ln, cols["nh"], cols["metric"])
        metric = _slice(ln, cols["metric"], cols["locprf"])
        local_pref = _slice(ln, cols["locprf"], cols["weight"])
        # Weight + Path are read together from the Weight column to the EOL, then
        # split: Weight is always present and 16-bit (<=5 digits, never wider than
        # the 6-char "Weight" header) so it never bleeds left of its column and is
        # always the first token; the Path (variable width) is the remainder. This
        # avoids depending on the Path column staying perfectly aligned.
        tail = ln[cols["weight"]:].split() if cols["weight"] >= 0 else []
        weight = tail[0] if tail else ""
        path_str = " ".join(tail[1:]) if len(tail) > 1 else ""

        if network:
            cur_prefix = network
            if cur_prefix not in groups:
                grp = {"prefix": cur_prefix, "paths": [],
                       "best_index": None, "installed": 0}
                groups[cur_prefix] = grp
                order.append(cur_prefix)
        if cur_prefix is None:
            continue                            # data before any prefix: skip

        # A network-only line (long prefix wrapped; next hop on the next line)
        # sets the carry-forward prefix but contributes no path of its own.
        if not next_hop and not path_str and not weight:
            continue

        flags = _decode_status(status)
        # NX-OS carries the path type as a letter glued before the prefix
        # (i-internal, e-external, c-confed, l-local, r-redist). 'i' means the path
        # is iBGP-learned; the other letters are NOT status flags (don't let 'r'
        # redist be misread as RIB-failure — that lives in _decode_status(status)).
        if _typ:
            if _typ.lower() == "i":
                flags["internal"] = True
        as_path, origin = _parse_path(path_str)
        path = {
            "next_hop": next_hop or None,
            "metric": _int_or_none(metric),
            "local_pref": _int_or_none(local_pref),
            "weight": _int_or_none(weight) or 0,
            "as_path": as_path,
            "origin": origin,
            "source": "ibgp" if flags["internal"] else "ebgp",
        }
        path.update(flags)

        grp = groups[cur_prefix]
        if path["best"] and grp["best_index"] is None:
            grp["best_index"] = len(grp["paths"])
        if path["best"] or path["multipath"]:
            grp["installed"] += 1
        grp["paths"].append(path)

    out["prefixes"] = [groups[p] for p in order]
    return out


def picker_rows(parsed):
    """Condense parsed output into one summary row per prefix for the Stage-1
    picker UI: how many paths, the chosen next hop, and the flags a student
    should notice (RIB-failure, ECMP/multipath)."""
    rows = []
    for grp in parsed.get("prefixes", []):
        paths = grp["paths"]
        bi = grp["best_index"]
        best = paths[bi] if bi is not None else None
        rows.append({
            "prefix": grp["prefix"],
            "paths": len(paths),
            "best_next_hop": best["next_hop"] if best else None,
            "rib_failure": any(p["rib_failure"] for p in paths),
            "multipath": grp["installed"] > 1,
        })
    return rows


# ---- Stage 2: `show ip bgp <prefix>` detail parser ---------------------------
#
# The columnar table (Stage 1) cannot carry the LOWER tiebreakers — IGP metric to
# the next hop, and the neighbour's router-id. The per-prefix detail does, so it
# is what feeds the full best-path waterfall:
#
#   BGP routing table entry for 10.0.0.0/24, version 5
#   Paths: (4 available, best #1, table default)
#     Refresh Epoch 1
#     65010 65020
#       10.1.12.1 from 10.1.12.1 (3.3.3.3)
#         Origin IGP, metric 0, localpref 100, valid, external, best
#     65040 65020
#       10.1.14.4 (metric 20) from 10.1.14.4 (5.5.5.5)
#         Origin IGP, metric 0, localpref 100, valid, internal
#
# Each path is three lines: the AS-path line, the next-hop line (with the optional
# "(metric N)" IGP cost and the "from <peer> (<router-id>)" tail), and the
# attribute line ("Origin .., metric .., localpref .., [weight ..,] valid,
# external|internal[, best]"). We assemble a path when we see the next-hop line
# (using the most recent AS-path line above it) and finish it on the Origin line.

_NH_RE = re.compile(
    r"^\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\s+\(metric (\d+)\))?"
    r" from (\S+) \((\d{1,3}(?:\.\d{1,3}){3})\)")
_AS_TOKEN = re.compile(r"^(?:\d+|\{[\d,]+\}|\([\d ]+\))$")
_ORIGIN_RE = re.compile(r"^\s+Origin (IGP|EGP|incomplete)", re.IGNORECASE)


def _is_aspath_line(s):
    """Is this an AS-path line? Returns (True, as_path) or (False, None). 'Local'
    means a locally originated route (empty AS-path). Trailing annotations after a
    comma (', (aggregated by ...)', ', (received-only)', NX-OS ', path sourced ...')
    are ignored. NX-OS prefixes the line with 'AS-Path: ' and writes an empty path
    as 'AS-Path: NONE' / '... Local'."""
    s = s.strip()
    # NX-OS "AS-Path: 65010 65020 , path sourced external to AS" / "AS-Path: NONE"
    m = re.match(r"AS-Path:\s*(.*)$", s, re.IGNORECASE)
    if m:
        s = m.group(1).strip()
        if s.upper().startswith("NONE") or s.upper().startswith("LOCAL"):
            return True, []
    if s == "Local":
        return True, []
    head = s.split(",")[0].strip()
    if not head:
        return False, None
    out = []
    for t in head.split():
        if t.isdigit():
            out.append(int(t))
        elif _AS_TOKEN.match(t):
            out.append(t)
        else:
            return False, None
    return True, out


def parse_detail(text):
    """Parse `show ip bgp <prefix>` detail into {prefix, version, available,
    best_num, paths:[...]}. Each path carries the full attribute set including the
    IGP metric to the next hop and the peer router-id."""
    out = {"prefix": None, "version": None, "available": None,
           "best_num": None, "paths": []}

    m = re.search(r"BGP routing table entry for (\S+?),", text)
    if m:
        out["prefix"] = m.group(1)
    else:
        out["error"] = "not a 'show ip bgp <prefix>' detail block"
        return out
    m = re.search(r"\((\d+) available(?:, best #(\d+))?", text)
    if m:
        out["available"] = int(m.group(1))
        out["best_num"] = int(m.group(2)) if m.group(2) else None

    pending = []            # most recently seen AS-path
    pending_type = None     # NX-OS "Path type:" attrs staged for the next path block
    cur = None              # path being assembled

    for ln in text.splitlines():
        # NX-OS states valid/best/internal on a "Path type:" line ABOVE the AS-Path
        # + next-hop lines (IOS folds them into the Origin line instead). Stage them
        # and apply when the next-hop line opens the path. e.g.
        #   "  Path type: external, path is valid, is best path, no labeled nexthop"
        #   "  Path type: internal, path is valid, not best reason: Router Id, ..."
        mt = re.match(r"\s*Path type:\s*(\w+)", ln)
        if mt:
            low = ln.lower()
            pending_type = {
                "source": ("ibgp" if "internal" in low
                           else ("ebgp" if "external" in low else None)),
                "valid": ("path is valid" in low) or ("is valid" in low),
                # "is best path" wins; "not best reason:" must NOT count as best.
                "best": ("is best path" in low)
                        or ("best path" in low and "not best" not in low),
            }
            continue
        nh = _NH_RE.match(ln)
        if nh:
            cur = {"as_path": list(pending), "local": (pending == [] and
                   _saw_local(ln, text)),
                   "next_hop": nh.group(1),
                   "igp_metric": int(nh.group(2)) if nh.group(2) else None,
                   "from_peer": nh.group(3), "router_id": nh.group(4),
                   "origin": None, "metric": None, "local_pref": None,
                   "weight": 0, "valid": False, "source": None, "best": False,
                   "flags": []}
            if pending_type is not None:                # NX-OS staged attributes
                cur["source"] = pending_type["source"]
                cur["valid"] = pending_type["valid"]
                cur["best"] = pending_type["best"]
                pending_type = None
            out["paths"].append(cur)
            continue
        if _ORIGIN_RE.match(ln) and cur is not None:
            clauses = [c.strip() for c in ln.strip().split(",")]
            cur["flags"] = clauses
            mo = _ORIGIN_RE.match(ln)
            cur["origin"] = mo.group(1).lower()
            # IOS writes "metric N"; NX-OS writes "MED N" — accept either.
            mm = re.search(r"\b(?:metric|MED) (\d+)", ln)
            if mm:
                cur["metric"] = int(mm.group(1))
            ml = re.search(r"\blocalpref (\d+)", ln)
            if ml:
                cur["local_pref"] = int(ml.group(1))
            mw = re.search(r"\bweight (\d+)", ln)
            if mw:
                cur["weight"] = int(mw.group(1))
            # OR-semantics: keep any valid/source/best already set from a NX-OS
            # "Path type:" line (its Origin line carries none of these), while still
            # reading them from the IOS Origin line where they DO live.
            cur["valid"] = cur["valid"] or ("valid" in clauses)
            if "internal" in clauses:
                cur["source"] = "ibgp"
            elif "external" in clauses:
                cur["source"] = "ebgp"
            if "local" in clauses or "sourced" in clauses:
                cur["local"] = True
            cur["best"] = cur["best"] or ("best" in clauses)
            # device-reported multipath membership (gated by `maximum-paths`): the
            # Origin line carries "multipath" on each co-installed non-best path.
            cur["multipath"] = "multipath" in clauses
            cur = None
            continue
        ok, ap = _is_aspath_line(ln)
        if ok:
            pending = ap
    return out


def _saw_local(nh_line, text):
    """A next-hop of 0.0.0.0 strongly implies a locally originated route; the
    Origin-line 'local'/'sourced' flag confirms it (set later)."""
    return nh_line.strip().startswith("0.0.0.0")


# ---- best-path decision (the waterfall, server-side) -------------------------

_ORIGIN_ORDER = {"igp": 0, "egp": 1, "incomplete": 2}

# Cisco best-path order. Each entry: (display name, sort key — LOWER wins).
_RUNGS = (
    ("Weight",                 lambda p: -(p.get("weight") or 0)),
    ("Local preference",       lambda p: -(p["local_pref"] if p.get("local_pref")
                                           is not None else 100)),
    ("Locally originated",     lambda p: 0 if p.get("local") else 1),
    ("AS-path length",         lambda p: len(p.get("as_path") or [])),
    ("Origin code",            lambda p: _ORIGIN_ORDER.get(p.get("origin"), 3)),
    ("MED",                    lambda p: p["metric"] if p.get("metric")
                                         is not None else 0),
    ("eBGP over iBGP",         lambda p: 0 if p.get("source") == "ebgp" else 1),
    ("IGP metric to next-hop", lambda p: p["igp_metric"] if p.get("igp_metric")
                                         is not None else float("inf")),
    ("Router ID",              lambda p: _rid_key(p.get("router_id"))),
)


def _rid_key(rid):
    if not rid:
        return (999, 999, 999, 999)
    try:
        return tuple(int(x) for x in rid.split("."))
    except ValueError:
        return (999, 999, 999, 999)


def waterfall_paths(detail):
    """Normalise parse_detail() paths into the candidate list the waterfall walks,
    labelled P1..Pn in table order."""
    rows = []
    for i, p in enumerate(detail.get("paths", [])):
        rows.append({
            "id": "P%d" % (i + 1),
            "next_hop": p["next_hop"], "as_path": p["as_path"],
            "as_len": len(p["as_path"]), "origin": p["origin"],
            "metric": p["metric"], "local_pref": p["local_pref"],
            "weight": p["weight"], "source": p["source"],
            "igp_metric": p["igp_metric"], "router_id": p["router_id"],
            "local": p.get("local", False), "valid": p["valid"],
            "best": p["best"], "multipath": p.get("multipath", False),
        })
    return rows


def decide(paths):
    """Run the best-path ladder over waterfall_paths(). Returns the winner, the
    rung that decided it, and per-rung survivors/eliminated for the UI. Invalid
    paths (no next-hop reachability) are dropped first — they never compete."""
    alive = [p for p in paths if p.get("valid", True)]
    if not alive:
        return {"winner": None, "decided_at": None, "rungs": [], "multipath": [],
                "note": "no valid paths"}
    # Device-installed multipath set (best + every "multipath"-flagged path),
    # gated by `maximum-paths`. The ladder below always resolves to ONE winner
    # (Router ID breaks any remaining tie), so the co-installed set has to come
    # from the device flags — and once the survivors narrow to exactly this set
    # we STOP the ladder, because the device shares the load there rather than
    # applying the Router-ID / oldest-path tiebreakers to pick just one.
    installed = [p for p in paths if p.get("best") or p.get("multipath")]
    mp_set = set(p["id"] for p in installed) if len(installed) > 1 else set()
    rungs = []
    winner = decided_at = multipath_at = None
    for name, key in _RUNGS:
        narrowed_to_mp = (bool(mp_set) and len(alive) > 1 and
                          set(p["id"] for p in alive) == mp_set)
        if narrowed_to_mp and multipath_at is None:
            multipath_at = name
        if winner is not None or len(alive) == 1 or narrowed_to_mp:
            if winner is None and not narrowed_to_mp:
                winner = alive[0]["id"]      # single valid path: best by default
            rungs.append({"name": name, "reached": False,
                          "survivors": [p["id"] for p in alive], "eliminated": []})
            continue
        vals = {p["id"]: key(p) for p in alive}
        best = min(vals.values())
        survivors = [p for p in alive if vals[p["id"]] == best]
        elim = [p["id"] for p in alive if vals[p["id"]] != best]
        rungs.append({"name": name, "reached": True,
                      "survivors": [p["id"] for p in survivors],
                      "eliminated": elim})
        alive = survivors
        if len(alive) == 1:
            winner, decided_at = alive[0]["id"], name
    if winner is None:
        winner = alive[0]["id"]
    best_flagged = next((p["id"] for p in paths if p.get("best")), None)
    if best_flagged:
        winner = best_flagged                # headline winner = device's best
    return {"winner": winner, "decided_at": decided_at, "rungs": rungs,
            "multipath": sorted(mp_set) if mp_set else [],
            "multipath_at": multipath_at}


# ---- self-test (run directly: python pnet_bgpparse.py) -----------------------

if __name__ == "__main__":
    import sys

    fails = 0

    def check(cond, msg):
        global fails
        print(("ok   " if cond else "FAIL ") + msg)
        if not cond:
            fails += 1

    SAMPLE = (
        "BGP table version is 14, local router ID is 1.1.1.1\n"
        "Status codes: s suppressed, d damped, h history, * valid, > best, "
        "i - internal,\n"
        "              r RIB-failure, S Stale, m multipath, b backup-path\n"
        "Origin codes: i - IGP, e - EGP, ? - incomplete\n"
        "\n"
        "     Network          Next Hop            Metric LocPrf Weight Path\n"
        " *>  10.0.0.0/24      10.1.12.1                0             0 65010 65020 i\n"
        " *                    10.1.13.1                0             0 65010 65030 65020 i\n"
        " * i                  10.1.14.4                0    100      0 65040 65020 i\n"
        " *                    10.1.15.1                0             0 65010 65050 65060 65020 i\n"
        " *>  10.0.1.0/24      10.1.12.1                              0 i\n"
        " r>i 10.0.2.0/24      192.168.1.1              0    100      0 65020 ?\n"
        " *>  10.0.3.0/24      0.0.0.0                             32768 i\n"
        " *=  10.0.4.0/24      10.1.12.1                0             0 65030 i\n"
        " *>  10.0.4.0/24      10.1.13.1                0             0 65030 i\n"
        "Total number of prefixes 7\n"
    )

    p = parse(SAMPLE)
    check(p.get("error") is None, "header found, no error")
    check(p["router_id"] == "1.1.1.1", "router-id parsed (%s)" % p["router_id"])
    check(p["table_version"] == 14, "table version parsed")

    pref = {g["prefix"]: g for g in p["prefixes"]}
    check(len(p["prefixes"]) == 5, "5 distinct prefixes (got %d)"
          % len(p["prefixes"]))

    # multi-path prefix with carry-forward (blank Network on continuation lines)
    g = pref["10.0.0.0/24"]
    check(len(g["paths"]) == 4, "10.0.0.0/24 carried forward to 4 paths (got %d)"
          % len(g["paths"]))
    check(g["best_index"] == 0, "first path is best")
    check(g["paths"][0]["as_path"] == [65010, 65020], "as_path of best path")
    check(g["paths"][0]["source"] == "ebgp", "best path is eBGP")
    check(g["paths"][2]["source"] == "ibgp", "3rd path internal (iBGP)")
    check(g["paths"][2]["local_pref"] == 100, "iBGP path carries LocPrf 100")
    check(g["paths"][0]["local_pref"] is None,
          "eBGP path LocPrf blank -> None (default 100)")
    check(g["paths"][3]["as_path"] == [65010, 65050, 65060, 65020],
          "4th path long as_path")

    # blank metric AND locprf, weight only
    g = pref["10.0.1.0/24"]
    check(g["paths"][0]["metric"] is None and g["paths"][0]["local_pref"] is None,
          "10.0.1.0/24 blank metric+locprf -> None")
    check(g["paths"][0]["weight"] == 0, "weight defaults to 0")

    # RIB-failure + internal + incomplete origin
    g = pref["10.0.2.0/24"]
    check(g["paths"][0]["rib_failure"], "10.0.2.0/24 flagged RIB-failure")
    check(g["paths"][0]["origin"] == "incomplete", "origin ? -> incomplete")
    check(g["best_index"] == 0, "RIB-failure path still marked best")

    # locally originated: next-hop 0.0.0.0, empty as_path, weight 32768
    g = pref["10.0.3.0/24"]
    check(g["paths"][0]["next_hop"] == "0.0.0.0", "local route next-hop 0.0.0.0")
    check(g["paths"][0]["as_path"] == [], "local route empty as_path")
    check(g["paths"][0]["weight"] == 32768, "local route weight 32768")
    check(g["paths"][0]["origin"] == "igp", "local route origin i -> igp")

    # multipath (= marker) — two installed paths to one prefix
    g = pref["10.0.4.0/24"]
    check(g["installed"] == 2, "10.0.4.0/24 has 2 installed (multipath/ECMP)")

    rows = picker_rows(p)
    rmap = {r["prefix"]: r for r in rows}
    check(rmap["10.0.0.0/24"]["best_next_hop"] == "10.1.12.1",
          "picker best next-hop")
    check(rmap["10.0.2.0/24"]["rib_failure"], "picker surfaces RIB-failure")
    check(rmap["10.0.4.0/24"]["multipath"], "picker surfaces multipath")

    # AS_SET preserved as a token (aggregated route)
    AGG = (
        "     Network          Next Hop            Metric LocPrf Weight Path\n"
        " *>  10.8.0.0/16      10.1.12.1                              0 65010 {65020,65030} i\n"
    )
    g = parse(AGG)["prefixes"][0]
    check("{65020,65030}" in g["paths"][0]["as_path"], "AS_SET token preserved")

    # missing header -> graceful error, no crash
    bad = parse("nonsense output with no table\n")
    check(bad.get("error") == "no BGP table header found", "missing header errors")
    check(bad["prefixes"] == [], "missing header -> empty prefixes")

    # ---- Stage 2: detail parser + decision ladder ---------------------------
    DETAIL = (
        "BGP routing table entry for 10.0.0.0/24, version 5\n"
        "Paths: (4 available, best #1, table default)\n"
        "  Advertised to update-groups:\n"
        "     3\n"
        "  Refresh Epoch 1\n"
        "  65010 65020\n"
        "    10.1.12.1 from 10.1.12.1 (3.3.3.3)\n"
        "      Origin IGP, metric 0, localpref 100, valid, external, best\n"
        "  Refresh Epoch 1\n"
        "  65010 65030 65020\n"
        "    10.1.13.1 from 10.1.13.1 (4.4.4.4)\n"
        "      Origin IGP, metric 0, localpref 100, valid, external\n"
        "  Refresh Epoch 1\n"
        "  65040 65020\n"
        "    10.1.14.4 (metric 20) from 10.1.14.4 (5.5.5.5)\n"
        "      Origin IGP, metric 0, localpref 100, valid, internal\n"
        "  Refresh Epoch 1\n"
        "  65010 65050 65060 65020\n"
        "    10.1.15.1 from 10.1.15.1 (6.6.6.6)\n"
        "      Origin IGP, metric 0, localpref 100, valid, external\n"
    )
    d = parse_detail(DETAIL)
    check(d.get("error") is None, "detail: parsed without error")
    check(d["prefix"] == "10.0.0.0/24", "detail: prefix")
    check(d["available"] == 4 and d["best_num"] == 1, "detail: available/best#")
    check(len(d["paths"]) == 4, "detail: 4 paths (got %d)" % len(d["paths"]))
    p0 = d["paths"][0]
    check(p0["as_path"] == [65010, 65020], "detail: path0 as_path (update-group "
          "number not misread)")
    check(p0["router_id"] == "3.3.3.3", "detail: path0 router-id from peer")
    check(p0["source"] == "ebgp" and p0["best"], "detail: path0 eBGP + best")
    p2 = d["paths"][2]
    check(p2["igp_metric"] == 20, "detail: path2 IGP metric to next-hop = 20")
    check(p2["source"] == "ibgp", "detail: path2 internal (iBGP)")

    wf = waterfall_paths(d)
    dec = decide(wf)
    check(dec["winner"] == "P1", "decide: winner is P1 (got %s)" % dec["winner"])
    check(dec["decided_at"] == "eBGP over iBGP",
          "decide: decided at eBGP-over-iBGP (got %s)" % dec["decided_at"])
    rung = {r["name"]: r for r in dec["rungs"]}
    check(set(rung["AS-path length"]["eliminated"]) == {"P2", "P4"},
          "decide: AS-path length eliminates P2 and P4")
    check(rung["AS-path length"]["survivors"] == ["P1", "P3"],
          "decide: P1 and P3 survive AS-path")
    check(rung["eBGP over iBGP"]["eliminated"] == ["P3"],
          "decide: eBGP-over-iBGP eliminates the iBGP path P3")
    check(rung["Router ID"]["reached"] is False,
          "decide: lower rungs not reached after decision")

    # decision short-circuits the lower tiebreakers but they exist if needed:
    # force a tie down to router-id and confirm lowest wins.
    tie = [
        {"id": "PA", "weight": 0, "local_pref": 100, "as_path": [65010],
         "origin": "igp", "metric": 0, "source": "ebgp", "igp_metric": 10,
         "router_id": "9.9.9.9", "valid": True},
        {"id": "PB", "weight": 0, "local_pref": 100, "as_path": [65010],
         "origin": "igp", "metric": 0, "source": "ebgp", "igp_metric": 10,
         "router_id": "2.2.2.2", "valid": True},
    ]
    dt = decide(tie)
    check(dt["winner"] == "PB" and dt["decided_at"] == "Router ID",
          "decide: falls through to lowest router-id")

    # single path -> best by default, no rung reached
    one = decide([{"id": "P1", "weight": 0, "source": "ebgp", "valid": True,
                   "as_path": [65010], "origin": "igp"}])
    check(one["winner"] == "P1" and one["decided_at"] is None,
          "decide: single path best by default")

    # ---- BGP multipath: device installs >1 path (maximum-paths) -------------
    MP = (
        "BGP routing table entry for 10.9.0.0/24, version 7\n"
        "Paths: (2 available, best #1, table default)\n"
        "  Refresh Epoch 1\n"
        "  65010 65020\n"
        "    10.1.12.1 from 10.1.12.1 (3.3.3.3)\n"
        "      Origin IGP, metric 0, localpref 100, valid, external, multipath, best\n"
        "  Refresh Epoch 1\n"
        "  65010 65020\n"
        "    10.1.13.1 from 10.1.13.1 (4.4.4.4)\n"
        "      Origin IGP, metric 0, localpref 100, valid, external, multipath\n"
    )
    dmp = parse_detail(MP)
    check(dmp["paths"][0]["best"] and dmp["paths"][0]["multipath"],
          "multipath: path0 best + multipath flagged")
    check(dmp["paths"][1]["multipath"] and not dmp["paths"][1]["best"],
          "multipath: path1 multipath, not best")
    decmp = decide(waterfall_paths(dmp))
    check(decmp["winner"] == "P1", "multipath: headline winner is the best path P1")
    check(set(decmp["multipath"]) == {"P1", "P2"},
          "multipath: both installed paths reported co-installed (got %s)"
          % decmp["multipath"])
    check(decide(waterfall_paths(parse_detail(DETAIL)))["multipath"] == [],
          "multipath: a single-best prefix reports no multipath set")

    # ---- NX-OS lane: `show ip bgp` table (status+type glued to the prefix) ----
    # NX-OS repeats the prefix on every path line and glues the status codes + the
    # path-type letter directly onto it ("*>e10.0.0.0/24", "* i10.0.0.0/24").
    NX = (
        "BGP routing table information for VRF default, address family IPv4 Unicast\n"
        "BGP table version is 8, Local Router ID is 1.1.1.1\n"
        "Status: s-suppressed, x-deleted, S-stale, d-dampened, h-history, "
        "*-valid, >-best\n"
        "Path type: i-internal, e-external, c-confed, r-redist, l-local\n"
        "Origin codes: i - IGP, e - EGP, ? - incomplete\n"
        "\n"
        "   Network            Next Hop            Metric     LocPrf     Weight Path\n"
        "*>e10.0.0.0/24         10.1.12.1                0                    0 65010 65020 i\n"
        "* i10.0.0.0/24         10.1.14.4                0        100         0 65040 65020 i\n"
        "*>l10.0.3.0/24         0.0.0.0                                   32768 i\n"
    )
    nx = parse(NX)
    check(nx.get("error") is None, "NX-OS: table header found, no error")
    check(nx["router_id"] == "1.1.1.1", "NX-OS: router-id parsed")
    nxp = {g["prefix"]: g for g in nx["prefixes"]}
    check(set(nxp) == {"10.0.0.0/24", "10.0.3.0/24"},
          "NX-OS: prefixes de-glued from status+type (got %s)" % sorted(nxp))
    g = nxp["10.0.0.0/24"]
    check(len(g["paths"]) == 2, "NX-OS: two paths to 10.0.0.0/24 (got %d)"
          % len(g["paths"]))
    check(g["paths"][0]["next_hop"] == "10.1.12.1"
          and g["paths"][0]["source"] == "ebgp",
          "NX-OS: path0 next-hop + eBGP (type 'e')")
    check(g["paths"][1]["source"] == "ibgp"
          and g["paths"][1]["local_pref"] == 100,
          "NX-OS: path1 iBGP (type 'i') + LocPrf 100")
    check(g["paths"][0]["best"] and g["paths"][0]["local_pref"] is None,
          "NX-OS: path0 best, blank LocPrf -> None")
    lg = nxp["10.0.3.0/24"]
    check(lg["paths"][0]["next_hop"] == "0.0.0.0"
          and lg["paths"][0]["weight"] == 32768,
          "NX-OS: local route (type 'l') next-hop 0.0.0.0, weight 32768")
    check(not any(pp["rib_failure"] for pp in g["paths"]),
          "NX-OS: path-type letters not misread as status flags (no false RIB-fail)")

    # ---- NX-OS lane: `show ip bgp <prefix>` detail -> waterfall ---------------
    # NX-OS states valid/best/internal on a "Path type:" line, prefixes the AS-Path
    # line with "AS-Path:", and writes the MED as "MED" not "metric".
    NXD = (
        "BGP routing table information for VRF default, address family IPv4 Unicast\n"
        "BGP routing table entry for 10.0.0.0/24, version 8\n"
        "Paths: (2 available, best #1)\n"
        "Flags: (0x08001a) on xmit-list, is in urib, is best urib route\n"
        "  Path type: external, path is valid, is best path\n"
        "  AS-Path: 65010 65020 , path sourced external to AS\n"
        "    10.1.12.1 (metric 0) from 10.1.12.1 (3.3.3.3)\n"
        "      Origin IGP, MED 0, localpref 100, weight 0\n"
        "  Path type: internal, path is valid, not best reason: Neighbor Address\n"
        "  AS-Path: 65040 65020 , path sourced external to AS\n"
        "    10.1.14.4 (metric 20) from 10.1.14.4 (5.5.5.5)\n"
        "      Origin IGP, MED 0, localpref 100, weight 0\n"
    )
    nd = parse_detail(NXD)
    check(nd.get("error") is None and nd["prefix"] == "10.0.0.0/24",
          "NX-OS detail: prefix parsed")
    check(nd["available"] == 2 and nd["best_num"] == 1,
          "NX-OS detail: available/best#")
    check(len(nd["paths"]) == 2, "NX-OS detail: 2 paths (got %d)" % len(nd["paths"]))
    np0, np1 = nd["paths"][0], nd["paths"][1]
    check(np0["as_path"] == [65010, 65020],
          "NX-OS detail: AS-Path: prefix stripped (got %s)" % np0["as_path"])
    check(np0["valid"] and np0["best"] and np0["source"] == "ebgp",
          "NX-OS detail: path0 valid+best+eBGP from 'Path type:' line")
    check(np0["router_id"] == "3.3.3.3", "NX-OS detail: router-id from peer")
    check(np1["source"] == "ibgp" and not np1["best"] and np1["valid"],
          "NX-OS detail: path1 iBGP, valid, not best ('not best reason')")
    check(np1["igp_metric"] == 20, "NX-OS detail: IGP metric to next-hop (metric 20)")
    ndec = decide(waterfall_paths(nd))
    check(ndec["winner"] == "P1" and ndec["decided_at"] == "eBGP over iBGP",
          "NX-OS detail: waterfall winner P1, decided eBGP-over-iBGP (got %s/%s)"
          % (ndec["winner"], ndec["decided_at"]))

    # IOS regression: the unified network-peel must not disturb IOS carry-forward.
    check(len(parse(SAMPLE)["prefixes"]) == 5,
          "IOS regression: carry-forward still yields 5 prefixes after NX-OS peel")

    print("\n%d failure(s)" % fails)
    sys.exit(1 if fails else 0)
