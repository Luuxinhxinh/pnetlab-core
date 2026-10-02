#!/bin/bash
# vwifi-autoplace.sh — co-locate newly-joined wireless nodes at the RF origin so a
# dropped Wireless AP + STA pair associates without any manual placement.
#
# vwifi only links nodes once they have been explicitly placed (an unplaced node at
# the default 0,0,0 does NOT relay). This loop watches the medium server's node list
# and sets each cid to the origin the first time it appears, then leaves it alone.
# The P2 canvas-coupling (Wi-Fi Painter) will set real per-node coordinates and
# supersede this default behaviour.
#
# Started (idempotently) by the broker verb vwifi_server_ensure as a transient unit
# `pnet-vwifi-autoplace`. Safe to kill; it re-seeds on restart.
set -u
SRV=pnet-vwifi-server
declare -A seen
# disable random distance loss for the single default cell
docker exec "$SRV" vwifi-ctrl loss no >/dev/null 2>&1 || true
while true; do
    while read -r cid _rest; do
        [ -z "${cid:-}" ] && continue
        case "$cid" in
            (*[!0-9]*) continue ;;   # skip non-numeric lines
        esac
        if [ -z "${seen[$cid]:-}" ]; then
            if docker exec "$SRV" vwifi-ctrl set "$cid" 0 0 0 >/dev/null 2>&1; then
                seen[$cid]=1
            fi
        fi
    done < <(docker exec "$SRV" vwifi-ctrl ls 2>/dev/null)
    sleep 4
done
