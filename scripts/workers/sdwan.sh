#!/bin/bash
# sdwan/worker.sh — runs the Catalyst SD-WAN control-plane onboarder as root in a
# transient systemd unit (pnet-sdwan-<job>, spawned by the broker):  worker.sh <job>
#
# Reads jobs/<job>.req (JSON: manager_ip/creds, org-name, transport IPs, version,
# optional serial path) and SHREDS it immediately, handing the JSON to the Python
# onboarder over stdin (NOT argv) so the admin password never appears in `ps`. The
# onboarder writes live progress to jobs/<job>.json for the status poll. A
# user-uploaded serial file (jobs/<job>.serial) is shredded once the run ends.
#
# Mirrors html/import/worker.sh (0600 .req + shred + JSON status file).
set -o pipefail

JOB="$1"
BASE="/opt/unetlab/html/sdwan"
ST="$BASE/jobs/${JOB}.json"
REQ="$BASE/jobs/${JOB}.req"
SERIAL="$BASE/jobs/${JOB}.serial"
ONBOARD="/opt/unetlab/scripts/sdwan/sdwan-onboard.py"
SNAPSHOT="/opt/unetlab/scripts/workers/config-snapshot.py"
WORK_ROOT="/run/pnetlab-worker-jobs"
WORK=""

cleanup() {
    unset REQDATA
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

[ -f "$REQ" ] || { upd "error" 0 "request missing"; exit 1; }
command -v python3 >/dev/null 2>&1 || { upd "error" 0 "python3 missing"; rm -f "$REQ" "$SERIAL"; exit 1; }
[ -f "$ONBOARD" ] || { upd "error" 0 "onboarder missing"; rm -f "$REQ" "$SERIAL"; exit 1; }
[ -f "$SNAPSHOT" ] && [ ! -L "$SNAPSHOT" ] || { upd "error" 0 "snapshot helper missing"; exit 1; }

[ -e "$WORK_ROOT" ] || [ -L "$WORK_ROOT" ] \
    || install -d -o root -g root -m 700 "$WORK_ROOT" \
    || { upd "error" 0 "cannot create worker runtime"; exit 1; }
[ -d "$WORK_ROOT" ] && [ ! -L "$WORK_ROOT" ] \
    && [ "$(stat -c '%u:%a' "$WORK_ROOT")" = "0:700" ] \
    || { upd "error" 0 "unsafe worker runtime"; exit 1; }
WORK=$(mktemp -d "$WORK_ROOT/sdwan-${JOB}.XXXXXX") || { upd "error" 0 "cannot create private workspace"; exit 1; }
chmod 700 "$WORK" || { upd "error" 0 "cannot protect private workspace"; exit 1; }
python3 "$SNAPSHOT" --claim --max-bytes 1048576 "$REQ" "$WORK/request.json" \
    || { upd "error" 0 "request snapshot failed"; exit 1; }

# The optional uploaded serial is part of this job's configuration too. Accept
# only the API's exact per-job path, claim it once, and point the private request
# at the claimed snapshot before the long-running onboarder starts.
SERIAL_PRESENT=$(python3 - "$WORK/request.json" "$SERIAL" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    req = json.load(f)
serial = req.get("serial_file")
if serial is None:
    print(0)
elif serial == sys.argv[2]:
    print(1)
else:
    raise SystemExit("unexpected serial_file path")
PY
) || { upd "error" 0 "bad serial configuration"; exit 1; }
if [ "$SERIAL_PRESENT" = 1 ]; then
    python3 "$SNAPSHOT" --claim --max-bytes 1048576 "$SERIAL" "$WORK/serial" \
        || { upd "error" 0 "serial snapshot failed"; exit 1; }
fi
python3 - "$WORK/request.json" "$WORK/request.final.json" "$SERIAL_PRESENT" "$WORK/serial" <<'PY'
import json, os, sys
with open(sys.argv[1]) as f:
    req = json.load(f)
if sys.argv[3] == "1":
    req["serial_file"] = sys.argv[4]
with open(sys.argv[2], "x") as f:
    os.chmod(sys.argv[2], 0o600)
    json.dump(req, f, separators=(",", ":"))
PY
if [ "$?" -ne 0 ]; then
    upd "error" 0 "cannot derive private request"
    exit 1
fi
shred -u "$WORK/request.json" 2>/dev/null || rm -f "$WORK/request.json"

upd "running" 1 "starting onboarder"

# Read the credentials once, destroy the on-disk copy immediately, then feed the
# JSON to the onboarder via stdin (--req /dev/stdin). Nothing sensitive on argv.
REQDATA="$(cat "$WORK/request.final.json")" \
    || { upd "error" 0 "cannot read private request"; exit 1; }
shred -u "$WORK/request.final.json" 2>/dev/null || rm -f "$WORK/request.final.json"

printf '%s' "$REQDATA" | python3 "$ONBOARD" --req /dev/stdin --progress "$ST"
rc=$?
unset REQDATA

# The private serial snapshot is shredded by the EXIT cleanup after the run.

# Safety net: if the onboarder died without writing a terminal state, mark error.
# NOTE: the onboarder writes JSON with spaces ("state": "error"), so the check must
# tolerate the optional space — otherwise it clobbers the real error message.
if [ "$rc" -ne 0 ]; then
    if ! grep -qE '"state": ?"(done|error)"' "$ST" 2>/dev/null; then
        upd "error" 0 "onboarder exited rc=${rc}"
    fi
fi
exit 0
