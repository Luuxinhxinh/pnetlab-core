#!/bin/bash
# gen-template-manifest.sh — (re)generate the shipped free-form docker template
# manifest for the docker-rebroker broker.
#
# The broker's docker_create verb accepts a template's legacy free-form
# `dock_args`/`docker_options` string ONLY when the template FILE's sha256 is
# listed here. This script hashes every shipped template that carries such a
# free-form string (across all platform dirs) and writes the manifest as
# `<sha256>  templates/<platform>/<name>.yml` lines (sha256sum format).
#
# BUILD PIPELINE: run this over the engine-custom template tree whenever a
# shipped template's dock_args/docker_options bytes change, and commit the
# regenerated manifest. scripts/build-release.sh should invoke it so the manifest
# always matches the shipped template bytes. Admin-added (non-shipped) free-form
# templates are signed at runtime with pnetlab-template-sign instead.
#
# Usage: gen-template-manifest.sh [TEMPLATES_ROOT] [OUT_MANIFEST]
#   TEMPLATES_ROOT defaults to /opt/unetlab/html/templates (the deployed path).
#   OUT_MANIFEST defaults to the root-owned scripts dir alongside this script
#   (…/scripts/docker-template-manifest.sha256), i.e. TEMPLATES_ROOT with
#   html/templates -> scripts. The manifest is deliberately kept OUT of the html
#   tree: fixpermissions chowns html to www-data, which would let www-data
#   self-sign a dangerous template; /opt/unetlab/scripts stays root-owned.
set -euo pipefail

ROOT="${1:-/opt/unetlab/html/templates}"
# Derive the sibling scripts dir from ROOT so this works for both the deployed
# tree and an engine-custom build tree; allow an explicit override as $2.
DEFAULT_OUT="${ROOT%/html/templates}/scripts/docker-template-manifest.sha256"
OUT="${2:-$DEFAULT_OUT}"

if [ ! -d "$ROOT" ]; then
    echo "gen-template-manifest: templates root not found: $ROOT" >&2
    exit 1
fi
OUT_DIR="$(dirname "$OUT")"
if [ ! -d "$OUT_DIR" ]; then
    echo "gen-template-manifest: manifest output dir not found: $OUT_DIR" >&2
    exit 1
fi

tmp="$(mktemp)"
{
    echo "# PNetLab shipped free-form docker template manifest (docker-rebroker)."
    echo "# Regenerate with scripts/gen-template-manifest.sh; do not hand-edit."
    echo "# <sha256>  templates/<platform>/<template>.yml"
} > "$tmp"

# Hash every template that carries a free-form dock_args/docker_options.
while IFS= read -r -d '' f; do
    if grep -qE '^\s*(dock_args|docker_options)\s*:' "$f"; then
        h="$(sha256sum "$f" | awk '{print $1}')"
        rel="templates/${f#"$ROOT"/}"
        printf '%s  %s\n' "$h" "$rel" >> "$tmp"
    fi
done < <(find "$ROOT" -mindepth 2 -maxdepth 2 -name '*.yml' -print0 | sort -z)

# Keep it root-owned and world-readable (broker root-reads it; must not be
# www-data-writable).
install -m 0644 "$tmp" "$OUT"
rm -f "$tmp"
echo "gen-template-manifest: wrote $OUT ($(grep -cvE '^#' "$OUT") entries)"
