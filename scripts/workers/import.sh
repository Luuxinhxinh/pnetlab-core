#!/bin/bash
# import/worker.sh — pulls selected qemu/iol images + .unl labs from a remote
# PNetLab over rsync+ssh, then fixes permissions. Runs as root in a transient
# systemd unit (pnet-import-<job>, spawned by the broker):   worker.sh <job>
#
# Reads jobs/<job>.req (JSON: host,user,pass,port,images[],labs[]) and SHREDS it
# immediately, then writes live progress to jobs/<job>.json for the status poll.
# The password reaches ssh only through the SSHPASS env (never argv). Conflicts
# are skipped (rsync --ignore-existing) so existing local images/labs are kept.
set -o pipefail

JOB="$1"
BASE="/opt/unetlab/html/import"
ST="$BASE/jobs/${JOB}.json"
REQ="$BASE/jobs/${JOB}.req"
SNAPSHOT="/opt/unetlab/scripts/workers/config-snapshot.py"
WORK_ROOT="/run/pnetlab-worker-jobs"
WORK=""
REQ_SNAPSHOT=""
IMGS=""
LABS=""

cleanup() {
    unset SSHPASS
    if [ -n "$WORK" ] && [ -d "$WORK" ]; then
        find "$WORK" -type f -exec shred -u -- {} + 2>/dev/null || rm -rf -- "$WORK"
        rm -rf -- "$WORK"
    fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

upd() {
    printf '{"state":"%s","pct":%s,"msg":"%s"}\n' "$1" "$2" "${3//\"/}" > "$ST"
    chmod 666 "$ST" 2>/dev/null
}
fail() {
    upd "error" 0 "$1"
    if [ -n "$SHIPPED_RSYNC" ]; then
        sshpass -e ssh "${SSH_ARGS[@]}" "${RUSER}@${HOST}" "rm -f $SHIPPED_RSYNC" </dev/null 2>/dev/null || true
    fi
    exit 1
}

[ -f "$REQ" ] || fail "request missing"
command -v python3 >/dev/null 2>&1 || fail "python3 missing"
command -v sshpass >/dev/null 2>&1 || fail "sshpass missing"
command -v rsync   >/dev/null 2>&1 || fail "rsync missing"
[ -f "$SNAPSHOT" ] && [ ! -L "$SNAPSHOT" ] || fail "snapshot helper missing"

# Atomically claim this job's request, then read only the private immutable
# snapshot. A duplicate worker cannot consume the same request, and a writer
# cannot make separate parses observe different configuration versions.
[ -e "$WORK_ROOT" ] || [ -L "$WORK_ROOT" ] \
    || install -d -o root -g root -m 700 "$WORK_ROOT" \
    || fail "cannot create worker runtime"
[ -d "$WORK_ROOT" ] && [ ! -L "$WORK_ROOT" ] \
    && [ "$(stat -c '%u:%a' "$WORK_ROOT")" = "0:700" ] \
    || fail "unsafe worker runtime"
WORK=$(mktemp -d "$WORK_ROOT/import-${JOB}.XXXXXX") || fail "cannot create private workspace"
chmod 700 "$WORK" || fail "cannot protect private workspace"
REQ_SNAPSHOT="$WORK/request.json"
IMGS="$WORK/images"
LABS="$WORK/labs"
PASSFILE="$WORK/password"
python3 "$SNAPSHOT" --claim --max-bytes 1048576 "$REQ" "$REQ_SNAPSHOT" \
    || fail "request snapshot failed"

# Parse the request JSON with python3 (robust). Emit connection scalars on one
# line, and the selections to tab/line files for the loops below.
read -r HOST RUSER PORT NIMG NLAB < <(python3 - "$REQ_SNAPSHOT" "$IMGS" "$LABS" "$PASSFILE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
imgs = d.get("images", []) or []
labs = d.get("labs", []) or []
with open(sys.argv[2], "w") as f:
    for it in imgs:
        t = str(it.get("type", "")); n = str(it.get("name", ""))
        if t and n:
            f.write("%s\t%s\n" % (t, n))
with open(sys.argv[3], "w") as f:
    for p in labs:
        p = str(p)
        if p:
            f.write("%s\n" % p)
with open(sys.argv[4], "w") as f:
    f.write(str(d.get("pass", "")))
print(d.get("host", ""), d.get("user", ""), int(d.get("port", 22) or 22),
      len(imgs), len(labs))
PY
)
[ -n "$HOST" ] && [ -n "$RUSER" ] || fail "bad request"

# Password into the env ONLY (sshpass -e reads $SSHPASS), never a command line.
SSHPASS="$(cat "$PASSFILE")"
export SSHPASS
[ -n "$SSHPASS" ] || fail "missing password"

# Credentials are now loaded — destroy private on-disk copies at once.
shred -u "$REQ_SNAPSHOT" "$PASSFILE" 2>/dev/null || rm -f "$REQ_SNAPSHOT" "$PASSFILE"

# ssh transport (used by rsync's -e and by the tar fallback). The password is
# supplied to BOTH rsync and ssh via `sshpass -e` reading $SSHPASS — never argv.
SSH_ARGS=(-p "$PORT" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20)
SSHOPT="ssh ${SSH_ARGS[*]}"

# rsync execs a REMOTE rsync over ssh, so it needs rsync on BOTH ends. The source
# is an old PNetLab that may be AIRGAPPED (no apt) and may not ship rsync. So:
#   1) use the remote's own rsync if present;
#   2) else SHIP our bundled fully-static amd64 rsync into the remote's tmpfs and
#      point rsync at it with --rsync-path (no install, no internet, removed after);
#   3) else fall back to a tar-over-ssh stream (only ssh+tar needed remotely).
# All paths preserve "skip existing": rsync via --ignore-existing, tar via
# --skip-old-files (plus an explicit pre-check for single files/labs).
STATIC_RSYNC="/opt/unetlab/html/import/bin/rsync.amd64-static"
RPATH=""                 # --rsync-path=… when we ship our own (empty otherwise)
SHIPPED_RSYNC=""         # remote temp path to clean up at the end
HAVE_RSYNC=0

if sshpass -e ssh "${SSH_ARGS[@]}" "${RUSER}@${HOST}" 'command -v rsync >/dev/null 2>&1' </dev/null; then
    HAVE_RSYNC=1
else
    RARCH=$(sshpass -e ssh "${SSH_ARGS[@]}" "${RUSER}@${HOST}" 'uname -m' </dev/null | tr -d '\r\n ')
    if [ -s "$STATIC_RSYNC" ] && [ "$RARCH" = "x86_64" ]; then
        REMOTE_RSYNC="/dev/shm/.pnq-rsync.$$"
        if sshpass -e ssh "${SSH_ARGS[@]}" "${RUSER}@${HOST}" \
               "cat > $REMOTE_RSYNC && chmod 755 $REMOTE_RSYNC" < "$STATIC_RSYNC" \
           && sshpass -e ssh "${SSH_ARGS[@]}" "${RUSER}@${HOST}" \
               "$REMOTE_RSYNC --version >/dev/null 2>&1" </dev/null; then
            HAVE_RSYNC=1
            RPATH="--rsync-path=$REMOTE_RSYNC"
            SHIPPED_RSYNC="$REMOTE_RSYNC"
        fi
    fi
fi

# single-quote an argument for the REMOTE shell (paths may contain spaces)
qq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Update the job pct from absolute bytes transferred so far. The bar is
# BYTE-weighted across the whole selection (not item count), so a multi-GB image
# advances the bar continuously instead of leaving it frozen until the file
# finishes. Cap 0..98; 99/100 are reserved for the finalize/done states.
upd_bytes() {
    local p=0
    [ "$TOTAL_BYTES" -gt 0 ] && p=$(( $1 * 100 / TOTAL_BYTES ))
    [ "$p" -lt 0 ] && p=0
    [ "$p" -gt 98 ] && p=98
    upd "running" "$p" "$2"
}

# rsync src->dst with LIVE byte progress folded into the global bar.
# --info=progress2 prints a running "<bytes> <pct>% <rate> <eta>" line (\r-updated);
# tr \r->\n so we read each refresh, first field (commas stripped) = cumulative
# bytes for this transfer. Returns rsync's own exit code (pipefail-safe).
rsync_live() {  # $1 src  $2 dst  $3 item_bytes  $4 label
    local src="$1" dst="$2" size="$3" label="$4"
    sshpass -e rsync -a -s --ignore-existing --info=progress2 $RPATH -e "$SSHOPT" \
        "$src" "$dst" 2>&1 \
      | stdbuf -oL tr '\r' '\n' \
      | while IFS= read -r ln; do
            case "$ln" in
                *%*)
                    b=$(printf '%s' "$ln" | awk '{gsub(/,/,"",$1); if($1~/^[0-9]+$/)print $1}')
                    [ -n "$b" ] || continue
                    [ "$b" -gt "$size" ] 2>/dev/null && b="$size"
                    upd_bytes "$(( DONE_BYTES + b ))" "$label"
                    ;;
            esac
        done
    return "${PIPESTATUS[0]}"
}

