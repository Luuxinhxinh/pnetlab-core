#!/bin/bash
# install-resolute-satellite.sh — PNetLab 27H1 v8 (Ubuntu 26.04 "resolute") CLUSTER SATELLITE installer.
#
# Headless node-execution host: engine wrappers + qemu/iol/dynamips/docker
# runtimes, NO apache/mysql/store/webconsole/guacd. After install, join the
# cluster from the master's System -> Cluster page:
#
#       pnet-satellite-join --master <master-ip> --id <1|2> --psk <psk>
#
# Run on a FRESH Ubuntu 26.04 machine:
#       sudo bash install-resolute-satellite.sh
#
# Uses the release-scoped bundle layout (pnetlab-debs/, deps/qemu-compat-libs.tgz,
# qemu-zoo/*.tgz, COMPLETE, and inventory.tsv). Idempotent.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C.UTF-8

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEBS_DIR="$SCRIPT_DIR/pnetlab-debs"
DEPS_DIR="$SCRIPT_DIR/deps"
LOG="/var/log/install-pnetlab-noble-satellite.log"
BUNDLE_COMPLETE="$SCRIPT_DIR/COMPLETE"
EXPECTED_RELEASE=''

readonly -a SATELLITE_REQUIRED_PACKAGES=(
    pnetlab-docker pnetlab-qemu pnetlab-satellite pnetlab-vpcs
)
readonly -a SATELLITE_ZOO_VERSIONS=(2.4.0 2.12.0 4.1.0 5.2.0)

DO_REBOOT=1
for arg in "$@"; do
    case $arg in
        --no-reboot) DO_REBOOT=0 ;;
    esac
done

log()  { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
warn() { echo "[$(date '+%H:%M:%S')] WARNING: $*" | tee -a "$LOG" >&2; }
die()  { echo "[$(date '+%H:%M:%S')] ERROR: $*" | tee -a "$LOG" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

: > "$LOG"
log "=== PNetLab 27H1 v8 SATELLITE Installer (Ubuntu 26.04 resolute, headless) ==="
log "Log: $LOG ; bundle: $SCRIPT_DIR"

# ── Preflight ─────────────────────────────────────────────────────────────────
[ "$(id -u)" = "0" ] || die "Must run as root (sudo bash install-resolute-satellite.sh)"
lsb_release -r -s 2>/dev/null | grep -q '26.04' || \
    die "Requires Ubuntu 26.04. Detected: $(lsb_release -r -s 2>/dev/null || echo unknown)"
[ -d "$DEBS_DIR" ] || die "pnetlab-debs/ not found in $SCRIPT_DIR"
[ -d "$DEPS_DIR" ] || die "deps/ not found in $SCRIPT_DIR"
dpkg -s pnetlab >/dev/null 2>&1 && \
    die "pnetlab (master) is installed on this box — a host is master OR satellite, not both"

marker_value() {
    local key="$1"
    awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1) }' "$BUNDLE_COMPLETE"
}

[ -f "$BUNDLE_COMPLETE" ] || die "satellite bundle COMPLETE marker is missing"
[ "$(marker_value format)" = '1' ] || die "satellite bundle COMPLETE marker has an invalid format"
EXPECTED_RELEASE="$(marker_value release)"
[[ "$EXPECTED_RELEASE" =~ ^6\.8\.[0-9]+resolute1$ ]] \
    || die "satellite bundle COMPLETE marker has an invalid release"
[ "$(marker_value packages)" = "pnetlab-docker=$EXPECTED_RELEASE,pnetlab-qemu=$EXPECTED_RELEASE,pnetlab-satellite=$EXPECTED_RELEASE,pnetlab-vpcs=$EXPECTED_RELEASE" ] \
    || die "satellite bundle COMPLETE marker has an incomplete package inventory"
expected_assets="qemu-compat-libs.tgz,qemu-zoo-2.4.0-net.tgz,qemu-zoo-2.12.0-net.tgz,qemu-zoo-4.1.0-net.tgz,qemu-zoo-5.2.0-net.tgz"
[ "$(marker_value assets)" = "$expected_assets" ] \
    || die "satellite bundle COMPLETE marker has an incomplete asset inventory"
[ -z "$(marker_value optional_packages)" ] \
    || [ "$(marker_value optional_packages)" = "pnetlab-bridge-dkms=$EXPECTED_RELEASE" ] \
    || die "satellite bundle COMPLETE marker has an invalid optional package inventory"
