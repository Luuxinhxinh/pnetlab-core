<?php

use App\Exceptions\FinishException;

require_once __DIR__ . '/broker.php';
require_once __DIR__ . '/cluster.php';
require_once __DIR__ . '/lab-session-access.php';

$db = null;
function checkDatabase()
{
    // Database connection
    try {
        //$db = new PDO('sqlite:'.DATABASE);
        if ($GLOBALS["db"] == null) {
            // Cluster satellite: no local mysqld — the engine connects to the
            // MASTER's DB with the per-satellite credential written at join
            // time by pnet-satellite-join. Masters never have this file.
            $dbHost = 'localhost';
            $dbPass = 'pnetlab';
            if (is_readable('/etc/pnetlab/cluster-db.conf')) {
                $cdb = json_decode(file_get_contents('/etc/pnetlab/cluster-db.conf'), true);
                if (is_array($cdb) && !empty($cdb['host']) && !empty($cdb['pass'])) {
                    $dbHost = $cdb['host'];
                    $dbPass = $cdb['pass'];
                }
            }
            $db = new PDO(
                "mysql:host=$dbHost;dbname=pnetlab_db",
                "pnetlab",
                $dbPass
            );
            $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
            $GLOBALS["db"] = $db;
        }

        return $GLOBALS["db"];
    } catch (Exception $e) {
        error_log(date("M d H:i:s ") . (string) $e);
        return false;
    }
}

/** Helper for load model */
$models = [];
function loadModel($name)
{
    if (!isset($GLOBALS["models"][$name])) {
        $modelName = BASE_DIR . "/html/includes/models/" . $name . ".php";
        if (is_file($modelName)) {
            require_once $modelName;
            $GLOBALS["models"][$name] = new $name();
        } else {
            throw new Exception($modelName . " is not exist");
        }
    }
    return $GLOBALS["models"][$name];
}

/**
 * Function to check user expiration.
 *
 * @param	PDO		$db					PDO object for database connection
 * @param	string	$username			Username
 * @return	bool						True if valid
 */
function checkUserExpiration($db, $username)
{
    $now = time() + SESSION;
    try {
        $query =
            "SELECT COUNT(*) AS rows FROM users WHERE username = :username AND (expiration < 0 OR expiration >= :expiration);";
        $statement = $db->prepare($query);
        $statement->bindParam(":expiration", $now, PDO::PARAM_INT);
        $statement->bindParam(":username", $username, PDO::PARAM_STR);
        $statement->execute();
        $result = $statement->fetch();
        if ($result["rows"] == 1) {
            return true;
        } else {
            return false;
        }
    } catch (Exception $e) {
        error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][90024]);
        error_log(date("M d H:i:s ") . (string) $e);
        return false;
    }
}

function updateOnlineTime($pod)
{
    $db = checkDatabase();
    $query = "UPDATE users SET online_time=:now WHERE pod = :pod";
    $statement = $db->prepare($query);
    $statement->execute(["now" => time(), "pod" => $pod]);
}

/** Return this process's lock registry by reference. */
function &pnetHeldLocks()
{
    static $locks = [];
    return $locks;
}

/**
 * Acquire an advisory lock with bounded waiting and process-local reentrancy.
 *
 * Lock files are persistent: unlinking an advisory-lock path can split contenders
 * across two inodes.  The .flock suffix also keeps the legacy stopall cleanup from
 * deleting a live lock while older appliances transition to this implementation.
 */
function pnetAcquireLock($path)
{
    $locks =& pnetHeldLocks();
    if (isset($locks[$path])) {
        $locks[$path]['depth']++;
        return true;
    }

    $handle = @fopen($path, 'c+b');
    if ($handle === false) {
        throw new RuntimeException('Cannot open lock file: ' . $path);
    }
    // A root CLI wrapper and the www-data API may contend on the same lab.
    // Match the containing lab directory's group before restricting the mode.
    @chgrp($path, filegroup(dirname($path)));
    @chmod($path, 0660);

    $deadline = microtime(true) + max(0, (float) TIMEOUT);
    do {
        if (flock($handle, LOCK_EX | LOCK_NB)) {
            $locks[$path] = ['handle' => $handle, 'depth' => 1];
            return true;
        }
        usleep(random_int(10000, 50000));
    } while (microtime(true) < $deadline);

    fclose($handle);
    throw new RuntimeException('Timed out acquiring lock: ' . $path);
}

/** Release only a lock held by this process. */
function pnetReleaseLock($path)
{
    $locks =& pnetHeldLocks();
    if (!isset($locks[$path])) {
        return true;
    }
    if (--$locks[$path]['depth'] > 0) {
        return true;
    }

    $handle = $locks[$path]['handle'];
    unset($locks[$path]);
    $unlocked = flock($handle, LOCK_UN);
    fclose($handle);
    return $unlocked;
}

/**
 * Function to lock a file.
 *
 * @param   string  $file               File to lock
 * @return  bool                        True if locked
 * @throws  RuntimeException            Lock cannot be acquired before TIMEOUT
 */
function lockFile($file)
{
    return pnetAcquireLock($file . '.lock.flock');
}

/**
 * Function to unlock a file.
 *
 * @param   string  $file               File to lock
 * @return  bool                        True if unlocked
 */
function unlockFile($file)
{
    return pnetReleaseLock($file . '.lock.flock');
}

function lockSession($labSession)
{
    return pnetAcquireLock(BASE_LAB . '/' . $labSession . '.lock.flock');
}

/**
 * Function to unlock a file.
 *
 * @param   string  $file               File to lock
 * @return  bool                        True if unlocked
 */
function unlockSession($labSession)
{
    return pnetReleaseLock(BASE_LAB . '/' . $labSession . '.lock.flock');
}

function Ctrl_get($name, $default = "")
{
    try {
        $db = checkDatabase();
        $query = "SELECT * FROM control WHERE control_name=:control_name";
        $statement = $db->prepare($query);
        $statement->execute(["control_name" => $name]);
        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (isset($result[0])) {
            return $result[0][CONTROL_VALUE];
        } else {
            return $default;
        }
    } catch (Exception $th) {
        return $default;
    }
}

/**
 * Write (upsert) a control_name/control_value row. Counterpart to Ctrl_get().
 * This is a plain www-data-owned MySQL write (the `control` table is not a
 * root resource), so it needs no broker verb — same trust boundary as any
 * other row www-data already owns in pnetlab_db.
 *
 * @param   string  $name   One of the CTRL_* constants.
 * @param   string  $value  Value to store (caller is responsible for
 *                          validating/typing it before calling this).
 * @return  bool            True on success.
 */
function Ctrl_set($name, $value)
{
    try {
        $db = checkDatabase();
        $query = "INSERT INTO control (control_name, control_value) VALUES (:control_name, :control_value) "
            . "ON DUPLICATE KEY UPDATE control_value = VALUES(control_value)";
        $statement = $db->prepare($query);
        $statement->execute(["control_name" => $name, "control_value" => $value]);
        return true;
    } catch (Exception $th) {
        return false;
    }
}

/**
 * Effective idle/session timeout in seconds. Falls back to the hardcoded
 * SESSION constant (includes/init.php) when no admin override is stored in
 * the control table yet, so a fresh install behaves exactly as before this
 * setting existed. Used both when minting the login cookie (api.php) and on
 * every authenticated request's sliding renewal (updateUserCookie() below) —
 * the two must stay in lock-step or the renewal would fight the login value.
 *
 * @return  int     Timeout in seconds (always >= 1).
 */
function getSessionTimeoutSeconds()
{
    $seconds = (int) Ctrl_get(CTRL_SESSION_TIMEOUT, SESSION);
    return $seconds > 0 ? $seconds : (int) SESSION;
}

/**
 * Function to update user session (expiration).
 *
 * @param   PDO     $db                 PDO object for database connection
 * @param   string  $username           Username
 * @param   string  $cookie             Session cookie
 * @return  0                           0 means ok
 */
function updateUserCookie($db, $username, $cookie)
{
    try {
        $ip = $_SERVER["REMOTE_ADDR"];
        // Sliding renewal: every authenticated request pushes expiry forward by
        // the CONFIGURED idle timeout (admin override via the control table,
        // falling back to the SESSION constant) — see getSessionTimeoutSeconds().
        $now = time() + getSessionTimeoutSeconds();
        $query =
            "UPDATE users SET cookie = :cookie, session = :session, ip = :ip WHERE username = :username;";
        $statement = $db->prepare($query);
        $statement->bindParam(":cookie", $cookie, PDO::PARAM_STR);
        $statement->bindParam(":session", $now, PDO::PARAM_INT);
        $statement->bindParam(":username", $username, PDO::PARAM_STR);
        $statement->bindParam(":ip", $ip, PDO::PARAM_STR);
        $statement->execute();
        return 0;
    } catch (Exception $e) {
        error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][90017]);
        error_log(date("M d H:i:s ") . (string) $e);
        return 90017;
    }
}

/**
 * Function to update user folder.
 *
 * @param   PDO     $db                 PDO object for database connection
 * @param   string  $cookie             Session cookie
 * @param   string  $folder             Last seen folder
 * @return  0                           0 means ok
 */
function updateUserFolder($pod, $folder)
{
    try {
        $db = checkDatabase();
        $query = "UPDATE users SET folder = :folder WHERE pod = :pod;";
        $statement = $db->prepare($query);
        $statement->bindParam(":pod", $pod, PDO::PARAM_STR);
        $statement->bindParam(":folder", $folder, PDO::PARAM_STR);
        $statement->execute();
        return 0;
    } catch (Exception $e) {
        error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][90033]);
        error_log(date("M d H:i:s ") . (string) $e);
        return 90033;
    }
}

/**
 * Function to update POD lab.
 *
 * @param   PDO     $db                 PDO object for database connection
 * @param   string  $cookie             Session cookie
 * @param   string  $lab				Running lab
 * @return  0                           0 means ok
 */

function html5_checkDatabase()
{
    // Database connection
    try {
        //$db = new PDO('sqlite:'.DATABASE);
        $db = new PDO(
            "mysql:host=127.0.0.1;dbname=guacdb",
            "guacuser",
            "pnetlab"
        );
        $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        return $db;
    } catch (Exception $e) {
        error_log(date("M d H:i:s ") . "ERROR: " . $GLOBALS["messages"][90003]);
        error_log(date("M d H:i:s ") . (string) $e);
        return false;
    }
}

function html5AddSession(
    $db,
    $name,
    $type,
    $port,
    $userid,
    $hostname = null,
    $servicePort = null,
    $username = null,
    $password = null,
    $onresize = null,
    $template = null,
    $backspace = null,
    $terminaltype = null

) {
    if ($servicePort === null) {
        $servicePort = $port;
    }
    if ($hostname === null) {
        $hostname = "127.0.0.1";
    }

    $connectionId = $port . $userid;

    $query =
        "delete from guacamole_connection where connection_id=:connection_id";
    $statement = $db->prepare($query);
    $statement->execute(["connection_id" => $connectionId]);

    // (Retired: the dead 'bash'→telnet Guacamole branch. html5AddSession is only
    // ever called for the VNC capture lane now; telnet/serial consoles use the xterm
    // web console + token_mint.php telnet bridge, not guacdb.)
    if ($type == "rdp-tls") {
        $query =
            "replace into guacamole_connection ( connection_id , connection_name , protocol ) values ( " .
            $connectionId .
            ",'" .
            $name .
            "','" .
            "rdp" .
            "');";
    } else {
        $query =
            "replace into guacamole_connection ( connection_id , connection_name , protocol ) values ( " .
            $connectionId .
            ",'" .
            $name .
            "','" .
            $type .
            "');";
    }
    $statement = $db->prepare($query);
    $statement->execute();

    $query =
        "replace into guacamole_connection_permission ( entity_id, connection_id, permission ) values ( " .
        ($userid + 1000) .
        " , " .
        $connectionId .
        ", 'READ' );";
    $statement = $db->prepare($query);
    $statement->execute();

    if ($type == "rdp") {
        $connectionData = [
            "( " . $connectionId . ",'ignore-cert','true' )",
            "( " . $connectionId . ", 'hostname', '" . $hostname . "' )",
            "( " . $connectionId . ", 'port', '" . $servicePort . "' )",
            "( " . $connectionId . ",'create-drive-path','true' )",
            "( " . $connectionId . ",'enable-drive','true' )",
            "( " . $connectionId . ",'enable-printing','false' )",
            "( " .
            $connectionId .
            ",'drive-path','/tmp/" .
            $connectionId .
            "' )",
            "( " . $connectionId . ",'disable-glyph-caching', 'true' )",
        ];

        if ($password != null && $username != null) {
            $connectionData[] =
                "( " . $connectionId . ",'disable-auth','false' )";
            $connectionData[] =
                "( " . $connectionId . ",'username', '" . $username . "' )";
            $connectionData[] =
                "( " . $connectionId . ",'password', '" . $password . "' )";
            $connectionData[] = "( " . $connectionId . ",'security', 'any' )";
            $connectionData[] =
                "( " .
                $connectionId .
                ",'resize-method', '" .
                $onresize .
                "' )";
        } else {
            $connectionData[] = "( " . $connectionId . ",'security', 'any' )";
            $connectionData[] =
                "( " .
                $connectionId .
                ",'resize-method', '" .
                $onresize .
                "' )";
            $connectionData[] =
                "( " . $connectionId . ",'disable-auth','true' )";
        }
    }
    if ($type == "rdp-tls") {
        $connectionData = [
            "( " . $connectionId . ",'ignore-cert','true' )",
            "( " . $connectionId . ", 'hostname', '" . $hostname . "' )",
            "( " . $connectionId . ", 'port', '" . $servicePort . "' )",
            "( " . $connectionId . ",'create-drive-path','true' )",
            "( " . $connectionId . ",'enable-drive','true' )",
            "( " . $connectionId . ",'enable-printing','false' )",
            "( " .
            $connectionId .
            ",'drive-path','/tmp/" .
            $connectionId .
            "' )",
            "( " . $connectionId . ",'disable-glyph-caching', 'true' )",
        ];

        if ($password != null && $username != null) {
            $connectionData[] =
                "( " . $connectionId . ",'disable-auth','false' )";
            $connectionData[] =
                "( " . $connectionId . ",'username', '" . $username . "' )";
            $connectionData[] =
                "( " . $connectionId . ",'password', '" . $password . "' )";
            $connectionData[] = "( " . $connectionId . ",'security', 'tls' )";
            $connectionData[] =
                "( " . $connectionId . ",'resize-method', 'display-update' )";
        } else {
            $connectionData[] = "( " . $connectionId . ",'security', 'tls' )";
            $connectionData[] =
                "( " . $connectionId . ",'resize-method', 'display-update' )";
            $connectionData[] =
                "( " . $connectionId . ",'disable-auth','true' )";
        }
    }

    if ($type == "spice") {
        $connectionData[] =
            "( " . $connectionId . ", 'hostname', '" . $hostname . "' )";
        $connectionData[] =
            "( " . $connectionId . ", 'port', '" . $servicePort . "' )";
        $connectionData[] =
            "( " . $connectionId . ",'file-transfer-create-folder','true' )";
        $connectionData[] = "( " . $connectionId . ",'file-transfer','true' )";
        $connectionData[] =
            "( " .
            $connectionId .
            ",'file-directory', '/tmp/" .
            $connectionId .
            "' )";
        $connectionData[] = "( " . $connectionId . ",'enable-audio','true' )";
        $connectionData[] =
            "( " . $connectionId . ",'enable-audio-input','true' )";
        $connectionData[] =
            "( " . $connectionId . ",'server-layout','fr_fr_azerty' )";
    }

    if ($type == "telnet" || $type == "ssh" || $type == "bash") {
        $html5_terminal_settings = yaml_parse_file("/opt/unetlab/html/includes/html5_terminal_config.yml");
        $backgroundColor = $html5_terminal_settings["backgroundColor"];
        $textColor = $html5_terminal_settings["textColor"];
        $html5_font_size =  $html5_terminal_settings["fontsize"];
        $html5_font_name =  $html5_terminal_settings["fontname"];
        $html5_backspace =  $html5_terminal_settings["backspace"];
        $html5_terminaltype =  $html5_terminal_settings["terminaltype"];
        if ($html5_terminaltype != $terminaltype){
            $connectionData[] =
            "( " . $connectionId . ",'terminal_type','" . $terminaltype . "' )";
        }
        else {
            $connectionData[] =
            "( " . $connectionId . ",'terminal_type','" . $html5_terminaltype . "' )";
        }
        if ($html5_backspace != $backspace){
            $connectionData[] =
            "( " . $connectionId . ",'backspace'," . $backspace . " )";
        }
        else {
            $connectionData[] =
            "( " . $connectionId . ",'backspace'," .$html5_backspace ." )";
        }
        $connectionData[] =
            "( " . $connectionId . ", 'hostname', '" . $hostname . "' )";
        $connectionData[] =
            "( " . $connectionId . ", 'port', '" . $servicePort . "' )";
        if ($password != null && $username != null) {
            $connectionData[] =
                "( " . $connectionId . ",'username', '" . $username . "' )";
            $connectionData[] =
                "( " . $connectionId . ",'password', '" . $password . "' )";
        }
        $connectionData[] =
            "( " . $connectionId . ",'color-scheme', ' foreground : color".$textColor."; background: color".$backgroundColor.";' )";
        $connectionData[] =
            "( " . $connectionId . ",'font-size','" . $html5_font_size . "'  )";
        $connectionData[] =
            "( " . $connectionId . ",'font-name','" . $html5_font_name . "'  )";
        $connectionData[] = "( " . $connectionId . ",'enable-sftp','true' )";
        $connectionData[] =
            "( " . $connectionId . ",'sftp-root-directory','/tmp/' )";
    }
    if ($type == "vnc") {
        $connectionData[] =
            "( " . $connectionId . ", 'hostname', '" . $hostname . "' )";
        $connectionData[] =
            "( " . $connectionId . ", 'port', '" . $servicePort . "' )";
        if ($password != null && $username != null) {
            $connectionData[] =
                "( " . $connectionId . ",'username', '" . $username . "' )";
            $connectionData[] =
                "( " . $connectionId . ",'password', '" . $password . "' )";
        }
    }

    $query =
        "insert into guacamole_connection_parameter ( connection_id , parameter_name , parameter_value ) values " .
        implode(",", $connectionData);
    $statement = $db->prepare($query);
    $statement->execute();
}

