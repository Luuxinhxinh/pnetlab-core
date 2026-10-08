# -*- coding: utf-8 -*-
"""Docker Engine Operations Module.

Extracted from pnetlab-brokerd.py during Clean Architecture refactoring.
Handles container lifecycle, execution, copy, image management, and capture containers.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from typing import Any, Dict, List, Tuple

try:
    import yaml
except Exception:
    yaml = None

BASE = '/opt/unetlab'
TMP_DIR = BASE + '/tmp'

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

def v_bool(args: Dict[str, Any], key: str) -> int:
    return 1 if args.get(key) in (1, '1', True, 'true', 'yes', 'on') else 0

def run(argv, timeout=60, stderr=None, check_rc=True):
    p = subprocess.run(argv, stdout=subprocess.PIPE,
                       stderr=stderr if stderr is not None else subprocess.PIPE,
                       timeout=timeout)
    out = p.stdout.decode('utf-8', 'replace').splitlines()
    err = '' if stderr is not None else p.stderr.decode('utf-8', 'replace')
    return p.returncode, out, err

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

# ---- docker rebroker (Stage 1) ----------------------------------------------
# Container names are always DERIVED broker-side from typed integer ids — PHP
# never passes a free-form name. Node containers are docker<node_session>;
# per-interface capture containers are
# Capture_<tenant>_<lab_session>_<node_session>_<interface_id> (node_session
# 901/902 = the Wi-Fi airduct/vwifi synthetic capture nodes — real names, must
# be accepted); the legacy shared per-lab capture container is
# Capture_<tenant>_<lab_session>. RE_CTR covers all three shapes for any later
# verb that receives a name (e.g. echoed back from `docker ps`) instead of ids.
# Stage 7: the tcp://127.0.0.1:4243 endpoint is GONE (pnetlab-docker 6.0.0-31
# binds unix:///var/run/docker.sock only). The broker runs as root, so it dials
# the unix socket directly; every verb below inherits this single constant.
DOCKER_HOST = "unix:///var/run/docker.sock"
# A network OS runs thousands of threads. With the systemd cgroup driver an
# omitted (or -1) create limit can inherit DefaultTasksMax, only 1550 on a small
# fresh VM. Use an explicit, bounded per-node budget with room for convergence
# and larger images; no host-wide systemd setting or caller-controlled limit.
DOCKER_NODE_PIDS_LIMIT = 16384
RE_CTR = re.compile(r"^(?:docker\d+|Capture_\d+_\d+(?:_\d+_\d+)?)$")
# The only --format templates the engine's read-only inspect sites use.
# Anything else is rejected — no free-form Go-template passthrough.
DOCKER_INSPECT_FORMATS = {
    "{{ .State.Running }}",
    "{{ .State.Pid }}",
    "{{json .State}}",
}


def _docker_name(node_session):
    """docker<node_session> — the engine's node-container name
    (device_docker.php --name=docker<getSession()>)."""
    return "docker%d" % v_int({"node_session": node_session}, "node_session")


def _capture_name(tenant, lab_session, node_session, interface_id):
    """Capture_<t>_<l>_<ns>_<if> — per-interface capture container name.
    node_session 901/902 (Wi-Fi synthetic capture nodes) are ordinary ints
    here and pass through like any other — do NOT special-case them."""
    return "Capture_%d_%d_%d_%d" % (
        v_int({"tenant": tenant}, "tenant"),
        v_int({"lab_session": lab_session}, "lab_session"),
        v_int({"node_session": node_session}, "node_session"),
        v_int({"interface_id": interface_id}, "interface_id"))


def _capture_shared_name(tenant, lab_session):
    """Capture_<t>_<l> — legacy shared per-lab capture container name
    (functions.php Capture_<labId> / Capture_<t>_<l> sites)."""
    return "Capture_%d_%d" % (
        v_int({"tenant": tenant}, "tenant"),
        v_int({"lab_session": lab_session}, "lab_session"))


def verb_docker_inspect(args):
    """READ-ONLY `docker inspect` on a container whose name is derived HERE
    from typed integer ids (never accepted as a string from the caller).
    format, when present, must be one of the allowlisted templates above.
    Fails closed (Reject) on any bad id/kind/format."""
    kind = v_enum(args, "kind", {"node", "capture", "capture_shared"})
    if kind == "node":
        name = _docker_name(args.get("node_session"))
    elif kind == "capture":
        name = _capture_name(args.get("tenant"), args.get("lab_session"),
                             args.get("node_session"), args.get("interface_id"))
    else:
        name = _capture_shared_name(args.get("tenant"), args.get("lab_session"))
    argv = ["docker", "-H=" + DOCKER_HOST, "inspect"]
    if args.get("format") is not None:
        argv += ["--format", v_enum(args, "format", DOCKER_INSPECT_FORMATS)]
    argv.append(name)
    return run(argv, timeout=30)


# ---- docker rebroker (Stage 2): typed-capability container lifecycle --------
# The `docker create` command used to be assembled as a FREE-FORM ROOT SHELL
# STRING in www-data PHP (device_{docker,ceos,srlinux}.php) and exec()'d. That
# string carried every dangerous capability (--privileged, --cap-add, --device,
# --mount, --sysctl, -u, entrypoint) directly, so a www-data foothold that could
# influence it was root-equivalent on the host.
#
# Stage 2 moves the whole builder here. The broker ROOT-READS the node's
# template YAML itself, extracts the capability set from it (never from the
# caller), maps each capability to a FIXED flag token with per-value validation,
# and executes a docker argv ARRAY (never `sh -c`, never a joined string).
# www-data PHP passes only typed, already-user-settable, validated leaf values
# (image, node name, ram/cpu ints, console publish ports derived engine-side).
#
# Template capability input has two forms:
#   1. A typed `docker:` schema block (preferred) -> _docker_build_typed().
#   2. Legacy free-form `dock_args`/`docker_options` strings -> accepted ONLY if
#      the template FILE's sha256 is in the shipped root:root manifest
#      (/opt/unetlab/scripts/docker-template-manifest.sha256, integrity-verified
#      root-owned by _manifest_trusted). The SAME in-memory buffer is hashed and
#      yaml-parsed (no re-read -> no TOCTOU). shlex.split -> per-token allowlist.
#   On a manifest miss the create FAILS CLOSED with a conversion/sign message.
#
# ceos/srlinux carry their dangerous flags as driver-hardcoded strings in PHP
# (their templates have no dock_args); those become root-authored broker profiles
# here (family=ceos/srlinux) taking only charset/int/bool leaf values.

TEMPLATES_DIR = BASE + "/html/templates"
# The shipped free-form template manifest lives OUTSIDE /opt/unetlab/html on
# purpose: fixpermissions chowns the html tree to www-data, so a manifest under
# html was www-data-writable on a running box and www-data could self-sign its
# own --privileged/-v:/host template (reopening the closed www-data->root path).
# /opt/unetlab/scripts is a root-owned dir the fixpermissions sweep never chowns
# to www-data; _manifest_hashes() also verifies root-ownership fail-closed.
SHIPPED_MANIFEST = BASE + "/scripts/docker-template-manifest.sha256"

RE_TEMPLATE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
RE_DEV = re.compile(r"^/dev/[a-z0-9/_-]+$")
RE_ENVKEY = re.compile(r"^[A-Z0-9_]+$")
RE_SHM = re.compile(r"^[0-9]+[kKmMgG]?$")
RE_USER = re.compile(r"^[0-9]+(:[0-9]+)?$")
RE_LEAF = re.compile(r"^[A-Za-z0-9_.-]+$")          # ETBA / EOS_PLATFORM / Card_Type
RE_MOUNT_TARGET = re.compile(r"^/[A-Za-z0-9_./-]+$")

CAP_ALLOW = {"NET_ADMIN", "NET_RAW", "SYS_ADMIN"}
# CAPABILITY TIERS (docker-rebroker fix1). The host-root-equivalent tier below
# is only honoured when the template's exact bytes are in the shipped manifest
# (i.e. signed) — the SAME gate the legacy free-form dock_args path enforces.
# The benign subset (net none/bridge, publish, env, mem/cpu, shm, sysctls,
# NET_ADMIN/NET_RAW, runpath-jailed mounts) stays usable UNSIGNED so future
# nodes need no signing.
CAP_DANGEROUS = {"SYS_ADMIN"}          # host-root-equivalent cap -> signed-only
DEV_ALLOW = {"/dev/fuse"}
NET_ALLOW = {"none", "bridge"}         # unsigned-allowed network modes
NET_DANGEROUS = {"host"}               # host namespace -> signed-only
RESTART_ALLOW = {"no", "on-failure", "always", "unless-stopped"}
# The six srlinux sysctl keys (device_srlinux.php:210). Values must be "0"/"1".
SYSCTL_ALLOW = {
    "net.ipv6.conf.all.disable_ipv6",
    "net.ipv4.ip_forward",
    "net.ipv6.conf.all.accept_dad",
    "net.ipv6.conf.default.accept_dad",
    "net.ipv6.conf.all.autoconf",
    "net.ipv6.conf.default.autoconf",
}
# -v host bind sources: a fixed SHIPPED allowlist (root-owned, read-only paths).
SHIPPED_VOL_ALLOW = {
    "/opt/unetlab/startup_configs/Docker/SR_linux/license.key",
}
HOSTPORT_FLOOR = 1024
RE_IMG_ID_SUFFIX = re.compile(r":[0-9a-f]{12}$|:[0-9a-f]{64}$")


def _docker_platform():
    """Mirror includes/init.php: /opt/unetlab/platform == 'svm' -> amd else intel."""
    try:
        with open(BASE + "/platform") as f:
            fam = f.read().strip()
    except Exception:
        fam = ""
    return "amd" if fam == "svm" else "intel"


def _docker_read_template(template):
    """Root-read the node template YAML ONCE. Returns (raw_bytes, parsed_dict,
    path). The raw bytes back both the manifest hash and the yaml parse so the
    legacy free-form gate has no TOCTOU. Fails closed on a bad name / missing
    file / unparseable yaml."""
    if yaml is None:
        raise Reject("docker_create: PyYAML unavailable in broker")
    name = v_re({"template": template}, "template", RE_TEMPLATE)
    if ".." in name or "/" in name:
        raise Reject("bad arg template")
    path = "%s/%s/%s.yml" % (TEMPLATES_DIR, _docker_platform(), name)
    if os.path.islink(path):
        raise Reject("template: refuse symlinked template file")
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except Exception:
        raise Reject("template not found: %s" % name)
    try:
        tpl = yaml.safe_load(raw)
    except Exception:
        raise Reject("template: unparseable yaml")
    if not isinstance(tpl, dict):
        raise Reject("template: not a mapping")
    return raw, tpl, path


def _manifest_trusted(path):
    """FAIL-CLOSED integrity gate for the shipped manifest. The manifest
    authorises host-root-equivalent docker flags, so it is trusted ONLY when
    BOTH the file AND its parent dir are root-owned (uid 0) and not
    group/other-writable. This defeats the www-data self-sign path: if
    fixpermissions (or any tampering) ever flips the manifest or its dir to
    www-data-owned/writable, or the file is mislocated, this returns False and
    _manifest_hashes() yields the empty set -> every dangerous/free-form
    template is refused rather than silently honoured."""
    try:
        st = os.stat(path)
    except Exception as e:
        log("manifest: refusing untrusted manifest %s: unreadable/missing (%s)" % (path, e))
        return False
    if st.st_uid != 0:
        log("manifest: refusing untrusted manifest %s: not root-owned (uid=%d)" % (path, st.st_uid))
        return False
    if st.st_mode & 0o022:
        log("manifest: refusing untrusted manifest %s: group/other-writable (mode=%o)" % (path, st.st_mode & 0o777))
        return False
    parent = os.path.dirname(path) or "/"
    try:
        pst = os.stat(parent)
    except Exception as e:
        log("manifest: refusing untrusted manifest %s: parent dir unstatable (%s)" % (path, e))
        return False
    if pst.st_uid != 0:
        log("manifest: refusing untrusted manifest %s: parent dir %s not root-owned (uid=%d)" % (path, parent, pst.st_uid))
        return False
    if pst.st_mode & 0o022:
        log("manifest: refusing untrusted manifest %s: parent dir %s group/other-writable (mode=%o)" % (path, parent, pst.st_mode & 0o777))
        return False
    return True


def _manifest_hashes():
    """The set of sha256 hex digests in the shipped manifest. The manifest MUST
    be root-owned and not group/other-writable, and so must its parent dir
    (verified by _manifest_trusted); otherwise -> empty set (every free-form /
    dangerous template refused). Absent/unreadable manifest -> empty set too."""
    if not _manifest_trusted(SHIPPED_MANIFEST):
        return set()
    hashes = set()
    try:
        with open(SHIPPED_MANIFEST) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                h = line.split()[0].lower()
                if re.match(r"^[0-9a-f]{64}$", h):
                    hashes.add(h)
    except Exception:
        pass
    return hashes


def _resolve_runpath_file(runpath, spec):
    """Resolve a template-supplied bind/env-file SOURCE to a path under the
    node runningPath jail. Only the basename is honoured (template writes
    './eve_env.txt', 'startup-config', '<card>.yml'). lstat-rejects a symlink
    and realpath-rejects any escape. RESIDUAL: runningPath lives under the
    www-data-writable /opt/unetlab/tmp, so www-data authors the file BYTES
    (not the path) — hence :ro is preferred by callers and symlink/escape are
    closed here."""
    base = os.path.basename(spec.rstrip("/"))
    if base in ("", ".", ".."):
        raise Reject("template: bad bind source %r" % spec)
    p = os.path.join(runpath, base)
    if os.path.islink(p):
        raise Reject("template: refuse symlinked bind source %r" % base)
    real = os.path.realpath(p)
    if real != runpath and not (real + "/").startswith(runpath.rstrip("/") + "/"):
        raise Reject("template: bind source escapes runningPath")
    return p


def _ff_take(tokens, i, tok):
    """Return (value, new_index) for a `--flag=value` or `--flag value` form."""
    if "=" in tok and tok.startswith("--"):
        return tok.split("=", 1)[1], i
    if i + 1 >= len(tokens):
        raise Reject("template: flag %s missing value" % tok)
    return tokens[i + 1], i + 1


def _parse_mount_spec(val, runpath):
    """type=bind,source=<runpath-jailed>,target=<abs>[,readonly|,ro]. Rejects
    any type other than bind and any non-basename escape."""
    parts = [p for p in val.split(",") if p != ""]
    kv = {}
    flags = []
    for p in parts:
        if "=" in p:
            k, v = p.split("=", 1)
            kv[k.strip()] = v.strip()
        else:
            flags.append(p.strip())
    if kv.get("type") != "bind":
        raise Reject("template: only type=bind mounts allowed")
    src = kv.get("source") or kv.get("src")
    tgt = kv.get("target") or kv.get("destination") or kv.get("dst")
    if not src or not tgt:
        raise Reject("template: mount missing source/target")
    if not RE_MOUNT_TARGET.match(tgt):
        raise Reject("template: bad mount target")
    real = _resolve_runpath_file(runpath, src)
    ro = ("readonly" in flags) or ("ro" in flags) or (kv.get("readonly") == "true")
    spec = "type=bind,source=%s,target=%s" % (real, tgt)
    if ro:
        spec += ",readonly"
    return spec


def _parse_volume_spec(val, runpath):
    """-v SRC:DST[:opts]. SRC is either a SHIPPED_VOL_ALLOW path (forced :ro) or
    a runningPath-jailed basename."""
    bits = val.split(":")
    if len(bits) < 2:
        raise Reject("template: bad -v spec")
    src, dst = bits[0], bits[1]
    opts = bits[2] if len(bits) > 2 else ""
    if not RE_MOUNT_TARGET.match(dst):
        raise Reject("template: bad -v target")
    real_src = os.path.realpath(src)
    if real_src in SHIPPED_VOL_ALLOW:
        return "%s:%s:ro" % (real_src, dst)
    jailed = _resolve_runpath_file(runpath, src)
    ro = "ro" in opts.split(",")
    return "%s:%s%s" % (jailed, dst, ":ro" if ro else "")


def _parse_freeform(text, runpath, allow_publish_net):
    """shlex-split a legacy dock_args/docker_options STRING and rebuild a
    VALIDATED docker argv list. Every recognised token maps to a fixed flag;
    anything unrecognised fails closed with a conversion/sign hint."""
    tokens = shlex.split(text)
    out = []
    i = 0
    n = len(tokens)
    while i < n:
        t = tokens[i]
        if t == "--privileged":
            out.append(t)
        elif t in ("-it", "-ti", "-i", "-t", "-d"):
            out.append(t)
        elif t == "--cap-add" or t.startswith("--cap-add="):
            v, i = _ff_take(tokens, i, t)
            if v not in CAP_ALLOW:
                raise Reject("template: cap %r not allowed" % v)
            out.append("--cap-add=" + v)
        elif t == "--device" or t.startswith("--device="):
            v, i = _ff_take(tokens, i, t)
            if not RE_DEV.match(v) or v not in DEV_ALLOW:
                raise Reject("template: device %r not allowed" % v)
            out += ["--device", v]
        elif t in ("--net", "--network") or t.startswith("--net=") or t.startswith("--network="):
            v, i = _ff_take(tokens, i, t)
            # free-form only reaches here after the shipped-manifest gate in
            # _docker_capabilities (i.e. signed), so the dangerous net=host mode
            # is permitted here — the signature is the authorization.
            if v not in (NET_ALLOW | NET_DANGEROUS):
                raise Reject("template: net mode %r not allowed" % v)
            out.append("--net=" + v)
        elif t == "--shm-size" or t.startswith("--shm-size="):
            v, i = _ff_take(tokens, i, t)
            if not RE_SHM.match(v):
                raise Reject("template: bad --shm-size %r" % v)
            out += ["--shm-size", v]
        elif t in ("-u", "--user") or t.startswith("--user="):
            v, i = _ff_take(tokens, i, t)
            if not RE_USER.match(v):
                raise Reject("template: bad --user %r" % v)
            out += ["-u", v]
        elif t in ("-e", "--env") or t.startswith("--env="):
            v, i = _ff_take(tokens, i, t)
            key = v.split("=", 1)[0]
            if not RE_ENVKEY.match(key):
                raise Reject("template: bad env key %r" % key)
            if "\x00" in v:
                raise Reject("template: bad env value")
            out += ["-e", v]
        elif t == "--env-file" or t.startswith("--env-file="):
            v, i = _ff_take(tokens, i, t)
            out += ["--env-file", _resolve_runpath_file(runpath, v)]
        elif t == "--sysctl" or t.startswith("--sysctl="):
            v, i = _ff_take(tokens, i, t)
            key = v.split("=", 1)[0]
            if key not in SYSCTL_ALLOW:
                raise Reject("template: sysctl %r not allowed" % key)
            out += ["--sysctl", v]
        elif t == "--restart" or t.startswith("--restart="):
            v, i = _ff_take(tokens, i, t)
            if v not in RESTART_ALLOW:
                raise Reject("template: bad --restart %r" % v)
            out.append("--restart=" + v)
        elif t == "--mount" or t.startswith("--mount="):
            v, i = _ff_take(tokens, i, t)
            out += ["--mount", _parse_mount_spec(v, runpath)]
        elif t in ("-v", "--volume") or t.startswith("--volume="):
            v, i = _ff_take(tokens, i, t)
            out += ["-v", _parse_volume_spec(v, runpath)]
        elif t == "--shm-size":
            raise Reject("template: --shm-size missing value")
        else:
            raise Reject(
                "template: unsupported docker flag %r — convert the template to "
                "the typed docker: schema or sign it with pnetlab-template-sign" % t)
        i += 1
    return out


def _docker_build_typed(block, runpath, signed):
    """Map a template `docker:` schema block to a validated docker argv list.
    Unknown keys / out-of-enum values fail closed.

    CAPABILITY-TIERED SIGNING (docker-rebroker fix1): host-root-equivalent
    features (privileged, cap SYS_ADMIN, net=host, any --device, any host bind
    outside the shipped safe allowlist) are only honoured when `signed` is True
    — i.e. the template's exact bytes are in the shipped manifest, the SAME gate
    the legacy free-form dock_args path enforces. `signed` is derived by the
    caller from a sha256 over the very buffer this block was parsed from, so
    there is no re-read and no TOCTOU. The benign subset stays usable unsigned."""
    if not isinstance(block, dict):
        raise Reject("template: docker: block not a mapping")
    known = {"privileged", "cap_add", "devices", "net", "shm_size", "user",
             "env", "env_file", "mounts", "volumes", "sysctls", "restart",
             "entrypoint"}
    # Fail closed on any key outside the known schema — in particular the
    # namespace/escape keys (pid, ipc, userns, security_opt, cgroup_parent,
    # runtime, device_cgroup_rule, volumes_from, ...) are NOT emitted by any
    # shipped template and MUST NOT be, signed or not.
    unknown = set(block) - known
    if unknown:
        raise Reject("template: unknown docker: keys %s" % sorted(unknown))

    # `privileged` is emitted only on the bool True (identity), so a YAML-truthy
    # non-bool (`1`, `"true"`, `yes`->parsed non-bool) would SILENTLY drop
    # privilege on a SIGNED template — safe security-wise but a footgun for the
    # author. Fail loud instead of silently ignoring it.
    if "privileged" in block and not isinstance(block["privileged"], bool):
        raise Reject("template: docker: privileged must be a boolean (true/false)")

    def need_sign(feature):
        if not signed:
            raise Reject(
                "template requests %s but its bytes are not in the shipped "
                "manifest; convert to the safe subset or have an admin sign it: "
                "sudo pnetlab-template-sign" % feature)

    out = []
    if block.get("privileged") is True:
        need_sign("privileged")
        out.append("--privileged")
    for c in block.get("cap_add", []) or []:
        if c not in CAP_ALLOW:
            raise Reject("template: cap %r not allowed" % c)
        if c in CAP_DANGEROUS:
            need_sign("cap %s" % c)
        out.append("--cap-add=" + c)
    for d in block.get("devices", []) or []:
        if not RE_DEV.match(str(d)) or d not in DEV_ALLOW:
            raise Reject("template: device %r not allowed" % d)
        need_sign("device %s" % d)
        out += ["--device", d]
    if "net" in block:
        nv = block["net"]
        if nv in NET_DANGEROUS:
            need_sign("net=%s" % nv)
        elif nv not in NET_ALLOW:
            raise Reject("template: net mode not allowed")
        out.append("--net=" + nv)
    if "shm_size" in block:
        if not RE_SHM.match(str(block["shm_size"])):
            raise Reject("template: bad shm_size")
        out += ["--shm-size", str(block["shm_size"])]
    if "user" in block:
        if not RE_USER.match(str(block["user"])):
            raise Reject("template: bad user")
        out += ["-u", str(block["user"])]
    for k, val in (block.get("env") or {}).items():
        if not RE_ENVKEY.match(str(k)):
            raise Reject("template: bad env key %r" % k)
        out += ["-e", "%s=%s" % (k, val)]
    if "env_file" in block:
        out += ["--env-file", _resolve_runpath_file(runpath, str(block["env_file"]))]
    for m in block.get("mounts", []) or []:
        src = m.get("source")
        tgt = m.get("target")
        if not src or not tgt or not RE_MOUNT_TARGET.match(str(tgt)):
            raise Reject("template: bad mount")
        real = _resolve_runpath_file(runpath, str(src))
        spec = "type=bind,source=%s,target=%s" % (real, tgt)
        if m.get("ro", True):
            spec += ",readonly"
        out += ["--mount", spec]
    for v in block.get("volumes", []) or []:
        src = os.path.realpath(str(v.get("source", "")))
        tgt = v.get("target")
        if not tgt or not RE_MOUNT_TARGET.match(str(tgt)):
            raise Reject("template: bad volume target")
        if src in SHIPPED_VOL_ALLOW:
            out += ["-v", "%s:%s:ro" % (src, tgt)]
        else:
            # a host bind outside the shipped safe allowlist is host-root-reach
            # -> dangerous-tier, permitted only for a signed template.
            need_sign("host bind %s" % src)
            ro = ":ro" if v.get("ro", True) else ""
            out += ["-v", "%s:%s%s" % (src, tgt, ro)]
    for k, val in (block.get("sysctls") or {}).items():
        if k not in SYSCTL_ALLOW:
            raise Reject("template: sysctl %r not allowed" % k)
        out += ["--sysctl", "%s=%s" % (k, val)]
    if "restart" in block:
        if block["restart"] not in RESTART_ALLOW:
            raise Reject("template: bad restart")
        out.append("--restart=" + block["restart"])
    return out, list(block.get("entrypoint") or [])


def _docker_capabilities(tpl, raw, runpath, allow_publish_net):
    """Return (cap_argv, entrypoint_argv) sourced from the template. BOTH the
    typed docker: block and the legacy free-form strings are gated on the shipped
    manifest for the host-root-equivalent capability tier: `signed` is a sha256
    over the SAME in-memory `raw` buffer that produced `tpl` (no re-read -> no
    TOCTOU), matched against the root-owned manifest. The typed path honours the
    benign subset unsigned and requires the signature only for dangerous caps;
    the free-form path requires the signature for ANY dock_args (it cannot be
    tier-inspected)."""
    digest = hashlib.sha256(raw).hexdigest()
    signed = digest in _manifest_hashes()
    if isinstance(tpl.get("docker"), dict):
        return _docker_build_typed(tpl["docker"], runpath, signed)
    free = (tpl.get("dock_args") or "").strip() or (tpl.get("docker_options") or "").strip()
    entry = []
    dock_cmd = (tpl.get("dock_cmd") or "").strip()
    if dock_cmd:
        entry = shlex.split(dock_cmd)
    if not free:
        return [], entry
    if not signed:
        raise Reject(
            "template not in shipped manifest (sha256=%s): convert its "
            "dock_args/docker_options to the typed docker: schema, or an admin "
            "must sign it with /opt/unetlab/scripts/pnetlab-template-sign" % digest)
    return _parse_freeform(free, runpath, allow_publish_net), entry


def _docker_console_publish(args):
    """Build `--net=bridge -p H:G ...` from the caller's typed publish pairs.
    Host ports are engine-assigned ints (>=1024); guest is the console port."""
    pub = args.get("publish")
    if not pub:
        return []
    if not isinstance(pub, list) or len(pub) > 4:
        raise Reject("bad arg publish")
    out = ["--net=bridge"]
    for p in pub:
        if not isinstance(p, dict):
            raise Reject("bad arg publish")
        host = v_int(p, "host")
        guest = v_int(p, "guest")
        if host < HOSTPORT_FLOOR or host > 65535 or guest < 1 or guest > 65535:
            raise Reject("publish port out of range")
        out += ["-p", "%d:%d" % (host, guest)]
    return out


def _docker_image(args):
    """Strip a trailing :<imageid> (12/64 hex) — mirrors the PHP drivers — then
    validate against RE_IMAGE."""
    img = args.get("image")
    if not isinstance(img, str):
        raise Reject("bad arg image")
    img = RE_IMG_ID_SUFFIX.sub("", img)
    if not RE_IMAGE.match(img) or ".." in img:
        raise Reject("bad arg image")
    return img


def _docker_hostname(args):
    """The -h hostname is the node name — an option-argument (single argv token,
    no shell), so it cannot inject a flag. Reject only NUL/newline and cap len."""
    v = args.get("name")
    if not isinstance(v, str) or v == "" or len(v) > 64:
        raise Reject("bad arg name")
    if "\x00" in v or "\n" in v or "\r" in v:
        raise Reject("bad arg name")
    return v


def verb_docker_create(args):
    """Build a `docker create` argv from typed leaf values + the ROOT-READ
    template capability set, and execute it as an array (never a shell string).
    Container name is derived here as docker<session>.

    family:
      docker  -- device_docker.php. Two branches selected by the template:
                 dock_args non-empty -> network-OS branch (no console publish);
                 else GUI branch (GDK/QT env + console publish). Both cap memory
                 (--memory <ram>M) and, if cpu>0, --cpus.
      ceos    -- device_ceos.php driver profile (fixed cEOS env + /sbin/init
                 setenv entrypoint; ETBA/EOS_PLATFORM are charset-validated leaf
                 values). No resource caps.
      srlinux -- device_srlinux.php driver profile (fixed sysctls + -u 0:0 +
                 --net=none + card-topology mount + optional startup-config mount
                 + optional license -v; sr_linux entrypoint). No resource caps."""
    session = v_int(args, "session")
    lab_session = v_int(args, "lab_session")
    family = v_enum(args, "family", {"docker", "ceos", "srlinux"})
    template = args.get("template")
    name = _docker_hostname(args)
    image = _docker_image(args)
    runpath = "%s/%d/%d" % (TMP_DIR, lab_session, session)
    cname = "docker%d" % session

    argv = ["docker", "-H=" + DOCKER_HOST, "create",
            "--pids-limit=%d" % DOCKER_NODE_PIDS_LIMIT]

    if family == "docker":
        raw, tpl, _ = _docker_read_template(template)
        dock_args = (tpl.get("dock_args") or "").strip()
        gui = not dock_args and not isinstance(tpl.get("docker"), dict)
        caps, entry = _docker_capabilities(tpl, raw, runpath, allow_publish_net=gui)
        if gui:
            argv += ["--env", "GDK_SCALE=2", "--env", "QT_SCALE_FACTOR=1.5"]
        argv.append("-ti")
        ram = args.get("ram")
        if ram is not None:
            argv += ["--memory", "%dM" % v_int(args, "ram")]
        cpu = int(v_int(args, "cpu")) if args.get("cpu") is not None else 0
        if cpu > 0:
            argv.append("--cpus=%d" % cpu)
        argv += caps
        if gui:
            argv += _docker_console_publish(args)
        if args.get("firstboot"):
            fb = _resolve_runpath_file(runpath, "firstboot.cfg")
            argv += ["-v", "%s:/firstboot.cfg:ro" % fb]
        argv += ["--name=" + cname, "-h", name, image]
        argv += entry

    elif family == "ceos":
        etba = v_re(args, "etba", RE_LEAF)
        eos_platform = v_re(args, "eos_platform", RE_LEAF)
        # device_ceos.php: fixed env + --net=none --privileged, then the
        # /sbin/init systemd.setenv entrypoint appended after the image.
        argv += [
            "-e", "INTFTYPE=eth", "-e", "ETBA=" + etba,
            "-e", "SKIP_ZEROTOUCH_BARRIER_IN_SYSDBINIT=1", "-e", "CEOS=1",
            "-e", "EOS_PLATFORM=" + eos_platform, "-e", "container=docker",
            "--net=none", "--privileged",
        ]
        argv += _docker_console_publish(args)
        argv += ["--name=" + cname, "-h", name, image]
        argv += [
            "/sbin/init", "systemd.setenv=INTFTYPE=eth",
            "systemd.setenv=ETBA=" + etba,
            "systemd.setenv=SKIP_ZEROTOUCH_BARRIER_IN_SYSDBINIT=1",
            "systemd.setenv=CEOS=1",
            "systemd.setenv=EOS_PLATFORM=" + eos_platform,
            "systemd.setenv=container=docker", "systemd.setenv=MAPETH0=1",
            "systemd.setenv=MGMT_INTF=eth0",
        ]

    else:  # srlinux
        card_type = v_re(args, "card_type", RE_LEAF)
        clab_intfs = v_int(args, "clab_intfs")
        # device_srlinux.php: startup-config mount (if present), clab_intfs env,
        # fixed sysctls + --net=none -u 0:0, card-topology mount, optional
        # license -v, then the sr_linux entrypoint.
        if args.get("has_startup"):
            src = _resolve_runpath_file(runpath, "startup-config")
            argv += ["--mount", "type=bind,source=%s,target=/startup-config" % src]
        argv += ["-e", "clab_intfs=%d" % clab_intfs]
        for k in ("net.ipv6.conf.all.disable_ipv6=0", "net.ipv4.ip_forward=0",
                  "net.ipv6.conf.all.accept_dad=0",
                  "net.ipv6.conf.default.accept_dad=0",
                  "net.ipv6.conf.all.autoconf=0",
                  "net.ipv6.conf.default.autoconf=0"):
            argv += ["--sysctl", k]
        argv += ["--net=none", "-u", "0:0"]
        topo = _resolve_runpath_file(runpath, card_type + ".yml")
        argv += ["--mount",
                 "type=bind,source=%s,target=/tmp/topology.yml,readonly" % topo]
        if v_bool(args, "sr_license"):
            lic = "/opt/unetlab/startup_configs/Docker/SR_linux/license.key"
            if os.path.realpath(lic) in SHIPPED_VOL_ALLOW:
                argv += ["-v", "%s:/opt/srlinux/etc/license.key:ro" % lic]
        argv += _docker_console_publish(args)
        argv += ["--name=" + cname, "-h", name, image]
        argv += ["sudo", "bash", "/opt/srlinux/bin/sr_linux"]

    log("docker_create %s family=%s image=%s" % (cname, family, image))
    return run(argv, timeout=120)


# ---- docker rebroker (Stage 3): exec + cp with fixed allowlists -------------
# The drivers used to exec() free-form `docker exec` / `docker cp` ROOT SHELL
# STRINGS built in PHP from engine state. Stage 3 replaces them with two verbs:
#
#   docker_exec — the command comes from the fixed enum below (every current
#     driver exec shape, enumerated by grep), never from the caller. The one
#     parameterised entry (ethtool_offload_e1) takes only a typed int. The
#     attach_* entries are the console-attach commands consumed today by the
#     ROOT-run console bridge (docker_console.sh/.py, docker_wrapper — launched
#     by the root unl_wrapper phase, NOT by www-data); they are in the enum so
#     the attach set is broker-authoritative and a later console stage can
#     route the PTY launch here without widening the allowlist. Anything not
#     in the enum is Rejected — there is NO free-form passthrough.
#
#   docker_cp — sources/dests come from the fixed selector map below: shipped
#     root-owned wrapper binaries pushed in from /opt/unetlab/wrappers (owner
#     verified uid 0, symlink-rejected), runningPath-jailed engine files pushed
#     in (basename-only, lstat symlink-reject + realpath jail — Stage 2 mount
#     discipline), and the two config-export out-copies whose DEST is jailed
#     the same way. RESIDUAL (same as Stage 2 mounts): the runningPath IN-copy
#     files (node_shell.sh, startup-config, initial-config) are www-data-
#     authored, so the BYTES are attacker-influenceable; only the path/name
#     is pinned here.
#
# Interactive vs one-shot: each enum entry carries the exact flags its call
# site used (-u root / -i / -it). The capture lane's one exec shape
# (raise_wireshark_window) rides this verb too — see the Stage 6 note in
# verb_docker_exec.

WRAPPERS_DIR = BASE + "/wrappers"

# cmd -> (exec flags, command argv) — exact current driver shapes.
DOCKER_EXEC_CMDS = {
    # one-shot maintenance/config execs
    "umount_resolv": (["-u", "root"], ["umount", "/etc/resolv.conf"]),
    "chmod_node_shell": ([], ["chmod", "+x", "/node_shell.sh"]),
    "ls_bin_bash": (["-i"], ["ls", "/bin/bash"]),
    "busybox_ln_bash": ([], ["/bash-static", "-c",
                             "/busybox ls /bin/bash 2>/dev/null || "
                             "/busybox ln /bash-static /bin/bash"]),
    "ethtool_offload_docker0": ([], ["sudo", "ethtool", "--offload", "docker0",
                                     "rx", "off", "tx", "off"]),
    # ethtool_offload_e1 is parameterised on a typed interface_id int — see verb.
    "sr_cli_source_startup": ([], ["sr_cli", "source", "startup-config",
                                   "auto-commit"]),
    "sr_cli_export": (["-u", "root"], ["bash", "-c",
                                       "sr_cli info flat from state  | more > "
                                       "export-config"]),
    # interactive console-attach commands (per family)
    "attach_node_shell": (["-it"], ["/node_shell.sh"]),   # docker_shell templates (XRd etc.)
    "attach_sh": (["-it"], ["sh"]),                       # generic docker fallback
    "attach_bin_bash": (["-it"], ["/bin/bash"]),          # generic docker (bash present)
    "attach_bash": (["-it"], ["bash"]),                   # ceos/srlinux bash console
    "attach_cli": (["-it"], ["Cli"]),                     # cEOS primary console
    "attach_sr_cli": (["-it"], ["sr_cli"]),               # SR Linux primary console
}

# file selector -> handled in verb_docker_cp. Wrapper pushes copy these shipped
# root-owned files from /opt/unetlab/wrappers into the container root.
DOCKER_CP_WRAPPERS = {
    "wrapper_busybox": "busybox",
    "wrapper_profile": "profile.sh",
    "wrapper_udhcpc": "udhcpc.script",
    "wrapper_bash_static": "bash-static",
}
# runningPath-jailed IN-copies: selector -> (runpath basename, container dest)
DOCKER_CP_RUNPATH_IN = {
    "node_shell": ("node_shell.sh", "/node_shell.sh"),
    "ceos_startup": ("startup-config", "/mnt/flash/"),
    "ceos_initial": ("initial-config", "/mnt/flash/startup-config"),
}
# container->host OUT-copies: selector -> (container src, runpath dest basename)
DOCKER_CP_OUT = {
    "ceos_export": ("/mnt/flash/startup-config", "export-config"),
    "srlinux_export": ("export-config", "export-config"),
}


def _docker_runpath(args):
    """The node runningPath jail — same derivation as verb_docker_create."""
    return "%s/%d/%d" % (TMP_DIR, v_int(args, "lab_session"),
                         v_int(args, "node_session"))


def verb_docker_exec(args):
    """`docker exec [flags] docker<node_session> <cmd...>` where <cmd...> is a
    fixed enum entry (or the typed-int-parameterised ethtool e1 shape). Name is
    derived here from the typed id; executed as an argv array, never sh -c.
    Unknown commands are Rejected — fail closed, no passthrough.

    Stage 6 adds ONE capture-lane entry: raise_wireshark_window runs the fixed
    xdotool raise/maximize command inside the legacy SHARED per-lab capture
    container (Capture_<t>_<l>, name derived here from typed ints). The window
    title is built HERE from a typed cap_idx int and shlex-quoted — nothing
    free-form crosses into the sh -c string."""
    if args.get("cmd") == "raise_wireshark_window":
        name = _capture_shared_name(args.get("tenant"), args.get("lab_session"))
        idx = v_int(args, "cap_idx")
        inner = ("DISPLAY=:1 xdotool search --name %s windowactivate --sync "
                 "windowsize 100%% 100%% windowmove 0 0"
                 % shlex.quote("Capturing from cap%d" % idx))
        log("docker_exec %s cmd=raise_wireshark_window idx=%d" % (name, idx))
        return run(["docker", "-H=" + DOCKER_HOST, "exec", name,
                    "sh", "-c", inner], timeout=90, check_rc=False)
    name = _docker_name(args.get("node_session"))
    if args.get("cmd") == "ethtool_offload_e1":
        ifid = v_int(args, "interface_id")
        flags, cmd = [], ["sudo", "ethtool", "--offload", "e1-%d" % ifid,
                          "rx", "off", "tx", "off"]
        sel = "ethtool_offload_e1"
    else:
        sel = v_enum(args, "cmd", set(DOCKER_EXEC_CMDS))
        flags, cmd = DOCKER_EXEC_CMDS[sel]
    log("docker_exec %s cmd=%s" % (name, sel))
    return run(["docker", "-H=" + DOCKER_HOST, "exec"] + flags + [name] + cmd,
               timeout=90, check_rc=False)


def _docker_cp_out(name, ctr_src, dst):
    """Container->host copy WITHOUT ever letting root `docker cp` write directly
    to the www-data-owned runningPath dest (docker-rebroker fix2: TOCTOU — between
    the resolve-time symlink check and the root copy, www-data could swap `dst`
    for a symlink and steer root's write outside the jail). Instead: `docker cp`
    the container source to a PRIVATE root-owned staging file under RUN_DIR, then
    place it at `dst` through an O_NOFOLLOW|O_CREAT|O_EXCL open — which refuses a
    symlink (ELOOP) or any file swapped in at the final path (EEXIST), so root
    never follows a symlink. Result is root:root 0644, matching the prior
    docker-cp-created export file (www-data reads it read-only)."""
    os.makedirs(RUN_DIR, exist_ok=True)
    fd, stage = tempfile.mkstemp(prefix="cp-stage-", dir=RUN_DIR)
    os.close(fd)
    try:
        r = run(["docker", "-H=" + DOCKER_HOST, "cp", name + ":" + ctr_src, stage],
                timeout=90, check_rc=False)
        if r[0] != 0:
            # docker cp failed (e.g. source absent) — surface the rc, leave the
            # existing dest untouched, place nothing.
            return r
        # Clear our own prior export (the engine expects to overwrite it); then
        # create the dest fresh. O_NOFOLLOW+O_EXCL fail closed if www-data has
        # planted a symlink or a file at dst after the unlink.
        try:
            if not os.path.islink(dst):
                os.unlink(dst)
        except FileNotFoundError:
            pass
        except OSError:
            pass
        dfd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            with open(stage, "rb") as s:
                while True:
                    chunk = s.read(1 << 16)
                    if not chunk:
                        break
                    os.write(dfd, chunk)
            os.fchmod(dfd, 0o644)
            try:
                os.fchown(dfd, 0, 0)
            except OSError:
                pass
        finally:
            os.close(dfd)
        return r
    finally:
        try:
            os.unlink(stage)
        except OSError:
            pass


def verb_docker_cp(args):
    """`docker cp` with both endpoints fixed by the file selector: wrapper
    pushes (shipped root-owned /opt/unetlab/wrappers files), runningPath-jailed
    IN-copies (basename-only, symlink-reject, realpath jail), and the two
    config-export OUT-copies. Name derived from the typed id. Anything else —
    unknown selector, symlink, escape — Rejects.

    OUT-copies do NOT let root docker cp write to the www-data dest directly;
    they stage to a private root file and place it via O_NOFOLLOW — see
    _docker_cp_out (fix2)."""
    name = _docker_name(args.get("node_session"))
    sel = v_enum(args, "file", set(DOCKER_CP_WRAPPERS)
                 | set(DOCKER_CP_RUNPATH_IN) | set(DOCKER_CP_OUT))
    if sel in DOCKER_CP_WRAPPERS:
        src = os.path.join(WRAPPERS_DIR, DOCKER_CP_WRAPPERS[sel])
        if os.path.islink(src) or not os.path.isfile(src):
            raise Reject("docker_cp: wrapper %s missing/symlinked" % sel)
        if os.stat(src).st_uid != 0:
            raise Reject("docker_cp: wrapper %s not root-owned" % sel)
        pair = [src, name + ":/"]
    elif sel in DOCKER_CP_RUNPATH_IN:
        base, dst = DOCKER_CP_RUNPATH_IN[sel]
        src = _resolve_runpath_file(_docker_runpath(args), base)
        if not os.path.isfile(src):
            raise Reject("docker_cp: %s not present in runningPath" % base)
        pair = [src, name + ":" + dst]
    else:
        ctr_src, base = DOCKER_CP_OUT[sel]
        dst = _resolve_runpath_file(_docker_runpath(args), base)
        log("docker_cp %s file=%s (out, staged)" % (name, sel))
        return _docker_cp_out(name, ctr_src, dst)
    log("docker_cp %s file=%s" % (name, sel))
    return run(["docker", "-H=" + DOCKER_HOST, "cp"] + pair,
               timeout=90, check_rc=False)


def _docker_target_name(args):
    """Stage 6: start/stop/rm gained the capture lane. The target container
    name is STILL derived here from typed integer ids — 'kind' only selects
    WHICH derivation ('node' -> docker<ns>, 'capture' -> Capture_<t>_<l>_<ns>_<if>,
    'capture_shared' -> Capture_<t>_<l>). Absent kind = 'node' (the Stage 2
    callers pass no kind and keep their exact behavior)."""
    kind = args.get("kind")
    if kind is None:
        kind = "node"
    kind = v_enum({"kind": kind}, "kind", {"node", "capture", "capture_shared"})
    if kind == "node":
        return _docker_name(args.get("node_session"))
    if kind == "capture":
        return _capture_name(args.get("tenant"), args.get("lab_session"),
                             args.get("node_session"), args.get("interface_id"))
    return _capture_shared_name(args.get("tenant"), args.get("lab_session"))


def verb_docker_start(args):
    """`docker start <derived-name>` — name derived from the typed ids."""
    name = _docker_target_name(args)
    # Existing node containers survive package upgrades. Correct their inherited
    # PID ceiling before boot as well, without recreating disks or changing any
    # memory/CPU settings. An update failure must not proceed to a broken start.
    if name.startswith("docker"):
        result = run(["docker", "-H=" + DOCKER_HOST, "update",
                      "--pids-limit=%d" % DOCKER_NODE_PIDS_LIMIT, name], timeout=30)
        if result[0] != 0:
            return result
    return run(["docker", "-H=" + DOCKER_HOST, "start", name], timeout=60)


def verb_docker_stop(args):
    """`docker stop <derived-name>` — name derived from the typed ids."""
    name = _docker_target_name(args)
    return run(["docker", "-H=" + DOCKER_HOST, "stop", name],
               timeout=60, check_rc=False)


def verb_docker_rm(args):
    """`docker rm [--force] <derived-name>` — name derived from the typed ids."""
    name = _docker_target_name(args)
    argv = ["docker", "-H=" + DOCKER_HOST, "rm"]
    if v_bool(args, "force"):
        argv.append("--force")
    argv.append(name)
    return run(argv, timeout=60, check_rc=False)


# ---- docker rebroker (Stage 4): image lifecycle ------------------------------
# devices-factory/api.php (admin-only) used to dial :4243 directly from
# www-data for pull / rmi / ancestor-lookup / image-list. Those now ride these
# verbs: the image REFERENCE is the only caller input, validated against the
# same strict grammar api.php enforces client-side (RE_IMAGE_REF, mirrored from
# its PNQ_REF_RE — no whitespace, no shell metacharacters), and every docker
# call is an argv ARRAY. `docker import`/`docker load` in root-context config
# scripts are NOT here — they never ran as www-data (Stage 7 repoints them).

# Strict docker image reference: optional registry[:port]/, repo path segments,
# optional :tag, optional @sha256:digest. Mirror of api.php's PNQ_REF_RE — keep
# both in sync.
RE_IMAGE_REF = re.compile(
    r"^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?/)?"
    r"[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*"
    r"(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*"
    r"(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?"
    r"(?:@sha256:[a-f0-9]{64})?$")
# Docker's short/long image id: bare lowercase hex (rmi/ancestor accept either).
RE_IMAGE_ID = re.compile(r"^[a-f0-9]{12,64}$")


def _image_ref(args, allow_id=False):
    ref = args.get("ref")
    if not isinstance(ref, str) or not (0 < len(ref) <= 256):
        raise Reject("bad image ref")
    if RE_IMAGE_REF.match(ref) or (allow_id and RE_IMAGE_ID.match(ref)):
        return ref
    raise Reject("bad image ref")


def verb_docker_image_pull(args):
    """Detached `docker pull <ref>` on the device-factory lane. The job id,
    logfile and end-of-job process_device row cleanup keep the exact contract
    api.php's process-polling expects (jobId = 'custom'+md5(ref)[:12], log at
    /tmp/pnet_device_factory_<job>_log, unit pnet-factory-<job> so
    device_factory_kill/rm still apply) — but the script body is authored HERE
    from the validated ref, no longer a www-data-written /tmp file."""
    ref = _image_ref(args)
    job = "custom" + hashlib.md5(ref.encode()).hexdigest()[:12]
    logpath = "/tmp/pnet_device_factory_%s_log" % job
    # Drop any pre-existing file/symlink at the log path (www-data could have
    # planted a symlink; `set -C` below additionally refuses to create through
    # one if it reappears — the unit then fails closed).
    if os.path.islink(logpath) or os.path.exists(logpath):
        os.unlink(logpath)
    q = shlex.quote(ref)   # belt-and-braces; the ref grammar has no metachars
    body = ("set -C; { "
            "echo \"Pulling %s from Docker Hub...\"; "
            "docker -H=%s pull %s; RC=$?; "
            "if [ \"$RC\" = \"0\" ]; then echo \"Done. %s is ready.\"; "
            "else echo \"FAILED to pull %s (rc=$RC)\"; fi; "
            "mysql pnetlab_db -e \"DELETE FROM process_device WHERE "
            "process_device_id='%s'\"; } > %s 2>&1"
            % (q, DOCKER_HOST, q, q, q, job, logpath))
    log("docker_image_pull %s job=%s" % (ref, job))
    spawn_unit("pnet-factory-" + job, ["/bin/bash", "-c", body],
               setenv=("HOME=/root",))
    return 0, [job], ""


def verb_docker_image_rmi(args):
    """`docker rmi <ref-or-id>` — NEVER -f/force: an image still referenced by
    any container (running or stopped) fails with Docker's own error, which is
    the in-use protection api.php surfaces back to the admin verbatim-ish."""
    ref = _image_ref(args, allow_id=True)
    log("docker_image_rmi %s" % ref)
    return run(["docker", "-H=" + DOCKER_HOST, "rmi", ref],
               timeout=120, check_rc=False)


def verb_docker_image_ancestor(args):
    """`docker ps -a --filter ancestor=<ref> --format {{.Names}}` — the
    read-only in-use lookup the catalog delete action guards with."""
    ref = _image_ref(args, allow_id=True)
    return run(["docker", "-H=" + DOCKER_HOST, "ps", "-a",
                "--filter", "ancestor=" + ref, "--format", "{{.Names}}"],
               timeout=60, check_rc=False)


def verb_docker_image_ls(args):
    """Read-only local image-store listings (no caller input beyond a fixed
    mode): images_json = `docker images --format {{json .}}` (one JSON object
    per line), used = `docker ps -a --format {{.Image}}` (in-use hint), refs =
    `docker images --format {{.Repository}}:{{.Tag}}` (for the template image
    picker in devices/functions.php — that read caller ports over in Stage 5)."""
    mode = v_enum(args, "mode", {"images_json", "used", "refs"})
    if mode == "images_json":
        argv = ["docker", "-H=" + DOCKER_HOST, "images", "--format", "{{json .}}"]
    elif mode == "used":
        argv = ["docker", "-H=" + DOCKER_HOST, "ps", "-a", "--format", "{{.Image}}"]
    else:
        argv = ["docker", "-H=" + DOCKER_HOST, "images",
                "--format", "{{.Repository}}:{{.Tag}}"]
    return run(argv, timeout=60, check_rc=False)


# ---- docker rebroker (Stage 5): read-only status / stats / health -----------
# api_status.php + status/api.php (running-container count, server version),
# pnq-nodestats.php (per-container cpu/mem) and doctor.php (engine
# reachability) used to dial :4243 directly from www-data. These verbs take NO
# free caller input (the one optional 'format' echo is an allowlist of one),
# and the old `ps -q | wc -l` shell pipe becomes a Python line count — no
# shell, argv arrays only. When the tcp socket closes in Stage 7 only the
# broker's DOCKER_HOST moves; every one of these callers stays green.

# The ONLY stats format the engine uses (pnq-nodestats.php) — allowlist of one.
DOCKER_STATS_FORMAT = "{{.Name}};{{.CPUPerc}};{{.MemUsage}}"


def verb_docker_ps_count(args):
    """Running-container count: `docker ps -q` root-side, the id lines counted
    HERE (no `| wc -l` pipe). out = [str(count)]."""
    rc, out, err = run(["docker", "-H=" + DOCKER_HOST, "ps", "-q"],
                       timeout=30, check_rc=False)
    if rc != 0:
        return rc, ["0"], err
    return 0, [str(sum(1 for l in out if l.strip()))], ""


def verb_docker_stats(args):
    """Read-only `docker stats --no-stream` with the FIXED format string above
    (one 'name;cpu%;mem' line per running container). A caller-supplied
    'format', when present, must equal it exactly — no free-form Go-template
    passthrough."""
    if args.get("format") is not None:
        v_enum(args, "format", {DOCKER_STATS_FORMAT})
    return run(["docker", "-H=" + DOCKER_HOST, "stats", "--no-stream",
                "--format", DOCKER_STATS_FORMAT], timeout=60, check_rc=False)


def verb_docker_version(args):
    """Docker engine reachability + server version:
    `docker version --format {{.Server.Version}}`. rc!=0 / empty out means the
    engine endpoint is down. doctor.php keys its docker health check off THIS
    verb instead of curling :4243/_ping, so the check stays truthful when the
    tcp socket closes in Stage 7."""
    return run(["docker", "-H=" + DOCKER_HOST, "version",
                "--format", "{{.Server.Version}}"], timeout=30, check_rc=False)


# ---- docker rebroker (Stage 6): capture + winbox container lane -------------
# functions.php (addWinboxSystem / addWiresharkSystem / addWifiCaptureWeb /
# deleteWireshark / removeWiresharkContainer / focusWiresharkWindow) and
# api.php's capture image check were the LAST www-data :4243 docker callers in
# the web tree. Their container profiles differ from lab nodes (NET_ADMIN
# capture sidecar, read-only pcap bind, winbox --privileged), so instead of
# widening the Stage 2 typed template builder, each shape gets its own NARROW
# verb whose entire argv is FIXED here: the only caller inputs are typed ints
# (names/hostnames/paths all derived broker-side), one enum (medium), and — in
# exactly one place, capture_rm — a container NAME bounded by RE_CAPTURE_NAME
# (the ws_dc_name stale-session teardown, whose value is server-derived and
# prepared-statement-stored, but which by design no longer matches the ids).

# Capture-container names ONLY (both the per-interface and the legacy shared
# per-lab shape). Deliberately EXCLUDES docker<n> node containers — capture_rm
# must never be able to rm a lab node.
RE_CAPTURE_NAME = re.compile(r"^Capture_\d{1,10}_\d{1,10}(?:_\d{1,10}_\d{1,10})?$")
CAPTURE_IMAGE = "pnet-capture-web:1.0"
WINBOX_IMAGE = "alexhorner/winbox-dockerised"


def verb_capture_create(args):
    """Create the live per-interface capture sidecar:
    `docker create --shm-size 1G --cap-add=NET_ADMIN -ti --net=none
       --name=Capture_<t>_<l>_<ns>_<if> -h <tap> pnet-capture-web:1.0`
    Name AND -h hostname (the node tap: vunl<ns>_<if> / ser<ns>_<if>, selected
    by the typed 'serial' flag) are derived here from typed ints; image and
    every flag are fixed. --net=none: eth0/eth1 are attached afterwards by the
    already-brokered capture_rdp_attach / capture_mirror_attach verbs."""
    name = _capture_name(args.get("tenant"), args.get("lab_session"),
                         args.get("node_session"), args.get("interface_id"))
    host = ("ser" if v_bool(args, "serial") else "vunl") + "%d_%d" % (
        v_int(args, "node_session"), v_int(args, "interface_id"))
    log("capture_create %s" % name)
    return run(["docker", "-H=" + DOCKER_HOST, "create",
                "--shm-size", "1G", "--cap-add=NET_ADMIN", "-ti", "--net=none",
                "--name=" + name, "-h", host, CAPTURE_IMAGE],
               timeout=120, check_rc=False)


def verb_capture_wifi_create(args):
    """FILE-MODE capture viewer for the session Wi-Fi pcap (addWifiCaptureWeb).
    Same fixed profile as capture_create plus a READ-ONLY bind of the pcap and
    CAPTURE_FILE env. The pcap PATH is derived HERE from the typed lab_session
    + medium enum — /opt/unetlab/tmp/<l>/wifi[-vwifi]-<l>.pcap — with symlink
    reject + realpath jail; no path crosses the socket. node_session is the
    reserved synthetic Wi-Fi capture node (airduct=901, vwifi=902), forced
    here, so the container name cannot collide with a real node's capture."""
    tenant = v_int(args, "tenant")
    session = v_int(args, "lab_session")
    medium = v_enum(args, "medium", {"airduct", "vwifi"})
    syn_node = 902 if medium == "vwifi" else 901
    name = _capture_name(tenant, session, syn_node, 0)
    base = "%s/%d" % (TMP_DIR, session)
    pcap = "%s/%s%d.pcap" % (base, "wifi-vwifi-" if medium == "vwifi" else "wifi-",
                             session)
    if os.path.islink(pcap):
        raise Reject("capture_wifi_create: refuse symlinked pcap")
    real = os.path.realpath(pcap)
    if not (real + "/").startswith(base.rstrip("/") + "/") and \
            not real.startswith(base.rstrip("/") + "/"):
        raise Reject("capture_wifi_create: pcap escapes session tmp")
    if not os.path.isfile(real):
        raise Reject("capture_wifi_create: pcap missing")
    log("capture_wifi_create %s medium=%s" % (name, medium))
    return run(["docker", "-H=" + DOCKER_HOST, "create",
                "--shm-size", "1G", "--cap-add=NET_ADMIN", "-ti", "--net=none",
                "--name=" + name,
                "-e", "CAPTURE_FILE=/wifi/cap.pcap",
                "-v", "%s:/wifi/cap.pcap:ro" % real,
                "-h", "wifi-" + medium, CAPTURE_IMAGE],
               timeout=120, check_rc=False)


