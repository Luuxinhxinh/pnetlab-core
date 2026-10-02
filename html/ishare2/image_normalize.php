<?php
/**
 * image_normalize.php — normalise a qemu image FOLDER name to the EVE-NG
 * template convention, shared by the image downloader (ishare2/api.php +
 * worker.sh) so the two can never drift.
 *
 * THE PROBLEM
 * PNETLab/EVE-NG only associate a qemu image with a node template when the
 * image folder is named "<template>-<anything>" (e.g. linux-ubuntu-22.04 ->
 * the `linux` template). The labhub.json catalog ships several generic Linux
 * images with a prefix that matches NO installed template (e.g. alpine-base,
 * alpine-desktop, alpine-trex, alpine-wanem). Those install into a folder that
 * maps to no template -> they show up as a bogus stand-alone "device" with no
 * working console.
 *
 * THE RULE (hybrid — confirmed with the maintainer)
 * Rewrite an image folder to the generic `linux` template (which is
 * `console: vnc`) by prefixing `linux-` IFF all of:
 *   1. it is not already `linux-*`, AND
 *   2. its prefix matches NO installed template (it's an orphan), AND
 *   3. its first dash-segment looks like a Linux distro (keyword list).
 * Real device images (their prefix matches a template) and non-Linux orphans
 * are left untouched.
 *
 * USE
 *   PHP:  require_once .../image_normalize.php;  $d = pnq_normalize_qemu_dirname($name);
 *   CLI:  php image_normalize.php <foldername>   # prints the normalised name
 */

/** Installed template names (basenames of templates/{amd,intel}/<t>.yml). */
function pnq_installed_templates() {
    static $templates = null;
    if ($templates !== null) {
        return $templates;
    }
    $templates = [];
    foreach (['amd', 'intel'] as $arch) {
        foreach (glob("/opt/unetlab/html/templates/$arch/*.yml") as $f) {
            $templates[basename($f, '.yml')] = true;
        }
    }
    return $templates;
}

/** Does this folder name map to an installed template (folder == T or "T-...")? */
function pnq_maps_to_template($name, $templates = null) {
    if ($templates === null) {
        $templates = pnq_installed_templates();
    }
    foreach ($templates as $tpl => $_) {
        if ($name === $tpl || strpos($name, $tpl . '-') === 0) {
            return true;
        }
    }
    return false;
}

/** Linux-distro keyword set for the hybrid detection (first dash-segment). */
function pnq_linux_keywords() {
    return [
        'alpine', 'ubuntu', 'debian', 'kali', 'centos', 'fedora', 'rocky',
        'rhel', 'mint', 'linuxmint', 'arch', 'manjaro', 'parrot', 'tinycore',
        'slax', 'gentoo', 'suse', 'opensuse', 'popos', 'elementary', 'zorin',
        'busybox', 'devuan', 'oraclelinux', 'almalinux',
    ];
}

/**
 * Normalise one qemu image folder name. Returns the (possibly unchanged) name.
 */
function pnq_normalize_qemu_dirname($name) {
    $name = trim($name);
    if ($name === '' || strpos($name, 'linux-') === 0) {
        return $name;                       // empty or already correct
    }
    if (pnq_maps_to_template($name)) {
        return $name;                       // a real device template — leave it
    }
    $first = strtolower(explode('-', $name)[0]);
    foreach (pnq_linux_keywords() as $kw) {
        if ($first === $kw) {
            return 'linux-' . $name;        // orphan Linux image -> linux template
        }
    }
    return $name;                           // orphan but not a known Linux distro
}

// CLI entry point: `php image_normalize.php <name>` (used by worker.sh).
if (PHP_SAPI === 'cli' && isset($argv[1])) {
    echo pnq_normalize_qemu_dirname($argv[1]) . "\n";
}