function updateUserToken($username, $password, $pod)
{
    // PNetLab jammy Slice-5 cutover: the in-browser console now opens the built-in
    // web console (telnet/vnc/rdp via guacamole-lite/websockify/bridge), so there
    // is no Tomcat Guacamole webapp to provision an SSO token for. This used to
    // POST http://127.0.0.1/html5/api/tokens (Tomcat) and store the returned
    // authToken in the `html5` table for the /html5/ guac link. With Tomcat
    // stripped that endpoint is gone; calling it during login would fail and
    // (being ahead of the auth cookie in LoginController) break login. The web
    // console mints its own short-lived tokens, and the `html5` token is no longer
    // read (see device.php::getGuacConsoleLink, now returning the web console URL),
    // so this is a safe no-op. Kept as a stub so existing callers stay valid.
    return;
}

function getHtml5Token($userid)
{
    $db = checkDatabase();
    $query = "select token from html5 where pod = " . $userid . " ;";
    $statement = $db->prepare($query);
    $statement->execute();
    $result = $statement->fetch();
    if ($result === false) { return ''; }
    return $result["token"];
}

function style_to_object($style)
{
    $return = [];
    $divstyle = explode(";", $style);
    array_pop($divstyle);
    foreach ($divstyle as $param) {
        $key = trim(explode(":", $param)[0]);
        $value = trim(explode(":", $param)[1]);
        $return[$key] = $value;
    }
    return $return;
}
function data_to_textobjattr($data)
{
    $return = [];
    $text = "";
    $dom = new DOMDocument();
    if (preg_match("/style/i", $data)) {
        $dom->loadHTML(htmlspecialchars_decode($data));
    } else {
        if (preg_match("/RECT/i", base64_decode($data))) {
            // OLD RECT STYLE
            return -1;
        }
        $dom->loadHTML(base64_decode($data));
    }
    $pstyle = style_to_object(
        $dom->documentElement
            ->getElementsByTagName("div")
            ->item(0)
            ->getAttribute("style")
    );
    $doc = $dom->documentElement->getElementsByTagName("p")->item(0);
    $childs = $doc->childNodes;
    for ($i = 0; $i < $childs->length; $i++) {
        $text .= $dom->saveXML($childs->item($i));
    }
    $tstyle = style_to_object(
        $dom->documentElement
            ->getElementsByTagName("p")
            ->item(0)
            ->getAttribute("style")
    );
    $return["text"] = $text;
    $return["top"] = preg_replace("/px/", "", $pstyle["top"]);
    $return["left"] = preg_replace("/px/", "", $pstyle["left"]);
    $return["fontColor"] = $tstyle["color"];
    $return["fontWeight"] = $tstyle["font-weight"];
    $return["bgColor"] = $tstyle["background-color"];
    $return["fontSize"] = preg_replace("/px/", "", $tstyle["font-size"]);
    $return["zindex"] = $pstyle["z-index"];
    if (isset($pstyle["transform"])) {
        $return["transform"] = $pstyle["transform"];
    } else {
        $return["transform"] = "rotate(0deg)";
    }
    return $return;
}
function dataToCircleAttr($data)
{
    $return = [];
    $p = xml_parser_create();
    if (preg_match("/style/i", $data)) {
        xml_parse_into_struct(
            $p,
            htmlspecialchars_decode($data),
            $vals,
            $index
        );
    } else {
        xml_parse_into_struct($p, base64_decode($data), $vals, $index);
    }
    $svg = $vals[$index["SVG"][0]];
    $style = style_to_object($vals[$index["DIV"][0]]["attributes"]["STYLE"]);
    $circle = $vals[$index["ELLIPSE"][0]];
    $return["borderWidth"] = $circle["attributes"]["STROKE-WIDTH"];
    $return["stroke"] = $circle["attributes"]["STROKE"];
    $return["bgcolor"] = $circle["attributes"]["FILL"];
    $return["cx"] = $circle["attributes"]["CX"];
    $return["cy"] = $circle["attributes"]["CY"];
    $return["rx"] = $circle["attributes"]["RX"];
    $return["ry"] = $circle["attributes"]["RY"];
    $return["top"] = preg_replace("/px/", "", $style["top"]);
    $return["left"] = preg_replace("/px/", "", $style["left"]);
    $return["width"] = preg_replace("/px/", "", $style["width"]);
    $return["height"] = preg_replace("/px/", "", $style["height"]);
    $return["svgWidth"] = $svg["attributes"]["WIDTH"];
    $return["svgHeight"] = $svg["attributes"]["HEIGHT"];
    $return["zindex"] = $style["z-index"];
    if (isset($circle["attributes"]["STROKE-DASHARRAY"])) {
        $return["strokeDashArray"] = $circle["attributes"]["STROKE-DASHARRAY"];
    } else {
        $return["strokeDashArray"] = "0,0";
    }
    if (isset($style["transform"])) {
        $return["transform"] = $style["transform"];
    } else {
        $return["transform"] = "rotate(0deg)";
    }
    return $return;
}
function datatoSquareAttr($data)
{
    $return = [];
    $p = xml_parser_create();
    if (preg_match("/style/i", $data)) {
        xml_parse_into_struct(
            $p,
            preg_replace('/"=""/', "", htmlspecialchars_decode($data)),
            $vals,
            $index
        );
    } else {
        xml_parse_into_struct(
            $p,
            preg_replace('/"=""/', "", base64_decode($data)),
            $vals,
            $index
        );
    }
    $svg = $vals[$index["SVG"][0]];
    $square = $vals[$index["RECT"][0]];
    $style = style_to_object($vals[$index["DIV"][0]]["attributes"]["STYLE"]);
    $return["top"] = preg_replace("/px/", "", $style["top"]);
    $return["left"] = preg_replace("/px/", "", $style["left"]);
    $return["width"] = preg_replace("/px/", "", $style["width"]);
    $return["height"] = preg_replace("/px/", "", $style["height"]);
    $return["svgWidth"] = $svg["attributes"]["WIDTH"];
    $return["svgHeight"] = $svg["attributes"]["HEIGHT"];
    $return["zindex"] = $style["z-index"];
    $return["stroke"] = $square["attributes"]["STROKE"];
    if (isset($square["attributes"]["STROKE-DASHARRAY"])) {
        $return["strokeDashArray"] = $square["attributes"]["STROKE-DASHARRAY"];
    } else {
        $return["strokeDashArray"] = "0,0";
    }
    $return["borderWidth"] = $square["attributes"]["STROKE-WIDTH"];
    $return["bgcolor"] = $square["attributes"]["FILL"];
    if (isset($style["transform"])) {
        $return["transform"] = $style["transform"];
    } else {
        $return["transform"] = "rotate(0deg)";
    }
    return $return;
}

/** EVE_STORE Whireshark */

function getDockerIp()
{
    $cmd = "ifconfig docker0 | grep inet";
    exec($cmd, $o, $rc);
    foreach ($o as $line) {
        if (
            preg_match(
                "/inet\s(addr:)?(?<ip>[0-9]+.[0-9]+.[0-9]+.[0-9]+)/",
                $line,
                $matches
            )
        ) {
            return $matches["ip"];
        }
    }
    return "";
}

function getWiresharkPort($db)
{
    $query = "SELECT ws_port FROM wiresharks";
    $statement = $db->prepare($query);
    $statement->execute();
    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    $portColumn = array_column($result, "ws_port", "ws_port");
    // Time-rotating base instead of 60000+count: with count-based allocation
    // a capture->close->capture cycle always re-issued the SAME port (hence
    // the same docker0 ws_ip), and guacd clients of the torn-down capture —
    // which linger up to ~45 s ("User is not responding") — clobbered the new
    // container's xrdp session (black capture pane). 100 ms ticks over a
    // 5000-port window (60000-64999, ~8 min wrap) keep new containers off
    // recently-used addresses; the DB check still skips concurrently active
    // rows, and ports ending in %255==0 are skipped (would yield a .0 IP).
    $port = 60000 + ((int) (microtime(true) * 10) % 5000);
    while (isset($portColumn[$port]) || $port % 255 === 0) {
        $port++;
    }
    return $port;
}

// Ensure the wiresharks table has the ws_ethidx column (per-capture interface
// index inside the shared per-lab container). MySQL 8 has no
// "ADD COLUMN IF NOT EXISTS", so guard via information_schema. Idempotent.
function ensureWiresharkSchema($db)
{
    $q = $db->query(
        "SELECT COUNT(*) FROM information_schema.COLUMNS " .
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wiresharks' " .
        "AND COLUMN_NAME = 'ws_ethidx'"
    );
    if ($q && (int) $q->fetchColumn() === 0) {
        $db->exec("ALTER TABLE wiresharks ADD COLUMN ws_ethidx INT DEFAULT NULL");
    }
}

// Lowest free per-lab capture interface index (0,1,2,...) -> in-container cap<idx>.
function getWiresharkEthIdx($db, $tenant, $lab_session)
{
    $st = $db->prepare(
        "SELECT ws_ethidx FROM wiresharks WHERE ws_tenant=:t AND ws_lab=:l AND ws_ethidx IS NOT NULL"
    );
    $st->execute(["t" => $tenant, "l" => $lab_session]);
    $used = array_map("intval", array_column($st->fetchAll(PDO::FETCH_ASSOC), "ws_ethidx"));
    $used = array_flip($used);
    $idx = 0;
    while (isset($used[$idx])) {
        $idx++;
    }
    return $idx;
}

/**
 * Effective tap to tc-mirror for a capture of $node_id:$interface_id.
 *
 *  • Master-hosted node -> its own tap (vunl<ns>_<iface> / ser…).
 *  • Satellite-hosted node on a point-to-point link whose PEER is on the master
 *    -> the PEER's master tap. A cross-host link is bridged over VXLAN and
 *    decapped before the tap, so the master end carries the IDENTICAL L2 frames;
 *    capturing it keeps the wireshark container + RDP display entirely on the
 *    master (no cross-host mirror tunnel needed).
 *  • Otherwise (intra-satellite p2p, satellite<->satellite, or a multi-access
 *    segment) -> not capturable from the master; ok=false with a message.
 *
 * Returns ['ok'=>bool, 'tap'=>string|null, 'why'=>string, 'redirected'=>bool].
 */
function captureMirrorTap($lab, $node_id, $interface_id)
{
    $nodes = $lab->getNodes();
    $node = isset($nodes[$node_id]) ? $nodes[$node_id] : null;
    if (!$node) {
        return ['ok' => false, 'tap' => null, 'why' => 'Node is undefined', 'redirected' => false];
    }
    $ifaces = $node->getInterfaces();
    $iface = isset($ifaces[$interface_id]) ? $ifaces[$interface_id] : null;
    if (!$iface) {
        return ['ok' => false, 'tap' => null, 'why' => 'Interface is undefined', 'redirected' => false];
    }
    $ownTap = ($iface->getNType() == 'serial' ? 'ser' : 'vunl')
        . $node->getSession() . '_' . $interface_id;

    if ((int) cluster_session_host($lab, $node_id) <= 0) {
        return ['ok' => true, 'tap' => $ownTap, 'why' => '', 'redirected' => false];
    }

    // Satellite node: redirect to a master peer on the same point-to-point network.
    $net = (int) $iface->getNetworkId();
    if ($net <= 0) {
        return ['ok' => false, 'tap' => null,
                'why' => 'Capture needs a connected interface', 'redirected' => false];
    }
    $members = [];
    foreach ($nodes as $nid => $n) {
        foreach ($n->getInterfaces() as $iid => $if) {
            if ((int) $if->getNetworkId() === $net) {
                $members[] = ['node_id' => (int) $nid, 'iface_id' => (int) $iid,
                              'if' => $if, 'node' => $n];
            }
        }
    }
    if (count($members) !== 2) {
        return ['ok' => false, 'tap' => null,
                'why' => 'Capture on a satellite-hosted node is supported only on a '
                       . 'point-to-point link to a master node — capture this segment '
                       . 'from a master-side interface instead.', 'redirected' => false];
    }
    $peer = null;
    foreach ($members as $m) {
        if ($m['node_id'] === (int) $node_id && $m['iface_id'] === (int) $interface_id) continue;
        $peer = $m;
    }
    if ($peer === null) {
        return ['ok' => false, 'tap' => null, 'why' => 'Could not resolve the link peer',
                'redirected' => false];
    }
    if ((int) cluster_session_host($lab, $peer['node_id']) > 0) {
        return ['ok' => false, 'tap' => null,
                'why' => 'Capture between two satellite-hosted nodes is not supported yet — '
                       . 'capture from a master-side interface instead.', 'redirected' => false];
    }
    $peerTap = ($peer['if']->getNType() == 'serial' ? 'ser' : 'vunl')
        . $peer['node']->getSession() . '_' . $peer['iface_id'];
    return ['ok' => true, 'tap' => $peerTap, 'why' => '', 'redirected' => true];
}

function addWireshark($lab, $node_id, $interface_id)
{
    // Entry validation: node_id/interface_id flow into $dockerName -> exec().
    // Reject shell metacharacters here so the fix is local, not dependent on the
    // int-column SQL coercion being a reliable gate (matches addWinboxSystem).
    secureIdent($node_id, "node id");
    secureIdent($interface_id, "interface id");
    if ($interface_id === "" || $node_id === "") {
        throw new Exception("Missing data");
    }
    // A satellite-hosted node's tap lives on the satellite, but a cross-host
    // point-to-point link is bridged over VXLAN and decapped before the master
    // peer's tap — so we capture that master tap instead (container + RDP stay on
    // the master). Unsupported cases throw a clear message here.
    $capChk = captureMirrorTap($lab, $node_id, $interface_id);
    if (!$capChk['ok']) {
        throw new Exception($capChk['why']);
    }
    $lab_session = $lab->getSession();
    if ($lab_session == null) {
        throw new Exception("No Lab Session");
    }

    $tenant = $lab->getTenant();

    $db = checkDatabase();
    ensureWiresharkSchema($db);

    $query =
        "SELECT * FROM wiresharks WHERE ws_tenant=:ws_tenant AND ws_lab=:ws_lab AND ws_node=:ws_node AND ws_if=:ws_if";
    $statement = $db->prepare($query);
    $statement->execute([
        "ws_tenant" => $tenant,
        "ws_lab" => $lab_session,
        "ws_node" => $node_id,
        "ws_if" => $interface_id,
    ]);

    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    if (count($result) == 0) {
        $node = $lab->getNodes()[$node_id];
        if (!$node) {
            throw new Exception("Undefine node");
        }
        $interface = $node->getInterfaces()[$interface_id];
        if (!$interface) {
            throw new Exception("Undefine Interface");
        }

        $network_id = $interface->getNetworkId();
        $node_name = $node->getName();
        $interface_name = $interface->getName();

        $node_session = $node->getSession();

        // ONE capture container PER capture (interface) — the eve-wireshark RDP
        // model. Each row gets its OWN docker0 IP/port; guacd (token_mint's rdp
        // capture lane) dials ws_ip:3389 to render that capture's Wireshark over
        // RDP. (The old KasmVNC build shared one container per lab + ws_ethidx;
        // per-capture containers give automatic stream separation instead.)
        $dockerName = "Capture_" . $tenant . "_" . $lab_session . "_" . $node_session . "_" . $interface_id;

        $port = getWiresharkPort($db);
        $oct4 = $port % 255;
        $oct3 = 200 + (floor($port / 255) % 55);

        $dockerIp = getDockerIp();
        $dockerIp = explode(".", trim($dockerIp));

        $oct1 = isset($dockerIp[0]) ? $dockerIp[0] : 10;
        $oct2 = isset($dockerIp[1]) ? $dockerIp[1] : 178;

        $ipAddress = $oct1 . "." . $oct2 . "." . $oct3 . "." . $oct4;

        $query = 'INSERT INTO wiresharks (ws_tenant, ws_lab, ws_node, ws_if, ws_net, ws_node_name, ws_if_name, ws_dc_name, ws_port, ws_ip)
					VALUES (:ws_tenant, :ws_lab, :ws_node, :ws_if, :ws_net, :ws_node_name, :ws_if_name, :ws_dc_name, :ws_port, :ws_ip)';
        $statement = $db->prepare($query);
        $statement->execute([
            "ws_tenant" => $tenant,
            "ws_lab" => $lab_session,
            "ws_node" => $node_id,
            "ws_if" => $interface_id,
            "ws_net" => $network_id,
            "ws_node_name" => $node_name,
            "ws_if_name" => $interface_name,
            "ws_dc_name" => $dockerName,
            "ws_port" => $port,
            "ws_ip" => $ipAddress,
        ]);
    }
}

