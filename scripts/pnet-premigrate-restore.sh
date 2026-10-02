#!/bin/bash
# pnet-premigrate-restore.sh — restore a pre-migration backup taken by
# pnet-premigrate-backup.sh.
#
# Usage: pnet-premigrate-restore.sh <backup-dir>
#   e.g. pnet-premigrate-restore.sh /opt/unetlab/data/backups/premigrate-6.9.0-20260719-120000
#
# What it does (as root):
#   1. stops apache2 + pnetlab-brokerd
#   2. restores /opt/unetlab/labs from <backup-dir>/labs.tgz
#   3. restores pnetlab_db from <backup-dir>/pnetlab_db.sql.gz (if present)
#   4. runs unl_wrapper -a fixpermissions
#   5. restarts pnetlab-brokerd + apache2
#
# NOTE: restoring the DB rolls its schema back to the backed-up version; if you
# stay on the newer deb afterwards, re-run its migrations with
#   dpkg-reconfigure pnetlab   (or work/installer/fix-db-migrations.sh)
set -eu

DIR="${1:-}"
[ -n "$DIR" ] && [ -d "$DIR" ] || { echo "usage: $0 <backup-dir>" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "must run as root" >&2; exit 1; }
[ -f "$DIR/labs.tgz" ] || { echo "ERROR: $DIR/labs.tgz missing" >&2; exit 1; }

MYSQL_OPTS=(--host=localhost --user=root --password=pnetlab)

echo "== stopping services"
systemctl stop apache2 pnetlab-brokerd 2>/dev/null || true

echo "== restoring labs from $DIR/labs.tgz"
tar -C /opt/unetlab -xzf "$DIR/labs.tgz"

if [ -f "$DIR/pnetlab_db.sql.gz" ]; then
    echo "== restoring pnetlab_db from $DIR/pnetlab_db.sql.gz"
    gunzip -c "$DIR/pnetlab_db.sql.gz" | mysql "${MYSQL_OPTS[@]}" pnetlab_db
else
    echo "== no DB dump in backup — labs-only restore"
fi

echo "== fixpermissions"
/opt/unetlab/wrappers/unl_wrapper -a fixpermissions >/dev/null 2>&1 || true

echo "== restarting services"
systemctl start pnetlab-brokerd apache2

echo "== restore complete from $DIR"
