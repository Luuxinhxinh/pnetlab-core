# pnet_protodecode — stdlib, control-message-depth protocol dissection for the
# Protocol Inspector (per-link packet ladder). No third-party deps (the appliance
# has tcpdump + python3 only; tshark is intentionally not pulled in). v1 covers
# BGP + the TCP session that carries it; the FlowTracker is the extension point
# for OSPF/EIGRP/STP/etc. later.
#
# The capture daemon (pnetlab-prototracer.py) feeds each frame to
# FlowTracker.process(pkt, wirelen, dir_ab, ts) and gets back zero or more
# "events" — the rows of the ladder diagram:
#
#   {"ts":float, "dir":"ab"|"ba", "proto":"BGP"|"TCP",
#    "kind":"bgp_open"|"tcp_rst"|..., "label":"OPEN", "detail":"<plain English>",
#    "severity":"info"|"good"|"warn"|"event", "fields":{...}}
#
# "dir" is wire-direction only: "ab" = side A (the lower node_id end of the p2p
# link) -> side B. The daemon attaches the human node names; the meaning of each
# message is rendered here in plain English so the UI stays a dumb renderer.

import socket
import struct

# ---- plain-English lookup tables --------------------------------------------

BGP_TYPES = {1: "OPEN", 2: "UPDATE", 3: "NOTIFICATION", 4: "KEEPALIVE",
             5: "ROUTE-REFRESH"}

# NOTIFICATION error codes (RFC 4271 §4.5) and the subcodes worth naming.
BGP_ERR = {
    1: "Message Header Error",
    2: "OPEN Message Error",
    3: "UPDATE Message Error",
    4: "Hold Timer Expired",
    5: "Finite State Machine Error",
    6: "Cease",
}
BGP_SUB = {
    2: {1: "unsupported version number", 2: "bad peer AS",
        3: "bad BGP identifier", 4: "unsupported optional parameter",
        6: "unacceptable hold time", 7: "unsupported capability"},
    6: {1: "maximum prefixes reached", 2: "administrative shutdown",
        3: "peer de-configured", 4: "administrative reset",
        5: "connection rejected", 6: "other configuration change",
        7: "connection collision resolution", 8: "out of resources",
        9: "hard reset"},
}

# A BGP error short enough to put on the ladder arrow.
def _bgp_notif_reason(code, sub):
    base = BGP_ERR.get(code, "error %d" % code)
    detail = BGP_SUB.get(code, {}).get(sub)
    return "%s (%s)" % (base, detail) if detail else base


# ---- frame walking -----------------------------------------------------------

def _ip_tcp(pkt):
    """Return (src, dst, sport, dport, flags, payload_off, payload_len) for a
    TCP/IPv4 frame (handles one 802.1Q tag), else None. flags = TCP flag byte."""
    try:
        eth = struct.unpack_from("!H", pkt, 12)[0]
        off = 14
        if eth == 0x8100:                          # 802.1Q
            eth = struct.unpack_from("!H", pkt, 16)[0]
            off = 18
        if eth != 0x0800 or len(pkt) < off + 20:   # IPv4 only in v1
            return None
        if pkt[off + 9] != 6:                      # TCP
            return None
        ihl = (pkt[off] & 0x0F) * 4
        tot = struct.unpack_from("!H", pkt, off + 2)[0]
        src = socket.inet_ntop(socket.AF_INET, pkt[off + 12:off + 16])
        dst = socket.inet_ntop(socket.AF_INET, pkt[off + 16:off + 20])
        t = off + ihl                              # TCP header start
        if len(pkt) < t + 20:
            return None
        sport, dport = struct.unpack_from("!HH", pkt, t)
        doff = (pkt[t + 12] >> 4) * 4
        flags = pkt[t + 13]
        payload_off = t + doff
        # IP total length is authoritative for payload size (the capture is
        # snaplen-truncated, so len(pkt) undercounts a full segment).
        payload_len = max(0, tot - ihl - doff)
        return src, dst, sport, dport, flags, payload_off, payload_len
    except Exception:
        return None


def _flag_names(flags):
    names = []
    for bit, nm in ((0x02, "SYN"), (0x01, "FIN"), (0x04, "RST"),
                    (0x10, "ACK"), (0x08, "PSH"), (0x20, "URG")):
        if flags & bit:
            names.append(nm)
    return names


# ---- shared frame helpers (OSPF/EIGRP/GRE/STP/IS-IS) -------------------------

def _ev(ts, dir_ab, proto, kind, label, detail, severity="info", fields=None):
    return {"ts": ts, "dir": "ab" if dir_ab else "ba", "proto": proto,
            "kind": kind, "label": label, "detail": detail,
            "severity": severity, "fields": fields or {}}


def _ipv4(pkt):
    """(ip_off, ihl, ip_proto, src, dst) for an IPv4 frame (one 802.1Q tag), else
    None. ip_off = start of the IPv4 header."""
    try:
        et = struct.unpack_from("!H", pkt, 12)[0]
        off = 14
        if et == 0x8100:
            et = struct.unpack_from("!H", pkt, 16)[0]
            off = 18
        if et != 0x0800 or len(pkt) < off + 20:
            return None
        ihl = (pkt[off] & 0x0F) * 4
        src = socket.inet_ntop(socket.AF_INET, pkt[off + 12:off + 16])
        dst = socket.inet_ntop(socket.AF_INET, pkt[off + 16:off + 20])
        return off, ihl, pkt[off + 9], src, dst
    except Exception:
        return None


def _llc_base(pkt):
    """Offset of the 802.2 LLC header (after eth + one optional 802.1Q tag)."""
    if len(pkt) < 14:
        return None
    return 18 if struct.unpack_from("!H", pkt, 12)[0] == 0x8100 else 14


def _bridge_id(b):
    """8-byte STP bridge/root ID -> 'priority/aa:bb:cc:dd:ee:ff'."""
    prio = struct.unpack_from("!H", b, 0)[0]
    mac = ":".join("%02x" % x for x in b[2:8])
    return "%d/%s" % (prio, mac)


# ---- BGP message parsing -----------------------------------------------------

BGP_MARKER = b"\xff" * 16

