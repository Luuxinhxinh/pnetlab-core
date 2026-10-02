#!/bin/bash
# pnet-imgsync.sh — push ONE device image master -> cluster satellite. Runs as
# root in a transient systemd unit (pnet-imgsync-<job>, spawned by brokerd's
# cluster_sync_image):    pnet-imgsync.sh <sat_ip> <type> <image> <job>
#
# Transport: rsync over the join-time cluster key, which the satellite jails
# with command="rrsync /opt/unetlab" — so everything lands under the addons
# tree by construction. Live progress (rsync --info=progress2) is written to
# html/cluster/jobs/<job>.json for the UI poll (cluster/api.php?action=
# sync_status). Docker images are exported to a tar under addons/docker/ on
# the satellite, where its pnetlab-docker-image-watcher auto-loads them.
set -o pipefail

SAT="$1"; TYPE="$2"; IMG="$3"; JOB="$4"
ST="/opt/unetlab/html/cluster/jobs/${JOB}.json"
KEY="/etc/pnetlab/cluster/id_ed25519"
SSHOPT="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
ADDONS="/opt/unetlab/addons"

mkdir -p "$(dirname "$ST")"
upd() {
    printf '{"state":"%s","pct":%s,"msg":"%s"}\n' "$1" "$2" "${3//\"/}" > "$ST"
    chmod 644 "$ST" 2>/dev/null
}
fail() { upd "error" 0 "$1"; exit 1; }

[ -n "$SAT" ] && [ -n "$TYPE" ] && [ -n "$IMG" ] && [ -n "$JOB" ] || fail "bad arguments"
[ -f "$KEY" ] || fail "cluster key missing (re-join the satellite)"

# rsync one path (file or dir/) with live percent from --info=progress2.
# Args: <label> <src...> (last src arg is the rsync source list, dst is sat:.)
push() {
    local label="$1"; shift
    upd "running" 0 "$label"
    rsync -a -R -e "$SSHOPT" --info=progress2 "$@" "root@${SAT}:." 2>&1 \
        | tr '\r' '\n' \
        | while IFS= read -r line; do
            if [[ "$line" =~ ([0-9]+)% ]]; then
                upd "running" "${BASH_REMATCH[1]}" "$label"
            fi
        done
    return "${PIPESTATUS[0]}"
}

case "$TYPE" in
    qemu)
        [ -d "$ADDONS/qemu/$IMG" ] || fail "qemu image $IMG not on the master"
        push "qemu/$IMG" "/opt/unetlab/./addons/qemu/$IMG" \
            || fail "rsync failed (satellite reachable?)"
        ;;
    iol)
        [ -f "$ADDONS/iol/bin/$IMG" ] || fail "iol image $IMG not on the master"
        # Deliberately NO iourc: the IOU license is host-locked (hostid+hostname),
        # so the master's copy is invalid on every satellite — and the cluster key
        # is rrsync-jailed, so the keygen can't be run remotely from here. The
        # satellite owns its own iourc (deb postinst + satd startup guard).
        push "iol/$IMG" "/opt/unetlab/./addons/iol/bin/$IMG" \
            || fail "rsync failed (satellite reachable?)"
        ;;
    dynamips)
        [ -f "$ADDONS/dynamips/$IMG" ] || fail "dynamips image $IMG not on the master"
        push "dynamips/$IMG" "/opt/unetlab/./addons/dynamips/$IMG" \
            || fail "rsync failed (satellite reachable?)"
        ;;
    docker)
        command -v docker >/dev/null 2>&1 || fail "docker missing on the master"
        SAFE="$(printf '%s' "$IMG" | tr '/:' '__')"
        TAR="/opt/unetlab/tmp/imgsync-${JOB}.tar"
        DST_REL="addons/docker/${SAFE}.tar"
        upd "running" 0 "docker save $IMG"
        docker -H=unix:///var/run/docker.sock save -o "$TAR" "$IMG" \
            || { rm -f "$TAR"; fail "docker save $IMG failed (image present on the master?)"; }
        # stage under a ./-rooted tree so -R lands it at addons/docker/<tar>
        STAGE="/opt/unetlab/tmp/imgsync-stage-${JOB}"
        mkdir -p "$STAGE/addons/docker"
        mv "$TAR" "$STAGE/$DST_REL"
        ( cd "$STAGE" && rsync -a -R -e "$SSHOPT" --info=progress2 "./$DST_REL" "root@${SAT}:." 2>&1 ) \
            | tr '\r' '\n' \
            | while IFS= read -r line; do
                if [[ "$line" =~ ([0-9]+)% ]]; then
                    upd "running" "${BASH_REMATCH[1]}" "docker/$IMG"
                fi
            done
        RC="${PIPESTATUS[0]}"
        rm -rf "$STAGE"
        [ "$RC" = "0" ] || fail "rsync failed (satellite reachable?)"
        # the satellite's docker-image-watcher loads the tar within seconds
        ;;
    *)
        fail "unsupported image type $TYPE"
        ;;
esac

upd "done" 100 "$TYPE/$IMG synced"
exit 0
