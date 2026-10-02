#!/usr/bin/env python3
"""airduct-pos-sync.py — feed REAL PNetLab canvas positions to the airhandler, per-lab OPT-IN.

The airhandler (airhandler.py, AIRHANDLER_RF=1) applies a log-distance path-loss model
to the airduct RF medium, reading each session's node canvas coords from
  /opt/unetlab/tmp/<session>/airduct-pos.json = {"<runtime_id>": [left, top], ...}
and FAILING OPEN (deliver, no loss) for any link whose endpoints lack a position.

OPT-IN gate (the front door is the Wi-Fi Painter's "Distance roaming (RF)" toggle):
pnq-wifi.php drops a marker  /opt/unetlab/tmp/<session>/airduct-rf  when RF is turned
ON for a lab and removes it when turned OFF. This script emits airduct-pos.json ONLY
for sessions that carry the marker, and DELETES a stale pos file for any session that
does not. So distance-loss + graded overlays apply ONLY to labs the user opted in;
every other lab stays pure passthrough via the airhandler's fail-open.

Id mapping: PNetLab runs each .unl node under a RUNTIME id
(node_sessions.node_session_id == the /opt/unetlab/tmp/<session>/<id> dir == the
airhandler's node key), distinct from the .unl lab-local id (node_session_nid). Canvas
left/top live in the .unl keyed by the lab-local id. We join
  node_sessions(node_session_id, node_session_nid, node_session_lab, node_session_running)
  lab_sessions(lab_session_id -> lab_session_path)   # the session's .unl
  .unl <node id=nid left top>                          # canvas coords
and key the output by the RUNTIME id. (Kept here, not in pnq-wifi.php, so the PHP hook
stays a one-line marker touch.)

Run once (default) or as a 5s loop (--loop, the shipped systemd service) so a live
canvas drag — persisted to the .unl by the GUI's node-move — is reflected within 5s.
"""
import json, os, re, subprocess, sys, time, xml.etree.ElementTree as ET

BASE_LAB = "/opt/unetlab/labs"
TMP = "/opt/unetlab/tmp"
CNF = "/etc/mysql/debian.cnf"
INTERVAL = 5.0


def q(sql):
    r = subprocess.run(["mysql", "--defaults-file=" + CNF, "-N", "-e", sql],
                       capture_output=True, text=True)
    return [ln.split("\t") for ln in r.stdout.splitlines() if ln.strip()]


def lab_paths():
    d = {}
    for row in q("SELECT lab_session_id, lab_session_path FROM pnetlab_db.lab_sessions;"):
        if len(row) >= 2:
            d[row[0].strip()] = row[1].strip()
    return d


def running_nodes():
    rows = q("SELECT node_session_id, node_session_nid, node_session_lab "
             "FROM pnetlab_db.node_sessions WHERE node_session_running=1;")
    return [(r[0].strip(), r[1].strip(), r[2].strip()) for r in rows if len(r) >= 3]


def unl_positions(unl_path):
    pos = {}
    try:
        for node in ET.parse(unl_path).iter("node"):
            nid, l, t = node.get("id"), node.get("left"), node.get("top")
            if nid and l is not None and t is not None:
                try:
                    pos[str(nid)] = [float(l), float(t)]
                except ValueError:
                    pass
    except Exception:
        try:
            data = open(unl_path, "rb").read().decode("utf-8", "replace")
        except Exception:
            return pos
        for m in re.finditer(r'<node\b[^>]*>', data):
            tag = m.group(0)
            i = re.search(r'\bid="(\d+)"', tag)
            l = re.search(r'\bleft="([0-9.]+)"', tag)
            t = re.search(r'\btop="([0-9.]+)"', tag)
            if i and l and t:
                pos[i.group(1)] = [float(l.group(1)), float(t.group(1))]
    return pos


def opted_in(session):
    return os.path.exists(os.path.join(TMP, str(session), "airduct-rf"))


def sweep(dry=False):
    paths = lab_paths()
    unl_cache = {}
    per_session = {}
    for rid, nid, sess in running_nodes():
        if not opted_in(sess):
            continue                      # not opted in -> no pos file (fail-open)
        rel = paths.get(sess)
        if not rel:
            continue
        unl = os.path.normpath(BASE_LAB + "/" + rel.lstrip("/"))
        if unl not in unl_cache:
            unl_cache[unl] = unl_positions(unl) if os.path.isfile(unl) else {}
        xy = unl_cache[unl].get(str(nid))
        if xy is None:
            continue
        per_session.setdefault(sess, {})[str(rid)] = xy

    # Write pos files for opted-in sessions; remove stale ones everywhere else.
    for entry in os.listdir(TMP) if os.path.isdir(TMP) else []:
        sess_dir = os.path.join(TMP, entry)
        if not os.path.isdir(sess_dir):
            continue
        dst = os.path.join(sess_dir, "airduct-pos.json")
        if entry in per_session:
            payload = json.dumps(per_session[entry])
            if dry:
                print("KEEP  session %s -> %s : %s" % (entry, dst, payload))
                continue
            tmp = dst + ".tmp"
            with open(tmp, "w") as f:
                f.write(payload)
            os.replace(tmp, dst)
        elif os.path.exists(dst):
            if dry:
                print("PRUNE session %s -> rm %s (not opted in)" % (entry, dst))
            else:
                try:
                    os.unlink(dst)
                except OSError:
                    pass


def main():
    dry = "--dry-run" in sys.argv
    if "--loop" in sys.argv:
        while True:
            try:
                sweep(dry)
            except Exception as e:
                sys.stderr.write("[airduct-pos-sync] %s\n" % e)
            time.sleep(INTERVAL)
    else:
        sweep(dry)


if __name__ == "__main__":
    main()
