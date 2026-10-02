#!/usr/bin/env python3
# pnet_showmany — parallel fan-out of read-only `show` console reads for the
# Topology Overlays endpoint. Sequential per-node gathers are slow (one telnet
# session at a time x N nodes); this runs the nodes CONCURRENTLY so total time is
# ~one node's read instead of the sum.
#
# Reads a JSON job list on stdin:
#   [{"key":"17","host":"127.0.0.1","port":30045,
#     "cmds":["show cdp neighbors detail","show ip cef 1.1.1.1/32"]}]
# and prints {"<key>": {"<cmd>": {"raw": "...", "error": "..."}}}.
#
# CONCURRENCY MODEL: different nodes run in parallel (thread pool); commands for
# the SAME node run SEQUENTIALLY — a node's serial console is single-client, so
# two simultaneous reads to one port would collide.
#
# Read-only + unprivileged: a node's reads run in ONE pnet-showcmd.py subprocess
# (via --cmds), which logs in once and runs every show in the same session — so the
# telnet login (the dominant cost) is paid once per node, not once per command.
# pnet-showcmd refuses anything that isn't `show ...`; telnet to a local console
# port needs no root, so the web tier can run this directly (no broker round-trip).

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
SHOWCMD = os.path.join(HERE, "pnet-showcmd.py")


def _node(job):
    host = job.get("host", "127.0.0.1")
    port = job["port"]
    cmds = list(job.get("cmds", []))
    # one login covers all of a node's reads, but allow more wall-clock when a node
    # has several commands queued (login + N sequential reads in the same session).
    timeout = max(int(job.get("timeout", 60)), 25 + 12 * len(cmds))
    if not cmds:
        return str(job["key"]), {}
    try:
        r = subprocess.run(
            ["python3", SHOWCMD, "--host", str(host), "--port", str(port),
             "--cmds", json.dumps(cmds)],
            capture_output=True, text=True, timeout=timeout)
        d = json.loads(r.stdout or "{}")
        res = d.get("results")
        if not isinstance(res, dict):
            err = d.get("error", "") or "no output"
            return str(job["key"]), {c: {"raw": "", "error": err} for c in cmds}
        out = {}
        for c in cmds:
            rc = res.get(c) if isinstance(res.get(c), dict) else {}
            out[c] = {"raw": rc.get("raw", ""), "error": rc.get("error", "")}
        return str(job["key"]), out
    except subprocess.TimeoutExpired:
        return str(job["key"]), {c: {"raw": "", "error": "timeout"} for c in cmds}
    except Exception as e:                                  # noqa: BLE001
        return str(job["key"]), {c: {"raw": "", "error": str(e)} for c in cmds}


def main():
    try:
        jobs = json.load(sys.stdin)
    except Exception as e:                                  # noqa: BLE001
        print(json.dumps({"error": "bad job list: %s" % e}))
        return 2
    if not isinstance(jobs, list) or not jobs:
        print(json.dumps({}))
        return 0
    result = {}
    with ThreadPoolExecutor(max_workers=min(len(jobs), 24)) as ex:
        for key, res in ex.map(_node, jobs):
            result[key] = res
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