# tar-over-ssh fallback (no rsync on either end): no byte stream, so the bar
# advances at item boundaries only (DONE_BYTES jumps after each item).
tar_pull() {  # $1 kind(dir|file|lab)  $2 remote_path  $3 local_dest_dir
    case "$1" in
        dir)  sshpass -e ssh "${SSH_ARGS[@]}" "${RUSER}@${HOST}" \
                  "tar -C $(qq "$(dirname "$2")") -cf - -- $(qq "$(basename "$2")")" </dev/null \
                  | tar -C "$3" --skip-old-files -xf - ;;
        file) [ -e "$3/$(basename "$2")" ] && return 0
              sshpass -e ssh "${SSH_ARGS[@]}" "${RUSER}@${HOST}" \
                  "tar -C $(qq "$(dirname "$2")") -cf - -- $(qq "$(basename "$2")")" </dev/null \
                  | tar -C "$3" --skip-old-files -xf - ;;
        lab)  [ -e "$2" ] && return 0
              sshpass -e ssh "${SSH_ARGS[@]}" "${RUSER}@${HOST}" \
                  "tar -C /opt/unetlab/labs -cf - -- $(qq "${2#/opt/unetlab/labs/}")" </dev/null \
                  | tar -C /opt/unetlab/labs --skip-old-files -xf - ;;
    esac
}