[ -f "$SCRIPT_DIR/inventory.tsv" ] || die "satellite bundle package inventory is missing"
inventory_sha="$(sha256sum "$SCRIPT_DIR/inventory.tsv" | awk '{print $1}')"
[ "$inventory_sha" = "$(marker_value inventory_sha256)" ] \
    || die "satellite bundle package inventory digest does not match COMPLETE"

# ── [1/8] DPKG cleanup ─────────────────────────────────────────────────────────
log "[1/8] Cleaning dpkg locks / configuring pending packages..."
rm -f /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/cache/apt/archives/lock 2>/dev/null || true
dpkg --configure -a >> "$LOG" 2>&1 || die "Initial dpkg configuration failed"

# ── [2/8] systemd timeout ──────────────────────────────────────────────────────
# The installer is normally invoked over SSH by pnet-satdeploy.sh. Preserve the
# caller's existing credential and SSH policy: changing either breaks or weakens
# the connection that the deployer must reuse for package checks and cluster join.
log "[2/8] Configuring systemd timeout (preserving existing credentials and SSH policy)..."
sed -i 's/.*DefaultTimeoutStopSec=.*/DefaultTimeoutStopSec=5s/' /etc/systemd/system.conf 2>/dev/null || true

# ── [3/8] APT update + remove conflicting docker ───────────────────────────────
log "[3/8] apt update; removing distro docker.io/containerd if present..."
apt-get purge -y docker.io containerd runc >> "$LOG" 2>&1 || true
apt-get update -q >> "$LOG" 2>&1 || die "apt-get update failed (need internet to Ubuntu mirrors)"

# ── [4/8] Base apt dependencies (headless subset of the master list) ───────────
# Engine + node runtimes only: php8.5 CLI stack (unl_wrapper is PHP), 32-bit IOL
# libs, the qemu runtime lib zoo (same sonames as the master list), tooling the
# wrappers/scripts call. NO apache/mysql/guac/websockify/java/freerdp/pango.
log "[4/8] Installing base apt dependencies (headless engine subset)..."
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    -o Dpkg::Options::="--force-confdef" \
    -o Dpkg::Options::="--force-confold" \
    ifupdown unzip resolvconf \
    build-essential dkms \
    php8.5-cli php8.5-yaml php8.5-common php8.5-curl php8.5-gd \
    php8.5-mbstring php8.5-mysql php8.5-sqlite3 php8.5-xml php8.5-zip \
    libncurses6 libncursesw6 libtinfo6 vim dos2unix \
    bridge-utils dmidecode genisoimage iptables \
    lib32gcc-s1 lib32z1 libc6 libc6-i386 libelf1 libpcap0.8 \
    libsdl1.2debian logrotate lsb-release lvm2 chrony rsync \
    python3-pexpect sqlite3 tcpdump telnet uml-utilities zip \
    cgroup-tools libyaml-0-2 net-tools \
    libaio1t64 libasound2t64 libbrlapi0.8 libcacard0 libepoxy0 libfdt1 libgbm1 \
    libgcc-s1 libglib2.0-0 libgnutls30 libibverbs1 libjpeg8 \
    libnettle8 libnuma1 libpixman-1-0 libpmem1 librdmacm1 libsasl2-2 \
    libseccomp2 libslirp0 libspice-server1 libusb-1.0-0 \
    libusbredirparser1 libvirglrenderer1 zlib1g qemu-system-common qemu-system-x86 qemu-utils \
    libcapstone5 libvdeplug2 libnfs14 libxss1 libsdl2-2.0-0 libsnappy1v5 \
    libspice-client-glib-2.0-8 inotify-tools curl ca-certificates gnupg \
    bc lsof busybox-static \
    openssh-server openssl \
    >> "$LOG" 2>&1 || die "Base dependency installation failed"
update-alternatives --set php /usr/bin/php8.5 >> "$LOG" 2>&1 || true

# ── [5/8] Side-load compat debs (libssl1.1 + lib32gcc1 transitional dummy) ─────
log "[5/8] Side-loading libssl1.1 + lib32gcc1 transitional dummy..."
if ls "$DEPS_DIR"/libssl1.1_*.deb >/dev/null 2>&1; then
    dpkg -i "$DEPS_DIR"/libssl1.1_*.deb >> "$LOG" 2>&1 || warn "libssl1.1 install warning"