def _parse_bgp_messages(pkt, start):
    """Walk the BGP messages packed into a TCP payload starting at offset
    `start`. control-message depth: type + a few header fields, no NLRI walk.
    Returns list of dicts: {type, label, detail, severity, fields}."""
    msgs = []
    i = start
    n = len(pkt)
    # Cap iterations so a malformed length can't spin.
    for _ in range(8):
        if i + 19 > n:
            break
        if pkt[i:i + 16] != BGP_MARKER:
            break                                   # not (or no longer) aligned
        mlen, mtype = struct.unpack_from("!HB", pkt, i + 16)
        if mlen < 19:
            break
        body = i + 19
        label = BGP_TYPES.get(mtype, "type %d" % mtype)
        fields = {}
        severity = "info"
        if mtype == 1 and body + 10 <= n:           # OPEN
            ver = pkt[body]
            my_as, hold = struct.unpack_from("!HH", pkt, body + 1)
            bgp_id = socket.inet_ntop(socket.AF_INET, pkt[body + 5:body + 9])
            fields = {"version": ver, "as": my_as, "holdtime": hold,
                      "router_id": bgp_id}
            detail = ("BGP OPEN — proposing the session: AS %d, hold-time %ds, "
                      "router-id %s. Both peers must agree before the session "
                      "comes up." % (my_as, hold, bgp_id))
            severity = "good"
        elif mtype == 2:                            # UPDATE
            hint = ""
            if body + 2 <= n:
                wlen = struct.unpack_from("!H", pkt, body)[0]
                bits = []
                if wlen > 0:
                    bits.append("withdraws routes")
                if body + 2 + wlen + 2 <= n:
                    palen = struct.unpack_from("!H", pkt, body + 2 + wlen)[0]
                    if palen > 0:
                        bits.append("advertises routes")
                    elif wlen == 0:
                        bits.append("end-of-RIB / keepalive-style")
                fields = {"withdrawn_len": wlen}
                hint = (" — " + ", ".join(bits)) if bits else ""
            detail = ("BGP UPDATE%s. Carries the actual reachability "
                      "information exchanged once the session is established."
                      % hint)
        elif mtype == 3 and body + 2 <= n:          # NOTIFICATION
            code, sub = pkt[body], pkt[body + 1]
            reason = _bgp_notif_reason(code, sub)
            fields = {"code": code, "subcode": sub, "reason": reason}
            detail = ("BGP NOTIFICATION — tearing the session down: %s. The "
                      "sender then closes the TCP connection." % reason)
            severity = "warn"
        elif mtype == 4:                            # KEEPALIVE
            detail = ("BGP KEEPALIVE — heartbeat proving the peer is alive; "
                      "sent at ~1/3 of the negotiated hold-time.")
        elif mtype == 5:                            # ROUTE-REFRESH
            detail = ("BGP ROUTE-REFRESH — asking the peer to re-advertise its "
                      "routes (e.g. after an inbound policy change).")
        else:
            detail = "BGP %s message." % label
        msgs.append({"type": mtype, "label": label, "detail": detail,
                     "severity": severity, "fields": fields})
        i += mlen
    return msgs


# ---- the per-link flow tracker (state for reset reasoning) --------------------

class FlowTracker:
    """Tracks the single BGP TCP flow on one p2p link so the ladder can explain
    handshakes and *why* a session reset. One instance per watcher process.

    Keyed canonically by the unordered IP/port 4-tuple so both directions land
    in the same flow record. `dir_ab` (A->B) is preserved per event for the UI.
    """

    def __init__(self, bgp_port=179):
        self.bgp_port = bgp_port
        self.flows = {}            # key -> {"state","last_notif","last_notif_ts"}

    @staticmethod
    def _key(src, dst, sp, dp):
        a, b = (src, sp), (dst, dp)
        return (a, b) if a <= b else (b, a)

    def process(self, pkt, wirelen, dir_ab, ts):
        info = _ip_tcp(pkt)
        if info is None:
            return []
        src, dst, sport, dport, flags, poff, plen = info
        is_bgp = (sport == self.bgp_port or dport == self.bgp_port)
        if not is_bgp:
            return []
        events = []
        key = self._key(src, dst, sport, dport)
        fl = self.flows.setdefault(key, {"state": "new", "last_notif": None,
                                         "last_notif_ts": 0.0})
        d = "ab" if dir_ab else "ba"
        syn, ack = bool(flags & 0x02), bool(flags & 0x10)
        rst, fin = bool(flags & 0x04), bool(flags & 0x01)

        def ev(proto, kind, label, detail, severity="info", fields=None):
            events.append({"ts": ts, "dir": d, "proto": proto, "kind": kind,
                           "label": label, "detail": detail,
                           "severity": severity, "fields": fields or {}})

        # --- TCP control plane (the :179 session itself) ---
        # initiator = the side NOT using port 179 as its source.
        opening = " to :%d" % self.bgp_port if dport == self.bgp_port else ""
        if syn and not ack:
            fl["state"] = "syn_sent"
            ev("TCP", "tcp_syn", "TCP SYN",
               "Opening the TCP connection that will carry BGP%s — the "
               "transport handshake before any BGP is spoken." % opening,
               "info")
        elif syn and ack:
            fl["state"] = "syn_rcvd"
            ev("TCP", "tcp_synack", "TCP SYN-ACK",
               "Peer accepts the TCP connection (a BGP listener is up on "
               ":%d). One more ACK completes the 3-way handshake."
               % self.bgp_port, "good")

        # The reset / teardown reasoning is the headline feature.
        if rst:
            prev = fl.get("state")
            recent_notif = (fl["last_notif"] is not None
                            and ts - fl["last_notif_ts"] <= 8)
            if prev in ("syn_sent", "new"):
                detail = ("TCP RST — connection refused. The peer is not "
                          "listening on :%d: BGP isn't configured for this "
                          "neighbor, an ACL/firewall is blocking it, or the "
                          "neighbor is shut. No BGP was ever spoken."
                          % self.bgp_port)
                sev = "warn"
            elif recent_notif:
                detail = ("TCP RST closing the connection right after a BGP "
                          "NOTIFICATION (%s) — this is the orderly half of a "
                          "BGP teardown: NOTIFICATION states the reason, RST "
                          "drops the socket." % fl["last_notif"])
                sev = "event"
            else:
                detail = ("TCP RST — the BGP session was reset abruptly with no "
                          "preceding NOTIFICATION. Typical causes: hold-timer "
                          "expiry (peer stopped hearing keepalives), the link "
                          "going down, or a forced 'clear ip bgp'.")
                sev = "warn"
            fl["state"] = "reset"
            ev("TCP", "tcp_rst", "RST", detail, sev)
        elif fin:
            ev("TCP", "tcp_fin", "TCP FIN",
               "Graceful TCP close of the BGP session.", "info")
        elif ack and not syn and plen == 0:
            # Bare ACK: the handshake-completing one is informative; the rest
            # are keepalive noise and are suppressed to keep the ladder readable.
            if fl["state"] == "syn_rcvd":
                fl["state"] = "established"
                ev("TCP", "tcp_established", "ACK",
                   "TCP 3-way handshake complete — the transport is up; BGP "
                   "OPEN messages follow next.", "good")

        # --- BGP messages riding this segment ---
        if plen > 0 and poff < len(pkt):
            for m in _parse_bgp_messages(pkt, poff):
                kind = "bgp_" + m["label"].lower().replace("-", "_")
                if m["type"] == 3:                  # remember for RST reasoning
                    fl["last_notif"] = m["fields"].get("reason", "error")
                    fl["last_notif_ts"] = ts
                ev("BGP", kind, m["label"], m["detail"], m["severity"],
                   m["fields"])

        return events


# ---- OSPF (IP proto 89) ------------------------------------------------------

OSPF_TYPES = {1: "Hello", 2: "DBD", 3: "LSR", 4: "LSU", 5: "LSAck"}

