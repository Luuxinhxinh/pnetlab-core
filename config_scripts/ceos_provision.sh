#!/bin/bash
# ceos_provision.sh — make an Arista cEOS-lab filesystem archive available as a
# PNetLab Docker image.
#
# cEOS-lab tars are FLAT root filesystems (use `docker import`, not `docker load` —
# they carry no manifest.json), so they cannot be auto-loaded by the generic
# docker_image_watcher path. This script imports one as:  ceos:<version>
# (a name containing "ceos", which is what the GUI cEOS node picker filters on).
#
# Nothing else needs baking: PNetLab's devices/docker/device_ceos.php already builds
# the full run command at node start — it appends `/sbin/init systemd.setenv=...` and
# passes `-e CEOS=1 -e EOS_PLATFORM=ceoslab -e ETBA=1 ...` from the node's template
# fields (ETBA / EOS_PLATFORM default to 1 / ceoslab in templates/device/ceos.yml).
# (The EVE-NG manual recipe bakes that CMD/ENV/getty-strip into the image instead,
# because EVE-NG runs the image through a generic Docker path; under PNetLab the
# engine supplies it, and a bare `-e EOS_PLATFORM=` from the node would override any
# baked ENV anyway — so an import is all that is required.)
#
# Idempotent. Usage: ceos_provision.sh <path-to-cEOS-lab-archive>
set -o pipefail

DOCKER="docker -H=unix:///var/run/docker.sock"   # PNetLab engine's docker endpoint (tcp :4243 retired)
LOG="/var/log/docker-image-watcher.log"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') ceos_provision: $*" | tee -a "$LOG"; }

SRC="$1"
[ -n "$SRC" ] || { log "ERROR: usage: ceos_provision.sh <cEOS-lab-archive>"; exit 2; }
[ -f "$SRC" ] || { log "ERROR: source archive not found: $SRC"; exit 1; }

base="$(basename "$SRC")"
# Derive the EOS version from the filename, e.g. 4.34.6M / 4.27.0F.
ver="$(echo "$base" | grep -oiE '[0-9]+\.[0-9]+\.[0-9]+[A-Za-z]?' | head -1)"
[ -n "$ver" ] || ver="latest"
tag="ceos:${ver}"

# Idempotency: already imported?
if $DOCKER image inspect "$tag" >/dev/null 2>&1; then
    log "$tag already present — skipping import."
    exit 0
fi

# docker import auto-handles .tar / .tar.gz / .tar.xz compression.
log "importing cEOS '$SRC' -> $tag"
if $DOCKER import "$SRC" "$tag" >>"$LOG" 2>&1; then
    log "DONE: $tag ready — add a cEOS Docker node in PNetLab (telnet console -> EOS Cli)."
    exit 0
else
    log "ERROR: docker import failed for $SRC"
    exit 1
fi
