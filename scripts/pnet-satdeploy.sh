#!/bin/bash
# pnet-satdeploy.sh — push-deploy a cluster SATELLITE from the master. Runs as
# root in a transient systemd unit (pnet-satdeploy-<job>, spawned by brokerd's
# cluster_deploy):    pnet-satdeploy.sh <job>
#
# The admin supplies the satellite's IP + SSH login (+ sudo password when the
# login isn't root) in the Cluster page. This worker (import/worker.sh
# credential pattern: jobs/<job>.req 0600, shredded once read; passwords only
# ever in env/stdin, never argv):
#   1. sanity-checks the target (Ubuntu 26.04, not already a PNetLab master)
#   2. rsyncs the satellite bundle from $PNET_SAT_BUNDLE
#      (default /opt/unetlab/cluster-bundle) to the target's /tmp
#   3. runs install-resolute-satellite.sh --no-reboot there (sudo -A when needed)
#   4. ensures the cluster PSK exists, then runs pnet-satellite-join on the
#      target (PSK over stdin via --psk -)
#   5. cleans up and reboots the satellite into the PNetLab kernel
# Progress lands in html/cluster/jobs/<job>.json (same poll as image sync);
# the full remote install log in jobs/<job>.log.
set -o pipefail

JOB="$1"
BASE="/opt/unetlab/html/cluster"
ST="$BASE/jobs/${JOB}.json"
REQ="$BASE/jobs/${JOB}.req"
LOG="$BASE/jobs/${JOB}.log"
BUNDLE="${PNET_SAT_BUNDLE:-/opt/unetlab/cluster-bundle}"
PSK_FILE="/etc/pnetlab/cluster/psk"
ASSET_CACHE_ROOT="${PNETLAB_CLUSTER_ASSET_CACHE_ROOT:-/var/cache/pnetlab/cluster-assets}"
MASTER_RELEASE=''
readonly -a SATELLITE_HARD_PACKAGES=(pnetlab-docker pnetlab-qemu pnetlab-satellite pnetlab-vpcs)
readonly -a SATELLITE_ZOO_VERSIONS=(2.4.0 2.12.0 4.1.0 5.2.0)

upd() {
    printf '{"state":"%s","pct":%s,"msg":"%s"}\n' "$1" "$2" "${3//\"/}" > "$ST"
    chmod 644 "$ST" 2>/dev/null
}
fail() { upd "error" 0 "$1"; rm -f "$REQ"; exit 1; }
log() {
    printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG"
}

validate_bundle_root() {
    [ -d "$BUNDLE" ] || fail "satellite bundle root is missing: $BUNDLE"
    [ ! -L "$BUNDLE" ] || fail "satellite bundle root must not be a symlink: $BUNDLE"
    [ "$(stat -c '%U:%G' -- "$BUNDLE" 2>/dev/null)" = 'root:root' ] || \
        fail "satellite bundle root must be root:root: $BUNDLE"
    [ "$(stat -c '%a' -- "$BUNDLE" 2>/dev/null)" = '755' ] || \
        fail "satellite bundle root must be mode 0755: $BUNDLE"
}

[ -f "$REQ" ] || fail "request missing"
command -v sshpass >/dev/null 2>&1 || fail "sshpass missing on the master"
command -v rsync   >/dev/null 2>&1 || fail "rsync missing on the master"

IP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("ip",""))' "$REQ")
SUSER=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("user",""))' "$REQ")
SLOT=$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("host_id",0)))' "$REQ")
NAME=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("name",""))' "$REQ")
SSHPASS=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pass",""))' "$REQ")
SUDO_PASS=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("sudo_pass",""))' "$REQ")
export SSHPASS
shred -u "$REQ" 2>/dev/null || rm -f "$REQ"

[ -n "$IP" ] && [ -n "$SUSER" ] && [ -n "$SSHPASS" ] || fail "bad request"
# SECURITY (Stage 0.5): SUSER goes into an ssh destination ("${SUSER}@${IP}").
# Reject anything but a plain login name so a forged user like "-oProxyCommand=..."
# can never be read by ssh as an option (root command execution). This is the
# AUTHORITATIVE check (brokerd pre-validates too, but www-data can race the .req);
# every ssh/rsync call below also uses "--" to end option parsing as defence in
# depth (also neutralises a leading-dash IP).
case "$SUSER" in
    ""|*[!A-Za-z0-9_-]*) fail "bad ssh user" ;;
esac
case "$SLOT" in 1|2) ;; *) fail "bad satellite slot" ;; esac
[ -n "$NAME" ] || NAME="Satellite $SLOT"
[ -n "$SUDO_PASS" ] || SUDO_PASS="$SSHPASS"

SSH_ARGS=(-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15)
SSHOPT="ssh ${SSH_ARGS[*]}"

# single-quote an argument for the remote shell
qq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

