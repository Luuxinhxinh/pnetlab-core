#!/usr/bin/env python3
# pnetlab-satd — satellite-side cluster agent.
#
# Runs as root on a cluster SATELLITE and is the only management path into it:
# the master's brokerd `cluster_call` verb TLS-connects here (port 9050),
# authenticates with an HMAC over the cluster PSK, and either forwards an
# allowlisted verb to the satellite's LOCAL pnetlab-brokerd (unix socket) or
# runs one of the few satd-native verbs (sysinfo, image_check).
#
# Protocol (one request per TLS connection, JSON-per-line, mirrors brokerd):
#   S->C  {"hello":"pnetlab-satd","version":"...","host_id":1,"nonce":"<32hex>"}\n
#   C->S  {"verb":"...","args":{...},"hmac":"<hex>"}\n
#   S->C  {"ok":bool,"rc":int,"out":[lines],"err":"..."}\n
#
# hmac = HMAC_SHA256(PSK, nonce + "\n" + canonical_json({"args":...,"verb":...}))
# where canonical_json = sorted keys, no spaces. The PSK never crosses the
# wire; a fresh nonce per connection kills replay. TLS gives confidentiality;
# the master pins this host's self-signed cert fingerprint recorded at join.
#
# Run via pnetlab-satd.service (shipped in the pnetlab-satellite deb).

import hashlib
import hmac as hmac_mod
import json
import os
import secrets
import socket
import socketserver
import ssl
import struct
import subprocess
import sys
import time

CONF_PATH = "/etc/pnetlab-satellite/satd.conf"
CERT_PATH = "/etc/pnetlab-satellite/satd-cert.pem"
KEY_PATH = "/etc/pnetlab-satellite/satd-key.pem"
BROKER_SOCK = "/run/pnetlab/broker.sock"
LISTEN = ("0.0.0.0", 9050)
MAX_REQUEST = 1048576
ADDONS = "/opt/unetlab/addons"

