#!/bin/bash
# pnet-premigrate-backup.sh — pre-migration safety backup of labs + DB.
#
# Usage: pnet-premigrate-backup.sh <new-version>
#
# Called (as root) from the pnetlab deb postinst immediately BEFORE the schema
# migration block, on upgrades only. Archives /opt/unetlab/labs and a mysqldump
# of pnetlab_db into /opt/unetlab/data/backups/premigrate-<newver>-<ts>/ with a
# MANIFEST (versions, sizes, sha256). Restore with pnet-premigrate-restore.sh.
#
# Guarantees:
#   - NEVER blocks an upgrade: any failure logs a warning and exits 0.
#   - Free-space guard: if the estimated backup size exceeds 80% of the free
#     space on the backups filesystem, the backup is SKIPPED (warning + a
#     SKIPPED-<ts>.log marker) and the upgrade proceeds.
#   - Retention: only the newest 3 premigrate-* dirs are kept.
#
# DB creds are the appliance's fixed root/pnetlab pair — same practice as the
# existing postinst migration block.
set -u

NEWVER="${1:-unknown}"
TS="$(date +%Y%m%d-%H%M%S)"
BACKROOT=/opt/unetlab/data/backups
DEST="$BACKROOT/premigrate-${NEWVER}-${TS}"
LABS_DIR=/opt/unetlab/labs
MYSQL_OPTS=(--host=localhost --user=root --password=pnetlab)

warn() { echo "pnet-premigrate-backup: WARNING: $*" >&2; }

[ "$(id -u)" = 0 ] || { warn "must run as root — skipping backup"; exit 0; }
[ -d "$LABS_DIR" ] || { warn "$LABS_DIR missing — nothing to back up"; exit 0; }

mkdir -p "$BACKROOT" || { warn "cannot create $BACKROOT"; exit 0; }

# ---- free-space guard (D11): estimate labs size + a modest DB allowance -------
LABS_KB=$(du -sk "$LABS_DIR" 2>/dev/null | awk '{print $1}')
LABS_KB=${LABS_KB:-0}
DB_KB=0
if mysql "${MYSQL_OPTS[@]}" -N -e "SELECT 1" pnetlab_db >/dev/null 2>&1; then
    DB_KB=$(mysql "${MYSQL_OPTS[@]}" -N -e \
        "SELECT COALESCE(CEIL(SUM(data_length+index_length)/1024),0) FROM information_schema.tables WHERE table_schema='pnetlab_db'" \
        2>/dev/null)
    DB_KB=${DB_KB:-0}
fi
EST_KB=$((LABS_KB + DB_KB))          # pre-compression worst case
FREE_KB=$(df -Pk "$BACKROOT" | awk 'NR==2 {print $4}')
FREE_KB=${FREE_KB:-0}
if [ "$FREE_KB" -gt 0 ] && [ $((EST_KB * 100)) -gt $((FREE_KB * 80)) ]; then
    warn "estimated backup ${EST_KB}KB > 80% of free ${FREE_KB}KB — SKIPPING backup, upgrade proceeds"
    echo "$(date -R): pre-migration backup for ${NEWVER} SKIPPED: est ${EST_KB}KB > 80% of free ${FREE_KB}KB" \
        > "$BACKROOT/SKIPPED-${TS}.log" 2>/dev/null
    exit 0
fi

mkdir -p "$DEST" || { warn "cannot create $DEST"; exit 0; }

# $2 = the version being replaced (postinst passes its own $2 = old version).
# Fall back to dpkg-query only when unset, but note that at postinst time dpkg
# already reports the NEW version, so the passed-in $2 is the correct source.
OLDVER="${2:-$(dpkg-query -W -f='${Version}' pnetlab 2>/dev/null || echo unknown)}"

# ---- labs archive --------------------------------------------------------------
if ! tar -C /opt/unetlab -czf "$DEST/labs.tgz" labs 2>>"$DEST/backup.err"; then
    warn "labs tar failed (see $DEST/backup.err) — upgrade proceeds"
fi

# ---- DB dump -------------------------------------------------------------------
if mysql "${MYSQL_OPTS[@]}" -N -e "SELECT 1" pnetlab_db >/dev/null 2>&1; then
    if ! mysqldump "${MYSQL_OPTS[@]}" --single-transaction pnetlab_db 2>>"$DEST/backup.err" \
            | gzip > "$DEST/pnetlab_db.sql.gz"; then
        warn "mysqldump failed (see $DEST/backup.err) — upgrade proceeds"
        rm -f "$DEST/pnetlab_db.sql.gz"
    fi
else
    warn "mysql not answering — labs-only backup"
fi
# drop mysql's cosmetic password-on-cli warning so backup.err only holds real errors
sed -i '/Using a password on the command line/d' "$DEST/backup.err" 2>/dev/null
[ -s "$DEST/backup.err" ] || rm -f "$DEST/backup.err"

# ---- MANIFEST ------------------------------------------------------------------
{
    echo "created: $(date -R)"
    echo "old_version: $OLDVER"
    echo "new_version: $NEWVER"
    echo "host: $(hostname)"
    for f in labs.tgz pnetlab_db.sql.gz; do
        if [ -f "$DEST/$f" ]; then
            echo "$f size_bytes=$(stat -c%s "$DEST/$f") sha256=$(sha256sum "$DEST/$f" | awk '{print $1}')"
        else
            echo "$f MISSING"
        fi
    done
} > "$DEST/MANIFEST" 2>/dev/null

echo "pnet-premigrate-backup: backup written to $DEST" >&2

# ---- retention: keep newest 3 premigrate-* dirs --------------------------------
ls -1dt "$BACKROOT"/premigrate-* 2>/dev/null | tail -n +4 | while read -r d; do
    rm -rf "$d"
done

exit 0