else
    warn "deps/libssl1.1_*.deb missing — focal-linked bundled binaries may fail to load"
fi
if ls "$DEPS_DIR"/lib32gcc1_*.deb >/dev/null 2>&1; then
    dpkg -i "$DEPS_DIR"/lib32gcc1_*.deb >> "$LOG" 2>&1 || warn "lib32gcc1 dummy install warning"
fi

# ── [6/8] Docker CE from docker.com (resolute) ─────────────────────────────────
log "[6/8] Installing Docker CE (docker.com resolute repo)..."
if have docker && docker --version >/dev/null 2>&1; then
    log "  Docker already present ($(docker --version)) — skipping repo setup"
else
    install -m 0755 -d /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
            | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>>"$LOG" || warn "docker gpg fetch failed"
        chmod a+r /etc/apt/keyrings/docker.gpg 2>/dev/null || true
    fi
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu resolute stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -q >> "$LOG" 2>&1 || warn "docker repo apt update failed"
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
        >> "$LOG" 2>&1 || warn "docker-ce install failed — install manually later"
fi

# ── [7/8] PNetLab packages (kernel, runtimes, satellite) ───────────────────────
log "[7/8] Installing PNetLab packages from local files..."
# v8/27H1: no custom kernel — 26.04 stock Linux 7.0 has in-tree KSM (userspace tuning ships in the satellite deb).
select_deb_path() {
    local package="$1" found
    found="$(ls "$DEBS_DIR/${package}_"*_amd64.deb 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$found" ] || die "Missing local deb for required package $package"
    [ "$(dpkg-deb -f "$found" Package 2>/dev/null)" = "$package" ] \
        || die "Local deb identity mismatch for $package: $found"
    [ "$(dpkg-deb -f "$found" Version 2>/dev/null)" = "$EXPECTED_RELEASE" ] \
        || die "Local deb version mismatch for $package: expected $EXPECTED_RELEASE"
    printf '%s\n' "$found"
}

LOCAL_DEBS=()
for package in "${SATELLITE_REQUIRED_PACKAGES[@]}"; do
    found="$(select_deb_path "$package")"
    LOCAL_DEBS+=("$found")
    log "  verified $package: $(basename "$found")"
done

BRIDGE_DEB=''
bridge_candidate="$(ls "$DEBS_DIR/pnetlab-bridge-dkms_"*.deb 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$bridge_candidate" ]; then
    [ "$(dpkg-deb -f "$bridge_candidate" Package 2>/dev/null)" = pnetlab-bridge-dkms ] \
        || die "Optional bridge deb identity mismatch: $bridge_candidate"
    [ "$(dpkg-deb -f "$bridge_candidate" Version 2>/dev/null)" = "$EXPECTED_RELEASE" ] \
        || die "Optional bridge deb version mismatch: $bridge_candidate"
    BRIDGE_DEB="$bridge_candidate"
    LOCAL_DEBS+=("$BRIDGE_DEB")
fi

HOLD_PACKAGES=("${SATELLITE_REQUIRED_PACKAGES[@]}")
[ -n "$BRIDGE_DEB" ] && HOLD_PACKAGES+=(pnetlab-bridge-dkms)
# On a first deploy the local .debs below are not known to dpkg yet, so apt-mark
# cannot look them up and would fail the install.  Only packages whose dpkg
# selection is actually "hold" need clearing: the selection is independent of
# the install status, so this excludes both unknown and rc/config-files-only
# package records (as well as installed packages that are not held).
already_held=()
for package in "${HOLD_PACKAGES[@]}"; do
    if [ "$(dpkg-query -W -f='${db:Status-Want}' "$package" 2>/dev/null)" = hold ]; then
        already_held+=("$package")
    fi
done
if [ "${#already_held[@]}" -gt 0 ]; then
    apt-mark unhold "${already_held[@]}" >> "$LOG" 2>&1 \
        || die "Could not unhold the satellite packages for redeploy"
else
    log "  no packages currently on hold; skipping unhold"
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall --allow-downgrades \
    --allow-change-held-packages --no-install-recommends \
    -o Dpkg::Options::="--force-confdef" \
    -o Dpkg::Options::="--force-confold" \
    "${LOCAL_DEBS[@]}" >> "$LOG" 2>&1 \
    || die "The single satellite package transaction failed"