function addWinboxSystem($lab, $node_id, $interface_id){
	secureIdent($node_id, "node id");
	secureIdent($interface_id, "interface id");
	if ($interface_id === '' || $node_id === '') throw new Exception('Missing data');
	// v1 cluster cut: the winbox container + span veth live on the node's host
	if (cluster_session_host($lab, $node_id) > 0) {
		throw new Exception('Winbox is not yet supported on satellite-hosted nodes');
	}

	$lab_session = $lab->getSession();
	$host_session = $lab->getHost();
	if ($lab_session == null) throw new Exception('No Lab Session');

	$nets = $lab->getNetworks();
	$node = $lab->getNodes()[$node_id];
	$node_session = $node->getSession();
	if (!$node) throw new Exception('Node is undefined');
	$interface = $node->getInterfaces()[0];
	if (!$interface) throw new Exception('Interface is undefined');

	$tenant = $lab->getTenant();

	$db=checkDatabase();

	$query = 'SELECT * FROM wiresharks WHERE ws_tenant=:ws_tenant AND ws_lab=:ws_lab AND ws_node=:ws_node AND ws_if=:ws_if';
	$statement = $db->prepare($query);
	$statement->execute([
		'ws_tenant' => $tenant,
		'ws_lab' => $lab_session,
		'ws_node' => $node_id,
		'ws_if' => $interface_id,
	]);

	$result = $statement->fetchAll(PDO::FETCH_ASSOC);
	if (count($result) > 0) {
		$result = $result[0];
		$network_id = $result['ws_net'];
		$node_name = $result['ws_node_name'];
		$interface_name = $result['ws_if_name'];
		$uniqueId = $tenant . '_' . $lab_session . '_' . $node_session . '_' . $interface_id;
		$dockerName = 'Capture_' . $uniqueId;
		$port = $result['ws_port'];
		$ipAddress = $result['ws_ip'];
	} else {
		throw new Exception('Please capture again');
	}

	$connectPort = 5900;

			if ( isset($nets[$interface->getNetworkId()]) && $nets[$interface->getNetworkId()]->isCloud()) {
				// Network is a Cloud
				$net_name = $nets[$interface->getNetworkId()]->getNType();
			}
			else if ($nets[$interface->getNetworkId()]->listNetworkTypes() == 'internal') {

                 $net_name = 'internal_' . $lab_session  ;
            }
            else if ($nets[$interface->getNetworkId()]->listNetworkTypes() == 'internal2') {

                $net_name = 'internal2_' . $lab_session  ;
            }
            elseif ($nets[$interface->getNetworkId()]->listNetworkTypes() == 'internal3') {

                $net_name = 'internal3_'  . $lab_session ;
            }

            else if ($nets[$interface->getNetworkId()]->listNetworkTypes() == 'private') {

                $net_name = 'private_' . $host_session ;
            }
            else if ($nets[$interface->getNetworkId()]->listNetworkTypes() == 'private2') {

                $net_name = 'private2_' . $host_session ;

            }
            else if ($nets[$interface->getNetworkId()]->listNetworkTypes() == 'private3') {

                $net_name = 'private3_' .$host_session;
            } 
	
    		else {
			$net_name = 'vnet' . $lab_session . '_' . $interface->getNetworkId();
			}

	// create winbox docker container — Stage 6: the whole docker lane rides
	// broker verbs (names derived broker-side from the typed ids; no :4243
	// dial from www-data).
	$winbox_ids = broker_capture_ids($tenant, $lab_session, $node_session, $interface_id);

	// Check docker is exist: read-only inspect; rc!=0 -> no such container.
	$chk = broker_docker_inspect('capture', $winbox_ids, '{{ .State.Running }}');

	if (!$chk['ok'] || $chk['rc'] != 0) {
		// TODO(sec residual): --privileged (broker winbox_create) is over-privilege
		// (grants ALL caps + device access) on the winbox container. Left
		// UNCHANGED — the alexhorner/winbox-dockerised image is absent on the
		// gate, so the minimal cap set it actually needs (if any) could not be
		// tested; narrowing it blind risks breaking winbox. Revisit once the
		// image is available to profile. (The `--cpu=2 --entrypoint wine
		// /winbox64` after-image argv quirk is also preserved as-is broker-side.)
		broker_call('winbox_create', array_merge($winbox_ids, [
			'hostname' => $node_name . '_' . $interface_name,
		]), 120);
	}

	broker_call('docker_start', array_merge(['kind' => 'capture'], $winbox_ids));

	$ins = broker_docker_inspect('capture', $winbox_ids, '{{ .State.Pid }}');
	$pid = ($ins['ok'] && count($ins['out'])) ? $ins['out'][0] : '';

	// Create rdp connection to eth1 (broker no-ops if rdp<uid> already exists)
	broker_call('winbox_rdp_attach', [
		'tenant' => (int) $tenant, 'lab_session' => (int) $lab_session,
		'node_session' => (int) $node_session, 'node_id' => (int) $node_id,
		'interface_id' => (int) $interface_id, 'pid' => (int) $pid,
		'ip' => $ipAddress,
	]);

	// span/cap veth pair mirrored into the winbox container + bridge attach
	broker_call('winbox_span_attach', [
		'tenant' => (int) $tenant, 'lab_session' => (int) $lab_session,
		'node_session' => (int) $node_session, 'node_id' => (int) $node_id,
		'interface_id' => (int) $interface_id, 'pid' => (int) $pid,
		'net' => $net_name,
	]);


	$html5_db = html5_checkDatabase();

	html5AddSession($html5_db, $dockerName, 'vnc', $port, $tenant, $ipAddress, $connectPort, null, null, null);
	$html5_db = null;
	// addHtml5Perm($port, $tenant);
	$token = getHtml5Token($tenant);
	$b64id = base64_encode($port.$tenant . "\0" . 'c' . "\0" . 'mysql');
	$link = '/html5/#/client/' . $b64id . '?token=' . $token;

	$output = [];
	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = [
		'link' => $link,
		'node' => $node_name,
		'port' => $interface_name,
	];
	return $output;
}

// Docker uses rc=1 both for an absent object and for real daemon/runtime errors.
// Accept only its exact absent-object diagnostic as idempotent cleanup success.
function brokerDockerTargetMissing($response)
{
    if (!is_array($response) || !empty($response['ok']) ||
        (int) get($response['rc'], -1) !== 1) {
        return false;
    }
    $error = trim((string) get($response['err'], ''));
    return preg_match(
        '/^(?:Error(?::| response from daemon:)\s*)?No such (?:object|container):\s+' .
        '[A-Za-z0-9][A-Za-z0-9_.-]*$/iD',
        $error
    ) === 1;
}

function addWiresharkSystem($lab, $node_id, $interface_id)
{
    // Entry validation before node_id/interface_id reach $dockerName -> exec().
    secureIdent($node_id, "node id");
    secureIdent($interface_id, "interface id");
    if ($interface_id === "" || $node_id === "") {
        throw new Exception("Missing data");
    }
    $lab_session = $lab->getSession();
    if ($lab_session == null) {
        throw new Exception("No Lab Session");
    }
    $node = $lab->getNodes()[$node_id];
    if (!$node) {
        throw new Exception("Node is undefined");
    }
    $node_session = $node->getSession();
    $interface = $node->getInterfaces()[$interface_id];
    if (!$interface) {
        throw new Exception("Interface is undefined");
    }

    $tenant = $lab->getTenant();
    $db = checkDatabase();

    // Pull this capture's allocated docker0 IP/port (addWireshark() inserted the row).
    $statement = $db->prepare(
        "SELECT * FROM wiresharks WHERE ws_tenant=:ws_tenant AND ws_lab=:ws_lab AND ws_node=:ws_node AND ws_if=:ws_if"
    );
    $statement->execute([
        "ws_tenant" => $tenant,
        "ws_lab" => $lab_session,
        "ws_node" => $node_id,
        "ws_if" => $interface_id,
    ]);
    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    if (count($result) == 0) {
        throw new Exception("Please capture again");
    }
    $result = $result[0];
    $node_name = $result["ws_node_name"];
    $interface_name = $result["ws_if_name"];
    $port = $result["ws_port"];
    $ipAddress = $result["ws_ip"];

    if ($interface->getNType() == "serial") {
        $tap_name = "ser" . $node_session . "_" . $interface_id;
    } else {
        $tap_name = "vunl" . $node_session . "_" . $interface_id;
    }

    $uniqueId = $tenant . "_" . $lab_session . "_" . $node_session . "_" . $interface_id;
    $dockerName = "Capture_" . $uniqueId;

    // Always start a fresh per-capture container so Wireshark begins from zero.
    // Remove the existing mirror while its cap target still exists: deleting the
    // container/netns first makes tc render the target as "*", after which strict
    // ownership verification must (correctly) refuse to delete the filter.
    // Stage 6: broker verbs — the Capture_<t>_<l>_<ns>_<if> name is derived
    // broker-side from these typed ids.
    $cap_ids = broker_capture_ids($tenant, $lab_session, $node_session, $interface_id);
    $cap = captureMirrorTap($lab, $node_id, $interface_id);
    $mirrorTap = $cap['ok'] ? $cap['tap'] : $tap_name;
    $oldName = isset($result["ws_dc_name"]) ? (string) $result["ws_dc_name"] : "";
    $oldNodeSession = (int) $node_session;
    if (preg_match('/^Capture_(\d+)_(\d+)_(\d+)_(\d+)$/D', $oldName, $oldIds) &&
        (int) $oldIds[1] === (int) $tenant &&
        (int) $oldIds[2] === (int) $lab_session &&
        (int) $oldIds[4] === (int) $interface_id) {
        $oldNodeSession = (int) $oldIds[3];
    }
    $cleanup = broker_call('capture_teardown', [
        'tenant' => (int) $tenant, 'lab_session' => (int) $lab_session,
        'node_session' => $oldNodeSession, 'interface_id' => (int) $interface_id,
        'tap' => $mirrorTap,
    ]);
    if (empty($cleanup['ok']) || (int) $cleanup['rc'] !== 0) {
        throw new RuntimeException('capture teardown failed: ' .
            get($cleanup['err'], 'broker failure'));
    }
    $existing = broker_docker_inspect('capture', $cap_ids, '{{ .State.Running }}');
    $containerMissing = brokerDockerTargetMissing($existing);
    if (empty($existing['ok']) && !$containerMissing) {
        throw new RuntimeException('capture inspect failed: ' .
            get($existing['err'], 'broker failure'));
    }
    if ((int) $existing['rc'] === 0) {
        $stopped = broker_call('docker_stop', array_merge(['kind' => 'capture'], $cap_ids));
        if (empty($stopped['ok']) || (int) $stopped['rc'] !== 0) {
            throw new RuntimeException('capture container stop failed: ' .
                get($stopped['err'], 'broker failure'));
        }
        $removed = broker_call('docker_rm', array_merge(['kind' => 'capture'], $cap_ids));
        if ((empty($removed['ok']) || (int) $removed['rc'] !== 0) &&
            !brokerDockerTargetMissing($removed)) {
            throw new RuntimeException('capture container removal failed: ' .
                get($removed['err'], 'broker failure'));
        }
    }
    // A node restart changes node_session, so the row's recorded container
    // (ws_dc_name) can differ from the freshly computed name — without this
    // the old-session container leaked forever (kept running + capturing).
    // ws_dc_name is server-derived + prepared-statement-stored; capture_rm
    // re-bounds it to a Capture_<ints> shape broker-side.
    if ($oldName !== "" && $oldName !== $dockerName) {
        $oldRemoved = broker_capture_rm($oldName);
        if ((empty($oldRemoved['ok']) || (int) $oldRemoved['rc'] !== 0) &&
            !brokerDockerTargetMissing($oldRemoved)) {
            throw new RuntimeException('stale capture container removal failed: ' .
                get($oldRemoved['err'], 'broker failure'));
        }
        $st = $db->prepare("UPDATE wiresharks SET ws_dc_name=:n WHERE ws_tenant=:t AND ws_lab=:l AND ws_node=:o AND ws_if=:i");
        $st->execute(["n" => $dockerName, "t" => $tenant, "l" => $lab_session, "o" => $node_id, "i" => $interface_id]);
    }
    // Fresh ws_ip on EVERY (re)launch — reusing the row's address let clients of
    // the PREVIOUS container of this very capture (relaunch path) collide with the
    // new one during its death grace. token_mint reads the row when the new iframe
    // loads, i.e. after this. We still allocate a per-capture serial via
    // getWiresharkPort() SOLELY to derive a unique docker0 IP (the octets below);
    // ws_port itself is now the fixed web-UI port 80 (see the container swap below:
    // pnet-capture-web serves its http UI on :80 at ws_ip via the eth1 attach).
    $serial = getWiresharkPort($db);
    $oct4 = $serial % 255;
    $oct3 = 200 + (floor($serial / 255) % 55);
    $dockerIp = explode(".", trim(getDockerIp()));
    $oct1 = isset($dockerIp[0]) ? $dockerIp[0] : 10;
    $oct2 = isset($dockerIp[1]) ? $dockerIp[1] : 178;
    $ipAddress = $oct1 . "." . $oct2 . "." . $oct3 . "." . $oct4;
    // ws_port = 80: the capture web UI listens on http :80 on ws_ip (eth1/docker0),
    // reached through the authenticated http-console reverse proxy, NOT guacd VNC.
    $port = 80;
    $st = $db->prepare("UPDATE wiresharks SET ws_port=:p, ws_ip=:ip WHERE ws_tenant=:t AND ws_lab=:l AND ws_node=:o AND ws_if=:i");
    $st->execute(["p" => $port, "ip" => $ipAddress, "t" => $tenant, "l" => $lab_session, "o" => $node_id, "i" => $interface_id]);
    broker_call('capture_links_del', [
        'tenant' => (int) $tenant, 'lab_session' => (int) $lab_session,
        'node_session' => (int) $node_session, 'interface_id' => (int) $interface_id,
    ]);

    // pnet-capture-web serves a live-packet WEB UI (http :80, .pcap download) that
    // the web console renders through the authenticated http-console reverse proxy
    // (/console/http/<token>/ -> http_ws_bridge.py dials ws_ip:80), NOT guacd/VNC.
    // It sniffs the node tap tc-mirrored onto its eth0 (same as the old VNC
    // Wireshark image). --net=none: we attach eth1 (mgmt on docker0, holds ws_ip —
    // the web UI is reachable there) and eth0 (the capture mirror) by hand below.
    // Renamed from pnet-wireshark:1.0 (VNC) — this is the html5-lane replacement;
    // the NATIVE (html5-off) local-Wireshark capture:// lane is untouched.
    // NET_ADMIN retained (likely redundant — promisc-mode capture uses CAP_NET_RAW,
    // which is in the default docker cap set — but not empirically confirmed, so
    // kept). SYS_ADMIN dropped: pnet-capture-web:1.0 has no consumer for it (getcap
    // empty; no setns/mount/pivot_root in the image), so it was pure over-privilege.
    // Stage 6: capture_create builds the whole fixed argv broker-side (name +
    // tap hostname derived from the same typed ids; 'serial' picks ser/vunl).
    broker_call('capture_create', array_merge($cap_ids, [
        'serial' => ($interface->getNType() == "serial") ? 1 : 0,
    ]), 120);
    broker_call('docker_start', array_merge(['kind' => 'capture'], $cap_ids));

    $ins = broker_docker_inspect('capture', $cap_ids, '{{ .State.Pid }}');
    $pid = ($ins['ok'] && count($ins['out'])) ? $ins['out'][0] : "";

    // eth1 = mgmt on docker0 so the http-console bridge can reach the capture web
    // UI (http :80) at ws_ip. capture_rdp_attach is kept as-is: despite its name it
    // just plumbs a docker0 veth + assigns ws_ip inside the netns (the same IP the
    // http bridge dials); no RDP/guacd is involved on this lane anymore. Broker
    // no-ops if the mgmt veth already exists.
    broker_call('capture_rdp_attach', [
        'tenant' => (int) $tenant, 'lab_session' => (int) $lab_session,
        'node_session' => (int) $node_session, 'interface_id' => (int) $interface_id,
        'pid' => (int) $pid, 'ip' => $ipAddress,
    ]);

    // eth0 = capture mirror: tc-mirror the node tap (both directions) onto cap<id>,
    // whose in-netns peer becomes the container's eth0 that /capture.sh dumpcaps.
    // For a satellite-hosted node the tap is on the satellite, so we mirror the
    // master-side peer's tap (same bridged frames) — the cap veth/container stay
    // named by THIS node's session, only the mirrored tap differs.
    $attachArgs = [
        'tenant' => (int) $tenant, 'lab_session' => (int) $lab_session,
        'node_session' => (int) $node_session, 'interface_id' => (int) $interface_id,
        'pid' => (int) $pid, 'tap' => $mirrorTap,
    ];
    $attach = broker_call('capture_mirror_attach', $attachArgs);
    if (empty($attach['ok']) || (int) $attach['rc'] !== 0) {
        $attachError = get($attach['err'], 'broker failure');
        $cleanupErrors = [];

        // The attach may have failed after creating only some resources. Keep
        // the cap target intact unless exact mirror teardown succeeds; otherwise
        // a forced container removal would erase the ownership evidence.
        $teardownArgs = $attachArgs;
        unset($teardownArgs['pid']);
        $teardown = broker_call('capture_teardown', $teardownArgs);
        if (empty($teardown['ok']) || (int) $teardown['rc'] !== 0) {
            $cleanupErrors[] = 'capture teardown: ' .
                get($teardown['err'], 'broker failure');
        }
        if (!empty($teardown['ok']) && (int) $teardown['rc'] === 0) {
            $remove = broker_call('docker_rm', array_merge(
                ['kind' => 'capture', 'force' => 1], $cap_ids
            ));
            if ((empty($remove['ok']) || (int) $remove['rc'] !== 0) &&
                !brokerDockerTargetMissing($remove)) {
                $cleanupErrors[] = 'container removal: ' .
                    get($remove['err'], 'broker failure');
            }
        }

        if (count($cleanupErrors) === 0) {
            $delete = $db->prepare(
                "DELETE FROM wiresharks WHERE ws_tenant=:t AND ws_lab=:l AND ws_node=:n AND ws_if=:i"
            );
            $delete->execute([
                't' => $tenant, 'l' => $lab_session,
                'n' => $node_id, 'i' => $interface_id,
            ]);
        }

        $message = 'capture mirror attach failed: ' . $attachError;
        if (count($cleanupErrors) !== 0) {
            $message .= '; cleanup failed: ' . implode('; ', $cleanupErrors);
        }
        throw new RuntimeException($message);
    }

    // The web console renders this capture as an HTTP lane via
    // console.html?capture=1 -> token_mint.php?type=http&capture=1 (resolves ws_ip
    // + ws_port=80 from the wiresharks row) -> http_ws_bridge.py reverse-proxies
    // ws_ip:80 under /console/http/<token>/. So we return NO "link" — the frontend
    // uses its console.html?capture=1 http path.
    $output = [];
    $output["code"] = 200;
    $output["status"] = "success";
    $output["message"] = [
        "node" => $node_name,
        "port" => $interface_name,
    ];
    return $output;
}

/**
 * Open a Wi-Fi (802.11) session pcap in the SAME pnet-capture-web viewer used for
 * live node captures — but in FILE MODE (the container's entrypoint runs
 * `wireshark -r $CAPTURE_FILE` instead of live-sniffing a tap, since the frames are
 * DLT_IEEE802_11, a link type the Ethernet tap path can't carry). Reuses the whole
 * existing capture lane: a wiresharks row (so token_mint's ?type=http&capture=1
 * resolves ws_ip:80) + the mgmt veth via the SAME capture_rdp_attach broker verb; the
 * frontend then opens console.html?capture=1&node&iface exactly like a node capture.
 *
 * The Wi-Fi capture is session-wide (not tied to a node tap), so it is keyed to a
 * reserved synthetic ws_node per medium (airduct=901, vwifi=902), iface 0. The pcap
 * comes from Item 4 (airduct: airhandler tee) or 4c (vwifi: spy-port tee); this only
 * VIEWS an already-produced pcap and is path-jailed to /opt/unetlab/tmp/<session>/.
 *
 * @param string $medium 'airduct' | 'vwifi'
 * @return array JSend with message => {node, iface, name}
 */
