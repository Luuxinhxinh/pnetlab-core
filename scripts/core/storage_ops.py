# -*- coding: utf-8 -*-
"""PNetLab Storage, Appliance, Device-Factory & PKI Operations.

Clean Architecture Domain Module extracted from pnetlab-brokerd.py:
- Service restart & system power (shutdown, reboot)
- NUMA balancing & CPU affinity
- IOL keygen & IOL binary operations
- Time sync (chrony/timesyncd/ntp)
- APT proxy configuration
- Device Factory run/kill/rm
- QEMU image operations (qemu_img)
- Filesystem operations (fs_op) & folder deletion
- Lab PKI CA management & CSR signing
- Root filesystem auto-expand (plain & LVM)
"""

import os
import re
import sys
import json
import time
import shutil
import socket
import struct
import subprocess
from typing import Any, Dict, List, Tuple

BASE = '/opt/unetlab'
RUN_DIR = '/run/pnetlab'
TMP_DIR = BASE + '/tmp'
LABS_DIR = BASE + '/labs'

def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)

class Reject(Exception):
    pass

def v_int(args, key):
    v = args.get(key)
    if not isinstance(v, int):
        raise Reject('bad arg %s' % key)
    return v

def v_bool(args, key):
    v = args.get(key)
    if not isinstance(v, bool):
        raise Reject('bad arg %s' % key)
    return v

def v_str(args, key):
    v = args.get(key)
    if not isinstance(v, str) or not v:
        raise Reject('bad arg %s' % key)
    return v

def v_enum(args, key, allowed):
    v = args.get(key)
    if v not in allowed:
        raise Reject('bad arg %s' % key)
    return v

def v_re(args, key, rx):
    v = args.get(key)
    if not isinstance(v, str) or not rx.match(v):
        raise Reject('bad arg %s' % key)
    return v

def v_list(args, key, minlen=0):
    v = args.get(key)
    if not isinstance(v, list) or len(v) < minlen:
        raise Reject('bad arg %s' % key)
    return v

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

# ---- B7: store-side verbs ----------------------------------------------------

def verb_service_restart(args):
    name = v_enum(args, "name", SERVICES)
    return run(["systemctl", "restart", name], timeout=120)


def verb_system_power(args):
    op = v_enum(args, "op", {"reboot", "shutdown"})
    spawn_unit("pnet-power-" + op,
               ["systemctl", "poweroff" if op == "shutdown" else "reboot"])
    return 0, [], ""


def verb_numa_balancing(args):
    state = str(v_enum(args, "state", {0, 1, "0", "1"}))
    return run(["sysctl", "-w", "kernel.numa_balancing=" + state], timeout=30)


def verb_cpu_affinity(args):
    # store "CPU dedicate" toggle: reserve cores 0-1 for the host in
    # /etc/systemd/system.conf + pin docker to the rest. The docker.service
    # sed historically ran WITHOUT sudo (silently failed as www-data) — the
    # verb makes the feature actually take effect.
    state = str(v_enum(args, "state", {0, 1, "0", "1"}))
    on = state == "1"
    rc1 = run_quiet(["sed", "-i",
                     "s/.*CPUAffinity=.*/%sCPUAffinity=0,1/g" % ("" if on else "#"),
                     "/etc/systemd/system.conf"])
    rc2 = run_quiet(["sed", "-i", "-e",
                     "s/.*CPUAffinity=.*/%sCPUAffinity=2-8191/" % ("" if on else "#"),
                     "/lib/systemd/system/docker.service"])
    return (rc1 or rc2), [], ""


def verb_iol_keygen(args):
    # Exec-side guard (defense in depth with the FS_WRITE_DENY jail exclusion in
    # _fs_jailed): refuse to root-run a keygen script that isn't root-owned / is
    # writable, so a planted CiscoIOUKeygen3.py can never execute as root.
    keygen = _require_root_script(IOL_KEYGEN)
    return run(["python3", keygen], timeout=60)


