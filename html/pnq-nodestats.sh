#!/bin/bash
# pnq-nodestats.sh — emit "<pid> <cwd>" for every process whose current working
# directory is under /opt/unetlab/tmp (the per-node workspace dirs). QEMU and IOL
# node processes chdir into their node workspace, so this maps a running node's
# workspace -> pid without needing the node's own pid file. Runs as root via the
# pnetlab-brokerd 'nodestats' verb (the node processes are root-owned, so
# /proc/<pid>/cwd is only readable as root). Read-only; safe.
for d in /proc/[0-9]*; do
    l=$(readlink "$d/cwd" 2>/dev/null) || continue
    case "$l" in
        /opt/unetlab/tmp/*) echo "${d#/proc/} $l" ;;
    esac
done