function addWifiCaptureWeb($lab, $medium = 'airduct')
{
    $lab_session = $lab->getSession();
    if ($lab_session == null) {
        throw new Exception("No Lab Session");
    }
    $tenant = $lab->getTenant();
    $session = (int) $lab_session;
    $medium = ($medium === 'vwifi') ? 'vwifi' : 'airduct';
    $syn_node = ($medium === 'vwifi') ? 902 : 901;    // reserved wifi-capture ws_node
    $iface = 0;

    // Path-jail: the pcap must be THIS session's wifi pcap under /opt/unetlab/tmp.
    $base = "/opt/unetlab/tmp/" . $session;
    $pcap = $base . "/" . ($medium === 'vwifi' ? "wifi-vwifi-" : "wifi-") . $session . ".pcap";
    $rp = realpath($pcap);
    if ($rp === false || strpos($rp, $base . "/") !== 0 || !is_file($rp) || filesize($rp) <= 24) {
        throw new Exception("No " . $medium . " Wi-Fi capture yet — arm capture and let some frames flow first.");
    }

    // Stage 6: image presence via the read-only broker listing, evaluated as
    // DATA here (no shell pipe, no :4243 dial from www-data).
    $imgs = broker_docker_image_ls('refs');
    $haveCaptureImg = false;
    foreach ($imgs['out'] as $imgRef) {
        if (strpos($imgRef, 'pnet-capture-web:') === 0) {
            $haveCaptureImg = true;
            break;
        }
    }
    if (!$haveCaptureImg) {
        throw new Exception("Capture image pnet-capture-web:1.0 not found.");
    }

    $db = checkDatabase();
    ensureWiresharkSchema($db);

    // Allocate a per-capture docker0 IP (same scheme as addWireshark).
    $wport = getWiresharkPort($db);
    $oct4 = $wport % 255;
    $oct3 = 200 + (floor($wport / 255) % 55);
    $dockerIp = explode(".", trim(getDockerIp()));
    $oct1 = isset($dockerIp[0]) ? $dockerIp[0] : 10;
    $oct2 = isset($dockerIp[1]) ? $dockerIp[1] : 178;
    $ipAddress = $oct1 . "." . $oct2 . "." . $oct3 . "." . $oct4;

    // Container name matches the standard Capture_<t>_<l>_<node>_<if> pattern so the
    // existing wireshark/delete -> capture_teardown flow tears it down unchanged.
    $dockerName = "Capture_" . $tenant . "_" . $session . "_" . $syn_node . "_" . $iface;
    $wifi_ids = broker_capture_ids($tenant, $session, $syn_node, $iface);
    broker_call('docker_stop', array_merge(['kind' => 'capture'], $wifi_ids));
    broker_call('docker_rm', array_merge(['kind' => 'capture'], $wifi_ids));

    // FILE MODE: bind-mount the pcap READ-ONLY and point CAPTURE_FILE at it; --net=none
    // (no capture mirror — this is a file view). eth1/ws_ip is attached below.
    // SYS_ADMIN dropped (unused by pnet-capture-web:1.0); NET_ADMIN retained
    // (likely redundant vs default CAP_NET_RAW, but not empirically confirmed).
    // Same rationale as addWiresharkSystem above.
    // Stage 6: capture_wifi_create re-derives + re-jails the pcap path
    // broker-side from lab_session + medium (the realpath check above stays
    // for the user-facing error message); fixed argv, ro bind, no shell.
    broker_call('capture_wifi_create', [
        'tenant' => (int) $tenant, 'lab_session' => (int) $session,
        'medium' => $medium,
    ], 120);
    broker_call('docker_start', array_merge(['kind' => 'capture'], $wifi_ids));

    $ins = broker_docker_inspect('capture', $wifi_ids, '{{ .State.Pid }}');
    $pid = ($ins['ok'] && count($ins['out'])) ? $ins['out'][0] : "";

    // Mgmt veth on docker0 (ws_ip) so the http-console bridge can reach the web UI on
    // :80 — the SAME broker verb the live capture uses (despite the name, no RDP).
    broker_call('capture_rdp_attach', [
        'tenant' => (int) $tenant, 'lab_session' => (int) $session,
        'node_session' => (int) $syn_node, 'interface_id' => (int) $iface,
        'pid' => (int) $pid, 'ip' => $ipAddress,
    ]);

    // Upsert the wiresharks row so token_mint (?type=http&capture=1) resolves ws_ip:80.
    $label = ($medium === 'vwifi') ? 'Wi-Fi vwifi (802.11)' : 'Wi-Fi airduct (802.11)';
    $db->prepare("DELETE FROM wiresharks WHERE ws_tenant=:t AND ws_lab=:l AND ws_node=:n AND ws_if=:i")
       ->execute(["t" => $tenant, "l" => $session, "n" => $syn_node, "i" => $iface]);
    $ins = $db->prepare('INSERT INTO wiresharks (ws_tenant, ws_lab, ws_node, ws_if, ws_net, ws_node_name, ws_if_name, ws_dc_name, ws_port, ws_ip)
        VALUES (:t, :l, :n, :i, 0, :nn, :ifn, :dc, 80, :ip)');
    $ins->execute([
        "t" => $tenant, "l" => $session, "n" => $syn_node, "i" => $iface,
        "nn" => $label, "ifn" => "802.11", "dc" => $dockerName, "ip" => $ipAddress,
    ]);

    return ["code" => 200, "status" => "success",
            "message" => ["node" => $syn_node, "iface" => $iface, "name" => $label]];
}

// Raise + maximize the Wireshark window for ONE capture inside the shared
// per-lab container, so clicking a capture tile brings ITS window to the front
// (all captures share one desktop with one window per cap<idx>).
function focusWiresharkWindow($lab, $node_id, $interface_id)
{
    // Entry validation: node_id/interface_id are used to build the SQL key and,
    // in sibling functions, the $dockerName. Reject metacharacters at entry.
    secureIdent($node_id, "node id");
    secureIdent($interface_id, "interface id");
    $lab_session = $lab->getSession();
    if ($lab_session == null) {
        throw new Exception("No Lab Session");
    }
    $tenant = $lab->getTenant();
    $db = checkDatabase();

    $st = $db->prepare(
        "SELECT ws_ethidx FROM wiresharks WHERE ws_tenant=:t AND ws_lab=:l AND ws_node=:n AND ws_if=:i"
    );
    $st->execute([
        "t" => $tenant,
        "l" => $lab_session,
        "n" => $node_id,
        "i" => $interface_id,
    ]);
    $row = $st->fetch(PDO::FETCH_ASSOC);

    $output = ["code" => 200, "status" => "success", "message" => "ok"];
    if (!$row) {
        return $output;
    }
    $capIdx = is_null($row["ws_ethidx"]) ? 0 : (int) $row["ws_ethidx"];

    // The X11 desktop runs on DISPLAY=:1; xdotool raises + maximizes the
    // window. Stage 6: fixed command shape broker-side (docker_exec cmd
    // raise_wireshark_window on the shared Capture_<t>_<l> container); only
    // typed ints cross the socket.
    broker_call('docker_exec', [
        'cmd' => 'raise_wireshark_window',
        'tenant' => (int) $tenant, 'lab_session' => (int) $lab_session,
        'cap_idx' => (int) $capIdx,
    ]);
    return $output;
}

function deleteWireshark($lab, $node_id, $interface_id)
{
    // delete wireshark when user close capture;
    // CRITICAL entry validation: the gating SELECT compares $node_id against the
    // int column ws_node, so MySQL coerces "1; cmd #" -> 1 and matches a real row;
    // getNodes()[$node_id] then misses (int-keyed) and the raw string fell through
    // to $node_session -> $dockerName -> exec(). Reject metacharacters here before
    // any DB or exec touches these values.
    secureIdent($node_id, "node id");
    secureIdent($interface_id, "interface id");
    $tenant = $lab->getTenant();
    $lab_session = $lab->getSession();
    if ($lab_session == null) {
        throw new Exception("No Lab Session");
    }

    $db = checkDatabase();

    $query =
        "SELECT * FROM wiresharks WHERE ws_tenant=:ws_tenant AND ws_lab=:ws_lab AND ws_node=:ws_node AND ws_if=:ws_if";
    $statement = $db->prepare($query);
    $statement->execute([
        "ws_tenant" => $tenant,
        "ws_lab" => $lab_session,
        "ws_node" => $node_id,
        "ws_if" => $interface_id,
    ]);

    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    if (count($result) > 0) {
        // Per-capture teardown: stop+remove THIS capture's eve-wireshark container,
        // its host veths (rdp/cap), and the node tap's tc mirror.
        $node = $lab->getNodes()[$node_id];
        $node_session = $node ? $node->getSession() : $node_id;
        $interface = $node ? $node->getInterfaces()[$interface_id] : null;
        if ($interface && $interface->getNType() == "serial") {
            $tap_name = "ser" . $node_session . "_" . $interface_id;
        } else {
            $tap_name = "vunl" . $node_session . "_" . $interface_id;
        }
        $uniqueId = $tenant . "_" . $lab_session . "_" . $node_session . "_" . $interface_id;
        $dockerName = "Capture_" . $uniqueId;
        // Prefer the row's RECORDED container name: if the node restarted since
        // the capture launched, node_session changed and the recomputed name
        // no longer matches the actual container (which would then leak).
        // Stage 6: rowName is server-derived + prepared-statement-stored;
        // broker capture_rm re-bounds it to a Capture_<ints> shape. The
        // id-derived name rides the typed docker_rm capture kind.
        // remove the tc mirror from the SAME tap addWiresharkSystem mirrored
        // (the master peer's tap for a satellite-hosted node, else its own).
        $capt = captureMirrorTap($lab, $node_id, $interface_id);
        $mirrorTap = $capt['ok'] ? $capt['tap'] : $tap_name;
        $rowName = isset($result[0]["ws_dc_name"]) ? (string) $result[0]["ws_dc_name"] : "";
        $rowNodeSession = (int) $node_session;
        if (preg_match('/^Capture_(\d+)_(\d+)_(\d+)_(\d+)$/D', $rowName, $rowIds) &&
            (int) $rowIds[1] === (int) $tenant &&
            (int) $rowIds[2] === (int) $lab_session &&
            (int) $rowIds[4] === (int) $interface_id) {
            $rowNodeSession = (int) $rowIds[3];
        }
        $cleanup = broker_call('capture_teardown', [
            'tenant' => (int) $tenant, 'lab_session' => (int) $lab_session,
            'node_session' => $rowNodeSession, 'interface_id' => (int) $interface_id,
            'tap' => $mirrorTap,
        ]);
        if (empty($cleanup['ok']) || (int) $cleanup['rc'] !== 0) {
            throw new RuntimeException('capture teardown failed: ' .
                get($cleanup['err'], 'broker failure'));
        }
        if ($rowName !== "" && $rowName !== $dockerName) {
            $rowRemoved = broker_capture_rm($rowName);
            if ((empty($rowRemoved['ok']) || (int) $rowRemoved['rc'] !== 0) &&
                !brokerDockerTargetMissing($rowRemoved)) {
                throw new RuntimeException('capture container removal failed: ' .
                    get($rowRemoved['err'], 'broker failure'));
            }
        }
        $removed = broker_call('docker_rm', array_merge(
            ['kind' => 'capture', 'force' => 1],
            broker_capture_ids($tenant, $lab_session, $node_session, $interface_id)
        ));
        if ((empty($removed['ok']) || (int) $removed['rc'] !== 0) &&
            !brokerDockerTargetMissing($removed)) {
            throw new RuntimeException('capture container removal failed: ' .
                get($removed['err'], 'broker failure'));
        }
    }

    $query =
        "DELETE FROM wiresharks WHERE ws_tenant=:ws_tenant AND ws_lab=:ws_lab AND ws_node=:ws_node AND ws_if=:ws_if";
    $statement = $db->prepare($query);
    $statement->execute([
        "ws_tenant" => $tenant,
        "ws_lab" => $lab_session,
        "ws_node" => $node_id,
        "ws_if" => $interface_id,
    ]);
}

// Remove ONE capture's mirror interface: tc on the node tap + the host veth.
// The container's supervisor reaps the corresponding Wireshark window when the
// in-netns peer disappears. A missing tap is safe broker-side, but an actual
// ownership/cleanup failure is surfaced so callers do not delete the DB row.
function removeCaptureInterface($lab, $tenant, $lab_session, $node_id, $interface_id, $capIdx)
{
    $labId   = $tenant . "_" . $lab_session;
    $capVeth = "wc" . $labId . "_" . $capIdx;

    $node = isset($lab->getNodes()[$node_id]) ? $lab->getNodes()[$node_id] : null;
    $args = [
        'tenant' => (int) $tenant, 'lab_session' => (int) $lab_session,
        'cap_idx' => (int) $capIdx,
    ];
    if ($node) {
        $args['node_session'] = (int) $node->getSession();
        $args['interface_id'] = (int) $interface_id;
        // mirror tap = the master peer's tap for a satellite-hosted node, else own
        $capi = captureMirrorTap($lab, $node_id, $interface_id);
        if ($capi['ok']) {
            $args['tap'] = $capi['tap'];
        } else {
            $node_session = $node->getSession();
            $interface = isset($node->getInterfaces()[$interface_id])
                ? $node->getInterfaces()[$interface_id] : null;
            $ntype = $interface ? $interface->getNType() : "";
            $args['tap'] = ($ntype == "serial" ? "ser" : "vunl") . $node_session . "_" . $interface_id;
        }
    }
    $cleanup = broker_call('capture_if_del', $args);
    if (empty($cleanup['ok']) || (int) $cleanup['rc'] !== 0) {
        throw new RuntimeException('capture interface cleanup failed: ' .
            get($cleanup['err'], 'broker failure'));
    }
    return true;
}

// Tear down the whole per-lab capture container: Apache proxy conf, the docker
// container (its netns death auto-removes all host cap veths) and the mgmt veth.
function removeWiresharkContainer($tenant, $lab_session)
{
    // Stage 6: shared Capture_<t>_<l> name derived broker-side from the ids.
    broker_call('docker_rm', [
        'kind' => 'capture_shared', 'force' => 1,
        'tenant' => (int) $tenant, 'lab_session' => (int) $lab_session,
    ]);
    broker_call('wireshark_container_remove', [
        'tenant' => (int) $tenant, 'session' => (int) $lab_session,
    ]);
    return true;
}

// How many capture rows remain for a (tenant, lab) -> decides container teardown.
function wiresharkLabCount($db, $tenant, $lab_session)
{
    $st = $db->prepare(
        "SELECT COUNT(*) FROM wiresharks WHERE ws_tenant=:t AND ws_lab=:l"
    );
    $st->execute(["t" => $tenant, "l" => $lab_session]);
    return (int) $st->fetchColumn();
}

function deleteWiresharkByNode($db, $lab, $node_id)
{
    // delete wireshark when a node is close, or delete
    $tenant = $lab->getTenant();
    $lab_session = $lab->getSession();

    if ($lab_session == null) {
        throw new Exception("No Lab Session");
    }

    $query =
        "SELECT * FROM wiresharks WHERE ws_tenant=:ws_tenant AND ws_lab=:ws_lab AND ws_node=:ws_node";
    $statement = $db->prepare($query);
    $statement->execute([
        "ws_tenant" => $tenant,
        "ws_lab" => $lab_session,
        "ws_node" => $node_id,
    ]);

    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    foreach ($result as $ws) {
        $capIdx = is_null($ws["ws_ethidx"]) ? 0 : (int) $ws["ws_ethidx"];
        removeCaptureInterface($lab, $tenant, $lab_session, $ws["ws_node"], $ws["ws_if"], $capIdx);
    }

    $query =
        "DELETE FROM wiresharks WHERE ws_tenant=:ws_tenant AND ws_lab=:ws_lab AND ws_node=:ws_node";
    $statement = $db->prepare($query);
    $statement->execute([
        "ws_tenant" => $tenant,
        "ws_lab" => $lab_session,
        "ws_node" => $node_id,
    ]);

    // If that was the last node's capture in this lab, tear down the container.
    if (wiresharkLabCount($db, $tenant, $lab_session) === 0) {
        removeWiresharkContainer($tenant, $lab_session);
    }
}

function deleteWiresharkByLab($db, $lab)
{
    // delete wireshark when an user leave lab
    $tenant = $lab->getTenant();
    $lab_session = $lab->getSession();

    if ($lab_session == null) {
        throw new Exception("No Lab Session");
    }

    $query =
        "SELECT * FROM wiresharks WHERE ws_tenant=:ws_tenant AND ws_lab=:ws_lab";
    $statement = $db->prepare($query);
    $statement->execute([
        "ws_tenant" => $tenant,
        "ws_lab" => $lab_session,
    ]);

    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    foreach ($result as $ws) {
        $capIdx = is_null($ws["ws_ethidx"]) ? 0 : (int) $ws["ws_ethidx"];
        removeCaptureInterface($lab, $tenant, $lab_session, $ws["ws_node"], $ws["ws_if"], $capIdx);
    }
    if (count($result) > 0) {
        removeWiresharkContainer($tenant, $lab_session);
    }

    $query =
        "DELETE FROM wiresharks WHERE ws_tenant=:ws_tenant AND ws_lab=:ws_lab";
    $statement = $db->prepare($query);
    $statement->execute([
        "ws_tenant" => $tenant,
        "ws_lab" => $lab_session,
    ]);
}

function deleteWiresharkBySession($db, $lab_session)
{
    //delete wireshark when session is destroyed
    if ($lab_session == null) {
        throw new Exception("No Lab Session");
    }

    $query = "SELECT * FROM wiresharks WHERE ws_lab=:ws_lab";
    $statement = $db->prepare($query);
    $statement->execute([
        "ws_lab" => $lab_session,
    ]);

    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    // One shared container per (tenant, lab_session); remove each distinct one.
    // The container's netns death auto-removes its host cap veths; the node taps
    // are gone with the session, so per-interface tc cleanup is unnecessary here.
    $seen = [];
    foreach ($result as $ws) {
        $tenant = $ws["ws_tenant"];
        if (!isset($seen[$tenant])) {
            removeWiresharkContainer($tenant, $lab_session);
            $seen[$tenant] = true;
        }
    }

    $query = "DELETE FROM wiresharks WHERE ws_lab=:ws_lab";
    $statement = $db->prepare($query);
    $statement->execute([
        "ws_lab" => $lab_session,
    ]);
}

// ==========EVE_STORE workbook ===================//

function unl_array_find_key($array, $callback)
{
    foreach ($array as $key => $item) {
        if ($callback($item)) {
            return $key;
        }
    }
    return false;
}

function objSort(&$objArray, $indexFunction, $sort_flags = 0)
{
    $indeces = [];
    foreach ($objArray as $obj) {
        $indeces[] = $indexFunction($obj);
    }
    return array_multisort($indeces, $objArray, $sort_flags);
}

if (!function_exists("get")) {
    function get(&$var, $default = null)
    {
        if (!isset($var)) {
            return $default;
        }
        if ($var === null) {
            return $default;
        }
        return $var;
    }
}

/** ============================ */

/** EVE_STORE lab session */

function createLabSession($db)
{
    $query = "SELECT lab_session_id FROM lab_sessions";
    $statement = $db->prepare($query);
    $statement->execute();
    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    $idColumn = array_column($result, "lab_session_id");
    if (count($idColumn) > 0) {
        $id = $idColumn[count($idColumn) - 1];
    } else {
        $id = 1;
    }
    while (array_search($id, $idColumn) !== false) {
        $id++;
    }
    return $id;
}

function replaceLabSessionPath($search, $replacement)
{
    $db = checkDatabase();
    $query =
        "UPDATE lab_sessions SET lab_session_path=REPLACE(lab_session_path, :search, :replacement)";
    $statement = $db->prepare($query);
    $statement->execute([
        "search" => $search,
        "replacement" => $replacement,
    ]);
}

function addLabSession($lid, $pod, $labpath)
{
    try {
        $db = checkDatabase();
        lockSession(0);
        try {
            // Keep the existence check and allocation in one critical section;
            // otherwise two open requests can both act on the same stale result.
            $query =
                "SELECT * FROM lab_sessions WHERE lab_session_lid=:lab_session_lid AND lab_session_pod = :lab_session_pod";
            $statement = $db->prepare($query);
            $statement->execute([
                "lab_session_lid" => $lid,
                "lab_session_pod" => $pod,
            ]);
            $result = $statement->fetchAll(PDO::FETCH_ASSOC);

            if (count($result) == 0) {
                $id = createLabSession($db);
                $query = 'INSERT INTO lab_sessions (`lab_session_id`, `lab_session_lid`, `lab_session_pod`, `lab_session_joined`, `lab_session_path`) ' .
                    'VALUES (:lab_session_id, :lab_session_lid, :lab_session_pod, :lab_session_joined, :lab_session_path)';
                $statement = $db->prepare($query);
                $statement->execute([
                    "lab_session_id" => $id,
                    "lab_session_lid" => $lid,
                    "lab_session_pod" => $pod,
                    "lab_session_joined" => $pod,
                    "lab_session_path" => $labpath,
                ]);
                $created = true;
            } else {
                $id = $result[0]["lab_session_id"];
                $created = false;
            }
        } finally {
            unlockSession(0);
        }

        if ($created) {
            $query =
                "UPDATE users SET lab_session = :lab_session WHERE pod = :pod;";
            $statement = $db->prepare($query);
            $statement->execute([
                "lab_session" => $id,
                "pod" => $pod,
            ]);
        } else {
            return joinLabSession($pod, $id);
        }

        return ["result" => true, "message" => "Success"];
    } catch (Exception $e) {
        return ["result" => false, "message" => $e->getMessage()];
    }
}

/**
 * TRUE when the tenant owns or has joined the given lab session. Lets
 * per-page API calls pin the session they actually display instead of
 * trusting the per-POD users.lab_session pointer, which any concurrent login
 * of the same account silently repoints.
 */
function labSessionJoinedBy($lab_session, $tenant)
{
    try {
        $db = checkDatabase();
        $statement = $db->prepare(
            'SELECT lab_session_joined FROM lab_sessions WHERE lab_session_id = :id'
        );
        $statement->execute(['id' => (int) $lab_session]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if ($row !== false) {
            return labSessionJoinedCsvContainsPod($row['lab_session_joined'], $tenant);
        }
    } catch (Exception $e) {
        // fall through to the users.lab_session pointer
    }
    return false;
}

function joinLabSession($tenant, $lab_session)
{
    try {
        $db = checkDatabase();
        $query =
            "SELECT * FROM lab_sessions WHERE lab_session_id=:lab_session_id";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session_id" => $lab_session,
        ]);

        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (!isset($result[0])) {
            throw new Exception("Lab Session not found");
        }
        $labSession = $result[0];

        if (
            $labSession["lab_session_joined"] == "" ||
            $labSession["lab_session_joined"] == null
        ) {
            $joined = [];
        } else {
            $joined = explode(",", $labSession["lab_session_joined"]);
        }

        if (!labSessionJoinedCsvContainsPod($labSession["lab_session_joined"], $tenant)) {
            $joined[] = $tenant;
        }

        $query =
            "UPDATE lab_sessions SET lab_session_joined = :lab_session_joined WHERE lab_session_id = :lab_session_id";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session_joined" => implode(",", $joined),
            "lab_session_id" => $lab_session,
        ]);

        $query =
            "UPDATE users SET lab_session = :lab_session WHERE pod = :pod;";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session" => $lab_session,
            "pod" => $tenant,
        ]);

        return ["result" => true, "message" => "Success"];
    } catch (Exception $e) {
        return ["result" => false, "message" => $e->getMessage()];
    }
}