def decode_ospf(pkt, wirelen, dir_ab, ts):
    try:
        info = _ipv4(pkt)
        if not info or info[2] != 89:
            return []
        off, ihl, _proto, src, dst = info
        o = off + ihl
        if len(pkt) < o + 24:
            return []
        otype = pkt[o + 1]
        rid = socket.inet_ntop(socket.AF_INET, pkt[o + 4:o + 8])
        area = socket.inet_ntop(socket.AF_INET, pkt[o + 8:o + 12])
        label = OSPF_TYPES.get(otype, "type %d" % otype)
        fields = {"router_id": rid, "area": area}
        b = o + 24
        sev = "info"
        if otype == 1 and len(pkt) >= b + 20:                 # Hello
            hello = struct.unpack_from("!H", pkt, b + 4)[0]
            dead = struct.unpack_from("!I", pkt, b + 8)[0]
            dr = socket.inet_ntop(socket.AF_INET, pkt[b + 12:b + 16])
            bdr = socket.inet_ntop(socket.AF_INET, pkt[b + 16:b + 20])
            # Neighbour Router IDs the sender has heard from (b+20 .. OSPF len).
            # This list is what distinguishes Init (one-way) from 2-Way: the
            # adjacency is 2-Way once each end lists the other's RID.
            olen = struct.unpack_from("!H", pkt, o + 2)[0]
            nend = min(len(pkt), o + olen) if olen >= 24 else len(pkt)
            seen = []
            q = b + 20
            while q + 4 <= nend and len(seen) < 32:
                seen.append(socket.inet_ntop(socket.AF_INET, pkt[q:q + 4]))
                q += 4
            fields.update({"hello_interval": hello, "dead_interval": dead,
                           "DR": dr, "BDR": bdr,
                           "neighbors": ",".join(seen) if seen else "(none)"})
            detail = ("OSPF Hello — discovers neighbours and keeps the adjacency "
                      "alive (every %ds, dead %ds); the neighbour list it carries "
                      "[%s] is how the two ends confirm they hear each other "
                      "(Init→2-Way). DR %s."
                      % (hello, dead, ",".join(seen) if seen else "none", dr))
            sev = "good"
        elif otype == 2 and len(pkt) >= b + 8:                # DBD
            flags = pkt[b + 3]
            bits = []
            if flags & 0x04: bits.append("Init")
            if flags & 0x02: bits.append("More")
            if flags & 0x01: bits.append("Master")
            fields["flags"] = ",".join(bits) or "Slave"
            detail = ("OSPF Database Description — the routers compare LSA headers "
                      "to sync their link-state databases; the I/M/MS bits "
                      "negotiate master/slave and more-to-come. [%s]" % fields["flags"])
            sev = "good"
        elif otype == 3:
            detail = ("OSPF Link-State Request — asks the neighbour for the full "
                      "copy of specific LSAs found newer during the DBD exchange.")
        elif otype == 4:                                      # LSU
            n = struct.unpack_from("!I", pkt, b)[0] if len(pkt) >= b + 4 else 0
            fields["lsa_count"] = n
            detail = ("OSPF Link-State Update — carries %d LSA(s): the actual "
                      "topology/route information that builds the SPF tree." % n)
        elif otype == 5:
            detail = ("OSPF LSAck — acknowledges received LSAs so flooding is "
                      "reliable.")
        else:
            detail = "OSPF %s packet." % label
        return [_ev(ts, dir_ab, "OSPF", "ospf_" + label.lower(), label, detail,
                    sev, fields)]
    except Exception:
        return []


# ---- EIGRP (IP proto 88) -----------------------------------------------------

EIGRP_OPS = {1: "Update", 2: "Request", 3: "Query", 4: "Reply", 5: "Hello",
             10: "SIA-Query", 11: "SIA-Reply"}

def decode_eigrp(pkt, wirelen, dir_ab, ts):
    try:
        info = _ipv4(pkt)
        if not info or info[2] != 88:
            return []
        off, ihl, _proto, src, dst = info
        o = off + ihl
        if len(pkt) < o + 20:
            return []
        opcode = pkt[o + 1]
        flags = struct.unpack_from("!I", pkt, o + 4)[0]
        seq = struct.unpack_from("!I", pkt, o + 8)[0]
        ack = struct.unpack_from("!I", pkt, o + 12)[0]
        asn = struct.unpack_from("!H", pkt, o + 18)[0]
        label = EIGRP_OPS.get(opcode, "opcode %d" % opcode)
        fields = {"as": asn, "seq": seq, "ack": ack, "flags": "0x%08x" % flags}
        sev = "info"
        # A Hello's first Parameters TLV (type 0x0001) carries K1..K6; a Goodbye
        # (graceful shutdown / K-value mismatch reject) sets K1..K5 all to 255.
        kvals = None
        if opcode == 5 and len(pkt) >= o + 30:
            tp = struct.unpack_from("!H", pkt, o + 20)[0]
            if tp == 0x0001:
                kvals = pkt[o + 24:o + 30]            # K1..K6
        if opcode == 5 and kvals and all(b == 0xFF for b in kvals[:5]):
            label = "Goodbye"
            fields["kvalues"] = "K1-K5 = 255 (goodbye)"
            detail = ("EIGRP Goodbye — the neighbour is announcing it is going "
                      "away (K-values all 255). Sent on a graceful shutdown, or "
                      "to reject a peer whose K-values don't match; the adjacency "
                      "drops.")
            sev = "warn"
        elif opcode == 5:
            if kvals:
                fields["kvalues"] = ".".join(str(b) for b in kvals[:5])
            if ack:
                label = "Hello (ACK)"
                detail = ("EIGRP Hello/ACK — acknowledges a reliably-sent packet "
                          "(ack=%d). Plain Hellos (every 5s) keep the neighbour up." % ack)
            else:
                detail = ("EIGRP Hello — neighbour discovery/keepalive (every 5s); "
                          "carries the K-values and hold time that must match to "
                          "form an adjacency.")
        elif opcode == 1:
            detail = ("EIGRP Update — advertises routes to the neighbour "
                      "(reliable, acked); sent on topology change or a new adjacency.")
        elif opcode == 3:
            detail = ("EIGRP Query — DUAL went active for a route with no feasible "
                      "successor; the router asks neighbours for an alternate path.")
            sev = "warn"
        elif opcode == 4:
            detail = ("EIGRP Reply — answers a Query with this router's distance "
                      "to the destination.")
        elif opcode in (10, 11):
            detail = ("EIGRP Stuck-In-Active %s — the query is taking too long; "
                      "this keeps the neighbour from being torn down."
                      % ("Query" if opcode == 10 else "Reply"))
            sev = "warn"
        elif opcode == 2:
            detail = "EIGRP Request — asks for specific route information."
        else:
            detail = "EIGRP %s." % label
        return [_ev(ts, dir_ab, "EIGRP", "eigrp_" + label.split()[0].lower(),
                    label, detail, sev, fields)]
    except Exception:
        return []


# ---- GRE (IP proto 47) -------------------------------------------------------

GRE_INNER = {0x0800: "IPv4", 0x86DD: "IPv6", 0x8847: "MPLS",
             0x6558: "Ethernet (bridged)", 0x880B: "PPP", 0x0000: "none"}

def decode_gre(pkt, wirelen, dir_ab, ts):
    try:
        info = _ipv4(pkt)
        if not info or info[2] != 47:
            return []
        off, ihl, _proto, src, dst = info
        o = off + ihl
        if len(pkt) < o + 4:
            return []
        fv = struct.unpack_from("!H", pkt, o)[0]
        ptype = struct.unpack_from("!H", pkt, o + 2)[0]
        ver = fv & 0x07
        inner = GRE_INNER.get(ptype, "0x%04x" % ptype)
        fl = []
        if fv & 0x8000: fl.append("Checksum")
        if fv & 0x2000: fl.append("Key")
        if fv & 0x1000: fl.append("Seq")
        fields = {"tunnel": "%s → %s" % (src, dst), "inner": inner,
                  "version": ver, "flags": ",".join(fl) or "none"}
        if ptype == 0x0000:
            return [_ev(ts, dir_ab, "GRE", "gre_keepalive", "GRE keepalive",
                "GRE keepalive — a looped probe proving the tunnel path to the "
                "far end is up. If these stop arriving, the tunnel interface goes "
                "down.", "good", fields)]
        detail = ("GRE — tunnel %s → %s carrying %s. A point-to-point "
                  "encapsulation; the inner packet rides inside this outer IP "
                  "header." % (src, dst, inner))
        return [_ev(ts, dir_ab, "GRE", "gre", "GRE (" + inner + ")", detail,
                    "info", fields)]
    except Exception:
        return []


