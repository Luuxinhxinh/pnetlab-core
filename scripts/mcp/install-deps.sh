#!/bin/bash
# Optional AI/MCP runtime installation. Always return success to dpkg; warnings
# identify unavailable features and preserve pip diagnostics for the operator.
set +e
WHEELHOUSE="${PNETLAB_AI_WHEELHOUSE:-/opt/pnet-webconsole/wheels}"
LOG="${PNETLAB_AI_DEPS_LOG:-/var/log/pnetlab-ai-deps.log}"
REPAIR='bash /opt/unetlab/scripts/mcp/install-deps.sh'

warn() {
    local message="pnetlab.postinst: WARNING: AI/MCP: $*"
    printf '\n!!!!!!!! %s !!!!!!!!\n\n' "$message" >&2
    printf '%s\n' "$message" >> "$LOG" 2>/dev/null || true
    logger -t pnetlab.postinst -- "$message" 2>/dev/null || true
}

probe() {
    python3 - <<'PY' >> "$LOG" 2>&1
from mcp import ClientSession
from mcp.server.fastmcp import FastMCP
from anthropic import Anthropic
from openai import OpenAI
from jsonschema import Draft202012Validator
import uvicorn, httpx
PY
}

if ! touch "$LOG" 2>/dev/null; then
    printf 'pnetlab.postinst: WARNING: cannot write %s; AI dependency diagnostics go to stderr\n' "$LOG" >&2
    LOG=/dev/stderr
fi
printf '\nAI/MCP dependency check %s\n' "$(date -Is)" >> "$LOG" 2>/dev/null
if probe; then
    echo 'pnetlab.postinst: AI/MCP dependencies available (services remain under dashboard control)'
    exit 0
fi
if ! python3 -m pip --version >> "$LOG" 2>&1; then
    warn "Python pip is unavailable. Install python3-pip and retry: $REPAIR. AI Lab Builder and external MCP remain unavailable. Appliance installation continues. Details: $LOG"
    exit 0
fi
if ! command -v timeout >/dev/null 2>&1; then
    warn "timeout is unavailable; dependency installation skipped. Retry: $REPAIR. Appliance installation continues. Details: $LOG"
    exit 0
fi
CONSTRAINT="$(mktemp)"
if [ -z "$CONSTRAINT" ]; then
    warn "Could not create pip constraint file. Retry: $REPAIR. Appliance installation continues. Details: $LOG"
    exit 0
fi
trap 'rm -f -- "$CONSTRAINT"' EXIT
# Keep apt cryptography/pyOpenSSL compatible (Lab PKI and SD-WAN certificates).
if ! printf 'cryptography<47\n' > "$CONSTRAINT"; then
    warn "Could not write pip constraint file. Retry: $REPAIR. Appliance installation continues. Details: $LOG"
    exit 0
fi
pip_install() {
    timeout --kill-after=5s 120s python3 -m pip install --break-system-packages \
        --disable-pip-version-check --no-cache-dir --timeout 10 --retries 1 \
        -c "$CONSTRAINT" "$@" >> "$LOG" 2>&1
}
install_from() {
    # Only jsonschema needs this workaround for apt's missing RECORD metadata.
    # Never use blanket --ignore-installed across the whole dependency closure.
    pip_install "$@" --ignore-installed --no-deps jsonschema && \
        pip_install "$@" mcp uvicorn httpx anthropic openai jsonschema && probe
}
if compgen -G "$WHEELHOUSE/mcp-*.whl" >/dev/null; then
    if install_from --no-index --find-links "$WHEELHOUSE"; then
        echo 'pnetlab.postinst: AI/MCP dependencies installed and verified from bundled wheels'
        exit 0
    fi
    warn "Bundled-wheel installation failed; trying a bounded online fallback. Details: $LOG"
else
    warn "Bundled AI/MCP wheels are missing; trying a bounded online fallback. Details: $LOG"
fi
if install_from; then
    echo 'pnetlab.postinst: AI/MCP dependencies installed and verified from the configured pip index'
else
    warn "DEPENDENCY INSTALLATION FAILED. AI Lab Builder and external MCP cannot be used until dependencies are repaired. Appliance installation continues. Retry: $REPAIR. Details: $LOG"
fi
exit 0
