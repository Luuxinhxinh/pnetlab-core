#!/bin/bash
# enable-php-fpm.sh — B2: switch Apache from prefork+mod_php8.5 to
# mpm_event + php8.5-fpm. Idempotent; `--revert` switches back.
#
# Why: prefork ties one full Apache process to every long-lived connection,
# and this appliance's traffic shape is exactly that — idle WS console
# tunnels (/telnet/ /vnc/ /guac/ /shell/). Under mpm_event those cost a
# slot, not a process, and PHP moves to a managed fpm pool.
#
# The engine's PHP limits historically lived in /opt/unetlab/html/.htaccess
# as php_value/php_flag lines (mod_php only — fpm ignores them; they 500
# without mod_php unless <IfModule>-guarded, which the shipped .htaccess
# now is). The fpm pool override below mirrors them 1:1. php_value (not
# php_admin_value) on purpose: the engine still runtime-overrides via
# set_time_limit()/ini_set() in long endpoints.
set -euo pipefail

POOL=/etc/php/8.5/fpm/pool.d/zz-pnetlab.conf
TUNE=/etc/apache2/conf-available/pnet-php-fpm.conf

log() { echo "[php-fpm] $*"; }

revert() {
    log "reverting to prefork + mod_php8.5"
    a2disconf php8.5-fpm >/dev/null 2>&1 || true
    a2dismod  proxy_fcgi  >/dev/null 2>&1 || true
    a2dismod  mpm_event   >/dev/null 2>&1 || true
    a2enmod   mpm_prefork >/dev/null
    a2enmod   php8.5      >/dev/null
    a2disconf pnet-php-fpm >/dev/null 2>&1 || true
    systemctl restart apache2
    systemctl disable --now php8.5-fpm >/dev/null 2>&1 || true
    log "reverted; MPM now: $(apache2ctl -M 2>/dev/null | grep -o 'mpm_[a-z]*')"
    exit 0
}
[ "${1:-}" = "--revert" ] && revert

dpkg -s php8.5-fpm >/dev/null 2>&1 || { echo "ERROR: php8.5-fpm not installed"; exit 1; }

# 1) pool overrides for the default www pool (zz- sorts last = wins)
cat > "$POOL" <<'EOF'
; pnetlab overrides for the default www pool (zz- sorts last = wins).
; Mirrors the php_value/php_flag set from /opt/unetlab/html/.htaccess,
; which only applies under mod_php. php_value stays runtime-overridable
; (set_time_limit/ini_set in the engine's long endpoints).
[www]
pm = dynamic
pm.max_children = 40
pm.start_servers = 6
pm.min_spare_servers = 4
pm.max_spare_servers = 12
; engine endpoints (node start via broker) legitimately run for minutes
request_terminate_timeout = 0

php_flag[display_startup_errors] = off
php_flag[display_errors] = off
php_flag[html_errors] = off
; v8/27H1 (PHP 8.5): silence vendored Slim 2.6.1 deprecation notices (non-fatal)
php_value[error_reporting] = "E_ALL & ~E_DEPRECATED"
php_value[memory_limit] = 512M
php_flag[log_errors] = on
php_value[error_log] = /opt/unetlab/data/Logs/php_errors.txt
php_value[session.gc_maxlifetime] = 86400
php_value[post_max_size] = 1024M
php_value[upload_max_filesize] = 1024M
EOF

# 2) fcgi proxy timeout: node start can block up to the broker's 600s
cat > "$TUNE" <<'EOF'
# pnetlab: long engine requests (node start/stop ride the privilege broker,
# up to 600s) must not be cut by the default 300s proxy timeout.
ProxyTimeout 600
EOF

# 3) module/handler switch (restart, not graceful — MPM swap needs it)
systemctl enable --now php8.5-fpm >/dev/null
a2dismod php8.5      >/dev/null 2>&1 || true
a2dismod mpm_prefork >/dev/null 2>&1 || true
a2enmod  mpm_event proxy_fcgi setenvif >/dev/null
a2enconf php8.5-fpm pnet-php-fpm >/dev/null
systemctl restart php8.5-fpm apache2

# 4) verify: right MPM loaded AND PHP actually executes through fpm
apache2ctl -M 2>/dev/null | grep -q mpm_event || { echo "ERROR: mpm_event not active"; exit 1; }
code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1/api/auth)
case "$code" in
    2*|4*) log "OK — mpm_event + php8.5-fpm active (api.php answered $code)";;
    *)     echo "ERROR: PHP not executing via fpm (http $code)"; exit 1;;
esac