# ---- STP / RSTP / MSTP (802.1D/w/s BPDUs) -----------------------------------

_STP_ROLES = {0: "Unknown", 1: "Alternate/Backup", 2: "Root", 3: "Designated"}

def decode_stp(pkt, wirelen, dir_ab, ts):
    try:
        base = _llc_base(pkt)
        if base is None or len(pkt) < base + 4:
            return []
        dsap = pkt[base]
        if dsap == 0x42:            # IEEE 802.1D LLC (42 42 03)
            bo = base + 3
        elif dsap == 0xAA:          # SNAP — Cisco PVST+/Rapid-PVST
            bo = base + 8           # LLC(3) + OUI(3) + PID(2)
        else:
            return []
        if len(pkt) < bo + 4:
            return []
        version = pkt[bo + 2]
        btype = pkt[bo + 3]
        if btype == 0x80:           # classic TCN BPDU
            return [_ev(ts, dir_ab, "STP", "stp_tcn", "TCN",
                "STP Topology Change Notification — a switch saw a port go up or "
                "down and is signalling toward the root bridge, which shortens "
                "MAC-table aging so the network reconverges.", "event")]
        flags = pkt[bo + 4] if len(pkt) > bo + 4 else 0
        rootid = _bridge_id(pkt[bo + 5:bo + 13]) if len(pkt) >= bo + 13 else "?"
        cost = struct.unpack_from("!I", pkt, bo + 13)[0] if len(pkt) >= bo + 17 else 0
        bridgeid = _bridge_id(pkt[bo + 17:bo + 25]) if len(pkt) >= bo + 25 else "?"
        portid = struct.unpack_from("!H", pkt, bo + 25)[0] if len(pkt) >= bo + 27 else 0
        role = _STP_ROLES[(flags >> 2) & 0x3]
        fl = []
        if flags & 0x01: fl.append("TopologyChange")
        if flags & 0x02: fl.append("Proposal")
        if flags & 0x40: fl.append("Agreement")
        if flags & 0x80: fl.append("TC-Ack")
        state = "forwarding" if flags & 0x20 else ("learning" if flags & 0x10
                                                   else "discarding")
        fields = {"root": rootid, "cost": cost, "bridge": bridgeid,
                  "port": "0x%04x" % portid, "flags": ",".join(fl) or "none"}
        sev = "event" if (flags & 0x01) else ("good" if (flags & 0x42) else "info")
        if btype == 0x00:                                     # Config BPDU (STP)
            fields["variant"] = "STP (802.1D)"
            detail = ("STP Configuration BPDU — advertises root bridge %s (path "
                      "cost %d) from bridge %s port 0x%04x. These elect the root "
                      "and build the loop-free tree (~every 2s)."
                      % (rootid, cost, bridgeid, portid))
            return [_ev(ts, dir_ab, "STP", "stp_config", "Config BPDU", detail,
                        sev, fields)]
        if btype == 0x02:                                     # RST / MST BPDU
            fields["role"] = role
            fields["state"] = state
            if version >= 3:
                fields["variant"] = "MSTP (802.1s)"
                detail = ("MSTP BPDU — carries the CIST plus per-instance (MSTI) "
                          "spanning-tree info. Port role: %s, %s%s. The proposal/"
                          "agreement handshake converges the region rapidly."
                          % (role, state, (", " + ",".join(fl)) if fl else ""))
                return [_ev(ts, dir_ab, "STP", "stp_mst", "MST BPDU", detail,
                            sev, fields)]
            fields["variant"] = "RSTP (802.1w)"
            detail = ("RSTP BPDU — rapid spanning tree. Port role: %s, %s%s. The "
                      "proposal/agreement handshake lets a link start forwarding "
                      "without the old 30s listen/learn timers."
                      % (role, state, (", " + ",".join(fl)) if fl else ""))
            return [_ev(ts, dir_ab, "STP", "stp_rst", "RST BPDU", detail, sev, fields)]
        return []
    except Exception:
        return []


# ---- IS-IS (LLC 0xFEFE, over L2) --------------------------------------------

_ISIS_TYPES = {15: ("IIH", "L1 LAN Hello"), 16: ("IIH", "L2 LAN Hello"),
               17: ("IIH", "Point-to-point Hello"), 18: ("LSP", "L1 LSP"),
               20: ("LSP", "L2 LSP"), 24: ("CSNP", "L1 CSNP"),
               25: ("CSNP", "L2 CSNP"), 26: ("PSNP", "L1 PSNP"),
               27: ("PSNP", "L2 PSNP")}

def decode_isis(pkt, wirelen, dir_ab, ts):
    try:
        base = _llc_base(pkt)
        if base is None or len(pkt) < base + 8:
            return []
        if pkt[base] != 0xFE or pkt[base + 1] != 0xFE:        # LLC FE FE
            return []
        if pkt[base + 3] != 0x83:                             # IRPD = IS-IS
            return []
        ptype = pkt[base + 7] & 0x1F
        td = _ISIS_TYPES.get(ptype)
        if not td:
            return []
        short, longn = td
        fields = {"pdu": longn, "type": ptype}
        if short == "IIH":
            detail = ("IS-IS Hello (IIH) — %s. Discovers and keeps the adjacency "
                      "alive; carries the system ID, holding time and supported "
                      "protocols." % longn)
            sev = "good"
        elif short == "LSP":
            detail = ("IS-IS Link State PDU (%s) — floods this router's links and "
                      "prefixes into the area database; the basis for SPF." % longn)
            sev = "info"
        elif short == "CSNP":
            detail = ("IS-IS Complete SNP (%s) — a full summary of the LSP database "
                      "so neighbours can spot missing or stale LSPs." % longn)
            sev = "info"
        else:
            detail = ("IS-IS Partial SNP (%s) — requests missing LSPs or "
                      "acknowledges received ones (reliable flooding)." % longn)
            sev = "info"
        return [_ev(ts, dir_ab, "IS-IS", "isis_" + short.lower(), short, detail,
                    sev, fields)]
    except Exception:
        return []


# ---- decoder dispatch --------------------------------------------------------

_STATELESS = {"ospf": decode_ospf, "eigrp": decode_eigrp, "gre": decode_gre,
              "stp": decode_stp, "isis": decode_isis}

def make_decoder(proto):
    """Return a callable (pkt, wirelen, dir_ab, ts) -> [event,...] for the proto.
    BGP carries TCP session state, so it gets a FlowTracker instance; the rest
    are stateless per-packet dissectors."""
    if proto == "bgp":
        return FlowTracker(bgp_port=179).process
    fn = _STATELESS.get(proto)
    if fn is None:
        raise ValueError("unknown proto %s" % proto)
    return fn


