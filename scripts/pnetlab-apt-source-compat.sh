#!/usr/bin/env bash
# Retire only the exact source emitted by older network installers, and only
# after a usable canonical source exists. The old key remains for recovery.
set -euo pipefail

pnetlab_retire_netinstall_source() {
    local source="$1" keyring="$2" repository="$3"
    local legacy="${4:-/etc/apt/sources.list.d/pnetlab-netinstall-codeberg.list}" backup
    [ -f "$legacy" ] && [ ! -L "$legacy" ] || return 0
    [ -f "$source" ] && [ ! -L "$source" ] && [ -s "$keyring" ] && [ -r "$keyring" ] || return 0
    printf '%s\n' "deb [arch=amd64 signed-by=/usr/share/keyrings/pnetlab-netinstall-codeberg.gpg] $repository resolute main" \
        | cmp -s - "$legacy" || return 0
    if ! printf '%s\n' "deb [signed-by=$keyring] $repository resolute main" | cmp -s - "$source"; then
        printf '%s\n' "deb [arch=amd64 signed-by=$keyring] $repository resolute main" \
            | cmp -s - "$source" || return 0
    fi
    backup=$(mktemp "${legacy}.XXXXXX.disabled") || return 1
    if ! mv -f -- "$legacy" "$backup"; then
        rm -f -- "$backup"
        return 1
    fi
    printf 'Retired duplicate network-install apt source; backup: %s\n' "$backup"
}

pnetlab_retire_netinstall_source "$@"