run_remote() {   # plain command as the login user
    sshpass -e ssh "${SSH_ARGS[@]}" -- "${SUSER}@${IP}" "$@" </dev/null
}
run_root() {     # command as root; non-root wrapper consumes the password line
    if [ "$SUSER" = "root" ]; then
        sshpass -e ssh "${SSH_ARGS[@]}" -- "root@${IP}" "$1"
    else
        local remote_cmd

        # The remote wrapper consumes only the password line before sudo starts;
        # the remaining stdin belongs exclusively to the wrapped command. Keep
        # the password out of remote command strings/argv and disk.
        remote_cmd="set -eu
umask 077
d=\$(mktemp -d /dev/shm/.pnetlab-sudo-askpass.XXXXXX)
cleanup() {
    rm -f -- \"\$d/askpass\"
    rmdir -- \"\$d\" 2>/dev/null || true
}
trap cleanup EXIT
IFS= read -r PNETLAB_SUDO_PASS
export PNETLAB_SUDO_PASS
printf '%s\n' '#!/bin/sh' \
    'printf \"%s\" \"\$PNETLAB_SUDO_PASS\"' > \"\$d/askpass\"
chmod 700 \"\$d/askpass\"
SUDO_ASKPASS=\"\$d/askpass\" sudo -A -p '' bash -c $(qq "$1")"

        { printf '%s\n' "$SUDO_PASS"; cat; } | \
            sshpass -e ssh "${SSH_ARGS[@]}" -- "${SUSER}@${IP}" "$remote_cmd"
    fi
}

# ── 1. sanity checks ──────────────────────────────────────────────────────────
upd "running" 2 "checking $IP"
run_remote 'true' || fail "cannot SSH to $IP as $SUSER (wrong password / host down?)"
REL=$(run_remote 'lsb_release -r -s 2>/dev/null' | tr -d '\r\n ')
[ "$REL" = "26.04" ] || fail "satellite must run Ubuntu 26.04 (found '${REL:-unknown}')"
if run_remote 'dpkg -s pnetlab >/dev/null 2>&1'; then
    fail "$IP already runs a PNetLab MASTER — a host is master OR satellite"
fi
MASTER_RELEASE="$(dpkg-query -W -f='${Version}' pnetlab 2>/dev/null || true)"
[[ "$MASTER_RELEASE" =~ ^6\.8\.[0-9]+resolute1$ ]] || fail "could not determine the installed master release"
if [ "$SUSER" != "root" ]; then
    run_root 'true' </dev/null || fail "sudo failed for $SUSER (wrong sudo password?)"