def verb_time_sync(args):
    # replaces the store's dead `sudo ntpdate` (absent on Noble; chrony is in)
    return run(["chronyc", "makestep"], timeout=30)


RE_PROXY_HOST = re.compile(r"^[A-Za-z0-9._-]{1,253}$")
RE_PROXY_CRED = re.compile(r"^[A-Za-z0-9._%+-]{1,64}$")


def verb_apt_proxy_set(args):
    # build the Acquire lines broker-side from validated parts; empty host
    # clears the proxy file (parity with the store's setProxy helper)
    host = args.get("host") or ""
    content = ""
    if host != "":
        host = v_re({"host": host}, "host", RE_PROXY_HOST)
        addr = "%s:%d" % (host, v_int(args, "port"))
        if args.get("user"):
            addr = "%s:%s@%s" % (v_re(args, "user", RE_PROXY_CRED),
                                 v_re(args, "pass", RE_PROXY_CRED), addr)
        content = "".join(
            'Acquire::%s::Proxy "http://%s/";\n' % (s, addr)
            for s in ("http", "https", "ftp"))
    with open("/etc/apt/apt.conf.d/00proxy", "w") as f:
        f.write(content)
    return 0, [], ""


def _factory_path(args):
    # catalog device ids are slugs, not guaranteed numeric
    return "/tmp/pnet_device_factory_" + v_re(args, "id", RE_FACTORY_ID)


def verb_device_factory_run(args):
    # Device-store install scripts: www-data-authored, root-executed — exact
    # parity with the old sudo path (no privilege change), but now id-jailed,
    # journald-logged and kill-able. Real hardening needs vetted/signed
    # scripts from the store catalog; tracked in docs/03 B7 notes.
    script = _factory_path(args)
    # Path is already id-jailed to ^/tmp/pnet_device_factory_<slug>$ (RE_FACTORY_ID,
    # no traversal). Additionally refuse a SYMLINK at either the script or its _log:
    # /tmp is sticky but www-data authors these files, so a symlink swap would make
    # the following chmod / the child's `> _log` redirect land on an arbitrary
    # root-owned target. islink() also catches broken links.
    logpath = script + "_log"
    if os.path.islink(script) or os.path.islink(logpath):
        raise Reject("factory script/log is a symlink (refused)")
    if not os.path.isfile(script):
        raise Reject("no factory script")
    run_quiet(["dos2unix", script])
    os.chmod(script, 0o755)
    nid = v_re(args, "id", RE_FACTORY_ID)
    # Device-store install scripts run `mysql pnetlab_db ...` relying on root's
    # /root/.my.cnf. A transient systemd unit starts with HOME unset, so mysql
    # never reads that file -> ERROR 1045 (root@localhost, using password: NO) on
    # docker image installs. Set HOME=/root so the credential-less root mysql the
    # installer set up actually works.
    # SECURITY (Stage 0.5): HOME=/root is RETAINED deliberately. The child script
    # body is www-data-authored yet root-executed — that is the load-bearing hole
    # here, and it can't be closed without breaking the factory (see RESIDUAL). But
    # because the script ALREADY runs as root it can read /root/.my.cnf directly
    # regardless of HOME, so pointing HOME elsewhere removes no privilege while it
    # DOES break the mysql install path. systemd-run gives the unit a clean env
    # (no brokerd env inherited), so no other sensitive env leaks in; we add only
    # HOME. Path/symlink hardening above bounds the tmp-file vectors.
    # RESIDUAL (deferred): www-data still controls the executed script BODY, so a
    # www-data foothold reaching this verb runs arbitrary code as root. A full fix
    # requires the device-factory to stop exec'ing www-data-authored scripts —
    # e.g. treat the catalog install steps as validated DATA, or ship signed
    # store-catalog scripts from a root-owned dir — which is out of scope for this
    # stage (would need the store DevicesController + catalog format reworked).
    spawn_unit("pnet-factory-" + nid,
               ["/bin/bash", "-c",
                "%s > %s_log 2>&1" % (script, script)],
               setenv=("HOME=/root",))
    return 0, [], ""


