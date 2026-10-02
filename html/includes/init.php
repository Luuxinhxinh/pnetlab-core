<?php

// Include custom configuration
if (file_exists("includes/config.php")) {
    require_once "includes/config.php";
}
// Preview Code UIlegacy
$UIlegacy = 1;

$kvm_family = file_get_contents("/opt/unetlab/platform");
$hypervisor = file_get_contents("/opt/unetlab/hypervisor");
$config = yaml_parse_file("/opt/unetlab/html/includes/config.yml");
$port_console = $config["port"];
$port2nd_console = $config["port_2nd"];

if ($hypervisor == "none\n") {
    $hypervisor = "bare";
} else {
    $hypervisor = "vm";
}
$platform = "intel";
if ($kvm_family == "svm") {
    $platform = "amd";
}
// Preview Code UIlegacy
$UIlegacy = 1;

if (!defined("DATABASE")) {
    define("DATABASE", "/opt/unetlab/data/database.sdb");
}
if (!defined("FORCE_VM")) {
    define("FORCE_VM", "auto");
}
if (!defined("MODE")) {
    define("MODE", "multi-user");
}
if (!defined("SESSION")) {
    define("SESSION", "3600");
}
if (!defined("THEME")) {
    define("THEME", "default");
}
if (!defined("TIMEOUT")) {
    define("TIMEOUT", 25);
}
if (!defined("TIMEZONE")) {
    define("TIMEZONE", "Europe/Rome");
}
if (!defined("TEMPLATE_DISABLED")) {
    define("TEMPLATE_DISABLED", ".missing");
}
if (!defined("TPL_DIR")) {
    define("TPL_DIR", "templates/" . $platform);
}
if (!defined("HYPERVISOR")) {
    define("HYPERVISOR", $hypervisor);
}
if (!defined("PLATFORM")) {
    define("PLATFORM", $platform);
}
if (!defined("PORT")) {
    define("PORT", $port_console);
}
if (!defined("PORT_2ND")) {
    define("PORT_2ND", $port2nd_console);
}


// Define parameters

define("VERSION", "PNET");
define("BASE_DIR", "/opt/unetlab");
define("BASE_LAB", BASE_DIR . "/labs");
define("BASE_TMP", BASE_DIR . "/tmp");
define("BASE_THEME", "/themes/" . THEME);

if (!isset($node_templates)) {
    $node_templates = [];
    $templateFiles = scandir(BASE_DIR . "/html/" . TPL_DIR . "/");
    foreach ($templateFiles as $file) {
        if (preg_match("/(.+)\.yml/", $file, $match)) {
            $node_templates[$match[1]] = $match[1];
        }
    }
}
// Setting timezone
date_default_timezone_set(TIMEZONE);

require_once BASE_DIR . "/html/includes/constants/user_roles_cst.php";
require_once BASE_DIR . "/html/includes/constants/user_permission_cst.php";
require_once BASE_DIR . "/html/includes/constants/users_cst.php";
require_once BASE_DIR . "/html/includes/constants/lab_sessions_cst.php";
require_once BASE_DIR . "/html/includes/constants/node_sessions_cst.php";
require_once BASE_DIR . "/html/includes/constants/if_sessions_cst.php";
require_once BASE_DIR . "/html/includes/constants/control_cst.php";
require_once BASE_DIR . "/html/includes/models/model_basic.php";

// Include classes and functions

require_once BASE_DIR . "/html/includes/__lab.php";
require_once BASE_DIR . "/html/includes/__network.php";
require_once BASE_DIR . "/html/includes/__node.php";
require_once BASE_DIR . "/html/includes/__textobject.php";
require_once BASE_DIR . "/html/includes/__picture.php";
require_once BASE_DIR . "/html/includes/functions.php";
require_once BASE_DIR . "/html/includes/messages_en.php";
require_once BASE_DIR . "/html/includes/Parsedown.php";
require_once BASE_DIR . "/html/includes/exceptions/response.php";

require_once BASE_DIR . "/html/devices/interfc.php";
require_once BASE_DIR . "/html/devices/device.php";
require_once BASE_DIR . "/html/devices/functions.php";

require_once BASE_DIR . "/html/includes/cli.php";

?>