# ---- derived FSM layer (Convergence Timeline) --------------------------------
# The packet ladder shows what crossed the wire; the FSM layer derives the
# protocol *state machine* from that same event stream so the UI can render a
# scrubbable Idle->Established / Down->Full timeline in lockstep with the ladder.
#
# These trackers consume the dicts the decoders already emit — they never
# re-parse packets, so the decoders stay untouched. One instance per watcher
# (single session-level FSM per link; on a p2p link both ends converge
# near-symmetrically, which is the clearest teaching abstraction). Each call to
# observe(event) returns a transition dict {from,to,by_seq,ts,reason} when the
# state changes, else None.
#
# Mid-capture honesty: when a capture starts on an already-up session there is
# no handshake to observe, so the tracker seeds the steady state and flips
# `seeded` true; the UI labels that case "already up when capture started".

FSM_MODELS = {
    "bgp": ["Idle", "Connect/Active", "OpenSent", "OpenConfirm", "Established"],
    "ospf": ["Down", "Init", "2-Way", "ExStart", "Exchange", "Loading", "Full"],
    "eigrp": ["Down", "Up"],
    "isis": ["Down", "Up"],
}


class _Fsm:
    """Base: holds the current state and emits a transition when it changes."""
    model = []

    def __init__(self):
        self.current = self.model[0]
        self.seeded = False

    def _go(self, to, ev, reason):
        if to == self.current:
            return None
        frm = self.current
        self.current = to
        return {"from": frm, "to": to, "by_seq": ev.get("seq"),
                "ts": ev.get("ts"), "reason": reason}

    def observe(self, ev):                       # pragma: no cover - overridden
        return None


class _BgpFsm(_Fsm):
    """Idle -> Connect/Active -> OpenSent -> OpenConfirm -> Established, driven by
    the TCP handshake + BGP OPEN/KEEPALIVE, back to Idle on NOTIFICATION/RST/FIN.
    The teardown `reason` reuses the plain-English text the FlowTracker wrote."""
    model = FSM_MODELS["bgp"]

    def __init__(self):
        super().__init__()
        self._open_dirs = set()
        self._handshake = False        # any TCP/OPEN bring-up evidence seen yet

    def observe(self, ev):
        k = ev.get("kind", "")
        if k in ("tcp_syn", "tcp_synack", "tcp_established", "bgp_open"):
            self._handshake = True
        if k == "tcp_syn":
            return self._go("Connect/Active", ev, "TCP SYN — opening transport")
        if k == "tcp_synack":
            return self._go("Connect/Active", ev, "TCP handshake")
        if k == "bgp_open":
            self._open_dirs.add(ev.get("dir"))
            if len(self._open_dirs) >= 2:
                return self._go("OpenConfirm", ev, "both peers sent OPEN")
            return self._go("OpenSent", ev, "OPEN sent — proposing the session")
        if k == "bgp_keepalive":
            if self.current in ("OpenSent", "OpenConfirm"):
                return self._go("Established", ev, "KEEPALIVE — session is up")
            if self.current == "Idle" and not self._handshake:
                self.seeded = True
                return self._go("Established", ev,
                                "session already up when capture started")
            return None
        if k == "bgp_update":
            if self.current == "Idle" and not self._handshake:
                self.seeded = True
                return self._go("Established", ev,
                                "session already up when capture started")
            return None
        if k in ("bgp_notification", "tcp_rst", "tcp_fin"):
            reason = (ev.get("fields", {}).get("reason")
                      or ("BGP NOTIFICATION" if k == "bgp_notification"
                          else "TCP reset" if k == "tcp_rst" else "TCP close"))
            self._open_dirs.clear()
            self._handshake = False
            return self._go("Idle", ev, reason)
        return None


class _OspfFsm(_Fsm):
    """Down -> Init -> 2-Way -> ExStart -> Exchange -> Loading -> Full.

    Init vs 2-Way is read from the Hello neighbour lists (a router lists the
    RIDs it has heard; the adjacency is 2-Way once the two ends list each
    other). DBD flags drive ExStart/Exchange (Init bit) and completion (More
    bit). A stable Full adjacency sends no DBDs, so any DBD means not-Full and
    an Init-DBD => ExStart (this catches an MTU-stuck EXSTART, which keeps
    retransmitting Init-DBDs). When the capture starts on an already-up
    adjacency we only ever see Hellos; a real bring-up's DBDs would appear
    within a hello interval or two of 2-Way, so we wait past that window before
    seeding the operational (Full) state — otherwise we'd flash Full during a
    genuine Init/2-Way bring-up."""
    model = FSM_MODELS["ospf"]

    def __init__(self):
        super().__init__()
        self._listed = {}            # router_id -> set(RIDs it has heard)
        self._saw_dbd = False
        self._dbd_done = False        # a final DBD (More cleared) was seen
        self._hellos = 0
        self._hello_interval = 10
        self._dead_interval = 40
        self._twoway_ts = None
        self._dr_ts = None            # first Hello with a non-zero DR (elected)

    def _mutual(self):
        for a, heard in self._listed.items():
            for b in heard:
                if a in self._listed.get(b, ()):
                    return True
        return False

    def observe(self, ev):
        k = ev.get("kind", "")
        f = ev.get("fields", {})
        if k == "ospf_hello":
            self._hellos += 1
            hi = f.get("hello_interval")
            if isinstance(hi, int) and hi > 0:
                self._hello_interval = hi
            di = f.get("dead_interval")
            if isinstance(di, int) and di > 0:
                self._dead_interval = di
            dr = f.get("DR")
            if self._dr_ts is None and dr and dr != "0.0.0.0":
                self._dr_ts = ev.get("ts")   # DR elected: past the wait timer
            src = f.get("router_id")
            if src:
                nb = str(f.get("neighbors", ""))
                self._listed[src] = set(x for x in nb.split(",")
                                        if x and x != "(none)")
            mutual = self._mutual()
            # The DB-description exchange has actually finished (final More-
            # cleared DBD) with nothing to load, so steady Hellos mean Full.
            # NB: Hellos flow throughout an adjacency's life — a Hello mid-
            # exchange is NOT proof of completion, hence the _dbd_done gate.
            if self.current == "Exchange" and self._dbd_done:
                return self._go("Full", ev, "exchange complete — adjacency Full")
            if self.current in ("Down", "Init"):
                if mutual:
                    if self._twoway_ts is None:
                        self._twoway_ts = ev.get("ts")
                    return self._go("2-Way", ev,
                                    "neighbours list each other — 2-Way")
                if self.current == "Down":
                    return self._go("Init", ev,
                                    "Hello — neighbour discovered (one-way so far)")
                return None
            # Already-operational adjacency: only Hellos, no DBD exchange to
            # witness. We must not seed Full during a real bring-up's 2-Way
            # phase — on a broadcast segment that includes the DR-election wait
            # timer (= dead interval, ~40s), a legitimately long 2-Way period.
            #   * DR already elected (non-zero DR in the Hello): the wait is over
            #     and on a two-router link they're operational -> seed shortly.
            #   * No DR ever seen: either point-to-point (no DR, instant ExStart)
            #     or broadcast still inside its wait. Hold off past the dead
            #     interval so we never seed during the wait; a real bring-up's
            #     DBDs arrive first and take the ExStart path instead.
            if (self.current == "2-Way" and not self._saw_dbd
                    and self._twoway_ts is not None):
                now = ev.get("ts", 0)
                if self._dr_ts is not None:
                    ready = now - self._dr_ts >= 2 * self._hello_interval
                else:
                    ready = (now - self._twoway_ts
                             >= self._dead_interval + 2 * self._hello_interval)
                if ready:
                    self.seeded = True
                    return self._go("Full", ev,
                                    "adjacency already operational when capture "
                                    "started (Hello-only — no bring-up witnessed)")
            return None
        if k == "ospf_dbd":
            self._saw_dbd = True
            fl = str(f.get("flags", ""))
            init, more = ("Init" in fl), ("More" in fl)
            # A stable Full adjacency sends NO DBDs — DBDs only flow during
            # (re)synchronisation. So any DBD means we are not Full, and an
            # Init-DBD (master/slave negotiation) means ExStart. This also
            # corrects a Full that was seeded from early Hellos before the DBD
            # exchange showed up in the capture (e.g. a flapping/MTU-stuck peer).
            if init:
                if self.current != "ExStart":
                    self._dbd_done = False
                    self.seeded = False
                    resync = " (re-syncing)" if self.current == "Full" else ""
                    return self._go("ExStart", ev,
                                    "DBD — negotiating master/slave" + resync)
                return None        # stuck retransmitting Init (MTU): stay ExStart
            # Init cleared: master/slave agreed, real DB-summary DBDs flowing.
            if self.current != "Exchange":
                self.seeded = False
                return self._go("Exchange", ev,
                                "DBD exchange — comparing databases")
            if not more:
                self._dbd_done = True      # final DBD: description complete
            return None
        if k in ("ospf_lsr", "ospf_lsu"):
            if self.current == "Exchange":
                return self._go("Loading", ev, "LSR/LSU — pulling missing LSAs")
            return None
        if k == "ospf_lsack":
            if self.current in ("Exchange", "Loading"):
                return self._go("Full", ev, "LSAck — databases synchronized")
            return None
        return None


