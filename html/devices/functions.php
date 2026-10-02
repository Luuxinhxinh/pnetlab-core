<?php

function checkFolder($s)
{
    if (preg_match('/^\/[\/A-Za-z0-9_\\s-]*$/', $s) && is_dir($s)) {
        return 0;
    } elseif (preg_match('/^\/[\/A-Za-z0-9_\\s-]*$/', $s)) {
        return 1;
    } else {
        return 2;
    }
}

/**
 * Function to check if a string is valid as interface_type.
 *
 * @param	string	$s					Parameter
 * @return	bool						True if valid
 */
function checkInterfcType($s)
{
    if (in_array($s, ["ethernet", "serial"])) {
        return true;
    } else {
        return false;
    }
}

/**
 * Function to check if a string is valid as lab_filename.
 *
 * @param	string	$s					String to check
 * @return	bool						True if valid
 */
function checkLabFilename($s)
{
    if (preg_match('/^[A-Za-z0-9_\\s-]+\.unl$/', $s)) {
        return true;
    } else {
        return false;
    }
}

/**
 * Function to check if a string is valid as lab_name.
 *
 * @param	string	$s					String to check
 * @return	bool						True if valid
 */
function checkLabName($s)
{
    if (preg_match('/^[A-Za-z0-9_\\s-]+$/', $s)) {
        return true;
    } else {
        return false;
    }
}

/**
 * Function to check if a string is valid as lab_path.
 *
 * @param	string	$s					String to check
 * @return	bool						True if valid
 */
function checkLabPath($s)
{
    if (preg_match('/^\/[\/A-Za-z0-9_\\s-]*$/', $s)) {
        return true;
    } else {
        return false;
    }
}

/**
 * Function to check if a string is valid as network_type.
 *
 * @param	string	$s					Parameter
 * @return	bool						True if valid
 */
function checkNetworkType($s)
{
    if (in_array($s, listNetworkTypes())) {
        return true;
    } else {
        return false;
    }
}

/**
 * Function to check if a string is valid as a picture_type. Currently only
 * PNG and JPEG images are supported.
 *
 * @param	string	$s					String to check
 * @return	bool						True if valid
 */
function checkPictureType($s)
{
    if (in_array($s, ["image/png", "image/jpeg"])) {
        return true;
    } else {
        return false;
    }
}

/**
 * Function to check if a string is valid as a position.
 *
 * @param	string	$s					String to check
 * @return	bool						True if valid
 */
function checkPosition($s)
{
    if (preg_match('/^[0-9]+$/', $s) && $s >= 0) {
        return true;
    } else {
        return false;
    }
}
/**
 * Function to check if a string is valid as UUID.
 *
 * @param	string	$s					String to check
 * @return	bool						True if valid
 */
function checkUuid($s)
{
    if (
        preg_match(
            '/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/',
            $s
        )
    ) {
        return true;
    } else {
        return false;
    }
}

/**
 * Function to generate a v4 UUID.
 *
 * @return	string						The generated UUID
 */
function genUuid()
{
    return sprintf(
        "%04x%04x-%04x-%04x-%04x-%04x%04x%04x",
        // 32 bits for "time_low"
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),

        // 16 bits for "time_mid"
        mt_rand(0, 0xffff),

        // 16 bits for "time_hi_and_version",
        // four most significant bits holds version number 4
        mt_rand(0, 0x0fff) | 0x4000,

        // 16 bits, 8 bits for "clk_seq_hi_res",
        // 8 bits for "clk_seq_low",
        // two most significant bits holds zero and one for variant DCE1.1
        mt_rand(0, 0x3fff) | 0x8000,

        // 48 bits for "node"
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff)
    );
}

/**
 * Function to check if mac address format is valid
 *
 * @return   int (Bool)
 */

function IsValidMac($mac)
{
    return preg_match("/([a-fA-F0-9]{2}[:]?){6}/", $mac) == 1;
}
/**
 * Function to Increment mac address
 *
 * @return string  Next Mac
 */

