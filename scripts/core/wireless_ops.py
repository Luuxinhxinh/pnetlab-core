# -*- coding: utf-8 -*-
"""PNetLab Wireless, RoCE and VWiFi Operations (Clean Architecture Domain Module).

Extracted from pnetlab-brokerd.py to provide modular domain logic for:
- Wireless cell WLAN configuration & hostapd integration
- vwifi-server and airhandler-server daemon management
- WiFi packet capture & truth telemetry
- RoCE workload generation and agent health
- Orphaned QEMU cleanup for wireless & RXE nodes
"""

import os
import re
import json
import time
import signal
import socket
import struct
import subprocess
from typing import Dict, Any, Tuple, List

BASE = '/opt/unetlab'
RUN_DIR = '/run/pnetlab'

def log(msg: str) -> None:
    import sys
    print(msg, file=sys.stderr, flush=True)

class Reject(Exception):
    pass


def run(argv, timeout=60, stderr=None, check_rc=True):
    p = subprocess.run(argv, stdout=subprocess.PIPE,
                       stderr=stderr if stderr is not None else subprocess.PIPE,
                       timeout=timeout)
    out = p.stdout.decode('utf-8', 'replace').splitlines()
    err = '' if stderr is not None else p.stderr.decode('utf-8', 'replace')
    return p.returncode, out, err

def run_quiet(argv, timeout=60):
    try:
        return run(argv, timeout=timeout)[0]
    except subprocess.TimeoutExpired:
        return 124

def _qemu_quota_timer_unit(session):
    return 'pnetlab-qemu-quota-%d.timer' % session

def _cancel_qemu_quota_timer(session):
    timer = _qemu_quota_timer_unit(session)
    rc, out, err = run(['systemctl', 'stop', timer], timeout=30, check_rc=False)
    if rc not in (0, 5):
        log('WARNING qemu_cpu_scope session=%d timer stop failed: %s' %
            (session, err.strip() or rc))

def link_exists(name):
    return os.path.exists('/sys/class/net/%s' % name)


RE_RUNPATH = re.compile(r"^/opt/unetlab/tmp/([0-9]+)/([0-9]+)$")

def v_re(args, key, rx):
    v = args.get(key)
    if not isinstance(v, str) or not rx.match(v):
        raise Reject("bad arg %s" % key)
    return v

def v_int(args, key):
    v = args.get(key)
    if not isinstance(v, int):
        raise Reject("bad arg %s" % key)
    return v

def v_str(args, key):
    v = args.get(key)
    if not isinstance(v, str) or not v:
        raise Reject("bad arg %s" % key)
    return v

def v_enum(args, key, allowed):
    v = args.get(key)
    if v not in allowed:
        raise Reject("bad arg %s" % key)
    return v

def v_cidr(args, key):
    import ipaddress
    v = args.get(key)
    if not isinstance(v, str):
        raise Reject("bad arg %s" % key)
    try:
        ipaddress.IPv4Network(v, strict=False)
    except Exception:
        raise Reject("bad arg %s" % key)
    return v

def v_ip_list(args, key):
    import ipaddress
    v = args.get(key)
    if not isinstance(v, str) or not v:
        raise Reject("bad arg %s" % key)
    for p in v.split(","):
        p = p.strip()
        try:
            ipaddress.IPv4Address(p)
        except Exception:
            raise Reject("bad arg %s" % key)
    return v

def _qemu_scope_unit(session):
    return "pnetlab-qemu-%d.scope" % session

def _cancel_qemu_quota_timer(session):
    # Dummy placeholder / safe no-op if quota timer is handled in brokerd
    pass

# ---- wireless cell WLAN list (VLAN-trunk multi-SSID) -----------------------
# A Wireless cell hosts one or more SSIDs, each mapped to a VLAN; the cell is a
# vlan_filtering bridge (the dot1q-switch plumbing). The WLAN list is config the
# AP bakes into its hostapd multi-BSS at start, so — like the soft-router — it
# lives broker-side keyed by session+net_id, validated once here so persisted
# state and the AP's generated config share one source of truth.

RE_SSID = re.compile(r"^[A-Za-z0-9 _.-]{1,32}$")


def _wificell_state_path(s, n):
    return "%s/wificell-%d_%d.json" % (RUN_DIR, s, n)


def _wificell_save_state(s, n, cfg):
    os.makedirs(RUN_DIR, exist_ok=True)
    tmp = _wificell_state_path(s, n) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f)
    os.replace(tmp, _wificell_state_path(s, n))


