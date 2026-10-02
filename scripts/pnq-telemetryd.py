#!/usr/bin/env python3
"""pnq-telemetryd — PNetLab historical telemetry collector (root systemd daemon).

Samples host + per-node CPU/RAM into a small on-disk SQLite store that the
dashboard History view (/main/#/history via status/api.php?action=history_*)
and the lab-canvas per-node graph panel (pnq-telemetry.php) read READONLY.

CPU% METHOD — /proc delta, NOT top (documented deliberately):
  The live Nodes-modal numbers (pnq-nodestats.php) come from `top -b -n2`,
  whose per-process %CPU is top's own 0.5s-window sample. THIS daemon instead
  computes CPU% from /proc deltas over its own sampling window:
    host:      100 * (Δbusy / Δtotal) from /proc/stat line "cpu" (busy =
               total - idle - iowait), i.e. percent of ALL cores combined,
               0..100 — same normalization the System gauges use.
    per-node:  100 * ((Δutime+Δstime)/CLK_TCK) / Δwall  from /proc/<pid>/stat,
               i.e. percent of ONE core; a multi-vCPU qemu node can exceed 100.
               This matches top's Irix-mode per-process convention, but the
               window is our 30s cycle, so short spikes average out — history
               numbers are smoother than the live modal's. Docker nodes use
               `docker stats` CPUPerc (same one-core convention).
  Feature 5's per-node panel consumes THESE numbers via pnq-telemetry.php, so
  the history view and the node panel share one CPU definition. Only the
  legacy live modal keeps top's instantaneous flavor.

Node discovery (fresh implementation — verb_nodestats has no reusable logic,
it just shells to pnq-nodestats.sh which is top+ps based):
  node_sessions (mysql) gives (lab_session_id=node_session_lab, nid, type,
  workspace, host). QEMU/IOL processes chdir into their workspace under
  /opt/unetlab/tmp/<pod>/<lab>/<sid>, so workspace -> pid comes from a root
  walk of /proc/<pid>/cwd; among the pids sharing a workspace cwd (node proc +
  wrapper/sh/nc helpers) the largest-RSS pid is the node. Docker nodes are
  containers named docker<node_session_id>, sampled with ONE
  `docker stats --no-stream` call. Satellite-hosted nodes (node_session_host
  != 0) are SKIPPED in v1 (silent degrade; satellite series is a follow-up).

MySQL creds: NO new creds file. As root we use the appliance's established
password-free paths: `mysql` with HOME=/root (reads /root/.my.cnf — the same
mechanism brokerd's factory path relies on), falling back to
--defaults-file=/etc/mysql/debian.cnf (the airduct-pos-sync mechanism).

Store: /opt/unetlab/data/telemetry/telemetry.db
  sys_raw  every 10s, kept 3h      node_raw every 30s, kept 2h
  sys_5m   rollup,    kept 90d     node_5m  rollup,    kept 14d
  Hard cap 50MB (oldest 5m rows deleted first). journal_mode=DELETE,
  synchronous=NORMAL, auto_vacuum=INCREMENTAL, busy_timeout on the writer
  (readers set their own); each cycle commits in ONE transaction.
Units: mem/swap/disk in MB, cpu in percent, ts epoch seconds.
"""

import os
import sqlite3
import subprocess
import sys
import time

DB_DIR = "/opt/unetlab/data/telemetry"
DB_PATH = DB_DIR + "/telemetry.db"
TMP_PREFIX = "/opt/unetlab/tmp/"

HOST_EVERY = 10        # s
NODE_EVERY = 30        # s
ROLLUP_EVERY = 300     # s
PRUNE_EVERY = 3600     # s

RET_SYS_RAW = 3 * 3600
RET_NODE_RAW = 2 * 3600
RET_SYS_5M = 90 * 86400
RET_NODE_5M = 14 * 86400
DB_CAP_BYTES = 50 * 1024 * 1024

CLK_TCK = os.sysconf("SC_CLK_TCK")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sys_raw  (ts INT PRIMARY KEY, cpu REAL, ram_used INT, ram_total INT,
                                     swap_used INT, swap_total INT, disk_used INT, disk_total INT, load1 REAL);