function incMac($mac, $n)
{
    $nmac = substr(
        "000000000000" . dechex(hexdec(str_replace(":", "", $mac)) + $n),
        -12
    );
    $fmac = trim(preg_replace("/../", '$0:', $nmac), ":");
    return $fmac;
}

/**
 * Function to check if UNetLab is running as a VM.
 *
 * @return	bool						True is is a VM
 */
function isVirtual()
{
    switch (FORCE_VM) {
        default:
            // Auto or non valid setting
            broker_exec('wrapper', ['action' => 'platform'], $o, $rc);
            $o = implode("", $o);
            switch ($o) {
                default:
                    return false;
                case "VMware Virtual Platform":
                    return true;
                case "VirtualBox":
                    return true;
                case "KVM":
                    // QEMU (KVM)
                    return true;
                case "Bochs":
                    // QEMU (emulated)
                    return true;
                case "Virtual Machine":
                    // Microsoft VirtualPC
                    return true;
                case "Xen":
                    // HVM domU
                    return true;
                case preg_match("/vmx.*/", $o) ? true : false:
                    // vmx and ept present -> kvm accel available
                    return false;
            }
        case "on":
            return true;
        case "off":
            return false;
    }
}

/**
 * Function to list all available cloud interfaces (pnet*).
 *
 * @return	Array						The list of pnet interfaces
 */
function listClouds()
{
    $results = [];
    foreach (scandir("/sys/devices/virtual/net") as $interface):
        if (preg_match('/^nat[0-9]+$/', $interface)) {
            $results[$interface] = $interface;
        }
        if (preg_match('/^pnet[\d\w]+$/', $interface)) {
            $results[$interface] = $interface;
        }
    endforeach;
    return $results;
}

/**
 * Function to list all available network types.
 *
 * @return	Array						The list of network types
 */
function listNetworkTypes()
{
    $results = [];
    $results["bridge"] = "bridge";
    $results["dot1q"] = "dot1q";
    $results["router"] = "router";
    $results["wireless"] = "wireless";
    $results["internal"] = "internal";
    $results["internal2"] = "internal2";
    $results["internal3"] = "internal3";
    $results["private"] = "private";
    $results["private2"] = "private2";
    $results["private3"] = "private3";
    // ovs REMOVED from the advertised list (owner decision 2026-08-05). It could
    // never work on this line and was a trap: the user picked it, the canvas drew
    // the network, and nothing existed on the host -- the same "topology looks
    // correct but no bridge exists" failure fixed for internal/private. It is dead
    // TWO ways: no ovs-vsctl binary is installed, AND cli.php's addOvs/addOvsPort
    // call ovs-vsctl through raw exec() as www-data with no sudo and no broker
    // verb, so installing the package alone would still fail. Those exec() calls
    // are the last survivors of the pattern the broker replaced. Reinstating ovs
    // needs broker verbs + the package + an OVS-capable gate -- see the OVS
    // backlog entry in docs/eve-parity-roadmap.md.

    foreach (scandir("/sys/devices/virtual/net") as $interface) {
        if (preg_match('/^nat[0-9]+$/', $interface)) {
            $results[$interface] = $interface;
        }
    }

    // Listing pnet interfaces
    foreach (scandir("/sys/devices/virtual/net") as $interface) {
        if (preg_match('/^pnet[0-9]+$/', $interface)) {
            $results[$interface] = $interface;
        }
    }
    return $results;
}

