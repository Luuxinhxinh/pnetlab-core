#!/bin/bash
#!/bin/bash
set -euo pipefail

path="${1:?usage: $0 /opt/unetlab/tmp/<lab_session>/<node_session> [ -s <satellite_ip> ]}"
SATELLITE_IP=""

# Parse optional -s parameter
shift
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

# PNetLab names containers docker{node_session_id}
DOCKER="docker$(basename "$path")"

# Set docker command prefix if satellite IP is provided
DOCKER_CMD="docker"
if [ -n "$SATELLITE_IP" ]; then
    DOCKER_CMD="docker -H ssh://root@$SATELLITE_IP"
fi

# Vérifie que le container existe
$DOCKER_CMD inspect "$DOCKER" >/dev/null

# Crée le fichier sur l'hôte (dans le dir runtime) puis docker cp
tmpfile="$path/firstboot.cfg"

cat > "$tmpfile" <<'EOF'
username admin
group root-lr
group netadmin
secret cisco
EOF

# Copie dans le container (root)
$DOCKER_CMD cp "$tmpfile" "$DOCKER:/firstboot.cfg"

echo "OK: injected /firstboot.cfg into container $DOCKER"