class _SimpleAdjFsm(_Fsm):
    """Down <-> Up adjacency lane. EIGRP/IS-IS don't expose a multi-step bring-up
    handshake the way BGP/OSPF do, but an adjacency still requires *bidirectional*
    Hellos — one-way Hellos mean the far end isn't running the protocol (or can't
    form), so we only declare Up once adjacency traffic is seen in BOTH
    directions. Up is seeded (we can't witness the precise formation); Down comes
    from a teardown signal if the protocol has one."""
    model = ["Down", "Up"]
    up_kinds = ()
    down_kinds = ()

    def __init__(self):
        super().__init__()
        self._up_dirs = set()

    def _up_ok(self, ev):
        return True              # subclass hook (e.g. EIGRP AS-match)

    def observe(self, ev):
        k = ev.get("kind", "")
        if self.current == "Up" and k in self.down_kinds:
            self._up_dirs.clear()
            return self._go("Down", ev, "neighbour torn down")
        if k in self.up_kinds:
            self._up_dirs.add(ev.get("dir"))
            if (self.current == "Down" and len(self._up_dirs) >= 2
                    and self._up_ok(ev)):
                self.seeded = True
                return self._go("Up", ev, "adjacency active (Hellos both ways)")
        return None


class _EigrpFsm(_SimpleAdjFsm):
    # Any adjacency-bearing packet keeps the neighbour up; a Goodbye (K-values
    # all 255 — shutdown or K-value mismatch) tears it down. Up additionally
    # requires both ends to advertise the SAME AS (a mismatched AS never forms).
    up_kinds = ("eigrp_hello", "eigrp_update", "eigrp_query", "eigrp_reply")
    down_kinds = ("eigrp_goodbye",)

    def __init__(self):
        super().__init__()
        self._as_by_dir = {}

    def _up_ok(self, ev):
        a = ev.get("fields", {}).get("as")
        self._as_by_dir[ev.get("dir")] = a
        return len(set(self._as_by_dir.values())) == 1     # AS agrees both ways

    def observe(self, ev):
        # record AS per direction even before both ends are seen
        if ev.get("kind", "") in self.up_kinds:
            self._as_by_dir.setdefault(ev.get("dir"),
                                       ev.get("fields", {}).get("as"))
        tr = super().observe(ev)
        if tr and tr["to"] == "Down":
            tr["reason"] = "EIGRP Goodbye (K-values 255) — adjacency down"
        elif tr and tr["to"] == "Up":
            tr["reason"] = ("both ends exchanging EIGRP (AS %s)"
                            % ev.get("fields", {}).get("as"))
        return tr


class _IsisFsm(_SimpleAdjFsm):
    # IS-IS needs IIHs both ways to form; teardown is only via hold-timer expiry
    # (no teardown PDU), so passively we show Up but not a clean Down.
    up_kinds = ("isis_iih",)


_FSM_CLASSES = {"bgp": _BgpFsm, "ospf": _OspfFsm, "eigrp": _EigrpFsm,
                "isis": _IsisFsm}


def make_fsm(proto):
    """Return a fresh FSM tracker for `proto`, or None if the protocol has no
    state-machine model (STP/GRE are stateless — the UI just hides the track)."""
    cls = _FSM_CLASSES.get(proto)
    return cls() if cls else None


# ---- self-test (run directly: python3 pnet_protodecode.py) -------------------

