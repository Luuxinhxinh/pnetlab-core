#!/bin/bash
set -euo pipefail

# Init script for the srlinux-ixr-d2l (Nokia 7220 IXR-D2L) Docker template.
# Invoked by device_docker.php's start() init hook as:
#   init_srlinux-ixr-d2l.sh <running_path> <container_name> [ -s <satellite_ip> ]
# <container_name> (docker<session>) is passed as $2 by the init hook
# (device_docker.php ~:522). Ported from EVE-NG's init_srlinux-ixr-d2l.sh,
# which only ever received <running_path> [-s <ip>] and derived the container
# name from the path (UUID-0-1). That fallback is kept for standalone use.

path="${1:?usage: $0 /opt/unetlab/tmp/<lab_session>/<node_session> [<container_name>] [ -s <satellite_ip> ]}"

# docker name: use the container name passed by the init hook ($2); fall back
# to EVE's path-derived UUID-0-1 form if it is absent (standalone-safe).
DOCKER="${2:-$(basename "$(dirname "$path")")-$(basename "$(dirname "$(dirname "$path")")")-$(basename "$path")}"

# Drop <path> and (if present) <container_name> from the positional params,
# leaving only a possible trailing "-s <satellite_ip>" pair.
shift "$(( $# < 2 ? $# : 2 ))"

SATELLITE_IP=""
while [[ $# -gt 0 ]]; do
    case $1 in
        -s)
            SATELLITE_IP="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Set docker command prefix if satellite IP is provided
DOCKER_CMD="docker"
if [ -n "$SATELLITE_IP" ]; then
    DOCKER_CMD="docker -H ssh://root@$SATELLITE_IP"
fi

# Verify the container exists
$DOCKER_CMD inspect "$DOCKER" >/dev/null

# Create the chassis model + netinit files on the host (in the runtime dir),
# then docker cp them in.
modelfile="$path/model.yml"
netinitfile="$path/netinit"

t=$(basename "$(dirname "$(dirname "$path")")")
id=$(basename "$path")
mac=$(printf '1a:%02x:%02x:%02x:%02x:%02x' \
  $(( t & 255 )) \
  $(( id & 255 )) \
  $(( 0 )) \
  $(( 0 )) \
  $(( 0 ))
)

cat > "$modelfile" <<EOF
# Config from https://github.com/srl-labs/containerlab/blob/main/nodes/srl/topology/7220IXRD2L.yml
# For other model, select one yaml from  https://github.com/srl-labs/containerlab/blob/main/nodes/srl/topology/
# and replace "base_mac": "{{ .MAC }}" with a correct mac like below
---
chassis_configuration:
  "chassis_type": 72
  "base_mac": "$mac"
  "cpm_card_type": 187

slot_configuration:
  1:
    "card_type": 187
    "mda_type": 208
...
EOF

$DOCKER_CMD cp "$modelfile" "$DOCKER:/tmp/topology.yml"
echo "OK: injected model  7220IXRD2L into container $DOCKER"

cat > "$netinitfile" <<'EOF'
#!/bin/bash
rm -f /var/run/netns/* || true
# Skip eth0: device_docker.php names the first (management) interface eth0,
# and it must stay eth0 -- sr_linux has no e1-0. Rename only eth1..N -> e1-1..e1-N.
for i in $(ls -1d /sys/class/net/eth*|sed -e 's/.*eth//') ; do \
if [ "$i" = "0" ]; then continue; fi
ip link set eth$i down
ip link set eth$i name e1-$i
ip link set e1-$i up
done
/opt/srlinux/bin/sr_linux
EOF
$DOCKER_CMD cp "$netinitfile" "$DOCKER:/sr_linux_init.sh"