function listNetwork_non_admin()
{
    $results = [];
    $results["bridge"] = "bridge";
    $results["dot1q"] = "dot1q";
    $results["router"] = "router";
    $results["wireless"] = "wireless";
    $results["internal"] = "internal";
    $results["internal2"] = "internal2";
    $results["internal3"] = "internal3";
    $results["private"] = "private";
    $results["private2"] = "private2";
    $results["private3"] = "private3";
    // ovs REMOVED from the advertised list (owner decision 2026-08-05). It could
    // never work on this line and was a trap: the user picked it, the canvas drew
    // the network, and nothing existed on the host -- the same "topology looks
    // correct but no bridge exists" failure fixed for internal/private. It is dead
    // TWO ways: no ovs-vsctl binary is installed, AND cli.php's addOvs/addOvsPort
    // call ovs-vsctl through raw exec() as www-data with no sudo and no broker
    // verb, so installing the package alone would still fail. Those exec() calls
    // are the last survivors of the pattern the broker replaced. Reinstating ovs
    // needs broker verbs + the package + an OVS-capable gate -- see the OVS
    // backlog entry in docs/eve-parity-roadmap.md.
    $clouds = yaml_parse_file("/opt/unetlab/html/includes/config.yml");
    $nat = $clouds["nat"];
    $cloud =  $clouds["cloud"];

    if ($nat == "0") {
        foreach (scandir("/sys/devices/virtual/net") as $interface) {
            if (preg_match('/^nat[0-9]+$/', $interface)) {
                $results[$interface] = $interface;
            }
        }
    } elseif ($nat == "1") {

    }

    if ($cloud == "0") {
        foreach (scandir("/sys/devices/virtual/net") as $interface) {
            if (preg_match('/^pnet[\d\w]+$/', $interface)) {
                $results[$interface] = $interface;
            }
        }
    }  elseif ($cloud == "1") {
        foreach (scandir("/sys/devices/virtual/net") as $interface) {
            if (preg_match('/^pnet[1-9]+$/', $interface)) {
                $results[$interface] = $interface;
            }
        }
    }
    elseif ($cloud == "2") {

    }
    return $results;
}

/**
 * Function to list all available icons.
 *
 * @return	Array						The list of icons
 */
function listNodeIcons()
{
    $results = [];
    foreach (scandir(BASE_DIR . "/html/images/icons") as $filename) {
        if (
            is_file(BASE_DIR . "/html/images/icons/" . $filename) &&
            preg_match('/^.+\.[png$\|jpg$]/', $filename)
        ) {
            $patterns[0] = '/^(.+)\.\(png$\|jpg$\)/'; // remove extension
            $replacements[0] = '$1';
            $name = preg_replace($patterns, $replacements, $filename);
            $results[$filename] = $name;
        }
    }
    return $results;
}

/**
 * Function to list all available images.
 *
 * @param   string  $t                  Type of image
 * @param   string  $p                  Template of image
 * @return  Array                       The list of images
 */
function listNodeImages($t, $p)
{
    $results = [];

    switch ($t) {
        default:
            break;
        case "iol":
            foreach (
                scandir(BASE_DIR . "/addons/iol/bin")
                as $name => $filename
            ) {
                if ($p == "iol") {
                    if (preg_match('/^.+\.bin$/', $filename)) {
                        $results[$filename] = $filename;
                    }
                } else {
                    // Case-INSENSITIVE platform-prefix match: lab templates store a
                    // lowercase platform (e.g. "i86bi_linux") but real IOL bin
                    // filenames are commonly mixed-case ("i86bi_Linux-L2-…"), so a
                    // case-sensitive ^prefix matched nothing and the image dropdown
                    // came up empty. preg_quote guards regex metachars in the name.
                    if (preg_match('/^' . preg_quote($p, '/') . '.*\.bin$/i', $filename)) {
                        $results[$filename] = $filename;
                    }
                }
            }
            break;
        case "qemu":
            foreach (scandir(BASE_DIR . "/addons/qemu") as $dir) {
                if (
                    is_dir(BASE_DIR . "/addons/qemu/" . $dir) &&
                    // case-insensitive + metachar-safe prefix match (see IOL note above)
                    preg_match('/^' . preg_quote($p, '/') . '-.+$/i', $dir)
                ) {
                    $results[$dir] = $dir;
                }
            }
            break;
        case "dynamips":
            foreach (scandir(BASE_DIR . "/addons/dynamips") as $filename) {
                if (
                    is_file(BASE_DIR . "/addons/dynamips/" . $filename) &&
                    preg_match('/^' . preg_quote($p, '/') . '-.+\.(image|bin)$/i', $filename)
                ) {
                    $results[$filename] = $filename;
                }
            }
            break;
        case "docker":
            // Local repo:tag list via the broker's read-only docker_image_ls
            // verb (Stage 5) — the same lines the old `docker images | sed`
            // pipe produced, minus the header row (refs mode has none).
            $resp = broker_docker_image_ls('refs');
            $o = (!empty($resp['ok']) && isset($resp['out'])) ? $resp['out'] : [];
            foreach ($o as $image) {
                $image = trim($image);
                if ($image === '') {
                    continue;
                }
                if ($p == "docker") {
                    $results[$image] = $image;
                } else {
                    if (stripos($image, $p) !== false) {   // case-insensitive
                        $results[$image] = $image;
                    }
                }
            }
            break;
        case "vpcs":
            $results[] = "";
            break;
    }
    return $results;
}