CREATE TABLE IF NOT EXISTS node_raw (ts INT, lab INT, nid INT, type TEXT, cpu REAL, mem_mb INT,
                                     PRIMARY KEY (ts, lab, nid));
CREATE TABLE IF NOT EXISTS sys_5m   (ts INT PRIMARY KEY, cpu_avg REAL, cpu_max REAL, ram_used INT, ram_total INT,
                                     swap_used INT, disk_used INT, disk_total INT);
CREATE TABLE IF NOT EXISTS node_5m  (ts INT, lab INT, nid INT, type TEXT, cpu_avg REAL, cpu_max REAL,
                                     mem_avg INT, mem_max INT, PRIMARY KEY (ts, lab, nid));
CREATE TABLE IF NOT EXISTS meta     (k TEXT PRIMARY KEY, v TEXT);
"""


def log(msg):
    sys.stderr.write("pnq-telemetryd: %s\n" % msg)
    sys.stderr.flush()


# ---------------------------------------------------------------- db ----------
def open_db():
    os.makedirs(DB_DIR, mode=0o755, exist_ok=True)
    # isolation_level=None = autocommit; we drive BEGIN/COMMIT explicitly so
    # each sampling cycle is exactly ONE short write transaction.
    db = sqlite3.connect(DB_PATH, timeout=5, isolation_level=None)
    db.execute("PRAGMA busy_timeout=3000")
    db.execute("PRAGMA journal_mode=DELETE")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA auto_vacuum=INCREMENTAL")
    db.executescript(SCHEMA)
    db.execute("INSERT OR IGNORE INTO meta VALUES ('schema_version','1')")
    db.commit()
    try:
        os.chmod(DB_PATH, 0o644)   # readers (www-data) open READONLY
    except OSError:
        pass
    return db


# ------------------------------------------------------------- host -----------
def read_proc_stat():
    with open("/proc/stat") as f:
        for line in f:
            if line.startswith("cpu "):
                v = [int(x) for x in line.split()[1:]]
                total = sum(v)
                idle = v[3] + (v[4] if len(v) > 4 else 0)   # idle + iowait
                return total, idle
    return 0, 0


def read_meminfo():
    m = {}
    with open("/proc/meminfo") as f:
        for line in f:
            p = line.split()
            if len(p) >= 2:
                m[p[0].rstrip(":")] = int(p[1])   # kB
    ram_total = m.get("MemTotal", 0) // 1024
    ram_used = (m.get("MemTotal", 0) - m.get("MemAvailable", 0)) // 1024
    swap_total = m.get("SwapTotal", 0) // 1024
    swap_used = (m.get("SwapTotal", 0) - m.get("SwapFree", 0)) // 1024
    return ram_used, ram_total, swap_used, swap_total


def read_disk():
    st = os.statvfs("/")
    total = st.f_blocks * st.f_frsize // (1024 * 1024)
    used = (st.f_blocks - st.f_bfree) * st.f_frsize // (1024 * 1024)
    return used, total


# ------------------------------------------------------------- mysql ----------
def mysql_query(sql):
    """Password-free root mysql (see header). Returns list of tab-split rows,
    or None when mysql is unreachable (pre-migration boot etc.)."""
    env = dict(os.environ)
    env["HOME"] = "/root"
    attempts = [
        ["mysql", "-N", "-B", "pnetlab_db", "-e", sql],
        ["mysql", "--defaults-file=/etc/mysql/debian.cnf", "-N", "-B",
         "pnetlab_db", "-e", sql],
    ]
    for cmd in attempts:
        try:
            p = subprocess.run(cmd, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env=env, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if p.returncode == 0:
            out = p.stdout.decode(errors="replace")
            return [r.split("\t") for r in out.splitlines() if r]
    return None


def list_nodes():
    """[(lab, nid, sid, type, workspace)] for master-host node sessions."""
    rows = mysql_query(
        "SELECT node_session_lab, node_session_nid, node_session_id, "
        "node_session_type, node_session_workspace, "
        "COALESCE(node_session_host,0) FROM node_sessions")
    if rows is None:
        return []
    out = []
    for r in rows:
        if len(r) < 6:
            continue
        try:
            lab, nid, host = int(r[0]), int(r[1]), int(r[5])
        except ValueError:
            continue
        if host != 0:
            continue        # satellite-hosted: v1 skip (silent)
        out.append((lab, nid, r[2], r[3], r[4].rstrip("/")))
    return out


# ------------------------------------------------------------- nodes ----------
def scan_workspaces():
    """cwd walk: workspace-path -> [(pid, rss_mb, cpu_ticks)]."""
    ws = {}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        base = "/proc/" + d
        try:
            cwd = os.readlink(base + "/cwd")
        except OSError:
            continue
        if not cwd.startswith(TMP_PREFIX):
            continue
        try:
            with open(base + "/stat") as f:
                st = f.read()
            # comm can contain spaces/parens: split after last ')'
            fields = st[st.rfind(")") + 2:].split()
            ticks = int(fields[11]) + int(fields[12])   # utime+stime (14,15)
            rss_mb = 0
            with open(base + "/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss_mb = int(line.split()[1]) // 1024
                        break
        except (OSError, IndexError, ValueError):
            continue
        ws.setdefault(cwd.rstrip("/"), []).append((int(d), rss_mb, ticks))
    return ws


def docker_stats():
    """One docker stats pass: container-name -> (cpu_pct, mem_mb)."""
    try:
        p = subprocess.run(
            ["docker", "stats", "--no-stream", "--format",
             "{{.Name}};{{.CPUPerc}};{{.MemUsage}}"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=25)
    except (OSError, subprocess.TimeoutExpired):
        return {}
    out = {}
    for line in p.stdout.decode(errors="replace").splitlines():
        c = line.split(";")
        if len(c) < 3:
            continue
        try:
            cpu = float(c[1].replace("%", "").replace(",", "."))
        except ValueError:
            cpu = 0.0
        mem = 0
        part = c[2].split("/")[0].strip()
        try:
            num = float("".join(ch for ch in part if ch.isdigit() or ch == "."))
            unit = part.lstrip("0123456789. ").upper()[:1]
            if unit == "G":
                mem = int(num * 1024)
            elif unit == "K":
                mem = int(num / 1024)
            elif unit == "B":
                mem = int(num / (1024 * 1024))
            else:
                mem = int(num)          # MiB/MB
        except ValueError:
            pass
        out[c[0].strip()] = (cpu, mem)
    return out


# ------------------------------------------------------------- rollup ---------
def rollup(db, now):
    cur = db.execute("SELECT v FROM meta WHERE k='last_rollup'").fetchone()
    last = int(cur[0]) if cur else 0
    # roll only COMPLETE 5-min buckets
    upto = (now // 300) * 300
    if upto <= last:
        return
    db.execute("BEGIN")
    db.execute(
        "INSERT OR REPLACE INTO sys_5m "
        "SELECT (ts/300)*300, AVG(cpu), MAX(cpu), CAST(AVG(ram_used) AS INT), MAX(ram_total),"
        " CAST(AVG(swap_used) AS INT), MAX(disk_used), MAX(disk_total) "
        "FROM sys_raw WHERE ts >= ? AND ts < ? GROUP BY ts/300", (last, upto))
    db.execute(
        "INSERT OR REPLACE INTO node_5m "
        "SELECT (ts/300)*300, lab, nid, MAX(type), AVG(cpu), MAX(cpu),"
        " CAST(AVG(mem_mb) AS INT), MAX(mem_mb) "
        "FROM node_raw WHERE ts >= ? AND ts < ? GROUP BY ts/300, lab, nid",
        (last, upto))
    db.execute("INSERT OR REPLACE INTO meta VALUES ('last_rollup', ?)",
               (str(upto),))
    db.commit()


def prune(db, now):
    db.execute("BEGIN")
    db.execute("DELETE FROM sys_raw  WHERE ts < ?", (now - RET_SYS_RAW,))
    db.execute("DELETE FROM node_raw WHERE ts < ?", (now - RET_NODE_RAW,))
    db.execute("DELETE FROM sys_5m   WHERE ts < ?", (now - RET_SYS_5M,))
    db.execute("DELETE FROM node_5m  WHERE ts < ?", (now - RET_NODE_5M,))
    db.commit()
    # 50MB hard cap: drop oldest 5m rows first, then oldest raw
    for _ in range(20):
        try:
            if os.path.getsize(DB_PATH) <= DB_CAP_BYTES:
                break
        except OSError:
            break
        db.execute("BEGIN")
        for tbl in ("node_5m", "sys_5m", "node_raw", "sys_raw"):
            r = db.execute("SELECT MIN(ts) FROM " + tbl).fetchone()
            if r and r[0] is not None:
                db.execute("DELETE FROM %s WHERE ts < ?" % tbl,
                           (r[0] + 86400,))
                break
        db.commit()
        db.execute("PRAGMA incremental_vacuum")
        db.commit()


# ------------------------------------------------------------- main -----------
def main():
    db = open_db()
    prev_total, prev_idle = read_proc_stat()
    prev_node = {}                 # (lab,nid) -> (pid, ticks, mono)
    last_node = last_rollup = last_prune = 0.0
    log("started (db=%s)" % DB_PATH)

    while True:
        time.sleep(HOST_EVERY)
        now = int(time.time())
        mono = time.monotonic()

        try:
            # ---- host sample (every cycle) ----
            total, idle = read_proc_stat()
            dt_total, dt_idle = total - prev_total, idle - prev_idle
            prev_total, prev_idle = total, idle
            cpu = 0.0
            if dt_total > 0:
                cpu = max(0.0, min(100.0, 100.0 * (dt_total - dt_idle) / dt_total))
            ram_u, ram_t, sw_u, sw_t = read_meminfo()
            dk_u, dk_t = read_disk()
            load1 = os.getloadavg()[0]

            node_rows = []
            if mono - last_node >= NODE_EVERY - 1:
                last_node = mono
                nodes = list_nodes()
                if nodes:
                    ws = scan_workspaces()
                    dock = None
                    seen = set()
                    for lab, nid, sid, typ, wsp in nodes:
                        seen.add((lab, nid))
                        if typ == "docker":
                            if dock is None:
                                dock = docker_stats()
                            d = dock.get("docker" + str(sid))
                            if d:
                                node_rows.append((now, lab, nid, typ, round(d[0], 1), d[1]))
                            continue
                        pids = ws.get(wsp)
                        if not pids:
                            # fallback: cwd ending in /<sid> (mirror nodestats.php)
                            suf = "/" + str(sid)
                            for path, plist in ws.items():
                                if path.endswith(suf):
                                    pids = plist
                                    break
                        if not pids:
                            prev_node.pop((lab, nid), None)
                            continue
                        pid, rss, ticks = max(pids, key=lambda p: p[1])
                        pcpu = None
                        pv = prev_node.get((lab, nid))
                        if pv and pv[0] == pid and mono > pv[2]:
                            pcpu = 100.0 * ((ticks - pv[1]) / CLK_TCK) / (mono - pv[2])
                            pcpu = max(0.0, round(pcpu, 1))
                        prev_node[(lab, nid)] = (pid, ticks, mono)
                        if pcpu is not None:
                            node_rows.append((now, lab, nid, typ, pcpu, rss))
                    # drop delta state for vanished nodes
                    for k in list(prev_node):
                        if k not in seen:
                            del prev_node[k]
                else:
                    prev_node.clear()

            # ---- one write txn per cycle ----
            db.execute("BEGIN")
            db.execute("INSERT OR REPLACE INTO sys_raw VALUES (?,?,?,?,?,?,?,?,?)",
                       (now, round(cpu, 1), ram_u, ram_t, sw_u, sw_t,
                        dk_u, dk_t, round(load1, 2)))
            if node_rows:
                db.executemany(
                    "INSERT OR REPLACE INTO node_raw VALUES (?,?,?,?,?,?)",
                    node_rows)
            db.commit()

            if mono - last_rollup >= ROLLUP_EVERY:
                last_rollup = mono
                rollup(db, now)
            if mono - last_prune >= PRUNE_EVERY:
                last_prune = mono
                prune(db, now)
        except sqlite3.Error as e:
            log("sqlite error: %s" % e)
            try:
                db.rollback()
            except sqlite3.Error:
                pass
        except Exception as e:                       # never die on a bad sample
            log("sample error: %r" % e)


if __name__ == "__main__":
    main()