fi
bundle_is_complete() {
    local root="$1" release="$2"
    python3 - "$root" "$release" <<'PY'
import csv
import hashlib
import os
import pathlib
import re
import stat
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
release = sys.argv[2]
hard = ['pnetlab-docker', 'pnetlab-qemu', 'pnetlab-satellite', 'pnetlab-vpcs']
zoo = ['qemu-zoo-2.4.0-net.tgz', 'qemu-zoo-2.12.0-net.tgz',
       'qemu-zoo-4.1.0-net.tgz', 'qemu-zoo-5.2.0-net.tgz']

def reject(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)

def lstat(path):
    try:
        return path.lstat()
    except OSError as exc:
        reject(str(path) + ': ' + str(exc))

def owned_mode(path, mode, label):
    st = lstat(path)
    if st.st_uid != 0 or st.st_gid != 0:
        reject(label + ': not root-owned')
    if stat.S_IMODE(st.st_mode) != mode:
        reject(label + ': mode is %o, expected %o' % (stat.S_IMODE(st.st_mode), mode))
    return st

if not re.fullmatch(r'6\.8\.[0-9]+resolute1', release):
    reject('invalid installed master release')
if root.is_symlink() or not root.is_dir():
    reject('bundle root is missing or is a symlink')
owned_mode(root, 0o755, 'bundle root')
releases = root / 'releases'
owned_mode(releases, 0o755, 'release root')
current = root / 'current'
current_st = lstat(current)
if not stat.S_ISLNK(current_st.st_mode) or current_st.st_uid != 0 or current_st.st_gid != 0:
    reject('current must be a root-owned symlink')
if os.readlink(current) != 'releases/' + release:
    reject('current does not point to the installed master release')
release_dir = releases / release
if release_dir.is_symlink() or not release_dir.is_dir():
    reject('current release directory is missing or is a symlink')
owned_mode(release_dir, 0o755, 'current release directory')
if pathlib.Path(os.path.realpath(current)) != release_dir.resolve():
    reject('current resolves outside the selected release directory')

marker = release_dir / 'COMPLETE'
owned_mode(marker, 0o644, 'COMPLETE')
values = {}
for line in marker.read_text().splitlines():
    if '=' not in line:
        reject('COMPLETE contains a malformed line')
    key, value = line.split('=', 1)
    if not key:
        reject('COMPLETE contains a malformed line')
    if key in values:
        reject('COMPLETE contains a duplicate key')
    values[key] = value
required_keys = {'format', 'release', 'packages', 'optional_packages', 'assets', 'inventory_sha256', 'asset_inventory_sha256'}
if set(values) != required_keys or values['format'] != '1' or values['release'] != release:
    reject('COMPLETE is absent, incomplete, or release-mismatched')
expected_packages = ','.join([package + '=' + release for package in hard])
if values['packages'] != expected_packages:
    reject('COMPLETE hard package inventory is incomplete or stale')
if values['optional_packages'] not in ('', 'pnetlab-bridge-dkms=' + release):
    reject('COMPLETE optional package inventory is invalid')
if values['assets'] != ','.join(['qemu-compat-libs.tgz'] + zoo):
    reject('COMPLETE asset inventory is incomplete')
if not re.fullmatch(r'[0-9a-f]{64}', values['inventory_sha256']):
    reject('COMPLETE inventory digest is malformed')

script = release_dir / 'install-resolute-satellite.sh'
owned_mode(script, 0o755, 'satellite installer')
inventory = release_dir / 'inventory.tsv'
owned_mode(inventory, 0o644, 'package inventory')
if hashlib.sha256(inventory.read_bytes()).hexdigest() != values['inventory_sha256']:
    reject('package inventory digest does not match COMPLETE')

asset_inventory = release_dir / 'asset-inventory.tsv'
owned_mode(asset_inventory, 0o644, 'asset inventory')
if not re.fullmatch(r'[0-9a-f]{64}', values['asset_inventory_sha256']):
    reject('COMPLETE asset inventory digest is malformed')
if hashlib.sha256(asset_inventory.read_bytes()).hexdigest() != values['asset_inventory_sha256']:
    reject('asset inventory digest does not match COMPLETE')
asset_rows = list(csv.reader(asset_inventory.open(newline=''), delimiter='\t'))
if not asset_rows or asset_rows[0] != ['asset', 'sha256', 'size', 'path']:
    reject('asset inventory header is invalid')
expected_assets = {
    'qemu-compat-libs.tgz': ('deps/qemu-compat-libs.tgz',),
    'qemu-zoo-2.4.0-net.tgz': ('qemu-zoo/qemu-zoo-2.4.0-net.tgz',),
    'qemu-zoo-2.12.0-net.tgz': ('qemu-zoo/qemu-zoo-2.12.0-net.tgz',),
    'qemu-zoo-4.1.0-net.tgz': ('qemu-zoo/qemu-zoo-4.1.0-net.tgz',),
    'qemu-zoo-5.2.0-net.tgz': ('qemu-zoo/qemu-zoo-5.2.0-net.tgz',),
}
asset_parsed = {}
for row in asset_rows[1:]:
    if len(row) != 4:
        reject('asset inventory row is malformed')
    asset, digest, size, path = row
    if asset in asset_parsed or asset not in expected_assets or path != expected_assets[asset][0]:
        reject('asset inventory identity is invalid')
    if not re.fullmatch(r'[0-9a-f]{64}', digest) or not size.isdigit():
        reject('asset inventory digest/size is invalid')
    asset_parsed[asset] = (digest, int(size), path)
if set(asset_parsed) != set(expected_assets):
    reject('asset inventory is incomplete')

deb_dir = release_dir / 'pnetlab-debs'
owned_mode(deb_dir, 0o755, 'satellite deb directory')
rows = list(csv.reader(inventory.open(newline=''), delimiter='\t'))
if not rows or rows[0] != ['package', 'architecture', 'version', 'sha256', 'size', 'filename']:
    reject('package inventory header is invalid')
parsed = {}
for row in rows[1:]:
    if len(row) != 6:
        reject('package inventory row is malformed')
    package, arch, version, digest, size, filename = row
    if package in parsed or arch not in ('amd64', 'all') or version != release:
        reject('package inventory identity is invalid')
    if not re.fullmatch(r'[0-9a-f]{64}', digest) or not size.isdigit() or '/' in filename or not filename.endswith('.deb'):
        reject('package inventory digest/filename is invalid')
    parsed[package] = (arch, version, digest, int(size), filename)
actual_debs = []
for item in deb_dir.iterdir():
    if item.is_symlink():
        reject('satellite deb directory contains a symlink')
    if item.is_file() and item.name.endswith('.deb'):
        actual_debs.append(item.name)
        owned_mode(item, 0o644, 'satellite deb ' + item.name)
if set(actual_debs) != {row[5] for row in rows[1:]}:
    reject('package inventory does not match the staged deb set')
expected_inventory = set(hard)
if values['optional_packages']:
    expected_inventory.add('pnetlab-bridge-dkms')
if set(parsed) != expected_inventory:
    reject('package inventory does not match the COMPLETE package inventory')
if any(package not in parsed for package in hard):
    reject('a hard satellite package is missing')
for package, (arch, version, digest, size, filename) in parsed.items():
    deb = deb_dir / filename
    # dpkg-deb -f prints a bare value for a SINGLE requested field, but
    # prefixes each line with "Field: " once two or more fields are
    # requested in one call -- passing all three at once here made every
    # comparison below compare "Package: <name>" against the bare <name>,
    # which can never match. Query each field separately so the values stay
    # bare, exactly like every other dpkg-deb -f call site in this codebase
    # (install-resolute-satellite.sh, network-install-pnetlab-27H1.sh) already does.
    actual_package = subprocess.check_output(
        ['dpkg-deb', '-f', str(deb), 'Package'], text=True).strip()
    actual_version = subprocess.check_output(
        ['dpkg-deb', '-f', str(deb), 'Version'], text=True).strip()
    actual_arch = subprocess.check_output(
        ['dpkg-deb', '-f', str(deb), 'Architecture'], text=True).strip()
    if actual_package != package or actual_version != version or actual_arch not in ('amd64', 'all'):
        reject(filename + ': dpkg identity differs from inventory')
    if hashlib.sha256(deb.read_bytes()).hexdigest() != digest or deb.stat().st_size != size:
        reject(filename + ': digest or size differs from inventory')

deps = release_dir / 'deps'
zoo_dir = release_dir / 'qemu-zoo'
owned_mode(deps, 0o755, 'satellite deps directory')
owned_mode(zoo_dir, 0o755, 'QEMU zoo directory')
owned_mode(deps / 'qemu-compat-libs.tgz', 0o644, 'qemu-compat-libs.tgz')
for filename in zoo:
    owned_mode(zoo_dir / filename, 0o644, filename)
for asset, (digest, size, path) in asset_parsed.items():
    payload = release_dir / path
    if hashlib.sha256(payload.read_bytes()).hexdigest() != digest or payload.stat().st_size != size:
        reject(asset + ': digest or size differs from asset inventory')
for item in release_dir.rglob('*'):
    if item.is_symlink():
        reject('release payload contains a symlink: ' + str(item))
print('bundle complete')
PY
}