def verb_winbox_create(args):
    """Create the Mikrotik winbox container (addWinboxSystem) — argv moved here
    FAITHFULLY from the PHP string, including its two pre-existing quirks:
    `--cpu=2 --entrypoint wine /winbox64` sits AFTER the image (so it is
    container argv, not docker flags) and --privileged remains (the image is
    unavailable to profile a minimal cap set — see the functions.php TODO).
    Name is the same Capture_<t>_<l>_<ns>_<if> shape, derived from typed ints;
    the -h hostname (<node>_<iface>) is an option-argument single token — it
    cannot become a flag — validated only for NUL/newline/length."""
    name = _capture_name(args.get("tenant"), args.get("lab_session"),
                         args.get("node_session"), args.get("interface_id"))
    host = args.get("hostname")
    if not isinstance(host, str) or host == "" or len(host) > 128:
        raise Reject("bad arg hostname")
    if "\x00" in host or "\n" in host or "\r" in host:
        raise Reject("bad arg hostname")
    log("winbox_create %s" % name)
    return run(["docker", "-H=" + DOCKER_HOST, "create",
                "--shm-size", "1G", "--net=bridge", "--privileged", "-ti",
                "--env", "VNC_BUILTIN_WIDTH=800",
                "--env", "VNC_BUILTIN_HEIGHT=600",
                "--env", "GDK_SCALE=2", "--env", "QT_SCALE_FACTOR=1.5",
                "--name=" + name, "-h", host, WINBOX_IMAGE,
                "--cpu=2", "--entrypoint", "wine", "/winbox64"],
               timeout=120, check_rc=False)


