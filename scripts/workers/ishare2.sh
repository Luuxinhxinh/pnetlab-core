#!/bin/bash
# worker.sh — downloads + installs one image from the labhub.json catalog.
# Invoked (as root, via sudo) by api.php:  worker.sh <type> <id> <job>
# Writes live progress to  $BASE/jobs/<job>.json  for the status endpoint.
set -o pipefail

TYPE="$1"; ID="$2"; JOB="$3"; ACTION="${4:-download}"
BASE="/opt/unetlab/html/ishare2"
CAT="$BASE/labhub.json"
ST="$BASE/jobs/${JOB}.json"
SNAPSHOT="/opt/unetlab/scripts/workers/config-snapshot.py"
WORK_ROOT="/run/pnetlab-worker-jobs"
WORK=""
ENTRY=""
TMP=""

cleanup() {
    [ -z "$TMP" ] || rm -rf -- "$TMP"
    [ -z "$WORK" ] || rm -rf -- "$WORK"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# state pct msg
upd() {
    printf '{"state":"%s","pct":%s,"msg":"%s","type":"%s","id":"%s"}\n' \
        "$1" "$2" "${3//\"/}" "$TYPE" "$ID" > "$ST"
    chmod 666 "$ST" 2>/dev/null
}
fail() { upd "error" 0 "$1"; exit 1; }

[ -f "$CAT" ] || fail "catalog missing"
command -v python3 >/dev/null 2>&1 || fail "python3 missing"
[ -f "$SNAPSHOT" ] && [ ! -L "$SNAPSHOT" ] || fail "snapshot helper missing"

# All reads below use one private catalog snapshot. A concurrent catalog update
# therefore affects the next job only; this job cannot combine URL properties
# from one version with an image entry from another.
[ -e "$WORK_ROOT" ] || [ -L "$WORK_ROOT" ] \
    || install -d -o root -g root -m 700 "$WORK_ROOT" \
    || fail "cannot create worker runtime"
[ -d "$WORK_ROOT" ] && [ ! -L "$WORK_ROOT" ] \
    && [ "$(stat -c '%u:%a' "$WORK_ROOT")" = "0:700" ] \
    || fail "unsafe worker runtime"
WORK=$(mktemp -d "$WORK_ROOT/ishare2-${JOB}.XXXXXX") || fail "cannot create private workspace"
chmod 700 "$WORK" || fail "cannot protect private workspace"
python3 "$SNAPSHOT" --max-bytes 16777216 "$CAT" "$WORK/catalog.json" \
    || fail "catalog snapshot failed"
CAT="$WORK/catalog.json"
ENTRY="$WORK/entry"

case "$TYPE" in
    qemu) KEY=QEMU ;; iol) KEY=IOL ;; dynamips) KEY=DYNAMIPS ;; *) fail "bad type" ;;
esac

# URL base from url_properties (main mirror)
read -r PROTO HOST PREFIX < <(python3 - "$CAT" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); up=d["url_properties"]
print(up["protocol"], up["hostnames"]["main"], up["prefixes"]["main"])
PY
)
[ -n "$HOST" ] || fail "bad catalog url_properties"

# entry -> tab-separated lines: INSTALL / TOTAL / FILE<path,filename,size>
python3 - "$CAT" "$KEY" "$ID" > "$ENTRY" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); key=sys.argv[2]; eid=int(sys.argv[3])
e=next((x for x in d[key] if int(x["id"])==eid), None)
if not e: sys.exit(3)
print("INSTALL\t"+e["metadata"]["install_path"])
print("TOTAL\t"+str(e["metadata"].get("total_size",0)))
for f in e["files"]:
    print("FILE\t"+f["path"]+"\t"+f["filename"]+"\t"+str(f.get("size",0)))
PY
[ $? -eq 0 ] || fail "image id $ID not found"

INSTALL=$(awk -F'\t' '$1=="INSTALL"{print $2}' "$ENTRY")
TOTAL=$(awk  -F'\t' '$1=="TOTAL"{print $2}'   "$ENTRY")
[ -n "$INSTALL" ] || fail "no install path"
[ "${TOTAL:-0}" -gt 0 ] 2>/dev/null || TOTAL=0

# Normalise Linux orphans (alpine-*, ...) to the EVE-NG linux-<name> folder so
# the image maps to the `linux` (vnc) template. Uses the SAME php helper api.php
# uses, so placement here matches the install-state the image store shows.
if [ "$TYPE" = "qemu" ] && command -v php >/dev/null 2>&1 && [ -f "$BASE/image_normalize.php" ]; then
    _ibase=$(basename "${INSTALL%/}")
    _inorm=$(php "$BASE/image_normalize.php" "$_ibase" 2>/dev/null)
    if [ -n "$_inorm" ] && [ "$_inorm" != "$_ibase" ]; then
        INSTALL="$(dirname "${INSTALL%/}")/$_inorm/"
    fi
fi

