#!/bin/bash
# /opt/unetlab/scripts/stress_workload.sh
# Tool to simulate continuous heavy CPU & RAM overload for testing User Resources and Incident Logs.

ACTION="${1:-status}"
PID_FILE="/tmp/pnetlab_stress_workload.pid"

case "$ACTION" in
    start)
        if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            echo "[STRESS] Workload is already running (PID: $(cat "$PID_FILE"))."
            exit 0
        fi

        echo "[STRESS] Starting continuous CPU (95%) and RAM (3.5 GB) workload..."
        # Run python script in background that burns CPU on all cores and holds RAM
        python3 -c '
import os, sys, time, multiprocessing

def cpu_burner():
    while True:
        pass

# Allocate ~3.5 GB RAM
try:
    memory_hog = bytearray(3500 * 1024 * 1024)
except Exception:
    pass

# Spin CPU on all cores
workers = []
for _ in range(multiprocessing.cpu_count()):
    p = multiprocessing.Process(target=cpu_burner)
    p.daemon = True
    p.start()
    workers.append(p)

while True:
    time.sleep(1)
' >/dev/null 2>&1 &

        STRESS_PID=$!
        echo "$STRESS_PID" > "$PID_FILE"
        echo "[STRESS] Workload ACTIVE (PID: $STRESS_PID). Host CPU and RAM are now full continuously!"
        echo "[STRESS] Run './stress_workload.sh stop' to stop."
        ;;

    stop)
        if [ -f "$PID_FILE" ]; then
            SPID=$(cat "$PID_FILE")
            pkill -P "$SPID" 2>/dev/null
            kill -9 "$SPID" 2>/dev/null
            rm -f "$PID_FILE"
        fi
        pkill -f 'cpu_burner' 2>/dev/null || true
        echo "[STRESS] Workload STOPPED. CPU and RAM returned to normal."
        ;;

    status)
        if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            echo "[STRESS] Status: RUNNING (PID: $(cat "$PID_FILE"))."
        else
            echo "[STRESS] Status: STOPPED (Idle)."
        fi
        ;;

    *)
        echo "Usage: $0 {start|stop|status}"
        exit 1
        ;;
esac