# Verbs relayed verbatim to the local brokerd (which re-validates every arg).
# `wrapper` is the long pole (node start can pull an image into qemu, IOL
# licence checks, etc.) — give it the same 600 s budget brokerd allows.
FORWARD_VERBS = {
    "ping", "wrapper", "nodestats", "session_cleanup",
    "node_kill_workspace", "vxlan_attach", "vxlan_detach",
    # Learning/inspection features run against the satellite's LOCAL taps and
    # consoles, so the engine relays them here for satellite-placed nodes:
    # Protocol Painter/overlays + BGP waterfall (node_show), Network Watcher +
    # link glow (linkwatch_*), Protocol Inspector (prototrace_*).
    "node_show", "node_show_many", "node_validate",
    "linkwatch_start", "linkwatch_stop", "linkwatch_status",
    "linkwatch_probe", "linkwatch_snapshot", "linkstats",
    "prototrace_start", "prototrace_stop", "prototrace_status",
    "prototrace_snapshot",
}
SLOW_VERBS = {"wrapper"}
# the parallel overlay gather (node_show_many) telnets several local consoles
GATHER_VERBS = {"node_show_many"}
# console telnet/expect (node_show -> pnet-showcmd) can take up to ~75 s
MED_VERBS = {"node_show", "node_validate"}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def load_conf():
    with open(CONF_PATH) as f:
        conf = json.load(f)
    if not conf.get("psk") or not conf.get("host_id"):
        raise RuntimeError("satd.conf missing psk/host_id")
    return conf


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def pkg_version():
    for pkg in ("pnetlab-satellite", "pnetlab"):
        try:
            rc = subprocess.run(
                ["dpkg-query", "-W", "-f", "${Version}", pkg],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
            if rc.returncode == 0 and rc.stdout:
                return rc.stdout.decode().strip()
        except Exception:
            pass
    return "unknown"


def broker_forward(verb, args, timeout):
    """Relay one request to the local brokerd; satd runs as root so the
    SO_PEERCRED check passes."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(BROKER_SOCK)
        s.sendall((json.dumps({"verb": verb, "args": args}) + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n") and len(buf) < MAX_REQUEST:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    finally:
        s.close()
    if not buf:
        return {"ok": False, "rc": 255, "out": [], "err": "local broker no response"}
    return json.loads(buf)


# ---- satd-native verbs -------------------------------------------------------

def read_meminfo():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 2:
                info[parts[0].rstrip(":")] = int(parts[1])  # kB
    return info


def cpu_sample():
    with open("/proc/stat") as f:
        fields = [int(x) for x in f.readline().split()[1:]]
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)  # idle + iowait
    return idle, sum(fields)


def pgrep_count(pattern):
    try:
        p = subprocess.run(["pgrep", "-f", "-c", "-P", "1", pattern],
                           stdout=subprocess.PIPE, timeout=10)
        return int(p.stdout.decode().strip() or 0)
    except Exception:
        return 0


def docker_count():
    try:
        p = subprocess.run(
            ["docker", "-H=unix:///var/run/docker.sock", "ps", "-q"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        out = p.stdout.decode().strip()
        return len(out.splitlines()) if out else 0
    except Exception:
        return 0


def verb_sysinfo(args):
    """Counterpart of the master's StatusController getSystemInfo +
    getRunningNodes + getInfo, in one shot for the cluster status cache."""
    idle0, total0 = cpu_sample()
    time.sleep(0.2)
    idle1, total1 = cpu_sample()
    dt = total1 - total0
    cpu = 0 if dt <= 0 else round(100 * (1 - (idle1 - idle0) / dt))

    mem = read_meminfo()
    total_ram = mem.get("MemTotal", 0)
    avail = mem.get("MemAvailable", 0)
    ram = 0 if total_ram <= 0 else round(100 * (1 - avail / total_ram))
    total_swap = mem.get("SwapTotal", 0)
    free_swap = mem.get("SwapFree", 0)
    swap = 0 if total_swap <= 0 else round(100 * (1 - free_swap / total_swap))

    st = os.statvfs("/")
    total_disk = st.f_blocks * st.f_frsize
    disk = 0 if st.f_blocks <= 0 else round(
        100 * (1 - st.f_bavail / st.f_blocks))

    qemu_version = ""
    try:
        p = subprocess.run(["/opt/qemu/bin/qemu-system-x86_64", "-version"],
                           stdout=subprocess.PIPE, timeout=10)
        first = p.stdout.decode().splitlines()[0]
        for tok in first.split():
            if tok[0:1].isdigit():
                qemu_version = tok
                break
    except Exception:
        pass

    with open("/proc/uptime") as f:
        uptime = int(float(f.read().split()[0]))

    data = {
        "cpu": cpu, "ram": ram, "swap": swap, "disk": disk,
        "total_ram": total_ram,          # kB, like /proc/meminfo
        "total_swap": total_swap,        # kB
        "total_disk": total_disk,        # bytes
        "cores": os.cpu_count() or 0,
        "qemu_version": qemu_version,
        "uptime": uptime,
        "version": pkg_version(),
        "counts": {
            "iol": pgrep_count("iol_wrapper"),
            "dynamips": pgrep_count("dynamips"),
            "qemu": pgrep_count("qemu-system"),
            "docker": docker_count(),
            "vpcs": pgrep_count("vpcs"),
        },
    }
    return {"ok": True, "rc": 0, "out": [json.dumps(data)], "err": ""}


def verb_image_check(args):
    """Does this satellite already have the image a node needs?"""
    typ = args.get("type")
    image = args.get("image") or ""
    if typ not in ("qemu", "iol", "dynamips", "docker") or \
            not isinstance(image, str) or image == "" or \
            "/" in image or ".." in image:
        return {"ok": False, "rc": 254, "out": [], "err": "bad type/image"}
    present = False
    if typ == "qemu":
        d = os.path.join(ADDONS, "qemu", image)
        present = os.path.isdir(d) and len(os.listdir(d)) > 0
    elif typ == "iol":
        present = os.path.isfile(os.path.join(ADDONS, "iol", "bin", image))
    elif typ == "dynamips":
        present = os.path.isfile(os.path.join(ADDONS, "dynamips", image))
    elif typ == "docker":
        try:
            p = subprocess.run(
                ["docker", "-H=unix:///var/run/docker.sock", "image", "inspect", image],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            present = p.returncode == 0
        except Exception:
            present = False
    return {"ok": True, "rc": 0,
            "out": [json.dumps({"present": present})], "err": ""}


def verb_image_list(args):
    """Full inventory of images present on this satellite."""
    import glob as _glob
    result = {"qemu": [], "iol": [], "dynamips": [], "docker": []}
    # qemu: dirs with at least one file
    qemu_base = os.path.join(ADDONS, "qemu")
    try:
        for name in sorted(os.listdir(qemu_base)):
            d = os.path.join(qemu_base, name)
            if os.path.isdir(d) and len(os.listdir(d)) > 0:
                result["qemu"].append(name)
    except OSError:
        pass
    # iol: *.bin files in addons/iol/bin
    iol_base = os.path.join(ADDONS, "iol", "bin")
    try:
        for name in sorted(os.listdir(iol_base)):
            if name.endswith(".bin"):
                result["iol"].append(name)
    except OSError:
        pass
    # dynamips: *.image files
    dyn_base = os.path.join(ADDONS, "dynamips")
    try:
        for name in sorted(os.listdir(dyn_base)):
            if name.endswith(".image"):
                result["dynamips"].append(name)
    except OSError:
        pass
    # docker: via the unix socket (tcp :4243 retired)
    try:
        p = subprocess.run(
            ["docker", "-H=unix:///var/run/docker.sock", "images",
             "--format", "{{.Repository}}:{{.Tag}}"],
            capture_output=True, text=True, timeout=15)
        if p.returncode == 0:
            result["docker"] = sorted(
                l.strip() for l in p.stdout.splitlines() if l.strip())
    except Exception:
        pass
    return {"ok": True, "rc": 0, "out": [json.dumps(result)], "err": ""}


NATIVE_VERBS = {
    "sysinfo": verb_sysinfo,
    "image_check": verb_image_check,
    "image_list": verb_image_list,
}


# ---- server ------------------------------------------------------------------

class Handler(socketserver.StreamRequestHandler):
    timeout = 15  # hello + request read; bumped per-verb for the dispatch

    def handle(self):
        conf = self.server.conf
        peer = self.client_address[0]
        nonce = secrets.token_hex(16)
        hello = {"hello": "pnetlab-satd", "version": self.server.version,
                 "host_id": int(conf["host_id"]), "nonce": nonce}
        try:
            self.wfile.write((json.dumps(hello) + "\n").encode())
            raw = self.rfile.readline(MAX_REQUEST)
            req = json.loads(raw)
            verb = req.get("verb")
            args = req.get("args") or {}
            mac = req.get("hmac") or ""
            if not isinstance(args, dict) or not isinstance(verb, str):
                raise ValueError("bad request")
            expect = hmac_mod.new(
                conf["psk"].encode(),
                (nonce + "\n" + canonical({"args": args, "verb": verb})).encode(),
                hashlib.sha256).hexdigest()
            if not hmac_mod.compare_digest(mac, expect):
                log("DENY %s verb=%s: bad hmac" % (peer, verb))
                resp = {"ok": False, "rc": 253, "out": [], "err": "auth failed"}
            elif verb in NATIVE_VERBS:
                resp = NATIVE_VERBS[verb](args)
            elif verb in FORWARD_VERBS:
                budget = 600 if verb in SLOW_VERBS else (
                    150 if verb in GATHER_VERBS else
                    90 if verb in MED_VERBS else 60)
                self.connection.settimeout(budget + 10)
                resp = broker_forward(verb, args, budget)
            else:
                log("DENY %s: verb %r not allowed" % (peer, verb))
                resp = {"ok": False, "rc": 254, "out": [], "err": "verb not allowed"}
            log("%s verb=%s -> rc=%d" % (peer, verb, resp.get("rc", -1)))
        except Exception as e:
            log("ERROR %s: %r" % (peer, e))
            resp = {"ok": False, "rc": 255, "out": [], "err": "satd error"}
        try:
            self.wfile.write((json.dumps(resp) + "\n").encode())
        except (BrokenPipeError, ssl.SSLError, OSError):
            pass


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, ctx):
        super().__init__(addr, handler)
        self.ctx = ctx

    def get_request(self):
        sock, addr = super().get_request()
        return self.ctx.wrap_socket(sock, server_side=True), addr


def ensure_iourc():
    """The IOU license is host-locked (hostid+hostname), so a copy from any
    other host can never license IOL here. Regenerate whenever the entry for
    THIS host is missing — covers fresh installs and satellites whose iourc a
    pre-6.7.16 imgsync clobbered with the master's."""
    keygen = os.path.join(ADDONS, "iol", "bin", "CiscoIOUKeygen3.py")
    iourc = os.path.join(ADDONS, "iol", "bin", "iourc")
    if not os.path.isfile(keygen):
        return
    host = socket.gethostname()
    try:
        with open(iourc) as fh:
            if any(line.split("=")[0].strip() == host
                   for line in fh if "=" in line):
                return
    except OSError:
        pass
    try:
        subprocess.run(["python3", keygen], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30)
        os.chmod(iourc, 0o644)
        log("regenerated host-locked IOL iourc for %s" % host)
    except Exception as e:
        log("iourc keygen failed: %r" % e)


def main():
    conf = load_conf()
    ensure_iourc()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT_PATH, KEY_PATH)
    srv = Server(LISTEN, Handler, ctx)
    srv.conf = conf
    srv.version = pkg_version()
    log("pnetlab-satd host_id=%s listening on %s:%d" %
        (conf["host_id"], LISTEN[0], LISTEN[1]))
    srv.serve_forever()


if __name__ == "__main__":
    main()
