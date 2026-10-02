#!/bin/bash
set -euo pipefail

dir="${1:?usage: $0 /full/path/to/node/dir}"
envfile="$dir/eve_env.txt"

[[ -f "$envfile" ]] || {
  echo "ERROR: $envfile not found" >&2
  exit 1
}

# Lire EVE_ENV
line="$(grep -m1 '^EVE_ENV=' "$envfile" || true)"
[[ -n "$line" ]] || {
  echo "ERROR: EVE_ENV not found in $envfile" >&2
  exit 1
}

json="${line#EVE_ENV=}"

# Extraire interfaces et compter {} (interfaces=[{},{},...])
block="${json#*\"interfaces\":[}"
block="${block%%]*}"

count=0
while [[ "$block" == *"{}"* ]]; do
  ((++count))
  block="${block#*{}}"
done

echo "XR_FIRST_BOOT_CONFIG=/firstboot.cfg" >> $envfile

# Générer XR_INTERFACES

#xr="linux:eth0,xr_name=Mg0/RP0/CPU0/0,chksum,snoop_v4,snoop_v6;"
xr=""
for ((i=1; i<count; i++)); do
	xr+="linux:eth$i,xr_name=Gi0/0/0/$((i-1));"
done

# Mettre à jour env-file (idempotent)
tmp="$(mktemp)"
grep -v '^XR_INTERFACES=' "$envfile" | grep -v '^XR_MGMT_INTERFACES=' > "$tmp"
printf 'XR_MGMT_INTERFACES=linux:eth0,xr_name=MgmtEth0/RP0/CPU0/0,chksum,snoop_v4,snoop_v6;\n'  >> "$tmp" 
printf 'XR_INTERFACES=%s\n' "$xr" >> "$tmp"
mv "$tmp" "$envfile"

echo "OK: XR_INTERFACES generated for $count interfaces in $envfile"
