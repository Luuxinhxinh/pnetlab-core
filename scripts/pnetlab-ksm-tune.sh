#!/bin/sh
# pnetlab-ksm-tune.sh — apply KSM scan/merge settings at boot.
#
# Driven by /etc/default/pnetlab-ksm (EnvironmentFile of pnetlab-ksm.service).
#
# Benchmarked on the noble 6.12 KSM kernel (8 idle vIOS, ~2.4 GB resident):
#   static  pages_to_scan=2000 sleep=20ms  -> ~1.6 GB merged, converges ~30s
#   advisor scan-time (kernel default)     -> slow/unreliable ramp, ~0.2 GB in 150s
# The in-tree KSM *advisor* targets a fixed full-scan TIME and computes a low
# pages_to_scan (70-500), so it converges far too slowly for GB-scale VM RAM and
# can stall entirely if it starts while guests are still booting (volatile pages
# + smart_scan poison the candidate set). A high STATIC rate is the UKSM-class
# replacement and is the default here. advisor_mode is still selectable for
# operators who prefer the kernel to self-throttle CPU at the cost of slow merge.
#
# All writes are best-effort: keys absent on this kernel are skipped, so this is
# safe across kernel versions (and a no-op on kernels without KSM).
set -eu

KSM=/sys/kernel/mm/ksm
if [ ! -d "$KSM" ]; then
    echo "pnetlab-ksm: KSM not present in this kernel; nothing to do"
    exit 0
fi

# Defaults — overridable via /etc/default/pnetlab-ksm.
KSM_MODE="static"                 # static | advisor
KSM_PAGES_TO_SCAN="2000"          # static mode: pages per scan cycle
KSM_SLEEP_MS="20"                 # static mode: ms between cycles
KSM_TARGET_SCAN_TIME="60"         # advisor mode: target full-scan seconds
KSM_MAX_CPU=""                    # advisor mode: advisor_max_cpu (% of one core); empty = kernel default
KSM_SMART_SCAN="1"                # skip pages that repeatedly fail to merge
KSM_USE_ZERO_PAGES="1"
KSM_RUN="1"                       # 1=run, 0=stop, 2=unmerge

if [ -r /etc/default/pnetlab-ksm ]; then
    # shellcheck disable=SC1091
    . /etc/default/pnetlab-ksm
fi

set_if() {  # set_if <sysfs-leaf> <value>
    leaf="$1"; val="$2"
    [ -n "$val" ] || return 0
    if [ ! -w "$KSM/$leaf" ]; then
        echo "pnetlab-ksm: skip $leaf (not present on this kernel)"
        return 0
    fi
    if printf '%s\n' "$val" > "$KSM/$leaf" 2>/dev/null; then
        echo "pnetlab-ksm: $leaf=$val"
    else
        echo "pnetlab-ksm: WARN failed to set $leaf=$val"
    fi
}

# smart_scan / zero-page handling apply to both modes.
set_if smart_scan     "$KSM_SMART_SCAN"
set_if use_zero_pages "$KSM_USE_ZERO_PAGES"

if [ "$KSM_MODE" = advisor ]; then
    set_if advisor_mode             scan-time
    set_if advisor_target_scan_time "$KSM_TARGET_SCAN_TIME"
    set_if advisor_max_cpu          "$KSM_MAX_CPU"
else
    # static: advisor off, then fixed rate (advisor must be off or it owns these)
    set_if advisor_mode    none
    set_if pages_to_scan   "$KSM_PAGES_TO_SCAN"
    set_if sleep_millisecs "$KSM_SLEEP_MS"
fi

set_if run "$KSM_RUN"
exit 0