function leaveLabSession($tenant, $lab)
{
    try {
        $db = checkDatabase();
        $query =
            "SELECT * FROM lab_sessions WHERE lab_session_id=:lab_session_id";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session_id" => $lab->getSession(),
        ]);

        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (!isset($result[0])) {
            throw new Exception("Lab Session not found");
        }
        $labSession = $result[0];

        $joined = explode(",", $labSession["lab_session_joined"]);
        $index = array_search($tenant, $joined);
        if ($index !== false) {
            array_splice($joined, $index, 1);
        }

        $query =
            "UPDATE lab_sessions SET lab_session_joined = :lab_session_joined WHERE lab_session_id = :lab_session_id";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session_joined" => implode(",", $joined),
            "lab_session_id" => $lab->getSession(),
        ]);

        $query =
            "UPDATE users SET lab_session = :lab_session WHERE pod = :pod;";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session" => null,
            "pod" => $tenant,
        ]);

        deleteWiresharkByLab($db, $lab);

        return ["result" => true, "message" => "Success"];
    } catch (Exception $e) {
        return ["result" => false, "message" => $e->getMessage()];
    }
}

function emptyLabSession($tenant)
{
    $db = checkDatabase();
    $query = "UPDATE users SET lab_session = :lab_session WHERE pod = :pod;";
    $statement = $db->prepare($query);
    $statement->execute([
        "lab_session" => null,
        "pod" => $tenant,
    ]);
}

function destroyLabSession($lab)
{
    try {
        $db = checkDatabase();
        deleteWiresharkBySession($db, $lab->getSession());

        $query =
            "SELECT * FROM lab_sessions WHERE lab_session_id=:lab_session_id";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session_id" => $lab->getSession(),
        ]);

        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (!isset($result[0])) {
            throw new Exception("Lab Session not found");
        }

        // Pass 1 — best-effort GRACEFUL stop + wipe of every node. NEVER abort the
        // teardown if one node fails: a stuck/running node must not block freeing
        // the session (the old code threw "Fail to Stop Node X" mid-loop, leaving a
        // half-destroyed lab — some nodes stopped, session + bridges + tmp still
        // present). Failures are logged; the force-kill pass below guarantees no
        // process survives, so a graceful failure here is harmless.
        foreach ($lab->getNodes() as $node_id => $node) {
            try {
                if (cluster_session_host($lab, $node_id) > 0) {
                    // satellite-hosted: stop/wipe where the process really is
                    node_wrapper_exec($lab, $node_id, 'stop', $lab->getTenant(), $co, $crc, 600);
                    node_wrapper_exec($lab, $node_id, 'wipe', $lab->getTenant(), $co, $crc, 600);
                } else {
                    stop($node);
                    wipe($node);
                }
            } catch (Exception $e) {
                error_log(date('M d H:i:s ') . 'WARNING: destroy: stop/wipe node ' .
                    $node_id . ': ' . $e->getMessage());
            }
        }

        // Pass 2 — GUARANTEED force-kill. Node::stop() flips the node to "stopped"
        // in state BEFORE the device process actually dies, so a failed/no-op
        // device stop leaves a real process running while the UI shows it stopped
        // ("stopped but running"). Force-kill each node by its REAL workspace
        // (root `fuser -k` via the broker) / docker stop+rm — the same reliable
        // sweep fwdestroyBrokenLabSession() uses — so nothing is left running.
        $query =
            "SELECT * FROM node_sessions WHERE node_session_lab=:node_session_lab";
        $statement = $db->prepare($query);
        $statement->execute(["node_session_lab" => $lab->getSession()]);
        $nodeRows = $statement->fetchAll(PDO::FETCH_ASSOC);
        $satellites = [];
        foreach ($nodeRows as $node) {
            $nodeHost = isset($node["node_session_host"]) ? (int) $node["node_session_host"] : 0;
            if ($nodeHost > 0 && cluster_host_ip($nodeHost) !== null) {
                $satellites[$nodeHost] = true;
                if ($node["node_session_type"] != "docker") {
                    cluster_exec($nodeHost, 'node_kill_workspace', [
                        'workspace' => $node["node_session_workspace"],
                    ]);
                }
                continue;
            }
            if ($node["node_session_type"] == "docker") {
                // Lifecycle stop+rm now ride the broker's typed verbs (name
                // derived broker-side from the session id).
                broker_docker_stop((int) $node["node_session_id"]);
                broker_docker_rm((int) $node["node_session_id"], false);
            } else {
                broker_call('node_kill_workspace', [
                    'workspace' => $node["node_session_workspace"],
                ]);
            }
        }

        // Pass 3 — free the session (ALWAYS reached now). Satellites first (their
        // session_cleanup needs the node_sessions rows the DELETE below removes).
        foreach (array_keys($satellites) as $sat) {
            cluster_exec($sat, 'session_cleanup', ['session' => (int) $lab->getSession()]);
        }

        $query =
            "DELETE FROM node_sessions WHERE node_session_lab = :node_session_lab";
        $statement = $db->prepare($query);
        $statement->execute([
            "node_session_lab" => $lab->getSession(),
        ]);

        $query =
            "DELETE FROM lab_sessions WHERE lab_session_id = :lab_session_id";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session_id" => $lab->getSession(),
        ]);

        $query =
            "UPDATE users SET lab_session = null WHERE lab_session = :lab_session";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session" => $lab->getSession(),
        ]);

        // bridge sweep (exact ^vnet<S>_ match) + rm -rf of the session tmp tree
        broker_call('session_cleanup', ['session' => (int) $lab->getSession()]);

        return ["result" => true, "message" => "Success"];
    } catch (Exception $e) {
        return ["result" => false, "message" => $e->getMessage()];
    }
}

function stopLabSession($lab)
{
    // Run when user click on stop all nodes button of lab session
    try {
        $db = checkDatabase();
        deleteWiresharkBySession($db, $lab->getSession());

        $query =
            "SELECT * FROM lab_sessions WHERE lab_session_id=:lab_session_id";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session_id" => $lab->getSession(),
        ]);

        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (!isset($result[0])) {
            throw new Exception("Lab Session not found");
        }

        foreach ($lab->getNodes() as $node_id => $node) {
            if (cluster_session_host($lab, $node_id) > 0) {
                node_wrapper_exec($lab, $node_id, 'stop', $lab->getTenant(), $co, $crc, 600);
                continue;
            }
            $result = stop($node);
            if ($result != 0) {
                throw new Exception("Fail to Stop Node " . $node->getName());
            }
        }

        return ["result" => true, "message" => "Success"];
    } catch (Exception $e) {
        return ["result" => false, "message" => $e->getMessage()];
    }
}

function fwdestroyBrokenLabSession($lab_session)
{
    try {
        $db = checkDatabase();
        deleteWiresharkBySession($db, $lab_session);

        $query =
            "SELECT * FROM lab_sessions WHERE lab_session_id=:lab_session_id";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session_id" => $lab_session,
        ]);

        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (!isset($result[0])) {
            throw new Exception("Lab Session not found");
        }

        $query =
            "SELECT * FROM node_sessions WHERE node_session_lab=:node_session_lab";
        $statement = $db->prepare($query);
        $statement->execute([
            "node_session_lab" => $lab_session,
        ]);

        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        $satellites = [];
        foreach ($result as $node) {
            $nodeHost = isset($node["node_session_host"]) ? (int) $node["node_session_host"] : 0;
            if ($nodeHost > 0 && cluster_host_ip($nodeHost) !== null) {
                $satellites[$nodeHost] = true;
                if ($node["node_session_type"] != "docker") {
                    // same fuser -k, on the satellite that hosts the workspace.
                    // remote docker containers are left to the satellite's
                    // session_cleanup below / a reboot (broken-session edge).
                    cluster_exec($nodeHost, 'node_kill_workspace', [
                        'workspace' => $node["node_session_workspace"],
                    ]);
                }
                continue;
            }
            if ($node["node_session_type"] == "docker") {
                // Lifecycle stop+rm now ride the broker's typed verbs (name
                // derived broker-side from the session id).
                broker_docker_stop((int) $node["node_session_id"]);
                broker_docker_rm((int) $node["node_session_id"], false);
            } else {
                // root-side fuser -k on the node workspace (the old inline
                // string concat dropped the space after "file" = no-op)
                broker_call('node_kill_workspace', [
                    'workspace' => $node["node_session_workspace"],
                ]);
            }
        }
        foreach (array_keys($satellites) as $sat) {
            cluster_exec($sat, 'session_cleanup', ['session' => (int) $lab_session]);
        }

        $query =
            "DELETE FROM node_sessions WHERE node_session_lab = :node_session_lab";
        $statement = $db->prepare($query);
        $statement->execute([
            "node_session_lab" => $lab_session,
        ]);

        $query =
            "DELETE FROM lab_sessions WHERE lab_session_id = :lab_session_id";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session_id" => $lab_session,
        ]);

        $query =
            "UPDATE users SET lab_session = null WHERE lab_session = :lab_session";
        $statement = $db->prepare($query);
        $statement->execute([
            "lab_session" => $lab_session,
        ]);

        // bridge sweep (exact ^vnet<S>_ match) + rm -rf of the session tmp tree
        broker_call('session_cleanup', ['session' => (int) $lab_session]);

        return ["result" => true, "message" => "Success"];
    } catch (Exception $e) {
        return ["result" => false, "message" => $e->getMessage()];
    }
}

$getLabFromSessionResult = [];
function getLabFromSession($lab_session)
{
    if (!isset($GLOBALS["getLabFromSessionResult"][$lab_session])) {
        $db = checkDatabase();
        $query =
            "SELECT * FROM lab_sessions WHERE lab_session_id=:lab_session_id";
        $statement = $db->prepare($query);
        $statement->execute(["lab_session_id" => $lab_session]);
        $result = $statement->fetchAll(PDO::FETCH_ASSOC);

        if (isset($result[0])) {
            $GLOBALS["getLabFromSessionResult"][$lab_session] = $result[0];
        } else {
            $GLOBALS["getLabFromSessionResult"][$lab_session] = null;
        }
    }
    return $GLOBALS["getLabFromSessionResult"][$lab_session];
}

function getAllSessionOfNode($lab_id, $node_id)
{
    $db = checkDatabase();
    $query =
        "SELECT * FROM node_sessions LEFT JOIN lab_sessions ON node_session_lab = lab_session_id WHERE node_session_nid=:node_session_nid AND lab_session_lid = :lab_session_lid";
    $statement = $db->prepare($query);
    $statement->execute([
        "node_session_nid" => $node_id,
        "lab_session_lid" => $lab_id,
    ]);
    $result = $statement->fetchAll(PDO::FETCH_ASSOC);

    foreach ($result as $key => $nodeSession) {
        $result[$key]["node_session_status"] = getNodeStatus(
            $nodeSession["node_session_id"],
            $nodeSession["node_session_type"],
            $nodeSession["node_session_workspace"],
            $nodeSession["node_session_port"],
            $nodeSession["node_session_port_2nd"],
            isset($nodeSession["node_session_host"]) ? (int) $nodeSession["node_session_host"] : 0
        );
    }

    return $result;
}

function getAllUser()
{
    $db = checkDatabase();
    $query = "SELECT * FROM users";
    $statement = $db->prepare($query);
    $statement->execute();
    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    return $result;
}

/** ======================== */

//==========================

