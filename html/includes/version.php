<?php
/**
 * version.php — single source of truth for the friendly PNetLab RELEASE string
 * shown in the UI: the login page, the main-page footer, the Version page, the
 * System → Platform card (engine version), and the Clusters master-version row.
 *
 * Bump PNET_RELEASE on every release. This is intentionally SEPARATE from the deb
 * package version (dpkg / the 'pnetlab' field on the Version page), which tracks
 * the build and is used for cluster version-skew detection.
 *
 * NOTE: the boot console banner is shell, not PHP — bump it too when releasing:
 *   engine-custom/opt/ovf/ovfstartup.sh  and  work/iso/pnetlab-firstboot.sh
 */
if (!defined('PNET_RELEASE')) {
    define('PNET_RELEASE', '27H1 v8.2');
}

// Numeric release label (mirrors the DB ctrl_version seed, doctor.php + the
// installer). The classic login shows this as "Version: 8.2.0". Kept here so it
// bumps in ONE place alongside PNET_RELEASE — login/version.php echoes it rather
// than hardcoding a second copy.
if (!defined('PNET_VERSION')) {
    define('PNET_VERSION', '8.2.0');
}
