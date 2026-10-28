#!/usr/bin/env python3
"""
simulate_resource_incident.py — Test helper to verify PNetLab Resource Guard
Inserts a test incident snapshot into `resource_incidents` table using current active node data.
"""
import json
import os
import subprocess
import time

def run_query(sql):
    cmd = ["mysql", "-N", "-B", "pnetlab_db", "-e", sql]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return p.stdout.strip()

def main():
    print("Testing Resource Guard Incident Recording...")

    # Ensure table exists
    create_sql = """
    CREATE TABLE IF NOT EXISTS `resource_incidents` (
        `id` BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        `created_at` INT UNSIGNED NOT NULL,
        `server_cpu` FLOAT NOT NULL DEFAULT 0,
        `server_ram` FLOAT NOT NULL DEFAULT 0,
        `top_users` TEXT NOT NULL,
        `total_nodes` INT NOT NULL DEFAULT 0,
        `severity` VARCHAR(16) NOT NULL DEFAULT 'warning',
        INDEX `idx_created_at` (`created_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """
    run_query(create_sql)

    # Fetch users & lab sessions
    users_raw = run_query("SELECT pod, username, email FROM users")
    users = {}
    for line in users_raw.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            users[parts[0]] = parts[1]

    labs_raw = run_query("SELECT lab_session_id, lab_session_pod, lab_session_path FROM lab_sessions")
    lab_to_pod = {}
    for line in labs_raw.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            lab_to_pod[parts[0]] = parts[1]

    # Discover running processes
    pod_stats = {}
    for pid_dir in os.listdir("/proc"):
        if not pid_dir.isdigit():
            continue
        cwd_link = f"/proc/{pid_dir}/cwd"
        try:
            cwd = os.readlink(cwd_link)
        except OSError:
            continue
        if cwd.startswith("/opt/unetlab/tmp/"):
            parts = cwd.strip("/").split("/")
            if len(parts) >= 4 and parts[3].isdigit():
                lab_session_id = parts[3]
                pod = lab_to_pod.get(lab_session_id, lab_session_id)
                if pod not in pod_stats:
                    pod_stats[pod] = {"ram_mb": 0, "nodes": set()}
                if len(parts) >= 5:
                    pod_stats[pod]["nodes"].add(f"{parts[3]}_{parts[4]}")
                # statm
                try:
                    with open(f"/proc/{pid_dir}/statm") as sf:
                        sm = sf.read().split()
                        if len(sm) >= 2:
                            pod_stats[pod]["ram_mb"] += int(round(int(sm[1]) * 4 / 1024))
                except Exception:
                    pass

    top_users = []
    total_nodes = 0
    for pod, stat in pod_stats.items():
        uname = users.get(str(pod), f"Pod {pod}")
        node_count = len(stat["nodes"])
        total_nodes += node_count
        top_users.append({
            "pod": int(pod),
            "username": uname,
            "cpu_percent": 88.5,
            "ram_mb": stat["ram_mb"],
            "running_nodes": node_count
        })

    if not top_users:
        top_users.append({
            "pod": 44,
            "username": "admin",
            "cpu_percent": 92.4,
            "ram_mb": 4096,
            "running_nodes": 5
        })
        total_nodes = 5

    now = int(time.time())
    snap_json = json.dumps(top_users).replace("'", "\\'")
    insert_sql = f"""
    INSERT INTO resource_incidents (created_at, server_cpu, server_ram, top_users, total_nodes, severity)
    VALUES ({now}, 89.2, 91.5, '{snap_json}', {total_nodes}, 'critical');
    """
    run_query(insert_sql)
    print(f"Successfully recorded simulated high-load incident at {now}!")
    print(f"Top users recorded: {top_users}")

if __name__ == "__main__":
    main()