validate_bundle_root() {
    [ -d "$BUNDLE" ] || fail "satellite bundle root is missing: $BUNDLE"
    [ ! -L "$BUNDLE" ] || fail "satellite bundle root must not be a symlink: $BUNDLE"
    [ "$(stat -c '%U:%G' -- "$BUNDLE" 2>/dev/null)" = 'root:root' ] || \
        fail "satellite bundle root must be root:root: $BUNDLE"
    [ "$(stat -c '%a' -- "$BUNDLE" 2>/dev/null)" = '755' ] || \
        fail "satellite bundle root must be mode 0755: $BUNDLE"
    bundle_is_complete "$BUNDLE" "$MASTER_RELEASE" || \
        fail "satellite bundle is absent, incomplete, or does not match master release $MASTER_RELEASE"
}

repair_asset_cache_is_valid() {
    local cache="$1"
    python3 - "$cache" <<'PY'
import csv
import hashlib
import pathlib
import re
import stat
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
expected = {
    'qemu-compat-libs.tgz': 'deps/qemu-compat-libs.tgz',
    'qemu-zoo-2.4.0-net.tgz': 'qemu-zoo/qemu-zoo-2.4.0-net.tgz',
    'qemu-zoo-2.12.0-net.tgz': 'qemu-zoo/qemu-zoo-2.12.0-net.tgz',
    'qemu-zoo-4.1.0-net.tgz': 'qemu-zoo/qemu-zoo-4.1.0-net.tgz',
    'qemu-zoo-5.2.0-net.tgz': 'qemu-zoo/qemu-zoo-5.2.0-net.tgz',
}

def valid_mode(path, mode):
    st = path.lstat()
    return (not stat.S_ISLNK(st.st_mode) and st.st_uid == 0 and st.st_gid == 0
            and stat.S_IMODE(st.st_mode) == mode)

if root.is_symlink() or not root.is_dir() or not valid_mode(root, 0o700):
    raise SystemExit(1)
inventory = root / 'asset-inventory.tsv'
if not valid_mode(inventory, 0o644):
    raise SystemExit(1)
rows = list(csv.reader(inventory.open(newline=''), delimiter='\t'))
if not rows or rows[0] != ['asset', 'sha256', 'size', 'path']:
    raise SystemExit(1)
parsed = {}
for row in rows[1:]:
    if len(row) != 4:
        raise SystemExit(1)
    asset, digest, size, path = row
    if asset in parsed or asset not in expected or path != expected[asset]:
        raise SystemExit(1)
    if not re.fullmatch(r'[0-9a-f]{64}', digest) or not size.isdigit():
        raise SystemExit(1)
    parsed[asset] = (digest, int(size), path)
if set(parsed) != set(expected):
    raise SystemExit(1)
for asset, (digest, size, path) in parsed.items():
    payload = root / path
    if not valid_mode(payload, 0o644):
        raise SystemExit(1)
    if payload.stat().st_size != size or hashlib.sha256(payload.read_bytes()).hexdigest() != digest:
        raise SystemExit(1)
    if subprocess.run(['tar', 'tzf', str(payload)], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode != 0:
        raise SystemExit(1)
PY
}

repair_asset_file_is_valid() {
    local asset_path="$1"
    [ -f "$asset_path" ] && [ ! -L "$asset_path" ] && [ -s "$asset_path" ] \
        && tar tzf "$asset_path" >/dev/null 2>&1
}

reap_satellite_tombstones() {
    local releases="$1" tombstone
    [ -d "$releases" ] || return 0
    while IFS= read -r -d '' tombstone; do
        if ! rm -rf -- "$tombstone"; then
            log "could not reap superseded satellite tombstone $tombstone; will retry on next publish"
        fi
    done < <(find "$releases" -mindepth 1 -maxdepth 1 -name '*.superseded.*' -print0 2>/dev/null)
}

# Auto-stage the bundle when missing: the installer stages it on fresh
# installs, but older masters (or PNET_NO_CLUSTER_BUNDLE installs) won't have
# it. First ask the signed updater to reconcile the currently installed
# release; this covers masters upgraded by a legacy updater that could not
# stage the bundle during its own package transaction. The local-source path
# below remains a compatibility fallback for offline/manual installations.
repair_bundle_from_signed_release() {
    local updater=/usr/sbin/pnetlab-update
    [ -x "$updater" ] || return 1
    log 'satellite bundle is missing or incomplete; invoking signed current-release reconciliation'
    if ! "$updater" --repair-satellite-bundle >> "$LOG" 2>&1; then
        log 'signed current-release reconciliation was unavailable or failed; trying legacy local bundle sources'
        return 1
    fi
    bundle_is_complete "$BUNDLE" "$MASTER_RELEASE"
}

stage_bundle() {
    local src="" d tgz tmp=""
    if repair_bundle_from_signed_release; then
        return 0
    fi
    for d in /root/pnetlab-27H1-v8.2-resolute /home/*/pnetlab-27H1-v8.2-resolute /opt/pnetlab-27H1-v8.2-resolute \
             /root/pnetlab-27H1-v8.1.2-resolute /home/*/pnetlab-27H1-v8.1.2-resolute /opt/pnetlab-27H1-v8.1.2-resolute \
             /root/pnetlab-26H2-noble /home/*/pnetlab-26H2-noble /opt/pnetlab-26H2-noble \
             /root/noble-test-bundle /home/*/noble-test-bundle /opt/noble-test-bundle; do
        [ -f "$d/install-resolute-satellite.sh" ] && { src="$d"; break; }
    done
    if [ -z "$src" ]; then
        tgz=$(ls -t /root/pnetlab-27H1-*.tgz /home/*/pnetlab-27H1-*.tgz /root/pnetlab-26H2-noble*.tgz /home/*/pnetlab-26H2-noble*.tgz /root/pnetlab-noble-*.tgz /home/*/pnetlab-noble-*.tgz 2>/dev/null | head -1)
        if [ -n "$tgz" ]; then
            tmp=$(mktemp -d) || return 1
            tar xzf "$tgz" -C "$tmp" 2>/dev/null && src=$(ls -d "$tmp"/pnetlab-27H1-v8.2-resolute "$tmp"/pnetlab-27H1-v8.1.2-resolute "$tmp"/pnetlab-26H2-noble "$tmp"/noble-test-bundle 2>/dev/null | head -1)
        fi
    fi
    if [ -z "$src" ] || [ ! -f "$src/install-resolute-satellite.sh" ]; then
        [ -n "$tmp" ] && rm -rf "$tmp"
        return 1
    fi
    local releases="$BUNDLE/releases" staging=''
    local destination="$BUNDLE/releases/$MASTER_RELEASE" deb package arch version sha size filename asset asset_path tombstone publish_lock_file publish_status
    local asset_cache asset_cache_available=0
    local package_list optional_list optional_deb inventory_sha asset_inventory_sha
    local -a staged_debs=()
    install -d -o root -g root -m 0755 "$BUNDLE" "$releases" || { [ -n "$tmp" ] && rm -rf "$tmp"; return 1; }
    if ! staging=$(mktemp -d "$releases/.${MASTER_RELEASE}.staging.XXXXXX") \
        || ! chmod 0700 "$staging"; then
        [ -n "$tmp" ] && rm -rf "$tmp"
        [ -n "$staging" ] && rm -rf -- "$staging"
        return 1
    fi
    cp -a "$src/install-resolute-satellite.sh" "$staging/install-resolute-satellite.sh" || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -rf -- "$staging"; return 1; }
    for d in pnetlab-debs deps qemu-zoo; do
        if [ ! -d "$src/$d" ]; then
            log "satellite stage source has no $d directory; skipping it"
            continue
        fi
        rm -rf -- "$staging/$d" || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -rf -- "$staging"; return 1; }
        cp -a "$src/$d" "$staging/" || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -rf -- "$staging"; return 1; }
    done
    if [ -d "$staging/pnetlab-debs" ]; then
        find "$staging/pnetlab-debs" -maxdepth 1 -type f -name '*.deb' -print0 |
            while IFS= read -r -d '' deb; do
                package=$(dpkg-deb -f "$deb" Package 2>/dev/null || true)
                case "$package" in
                    pnetlab-docker|pnetlab-qemu|pnetlab-satellite|pnetlab-vpcs|pnetlab-bridge-dkms) : ;;
                    *) rm -f -- "$deb" ;;
                esac
            done
    fi
    for package in "${SATELLITE_HARD_PACKAGES[@]}"; do
        deb=$(find "$staging/pnetlab-debs" -maxdepth 1 -type f -name "${package}_*.deb" -print -quit 2>/dev/null || true)
        if [ -z "$deb" ] || [ "$(dpkg-deb -f "$deb" Package 2>/dev/null)" != "$package" ] \
            || [ "$(dpkg-deb -f "$deb" Version 2>/dev/null)" != "$MASTER_RELEASE" ]; then
            log "satellite stage source has no complete $package payload; skipping repair"
            [ -n "$tmp" ] && rm -rf "$tmp"
            rm -rf -- "$staging"
            return 0
        fi
    done
    if ! install -d -m 0755 "$staging/qemu-zoo" "$staging/deps"; then
        [ -n "$tmp" ] && rm -rf "$tmp"
        rm -rf -- "$staging"
        return 1
    fi
    asset_cache="$ASSET_CACHE_ROOT/$MASTER_RELEASE"
    if [ -e "$asset_cache" ] || [ -L "$asset_cache" ]; then
        if ! repair_asset_cache_is_valid "$asset_cache"; then
            log "verified satellite asset cache is present but invalid for $MASTER_RELEASE; skipping repair"
            [ -n "$tmp" ] && rm -rf "$tmp"
            rm -rf -- "$staging"
            return 0
        fi
        asset_cache_available=1
    fi
    for version in "${SATELLITE_ZOO_VERSIONS[@]}"; do
        if [ "$asset_cache_available" -eq 1 ]; then
            asset_path="$asset_cache/qemu-zoo/qemu-zoo-$version-net.tgz"
        else
            asset_path="$staging/qemu-zoo/qemu-zoo-$version-net.tgz"
        fi
        if [ ! -f "$asset_path" ]; then
            log "satellite stage source has no qemu-zoo $version payload; skipping repair"
            [ -n "$tmp" ] && rm -rf "$tmp"
            rm -rf -- "$staging"
            return 0
        fi
    done
    if [ "$asset_cache_available" -eq 1 ]; then
        asset_path="$asset_cache/deps/qemu-compat-libs.tgz"
    else
        asset_path="$staging/deps/qemu-compat-libs.tgz"
    fi
    if [ ! -f "$asset_path" ]; then
        log 'satellite stage source has no qemu-compat-libs.tgz; skipping repair'
        [ -n "$tmp" ] && rm -rf "$tmp"
        rm -rf -- "$staging"
        return 0
    fi
    if [ "$asset_cache_available" -eq 1 ]; then
        if ! install -m 0644 "$asset_cache/asset-inventory.tsv" "$staging/asset-inventory.tsv" \
            || ! install -m 0644 "$asset_cache/deps/qemu-compat-libs.tgz" "$staging/deps/qemu-compat-libs.tgz"; then
            [ -n "$tmp" ] && rm -rf "$tmp"
            rm -rf -- "$staging"
            return 1
        fi
        for version in "${SATELLITE_ZOO_VERSIONS[@]}"; do
            asset="qemu-zoo-$version-net.tgz"
            if ! install -m 0644 "$asset_cache/qemu-zoo/$asset" "$staging/qemu-zoo/$asset"; then
                [ -n "$tmp" ] && rm -rf "$tmp"
                rm -rf -- "$staging"
                return 1
            fi
        done
    else
        if ! printf 'asset\tsha256\tsize\tpath\n' >"$staging/asset-inventory.tsv"; then
            [ -n "$tmp" ] && rm -rf "$tmp"
            rm -rf -- "$staging"
            return 1
        fi
        asset_path="$staging/deps/qemu-compat-libs.tgz"
        if ! repair_asset_file_is_valid "$asset_path" \
            || ! sha=$(sha256sum "$asset_path" | awk '{print $1}') \
            || ! size=$(stat -c '%s' "$asset_path") \
            || ! printf 'qemu-compat-libs.tgz\t%s\t%s\tdeps/qemu-compat-libs.tgz\n' "$sha" "$size" >>"$staging/asset-inventory.tsv"; then
            log 'locally repaired qemu-compat-libs.tgz is not a fully readable tar archive; skipping repair'
            [ -n "$tmp" ] && rm -rf "$tmp"
            rm -rf -- "$staging"
            return 0
        fi
        for version in "${SATELLITE_ZOO_VERSIONS[@]}"; do
            asset="qemu-zoo-$version-net.tgz"
            asset_path="$staging/qemu-zoo/$asset"
            if ! repair_asset_file_is_valid "$asset_path" \
                || ! sha=$(sha256sum "$asset_path" | awk '{print $1}') \
                || ! size=$(stat -c '%s' "$asset_path") \
                || ! printf '%s\t%s\t%s\tqemu-zoo/%s\n' "$asset" "$sha" "$size" "$asset" >>"$staging/asset-inventory.tsv"; then
                log "locally repaired $asset is not a fully readable tar archive; skipping repair"
                [ -n "$tmp" ] && rm -rf "$tmp"
                rm -rf -- "$staging"
                return 0
            fi
        done
    fi
    package_list="pnetlab-docker=$MASTER_RELEASE,pnetlab-qemu=$MASTER_RELEASE,pnetlab-satellite=$MASTER_RELEASE,pnetlab-vpcs=$MASTER_RELEASE"
    optional_list=''
    optional_deb=$(find "$staging/pnetlab-debs" -maxdepth 1 -type f -name 'pnetlab-bridge-dkms_*.deb' -print -quit 2>/dev/null || true)
    if [ -n "$optional_deb" ] && [ "$(dpkg-deb -f "$optional_deb" Version 2>/dev/null)" = "$MASTER_RELEASE" ]; then
        optional_list="pnetlab-bridge-dkms=$MASTER_RELEASE"
    fi
    {
        printf 'package\tarchitecture\tversion\tsha256\tsize\tfilename\n'
        mapfile -t staged_debs < <(find "$staging/pnetlab-debs" -maxdepth 1 -type f -name '*.deb' -printf '%p\n' | sort)
        for deb in "${staged_debs[@]}"; do
            package=$(dpkg-deb -f "$deb" Package); arch=$(dpkg-deb -f "$deb" Architecture); version=$(dpkg-deb -f "$deb" Version)
            sha=$(sha256sum "$deb" | awk '{print $1}'); size=$(stat -c '%s' "$deb"); filename=$(basename "$deb")
            printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$package" "$arch" "$version" "$sha" "$size" "$filename"
        done
    } >"$staging/inventory.tsv" || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -rf -- "$staging"; return 1; }
    inventory_sha=$(sha256sum "$staging/inventory.tsv" | awk '{print $1}')
    asset_inventory_sha=$(sha256sum "$staging/asset-inventory.tsv" | awk '{print $1}')
    {
        printf 'format=1\nrelease=%s\npackages=%s\noptional_packages=%s\n' "$MASTER_RELEASE" "$package_list" "$optional_list"
        printf 'assets=qemu-compat-libs.tgz,qemu-zoo-2.4.0-net.tgz,qemu-zoo-2.12.0-net.tgz,qemu-zoo-4.1.0-net.tgz,qemu-zoo-5.2.0-net.tgz\n'
        printf 'inventory_sha256=%s\nasset_inventory_sha256=%s\n' "$inventory_sha" "$asset_inventory_sha"
    } >"$staging/COMPLETE" || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -rf -- "$staging"; return 1; }
    printf 'release=%s\nsource=repair\nprofile=satellite\n' "$MASTER_RELEASE" >"$staging/provenance" || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -rf -- "$staging"; return 1; }
    chown -R root:root "$staging" || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -rf -- "$staging"; return 1; }
    if ! find "$staging" -type d -exec chmod 0755 {} + \
        || ! find "$staging" -type f -exec chmod 0644 {} + \
        || ! chmod 0755 "$staging/install-resolute-satellite.sh"; then
        [ -n "$tmp" ] && rm -rf "$tmp"
        rm -rf -- "$staging"
        return 1
    fi
    # Shared with network-install-pnetlab-27H1.sh: only one publisher may
    # mutate this release tree or reap its rollback tombstones at a time.
    publish_lock_file="$releases/.publish.lock"
    if ! exec 7>"$publish_lock_file"; then
        [ -n "$tmp" ] && rm -rf "$tmp"
        rm -rf -- "$staging"
        log "could not open satellite release publish lock $publish_lock_file"
        return 1
    fi
    if ! flock -x -w 600 7; then
        exec 7>&-
        [ -n "$tmp" ] && rm -rf "$tmp"
        rm -rf -- "$staging"
        log "another satellite release publisher holds $publish_lock_file"
        return 1
    fi
    if (
        reap_satellite_tombstones "$releases"
    if [ -e "$destination" ] || [ -L "$destination" ]; then
        [ -d "$destination" ] && [ ! -L "$destination" ] \
            || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -rf -- "$staging"; return 1; }
        tombstone="$releases/$MASTER_RELEASE.superseded.$$.$RANDOM"
        if [ -e "$tombstone" ] || [ -L "$tombstone" ] \
            || ! mv -T -- "$destination" "$tombstone"; then
            [ -n "$tmp" ] && rm -rf "$tmp"
            rm -rf -- "$staging"
            return 1
        fi
        if ! mv -T -- "$staging" "$destination"; then
            if ! mv -T -- "$tombstone" "$destination"; then
                [ -n "$tmp" ] && rm -rf "$tmp"
                return 1
            fi
            [ -n "$tmp" ] && rm -rf "$tmp"
            rm -rf -- "$staging"
            return 1
        fi
        rm -rf -- "$tombstone" || log "published $destination but could not remove superseded tombstone $tombstone"
    else
        mv -T -- "$staging" "$destination" || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -rf -- "$staging"; return 1; }
    fi
    local pointer_tmp="$BUNDLE/.current.$$.tmp"
    rm -f -- "$pointer_tmp"
    ln -s "releases/$MASTER_RELEASE" "$pointer_tmp" || { [ -n "$tmp" ] && rm -rf "$tmp"; return 1; }
    chown -h root:root "$pointer_tmp" || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -f -- "$pointer_tmp"; return 1; }
    mv -Tf -- "$pointer_tmp" "$BUNDLE/current" || { [ -n "$tmp" ] && rm -rf "$tmp"; rm -f -- "$pointer_tmp"; return 1; }
    reap_satellite_tombstones "$releases"
    [ -n "$tmp" ] && rm -rf "$tmp"
    return 0
    ); then
        publish_status=0
    else
        publish_status=$?
    fi
    flock -u 7 || true
    exec 7>&-
    return "$publish_status"
}
if ! bundle_is_complete "$BUNDLE" "$MASTER_RELEASE"; then
    upd "running" 2 "staging or repairing satellite bundle on the master"
    stage_bundle || fail "satellite bundle is absent, incomplete, or release-mismatched and no complete source bundle was available"
fi
validate_bundle_root
BUNDLE_CURRENT=$(readlink -f -- "$BUNDLE/current") || fail "could not resolve the current satellite bundle"
[ -n "$BUNDLE_CURRENT" ] || fail "current satellite bundle pointer is empty"

# ── 2. push the bundle (5–60 %) ───────────────────────────────────────────────
upd "running" 5 "copying bundle to $IP"
sshpass -e rsync -a --info=progress2 -e "$SSHOPT" \
        -- "$BUNDLE_CURRENT/" "${SUSER}@${IP}:/tmp/pnet-satellite-bundle/" 2>&1 \
    | tr '\r' '\n' \
    | while IFS= read -r line; do
        if [[ "$line" =~ ([0-9]+)% ]]; then
            upd "running" $(( 5 + ${BASH_REMATCH[1]} * 55 / 100 )) "copying bundle to $IP"
        fi
    done
RC="${PIPESTATUS[0]}"
[ "$RC" = "0" ] || fail "bundle copy failed (rsync rc $RC)"

# ── 3. install (60–88 %) ──────────────────────────────────────────────────────
upd "running" 62 "installing pnetlab-satellite on $IP (several minutes)"
run_root 'bash /tmp/pnet-satellite-bundle/install-resolute-satellite.sh --no-reboot' \
    </dev/null >> "$LOG" 2>&1 \
    || fail "satellite installer failed — see cluster/jobs/${JOB}.log on the master"
chmod 644 "$LOG" 2>/dev/null
run_root 'set -e; dpkg --configure -a; audit=$(dpkg --audit); [ -z "$audit" ]; apt-get check; for p in pnetlab-satellite pnetlab-qemu pnetlab-vpcs; do status="$(dpkg-query -W -f="\${db:Status-Abbrev}" "$p" 2>/dev/null)"; case "$status" in ii\ |hi\ ) ;; *) exit 1 ;; esac; done; systemctl is-active --quiet pnetlab-brokerd.service' \
    </dev/null >> "$LOG" 2>&1 \
    || fail "satellite package or broker checks failed; refusing to join"

# ── 4. join ───────────────────────────────────────────────────────────────────
upd "running" 90 "joining $NAME to the cluster"
if [ ! -s "$PSK_FILE" ]; then
    mkdir -p "$(dirname "$PSK_FILE")"; chmod 700 "$(dirname "$PSK_FILE")"
    umask 077; openssl rand -hex 32 > "$PSK_FILE" || fail "could not generate a PSK"
fi
PSK=$(tr -d '\n' < "$PSK_FILE")
# the master's IP exactly as the satellite reaches it = our SSH source address
MASTER_IP=$(run_remote 'echo "$SSH_CONNECTION"' | awk '{print $1}' | tr -d '\r')
[ -n "$MASTER_IP" ] || fail "could not determine the master IP from the satellite"
printf '%s\n' "$PSK" | run_root "pnet-satellite-join --master $MASTER_IP --id $SLOT --name $(qq "$NAME") --psk -" \
    >> "$LOG" 2>&1 || fail "join failed — see cluster/jobs/${JOB}.log on the master"
run_root 'systemctl enable --now pnetlab-satd.service && systemctl is-active --quiet pnetlab-satd.service' \
    </dev/null >> "$LOG" 2>&1 || fail "satellite service failed after join — see cluster/jobs/${JOB}.log on the master"

# ── 5. cleanup + reboot into the PNetLab kernel ───────────────────────────────
upd "running" 97 "rebooting $IP"
run_root 'rm -rf /tmp/pnet-satellite-bundle' </dev/null >> "$LOG" 2>&1
run_root 'systemctl reboot' </dev/null >> "$LOG" 2>&1 || true   # ssh drop is expected
unset SSHPASS

upd "done" 100 "$NAME deployed — rebooting into the PNetLab kernel"
exit 0