if __name__ == "__main__":
    import sys

    def _a(s):  # ascii-safe for the Windows console; the real strings are UTF-8
        return s.encode("ascii", "replace").decode()

    def eth_ip_tcp(src, dst, sport, dport, flags, payload=b""):
        # minimal IPv4/TCP frame builder for the self-test
        tcp = struct.pack("!HHIIBBHHH", sport, dport, 0, 0,
                          (5 << 4), flags, 0, 0, 0) + payload
        iplen = 20 + len(tcp)
        ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, iplen, 0, 0, 64, 6, 0,
                         socket.inet_aton(src), socket.inet_aton(dst)) + tcp
        return b"\x00" * 12 + b"\x08\x00" + ip

    def bgp(mtype, body=b""):
        return BGP_MARKER + struct.pack("!HB", 19 + len(body), mtype) + body

    ft = FlowTracker()
    t = 1000.0
    A, B = "10.0.0.1", "10.0.0.2"
    seq = []
    # handshake
    seq.append((eth_ip_tcp(A, B, 50000, 179, 0x02), True))         # SYN
    seq.append((eth_ip_tcp(B, A, 179, 50000, 0x12), False))        # SYN-ACK
    seq.append((eth_ip_tcp(A, B, 50000, 179, 0x10), True))         # ACK
    # OPEN both ways
    openbody = struct.pack("!BHH4sB", 4, 65001, 180,
                           socket.inet_aton("1.1.1.1"), 0)
    seq.append((eth_ip_tcp(A, B, 50000, 179, 0x18, bgp(1, openbody)), True))
    seq.append((eth_ip_tcp(B, A, 179, 50000, 0x18,
                           bgp(1, struct.pack("!BHH4sB", 4, 65002, 180,
                               socket.inet_aton("2.2.2.2"), 0))), False))
    # keepalives
    seq.append((eth_ip_tcp(A, B, 50000, 179, 0x18, bgp(4)), True))
    # notification: Cease / administrative shutdown, then RST
    seq.append((eth_ip_tcp(A, B, 50000, 179, 0x18,
                           bgp(3, bytes([6, 2]))), True))
    seq.append((eth_ip_tcp(A, B, 50000, 179, 0x14), True))         # RST+ACK

    fails = 0
    for pkt, ab in seq:
        for e in ft.process(pkt, len(pkt), ab, t):
            arrow = "A->B" if e["dir"] == "ab" else "B->A"
            print("%-5s %-4s %-14s | %s" % (arrow, e["proto"], e["label"],
                                            _a(e["detail"])))
        t += 1.0

    # connection-refused path on a fresh flow
    print("--- refused ---")
    ft2 = FlowTracker()
    for pkt, ab in [(eth_ip_tcp(A, B, 50001, 179, 0x02), True),
                    (eth_ip_tcp(B, A, 179, 50001, 0x14), False)]:
        for e in ft2.process(pkt, len(pkt), ab, t):
            arrow = "A->B" if e["dir"] == "ab" else "B->A"
            print("%-5s %-4s %-14s | %s" % (arrow, e["proto"], e["label"],
                                            _a(e["detail"])))

    # --- stateless dissectors: craft one frame each and confirm it decodes ---
    print("--- ospf/eigrp/gre/stp/isis ---")

    def eth_ipproto(proto, body, src=A, dst=B):
        ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(body), 0, 0, 64,
                         proto, 0, socket.inet_aton(src), socket.inet_aton(dst)) + body
        return b"\x00" * 12 + b"\x08\x00" + ip

    def eth_llc(dstmac, llc_and_body):
        # 802.3: dst(6) src(6) len(2) + LLC/payload
        ln = struct.pack("!H", len(llc_and_body))
        return dstmac + b"\x52\x54\x00\x00\x00\x01" + ln + llc_and_body

    checks = []
    # OSPF Hello: 24B hdr (ver,type,len,rid,area,csum,authtype,auth=8B) + body
    ospf_hdr = struct.pack("!BBH4s4sHHQ", 2, 1, 0, socket.inet_aton("1.1.1.1"),
                           socket.inet_aton("0.0.0.0"), 0, 0, 0)
    ospf_hello = (struct.pack("!4sHBBI4s4s", socket.inet_aton("255.255.255.0"),
                  10, 0, 1, 40, socket.inet_aton("1.1.1.1"),
                  socket.inet_aton("0.0.0.0")))
    checks.append(("OSPF", decode_ospf, eth_ipproto(89, ospf_hdr + ospf_hello)))
    # EIGRP Hello (opcode 5)
    eigrp = struct.pack("!BBHIIIHH", 2, 5, 0, 0, 0, 0, 0, 100)
    checks.append(("EIGRP", decode_eigrp, eth_ipproto(88, eigrp)))
    # GRE carrying IPv4
    gre = struct.pack("!HH", 0, 0x0800)
    checks.append(("GRE", decode_gre, eth_ipproto(47, gre)))
    # STP RST BPDU (SNAP/PVST+): LLC AA AA 03 + OUI 00000c + PID 010b + BPDU
    bpdu = (struct.pack("!HBB B", 0, 2, 0x02, 0x3c) +   # protoid,ver=2,type=2,flags
            b"\x80\x00" + b"\x00\x11\x22\x33\x44\x55" + struct.pack("!I", 4) +
            b"\x80\x00" + b"\x66\x77\x88\x99\xaa\xbb" + struct.pack("!H", 0x8001))
    snap = b"\xaa\xaa\x03" + b"\x00\x00\x0c" + b"\x01\x0b" + bpdu
    checks.append(("STP", decode_stp,
                   eth_llc(b"\x01\x00\x0c\xcc\xcc\xcd", snap)))
    # IS-IS P2P Hello: LLC FE FE 03 + IRPD 0x83 + len + ver + idlen + ptype(17)
    isis = b"\xfe\xfe\x03" + bytes([0x83, 0x14, 0x01, 0x00, 17, 0x01, 0x00, 0x00])
    checks.append(("IS-IS", decode_isis, eth_llc(b"\x09\x00\x2b\x00\x00\x05", isis)))

    for name, fn, frame in checks:
        evs = fn(frame, len(frame), True, t)
        if not evs:
            print("FAIL %-6s -> no event" % name); fails += 1
            continue
        e = evs[0]
        print("%-6s %-12s | %s" % (name, e["label"], _a(e["detail"][:64])))

    # --- derived FSM layer (Convergence Timeline) ---
    print("--- fsm ---")

    def run_fsm(proto, frames, dt=5.0):
        """Feed (frame, dir_ab) pairs through the decoder + FSM; return the
        ordered list of states the session transitioned *to*. dt = seconds
        between frames (drives the OSPF already-up seed's time gate)."""
        dec = make_decoder(proto)
        fsm = make_fsm(proto)
        states, sq, tt = [], 0, 3000.0
        for frame, ab in frames:
            for e in dec(frame, len(frame), ab, tt):
                e["seq"] = sq; sq += 1
                tr = fsm.observe(e)
                if tr:
                    states.append(tr["to"])
            tt += dt
        return states, fsm

    # BGP: reuse the handshake sequence built above (SYN..OPEN..KA..NOTIF..RST)
    bgp_states, _ = run_fsm("bgp", seq)
    bgp_want = ["Connect/Active", "OpenSent", "OpenConfirm", "Established", "Idle"]
    print("bgp:  " + " -> ".join(bgp_states))
    if bgp_states != bgp_want:
        print("FAIL bgp fsm: %r != %r" % (bgp_states, bgp_want)); fails += 1

    # OSPF: Hello(both) -> DBD(both) -> LSU -> LSAck  ==>  Down..Full
    def ospf_pkt(otype, body):
        hdr = struct.pack("!BBH4s4sHHQ", 2, otype, 0,
                          socket.inet_aton("1.1.1.1"),
                          socket.inet_aton("0.0.0.0"), 0, 0, 0)
        return eth_ipproto(89, hdr + body)

    def dbd(fl):                          # 8-byte DBD body; flags byte at off 3
        return bytes([0, 0, 0, fl, 0, 0, 0, 0])
    DBD_INIT = 0x07                       # Init+More+Master (master/slave neg)
    DBD_MORE = 0x03                       # More+Master (Init cleared: Exchange)
    DBD_LAST = 0x01                       # Master only (More cleared: final)
    lsu_body = b"\x00\x00\x00\x01"        # 1 LSA
    RA, RB = "2.2.2.2", "3.3.3.3"         # the two routers' RIDs

    def hello(src, neighbors, dr="0.0.0.0"):
        """OSPF Hello from `src` listing `neighbors` (RIDs it has heard); `dr`
        is the elected Designated Router (0.0.0.0 = none/p2p or DR-wait)."""
        body = (struct.pack("!4sHBBI4s4s", socket.inet_aton("255.255.255.0"),
                10, 0, 1, 40, socket.inet_aton(dr), socket.inet_aton("0.0.0.0"))
                + b"".join(socket.inet_aton(n) for n in neighbors))
        olen = 24 + len(body)
        hdr = struct.pack("!BBH4s4sHHQ", 2, 1, olen, socket.inet_aton(src),
                          socket.inet_aton("0.0.0.0"), 0, 0, 0)
        return eth_ipproto(89, hdr + body)

    # Fresh bring-up: one-way Hello -> Init, mutual Hellos -> 2-Way, then the
    # DBD/LSR/LSU/LSAck exchange -> ... -> Full. (Matches the real FSM.)
    ospf_frames = [
        (hello(RA, []), True),                # R_A hears no-one -> Init
        (hello(RB, [RA]), False),             # R_B hears A (one-way) -> stay Init
        (hello(RA, [RB]), True),              # mutual -> 2-Way
        (ospf_pkt(2, dbd(DBD_INIT)), True),   # DBD Init       -> ExStart
        (ospf_pkt(2, dbd(DBD_MORE)), False),  # DBD Init-clear -> Exchange
        (ospf_pkt(2, dbd(DBD_LAST)), True),   # DBD More-clear -> _dbd_done
        (ospf_pkt(4, lsu_body), True),        # LSU            -> Loading
        (ospf_pkt(5, b""), False),            # LSAck          -> Full
    ]
    ospf_states, _ = run_fsm("ospf", ospf_frames)
    ospf_want = ["Init", "2-Way", "ExStart", "Exchange", "Loading", "Full"]
    print("ospf: " + " -> ".join(ospf_states))
    if ospf_states != ospf_want:
        print("FAIL ospf fsm: %r != %r" % (ospf_states, ospf_want)); fails += 1

    # OSPF p2p bring-up, empty LSR list: no Loading, Hellos resume -> Full
    noload = [(hello(RA, []), True), (hello(RB, [RA]), False), (hello(RA, [RB]), True),
              (ospf_pkt(2, dbd(DBD_INIT)), True), (ospf_pkt(2, dbd(DBD_MORE)), False),
              (ospf_pkt(2, dbd(DBD_LAST)), True), (hello(RA, [RB]), False)]
    noload_states, _ = run_fsm("ospf", noload)
    noload_want = ["Init", "2-Way", "ExStart", "Exchange", "Full"]
    print("ospf (no Loading): " + " -> ".join(noload_states))
    if noload_states != noload_want:
        print("FAIL ospf no-load: %r != %r" % (noload_states, noload_want))
        fails += 1

    # OSPF stuck in EXSTART (MTU mismatch): mutual Hellos reach 2-Way, then
    # Init-DBDs retransmit forever (Init never clears) -> stays ExStart.
    stuck = [(hello(RA, [RB]), True), (hello(RB, [RA]), False)] + \
            [(ospf_pkt(2, dbd(DBD_INIT)), i % 2 == 0) for i in range(8)] + \
            [(hello(RA, [RB]), True)]
    stuck_states, stuck_fsm = run_fsm("ospf", stuck)
    print("ospf (MTU-stuck): " + " -> ".join(stuck_states) +
          " [current=" + stuck_fsm.current + "]")
    if stuck_states[-1] != "ExStart" or stuck_fsm.current != "ExStart" \
            or "Full" in stuck_states:
        print("FAIL ospf stuck: %r current=%s"
              % (stuck_states, stuck_fsm.current)); fails += 1

    # Fresh bring-up must NOT flash Full during Init/2-Way: a one-way Hello,
    # mutual Hello (2-Way), then DBDs within a hello interval. The time-gated
    # seed must not fire (DBDs arrive first). (The exact .222 complaint.)
    fresh = [(hello(RA, []), True), (hello(RB, [RA]), False), (hello(RA, [RB]), True),
             (ospf_pkt(2, dbd(DBD_INIT)), True)]
    fresh_states, fresh_fsm = run_fsm("ospf", fresh)
    print("ospf (fresh, no early Full): " + " -> ".join(fresh_states))
    if "Full" in fresh_states or fresh_states != ["Init", "2-Way", "ExStart"]:
        print("FAIL ospf fresh: %r" % fresh_states); fails += 1

    # Broadcast bring-up DR-wait: 2-Way reached, then a long Hello-only stretch
    # with DR=0.0.0.0 (the DR-election wait timer) before ExStart. Must NOT seed
    # Full during the wait — stays 2-Way until the DBDs start. (The .222 band
    # showed a spurious Full segment here.)
    drwait = [(hello(RA, []), True), (hello(RB, [RA]), False), (hello(RA, [RB]), True)]
    drwait += [(hello(RA, [RB]) if i % 2 else hello(RB, [RA]), i % 2 == 0)
               for i in range(6)]                       # ~30s of DR-wait Hellos
    drwait += [(ospf_pkt(2, dbd(DBD_INIT)), True)]       # DR elected -> ExStart
    drwait_states, _ = run_fsm("ospf", drwait)
    print("ospf (broadcast DR-wait): " + " -> ".join(drwait_states))
    if "Full" in drwait_states or drwait_states != ["Init", "2-Way", "ExStart"]:
        print("FAIL ospf dr-wait: %r" % drwait_states); fails += 1

    # Already-operational broadcast adjacency: mutual Hellos with the DR elected
    # (non-zero) and no DBD -> settles Init->2-Way->Full once the DR has been
    # stable for a couple of hello intervals.
    seed = [(hello(RA, [RB], dr="10.0.0.1") if i % 2 == 0
             else hello(RB, [RA], dr="10.0.0.1"), i % 2 == 0) for i in range(8)]
    seed_states, seed_fsm = run_fsm("ospf", seed)   # dt=5, hello=10 -> seed ~20s
    print("ospf seed: " + " -> ".join(seed_states) +
          (" (seeded)" if seed_fsm.seeded else ""))
    if seed_states[-1] != "Full" or not seed_fsm.seeded or "Full" in seed_states[:2]:
        print("FAIL ospf seed: %r seeded=%s" % (seed_states, seed_fsm.seeded))
        fails += 1

    # EIGRP adjacency lane. AS 100 both ways unless noted.
    def eigrp_hello(asn=100):
        return struct.pack("!BBHIIIHH", 2, 5, 0, 0, 0, 0, 0, asn)
    eigrp_goodbye = (eigrp_hello() + struct.pack("!HH", 0x0001, 12)
                     + bytes([255, 255, 255, 255, 255, 0]) + struct.pack("!H", 15))
    eh = lambda asn, ab: (eth_ipproto(88, eigrp_hello(asn)), ab)

    # one-way Hellos (far end not running EIGRP) must NOT come up
    oneway, _ = run_fsm("eigrp", [eh(100, True)] * 3)
    print("eigrp (one-way): %s" % (" -> ".join(oneway) or "(stays Down)"))
    if oneway:
        print("FAIL eigrp one-way: %r" % oneway); fails += 1

    # bidirectional but mismatched AS must NOT come up
    asmm, _ = run_fsm("eigrp", [eh(100, True), eh(200, False), eh(100, True)])
    if asmm:
        print("FAIL eigrp AS-mismatch: %r" % asmm); fails += 1

    # both ends, same AS -> Up; Goodbye -> Down; both ends -> Up
    eig = [eh(100, True), eh(100, False),                       # -> Up
           (eth_ipproto(88, eigrp_goodbye), False),             # Goodbye -> Down
           eh(100, True), eh(100, False)]                       # -> Up
    eig_states, _ = run_fsm("eigrp", eig)
    print("eigrp: " + " -> ".join(eig_states))
    if eig_states != ["Up", "Down", "Up"]:
        print("FAIL eigrp fsm: %r != ['Up','Down','Up']" % eig_states); fails += 1

    # IS-IS: one-way IIH stays Down; IIH both ways -> Up.
    isis_iih = b"\xfe\xfe\x03" + bytes([0x83, 0x14, 0x01, 0x00, 17, 0x01, 0x00, 0x00])
    ih = lambda ab: (eth_llc(b"\x09\x00\x2b\x00\x00\x05", isis_iih), ab)
    isis_oneway, _ = run_fsm("isis", [ih(True)] * 3)
    if isis_oneway:
        print("FAIL isis one-way: %r" % isis_oneway); fails += 1
    iss_states, iss_fsm = run_fsm("isis", [ih(True), ih(False)])
    print("isis:  " + " -> ".join(iss_states))
    if iss_states != ["Up"] or not iss_fsm.seeded:
        print("FAIL isis fsm: %r seeded=%s" % (iss_states, iss_fsm.seeded)); fails += 1

    sys.exit(fails)
