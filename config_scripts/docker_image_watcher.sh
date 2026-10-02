#!/bin/bash
# Watches /opt/unetlab/addons/docker/ for new Docker image archives and
# loads them automatically.
#
# Standard images (.tar.gz/.tar/.tgz/.tar.xz) are `docker load`ed as-is.
# Arista cEOS-lab archives (filename contains "ceos") are FLAT root filesystems,
# not `docker save` images, so they are routed to ceos_provision.sh, which does
# `docker import` + bakes the systemd boot CMD / flash volume (see that script).
#
# Triggers on:
#   close_write  — file written via SCP/cp
#   moved_to     — file written via rsync (temp file renamed into place)
#
# After loading, fixes ownership of the addon directory to pnet:pnet.

WATCH_DIR="/opt/unetlab/addons/docker"
LOG="/var/log/docker-image-watcher.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }

log "Docker image watcher started. Watching $WATCH_DIR"

inotifywait -m -r --format '%w%f' \
    -e close_write -e moved_to \
    "$WATCH_DIR" 2>/dev/null | \
while read -r filepath; do
    filename="$(basename "$filepath")"
    dirpath="$(dirname "$filepath")"

    # Only trigger on Docker image archive files (cEOS also ships as .tar.xz)
    case "$filename" in
        *.tar.gz|*.tar|*.tgz|*.tar.xz) ;;
        *) continue ;;
    esac

    log "New Docker image archive detected: $filepath"

    # Brief wait in case file is still being flushed
    sleep 2

    # Arista cEOS-lab: flat filesystem archive -> needs `docker import` + baking,
    # not `docker load`. Hand it to the provisioner.
    if echo "$filename" | grep -qiE 'ceos'; then
        log "cEOS archive detected: $filepath — provisioning"
        if /opt/unetlab/config_scripts/ceos_provision.sh "$filepath" >> "$LOG" 2>&1; then
            chown -R pnet:pnet "$dirpath/" 2>/dev/null || true
            log "cEOS provision complete: $filepath — image ready for PNetLab nodes"
        else
            log "WARNING: cEOS provision failed for $filepath — check $LOG for details"
        fi
        continue
    fi

    log "Loading into Docker: $filepath"
    if docker load -i "$filepath" >> "$LOG" 2>&1; then
        chown -R pnet:pnet "$dirpath/"
        loaded=$(docker images --format '{{.Repository}}:{{.Tag}}' | head -1)
        log "Load complete: $filepath — image ready for PNetLab nodes"
    else
        log "WARNING: docker load failed for $filepath — check $LOG for details"
    fi
done