def _factory_cleanup(args):
    # Remove BOTH the install/delete script AND its `_log`. The script is
    # www-data-authored but the `_log` is created by THIS root-run unit
    # (`> ..._log`), so it is root-owned. /tmp is sticky, so when the store
    # DevicesController (www-data) later tries to unlink that stale `_log`
    # before the next install/delete, it gets "Operation not permitted" ->
    # 500 -> the GUI shows a blank "Install failed". Clearing it here (as
    # root) means the controller's own is_file()/unlink() are no-ops.
    base = _factory_path(args)
    for p in (base, base + "_log"):
        try:
            os.unlink(p)
        except OSError:
            pass


def verb_device_factory_kill(args):
    nid = v_re(args, "id", RE_FACTORY_ID)
    run_quiet(["systemctl", "stop", "pnet-factory-%s.service" % nid])
    run_quiet(["pkill", "-f", "pnet_device_factory_" + nid])
    # The controller always calls kill right before rewriting the script, so
    # also drop the stale root-owned tmp files here (see _factory_cleanup).
    _factory_cleanup(args)
    return 0, [], ""


def verb_device_factory_rm(args):
    _factory_cleanup(args)
    return 0, [], ""


def _qemu_overlay(args, key):
    """A node's RUNNING disk overlay. Jailed to /opt/unetlab/tmp, never BASE.

    This used to jail to BASE, which also covers /opt/unetlab/addons — so a
    caller could have pointed `commit` at a base image and folded it into
    ITS backing file. Every write op here takes a node overlay, and node
    overlays only ever live under tmp/<session>/<node>/, so the narrower jail
    costs nothing and closes that. The basename is re-validated against the
    same pattern device_qemu.php uses when it creates the linked clone.
    """
    p = v_path_under(args, key, TMP_DIR)
    if not RE_QEMU_DISK.match(os.path.basename(p)):
        raise Reject("arg %s is not a qemu disk name" % key)
    return p


def _qemu_dest_dir(args, key):
    """Destination image directory under addons/qemu, composed BROKER-SIDE.

    The caller supplies a NAME, never a path: the directory is built here from
    a strict regex match, so no traversal, absolute path or symlink component
    can reach the filesystem call. Refuses an existing directory outright —
    silently overwriting a base image that other labs are cloned from would be
    unrecoverable, so this fails closed and the caller picks another name.
    """
    name = args.get(key)
    if not isinstance(name, str) or not RE_QEMU_IMAGE_DIR.match(name):
        raise Reject("bad arg %s" % key)
    dest = ADDONS_QEMU + "/" + name
    if os.path.exists(dest):
        raise Reject("image %s already exists" % name)
    return dest


