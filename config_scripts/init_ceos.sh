#!/bin/bash
# Inject Arista cEOS user-defined interface mapping (EosIntfMapping.json) into the
# lab container via docker cp (no bind mount). Requires cEOS >= 4.28.0F for mapping.
#
# Usage: init_ceos.sh /opt/unetlab/tmp/<tenant>/<lab_id>/<node_id> [ -s <satellite_ip> ]
#
# EVE_ENV in eve_env.txt must contain intnames (and optionally interfaces); see cli.php.

set -euo pipefail

path="${1:?usage: $0 /opt/unetlab/tmp/<tenant>/<lab_id>/<node_id> [ -s <satellite_ip> ]}"
shift || true
SATELLITE_IP=""

while [[ $# -gt 0 ]]; do
	case "$1" in
	-s)
		SATELLITE_IP="${2:?-s requires an IP}"
		shift 2
		;;
	*)
		echo "Unknown option: $1" >&2
		exit 1
		;;
	esac
done

# Docker container name for docker-type nodes: lab_id-tenant-node_id (see __node.php getUuid())
DOCKER="$(basename "$(dirname "$path")")-$(basename "$(dirname "$(dirname "$path")")")-$(basename "$path")"

if [[ -n "$SATELLITE_IP" ]]; then
	DOCKER_CMD=(docker -H "ssh://root@${SATELLITE_IP}")
else
	# Same daemon as html/includes/cli.php
	DOCKER_CMD=(docker -H "tcp://127.0.0.1:4243")
fi

envfile="${path}/eve_env.txt"
[[ -f "$envfile" ]] || {
	echo "ERROR: $envfile not found" >&2
	exit 1
}

outfile="${path}/EosIntfMapping.json"
bash_wrapper_host="${path}/eve_ceos_bash_wrapper.sh"
bash_real_host="${path}/eve_ceos_bash.real"

if ! command -v python3 >/dev/null 2>&1; then
	echo "ERROR: python3 is required to build EosIntfMapping.json" >&2
	exit 1
fi

python3 - "$envfile" "$outfile" <<'PY'
import json
import sys

env_path, out_path = sys.argv[1], sys.argv[2]

raw_intnames = None
raw_ifaces = None
with open(env_path, "r", encoding="utf-8", errors="replace") as f:
    for line in f:
        if line.startswith("EVE_ENV="):
            payload = line.split("=", 1)[1].strip()
            if not payload:
                break
            data = json.loads(payload)
            raw_intnames = data.get("intnames")
            raw_ifaces = data.get("interfaces")
            break


def normalize_intnames(raw):
    """PHP json_encode may use object {\"0\":...} or array [\"eth0\", ...]."""
    if raw is None:
        return {}
    if isinstance(raw, list):
        out = {}
        for i, v in enumerate(raw):
            if v is None:
                continue
            s = str(v).strip()
            if s:
                out[str(i)] = s
        return out
    if isinstance(raw, dict):
        out = {}
        for k, v in raw.items():
            if v is None:
                continue
            s = str(v).strip()
            if not s:
                continue
            out[str(k)] = s
        return out
    return {}


def iface_index_set(interfaces, intnames_keys):
    """Derive interface indices from interfaces (list or dict) and intnames keys."""
    ids = set()
    for k in intnames_keys:
        if isinstance(k, str) and k.lstrip("-").isdigit():
            ids.add(int(k))
        elif isinstance(k, int):
            ids.add(k)
    if isinstance(interfaces, list):
        ids.update(range(len(interfaces)))
    elif isinstance(interfaces, dict):
        for k in interfaces:
            if isinstance(k, int):
                ids.add(k)
            elif isinstance(k, str) and k.lstrip("-").isdigit():
                ids.add(int(k))
    return ids


intnames = normalize_intnames(raw_intnames)
ids = iface_index_set(raw_ifaces, intnames.keys())
if not ids:
    ids = {0}
max_id = max(ids)

mgmt: dict[str, str] = {}
eth: dict[str, str] = {}

for i in range(0, max_id + 1):
    k = str(i)
    name = intnames.get(k)
    if not name:
        if i == 0:
            name = "Management1"
        else:
            name = f"Ethernet{i}/1"
    linux = f"eth{i}"
    if i == 0:
        mgmt[linux] = name
    else:
        eth[linux] = name

doc = {"ManagementIntf": mgmt, "EthernetIntf": eth}
with open(out_path, "w", encoding="utf-8") as out:
    json.dump(doc, out, indent=2)
    out.write("\n")
PY

"${DOCKER_CMD[@]}" inspect "$DOCKER" >/dev/null

install_bash_wrapper() {
	# Already hardened.
	if "${DOCKER_CMD[@]}" cp "${DOCKER}:/bin/bash.real" "$bash_real_host" >/dev/null 2>&1; then
		rm -f "$bash_real_host"
	else
		# Preserve original bash binary before replacing /bin/bash.
		"${DOCKER_CMD[@]}" cp "${DOCKER}:/bin/bash" "$bash_real_host"
		"${DOCKER_CMD[@]}" cp "$bash_real_host" "${DOCKER}:/bin/bash.real"
		rm -f "$bash_real_host"
	fi

	cat > "$bash_wrapper_host" <<'EOF'
#!/bin/bash.real
MSG="Interactive Linux shell access is disabled by EVE-NG for NOS container."

# Block only when a real TTY is attached.
if [ -t 0 ] || [ -t 1 ] || [ -t 2 ]; then
	echo "$MSG" >&2
	exit 126
fi

exec /bin/bash.real "$@"
EOF

	chmod 755 "$bash_wrapper_host"
	"${DOCKER_CMD[@]}" cp "$bash_wrapper_host" "${DOCKER}:/bin/bash"
	rm -f "$bash_wrapper_host"
}

install_bash_wrapper

# Arista expects this path at boot (see Containerlab ceos kind docs)
dest="/mnt/flash/EosIntfMapping.json"
"${DOCKER_CMD[@]}" cp "$outfile" "${DOCKER}:${dest}"

echo "OK: hardened /bin/bash and injected ${dest} into container ${DOCKER}"