assert_dpkg_audit_clean() {
    local audit
    audit="$(dpkg --audit 2>&1)" || die "dpkg --audit failed"
    [ -z "$audit" ] || { printf '%s\n' "$audit" >> "$LOG"; die "dpkg --audit reported an incomplete package state"; }
}

assert_package_configured() {
    local package="$1" status
    status="$(dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null || true)"
    [ "$status" = 'ii ' ] || die "$package is not configured (status ${status:-missing})"
}

assert_dpkg_audit_clean
dpkg --configure -a >> "$LOG" 2>&1 || die "dpkg --configure -a failed"
assert_dpkg_audit_clean
apt-get check >> "$LOG" 2>&1 || die "apt-get check failed after satellite installation"
for package in "${SATELLITE_REQUIRED_PACKAGES[@]}"; do
    assert_package_configured "$package"
done

systemctl daemon-reload >> "$LOG" 2>&1 || die "systemd daemon-reload failed"
# pnetlab-docker configures docker.service; the PNetLab package set provides
# the image watcher. Verify both real units after the package transaction.
for unit in pnetlab-brokerd.service docker.service pnetlab-docker-image-watcher.service; do
    systemctl enable --now "$unit" >> "$LOG" 2>&1 || die "$unit failed to start"
    systemctl is-active --quiet "$unit" || die "$unit is not active after start"
done
systemctl enable pnetlab-satd.service >> "$LOG" 2>&1 || die "pnetlab-satd.service could not be enabled"

apt-mark hold "${HOLD_PACKAGES[@]}" >> "$LOG" 2>&1 \
    || die "Could not restore the satellite package holds"

# Verify the LACP bridge hotfix module is active
if dkms status 2>/dev/null | grep -q "pnetlab-bridge" && modinfo bridge 2>/dev/null | grep -q "2.3.1-pnetlab"; then
    log "  [ok] pnetlab-bridge-dkms 2.3.1-pnetlab active"
else
    warn "pnetlab-bridge-dkms NOT active — LACP/multi-chassis LAG will fail." \
         "Run: dkms install pnetlab-bridge/1.0 --force; modprobe -r bridge; modprobe bridge"
fi

# ── [8/8] QEMU 9.2.4 default + legacy compat libs + permissions ────────────────
# The zoo tarballs are rooted at qemu-<version>/ and extract under /opt; the
# compat archive is a flat .so set extracted into /opt/qemu-compat-libs.
log "[8/8] Extracting the four network QEMU zoo versions + compat libs..."
log "qemu92/ is not present; v8 does not ship a qemu92 bundle (expected)"
for version in "${SATELLITE_ZOO_VERSIONS[@]}"; do
    zoo="$SCRIPT_DIR/qemu-zoo/qemu-zoo-$version-net.tgz"
    [ -f "$zoo" ] || die "required QEMU zoo archive is missing: $zoo"
    tar xzf "$zoo" -C /opt >> "$LOG" 2>&1 \
        || die "QEMU zoo extraction failed: $zoo"
done
[ -f "$DEPS_DIR/qemu-compat-libs.tgz" ] \
    || die "required qemu-compat-libs.tgz is missing"
mkdir -p /opt/qemu-compat-libs
tar xzf "$DEPS_DIR/qemu-compat-libs.tgz" -C /opt/qemu-compat-libs >> "$LOG" 2>&1 \
    || die "qemu compat libs extraction failed"
echo "/opt/qemu-compat-libs" > /etc/ld.so.conf.d/pnetlab-qemu-compat.conf
ldconfig >> "$LOG" 2>&1 || die "ldconfig failed after qemu-compat-libs extraction"
# Pre-join this fails on the missing cluster DB (the deb postinst already set
# the workspace ownership DB-independently); on a joined re-run it heals.
/opt/unetlab/wrappers/unl_wrapper -a fixpermissions >> "$LOG" 2>&1 || warn "fixpermissions warnings (expected pre-join)"

log "=== Satellite install complete ==="
log "Next: on the MASTER, System -> Cluster -> Generate PSK, then run here:"
log "    pnet-satellite-join --master <master-ip> --id <1|2> --psk <psk>"
if [ "$DO_REBOOT" = 1 ]; then
    log "Rebooting into the PNetLab kernel in 5s (Ctrl-C to abort; --no-reboot to skip)..."
    sleep 5
    reboot
fi