# ── delete mode: remove the installed files, then fix permissions ────────────
if [ "$ACTION" = "delete" ]; then
    upd "deleting" 40 "removing files"
    case "$TYPE" in
        iol)
            while IFS=$'\t' read -r tag path filename fsize; do
                [ "$tag" = "FILE" ] && rm -f "/opt/unetlab/addons/iol/bin/$filename"
            done < "$ENTRY" ;;
        dynamips)
            while IFS=$'\t' read -r tag path filename fsize; do
                [ "$tag" = "FILE" ] && rm -f "/opt/unetlab/addons/dynamips/$filename"
            done < "$ENTRY" ;;
        qemu)
            # only ever delete inside the qemu addon tree (guard against a bad catalog)
            case "$INSTALL" in
                /opt/unetlab/addons/qemu/*/) rm -rf "$INSTALL" ;;
                /opt/unetlab/addons/qemu/*)  rm -rf "$INSTALL" ;;
                *) fail "refusing to delete unexpected path" ;;
            esac ;;
    esac
    upd "deleting" 80 "fixing permissions"
    /opt/unetlab/wrappers/unl_wrapper -a fixpermissions >/dev/null 2>&1
    rm -f "$ENTRY"
    upd "removed" 100 "removed"
    exit 0
fi

# scratch dir (prefer the big disk, not tmpfs)
TMP=$(mktemp -d /opt/unetlab/tmp/ishare2.XXXXXX 2>/dev/null) || TMP=$(mktemp -d)

upd "downloading" 0 "starting download"
DLBYTES=0
while IFS=$'\t' read -r tag path filename fsize; do
    [ "$tag" = "FILE" ] || continue
    URL="${PROTO}://${HOST}${PREFIX}${path}"
    OUT="$TMP/$filename"
    curl -sSL --fail --connect-timeout 20 --retry 2 --retry-delay 3 "$URL" -o "$OUT" &
    CPID=$!
    while kill -0 "$CPID" 2>/dev/null; do
        if [ -f "$OUT" ] && [ "$TOTAL" -gt 0 ]; then
            cur=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
            pct=$(( (DLBYTES + cur) * 100 / TOTAL ))
            [ "$pct" -gt 99 ] && pct=99
            upd "downloading" "$pct" "$filename"
        fi
        sleep 1
    done
    wait "$CPID" || fail "download failed: $filename"
    cur=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
    DLBYTES=$(( DLBYTES + cur ))
done < "$ENTRY"

upd "installing" 99 "placing files"
case "$TYPE" in
    iol)
        mkdir -p /opt/unetlab/addons/iol/bin
        cp "$TMP"/* /opt/unetlab/addons/iol/bin/ || fail "copy failed" ;;
    dynamips)
        mkdir -p /opt/unetlab/addons/dynamips
        cp "$TMP"/* /opt/unetlab/addons/dynamips/ || fail "copy failed" ;;
    qemu)
        mkdir -p "$INSTALL"
        for f in "$TMP"/*; do
            case "$f" in
                *.tgz|*.tar.gz) tar -xzf "$f" -C "$INSTALL" || fail "extract failed" ;;
                *.tar)          tar -xf  "$f" -C "$INSTALL" || fail "extract failed" ;;
                *.zip)          unzip -o "$f" -d "$INSTALL" >/dev/null || fail "unzip failed" ;;
                *)              cp "$f" "$INSTALL/" || fail "copy failed" ;;
            esac
        done
        # flatten a single nested folder (archive contained one wrapper dir)
        shopt -s nullglob
        qcows=("$INSTALL"/*.qcow2); subdirs=("$INSTALL"/*/)
        if [ ${#qcows[@]} -eq 0 ] && [ ${#subdirs[@]} -eq 1 ]; then
            mv "${subdirs[0]}"* "$INSTALL"/ 2>/dev/null
            rmdir "${subdirs[0]}" 2>/dev/null
        fi ;;
esac

# Verify the files actually landed at their destination BEFORE fixing perms.
verify_landed() {
    while IFS=$'\t' read -r tag path filename fsize; do
        [ "$tag" = "FILE" ] || continue
        case "$TYPE" in
            iol)      [ -s "/opt/unetlab/addons/iol/bin/$filename" ]      || return 1 ;;
            dynamips) [ -s "/opt/unetlab/addons/dynamips/$filename" ]      || return 1 ;;
        esac
    done < "$ENTRY"
    # qemu: extracted filenames are unknown — just require a non-empty install dir
    if [ "$TYPE" = "qemu" ]; then
        [ -d "$INSTALL" ] && [ -n "$(ls -A "$INSTALL" 2>/dev/null)" ] || return 1
    fi
    return 0
}
verify_landed || fail "install incomplete — files missing after copy"

# Fix permissions and only report "installed" once it has fully completed.
upd "finalizing" 99 "fixing permissions"
/opt/unetlab/wrappers/unl_wrapper -a fixpermissions >/dev/null 2>&1
# fixpermissions runs synchronously; re-verify the files survived it
verify_landed || fail "files missing after permission fix"
upd "done" 100 "installed"