# ── build the transfer plan: kind \t remote_path \t label ────────────────────
PLAN="$WORK/plan"; : > "$PLAN"
if [ -s "$IMGS" ]; then
    while IFS=$'\t' read -r type name; do
        [ -n "$type" ] && [ -n "$name" ] || continue
        case "$type" in
            qemu) printf 'qemu\t%s\t%s\n' "/opt/unetlab/addons/qemu/$name" "qemu/$name" >> "$PLAN" ;;
            iol)  case "$name" in *.bin) ;; *) continue ;; esac
                  printf 'iol\t%s\t%s\n'  "/opt/unetlab/addons/iol/bin/$name" "iol/$name" >> "$PLAN" ;;
        esac
    done < "$IMGS"
fi
if [ -s "$LABS" ]; then
    while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        printf 'lab\t%s\t%s\n' "/opt/unetlab/labs/$rel" "lab: $rel" >> "$PLAN"
    done < "$LABS"
fi

# ── size every item in ONE ssh round-trip (du -sb), aligned to PLAN order ─────
declare -a SIZES=()
if [ -s "$PLAN" ]; then
    mapfile -t SIZES < <(
        cut -f2 "$PLAN" | sshpass -e ssh "${SSH_ARGS[@]}" "${RUSER}@${HOST}" \
            'while IFS= read -r p; do s=$(du -sb "$p" 2>/dev/null | cut -f1); echo "${s:-0}"; done' 2>/dev/null
    )
