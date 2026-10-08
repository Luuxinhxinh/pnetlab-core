# -*- coding: utf-8 -*-
"""Cluster Operations Module (Multi-Host Management).

Extracted from pnetlab-brokerd.py during Clean Architecture refactoring.
Handles satellite registration, synchronization, remote execution, and image distribution.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import time
from typing import Any, Dict, List, Tuple

BASE = '/opt/unetlab'
LABS_DIR = BASE + '/labs'
TMP_DIR = BASE + '/tmp'
MAX_REQUEST = 65536
SHIPPED_MANIFEST = BASE + '/scripts/docker-template-manifest.sha256'
RE_JOB = re.compile(r'^[0-9a-f]{16}$')
RE_CLUSTER_USER = re.compile(r'^[A-Za-z0-9_-]{1,64}$')

def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)

class Reject(Exception):
    pass

def v_int(args: Dict[str, Any], key: str) -> int:
    v = args.get(key)
    if isinstance(v, bool) or not (isinstance(v, int) or (isinstance(v, str) and v.isdigit())):
        raise Reject('bad arg %s' % key)
    n = int(v)
    if n < 0 or n > 2**31:
        raise Reject('bad arg %s' % key)
    return n

def v_enum(args: Dict[str, Any], key: str, allowed: Any) -> Any:
    v = args.get(key)
    if v not in allowed:
        raise Reject('bad arg %s' % key)
    return v

def v_re(args: Dict[str, Any], key: str, rx: re.Pattern) -> str:
    v = args.get(key)
    if not isinstance(v, str) or not rx.match(v):
        raise Reject('bad arg %s' % key)
    return v

def v_ip(args: Dict[str, Any], key: str) -> str:
    v = args.get(key)
    try:
        ipaddress.IPv4Address(v)
    except Exception:
        raise Reject('bad arg %s' % key)
    return v

def v_path_under(args: Dict[str, Any], key: str, root: str) -> str:
    v = args.get(key)
    if not isinstance(v, str) or '\x00' in v:
        raise Reject('bad arg %s' % key)
    real = os.path.realpath(v)
    root_real = os.path.realpath(root).rstrip('/')
    if not (real + '/').startswith(root_real + '/'):
        raise Reject('arg %s is outside %s' % (key, root))
    return real

def v_path_under_any(args: Dict[str, Any], key: str, roots: Tuple[str, ...]) -> str:
    v = args.get(key)
    if not isinstance(v, str) or '\x00' in v:
        raise Reject('bad arg %s' % key)
    real = os.path.realpath(v)
    for root in roots:
        root_real = os.path.realpath(root).rstrip('/')
        if (real + '/').startswith(root_real + '/'):
            return real
    raise Reject('arg %s is outside trusted roots' % key)

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

def spawn_unit(unit, argv, props=(), setenv=()):
    cmd = ['systemd-run', '--collect', '--unit', unit]
    for p in props:
        cmd += ['--property', p]
    for e in setenv:
        cmd += ['--setenv', e]
    cmd += argv
    rc, out, err = run(cmd, timeout=30)
    if rc != 0:
        raise Reject('systemd-run failed: %s' % (err.strip() or rc))
    return unit

# ---- cluster (multi-host) ----------------------------------------------------
# Master-side verbs for the 1-master + up-to-5-satellite cluster. The PSK and
# satellite registry live under /etc/pnetlab/cluster (root 0600) so www-data
# never sees them: PHP asks the broker, the broker owns the TLS+HMAC transport
# to each satellite's pnetlab-satd (port 9050). All verbs are inert until an
# admin generates a PSK (cluster_psk_new).

CLUSTER_DIR = "/etc/pnetlab/cluster"
CLUSTER_PSK = CLUSTER_DIR + "/psk"
CLUSTER_HOSTS = CLUSTER_DIR + "/hosts.json"
CLUSTER_KEY = CLUSTER_DIR + "/id_ed25519"
CLUSTER_MYSQL_CNF = "/etc/mysql/mysql.conf.d/zz-pnetlab-cluster.cnf"
SATD_PORT = 9050
RE_CERT_FP = re.compile(r"^sha256:[0-9a-f]{64}$")
RE_HOST_NAME = re.compile(r"^[A-Za-z0-9 ._-]{1,64}$")
JOIN_TS_WINDOW = 300


def _canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _cluster_psk():
    try:
        with open(CLUSTER_PSK) as f:
            return f.read().strip()
    except OSError:
        raise Reject("no cluster PSK generated")


def _cluster_load_hosts():
    try:
        with open(CLUSTER_HOSTS) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"self_ip": "", "hosts": {}}


def _cluster_save_hosts(data):
    os.makedirs(CLUSTER_DIR, mode=0o700, exist_ok=True)
    tmp = CLUSTER_HOSTS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CLUSTER_HOSTS)


def _mysql(sql):
    """Root SQL on the local pnetlab_db; password via env, never argv."""
    env = dict(os.environ)
    env["MYSQL_PWD"] = "pnetlab"
    p = subprocess.run(["mysql", "--user=root", "pnetlab_db"],
                       input=sql.encode(), stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, env=env, timeout=30)
    if p.returncode != 0:
        raise Reject("mysql: " + p.stderr.decode(errors="replace").strip()[:200])


def verb_cluster_psk_new(args):
    os.makedirs(CLUSTER_DIR, mode=0o700, exist_ok=True)
    psk = secrets.token_hex(32)
    fd = os.open(CLUSTER_PSK, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(psk + "\n")
    return 0, [psk], ""


def verb_cluster_join(args):
    body = args.get("body")
    mac = args.get("hmac")
    if not isinstance(body, dict) or not isinstance(mac, str):
        raise Reject("bad join request")
    psk = _cluster_psk()
    expect = hmac.new(psk.encode(), _canonical(body).encode(),
                      hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expect):
        raise Reject("join auth failed")
    ts = body.get("ts")
    if not isinstance(ts, int) or abs(time.time() - ts) > JOIN_TS_WINDOW:
        raise Reject("join timestamp outside window")
    host_id = v_enum(body, "host_id", {1, 2, 3, 4, 5})
    name = v_re(body, "name", RE_HOST_NAME)
    ip = v_ip(body, "ip")
    cert_fp = v_re(body, "cert_fp", RE_CERT_FP)
    version = str(body.get("version", ""))[:48]

    # first join: expose mysqld on the LAN (host-scoped grants do the gating)
    if not os.path.isfile(CLUSTER_MYSQL_CNF):
        with open(CLUSTER_MYSQL_CNF, "w") as f:
            f.write("# pnetlab cluster: satellites connect to the master DB\n"
                    "[mysqld]\nbind-address = 0.0.0.0\n"
                    "mysqlx-bind-address = 127.0.0.1\n")
        run_quiet(["systemctl", "restart", "mysql"], timeout=120)

    data = _cluster_load_hosts()
    self_ip = args.get("self_ip")
    if isinstance(self_ip, str) and self_ip:
        try:
            ipaddress.IPv4Address(self_ip)
            data["self_ip"] = self_ip
        except Exception:
            pass

    # rotate the per-satellite DB credential; drop a stale grant if the
    # satellite moved IP since the last join
    prev = data["hosts"].get(str(host_id))
    db_pass = secrets.token_urlsafe(18)
    if prev and prev.get("ip") and prev["ip"] != ip:
        _mysql("DROP USER IF EXISTS 'pnetlab'@'%s';" % prev["ip"])
    _mysql(
        "DROP USER IF EXISTS 'pnetlab'@'{ip}';"
        "CREATE USER 'pnetlab'@'{ip}' IDENTIFIED BY '{pw}';"
        "GRANT ALL PRIVILEGES ON pnetlab_db.* TO 'pnetlab'@'{ip}';"
        "FLUSH PRIVILEGES;".format(ip=ip, pw=db_pass))

    if not os.path.isfile(CLUSTER_KEY):
        rc, _, err = run(["ssh-keygen", "-t", "ed25519", "-N", "",
                          "-C", "pnetlab-cluster", "-f", CLUSTER_KEY],
                         timeout=30)
        if rc != 0:
            raise Reject("ssh-keygen failed: " + err.strip()[:200])
    with open(CLUSTER_KEY + ".pub") as f:
        rsync_pubkey = f.read().strip()

    data["hosts"][str(host_id)] = {
        "ip": ip, "name": name, "cert_fp": cert_fp, "version": version,
        "joined": int(time.time()),
    }
    _cluster_save_hosts(data)
    log("cluster: host %d (%s, %s) joined" % (host_id, name, ip))
    return 0, [json.dumps({"db_pass": db_pass, "rsync_pubkey": rsync_pubkey})], ""


def verb_cluster_remove(args):
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    data = _cluster_load_hosts()
    prev = data["hosts"].pop(str(host_id), None)
    if prev and prev.get("ip"):
        try:
            _mysql("DROP USER IF EXISTS 'pnetlab'@'%s';" % prev["ip"])
        except Reject:
            pass  # grant cleanup is best-effort; registry removal is the point
    _cluster_save_hosts(data)
    return 0, [], ""


def verb_cluster_info(args):
    # registry only — the PSK never leaves its root-0600 file
    data = _cluster_load_hosts()
    data["psk_set"] = os.path.isfile(CLUSTER_PSK)
    return 0, [json.dumps(data)], ""


def verb_cluster_sync_lab(args):
    """Ship a lab .unl master->satellite (push: before any remote wrapper run)
    or satellite->master (pull: after a remote export wrote configs into the
    satellite's copy). Rides the join-time ssh key, rrsync-jailed to
    /opt/unetlab on the satellite; -R recreates the labs/... subdirs."""
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    direction = v_enum(args, "direction", {"push", "pull"})
    lab = v_path_under(args, "lab", LABS_DIR)
    if not lab.endswith(".unl"):
        raise Reject("lab must be a .unl file")
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    rel = os.path.relpath(lab, BASE)            # labs/<dir>/<file>.unl
    ssh = ("ssh -i %s -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
           % CLUSTER_KEY)
    if direction == "push":
        if not os.path.isfile(lab):
            raise Reject("lab file missing on master")
        # the /./ marker sets where -R's relative part starts, so the file
        # lands at <jail>/labs/<dir>/<file>.unl with subdirs auto-created
        rc, out, err = run(
            ["rsync", "-a", "-R", "-e", ssh,
             BASE + "/./" + rel, "root@%s:." % h["ip"]],
            timeout=120, check_rc=False)
    else:
        rc, out, err = run(
            ["rsync", "-a", "-e", ssh,
             "root@%s:%s" % (h["ip"], rel), lab],
            timeout=120, check_rc=False)
        if rc == 0:
            # the engine (www-data) must keep write access to the lab file
            shutil.chown(lab, "www-data", "www-data")
    return rc, out, err


def verb_cluster_sync_configscripts(args):
    """Push /opt/unetlab/config_scripts master->satellite so device prep/config
    scripts (template `prep:`/`config_script:`, e.g. SD-WAN prep_c8000vcm.sh that
    builds the cEdge day-0 config.iso) exist on the satellite that runs the node.
    These scripts are not deb-owned (placed by the bundle/SD-WAN install) so a
    joined satellite can otherwise lag the master. Additive rsync (no --delete),
    same join-time ssh key + rrsync jail (/opt/unetlab) as cluster_sync_lab."""
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    if not os.path.isdir(BASE + "/config_scripts"):
        return 0, [], ""
    ssh = ("ssh -i %s -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
           % CLUSTER_KEY)
    # /./ marker: -R lands the tree at <jail>/config_scripts/ (subdirs created)
    rc, out, err = run(
        ["rsync", "-a", "-R", "-e", ssh,
         BASE + "/./config_scripts/", "root@%s:." % h["ip"]],
        timeout=120, check_rc=False)
    return rc, out, err


def verb_cluster_sync_templdefaults(args):
    """Mirror /opt/unetlab/data/template-defaults master->satellite so admin-saved
    per-template Add-Node defaults follow the cluster. A full mirror (--delete)
    keeps both saves AND reverts in lockstep — a reverted (deleted) override
    disappears on the satellite too. Dedicated dir, so --delete is safe. Same
    join-time ssh key + rrsync jail (/opt/unetlab) as cluster_sync_lab."""
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    src = BASE + "/data/template-defaults/"
    if not os.path.isdir(src):
        # nothing saved yet (or all reverted) — create an empty dir so the mirror
        # still runs and --delete clears any stale overrides on the satellite.
        try:
            os.makedirs(src, mode=0o775, exist_ok=True)
        except OSError:
            return 0, [], ""
    ssh = ("ssh -i %s -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
           % CLUSTER_KEY)
    # explicit dest subpath (not -R) so --delete prunes ONLY within
    # data/template-defaults/ on the satellite; data/ exists there already.
    rc, out, err = run(
        ["rsync", "-a", "--delete", "-e", ssh,
         src, "root@%s:data/template-defaults/" % h["ip"]],
        timeout=120, check_rc=False)
    return rc, out, err


def verb_cluster_sync_manifest(args):
    """Push the shipped docker-template capability manifest
    (/opt/unetlab/scripts/docker-template-manifest.sha256) master->satellite.
    The satellite's broker gates dangerous/free-form docker templates on this
    root-owned manifest (_manifest_trusted/_manifest_hashes): it ships inside
    the pnetlab-satellite deb but is REGENERATED on the master by
    gen-template-manifest.sh whenever a shipped template's bytes change, so a
    joined satellite would otherwise fail-closed on those templates. Same
    join-time ssh key + rrsync jail (/opt/unetlab) as cluster_sync_lab; rsync
    runs as root through the jail (root:root ownership, temp-file + rename so
    a broken transfer never leaves a partial file) and --chmod pins 0644 so
    the satellite's _manifest_trusted not-group/other-writable check passes.
    Missing/empty master manifest -> graceful no-op (the satellite keeps its
    deb-shipped copy; pushing an empty file would fail-closed EVERY dangerous
    template there)."""
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    try:
        if os.path.getsize(SHIPPED_MANIFEST) == 0:
            log("cluster_sync_manifest: manifest empty on master — skipped")
            return 0, ["manifest empty on master — skipped"], ""
    except OSError:
        log("cluster_sync_manifest: manifest missing on master — skipped")
        return 0, ["manifest missing on master — skipped"], ""
    ssh = ("ssh -i %s -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
           % CLUSTER_KEY)
    rel = os.path.relpath(SHIPPED_MANIFEST, BASE)
    # /./ marker: -R lands the file at <jail>/scripts/docker-template-
    # manifest.sha256 (scripts/ is deb-owned and already root:root there).
    rc, out, err = run(
        ["rsync", "-a", "-R", "--chmod=F0644", "-e", ssh,
         BASE + "/./" + rel, "root@%s:." % h["ip"]],
        timeout=60, check_rc=False)
    return rc, out, err


RE_IMAGE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/+-]{0,127}$")


def verb_cluster_sync_image(args):
    """Detach a pnet-imgsync worker pushing one image to a satellite (B5
    transient-unit pattern; progress JSON polled via cluster/api.php)."""
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    typ = v_enum(args, "type", {"qemu", "iol", "dynamips", "docker"})
    img = v_re(args, "image", RE_IMAGE)
    if ".." in img:
        raise Reject("bad arg image")
    job = v_re(args, "job", RE_JOB)
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    unit = spawn_unit(
        "pnet-imgsync-" + job,
        ["/bin/bash", BASE + "/scripts/pnet-imgsync.sh",
         h["ip"], typ, img, job],
        props=("IOWeight=50",))
    return 0, ["unit " + unit], ""


def verb_cluster_deploy(args):
    """Detach a pnet-satdeploy worker: push the satellite bundle to a fresh
    Ubuntu 24.04 host over SSH (admin-supplied credentials in the 0600
    jobs/<job>.req, import-worker pattern), install it and join it."""
    job = v_re(args, "job", RE_JOB)
    req = BASE + "/html/cluster/jobs/" + job + ".req"
    if not os.path.isfile(req):
        raise Reject("deploy request missing")
    # SECURITY (Stage 0.5): the .req carries an admin-supplied "user" that
    # pnet-satdeploy.sh places into an ssh destination ("${SUSER}@${IP}"). An
    # unvalidated value like "-oProxyCommand=..." would be read by ssh as an
    # OPTION and run a command as root. Fail-fast here so an obviously-forged
    # user never even spawns the worker. NOTE: www-data owns/writes the .req, so
    # this pre-check is racy against a rewrite between here and the worker's
    # read+shred; the AUTHORITATIVE validation lives in pnet-satdeploy.sh (the
    # consumer), which also passes user/host to ssh after "--" (end-of-options).
    try:
        with open(req) as f:
            ruser = (json.load(f) or {}).get("user", "")
    except (OSError, ValueError):
        raise Reject("deploy request unreadable")
    if not RE_CLUSTER_USER.match(str(ruser)):
        raise Reject("bad ssh user in deploy request")
    unit = spawn_unit(
        "pnet-satdeploy-" + job,
        ["/bin/bash", BASE + "/scripts/pnet-satdeploy.sh", job],
        props=("MemoryMax=2G",))
    return 0, ["unit " + unit], ""


# verbs that stay usable across an engine version skew (monitoring + the
# image probe), so the Cluster page can still show what's wrong
SKEW_SAFE_VERBS = {"ping", "sysinfo", "image_check", "image_list"}
_MASTER_VERSION = None


def _master_version():
    global _MASTER_VERSION
    if _MASTER_VERSION is None:
        rc, out, _ = run(["dpkg-query", "-W", "-f", "${Version}", "pnetlab"],
                         timeout=15)
        _MASTER_VERSION = out[0].strip() if rc == 0 and out else ""
    return _MASTER_VERSION


def _ver_core(v):
    m = re.match(r"(\d+\.\d+\.\d+)", v or "")
    return m.group(1) if m else (v or "")


def verb_cluster_call(args):
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    verb = args.get("verb")
    vargs = args.get("args") or {}
    if not isinstance(verb, str) or not isinstance(vargs, dict):
        raise Reject("bad cluster_call request")
    timeout = min(900, max(5, v_int(args, "timeout"))) \
        if args.get("timeout") is not None else 60

    psk = _cluster_psk()
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)

    try:
        raw = socket.create_connection((h["ip"], SATD_PORT), timeout=10)
    except OSError as e:
        return 255, [], "satellite %d (%s) unreachable: %s" % (
            host_id, h["ip"], e)
    try:
        ctx = ssl._create_unverified_context()
        tls = ctx.wrap_socket(raw)
        der = tls.getpeercert(binary_form=True)
        fp = "sha256:" + hashlib.sha256(der).hexdigest()
        if fp != h["cert_fp"]:
            return 253, [], "satellite %d cert fingerprint mismatch" % host_id
        tls.settimeout(timeout + 10)
        f = tls.makefile("rwb")
        hello = json.loads(f.readline(MAX_REQUEST))
        nonce = hello.get("nonce", "")
        # refuse lifecycle/network verbs across an engine version skew —
        # wrapper/vxlan behaviour must match on both ends of a lab
        if verb not in SKEW_SAFE_VERBS:
            sat_ver = str(hello.get("version", ""))
            mv = _master_version()
            if mv and sat_ver and _ver_core(sat_ver) != _ver_core(mv):
                return 254, [], ("version skew: satellite %d runs %s, master %s"
                                 % (host_id, sat_ver, mv))
        mac = hmac.new(
            psk.encode(),
            (nonce + "\n" + _canonical({"args": vargs, "verb": verb})).encode(),
            hashlib.sha256).hexdigest()
        f.write((json.dumps({"verb": verb, "args": vargs, "hmac": mac})
                 + "\n").encode())
        f.flush()
        line = f.readline(MAX_REQUEST)
        if not line:
            return 255, [], "satellite %d: no response" % host_id
        resp = json.loads(line)
        return (int(resp.get("rc", 255)), list(resp.get("out", [])),
                str(resp.get("err", "")))
    except (OSError, ValueError, ssl.SSLError) as e:
        return 255, [], "satellite %d (%s) error: %s" % (host_id, h["ip"], e)
    finally:
        try:
            raw.close()
        except OSError:
            pass


def verb_cluster_sync_satellite(args):
    """Detach a pnet-satdeb worker pushing a matching satellite/bridge pair.

    The PHP caller selects the pair from root-owned, read-only staging paths;
    the broker repeats the path jail before passing either path to the root
    worker.  This keeps the compatibility fallback useful for old masters
    without turning the new bridge argument into a root path primitive.
    """
    host_id = v_enum(args, "host", {1, 2, 3, 4, 5})
    job = v_re(args, "job", RE_JOB)
    sync_deb_roots = (
        "/opt/unetlab/data/satellite",
        "/opt/unetlab/cluster-bundle",
        "/var/cache/pnetlab/debs",
    )
    deb_source = v_path_under_any(args, "deb_source", sync_deb_roots)
    bridge_deb_source = v_path_under_any(args, "bridge_deb_source", sync_deb_roots)
    data = _cluster_load_hosts()
    h = data["hosts"].get(str(host_id))
    if not h:
        raise Reject("host %d not joined" % host_id)
    sat_ip = h["ip"]
    unit = spawn_unit(
        "pnet-satdeb-" + job,
        ["/bin/bash", BASE + "/scripts/pnet-satdeb-push.sh",
         sat_ip, deb_source, bridge_deb_source, job],
        props=("IOWeight=50",))
    return 0, ["unit " + unit], ""




VERBS = {
    'cluster_psk_new': verb_cluster_psk_new,
    'cluster_join': verb_cluster_join,
    'cluster_remove': verb_cluster_remove,
    'cluster_info': verb_cluster_info,
    'cluster_sync_lab': verb_cluster_sync_lab,
    'cluster_sync_configscripts': verb_cluster_sync_configscripts,
    'cluster_sync_templdefaults': verb_cluster_sync_templdefaults,
    'cluster_sync_manifest': verb_cluster_sync_manifest,
    'cluster_sync_image': verb_cluster_sync_image,
    'cluster_deploy': verb_cluster_deploy,
    'cluster_call': verb_cluster_call,
    'cluster_sync_satellite': verb_cluster_sync_satellite,
}