def _wificell_load_state(s, n):
    try:
        with open(_wificell_state_path(s, n)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _wificell_normalize(args):
    """Validate a Wireless-cell Configure-dialog payload into a JSON-safe cfg:
    {mgmt_vlan, wlans:[{ssid,vlan,security,psk?,radius_server?,radius_secret?,
    mode,lan_cidr?}]}. SSIDs and VLANs must be unique within the cell. Every
    field passes the shared validators here, so bad state can never reach the
    AP's hostapd config; re-validated on restore too."""
    raw = args.get("wlans")
    if not isinstance(raw, list) or len(raw) > 16:
        raise Reject("bad arg wlans")
    seen_ssid, seen_vlan, wlans = set(), set(), []
    for w in raw:
        if not isinstance(w, dict):
            raise Reject("bad wlan entry")
        ssid = v_re(w, "ssid", RE_SSID)
        vlan = v_int(w, "vlan")
        if vlan < 1 or vlan > 4094:
            raise Reject("bad wlan vlan")
        sec = v_enum(w, "security",
                     {"open", "wpa2-psk", "wpa3-sae", "wpa-eap"})
        if ssid in seen_ssid:
            raise Reject("duplicate ssid")
        if vlan in seen_vlan:
            raise Reject("duplicate vlan")
        seen_ssid.add(ssid)
        seen_vlan.add(vlan)
        entry = {"ssid": ssid, "vlan": vlan, "security": sec,
                 "mode": (v_enum(w, "mode", {"bridge", "routed"})
                          if w.get("mode") is not None else "bridge")}
        if sec in ("wpa2-psk", "wpa3-sae"):
            psk = w.get("psk")
            if not isinstance(psk, str) or not (8 <= len(psk) <= 63):
                raise Reject("bad wlan psk")
            entry["psk"] = psk
        if sec == "wpa-eap":
            entry["radius_server"] = (v_ip_list(w, "radius_server")
                                      if w.get("radius_server") else "")
            rs = w.get("radius_secret", "pnetlab-radius")
            if not isinstance(rs, str) or not (1 <= len(rs) <= 64):
                raise Reject("bad radius secret")
            entry["radius_secret"] = rs
        if entry["mode"] == "routed":
            entry["lan_cidr"] = v_cidr(w, "lan_cidr")
        wlans.append(entry)
    mgmt = (v_int(args, "mgmt_vlan")
            if args.get("mgmt_vlan") is not None else 1)
    if mgmt < 1 or mgmt > 4094:
        raise Reject("bad mgmt_vlan")
    return {"mgmt_vlan": mgmt, "wlans": wlans}


def verb_wifi_cell_apply(args):
    """api.php network/manage for a wireless cell: validate + persist the WLAN
    list so the AP bakes its hostapd multi-BSS config from it at start and the
    Configure dialog round-trips. Persisting before lab start means a freshly
    dropped AP picks the WLANs up on first boot."""
    s, n = v_int(args, "session"), v_int(args, "net_id")
    cfg = _wificell_normalize(args)
    _wificell_save_state(s, n, cfg)
    return 0, [], ""


def verb_wifi_cell_get(args):
    """api_networks.php manage response: the saved WLAN cfg as one JSON line so
    the Configure dialog reopens populated. '{}' when nothing is persisted yet.
    Also the AP handler's source for the multi-BSS config at start."""
    s, n = v_int(args, "session"), v_int(args, "net_id")
    cfg = _wificell_load_state(s, n) or {}
    return 0, [json.dumps(cfg)], ""


def verb_wifi_cell_delete(args):
    """cli.php delBridge() for a wireless cell: drop the per-run WLAN state so a
    recycled net_id never inherits a previous cell's SSIDs. No-op if absent."""
    s, n = v_int(args, "session"), v_int(args, "net_id")
    try:
        os.unlink(_wificell_state_path(s, n))
    except OSError:
        pass
    return 0, [], ""


def verb_wifi_ap_refresh(args):
    """Clear a wireless AP's auto-generated cidata + first-boot markers so the next
    start regenerates the hostapd multi-BSS config from the (updated) cell WLAN
    list. Backs the cell Configure 'Save -> live-apply to running APs' path
    (api.php restarts the cabled AP around this). Only the auto-generated artifacts
    are removed; a user-saved startup-config is left untouched (the caller already
    skips manually-configured APs). No-op on any file that isn't there."""
    d = _node_dir(args)
    for f in ("config.iso", "user-data", "meta-data", "wrapper.txt", ".configured"):
        try:
            os.unlink(d + "/" + f)
        except OSError:
            pass
    return 0, [], ""




def verb_vwifi_server_ensure(args):
    """Ensure the host-side vwifi medium server is running (the emulated RF medium for
    the Wireless AP/STA nodes). vwifi-server stitches the per-VM mac80211_hwsim radios
    over vsock; -u keys clients by their unique guest-cid. One server serves all local
    wireless cells in P1a (per-cell servers arrive with the Wireless-cell net type, P1b).
    Idempotent — safe to call on every wireless node prepare()."""
    run_quiet(["modprobe", "vhost_vsock"])
    rc, out, _ = run(["docker", "inspect", "-f", "{{.State.Running}}",
                      "pnet-vwifi-server"], check_rc=False)
    if rc == 0 and out and out[0].strip() == "true":
        _vwifi_autoplace_ensure()
        return 0, ["already-running"], ""
    run_quiet(["docker", "rm", "-f", "pnet-vwifi-server"])
    image = _vwifi_medium_image()
    if image is None:
        return 1, [], ("vwifi medium image %s not installed (and no legacy %s to "
                       "rename) — load docker-store/pnet-wifi-spike-1-0.tar.gz or "
                       "install it from Dashboard > Docker Devices"
                       % (VWIFI_MEDIUM_IMAGE, VWIFI_MEDIUM_IMAGE_LEGACY))
    # NOTE: NO -u. `-u`/--use-port-in-hash is a Docker-NAT demux hack (many TCP
    # clients behind one NAT IP); over vsock each node has a unique guest-cid, so
    # -u is unnecessary AND the recompiled (Raizo62) server mis-keys vsock clients
    # under -u so only ONE stays registered at a time (others silently drop -> a
    # client never hears the AP's beacons). Plain `vwifi-server` keys by CID and
    # holds all nodes.
    rc, out, err = run(["docker", "run", "-d", "--name", "pnet-vwifi-server",
                        "--privileged", "--network", "host", "--restart", "unless-stopped",
                        image, "vwifi-server"], check_rc=False)
    if rc != 0:
        return rc, out, "vwifi-server start failed: " + err.strip()
    _vwifi_autoplace_ensure()
    return 0, ["started"], ""


def _vwifi_autoplace_ensure():
    """Ensure the auto-placer loop is running so newly-joined wireless nodes link
    without manual placement (P2 canvas-coupling overrides per-node coords later)."""
    rc, _, _ = run(["systemctl", "is-active", "pnet-vwifi-autoplace.service"],
                   check_rc=False)
    if rc == 0:
        return
    try:
        spawn_unit("pnet-vwifi-autoplace",
                   ["/bin/bash", "/opt/unetlab/scripts/vwifi-autoplace.sh"])
    except Exception:
        pass


def verb_airhandler_ensure(args):
    """Ensure the host-side airhandler is running — the clean-room RF-medium
    arbiter for the Cisco VAP (and CML wireless-client) nodes. Their in-guest
    `airduct` client connects over a per-node virtio-serial unix socket
    (/opt/unetlab/tmp/<s>/<n>/airduct.sock, qemu listens) to request radio MACs
    and relay 802.11 frames; without it airduct exit(1)s and capwapd never joins.
    Runs as a transient systemd unit (single-instance-guarded by the daemon).
    Idempotent — called from every VAP/wireless node prepare()."""
    rc, _, _ = run(["systemctl", "is-active", "pnet-airhandler.service"],
                   check_rc=False)
    if rc == 0:
        return 0, ["already-running"], ""
    try:
        spawn_unit("pnet-airhandler",
                   ["/usr/bin/python3", "/opt/unetlab/scripts/airhandler.py"])
    except Exception as e:
        return 1, [], "airhandler start failed: %s" % e
    return 0, ["started"], ""


def verb_vwifi_ctrl(args):
    """Drive vwifi-ctrl against the running medium server: node placement (positions),
    naming, packet-loss + scale toggles, and listing. The canvas RF coupling / Wi-Fi
    Painter (P2) maps node left/top -> set <cid> x y z through this verb."""
    sub = v_enum(args, "cmd", ["ls", "set", "setname", "loss", "scale", "distance"])
    cargv = ["docker", "exec", "pnet-vwifi-server", "vwifi-ctrl", sub]
    # CIDs are the node guest-cid = crc32(uuid)%0x7fff0000 + 0x10000, up to ~2.1e9
    # (10 digits). The old 9-digit cap silently rejected every real set/setname/
    # distance, so vwifi node placement never took effect. Allow 10.
    cidrx = re.compile(r"^[0-9]{1,10}$")
    intrx = re.compile(r"^-?[0-9]{1,9}$")
    namerx = re.compile(r"^[A-Za-z0-9_\- ]{1,32}$")
    scalerx = re.compile(r"^[0-9]+(\.[0-9]+)?$")
    if sub == "set":
        cargv += [v_re(args, "cid", cidrx), v_re(args, "x", intrx),
                  v_re(args, "y", intrx), v_re(args, "z", intrx)]
    elif sub == "setname":
        cargv += [v_re(args, "cid", cidrx), v_re(args, "name", namerx)]
    elif sub == "loss":
        cargv += [v_enum(args, "value", ["yes", "no"])]
    elif sub == "scale":
        cargv += [v_re(args, "value", scalerx)]
    elif sub == "distance":
        cargv += [v_re(args, "cid", cidrx), v_re(args, "cid2", cidrx)]
    rc, out, err = run(cargv, check_rc=False)
    return rc, out, err


def verb_wifi_capture(args):
    """Start/stop/status the OPT-IN 802.11 pcap tee for a lab session. The airhandler
    writes every frame crossing the medium to /opt/unetlab/tmp/<session>/wifi-<s>.pcap
    ONLY while the marker /opt/unetlab/tmp/<session>/wifi-capture exists, so this verb
    just touches/removes the marker (no unconditional disk burn) and reports the pcap
    path + whether it has frames yet. Backs a 'Capture Wi-Fi' control that hands the
    pcap to Wireshark (download / web-capture)."""
    session = v_int(args, "session")
    if session <= 0:
        raise Reject("bad arg session")
    action = v_enum(args, "action", ["start", "stop", "status"])
    # medium selects which tee's marker/pcap this arms: airduct (airhandler _flood tee,
    # cvap/cwificlient) or vwifi (vwifi-server spy-port tee, wifiap/wifista). Distinct
    # marker + pcap names so both can be armed in one lab.
    medium = (v_enum(args, "medium", ["airduct", "vwifi"])
              if args.get("medium") is not None else "airduct")
    sdir = "/opt/unetlab/tmp/%d" % session
    if medium == "vwifi":
        marker = sdir + "/wifi-vwifi-capture"
        pcap = sdir + "/wifi-vwifi-%d.pcap" % session
    else:
        marker = sdir + "/wifi-capture"
        pcap = sdir + "/wifi-%d.pcap" % session
    unit = "pnet-wifi-spy-%d" % session          # vwifi spy-tee transient unit
    if action == "start":
        if not os.path.isdir(sdir):
            raise Reject("no such session dir")
        try:
            open(marker, "a").close()
        except OSError as e:
            raise Reject("cannot arm capture: %s" % e)
        # airduct is teed inside the always-running airhandler (marker is enough).
        # vwifi needs a dedicated process connected to the vwifi-server SPY port;
        # spawn it as a transient unit — it self-exits when the marker is removed.
        if medium == "vwifi":
            run_quiet(["systemctl", "reset-failed", unit + ".service"])
            try:
                spawn_unit(unit, ["/usr/bin/python3",
                                  BASE + "/scripts/vwifi-spy-capture.py",
                                  "--pcap", pcap, "--marker", marker])
            except Exception as e:                # noqa: BLE001
                raise Reject("cannot start vwifi spy capture: %s" % e)
    elif action == "stop":
        try:
            os.unlink(marker)                    # the spy process self-exits on this
        except OSError:
            pass
        if medium == "vwifi":
            run_quiet(["systemctl", "stop", unit + ".service"])
    armed = os.path.exists(marker)
    size = os.path.getsize(pcap) if os.path.exists(pcap) else 0
    return 0, [json.dumps({"armed": armed, "pcap": pcap, "bytes": size})], ""


def verb_wifi_truth(args):
    """Read the REAL 802.11 association state of ONE wireless node over its serial
    console and return it as one JSON line. Backs the Wi-Fi Painter's truth overlay
    (pnq-wifi.php ?truth=1): the painter's association/RSSI is MODELLED, so this lets
    it flag model-vs-actual divergence (e.g. a wrong-PSK station that "looks"
    connected but never completed the 4-way handshake). The telnet/expect + parsing
    lives in pnet-wifi-truth.py; only a fixed whitelist of read-only query commands
    (wpa_cli status / hostapd_cli all_sta / cat of /proc+/sys) is ever run.
    host is ALWAYS forced to 127.0.0.1 — this verb only reads consoles local to this
    host (same policy as node_config_push)."""
    role = v_enum(args, "role", ["ap", "sta"])
    ifc = args.get("ifc", "wlan0")
    if not (isinstance(ifc, str) and re.match(r"^wlan[0-9](_[0-9]+)?$", ifc)):
        raise Reject("bad arg ifc")
    # Prefer the qemu console UNIX socket (always present while a node runs); the TCP
    # telnet port only listens when the on-demand web-console bridge is up, so it is an
    # unreliable target for an unattended read. `sock` must be a node console.sock under
    # the tmp tree — never an arbitrary path.
    argv = ["/usr/bin/python3", BASE + "/scripts/pnet-wifi-truth.py",
            "--role", role, "--ifc", ifc]
    sock = args.get("sock")
    if sock is not None:
        if not (isinstance(sock, str)
                and re.match(r"^/opt/unetlab/tmp/\d+/\d+/console\.sock$", sock)):
            raise Reject("bad arg sock")
        argv += ["--sock", sock]
    else:
        port = v_int(args, "port")
        if not (1 <= port <= 65535):
            raise Reject("bad arg port")
        argv += ["--host", "127.0.0.1", "--port", str(port)]
    rc, out, err = run(argv, timeout=45)
    if rc != 0 and not out:
        raise Reject("wifi-truth: " + (err.strip() or ("rc=%d" % rc)))
    return 0, out, ""                                   # out = one JSON line


def _roce_agent_get(cid, resource):
    """GET one controller-owned resource; ``resource`` never comes from a request."""
    if resource not in ("/v1/health", "/v1/inventory"):
        raise Reject("bad RoCE agent resource")
    request = ("GET %s HTTP/1.1\r\n" % resource).encode("ascii") + (
        b"Host: vsock\r\n"
        b"Accept: application/json\r\n"
        b"Connection: close\r\n\r\n")
    chunks = []
    total = 0
    wire_limit = ROCE_AGENT_MAX_RESPONSE + 8192
    deadline = time.monotonic() + ROCE_AGENT_TIMEOUT
    sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try:
        sock.settimeout(max(0.001, deadline - time.monotonic()))
        sock.connect((cid, ROCE_AGENT_PORT))
        sock.settimeout(max(0.001, deadline - time.monotonic()))
        sock.sendall(request)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Reject("agent probe timed out")
            sock.settimeout(remaining)
            chunk = sock.recv(min(4096, wire_limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > wire_limit:
                raise Reject("agent HTTP response exceeded its bound")
    except (OSError, socket.timeout):
        raise Reject("agent probe failed")
    finally:
        sock.close()

    raw = b"".join(chunks)
    head, sep, body = raw.partition(b"\r\n\r\n")
    if not sep or len(head) > 8192:
        raise Reject("agent returned malformed HTTP")
    if len(body) > ROCE_AGENT_MAX_RESPONSE:
        raise Reject("agent JSON response exceeded 32768 bytes")
    lines = head.split(b"\r\n")
    if not lines or lines[0] not in (b"HTTP/1.1 200 OK", b"HTTP/1.0 200 OK"):
        raise Reject("agent request was not successful")
    headers = {}
    for line in lines[1:]:
        name, colon, value = line.partition(b":")
        if not colon:
            raise Reject("agent returned malformed HTTP headers")
        try:
            key = name.decode("ascii").strip().lower()
            val = value.decode("ascii").strip()
        except UnicodeDecodeError:
            raise Reject("agent returned malformed HTTP headers")
        if key in headers:
            raise Reject("agent returned duplicate HTTP headers")
        headers[key] = val
    if headers.get("transfer-encoding"):
        raise Reject("agent response must not be transfer encoded")
    if not headers.get("content-type", "").lower().startswith("application/json"):
        raise Reject("agent response is not JSON")
    if "content-length" in headers:
        if not re.match(r"^[0-9]{1,5}$", headers["content-length"]):
            raise Reject("agent returned invalid content length")
        if int(headers["content-length"]) != len(body):
            raise Reject("agent returned incomplete document")
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Reject("agent returned invalid JSON")
    if not isinstance(document, dict):
        raise Reject("agent JSON must be an object")
    if document.get("api_version") != "rxe-agent/v1":
        raise Reject("agent API version mismatch")
    return document


def _roce_agent_post(cid, resource, document):
    allowed = {"/v1/prepare", "/v1/start-server", "/v1/readiness",
               "/v1/start-client", "/v1/status", "/v1/cancel", "/v1/result"}
    if resource not in allowed or not isinstance(document, dict):
        raise Reject("bad RoCE workload request")
    body = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(body) > 8192:
        raise Reject("RoCE workload request exceeded its bound")
    request = (("POST %s HTTP/1.1\r\n" % resource).encode("ascii") +
               b"Host: vsock\r\nAccept: application/json\r\nContent-Type: application/json\r\n" +
               ("Content-Length: %d\r\n" % len(body)).encode("ascii") +
               b"Connection: close\r\n\r\n" + body)
    chunks, total = [], 0
    deadline = time.monotonic() + 5.0
    sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try:
        sock.settimeout(5.0); sock.connect((cid, ROCE_AGENT_PORT)); sock.sendall(request)
        while True:
            sock.settimeout(max(0.001, deadline - time.monotonic()))
            chunk = sock.recv(min(4096, ROCE_AGENT_MAX_RESPONSE + 8193 - total))
            if not chunk: break
            chunks.append(chunk); total += len(chunk)
            if total > ROCE_AGENT_MAX_RESPONSE + 8192: raise Reject("agent HTTP response exceeded its bound")
    except (OSError, socket.timeout): raise Reject("agent workload request failed")
    finally: sock.close()
    raw = b"".join(chunks); head, sep, response_body = raw.partition(b"\r\n\r\n")
    if not sep or len(head) > 8192 or len(response_body) > ROCE_AGENT_MAX_RESPONSE: raise Reject("agent returned malformed workload HTTP")
    lines = head.split(b"\r\n")
    if lines[0] not in (b"HTTP/1.1 200 OK", b"HTTP/1.0 200 OK"): raise Reject("agent workload operation was rejected")
    headers = {}
    for line in lines[1:]:
        name, colon, value = line.partition(b":")
        if not colon: raise Reject("agent returned malformed workload headers")
        try: key, val = name.decode("ascii").strip().lower(), value.decode("ascii").strip()
        except UnicodeDecodeError: raise Reject("agent returned malformed workload headers")
        if key in headers: raise Reject("agent returned duplicate workload headers")
        headers[key] = val
    if headers.get("transfer-encoding") or not headers.get("content-type", "").lower().startswith("application/json"): raise Reject("agent returned invalid workload encoding")
    if not re.fullmatch(r"[0-9]{1,5}", headers.get("content-length", "")) or int(headers["content-length"]) != len(response_body): raise Reject("agent returned incomplete workload document")
    try: result = json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError): raise Reject("agent returned invalid workload JSON")
    if not isinstance(result, dict) or result.get("api_version") != ROCE_WORKLOAD_API: raise Reject("agent workload API version mismatch")
    return result


def _roce_cid(node_session, node_uuid):
    return (zlib.crc32(("%d:%s" % (node_session, node_uuid)).encode()) % 0x7fff0000) + 0x10000


def _roce_owned_qemu(lab_session, node_session, cid, node_uuid):
    runtime = "/opt/unetlab/tmp/%d/%d/" % (lab_session, node_session)
    cid_arg = re.compile(r"(?:^|,)guest-cid=%d(?:,|$)" % cid)
    for pid in os.listdir("/proc"):
        if not pid.isdigit(): continue
        try:
            exe = os.path.basename(os.readlink("/proc/%s/exe" % pid))
            with open("/proc/%s/stat" % pid, "rb") as f: stat_tail = f.read(4096).rpartition(b") ")[2]
            with open("/proc/%s/cmdline" % pid, "rb") as f: argv = [p.decode("ascii", "ignore") for p in f.read(262144).split(b"\0") if p]
        except OSError: continue
        uuid_match = any(arg == "-uuid=" + node_uuid for arg in argv)
        uuid_match = uuid_match or any(argv[i] == "-uuid" and i + 1 < len(argv) and argv[i + 1] == node_uuid for i in range(len(argv)))
        if (exe.startswith("qemu-system-") and stat_tail and stat_tail[:1] != b"Z" and uuid_match and
                any(runtime in arg for arg in argv) and any(cid_arg.search(arg) for arg in argv)): return True
    return False


def _roce_endpoint(args, key, lab_session):
    value = args.get(key)
    if not isinstance(value, dict) or set(value) != {"node_session", "node_uuid"}: raise Reject("bad RoCE prepare shape")
    node_session, node_uuid = value.get("node_session"), value.get("node_uuid")
    if isinstance(node_session, bool) or not isinstance(node_session, int) or not 1 <= node_session <= 0x7fffffff: raise Reject("bad %s node_session" % key)
    if not isinstance(node_uuid, str) or not RE_ROCE_UUID.fullmatch(node_uuid): raise Reject("bad %s node_uuid" % key)
    cid = _roce_cid(node_session, node_uuid)
    if not _roce_owned_qemu(lab_session, node_session, cid, node_uuid): raise Reject("no live node-runtime QEMU owns %s" % key)
    health, inventory = _roce_agent_get(cid, "/v1/health"), _roce_agent_get(cid, "/v1/inventory")
    iface, addresses = inventory.get("data_interface"), []
    for item in inventory.get("interfaces", []):
        if isinstance(item, dict) and item.get("name") == iface:
            for candidate in item.get("addresses", []):
                try: parsed = ipaddress.ip_interface(candidate)
                except ValueError: continue
                if parsed.version == 4 and not parsed.ip.is_unspecified and not parsed.ip.is_loopback and not parsed.ip.is_multicast: addresses.append(str(parsed.ip))
    addresses = sorted(set(addresses))
    devices = inventory.get("rdma", {}).get("devices", [])
    rxe0 = [d for d in devices if isinstance(d, dict) and d.get("name") == "rxe0"]
    rxe0_ready = False
    if len(rxe0) == 1:
        for port in rxe0[0].get("ports", []):
            active = "ACTIVE" in str(port.get("state", "")).upper().split()
            attached_gid = any(gid.get("netdev") == iface and gid.get("value") not in ("", "::") for gid in port.get("gids", []) if isinstance(gid, dict))
            rxe0_ready = rxe0_ready or (active and attached_gid)
    if len(addresses) != 1 or not rxe0_ready or not inventory.get("rdma", {}).get("rxe_ready"): raise Reject("%s endpoint is not unambiguously RXE ready" % key)
    if not health.get("boot_id") or not health.get("instance_id"): raise Reject("%s agent identity is incomplete" % key)
    return {"node_session": node_session, "node_uuid": node_uuid, "cid": cid, "boot_id": health["boot_id"], "instance_id": health["instance_id"], "local_ip": addresses[0], "data_interface": iface, "rxe_device": "rxe0"}


def _roce_revalidate(record, side):
    endpoint = record[side]
    if not _roce_owned_qemu(record["lab_session"], endpoint["node_session"], endpoint["cid"], endpoint["node_uuid"]): raise Reject("RoCE runtime identity changed")
    probe = {side: {"node_session": endpoint["node_session"], "node_uuid": endpoint["node_uuid"]}}
    current = _roce_endpoint(probe, side, record["lab_session"])
    for key in ("cid", "boot_id", "instance_id", "local_ip", "data_interface", "rxe_device"):
        if current.get(key) != endpoint.get(key): raise Reject("RoCE endpoint identity changed")


def _roce_run_path(run_id):
    if not isinstance(run_id, str) or not RE_ROCE_RUN.fullmatch(run_id): raise Reject("bad arg run_id")
    return os.path.join(ROCE_RUN_DIR, run_id + ".json")


def _roce_ensure_run_dir():
    parent = os.path.dirname(ROCE_RUN_DIR)
    if os.path.islink(parent): raise Reject("invalid RoCE state parent")
    os.makedirs(ROCE_RUN_DIR, mode=0o700, exist_ok=True)
    st = os.lstat(ROCE_RUN_DIR)
    if os.path.islink(ROCE_RUN_DIR) or not os.path.isdir(ROCE_RUN_DIR) or st.st_uid != 0 or (st.st_mode & 0o077): raise Reject("invalid RoCE state directory")


def _roce_write_run(record):
    _roce_ensure_run_dir(); path = _roce_run_path(record["run_id"])
    fd, tmp = tempfile.mkstemp(prefix="." + record["run_id"], dir=ROCE_RUN_DIR, text=True)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f: json.dump(record, f, sort_keys=True, separators=(",", ":")); f.write("\n"); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try: os.close(fd)
        except OSError: pass
        try: os.unlink(tmp)
        except OSError: pass
        raise


def _roce_read_run(run_id):
    _roce_ensure_run_dir()
    path = _roce_run_path(run_id)
    try:
        st = os.lstat(path)
        if os.path.islink(path) or st.st_size > 65536: raise Reject("invalid RoCE run record")
        with open(path, "r", encoding="utf-8") as f: record = json.load(f)
    except (OSError, ValueError): raise Reject("unknown RoCE run")
    if not isinstance(record, dict) or record.get("run_id") != run_id: raise Reject("invalid RoCE run record")
    return record


def _roce_agent_body(record, side, prepare=False):
    endpoint = record[side]
    body = {"api_version": ROCE_WORKLOAD_API, "run_id": record["run_id"], "owner": {"lab_session": record["lab_session"], "node_session": endpoint["node_session"], "boot_id": endpoint["boot_id"], "cid": endpoint["cid"]}}
    if prepare:
        other = record["client" if side == "server" else "server"]
        body.update({"tool": record["tool"], "role": side, "local_ip": endpoint["local_ip"], "peer_ip": other["local_ip"], "lease_seconds": record["lease_seconds"]})
    return body


def _roce_pair_pass(record):
    for side in ("server", "client"):
        result, endpoint = record.get("roles", {}).get(side, {}), record[side]; cleanup = result.get("cleanup", {})
        exit_code = result.get("exit_code")
        hashes = ("rdma_before_sha256", "rdma_after_sha256", "qdisc_before_sha256", "qdisc_after_sha256")
        raw_pairs = (("rdma_before", "rdma_after", "rdma_before_sha256", "rdma_after_sha256"), ("qdisc_before", "qdisc_after", "qdisc_before_sha256", "qdisc_after_sha256"))
        if (result.get("api_version") != ROCE_WORKLOAD_API or result.get("run_id") != record["run_id"] or result.get("role") != side or result.get("tool") != record["tool"] or
                result.get("state") != "succeeded" or isinstance(exit_code, bool) or exit_code != 0 or result.get("forced") is not False or result.get("truncated") is not False or
                result.get("boot_id") != endpoint["boot_id"] or result.get("instance_id") != endpoint["instance_id"] or cleanup.get("complete") is not True or
                cleanup.get("processes_remaining") is not False or cleanup.get("rdma_unchanged") is not True or cleanup.get("qdisc_unchanged") is not True or
                any(not isinstance(cleanup.get(k), str) or not re.fullmatch(r"[0-9a-f]{64}", cleanup[k]) for k in hashes) or
                cleanup["rdma_before_sha256"] != cleanup["rdma_after_sha256"] or cleanup["qdisc_before_sha256"] != cleanup["qdisc_after_sha256"] or
                result.get("pid", 0) != 0 or result.get("error", "") != "" or cleanup.get("error", "") != "" or
                any(not isinstance(cleanup.get(before), str) or cleanup.get(before) != cleanup.get(after) or hashlib.sha256(cleanup[before].encode()).hexdigest() != cleanup.get(before_hash) or hashlib.sha256(cleanup[after].encode()).hexdigest() != cleanup.get(after_hash) for before, after, before_hash, after_hash in raw_pairs) or
                not _roce_output_valid(record["tool"], result.get("output", ""))): return False
    return True


def _roce_output_valid(tool, output):
    if not isinstance(output, str) or len(output.encode("utf-8")) > 8192: return False
    if tool == "rping": return "ping data: rdma-ping-0:" in output
    expected, minimum = (64, 7) if tool == "ib_write_lat" else (4096, 5)
    for line in output.splitlines():
        fields = line.split()
        if len(fields) < minimum or fields[:2] != [str(expected), "100"]: continue
        try: values = [float(v) for v in fields[2:]]
        except ValueError: continue
        if all(math.isfinite(v) and v >= 0 for v in values) and any(v > 0 for v in values): return True
    return False


def _roce_outcome_state(record, states, default="failed", cleanup_failed=False):
    """Apply the immutable pair-outcome precedence in one place."""
    outcome_lock = record.get("outcome_lock")
    if cleanup_failed or outcome_lock == "cleanup_failed" or "cleanup_failed" in states:
        return "cleanup_failed"
    if outcome_lock in ("failed", "cancelled"):
        return outcome_lock
    if "failed" in states:
        return "failed"
    if "cancelled" in states:
        return "cancelled"
    return default


def _roce_reconciled_state(record):
    """Keep a latched outcome when an expired endpoint can be released safely."""
    states = [record.get("state")]
    states.extend(role.get("state") for role in record.get("roles", {}).values())
    return _roce_outcome_state(record, states)


def _roce_public_payload(record):
    public = {k: v for k, v in record.items() if k not in ("server", "client", "roles")}
    public["server"] = {"node_session": record["server"]["node_session"], "result": record["roles"].get("server")}
    public["client"] = {"node_session": record["client"]["node_session"], "result": record["roles"].get("client")}
    payload = json.dumps(public, sort_keys=True, separators=(",", ":"))
    if len(payload.encode("utf-8")) > 60000: raise Reject("RoCE broker response exceeded its bound")
    return payload


def verb_roce_workload(args):
    if not isinstance(args, dict) or args.get("api_version") != ROCE_BROKER_API: raise Reject("bad RoCE broker API version")
    operation = args.get("operation")
    with ROCE_WORKLOAD_LOCK:
        if operation == "reset-pair":
            if set(args) != {"api_version", "operation", "lab_session", "server", "client"}: raise Reject("bad RoCE reset shape")
            lab_session = v_int(args, "lab_session")
            if not 1 <= lab_session <= 0x7fffffff: raise Reject("bad RoCE bounds")
            server = _roce_endpoint(args, "server", lab_session); client = _roce_endpoint(args, "client", lab_session)
            if server["node_session"] == client["node_session"] or server["cid"] == client["cid"]: raise Reject("RoCE endpoints must be distinct")
            selected = {server["node_session"], client["node_session"]}
            _roce_ensure_run_dir()
            names = [n for n in os.listdir(ROCE_RUN_DIR) if n.endswith(".json") and RE_ROCE_RUN.fullmatch(n[:-5])]
            reset_count, attention = 0, 0
            for name in names:
                prior = _roce_read_run(name[:-5])
                involved = any(prior.get(side, {}).get("node_session") in selected for side in ("server", "client"))
                if prior.get("lab_session") != lab_session or prior.get("terminal") or not involved: continue
                try:
                    _, out, _ = verb_roce_workload({"api_version": ROCE_BROKER_API, "operation": "cancel",
                                                     "lab_session": lab_session, "run_id": prior["run_id"]})
                    result = json.loads(out[0])
                    if result.get("terminal") is True and result.get("state") in ("passed", "failed", "cancelled"):
                        reset_count += 1
                    else:
                        attention += 1
                except Exception:
                    attention += 1
            state = "reset" if attention == 0 else "attention"
            payload = {"api_version": ROCE_BROKER_API, "state": state, "terminal": attention == 0,
                       "reset_count": reset_count, "attention_count": attention}
            if attention:
                payload["error"] = "One or more owned workloads could not prove clean terminal cleanup; reservations remain protected."
            return 0, [json.dumps(payload, sort_keys=True, separators=(",", ":"))], ""
        if operation == "prepare":
            if set(args) != {"api_version", "operation", "lab_session", "server", "client", "tool", "lease_seconds"}: raise Reject("bad RoCE prepare shape")
            lab_session, lease = v_int(args, "lab_session"), v_int(args, "lease_seconds")
            if not 1 <= lab_session <= 0x7fffffff or not 1 <= lease <= 120: raise Reject("bad RoCE bounds")
            tool = v_enum(args, "tool", {"rping", "ib_write_lat", "ib_write_bw"}); server = _roce_endpoint(args, "server", lab_session); client = _roce_endpoint(args, "client", lab_session)
            if server["node_session"] == client["node_session"] or server["cid"] == client["cid"]: raise Reject("RoCE endpoints must be distinct")
            _roce_ensure_run_dir(); records = [n for n in os.listdir(ROCE_RUN_DIR) if n.endswith(".json") and RE_ROCE_RUN.fullmatch(n[:-5])]
            if len(records) >= ROCE_RUN_LIMIT:
                clean = sorted((_roce_read_run(n[:-5]) for n in records), key=lambda r: r.get("created_at", 0))
                for prior in clean:
                    if len(records) < ROCE_RUN_LIMIT // 2: break
                    if prior.get("terminal") and prior.get("state") in ("passed", "failed", "cancelled"):
                        roles = prior.get("roles", {})
                        if set(roles) == {"server", "client"} and all(v.get("cleanup", {}).get("complete") is True for v in roles.values()):
                            os.unlink(_roce_run_path(prior["run_id"])); records.remove(prior["run_id"] + ".json")
            if len(records) >= ROCE_RUN_LIMIT: raise Reject("RoCE run retention limit reached")
            for name in records:
                prior = _roce_read_run(name[:-5])
                if not prior.get("terminal") and time.time() >= prior.get("created_at", 0) + prior.get("lease_seconds", 120) + 5:
                    present = [_roce_owned_qemu(prior["lab_session"], prior[s]["node_session"], prior[s]["cid"], prior[s]["node_uuid"]) for s in ("server", "client")]
                    if not any(present):
                        prior["state"], prior["terminal"] = _roce_reconciled_state(prior), True
                        prior["error"] = "lease expired after endpoints stopped"
                        _roce_write_run(prior)
                    else:
                        try:
                            stale, clean = False, True
                            for index, side in enumerate(("server", "client")):
                                if not present[index]: continue
                                health = _roce_agent_get(prior[side]["cid"], "/v1/health")
                                if health.get("boot_id") != prior[side]["boot_id"] or health.get("instance_id") != prior[side]["instance_id"]: stale = True; continue
                                prior["roles"][side] = _roce_agent_post(prior[side]["cid"], "/v1/status", _roce_agent_body(prior, side))
                                clean = clean and prior["roles"][side].get("cleanup", {}).get("complete") is True and prior["roles"][side].get("state") in ("succeeded", "failed", "cancelled")
                            if stale or clean:
                                prior["state"], prior["terminal"] = _roce_reconciled_state(prior), True
                                prior["error"] = "stale endpoint identity" if stale else "broker lease reconciliation"
                                _roce_write_run(prior)
                        except Reject: pass
                if not prior.get("terminal") and any(prior.get(side, {}).get("node_session") in (server["node_session"], client["node_session"]) for side in ("server", "client")): raise Reject("RoCE endpoint already reserved")
            run_id = secrets.token_hex(16); record = {"api_version": ROCE_BROKER_API, "run_id": run_id, "lab_session": lab_session, "tool": tool, "lease_seconds": lease, "server": server, "client": client, "roles": {}, "state": "preparing", "terminal": False, "created_at": time.time()}; _roce_write_run(record)
            try:
                for side in ("server", "client"): record["roles"][side] = _roce_agent_post(record[side]["cid"], "/v1/prepare", _roce_agent_body(record, side, True))
                record["state"] = "prepared"
            except Exception:
                for side in record["roles"]:
                    try: _roce_agent_post(record[side]["cid"], "/v1/cancel", _roce_agent_body(record, side))
                    except Exception: pass
                record["state"], record["terminal"] = "failed", False; _roce_write_run(record); raise
        else:
            if set(args) != {"api_version", "operation", "lab_session", "run_id"} or operation not in {"start-server", "readiness", "start-client", "status", "cancel", "result"}: raise Reject("bad RoCE workload operation shape")
            lab_session, record = v_int(args, "lab_session"), _roce_read_run(args.get("run_id"))
            if record.get("lab_session") != lab_session: raise Reject("RoCE run ownership mismatch")
            if record.get("terminal"):
                if operation in ("start-server", "readiness", "start-client"): raise Reject("RoCE run is terminal")
                return 0, [_roce_public_payload(record)], ""
            for side in ("server", "client"): _roce_revalidate(record, side)
            if operation == "start-client":
                ready = _roce_agent_post(record["server"]["cid"], "/v1/readiness", _roce_agent_body(record, "server"))
                record["roles"]["server"] = ready
                if ready.get("state") != "ready": _roce_write_run(record); raise Reject("RoCE server listener is not ready")
            targets = ("server", "client") if operation in ("status", "cancel", "result") else (("client",) if operation == "start-client" else ("server",))
            if operation == "cancel":
                for side in ("server", "client"):
                    record["roles"][side] = _roce_agent_post(record[side]["cid"], "/v1/status", _roce_agent_body(record, side))
                prior_states = [record["roles"][side].get("state") for side in ("server", "client")]
                if not record.get("outcome_lock") and all(state == "succeeded" for state in prior_states) and _roce_pair_pass(record):
                    record["pair_pass"], record["state"], record["terminal"] = True, "passed", True
                    _roce_write_run(record)
                    return 0, [_roce_public_payload(record)], ""
                record["outcome_lock"] = _roce_outcome_state(record, prior_states, default="cancelled")
                record["state"] = "cancel_requested"; record["cancel_requested"] = True; _roce_write_run(record)
            for side in targets:
                record["roles"][side] = _roce_agent_post(record[side]["cid"], "/v1/" + operation, _roce_agent_body(record, side))
            if operation == "status":
                observed = [record["roles"].get(side, {}).get("state") for side in ("server", "client")]
                if any(state in ("failed", "cancelled", "cleanup_failed") for state in observed):
                    # One role cannot make progress after its peer has failed.
                    # Latch the outcome before transport cleanup so a partial
                    # cancel failure can never be relabelled as a later PASS.
                    record["outcome_lock"] = _roce_outcome_state(record, observed)
                    record["state"] = "peer_cleanup"
                    _roce_write_run(record)
                    for side in ("server", "client"):
                        state = record["roles"].get(side, {}).get("state")
                        if state not in ("succeeded", "failed", "cancelled", "cleanup_failed"):
                            record["roles"][side] = _roce_agent_post(
                                record[side]["cid"], "/v1/cancel", _roce_agent_body(record, side))
            record["state"] = operation
            states = [record["roles"].get(side, {}).get("state") for side in ("server", "client")]
            clean = all(record["roles"].get(side, {}).get("cleanup", {}).get("complete") is True for side in ("server", "client"))
            if operation == "result":
                record["pair_pass"] = not record.get("outcome_lock") and _roce_pair_pass(record)
                if record["pair_pass"]: record["state"] = "passed"
                else: record["state"] = _roce_outcome_state(record, states, cleanup_failed=not clean)
                record["terminal"] = clean
            elif operation in ("cancel", "status") and ("cleanup_failed" in states or record.get("outcome_lock") == "cleanup_failed"):
                record["state"], record["pair_pass"], record["terminal"] = "cleanup_failed", False, False
            elif operation == "status" and clean and all(state in ("succeeded", "failed", "cancelled") for state in states):
                record["pair_pass"] = not record.get("outcome_lock") and _roce_pair_pass(record)
                record["state"] = "passed" if record["pair_pass"] else _roce_outcome_state(record, states)
                record["terminal"] = True
            elif operation in ("cancel", "status") and record.get("outcome_lock") and clean and all(state in ("succeeded", "failed", "cancelled") for state in states):
                record["state"] = record["outcome_lock"]
                record["pair_pass"], record["terminal"] = False, True
        _roce_write_run(record)
        return 0, [_roce_public_payload(record)], ""


def verb_roce_agent_health(args):
    """Read one RXE guest's typed health + inventory over host -> guest vsock.

    PHP derives both session IDs and ``cid`` from an authenticated active-lab node
    whose template is exactly ``rxe``. The vsock port, two HTTP resources,
    timeout and per-response ceiling are fixed here. It never invokes a shell,
    subprocess, URL parser, or caller path.
    """
    if set(args) != {"lab_session", "node_session", "cid"}:
        raise Reject("roce_agent_health accepts only lab_session, node_session and cid")
    lab_session = v_int(args, "lab_session")
    node_session = v_int(args, "node_session")
    if not (1 <= lab_session <= 0x7fffffff):
        raise Reject("bad arg lab_session")
    if not (1 <= node_session <= 0x7fffffff):
        raise Reject("bad arg node_session")
    cid = v_int(args, "cid")
    if not (0x10000 <= cid <= 0x7fffffff):
        raise Reject("bad arg cid")
    if not hasattr(socket, "AF_VSOCK"):
        return 1, [], "vsock is not supported by this host Python"
    runtime = "/opt/unetlab/tmp/%d/%d/" % (lab_session, node_session)
    cid_arg = re.compile(r"(?:^|,)guest-cid=%d(?:,|$)" % cid)
    owned_qemu = False
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        proc = "/proc/" + pid
        try:
            exe = os.path.basename(os.readlink(proc + "/exe"))
            if not exe.startswith("qemu-system-"):
                continue
            with open(proc + "/stat", "rb") as f:
                stat_tail = f.read(4096).rpartition(b") ")[2]
            if not stat_tail or stat_tail[:1] == b"Z":
                continue
            with open(proc + "/cmdline", "rb") as f:
                argv = [part.decode("ascii", "ignore")
                        for part in f.read(262144).split(b"\0") if part]
        except OSError:
            continue
        has_runtime = any(runtime in arg for arg in argv)
        if has_runtime and any(cid_arg.search(arg) for arg in argv):
            owned_qemu = True
            break
    if not owned_qemu:
        return 1, [], "no live node-runtime QEMU has that guest CID"
    try:
        health = _roce_agent_get(cid, "/v1/health")
        inventory = _roce_agent_get(cid, "/v1/inventory")
    except Reject as e:
        return 1, [], str(e)
    return 0, [json.dumps({"health": health, "inventory": inventory},
                          separators=(",", ":"), sort_keys=True)], ""


def verb_node_kill_orphan_qemu(args):
    """Kill any leftover qemu still bound to this node's running path BEFORE the
    node (re)starts. PNetLab can leave an orphaned qemu when a node is deleted/
    recreated or restarted; for a Wireless node that orphan keeps its radio on the
    shared vwifi medium and beacons a STALE SSID (ghost network) even after the
    config is fixed. Called only from a wireless node's prepare() — i.e. before
    that node's own qemu launches — so any qemu whose cmdline references this run
    path is by definition stale and safe to kill. Matches the node run dir
    (/opt/unetlab/tmp/<s>/<n>) in the qemu cmdline."""
    run_path = v_re(args, "run", RE_RUNPATH)
    needle = run_path + "/"
    killed = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as f:
                cmd = f.read().replace(b"\x00", b" ").decode("latin-1", "replace")
        except OSError:
            continue
        if "qemu-system" in cmd and needle in cmd:
            try:
                os.kill(int(pid), 9)
                killed.append(pid)
            except OSError:
                pass
    return 0, [json.dumps({"killed": killed})], ""


def verb_rxe_kill_orphan_qemu(args):
    """Retire only the QEMU bound to an RXE node's exact runtime path.

    RXE uses a stable AF_VSOCK CID. An orphan from the same runtime session can
    retain that CID after its directory is removed, so wait for complete process
    exit before allowing the replacement launch. This dedicated verb is called
    only by device_rxe::prepare() and does not alter other QEMU node lifecycles.
    """
    if set(args) != {"run"}:
        raise Reject("bad args")
    run_path = v_re(args, "run", RE_RUNPATH)
    needle = run_path + "/"

    def matching_qemu_pids():
        matches = []
        for pid_text in os.listdir("/proc"):
            if not pid_text.isdigit():
                continue
            try:
                exe = os.path.basename(os.readlink("/proc/%s/exe" % pid_text))
                with open("/proc/%s/cmdline" % pid_text, "rb") as f:
                    argv = [part.decode("latin-1", "replace")
                            for part in f.read().split(b"\x00") if part]
            except OSError:
                continue
            if exe.startswith("qemu-system-") and any(needle in arg for arg in argv):
                matches.append(int(pid_text))
        return matches

    session = int(run_path.rsplit("/", 1)[1])
    unit = _qemu_scope_unit(session)
    _cancel_qemu_quota_timer(session)
    # A managed QEMU normally lives in this exact per-session transient scope.
    # Stopping it first lets systemd clean up its cgroup; the PID scan below also
    # handles pre-scope launch failures and legacy unmanaged processes.
    run_quiet(["systemctl", "stop", unit], timeout=5)

    killed = []
    for pid in matching_qemu_pids():
        try:
            os.kill(pid, signal.SIGKILL)
            killed.append(str(pid))
        except ProcessLookupError:
            pass
        except OSError as e:
            raise Reject("cannot retire orphaned QEMU: %s" % e)

    deadline = time.monotonic() + 5.0
    remaining = matching_qemu_pids()
    while remaining and time.monotonic() < deadline:
        time.sleep(0.05)
        remaining = matching_qemu_pids()
    if remaining:
        raise Reject("orphaned QEMU did not exit")

    run_quiet(["systemctl", "reset-failed", unit], timeout=5)
    return 0, [json.dumps({"killed": killed, "scope": unit})], ""