// Snapshot every locally-LISTENing TCP port (IPv4 + IPv6) ONCE, so a
// node-status sweep over N nodes costs one read instead of N `netstat|grep|grep`
// forks. Returns an assoc set [portInt => true] for O(1) membership.
//
// Primary source is /proc/net/tcp{,6}: zero fork, and the kernel format is
// stable — line columns are space-separated, col[1] = local_address as
// "HEXIP:HEXPORT" (port is host-order hex after the last colon), col[3] = st
// where 0A = TCP_LISTEN. e.g. "... 00000000:0050 ... 0A ..." => hexdec("0050")
// = 80, LISTEN. Only if BOTH proc files are unreadable do we fall back to a
// SINGLE `ss -ltn` (or `netstat -ltn`) exec — never one probe per node.
function snapshotListeningPorts()
{
    $ports = [];
    $gotProc = false;

    foreach (["/proc/net/tcp", "/proc/net/tcp6"] as $procFile) {
        $lines = @file($procFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if ($lines === false) {
            continue; // this family unreadable; try the other
        }
        $gotProc = true;
        foreach ($lines as $i => $line) {
            if ($i === 0) {
                continue; // header row: "sl  local_address ... st ..."
            }
            $cols = preg_split('/\s+/', trim($line));
            // [0]=sl [1]=local_address [2]=rem_address [3]=st
            if (count($cols) < 4 || strtoupper($cols[3]) !== "0A") {
                continue; // not TCP_LISTEN (0A)
            }
            $colon = strrpos($cols[1], ":");
            if ($colon === false) {
                continue;
            }
            $port = hexdec(substr($cols[1], $colon + 1));
            if ($port > 0) {
                $ports[(int) $port] = true;
            }
        }
    }

    if ($gotProc) {
        return $ports;
    }

    // Fallback: /proc unavailable. One exec, listeners + numeric only (-ltn).
    // In both `ss -ltn` and `netstat -ltn` the Local Address:Port lives in
    // whitespace-token index 3; the port is the part after its last colon.
    $out = [];
    $rc = 1;
    @exec("ss -ltn 2>/dev/null", $out, $rc);
    if ($rc !== 0 || empty($out)) {
        $out = [];
        @exec("netstat -ltn 2>/dev/null", $out, $rc);
    }
    foreach ($out as $line) {
        $cols = preg_split('/\s+/', trim($line));
        if (count($cols) < 4) {
            continue;
        }
        $colon = strrpos($cols[3], ":");
        if ($colon === false) {
            continue; // header / non-address row
        }
        $p = substr($cols[3], $colon + 1);
        if (ctype_digit($p) && (int) $p > 0) {
            $ports[(int) $p] = true;
        }
    }

    return $ports;
}

function getNodesStatus($lab_session)
{
    $db = checkDatabase();
    if ($lab_session === null) {
        $query = "SELECT * FROM node_sessions";
        $statement = $db->prepare($query);
        $statement->execute();
        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        $listening = snapshotListeningPorts();
        foreach ($result as $id => $node) {
            $result[$id]["node_session_status"] = getNodeStatus(
                $node["node_session_id"],
                $node["node_session_type"],
                $node["node_session_workspace"],
                $node["node_session_port"],
                $node["node_session_port_2nd"],
                isset($node["node_session_host"]) ? (int) $node["node_session_host"] : 0,
                $listening
            );
        }
        return $result;
    } else {
        $query =
            "SELECT * FROM node_sessions WHERE node_session_lab=:node_session_lab";
        $statement = $db->prepare($query);
        $statement->execute(["node_session_lab" => $lab_session]);
        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        $status = [];
        $listening = snapshotListeningPorts();
        foreach ($result as $node) {
            $status[$node["node_session_nid"]] = getNodeStatus(
                $node["node_session_id"],
                $node["node_session_type"],
                $node["node_session_workspace"],
                $node["node_session_port"],
                $node["node_session_port_2nd"],
                isset($node["node_session_host"]) ? (int) $node["node_session_host"] : 0,
                $listening
            );
        }
        return $status;
    }
}

function getNodeStatus($session, $type, $running_path, $port, $port_2nd = null, $host = 0, $listening = null)
{
    if (!isset($session)) {
        return 0;
    }

    // Satellite-hosted node: the local netstat/docker/lock-file checks below
    // can't see it, so trust the shared-DB running flag maintained by every
    // node's start/stop wrapper. Do not probe the remote console port: console
    // servers such as VPCS/netprobe treat a TCP connect as a real session and
    // evict the browser's active console. v1: lock/freeze/hibernate sub-states
    // are not detected for remote nodes.
    if ($host > 0) {
        $ip = cluster_host_ip($host);
        if ($ip === null) {
            return 0;
        }
        try {
            $db = checkDatabase();
            $statement = $db->prepare(
                'SELECT node_session_running FROM node_sessions ' .
                'WHERE node_session_id = :s'
            );
            $statement->execute(['s' => $session]);
            $running = (int) $statement->fetchColumn();
            // node_session_running is the 0/1 flag the wrapper sets after start
            // confirmation; the SUM-of-running CPU/RAM queries
            // also test = 1) — NOT the 2=running status code. >=1 = running
            // (status 2 = green).
            return $running >= 1 ? 2 : 0;
        } catch (Exception $e) {
            return 0;
        }
    }

    if ($type == "docker") {
        // Stage 1 (docker rebroker): the read-only running-state probe rides
        // the broker's docker_inspect verb (container name derived broker-side
        // from the typed session id) instead of a www-data exec of the docker
        // CLI. Same contract as before: rc==0 + "true" on line 0 = running.
        $resp = broker_docker_inspect('node',
            ['node_session' => (int) $session], '{{ .State.Running }}');
        if ($resp['ok']) {
            if (isset($resp['out'][0]) && $resp['out'][0] == "true") {
                // Node is running
                if (is_file($running_path . "/.lock")) {
                    // Node is running and locked
                    return 3;
                } else {
                    return 2;
                }
            } else {
                if (is_file($running_path . "/.lock")) {
                    // Node is stopped and locked
                    return 1;
                } else {
                    return 0;
                }
            }
        } else {
            // Instance does not exist
            return 0;
        }
    } else {
        // Need to check if node port is used.
        if ($listening !== null) {
            // Batched sweep: membership against the one-shot LISTEN-port snapshot
            // built by the caller (snapshotListeningPorts()). Exact integer match
            // — no fork, and it fixes the old substring bug where grep ":3276"
            // also matched 32768/32760 etc. $rc keeps the grep contract below:
            // 0 = this port is listening, 1 = not.
            $rc = isset($listening[(int) $port]) ? 0 : 1;
            $o = [];
        } else {
            // Standalone single-node callers (no snapshot passed): keep the
            // original per-call probe verbatim to preserve exact behavior.
            // netstat + grep doesn't require root privileges.
            $cmd = "netstat -a -t -n | grep LISTEN | grep :" . $port . " 2>&1";
            exec($cmd, $o, $rc);
        }
        // A bare port LISTEN is not proof THIS node is up: a foreign/orphaned
        // listener on the same port (e.g. a docker_console leftover from a deleted
        // docker node that reused this node-id, see upg/docker-console-orphan) would
        // otherwise report the node as running and make start() silently no-op. The
        // node's running path (its qemu/iol working dir) only exists while it is
        // actually started, so require both.
        if ($rc == 0 && !is_dir($running_path)) {
            $rc = 1;
            $o = [];
        }
        if ($rc == 0) {
            // Console available -> node is running
            if (is_file($running_path . "/.lock")) {
                // Node is running and locked
                return 3;
            } elseif (is_file($running_path . "/.freeze")) {
                // Node is running and locked
                return 7;
            } else {
                return 2;
            }
        } else {
            // No console available -> node is stopped
            if (is_file($running_path . "/.lock")) {
                // Node is stopped and locked
                return 1;
            } elseif (is_file($running_path . "/.hibernated")) {
                // Node is running and locked
                return 6;
            }else {
                return 0;
            }
        }
    }
}

function createRunningPath($lab_session, $node_session)
{
    return BASE_TMP ."/" . $lab_session . "/" . $node_session;
}

function getTemplates()
{
    $templates = $GLOBALS["node_templates"];
    $qemudir = scandir("/opt/unetlab/addons/qemu/");
    $ioldir = scandir("/opt/unetlab/addons/iol/bin/");
    $dyndir = scandir("/opt/unetlab/addons/dynamips/");
    natcasesort($templates);

    foreach ($templates as $templ => $desc) {
        try {
            if (
                !is_file(BASE_DIR . "/html/" . TPL_DIR . "/" . $templ . ".yml")
            ) {
                unset($templates[$templ]);
                continue;
            }

            $p = yaml_parse_file(
                BASE_DIR . "/html/" . TPL_DIR . "/" . $templ . ".yml"
            );
            if (isset($p["description"])) {
                $desc = $p["description"];
            } else {
                $desc = $templ;
            }

            // }
            if (!isset($p["type"])) {
                unset($templates[$templ]);
                continue;
            }

            $found = 0;
            if (
                $templ == "l2_iol" ||
                $templ == "l3_iol" ||
                $templ == "i86bi_linux" ||
                $templ == "i86bi_linux_l2" ||
                $templ == "i86bi_linux_l3"
            ) {
                foreach ($ioldir as $dir) {
                    if (preg_match("/" . $templ . "/", $dir) == 1) {
                        $found = 1;
                    }
                }
            }
            if ($templ == "iol") {
                foreach ($ioldir as $dir) {
                    if (preg_match("/\.bin/", $dir) == 1) {
                        $found = 1;
                    }
                }
            }
            if ($p["type"] == "dynamips") {
                foreach ($dyndir as $dir) {
                    if (preg_match("/" . $templ . "/", $dir) == 1) {
                        $found = 1;
                        break;
                    }
                }
            }
            if ($templ == "vpcs") {
                $found = 1;
            }

            if ($p["type"] == "docker") {
                if ($templ == "docker") {
                    $found = 1;
                } else {
                    /* Provisioned = $templ appears in a local repo:tag line —
                       evaluated against ONE brokered image-ref list (Stage 5,
                       fetched once per request via the static) instead of
                       exec()ing a `docker images | grep` pipeline per docker
                       template from www-data. Substring match, case-sensitive,
                       exactly what the old grep did over the images table. */
                    static $dockerRefs = null;
                    if ($dockerRefs === null) {
                        $dresp = broker_docker_image_ls('refs');
                        $dockerRefs = (!empty($dresp['ok']) && isset($dresp['out']))
                            ? $dresp['out'] : [];
                    }
                    foreach ($dockerRefs as $refLine) {
                        if (strpos($refLine, $templ) !== false) {
                            $found = 1;
                            break;
                        }
                    }
                }
            }

            foreach ($qemudir as $dir) {
                if (preg_match("/" . $templ . "-.*/", $dir) == 1) {
                    $found = 1;
                }
            }
            if ($found == 0) {
                $templates[$templ] = $desc . TEMPLATE_DISABLED;
            } else {
                $templates[$templ] = $desc;
            }
        } catch (Exception $e) {
            throw new ResponseException("Can not load template {data}", [
                "data" => $templ,
            ]);
        }
    }

    return $templates;
}

/**
 * Map every node template to its `icon:` field (slug => icon filename), parsed
 * live from the template YAMLs. Backs the Add Node picker so each row shows the
 * template's own icon instead of a hardcoded map / Router.png fallback. Templates
 * with no icon field are omitted (the picker falls back for those).
 */
function getTemplateIcons()
{
    // Per-template admin override ("Save as template default") wins over the YAML
    // icon, matching what the canvas + Edit Node use (template_defaults_apply).
    if (
        !function_exists("template_defaults_load") &&
        is_file(BASE_DIR . "/html/includes/api_templatedefaults.php")
    ) {
        require_once BASE_DIR . "/html/includes/api_templatedefaults.php";
    }
    $haveOverrides = function_exists("template_defaults_load");

    $templates = $GLOBALS["node_templates"];
    $icons = [];
    foreach ($templates as $templ => $desc) {
        $f = BASE_DIR . "/html/" . TPL_DIR . "/" . $templ . ".yml";
        if (!is_file($f)) {
            continue;
        }
        $icon = "";
        try {
            $p = yaml_parse_file($f);
            if (is_array($p) && isset($p["icon"]) && $p["icon"] !== "") {
                $icon = $p["icon"];
            }
        } catch (Exception $e) {
            // fall through — an override may still supply the icon
        }
        if ($haveOverrides) {
            $ov = template_defaults_load($templ);
            if (isset($ov["icon"]) && is_string($ov["icon"]) && $ov["icon"] !== "") {
                $icon = $ov["icon"];
            }
        }
        if ($icon !== "") {
            $icons[$templ] = $icon;
        }
    }
    return $icons;
}

function getTemplateTypes()
{
    // Per-template YAML `type` (iol/qemu/docker/dynamips) surfaced for the
    // Add-Node picker so each row can show the node type next to its name.
    // Mirrors getTemplateIcons(); reads the YAML only (admin template-default
    // overrides never change a template's emulation type).
    $templates = $GLOBALS["node_templates"];
    $types = [];
    foreach ($templates as $templ => $desc) {
        $f = BASE_DIR . "/html/" . TPL_DIR . "/" . $templ . ".yml";
        if (!is_file($f)) {
            continue;
        }
        try {
            $p = yaml_parse_file($f);
            if (is_array($p) && isset($p["type"]) && $p["type"] !== "") {
                $types[$templ] = (string) $p["type"];
            }
        } catch (Exception $e) {
            // skip templates that fail to parse
        }
    }
    return $types;
}

function scanDirFiles($path)
{
    if (!is_dir($path)) {
        return [];
    }
    $files = [];
    $scaned = scandir($path);
    array_splice($scaned, 0, 2);
    foreach ($scaned as $item) {
        $itemPath = $path . "/" . $item;
        if (is_file($itemPath)) {
            $files[] = $itemPath;
        } else {
            $files = array_merge($files, scanDirFiles($itemPath));
        }
    }
    return $files;
}

/* license helper */
$user = null;
function getUser()
{
    if ($GLOBALS["user"] != null) {
        return $GLOBALS["user"];
    }
    // was `return $user` — undefined in function scope, so this returned
    // null anyway but warned "undefined variable" into the log on every call
    return null;
}

function getLocalPass()
{
    if ($GLOBALS["user"] != null) {
        return $GLOBALS["user"][USER_PASSWORD];
    }
    return null;
}

$role = null;
function getRole()
{
    if ($GLOBALS["role"] != null) {
        return $GLOBALS["role"];
    }
    $user = getUser();
    if (!$user) {
        return null;
    }
    $db = checkDatabase();
    $query =
        "SELECT * FROM " .
        USER_ROLES_TABLE .
        " WHERE " .
        USER_ROLE_ID .
        " = :role";
    $statement = $db->prepare($query);
    $statement->execute([
        "role" => $user["role"],
    ]);
    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    if (!isset($result[0])) {
        return null;
    }
    $GLOBALS["role"] = $result[0];
    return $GLOBALS["role"];
}

$getRoleByPod = [];
function getRoleByPod($pod)
{
    if (isset($GLOBALS["getRoleByPod"][$pod])) {
        return $GLOBALS["getRoleByPod"][$pod];
    }

    $user = getUser();
    if (!$user) {
        return null;
    }
    if ($user["pod"] == $pod) {
        $GLOBALS["getRoleByPod"][$pod] = getRole();
        return $GLOBALS["getRoleByPod"][$pod];
    }

    $db = checkDatabase();
    $hostLab = getUserByPod($pod);
    if (!$hostLab) {
        return null;
    }
    $roleID = $hostLab[USER_ROLE];

    $query =
        "SELECT * FROM " .
        USER_ROLES_TABLE .
        " WHERE " .
        USER_ROLE_ID .
        " = :role";
    $statement = $db->prepare($query);
    $statement->execute([
        "role" => $roleID,
    ]);
    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    if (!isset($result[0])) {
        return null;
    }

    $GLOBALS["getRoleByPod"][$pod] = $result[0];
    return $GLOBALS["getRoleByPod"][$pod];
}

$userByPod = [];
function getUserByPod($pod)
{
    if (!isset($userByPod[$pod])) {
        $db = checkDatabase();
        $query =
            "SELECT * FROM " . USERS_TABLE . " WHERE " . USER_POD . " = :pod";
        $statement = $db->prepare($query);
        $statement->execute([
            "pod" => $pod,
        ]);
        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (!isset($result[0])) {
            return false;
        }
        $userByPod[$pod] = $result[0];
    }
    return $result[0];
}

function getTotalDisk()
{
    $cmd = "df -k /";
    exec($cmd, $o, $rc);
    $data = [];
    foreach ($o as $output) {
        if (
            preg_match(
                '/^.*\s([\d\.]+)\s+([\d\.]+)\s+([\d\.]+)\s+([\d]+)%.*$/mi',
                $output,
                $match
            )
        ) {
            $data["free"] = (int) $match[3];
            $data["used"] = (int) $match[2];
            $data["total"] = (int) $match[1];
            $data["percent"] = (float) $match[4];
        }
    }
    return $data;
}

function checkRunningNodeLimit($pod)
{
    if (isAdmin()) {
        return true;
    }
    $hostLab = getUserByPod($pod);
    if (!$hostLab) {
        throw new ResponseException("User not exist");
    }
    if ($hostLab[USER_ROLE] == 0) {
        return true;
    }

    $checkMaxNode = false;
    if (isset($hostLab[USER_MAX_NODE]) && $hostLab[USER_MAX_NODE] > 0) {
        $checkMaxNode = true;
    }
    $checkMaxNodeLab = false;
    if (isset($hostLab[USER_MAX_NODELAB]) && $hostLab[USER_MAX_NODELAB] > 0) {
        $checkMaxNodeLab = true;
    }

    if (!$checkMaxNode && !$checkMaxNodeLab) {
        return true;
    }

    $db = checkDatabase();
    $query =
        "SELECT COUNT(*) as total_running_node FROM " .
        NODE_SESSIONS_TABLE .
        " WHERE " .
        NODE_SESSION_POD .
        " = :pod AND " .
        NODE_SESSION_RUNNING .
        " = 1";

    $statement = $db->prepare($query);
    $statement->execute([
        "pod" => $pod,
    ]);
    $result = $statement->fetch(PDO::FETCH_ASSOC);

    $totalRunningNode = $result["total_running_node"];

    if ($checkMaxNode) {
        if ($totalRunningNode >= $hostLab[USER_MAX_NODE]) {
            throw new ResponseException("max_running_node_limit", [
                "data" => $hostLab[USER_MAX_NODE],
            ]);
        }
    }

    if ($checkMaxNodeLab) {
        if ($totalRunningNode >= $hostLab[USER_MAX_NODELAB]) {
            throw new ResponseException("max_running_nodelab_limit", [
                "data" => $hostLab[USER_MAX_NODELAB],
            ]);
        }
    }

    return true;
}

function checkLimit($pod)
{
    if (isAdmin()) {
        return true;
    }
    $role = getRoleByPod($pod);
    $ramLimit = $role[USER_ROLE_RAM];
    $cpuLimit = $role[USER_ROLE_CPU];
    $hddLimit = $role[USER_ROLE_HDD];

    if ($ramLimit == "" || $ramLimit > 95) {
        $ramLimit = 95;
    }
    if ($cpuLimit == "" || $cpuLimit > 95) {
        $cpuLimit = 95;
    }
    if ($hddLimit == "") {
        $disk = getTotalDisk();
        $totalDisk = isset($disk["total"]) ? $disk["total"] / 1024 : 0;
        $hddLimit = $totalDisk - 512;
    }

    $db = checkDatabase();
    $query =
        "SELECT SUM(" .
        NODE_SESSION_RAM .
        ") as consume_ram, SUM(" .
        NODE_SESSION_CPU .
        ") as consume_cpu, SUM(" .
        NODE_SESSION_HDD .
        ") as consume_hdd FROM " .
        NODE_SESSIONS_TABLE .
        " WHERE " .
        NODE_SESSION_POD .
        " = :pod";

    $statement = $db->prepare($query);
    $statement->execute([
        "pod" => $pod,
    ]);
    $result = $statement->fetch(PDO::FETCH_ASSOC);
    $consumeRam = $result["consume_ram"];
    $consumeCpu = $result["consume_cpu"];
    $consumeHdd = $result["consume_hdd"];
    if ($consumeCpu >= $cpuLimit) {
        throw new Exception(
            "Over the threshold:" .
                $cpuLimit .
                "% CPU. Please turn off idle Devices"
        );
    }
    if ($consumeRam >= $ramLimit) {
        throw new Exception(
            "Over the threshold:" .
                $ramLimit .
                "% RAM. Please turn off idle Devices"
        );
    }
    if ($consumeHdd >= $hddLimit) {
        throw new Exception(
            "Over the threshold:" .
                $hddLimit .
                "MB Hard disk. Please Wipe or Destroy idle Devices and Labs"
        );
    }

    return true;
}

$permission = null;
function getPermission()
{
    if ($GLOBALS["permission"] != null) {
        return $GLOBALS["permission"];
    }
    $role = getRole();
    if (!$role) {
        return null;
    }
    $roleId = $role[USER_ROLE_ID];
    $db = checkDatabase();
    $query =
        "SELECT * FROM " .
        USER_PERMISSION_TABLE .
        " WHERE " .
        USER_PER_ROLE .
        " = :role_id";
    $statement = $db->prepare($query);
    $statement->execute([
        "role_id" => $roleId,
    ]);
    $result = $statement->fetchAll(PDO::FETCH_ASSOC);
    $GLOBALS["permission"] = $result;
    return $GLOBALS["permission"];
}

function isAdmin()
{
    $user = getUser();
    if (!$user) {
        return false;
    }
    return (int) $user["role"] === 0;
}

function isOffline()
{
    $user = getUser();
    if (!$user) {
        return false;
    }
    return $user["offline"] == 1;
}

function checkLockLab($lab)
{
    if ($lab->isLock()) {
        throw new Exception("This lab is locked, Please unlock it first");
    }
}

function getSharedFolder()
{
    try {
        $db = checkDatabase();
        $query = "SELECT * FROM control WHERE control_name=:control_name";
        $statement = $db->prepare($query);
        $statement->execute(["control_name" => CTRL_SHARED]);
        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (isset($result[0])) {
            return json_decode($result[0][CONTROL_VALUE]);
        } else {
            return [];
        }
    } catch (Exception $th) {
        return [];
    }
}

function checkSharePermission($action)
{
    if (isAdmin()) {
        return true;
    }
    try {
        $db = checkDatabase();
        $query = "SELECT * FROM control WHERE control_name=:control_name";
        $statement = $db->prepare($query);
        $statement->execute(["control_name" => CTRL_SHARED_PERMISSION]);
        $result = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (isset($result[0])) {
            $permission = json_decode($result[0][CONTROL_VALUE]);
        } else {
            $permission = (object) [];
        }
    } catch (Exception $th) {
        $permission = (object) [];
    }
    if (!isset($permission->{$action})) {
        return false;
    }
    return $permission->{$action};
}

function checkWorkSpace($path, $allowShare = false)
{
    if (isAdmin()) {
        return true;
    }

    $path = str_replace(["//", "."], ["/", ""], $path);
    if ($path[-1] != "/") {
        $path .= "/";
    }

    if ($allowShare) {
        $sharedFolders = getSharedFolder();
        foreach ($sharedFolders as $sharedFolder) {
            $sharedFolder = preg_replace(
                "/" . preg_quote(BASE_LAB, "/") . "/",
                "",
                $sharedFolder,
                1
            );
            if ($sharedFolder[-1] != "/") {
                $sharedFolder .= "/";
            }
            if (strpos($path, $sharedFolder) === 0) {
                return true;
            }
        }
    }

    $workspace = getWorkspace();

    if ($workspace[-1] != "/") {
        $workspace .= "/";
    }
    if (strpos($path, $workspace) === 0) {
        return true;
    }
    throw new Exception("You do not have permission to access folder " . $path);
}

function getWorkspace()
{
    if (isAdmin()) {
        return "/";
    }

    $role = getRole();
    if ($role == "null") {
        throw new Exception("You do not have permission");
    }
    $workspace = $role["user_role_workspace"];

    // Per-user workspace OVERRIDE: when a user carries their own user_workspace
    // it REPLACES the role default (delegation), instead of being appended to it.
    // Blank/NULL falls back to the role workspace. This lets an admin hand one
    // user a different subtree without minting a whole new role.
    $user = getUser();
    if (
        isset($user[USER_WORKSPACE]) &&
        $user[USER_WORKSPACE] != null &&
        $user[USER_WORKSPACE] != ""
    ) {
        $workspace = $user[USER_WORKSPACE];
        $workspace = str_replace("//", "/", $workspace);
    }

    if ($workspace[0] != "/") {
        $workspace = "/" . $workspace;
    }

    if (!is_dir(BASE_LAB . $workspace)) {
        mkdir(BASE_LAB . $workspace, 0755, true);
    }

    return $workspace;
}

function checkPermission($action)
{
    if (isAdmin()) {
        return true;
    }
    $permission = getPermission();
    if (!$permission) {
        throw new Exception("You do not have permission");
    }
    foreach ($permission as $item) {
        if ($item[USER_PER_NAME] == $action) {
            return true;
        }
    }
    throw new Exception("You do not have permission");
}

/**
 * Canonicalize instructor-authored task HTML to the small rich-text subset
 * rendered by the live-lab page. This intentionally has no external
 * dependency: the same function is used on task writes and defensive reads.
 *
 * The tag/class/attribute vocabulary below is not guesswork: it was captured by
 * running Quill 2 + quill-table-better in a browser, building a table (merged
 * cell, header row, per-cell background, list and heading inside cells, column
 * resize, section divider) and reading back the editor's own
 * getSemanticHTML()/root.innerHTML. Anything the editor cannot actually emit is
 * deliberately absent. Class names and inline styles are re-serialized from a
 * validated allowlist, so no attacker-controlled token is ever echoed verbatim.
 *
 * Manual smoke vectors (run after loading this file in a PHP process):
 * assert(sanitizeTaskHtml('<script>alert(1)</script>') === '');
 * assert(sanitizeTaskHtml('<a href="javascript:alert(1)">x</a>') === '<a rel="noopener noreferrer">x</a>');
 * assert(sanitizeTaskHtml('<h2>Objective</h2><p><strong>Formatted</strong> text</p>') === '<h2>Objective</h2><p><strong>Formatted</strong> text</p>');
 * assert(sanitizeTaskHtml('<td>orphan</td>') === 'orphan');
 */
function sanitizeTaskHtml(string $html): string
{
    $allowed = array_fill_keys([
        'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'sub', 'sup', 'strong', 'em', 'u', 's',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'span',
        'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col',
    ], true);
    $removeWithContents = array_fill_keys([
        'script', 'style', 'iframe', 'object', 'embed', 'applet',
        'frame', 'frameset', 'link', 'meta', 'base', 'img', 'image',
        'source', 'video', 'audio', 'track', 'svg', 'math', 'template',
        'noscript',
        // quill-table-better parks a table's own attributes in a <temporary>
        // blot while editing. The client strips it before submitting; drop it
        // (with its <br> placeholder) here too rather than unwrapping it into
        // stray markup inside the table.
        'temporary',
    ], true);

    // class="" is only ever kept for the exact structural class names the editor
    // emits — never a prefix match, so an arbitrary attacker-chosen class name
    // can never reach the rendered page.
    $alignClasses = ['ql-align-center', 'ql-align-right', 'ql-align-justify'];
    $allowedClasses = [
        'table' => ['ql-table-better'],
        'p' => array_merge(['ql-table-block', 'table-th-block'], $alignClasses),
        'h2' => array_merge(['ql-table-header'], $alignClasses),
        'h3' => array_merge(['ql-table-header'], $alignClasses),
        'h4' => array_merge(['ql-table-header'], $alignClasses),
        'ul' => ['table-list-container'],
        'ol' => ['table-list-container'],
        'li' => array_merge(['table-list'], $alignClasses),
        'blockquote' => $alignClasses,
        'pre' => $alignClasses,
    ];

    // Per-tag attribute allowlist. Every value is validated below; an attribute
    // whose value fails validation is dropped, never partially kept.
    $allowedAttributes = [
        'a' => ['href', 'rel', 'target'],
        'table' => ['class', 'style', 'border', 'cellspacing'],
        'col' => ['span', 'width', 'style'],
        'td' => ['class', 'style', 'data-row', 'colspan', 'rowspan', 'width', 'height'],
        'th' => ['class', 'style', 'data-row', 'colspan', 'rowspan', 'width', 'height'],
        'p' => ['class', 'data-cell'],
        'h2' => ['class', 'data-cell'],
        'h3' => ['class', 'data-cell'],
        'h4' => ['class', 'data-cell'],
        'ul' => ['class', 'data-row', 'data-cell'],
        'ol' => ['class', 'data-row', 'data-cell'],
        'li' => ['class', 'data-list'],
        'blockquote' => ['class'],
        'pre' => ['class', 'data-language'],
        'span' => ['style'],
    ];

    // Inline style is restricted to the exact property set the table module
    // writes (cell/table properties form + column-resize drag), with values
    // re-emitted from validated tokens only.
    $styleKeywords = [
        'text-align' => ['left', 'right', 'center', 'justify'],
        'vertical-align' => ['top', 'middle', 'bottom', 'baseline'],
        'border-style' => ['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'],
    ];
    $styleShapes = [
        'width' => 'length', 'height' => 'length',
        'border-width' => 'length', 'margin-left' => 'length', 'margin-right' => 'length',
        'padding' => 'lengths', 'margin' => 'lengths',
        'background-color' => 'color', 'color' => 'color', 'border-color' => 'color',
        'border' => 'border',
    ];

    // Table structure only survives where it is legal. DOMDocument's fragment
    // parser happily keeps a bare <td> inside a <div>, which would then render
    // as loose text; unwrap anything whose parent cannot legally contain it.
    $requiredParents = [
        'tr' => ['table', 'thead', 'tbody'],
        'td' => ['tr'],
        'th' => ['tr'],
        'thead' => ['table'],
        'tbody' => ['table'],
        'colgroup' => ['table'],
        'col' => ['colgroup'],
        'li' => ['ul', 'ol'],
    ];

    $isLengthToken = function ($token) {
        return (bool) preg_match('/^(auto|0|\d{1,5}(\.\d{1,3})?(px|%|em|rem|pt))$/', $token);
    };
    $isColorToken = function ($token) {
        if (preg_match('/^#[0-9a-f]{3,8}$/', $token)) {
            return true;
        }
        if (preg_match('/^rgba?\(\s*\d{1,3}(\.\d{1,3})?%?\s*(,\s*\d{1,3}(\.\d{1,3})?%?\s*){2,3}\)$/', $token)) {
            return true;
        }
        // CSS colour keywords ("transparent", "lightgoldenrodyellow", …).
        return (bool) preg_match('/^[a-z]{3,24}$/', $token);
    };

    $sanitizeStyle = function ($value) use ($styleKeywords, $styleShapes, $isLengthToken, $isColorToken) {
        $value = strtolower(trim((string) $value));
        if ($value === '' || strlen($value) > 400) {
            return '';
        }
        // Nothing in the allowed value shapes needs any of these; their presence
        // means the declaration is not something this editor produced.
        if (preg_match('/url\(|expression\(|@import|javascript:|<|>|\\\\|"|\'|\/\*|&/', $value)) {
            return '';
        }
        $kept = [];
        foreach (explode(';', $value) as $declaration) {
            if (strpos($declaration, ':') === false) {
                continue;
            }
            list($property, $raw) = explode(':', $declaration, 2);
            $property = trim($property);
            $raw = trim(preg_replace('/\s+/', ' ', $raw));
            if ($raw === '' || strlen($raw) > 80) {
                continue;
            }
            if (isset($styleKeywords[$property])) {
                if (in_array($raw, $styleKeywords[$property], true)) {
                    $kept[] = $property . ': ' . $raw;
                }
                continue;
            }
            if (!isset($styleShapes[$property])) {
                continue;
            }
            // rgb()/rgba() carry internal commas; keep them as one token.
            $tokens = preg_match('/^rgba?\(/', $raw) ? [$raw] : explode(' ', $raw);
            if (!$tokens || count($tokens) > 4) {
                continue;
            }
            $ok = true;
            switch ($styleShapes[$property]) {
                case 'length':
                    $ok = count($tokens) === 1 && $isLengthToken($tokens[0]);
                    break;
                case 'lengths':
                    foreach ($tokens as $token) {
                        if (!$isLengthToken($token)) {
                            $ok = false;
                        }
                    }
                    break;
                case 'color':
                    $ok = count($tokens) === 1 && $isColorToken($tokens[0]);
                    break;
                case 'border':
                    if (count($tokens) > 3) {
                        $ok = false;
                        break;
                    }
                    foreach ($tokens as $token) {
                        if (!$isLengthToken($token)
                            && !in_array($token, $styleKeywords['border-style'], true)
                            && !$isColorToken($token)) {
                            $ok = false;
                        }
                    }
                    break;
                default:
                    $ok = false;
            }
            if ($ok) {
                $kept[] = $property . ': ' . $raw;
            }
        }
        return implode('; ', $kept);
    };

    $sanitizeAttributeValue = function ($tag, $name, $value) use ($sanitizeStyle, $allowedClasses) {
        $value = trim((string) $value);
        switch ($name) {
            case 'style':
                return $sanitizeStyle($value);
            case 'class':
                $permitted = isset($allowedClasses[$tag]) ? $allowedClasses[$tag] : [];
                $kept = [];
                foreach (preg_split('/\s+/', $value, -1, PREG_SPLIT_NO_EMPTY) as $token) {
                    if (in_array($token, $permitted, true) && !in_array($token, $kept, true)) {
                        $kept[] = $token;
                    }
                }
                return implode(' ', $kept);
            case 'colspan':
            case 'rowspan':
            case 'span':
                return preg_match('/^\d{1,2}$/', $value) && (int) $value >= 1 && (int) $value <= 50
                    ? (string) (int) $value : '';
            case 'border':
            case 'cellspacing':
                return preg_match('/^\d{1,2}$/', $value) ? (string) (int) $value : '';
            case 'width':
            case 'height':
                // The module writes plain pixel counts, and percentages for
                // percent-width tables.
                return preg_match('/^\d{1,5}(\.\d{1,3})?%?$/', $value) ? $value : '';
            case 'data-row':
                return preg_match('/^row-[a-z0-9_-]{1,16}$/i', $value) ? $value : '';
            case 'data-cell':
                return preg_match('/^cell-[a-z0-9_-]{1,16}$/i', $value) ? $value : '';
            case 'data-list':
                return in_array($value, ['bullet', 'ordered', 'checked', 'unchecked'], true) ? $value : '';
            case 'data-language':
                return preg_match('/^[a-z0-9+#._-]{1,24}$/i', $value) ? $value : '';
            case 'target':
                return $value === '_blank' ? '_blank' : '';
            default:
                return $value;
        }
    };

    $previousLibxmlMode = libxml_use_internal_errors(true);
    $sanitized = '';
    try {
        $dom = new DOMDocument('1.0', 'UTF-8');
        $dom->preserveWhiteSpace = true;
        $rootId = '__pnetlab_task_html_root__';
        $loaded = $dom->loadHTML(
            '<?xml encoding="utf-8" ?><div id="' . $rootId . '">' . $html . '</div>',
            LIBXML_HTML_NODEFDTD | LIBXML_NONET
        );
        if (!$loaded) {
            throw new Exception('Unable to parse task HTML');
        }

        $xpath = new DOMXPath($dom);
        $rootNodes = $xpath->query('//*[@id="' . $rootId . '"]');
        $root = ($rootNodes !== false) ? $rootNodes->item(0) : null;
        if (!$root) {
            throw new Exception('Unable to parse task HTML');
        }

        $isSafeHref = function ($href) {
            $href = trim((string) $href);
            if ($href === '') {
                return true;
            }
            // Reject control characters and protocol-relative/backslash-host URLs.
            if (preg_match('/[\x00-\x1F\x7F]/', $href) || $href[0] === '\\' || strpos($href, '//') === 0) {
                return false;
            }
            if (preg_match('/^[a-z][a-z0-9+.-]*:/i', $href)) {
                return (bool) preg_match('/^https?:\/\//i', $href);
            }
            return true;
        };

        $sanitizeChildren = null;
        $sanitizeChildren = function ($parent) use (
            &$sanitizeChildren,
            $allowed,
            $removeWithContents,
            $isSafeHref,
            $allowedAttributes,
            $sanitizeAttributeValue,
            $requiredParents
        ) {
            $parentTag = strtolower($parent->nodeName);
            $children = [];
            foreach ($parent->childNodes as $child) {
                $children[] = $child;
            }

            foreach ($children as $child) {
                if ($child->parentNode !== $parent) {
                    continue;
                }
                if ($child->nodeType === XML_COMMENT_NODE) {
                    $parent->removeChild($child);
                    continue;
                }
                if ($child->nodeType !== XML_ELEMENT_NODE) {
                    continue;
                }

                $tag = strtolower($child->nodeName);
                if (isset($removeWithContents[$tag])) {
                    $parent->removeChild($child);
                    continue;
                }

                // Sanitize descendants before unwrapping unknown formatting tags.
                $sanitizeChildren($child);
                $misplaced = isset($requiredParents[$tag])
                    && !in_array($parentTag, $requiredParents[$tag], true);
                if (!isset($allowed[$tag]) || $misplaced) {
                    while ($child->firstChild) {
                        $parent->insertBefore($child->firstChild, $child);
                    }
                    $parent->removeChild($child);
                    continue;
                }

                $attributes = [];
                foreach ($child->attributes as $attribute) {
                    $attributes[] = $attribute->name;
                }
                $permitted = isset($allowedAttributes[$tag]) ? $allowedAttributes[$tag] : [];
                foreach ($attributes as $attributeName) {
                    $name = strtolower($attributeName);
                    if (!in_array($name, $permitted, true)) {
                        $child->removeAttribute($attributeName);
                        continue;
                    }
                    if ($name === 'href' || $name === 'rel') {
                        continue; // handled by the <a> rules below
                    }
                    $value = $sanitizeAttributeValue($tag, $name, $child->getAttribute($attributeName));
                    if ($value === '') {
                        $child->removeAttribute($attributeName);
                    } else {
                        $child->setAttribute($attributeName, $value);
                    }
                }

                if ($tag === 'a') {
                    if ($child->hasAttribute('href') && !$isSafeHref($child->getAttribute('href'))) {
                        $child->removeAttribute('href');
                    }
                    $child->setAttribute('rel', 'noopener noreferrer');
                }
            }
        };

        $sanitizeChildren($root);
        foreach ($root->childNodes as $child) {
            $sanitized .= $dom->saveHTML($child);
        }
    } finally {
        libxml_clear_errors();
        libxml_use_internal_errors($previousLibxmlMode);
    }

    // Raised from 64 KB when tables landed: the table module's serialization is
    // structurally verbose (~110-140 bytes per cell once data-row/data-cell ids
    // and the per-cell <p class="ql-table-block"> wrapper are counted), so a
    // couple of ordinary 10x8 instruction tables plus prose already approached
    // the old ceiling. 256 KB keeps a hard bound on what a single <workbook>
    // entry can add to the lab's .unl XML while leaving real tables room.
    if (strlen($sanitized) > (256 * 1024)) {
        throw new Exception('Task HTML must be 256 KB or smaller after sanitization');
    }
    return $sanitized;
}

// Non-throwing companion to checkPermission(): true iff the current non-admin
// user's role grants $action. checkLabPermission() uses this so a custom role
// holding OPEN_LAB/JOIN_LAB/EDIT_LAB actually lets the user open/join/edit labs
// in their (already workspace-confined) scope — previously these permissions
// were stored by the roles UI but never consulted, so they were dead. The
// per-lab openable/joinable/editable flags remain as an ADDITIVE share grant
// for users who lack the role permission.
function roleHasPermission($action)
{
    $permission = getPermission();
    if (!$permission) {
        return false;
    }
    foreach ($permission as $item) {
        if ($item[USER_PER_NAME] == $action) {
            return true;
        }
    }
    return false;
}

function checkLabPermission($lab, $action)
{
    if (isAdmin()) {
        return true;
    }

    $user = getUser();
    if (!$user) {
        throw new Exception("You do not have permission");
    }

    if ($action == USER_PER_EDIT_LAB) {
        if (roleHasPermission(USER_PER_EDIT_LAB)) {
            return true;
        }
        $flag = $lab->getEditable();
        if ($flag == 0) {
            throw new Exception("You do not have permission to Edit this Lab");
        }
        if ($flag == 1) {
            return true;
        }
        $allowes = $lab->getEditableEmails();
        $email = $user["email"];
        $pod = $user["pod"];
        if (
            array_search($email, $allowes) !== false ||
            array_search($pod, $allowes) !== false
        ) {
            return true;
        }
        throw new Exception("You do not have permission to Edit this Lab");
    } elseif ($action == USER_PER_OPEN_LAB) {
        if (roleHasPermission(USER_PER_OPEN_LAB)) {
            return true;
        }
        $flag = $lab->getOpenable();
        if ($flag == 0) {
            throw new Exception("You do not have permission to Open this Lab");
        }
        if ($flag == 1) {
            return true;
        }
        $allowes = $lab->getOpenableEmails();
        $email = $user["email"];
        $pod = $user["pod"];
        if (
            array_search($email, $allowes) !== false ||
            array_search($pod, $allowes) !== false
        ) {
            return true;
        }
        throw new Exception("You do not have permission to Open this Lab");
    } elseif ($action == USER_PER_JOIN_LAB) {
        if (roleHasPermission(USER_PER_JOIN_LAB)) {
            return true;
        }
        $flag = $lab->getJoinable();
        if ($flag == 0) {
            throw new Exception("You do not have permission to Join this Lab");
        }
        if ($flag == 1) {
            return true;
        }
        $allowes = $lab->getJoinableEmails();
        $email = $user["email"];
        $pod = $user["pod"];
        if (
            array_search($email, $allowes) !== false ||
            array_search($pod, $allowes) !== false
        ) {
            return true;
        }
        throw new Exception("You do not have permission to Join this Lab");
    } elseif ($action == USER_PER_EDIT_TASKS) {
        if (roleHasPermission(USER_PER_EDIT_TASKS)) {
            return true;
        }
        throw new Exception("You do not have permission");
    }
    throw new Exception("You do not have permission");
}

function checkDestroy($lab_session)
{
    if (isAdmin()) {
        return true;
    }
    $user = getUser();
    if (!$user) {
        throw new Exception("You do not have permission");
    }
    $labSession = getLabFromSession($lab_session);
    if (!$lab_session) {
        throw new Exception("You do not have permission");
    }
    if ($labSession["lab_session_pod"] == $user["pod"]) {
        return true;
    }
    throw new Exception("Only Admin or Host can destroy the Lab Session");
}

function checkStopNodes($lab_session)
{
    // Function check before user click on stop all nodes
    if (isAdmin()) {
        return true;
    }
    $user = getUser();
    if (!$user) {
        throw new Exception("You do not have permission");
    }
    $labSession = getLabFromSession($lab_session);
    if (!$lab_session) {
        throw new Exception("You do not have permission");
    }
    if ($labSession["lab_session_pod"] == $user["pod"]) {
        return true;
    }
    throw new Exception("Only Admin or Host can Stop this Lab Session");
}

function loadLanguage($lang)
{
    if (!isset($lang) || $lang == "") {
        $lang = Ctrl_get(CTRL_DEFAULT_LANG, "English");
    }
    if ($lang == "") {
        $lang = "English";
    }
    $LANGDIR = "/opt/unetlab/html/language";
    $langPackes = scandir($LANGDIR);
    array_splice($langPackes, 0, 2);
    $langData = [];
    $log = "Load language packages successfull";
    if (is_dir($LANGDIR . "/" . $lang)) {
        $langFiles = scandir($LANGDIR . "/" . $lang);
        array_splice($langFiles, 0, 2);

        foreach ($langFiles as $file) {
            try {
                $fileContent = file_get_contents(
                    $LANGDIR . "/" . $lang . "/" . $file
                );
                $data = json_decode($fileContent, true);
                $langData = array_merge($langData, $data);
            } catch (\Exception $th) {
                $log =
                    "[Warning] Load language package faild: " .
                    $lang .
                    "/" .
                    $file;
            }
        }
    }
    return [
        "packages" => $langPackes,
        "language" => $lang,
        "data" => (object) $langData,
        "log" => $log,
    ];
}

/* ==========================================================================
 * Per-IP failed-login throttling for POST /api/auth.
 *
 * Ported from the working memory-only lockout in scripts/mcp/pnetlab-mcp.py
 * (FAIL_MAX / FAIL_WINDOW / FAIL_BLOCK, success clears the record, bounded
 * table). PHP has no cross-request memory, so state is one small file per IP
 * under /dev/shm - the same idiom already used by token_mint.php,
 * node-errors/api.php and pnq-linkwatch.php.
 *
 * Design constraints, chosen so this can never strand an operator:
 *   - PER-IP, never global: one attacker cannot lock out everybody else.
 *   - Block window is MINUTES (5), not hours, and is self-clearing: the record
 *     expires on its own, no admin action required.
 *   - /dev/shm is tmpfs, so a reboot ALWAYS clears every lockout.
 *   - Manual reset (documented, no restart needed):
 *         rm -rf /dev/shm/pnet-authfail          # clear all
 *         rm -f  /dev/shm/pnet-authfail/<sha1>   # clear one IP
 *
 * Identity is $_SERVER['REMOTE_ADDR'] only. X-Forwarded-For is deliberately
 * NOT honoured: Apache serves clients directly here, and trusting XFF would
 * let an attacker both evade their own throttle and forge someone else's
 * identity to lock them out.
 * ========================================================================== */
define("AUTH_FAIL_DIR", "/dev/shm/pnet-authfail");
define("AUTH_FAIL_MAX", 10);      // failures allowed inside the window
define("AUTH_FAIL_WINDOW", 300);  // seconds the failure count accumulates over
define("AUTH_FAIL_BLOCK", 300);   // seconds blocked once MAX is exceeded
define("AUTH_FAIL_CAP", 4096);    // max tracked IPs (anti memory-DoS)

function authThrottleFile($ip)
{
    if (!is_dir(AUTH_FAIL_DIR)) {
        @mkdir(AUTH_FAIL_DIR, 0700, true);
    }
    return AUTH_FAIL_DIR . "/" . sha1((string) $ip);
}

/**
 * Seconds the caller must still wait, or 0 if not currently blocked.
 */
function authThrottleRetryAfter($ip)
{
    $f = authThrottleFile($ip);
    if (!is_file($f)) return 0;
    $rec = json_decode((string) @file_get_contents($f), true);
    if (!is_array($rec)) return 0;
    $until = isset($rec["until"]) ? (int) $rec["until"] : 0;
    $now = time();
    if ($until > $now) return $until - $now;
    return 0;
}

/**
 * Record one failed attempt; starts a block once MAX is exceeded.
 */
function authThrottleFail($ip)
{
    $f = authThrottleFile($ip);
    $now = time();
    $rec = array("n" => 0, "first" => $now, "until" => 0);
    if (is_file($f)) {
        $old = json_decode((string) @file_get_contents($f), true);
        if (is_array($old) && isset($old["first"]) && ($now - (int) $old["first"]) <= AUTH_FAIL_WINDOW) {
            $rec = array(
                "n" => (int) get($old["n"], 0),
                "first" => (int) $old["first"],
                "until" => (int) get($old["until"], 0),
            );
        }
    }
    $rec["n"]++;
    if ($rec["n"] > AUTH_FAIL_MAX) {
        $rec["until"] = $now + AUTH_FAIL_BLOCK;
    }
    @file_put_contents($f, json_encode($rec), LOCK_EX);
    @chmod($f, 0600);

    // Occasional bounded sweep of expired records so the directory cannot grow
    // without limit; cheap because it only runs ~2% of failed attempts.
    if (mt_rand(1, 50) === 1) {
        authThrottleSweep();
    }
    return $rec;
}

/**
 * Clear an IP's record (called on successful authentication).
 */
function authThrottleClear($ip)
{
    @unlink(authThrottleFile($ip));
}

/**
 * Drop records whose window and block have both lapsed; hard-cap the table.
 */
function authThrottleSweep()
{
    $files = @glob(AUTH_FAIL_DIR . "/*");
    if (!is_array($files)) return;
    $now = time();
    foreach ($files as $f) {
        $rec = json_decode((string) @file_get_contents($f), true);
        if (!is_array($rec)) { @unlink($f); continue; }
        $until = (int) get($rec["until"], 0);
        $first = (int) get($rec["first"], 0);
        if ($until <= $now && ($now - $first) > AUTH_FAIL_WINDOW) {
            @unlink($f);
        }
    }
    $files = @glob(AUTH_FAIL_DIR . "/*");
    if (is_array($files) && count($files) > AUTH_FAIL_CAP) {
        usort($files, function ($a, $b) { return filemtime($a) - filemtime($b); });
        foreach (array_slice($files, 0, count($files) - AUTH_FAIL_CAP) as $f) {
            @unlink($f);
        }
    }
}

/**
 * Single source of truth for account-containment checks (status / activation
 * date / expiry date / allowed weekdays).
 *
 * Returns null when the account may be used, otherwise array(reason, detail).
 * Callers map the reason onto their own exception type so existing i18n keys
 * on the authenticated path are preserved.
 *
 * Deliberately NOT exempting admins: previously all four checks sat behind
 * "if (role != 0)", which meant a disabled admin account was never actually
 * disabled. Verified on a production appliance that the admin account has
 * user_status=1 and NULL active_time/expired_time/access_days, i.e. it passes
 * every check. A field that is NULL/absent/0 never denies, so no account can
 * be locked out by this unless an operator explicitly set a denying value.
 *
 * Recovery if an operator disables the last admin:
 *   mysql -e "UPDATE users SET user_status=1, active_time=NULL,
 *             expired_time=NULL, access_days=NULL WHERE username='admin';" pnetlab_db
 */
function userContainmentViolation($row)
{
    $now = time();

    if (!isset($row[USER_STATUS]) || $row[USER_STATUS] != USER_STATUS_ACTIVE) {
        return array("disabled", null);
    }
    if (isset($row[USER_ACTIVE_TIME]) && $row[USER_ACTIVE_TIME] > 0 && $row[USER_ACTIVE_TIME] > $now) {
        return array("unactive", date("Y-m-d H:i", $row[USER_ACTIVE_TIME]));
    }
    if (isset($row[USER_EXPIRED_TIME]) && $row[USER_EXPIRED_TIME] > 0 && $row[USER_EXPIRED_TIME] < $now) {
        return array("expired", date("Y-m-d H:i", $row[USER_EXPIRED_TIME]));
    }
    $accessDays = isset($row["access_days"]) ? trim((string) $row["access_days"]) : "";
    if ($accessDays !== "" && strpos($accessDays, (string) date("N", $now)) === false) {
        return array("days", $accessDays);
    }
    return null;
}

/**
 * Denylist filter for ALREADY-ASSEMBLED shell command lines.
 *
 * Callers of this function pass a complete command string that legitimately
 * contains shell syntax: redirections ("2>&1"), background ("&"), and globs
 * ("*.unl" in the lab-import unzip). An allowlist is therefore impossible
 * here -- the only correct fix for these sites is escapeshellarg() on each
 * interpolated operand at the point of assembly, which is a larger refactor.
 *
 * Until then this stays a denylist, but a strictly stronger one: it now also
 * rejects command substitution (backtick, "$(", "${") and embedded newlines,
 * none of which any legitimate assembled command in this codebase contains.
 * Characters that ARE legitimately present (& > < * ?) are deliberately NOT
 * blocked, because doing so would break node start, link setup and lab import.
 *
 * Prefer secureIdent() or securePath() for single operands.
 */
function secureCmd($cmd)
{
    $re = '/[#;|`\r\n]|\$\(|\$\{|\.{2,}/m';
    if (preg_match($re, $cmd, $matches)) {
        throw new Exception(
            "The command contains dangerous characters [" .
                join(" ", $matches) .
                "]"
        );
    }
    return $cmd;
}

/**
 * Allowlist validator for a SINGLE operand that is an identifier: bridge / OVS
 * / TAP / interface names, node and interface ids, console ports, tenant ids.
 *
 * Every such value in this codebase is server-generated (e.g. "vunl15_16",
 * "pnet0", "ser16_1") or numeric; verified against the full /sys/class/net
 * namespace, whose charset is [a-z0-9_-]. Anything outside [A-Za-z0-9._-] is
 * rejected outright, so no shell metacharacter can survive.
 */
function secureIdent($value, $label = "value")
{
    $s = (string) $value;
    if ($s === "" || strlen($s) > 64 || !preg_match('/^[A-Za-z0-9._-]+$/', $s)) {
        throw new Exception("Invalid " . $label . " [" . $s . "]");
    }
    if (strpos($s, "..") !== false) {
        throw new Exception("Invalid " . $label . " [" . $s . "]");
    }
    return $s;
}

/**
 * Allowlist validator for a lab/folder path relative to BASE_LAB.
 *
 * Verified against every real lab and folder name on a production appliance:
 * the observed charset is exactly [A-Za-z0-9 ._-]. The set below additionally
 * permits ()[]+, so realistic future names are not broken, while excluding
 * every shell metacharacter and any traversal sequence.
 */
function securePath($path)
{
    $s = (string) $path;
    if (strlen($s) > 4096 || !preg_match('/^[A-Za-z0-9 ._()\[\]+,\/-]*$/', $s)) {
        throw new Exception("Invalid path [" . $s . "]");
    }
    if (strpos($s, "..") !== false) {
        throw new Exception("Invalid path [" . $s . "]");
    }
    return $s;
}

/** ========EVE_STORE ==================*/

/* ==== External authentication (RADIUS / LDAP) ================================
 * The engine never talks to a directory itself: credentials are verified by
 * the root broker (verbs extauth_settings_read / extauth_verify), where the
 * RADIUS shared secret and the LDAP service bind password live root-only
 * (data/extauth/config.json, 0600). These helpers are the thin www-data side.
 *
 * KNOWN LIMITATION (documented): group membership is re-evaluated at LOGIN
 * only. Removing a user from a directory group (or disabling them upstream)
 * does not revoke an already-issued session — the role change lands on their
 * next login and the old token stays valid until it expires. Deprovision an
 * external user immediately by blocking the local account (user_status=0).
 */

/** Redacted external-auth settings via the broker, cached per request.
 *  Returns the decoded config array, or null when the broker is unreachable
 *  or the feature has never been configured. */
function extauthSettings()
{
    static $cfg = null, $loaded = false;
    if ($loaded) {
        return $cfg;
    }
    $loaded = true;
    $resp = broker_call('extauth_settings_read', [], 10);
    if (!empty($resp['ok']) && !empty($resp['out'])) {
        $dec = json_decode($resp['out'][count($resp['out']) - 1], true);
        if (is_array($dec)) {
            $cfg = $dec;
        }
    }
    return $cfg;
}

/** Tri-state broker verification. Always returns an array with 'ok' and,
 *  when ok is false, a 'reason' of "denied" or "unreachable" (a dead broker
 *  or malformed reply counts as unreachable — never as authenticated). */
function extauthVerify($username, $password, $proto = null)
{
    $args = ['username' => (string) $username, 'password' => (string) $password];
    if ($proto === 'radius' || $proto === 'ldap') {
        // the user's own flag = primary protocol when mode is "both"
        $args['proto'] = $proto;
    }
    $resp = broker_call('extauth_verify', $args, 30);
    if (empty($resp['ok']) || empty($resp['out'])) {
        return ['ok' => false, 'reason' => 'unreachable'];
    }
    $r = json_decode($resp['out'][count($resp['out']) - 1], true);
    if (!is_array($r) || !array_key_exists('ok', $r)) {
        return ['ok' => false, 'reason' => 'unreachable'];
    }
    return $r;
}

/**
 * Apply the configured group->role mapping after a successful external login.
 * First group_map entry (entries are stored sorted by prio) whose group string
 * case-insensitively matches a returned group — as the full value (DN or plain
 * name) or as the first CN= RDN token of a DN — sets users.role.
 *
 * HARD DENYLIST: a mapping can never resolve to the built-in admin role
 * (name "admin" / role id 0). The broker refuses to STORE such entries at
 * extauth_settings_write time; this function additionally skips them (and any
 * mapping whose role no longer exists in user_roles) as defence in depth, so
 * a directory group can never mint an appliance admin. No match -> the
 * default_role (same restrictions) if configured, else the role is kept.
 */
function extauthApplyMapping($db, $user, $groups)
{
    $cfg = extauthSettings();
    if (!is_array($cfg)) {
        return;
    }
    $map = isset($cfg['group_map']) && is_array($cfg['group_map']) ? $cfg['group_map'] : [];
    // candidate strings from the directory: full value + first CN= token of DNs
    $cand = [];
    foreach ((array) $groups as $g) {
        $g = trim((string) $g);
        if ($g === '') {
            continue;
        }
        $cand[strtolower($g)] = true;
        if (preg_match('/^cn=([^,]+)/i', $g, $m)) {
            $cand[strtolower(trim($m[1]))] = true;
        }
    }
    $resolveRole = function ($roleName) use ($db) {
        // built-in admin (or id 0) is NEVER a valid mapping target
        $rn = strtolower(trim((string) $roleName));
        if ($rn === '' || $rn === 'admin' || $rn === '0') {
            return null;
        }
        $st = $db->prepare('SELECT user_role_id FROM user_roles WHERE LOWER(user_role_name) = :n');
        $st->execute(['n' => $rn]);
        $id = $st->fetchColumn();
        if ($id === false || (string) $id === '0') {
            return null;
        }
        return (string) $id;
    };
    $newRole = null;
    foreach ($map as $ent) {
        if (!is_array($ent) || !isset($ent['group'], $ent['role'])) {
            continue;
        }
        if (isset($cand[strtolower(trim((string) $ent['group']))])) {
            $rid = $resolveRole($ent['role']);
            if ($rid !== null) {
                $newRole = $rid;
                break;
            }
            // matched entry targets a forbidden/missing role -> treat as no-match
        }
    }
    if ($newRole === null && !empty($cfg['default_role'])) {
        $newRole = $resolveRole($cfg['default_role']);
    }
    if ($newRole !== null && (string) $user['role'] !== $newRole) {
        $st = $db->prepare('UPDATE users SET role = :r WHERE username = :u');
        $st->execute(['r' => $newRole, 'u' => $user['username']]);
        error_log(date('M d H:i:s ') . 'INFO: extauth mapped user ' .
            $user['username'] . ' role ' . $user['role'] . ' -> ' . $newRole);
    }
}