fi
TOTAL_BYTES=0
for s in "${SIZES[@]}"; do [ "$s" -gt 0 ] 2>/dev/null && TOTAL_BYTES=$(( TOTAL_BYTES + s )); done
# Fallback to equal per-item weighting if remote sizing failed (du missing/airgapped).
WEIGHTED=1
if [ "$TOTAL_BYTES" -le 0 ]; then
    WEIGHTED=0
    NPLAN=$(wc -l < "$PLAN" 2>/dev/null); [ "$NPLAN" -gt 0 ] 2>/dev/null || NPLAN=1
    TOTAL_BYTES="$NPLAN"
fi

DONE_BYTES=0
SKIPPED=()          # items that failed to copy — reported at the end, NOT fatal
upd "running" 0 "starting import"

i=0
while IFS=$'\t' read -r kind rpath label; do
    [ -n "$kind" ] || continue
    if [ "$WEIGHTED" = 1 ]; then sz=${SIZES[$i]:-0}; else sz=1; fi
    i=$((i + 1))
    upd_bytes "$DONE_BYTES" "$label"          # show the item's starting point
    ok=0
    case "$kind" in
        qemu)
            mkdir -p "$rpath"
            if [ "$HAVE_RSYNC" = 1 ]; then
                rsync_live "${RUSER}@${HOST}:$rpath/" "$rpath/" "$sz" "$label" && ok=1
            else
                tar_pull dir "$rpath" "$(dirname "$rpath")" && ok=1
            fi
            ;;
        iol)
            dir="$(dirname "$rpath")"; mkdir -p "$dir"
            if [ "$HAVE_RSYNC" = 1 ]; then
                rsync_live "${RUSER}@${HOST}:$rpath" "$dir/" "$sz" "$label" && ok=1
            else
                tar_pull file "$rpath" "$dir" && ok=1
            fi
            ;;
        lab)
            rel="${rpath#/opt/unetlab/labs/}"; mkdir -p "/opt/unetlab/labs/$(dirname "$rel")"
            if [ "$HAVE_RSYNC" = 1 ]; then
                rsync_live "${RUSER}@${HOST}:$rpath" "$rpath" "$sz" "$label" && ok=1
            else
                tar_pull lab "$rpath" "" && ok=1
            fi
            ;;
    esac
    [ "$ok" = 1 ] || SKIPPED+=("$label")
    DONE_BYTES=$(( DONE_BYTES + sz ))
done < "$PLAN"
rm -f "$PLAN"

rm -f "$IMGS" "$LABS"
# remove our shipped static rsync from the remote tmpfs (best effort)
if [ -n "$SHIPPED_RSYNC" ]; then
    sshpass -e ssh "${SSH_ARGS[@]}" "${RUSER}@${HOST}" "rm -f $SHIPPED_RSYNC" </dev/null 2>/dev/null || true
fi
unset SSHPASS

# Fix ownership/permissions for everything just pulled, and regenerate the
# host-locked IOL license — identical to SystemController::fixPermission().
upd "finalizing" 99 "fixing permissions"
/opt/unetlab/wrappers/unl_wrapper -a fixpermissions >/dev/null 2>&1
if [ -f /opt/unetlab/addons/iol/bin/CiscoIOUKeygen3.py ]; then
    python3 /opt/unetlab/addons/iol/bin/CiscoIOUKeygen3.py >/dev/null 2>&1
fi

if [ "${#SKIPPED[@]}" -gt 0 ]; then
    # Partial success: the import finished (state "done"), but some items could not
    # be copied. List them in a "skipped" array so the UI shows a note instead of
    # treating the whole run as a failure. A single bad file no longer aborts.
    SK_JSON=$(printf '%s\n' "${SKIPPED[@]}" \
        | python3 -c 'import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))')
    N="${#SKIPPED[@]}"
    printf '{"state":"done","pct":100,"msg":"import complete — %s skipped","skipped":%s}\n' "$N" "$SK_JSON" > "$ST"
    chmod 666 "$ST" 2>/dev/null
else
    upd "done" 100 "import complete"
fi
exit 0