def verb_qemu_img(args):
    op = v_enum(args, "op", {"info_chain", "commit", "rebase", "save_as"})
    if op == "info_chain":
        # Read-only, and legitimately used against base images too, so this one
        # keeps the wider jail.
        return run(["qemu-img", "info", "--backing-chain",
                    v_path_under(args, "file", BASE)], timeout=120)

    f = _qemu_overlay(args, "file")

    # NOTE (do not "fix" by adding -U): qemu-img takes an image lock, so every
    # op below FAILS CLOSED while the node's qemu still holds the overlay open.
    # That lock is the load-bearing guard against committing or converting a
    # live disk, which yields a torn image rather than an error. The PHP caller
    # also refuses a running node; this is the half that cannot be bypassed by
    # a caller that forgets. `-U`/`--force-share` would defeat both.
    if op == "commit":
        return run(["qemu-img", "commit", f], timeout=1800)

    if op == "save_as":
        dest_dir = _qemu_dest_dir(args, "dest")
        dest = dest_dir + "/" + os.path.basename(f)
        # Space: `convert` writes a STANDALONE image, so the whole backing
        # chain gets flattened into the destination. Size it from the chain's
        # virtual size, not the overlay's allocated size, and keep a margin —
        # filling /opt takes the appliance down, not just this operation.
        need = _qemu_virtual_size(f) + (256 * 1024 * 1024)
        free = shutil.disk_usage(ADDONS_QEMU).free
        if free < need:
            raise Reject("not enough space: need ~%dMB, have %dMB"
                         % (need // 1048576, free // 1048576))
        os.makedirs(dest_dir, exist_ok=True)
        rc, out, err = run(["qemu-img", "convert", "-O", "qcow2", f, dest],
                           timeout=3600)
        if rc != 0:
            # Never leave a half-written image behind: a truncated qcow2 in
            # addons/qemu is indistinguishable from a good one in the template
            # list, and nodes would be cloned from it.
            shutil.rmtree(dest_dir, ignore_errors=True)
            return rc, out, err
        run(["chown", "-R", "www-data:www-data", dest_dir], timeout=300)
        os.chmod(dest_dir, 0o755)
        os.chmod(dest, 0o644)
        return rc, out, err

    backing = v_path_under(args, "backing", ADDONS_QEMU)
    return run(["qemu-img", "rebase", "-b", backing, f], timeout=1800)


def _qemu_virtual_size(f):
    """Virtual size of an image chain, in bytes; 0 when it cannot be read."""
    rc, out, _ = run(["qemu-img", "info", "--output=json", f], timeout=120)
    if rc != 0:
        return 0
    try:
        return int(json.loads("\n".join(out)).get("virtual-size") or 0)
    except (ValueError, TypeError, AttributeError):
        return 0


def _fs_jailed(args, key):
    v = args.get(key)
    if not isinstance(v, str) or "\x00" in v:
        raise Reject("bad arg %s" % key)
    # realpath the parent (target may not exist yet for mkdir/cp/mv)
    parent = os.path.realpath(os.path.dirname(v.rstrip("/")) or "/")
    real = parent + "/" + os.path.basename(v.rstrip("/"))
    if not any((real + "/").startswith(j + "/") for j in FS_JAILS):
        raise Reject("arg %s escapes fs jails" % key)
    # SECURITY (Stage 0.5): even though these dirs sit INSIDE the writable jail
    # (/opt/unetlab/addons), refuse any fs_op that targets a path the broker later
    # root-EXECUTES (the IOL keygen bin dir). Otherwise a www-data caller could
    # cp_f/mv_f a payload onto CiscoIOUKeygen3.py (legitimately in-jail) and then
    # trigger verb_iol_keygen to run it as root. Legit keygen install goes through
    # the ishare2/import worker (direct root cp), never this verb, so denying the
    # dir here does not break image installs.
    if any((real + "/").startswith(d + "/") for d in FS_WRITE_DENY):
        raise Reject("arg %s targets a root-executed path (refused)" % key)
    # SECURITY (2026-07-12): the PARENT is realpath'd but the final component is
    # deliberately not (the target may not exist yet for mkdir/cp/mv). A symlink
    # whose NAME is the final component therefore passes the jail check above and
    # is then dereferenced by the following cp/chown/chmod — letting a www-data
    # caller (the jails /opt/unetlab/{addons,tmp}+/tmp/commit are www-data-
    # writable) escape the jail and write/chown/chmod an arbitrary root-owned
    # file (e.g. a component named `dst` symlinked to /etc/cron.d/x). Refuse a
    # symlink final component outright — jailed fs ops never legitimately target
    # one (islink() is true for broken links too, so this covers not-yet-
    # resolvable targets). When the target already exists as a real path, also
    # re-check the FULLY resolved path against the jails as belt-and-suspenders.
    # (A narrow TOCTOU remains: a www-data caller could race a symlink into place
    # between this check and the coreutils op; the coreutils calls default to
    # not traversing symlinks during -R recursion, which bounds it.)
    if os.path.islink(real):
        raise Reject("arg %s is a symlink (refused)" % key)
    if os.path.exists(real):
        realfull = os.path.realpath(real)
        if not any((realfull + "/").startswith(j + "/") for j in FS_JAILS):
            raise Reject("arg %s escapes fs jails" % key)
    return real


def verb_fs_op(args):
    # root file ops for the store's image-commit flows, jailed to
    # /opt/unetlab/{addons,tmp} + /tmp/commit
    op = v_enum(args, "op",
                {"mkdir_p", "rm_rf", "cp_f", "mv_f", "chown_www", "chmod_755"})
    p = _fs_jailed(args, "path")
    if op == "mkdir_p":
        os.makedirs(p, exist_ok=True)
        return 0, [], ""
    if op == "rm_rf":
        shutil.rmtree(p, ignore_errors=True)
        try:
            os.unlink(p)
        except OSError:
            pass
        return 0, [], ""
    if op == "chown_www":
        return run(["chown", "-R", "www-data:www-data", p], timeout=300)
    if op == "chmod_755":
        return run(["chmod", "-R", "755", p], timeout=300)
    dst = _fs_jailed(args, "dst")
    if op == "cp_f":
        return run(["cp", "-f", p, dst], timeout=1800)
    return run(["mv", "-f", p, dst], timeout=300)


# addons/iol/bin write-deny carve-out (Stage 0.5): verb_fs_op refuses ALL
# writes into this dir via FS_WRITE_DENY, because it's where verb_iol_keygen
# root-execs CiscoIOUKeygen3.py from — a generic mv_f/cp_f there would let
# www-data plant a payload over that script. Legitimate .bin image
# install/rename/delete (GUI image manager, images-manage/api.php) still need
# to land here, so this is a narrow, filename-locked carve-out: every path
# this verb touches is composed broker-side from a whitelisted bare filename
# (never a caller-supplied path), and the keygen script's own name is
# explicitly refused.
RE_IOL_BIN_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.bin$")
IOL_BIN_DIR = BASE + "/addons/iol/bin"


def _iol_bin_name(args, key):
    name = args.get(key)
    if not isinstance(name, str) or not RE_IOL_BIN_NAME.match(name):
        raise Reject("bad arg %s" % key)
    if name.lower() == os.path.basename(IOL_KEYGEN).lower():
        raise Reject("arg %s refused" % key)
    return name


def verb_iol_bin_op(args):
    op = v_enum(args, "op", {"install", "rename", "delete"})
    os.makedirs(IOL_BIN_DIR, exist_ok=True)
    if op == "install":
        # src must already be inside a www-data-writable jail (FS_JAILS) —
        # e.g. the upload assembly dir under /opt/unetlab/tmp/uploads/.
        src = _fs_jailed(args, "src")
        name = _iol_bin_name(args, "name")
        if not os.path.isfile(src) or os.path.islink(src):
            raise Reject("bad src")
        dest = IOL_BIN_DIR + "/" + name
        if os.path.islink(dest):
            raise Reject("dest is a symlink (refused)")
        shutil.move(src, dest)
        os.chmod(dest, 0o755)
        return 0, [dest], ""

    name = _iol_bin_name(args, "name")
    target = IOL_BIN_DIR + "/" + name
    if os.path.islink(target):
        raise Reject("target is a symlink (refused)")
    if not os.path.isfile(target):
        raise Reject("target not found")

    if op == "delete":
        os.remove(target)
        return 0, [], ""

    # rename
    newname = _iol_bin_name(args, "newname")
    dest = IOL_BIN_DIR + "/" + newname
    if os.path.islink(dest):
        raise Reject("dest is a symlink (refused)")
    os.rename(target, dest)
    return 0, [dest], ""


def verb_folder_delete(args):
    # Root rm -rf of ONE lab folder, for the web tier's apiDeleteFolder retry when
    # a plain www-data rm fails on root-owned content (AI-builder-written labs).
    # Jailed STRICTLY under /opt/unetlab/labs: never the labs root itself, no
    # traversal, must be an existing directory.
    path = v_path_under(args, "path", LABS_DIR)
    if (path + "/") == (LABS_DIR.rstrip("/") + "/"):
        raise Reject("refusing to delete the labs root")
    if not os.path.isdir(path):
        raise Reject("not a directory")
    shutil.rmtree(path)
    return 0, [], ""


# ---- Lab PKI (pki) ----------------------------------------------------------
# Thin dispatch to the cryptography-backed CA engine. The engine runs as root
# (brokerd is root), owns /opt/unetlab/data/pki (CA keys 0600), and prints ONE
# JSON line. www-data never touches the store — artifacts return through here.
PKI_HELPER = BASE + "/scripts/pki/pnet-pki.py"
RE_PKI_ID = re.compile(r"^[0-9a-f]{12}$")
PKI_ACTIONS = {"profiles", "ca_create", "list", "issue", "sign_csr",
               "export", "revoke", "crl", "delete_ca"}
PKI_PROFILES = {"server", "client", "server_client", "radius_eap",
                "ipsec", "https", "device"}
PKI_KEYTYPES = {"rsa2048", "rsa4096", "ec256", "ec384"}
PKI_FORMATS = {"cert", "key", "chain", "fullchain", "ca", "p12", "der"}


def _pki_text(args, key, maxlen):
    """Copy a printable, length-capped string field (or skip if absent)."""
    v = args.get(key)
    if v is None:
        return None
    if not isinstance(v, str):
        raise Reject("bad arg %s" % key)
    return "".join(c for c in v if 32 <= ord(c) < 127)[:maxlen]


def verb_pki(args):
    action = v_enum(args, "action", PKI_ACTIONS)
    p = {}
    # ids first — path-traversal defense (the engine re-checks, belt+suspenders)
    if args.get("ca_id") is not None:
        p["ca_id"] = v_re(args, "ca_id", RE_PKI_ID)
    if args.get("cert_id") is not None:
        p["cert_id"] = v_re(args, "cert_id", RE_PKI_ID)
    if action in ("issue", "sign_csr"):
        p["profile"] = v_enum(args, "profile", PKI_PROFILES)
    if action in ("ca_create", "issue"):
        p["key_type"] = v_enum(args, "key_type", PKI_KEYTYPES) \
            if args.get("key_type") is not None else "rsa2048"
    if args.get("days") is not None:
        p["days"] = v_int(args, "days")          # engine bounds the range
    if action == "export":
        p["format"] = v_enum(args, "format", PKI_FORMATS)
    # capped free-text subject fields (engine sanitizes again before X.509)
    for k, ml in (("name", 64), ("org", 64), ("ou", 64), ("country", 2),
                  ("cn", 253), ("lab", 64)):
        t = _pki_text(args, k, ml)
        if t is not None:
            p[k] = t
    if args.get("two_tier") is not None:
        p["two_tier"] = v_bool(args, "two_tier")
    if args.get("p12_pass") is not None:
        p["p12_pass"] = _pki_text(args, "p12_pass", 128)
    if args.get("sans") is not None:
        sans = v_list(args, "sans", 64)
        p["sans"] = [s for s in
                     ("".join(c for c in str(x) if 32 <= ord(c) < 127)[:253]
                      for x in sans) if s]
    if action == "sign_csr":
        csr = args.get("csr")
        if not isinstance(csr, str) or len(csr) > 32768 or \
                "BEGIN CERTIFICATE REQUEST" not in csr:
            raise Reject("bad csr")
        p["csr"] = csr
    proc = subprocess.run(["/usr/bin/python3", PKI_HELPER, action],
                          input=json.dumps(p).encode(),
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=60)
    out = proc.stdout.decode("utf-8", "replace").splitlines()
    if proc.returncode != 0 and not out:
        raise Reject("pki: " + (proc.stderr.decode("utf-8", "replace").strip()
                                or ("rc=%d" % proc.returncode)))
    return 0, out, ""                               # out = one JSON line




def verb_disk_expand(args):
    """Detect or expand the root filesystem.

    op=detect — probe root partition layout (plain vs LVM), filesystem size,
    disk total, and growable free space.  Returns rc0 + out[0]=JSON.

    op=expand — run the detected expansion steps (growpart + resize2fs/xfs_growfs
    for plain; pvresize + lvextend + grow for LVM).  Returns rc0 + out[0]=JSON
    with before/after sizes.  Idempotent: if no space is available returns
    ok:true with a note.
    """
    op = v_enum(args, "op", {"detect", "expand"})

    # ---- helpers ----
    def _gb(nbytes):
        return round(nbytes / (1024 ** 3), 2)

    def _df_bytes():
        """Return (fs_size_bytes, fs_used_bytes) for the root mount."""
        rc2, out2, _ = run(["df", "-B1", "--output=size,used", "/"], timeout=30)
        for line in out2:
            parts = line.split()
            if len(parts) == 2 and parts[0].isdigit():
                return int(parts[0]), int(parts[1])
        raise Reject("df failed")

    def _lsblk_size(dev):
        """Return device size in bytes via lsblk -b."""
        rc2, out2, _ = run(["lsblk", "-b", "-d", "-n", "-o", "SIZE", dev], timeout=30)
        for line in out2:
            s = line.strip()
            if s.isdigit():
                return int(s)
        raise Reject("lsblk size failed for %s" % dev)

    # ---- detect root device ----
    rc, out, err = run(["findmnt", "-no", "SOURCE", "/"], timeout=30)
    if rc != 0 or not out:
        raise Reject("findmnt failed: %s" % err.strip()[:120])
    root_source = out[0].strip()   # e.g. /dev/sda1 or /dev/mapper/ubuntu--vg-ubuntu--lv

    # ---- detect fstype ----
    rc, out2, _ = run(["findmnt", "-no", "FSTYPE", "/"], timeout=30)
    fstype = (out2[0].strip() if out2 else "ext4")

    # ---- LVM detection ----
    is_lvm = root_source.startswith("/dev/mapper/") or root_source.startswith("/dev/dm-")
    vg, lv = "", ""
    part = root_source
    disk = ""
    part_num = ""

    if is_lvm:
        # Resolve LV name -> VG/LV
        rc2, lv_out, _ = run(["lvs", "--noheadings", "-o", "vg_name,lv_name",
                               root_source], timeout=30)
        for line in lv_out:
            cols = line.split()
            if len(cols) >= 2:
                vg, lv = cols[0], cols[1]
                break
        # Find the underlying PV (first one, enough for single-disk setups)
        rc2, pv_out, _ = run(["pvs", "--noheadings", "-o", "pv_name,vg_name"],
                              timeout=30)
        for line in pv_out:
            cols = line.split()
            if len(cols) >= 2 and cols[1] == vg:
                part = cols[0]    # e.g. /dev/sda3
                break
    else:
        part = root_source        # e.g. /dev/sda1

    # Strip partition number to get the disk device (e.g. /dev/sda1 -> /dev/sda, num=1)
    # Handles /dev/sdaN, /dev/nvme0n1pN, /dev/vdaN
    import re as _re
    m = _re.match(r"^(/dev/(?:nvme\d+n\d+|[a-z]+))p?(\d+)$", part)
    if m:
        disk = m.group(1)
        part_num = m.group(2)
    else:
        # Fallback: disk = part (whole-disk or unknown layout; no growpart possible)
        disk = part
        part_num = ""

    # ---- sizes ----
    try:
        fs_bytes, fs_used = _df_bytes()
    except Reject:
        fs_bytes, fs_used = 0, 0

    disk_bytes = 0
    if disk:
        try:
            disk_bytes = _lsblk_size(disk)
        except Reject:
            pass

    # For LVM: growable = VG free extents (vgs reports in the requested unit)
    growable_bytes = 0
    if is_lvm and vg:
        rc2, vg_out, _ = run(["vgs", "--noheadings", "--units", "b",
                               "-o", "vg_free", vg], timeout=30)
        for line in vg_out:
            s = line.strip().rstrip("B").rstrip("b")
            try:
                growable_bytes = int(float(s))
                break
            except ValueError:
                pass
        if growable_bytes == 0 and part and disk and part_num:
            # VG free is zero — underlying partition may still have unallocated disk space
            part_bytes = 0
            try:
                part_bytes = _lsblk_size(part)
            except Reject:
                pass
            growable_bytes = max(0, disk_bytes - part_bytes)
    else:
        # Plain: growable = disk - partition
        part_bytes = 0
        if part and part != disk:
            try:
                part_bytes = _lsblk_size(part)
            except Reject:
                pass
        growable_bytes = max(0, disk_bytes - part_bytes)

    expandable = growable_bytes > (512 * 1024 * 1024)   # >512 MiB free

    # ---- build human-readable commands ----
    commands = []
    if expandable and part_num and disk:
        if is_lvm:
            commands = [
                "growpart %s %s" % (disk, part_num),
                "pvresize %s" % part,
                "lvextend -l +100%%FREE /dev/%s/%s" % (vg, lv),
                ("resize2fs /dev/%s/%s" % (vg, lv)) if fstype in ("ext2", "ext3", "ext4")
                else ("xfs_growfs /"),
            ]
        else:
            commands = [
                "growpart %s %s" % (disk, part_num),
                ("resize2fs %s" % part) if fstype in ("ext2", "ext3", "ext4")
                else ("xfs_growfs /"),
            ]
    elif expandable:
        if is_lvm and vg and lv:
            commands = [
                "pvresize %s" % part,
                "lvextend -l +100%%FREE /dev/%s/%s" % (vg, lv),
                ("resize2fs /dev/%s/%s" % (vg, lv)) if fstype in ("ext2", "ext3", "ext4")
                else ("xfs_growfs /"),
            ]

    info = {
        "root_mount": "/",
        "dev": root_source,
        "part": part,
        "fstype": fstype,
        "is_lvm": is_lvm,
        "vg": vg,
        "lv": lv,
        "fs_size_gb": _gb(fs_bytes),
        "disk_total_gb": _gb(disk_bytes),
        "growable_gb": _gb(growable_bytes),
        "expandable": expandable,
        "commands": commands,
    }

    if op == "detect":
        return 0, [json.dumps(info)], ""

    # ---- op == expand ----
    before_gb = _gb(fs_bytes)
    steps = []

    if not expandable:
        return 0, [json.dumps({
            "ok": True, "before_gb": before_gb, "after_gb": before_gb,
            "steps": ["nothing to grow (growable_gb=%.2f)" % _gb(growable_bytes)],
        })], ""

    if not commands:
        return 0, [json.dumps({
            "ok": False, "before_gb": before_gb, "after_gb": before_gb,
            "steps": ["could not determine expansion commands"],
        })], ""

    ok = True
    for cmd_str in commands:
        argv = cmd_str.split()
        try:
            rc2, out2, err2 = run(argv, timeout=120, check_rc=False)
            steps.append({"cmd": cmd_str, "rc": rc2,
                           "out": out2[:10], "err": err2.strip()[:200]})
            if rc2 != 0:
                # growpart rc=1 means "no space to grow" — treat as non-fatal
                if argv[0] == "growpart" and rc2 == 1:
                    steps[-1]["note"] = "partition already at disk edge"
                else:
                    ok = False
                    break
        except Exception as exc:
            steps.append({"cmd": cmd_str, "rc": -1, "err": str(exc)[:200]})
            ok = False
            break

    # after size
    try:
        after_bytes, _ = _df_bytes()
    except Reject:
        after_bytes = fs_bytes
    after_gb = _gb(after_bytes)

    return 0, [json.dumps({
        "ok": ok, "before_gb": before_gb, "after_gb": after_gb, "steps": steps,
    })], ""