/**
 * Function to scale an image maintaining the aspect ratio.
 *
 * @param   string  $image              The image
 * @param   int     $width              New width
 * @param   int     $height             New height
 * @return  string                      The resized image
 */
function resizeImage($image, $width, $height)
{
    $img = new Imagick();
    $img->readimageblob($image);
    $img->setImageFormat("png");
    $original_width = $img->getImageWidth();
    $original_height = $img->getImageHeight();

    if ($width > 0 && $height == 0) {
        // Use width to scale
        if ($width < $original_width) {
            $new_width = $width;
            $new_height = ($original_height / $original_width) * $width;
            $new_height > 0 ? $new_height : ($new_height = 1); // Must be 1 at least
            $img->resizeImage(
                $new_width,
                $new_height,
                Imagick::FILTER_LANCZOS,
                1
            );
            return $img->getImageBlob();
        }
    } elseif ($width == 0 && $height > 0) {
        // Use height to scale
        if ($height < $original_height) {
            $new_width = ($original_width / $original_height) * $height;
            $new_width > 0 ? $new_width : ($new_width = 1); // Must be 1 at least
            $new_height = $height;
            $img->resizeImage(
                $new_width,
                $new_height,
                Imagick::FILTER_LANCZOS,
                1
            );
            return $img->getImageBlob();
        }
    } elseif ($width > 0 && $height > 0) {
        // No need to keep aspect ratio
        $img->resizeImage($width, $height, Imagick::FILTER_LANCZOS, 1);
        return $img->getImageBlob();
    } else {
        // No need to resize, return the original image
        return $image;
    }
}

function EthFormat2val($s)
{
    // check if format exist
    $format = [];
    $format["prefix"] = "e";
    $format["slotstart"] = 9999;
    $format["first"] = 0;
    $format["mod"] = 9999;
    $format["sep"] = 9999;
    preg_match("/(.*)\{(.*)\}(.*)\{(.*)\}/", $s, $m);
    if (!isset($m[4])) {
        preg_match("/(.*)\{(.*)\}/", $s, $m);
    }
    if (isset($m[1])) {
        $format["prefix"] = $m[1];
    }
    if (!isset($m[3]) || !isset($m[4])) {
        preg_match("/(\d+)/", $m[2], $n);
        if (isset($n[1])) {
            $format["first"] = $n[1];
        }
    } else {
        $format["slotstart"] = intval($m[2]);
        preg_match("/(\d+)\-(\d+)/", $m[4], $n);
        if (isset($n[1]) && isset($n[2])) {
            $format["first"] = intval($n[1]);
            $format["mod"] = intval($n[2]);
            $format["sep"] = $m[3];
        }
    }
    return $format;
}

function isExitConfigScript($templ)
{
    $p = yaml_parse_file(BASE_DIR . "/html/" . TPL_DIR . "/" . $templ . ".yml");
    if (isset($p["config_script"]) && $p["config_script"] != "") {
        return true;
    } else {
        return false;
    }
}

function getConfigScript($templ)
{
    $p = yaml_parse_file(BASE_DIR . "/html/" . TPL_DIR . "/" . $templ . ".yml");
    if (isset($p["config_script"]) && $p["config_script"] != "") {
        return $p["config_script"];
    } else {
        return "";
    }
}