def verb_capture_rm(args):
    """`docker rm -f <name>` for a CAPTURE container addressed BY NAME — the one
    name-argument verb in the docker lane, needed because deleteWireshark /
    addWiresharkSystem must tear down the wiresharks row's RECORDED ws_dc_name
    when a node restart changed node_session (the id-derived name no longer
    matches the actual container). The name is server-derived + prepared-
    statement-stored on the PHP side and re-bounded HERE by RE_CAPTURE_NAME,
    which matches ONLY Capture_<ints> shapes — a lab node (docker<n>) or any
    other container name Rejects."""
    name = args.get("name")
    if not isinstance(name, str) or len(name) > 64 \
            or not RE_CAPTURE_NAME.match(name):
        raise Reject("bad arg name")
    log("capture_rm %s" % name)
    return run(["docker", "-H=" + DOCKER_HOST, "rm", "-f", name],
               timeout=60, check_rc=False)




VERBS = {
    'docker_inspect': verb_docker_inspect,
    'docker_create': verb_docker_create,
    'docker_start': verb_docker_start,
    'docker_stop': verb_docker_stop,
    'docker_rm': verb_docker_rm,
    'docker_exec': verb_docker_exec,
    'docker_cp': verb_docker_cp,
    'docker_image_pull': verb_docker_image_pull,
    'docker_image_rmi': verb_docker_image_rmi,
    'docker_image_ancestor': verb_docker_image_ancestor,
    'docker_image_ls': verb_docker_image_ls,
    'docker_ps_count': verb_docker_ps_count,
    'docker_stats': verb_docker_stats,
    'docker_version': verb_docker_version,
    'capture_create': verb_capture_create,
    'capture_wifi_create': verb_capture_wifi_create,
    'winbox_create': verb_winbox_create,
    'capture_rm': verb_capture_rm,
}
