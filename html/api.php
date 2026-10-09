<?php

require_once "/opt/unetlab/html/includes/init.php";
require_once BASE_DIR . "/html/includes/Slim/Slim.php";
require_once BASE_DIR . "/html/includes/Slim-Extras/DateTimeFileWriter.php";
require_once BASE_DIR . "/html/includes/api_authentication.php";
require_once BASE_DIR . "/html/includes/api_configs.php";
require_once BASE_DIR . "/html/includes/api_folders.php";
require_once BASE_DIR . "/html/includes/api_labs.php";
require_once BASE_DIR . "/html/includes/api_networks.php";
require_once BASE_DIR . "/html/includes/api_nodes.php";
require_once BASE_DIR . "/html/includes/api_templatedefaults.php";
require_once BASE_DIR . "/html/includes/lab_validation_store.php";
$labValidationAdapter = BASE_DIR . "/html/includes/lab_validation_probe.php";
if (is_file($labValidationAdapter)) require_once $labValidationAdapter;
require_once BASE_DIR . "/html/includes/api_sdwan.php";
require_once BASE_DIR . "/html/includes/api_pictures.php";
require_once BASE_DIR . "/html/includes/api_status.php";
require_once BASE_DIR . "/html/includes/api_textobjects.php";
require_once BASE_DIR . "/html/includes/api_topology.php";
require_once BASE_DIR . "/html/includes/api_uusers.php";
require_once BASE_DIR . "/html/includes/activity_log.php";
require_once BASE_DIR . "/html/includes/password_reset.php";
require_once BASE_DIR . "/html/devices/interfc.php";

\Slim\Slim::registerAutoloader();

$apiLogFp = @fopen("/opt/unetlab/data/Logs/api.txt", "a");
$slimSettings = [
    "mode" => "production",
    "debug" => true, // Change to False for production
    "log.level" => \Slim\Log::WARN, // Change to WARN for production, DEBUG to develop
    "log.enabled" => true,
];
if (is_resource($apiLogFp)) {
    $slimSettings["log.writer"] = new \Slim\LogWriter($apiLogFp);
}
$app = new \Slim\Slim($slimSettings);

$app->hook("slim.after.router", function () use ($app) {
    // Log all requests and responses
    $request = $app->request;
    $response = $app->response;

    $app->log->debug("Request path: " . $request->getPathInfo());
    $app->log->debug("Response status: " . $response->getStatus());
});

$app->response->headers->set("Content-Type", "application/json");
$app->response->headers->set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, max-age=0"
);
$app->response->headers->set("Cache-Control", "post-check=0, pre-check=0");
$app->response->headers->set("Pragma", "no-cache");

$app->notFound(function () use ($app) {
    $output["code"] = 404;
    $output["status"] = "fail";
    $output["message"] = $GLOBALS["messages"]["60038"];
    $app->halt($output["code"], json_encode($output));
});

$db = checkDatabase();

// Define output for unprivileged requests
$forbidden = [
    "code" => 401,
    "status" => "forbidden",
    "message" => $GLOBALS["messages"]["90032"],
];

function apiFeatureReply($app, $code, $data = null, $message = "")
{
    $body = [
        "code" => (int) $code,
        "status" => $code >= 200 && $code < 300 ? "success" : "fail",
        "message" => (string) $message,
    ];
    if ($data !== null) $body["data"] = $data;
    $app->response->setStatus((int) $code);
    $app->response->setBody(json_encode($body));
}

function apiFeatureBody($app)
{
    $body = json_decode($app->request()->getBody(), true);
    return is_array($body) ? $body : [];
}

function apiFeatureAdmin($app)
{
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization($app->getCookie("token"));
    if ($user === false) {
        apiFeatureReply($app, isset($output["code"]) ? (int) $output["code"] : 401, null, "Not authenticated");
        return false;
    }
    $role = isset($user["role"]) ? (string) $user["role"] : "";
    if ($role !== "0" && strtolower($role) !== "admin") {
        apiFeatureReply($app, 403, null, "Administrator access is required");
        return false;
    }
    return [$user, $tenant];
}

function apiFeatureBoolean($value)
{
    return $value === true || $value === 1 || $value === '1';
}

// Public token check/consume routes live on the existing Slim router. There is
// no global auth middleware, so these two closures simply omit authorization.
$app->post("/api/password-reset/check", function () use ($app, $db) {
    try {
        $body = apiFeatureBody($app);
        list($ok, $value) = password_reset_lookup($db, isset($body["token"]) ? $body["token"] : "");
        if (!$ok) { apiFeatureReply($app, 404, null, $value); return; }
        apiFeatureReply($app, 200, ["username" => $value]);
    } catch (Throwable $e) {
        error_log("password reset check failed: " . $e->getMessage());
        apiFeatureReply($app, 500, null, "Could not validate this reset link");
    }
});

$app->post("/api/password-reset/consume", function () use ($app, $db) {
    try {
        $body = apiFeatureBody($app);
        list($ok, $message) = password_reset_consume(
            $db,
            isset($body["token"]) ? $body["token"] : "",
            isset($body["password"]) ? $body["password"] : ""
        );
        if (!$ok) { apiFeatureReply($app, 400, null, $message); return; }
        apiFeatureReply($app, 200, ["ok" => true], "Password changed. Existing sessions were signed out.");
    } catch (Throwable $e) {
        error_log("password reset consume failed: " . $e->getMessage());
        apiFeatureReply($app, 500, null, "Could not change the password");
    }
});

$app->post("/api/password-reset/request", function () use ($app, $db) {
    try {
        $body = apiFeatureBody($app);
        $identifier = trim(isset($body["identifier"]) ? (string) $body["identifier"] : "");
        if ($identifier === "") {
            apiFeatureReply($app, 400, null, "Please enter your username or email address.");
            return;
        }

        $cfg = smtp_settings();
        if (!$cfg['enabled']) {
            apiFeatureReply($app, 400, null, "Email service is not configured on this appliance. Please contact your system administrator to reset your password.");
            return;
        }

        $select = $db->prepare('SELECT pod, username, email FROM users WHERE LOWER(username) = LOWER(:id1) OR LOWER(email) = LOWER(:id2) LIMIT 1');
        $select->execute(['id1' => $identifier, 'id2' => $identifier]);
        $user = $select->fetch(PDO::FETCH_ASSOC);

        if (!$user) {
            apiFeatureReply($app, 200, ["sent" => true], "If an account matches that username or email, a password reset link has been sent.");
            return;
        }

        $email = trim((string) ($user['email'] ?? ''));
        if ($email === '') {
            apiFeatureReply($app, 400, null, "No email address is associated with this account. Please contact your administrator.");
            return;
        }

        $deliveryError = password_reset_delivery_error($email);
        if ($deliveryError !== null) {
            apiFeatureReply($app, 400, null, "Cannot send reset email: " . $deliveryError . ". Please contact your administrator.");
            return;
        }

        list($ok, $err) = password_reset_issue_and_send($db, (int) $user['pod'], $user['username'], $email, 'request');
        if (!$ok) {
            apiFeatureReply($app, 500, null, "Could not send reset email: " . $err . ". Please contact your administrator.");
            return;
        }

        apiFeatureReply($app, 200, ["sent" => true], "A password reset link has been sent to your email address. Please check your inbox.");
    } catch (Throwable $e) {
        error_log("password reset request failed: " . $e->getMessage());
        apiFeatureReply($app, 500, null, "Could not process password reset request");
    }
});

$app->get("/api/admin/mail", function () use ($app) {
    if (apiFeatureAdmin($app) === false) return;
    $cfg = smtp_settings();
    list($welcomeSubject, $welcomeBody) = password_reset_template('welcome');
    list($requestSubject, $requestBody) = password_reset_template('request');
    list($testSubject, $testBody) = password_reset_template('test');
    apiFeatureReply($app, 200, [
        "enabled" => $cfg["enabled"], "host" => $cfg["host"], "port" => $cfg["port"],
        "encryption" => $cfg["encryption"], "auth" => $cfg["auth"], "username" => $cfg["username"],
        "password_set" => $cfg["password"] !== "", "from_email" => $cfg["from_email"],
        "from_name" => $cfg["from_name"], "public_url" => $cfg["public_url"],
        "templates" => [
            "welcome" => ["subject" => $welcomeSubject, "body" => $welcomeBody],
            "request" => ["subject" => $requestSubject, "body" => $requestBody],
            "test" => ["subject" => $testSubject, "body" => $testBody],
        ],
    ]);
});

$app->put("/api/admin/mail", function () use ($app) {
    if (apiFeatureAdmin($app) === false) return;
    try {
        $body = apiFeatureBody($app);
        $enabled = apiFeatureBoolean(isset($body["enabled"]) ? $body["enabled"] : false);
        $auth = apiFeatureBoolean(isset($body["auth"]) ? $body["auth"] : false);
        $host = smtp_single_line(isset($body["host"]) ? $body["host"] : "", "SMTP host", 253);
        $port = filter_var(isset($body["port"]) ? $body["port"] : null, FILTER_VALIDATE_INT, ["options" => ["min_range" => 1, "max_range" => 65535]]);
        $encryption = strtolower((string) (isset($body["encryption"]) ? $body["encryption"] : "tls"));
        $username = smtp_single_line(isset($body["username"]) ? $body["username"] : "", "SMTP username", 320);
        $fromEmail = smtp_single_line(isset($body["from_email"]) ? $body["from_email"] : "", "from address", 254);
        $fromName = smtp_single_line(isset($body["from_name"]) ? $body["from_name"] : "", "from name", 160);
        $publicUrl = password_reset_validate_base_url(isset($body["public_url"]) ? $body["public_url"] : "");
        if ($host !== "" && !smtp_valid_host($host)) throw new InvalidArgumentException("SMTP host is not valid");
        if ($port === false) throw new InvalidArgumentException("SMTP port must be between 1 and 65535");
        if (!in_array($encryption, ["none", "ssl", "tls"], true)) throw new InvalidArgumentException("Unknown SMTP encryption mode");
        if ($fromEmail !== "" && !smtp_valid_mailbox($fromEmail)) throw new InvalidArgumentException("From address is not valid");
        if (trim((string) (isset($body["public_url"]) ? $body["public_url"] : "")) !== "" && $publicUrl === false) {
            throw new InvalidArgumentException("Public appliance URL must be an HTTPS origin without a path, query, or credentials");
        }
        if ($enabled && ($host === "" || $fromEmail === "")) throw new InvalidArgumentException("Enabled SMTP requires a host and from address");
        $newPassword = array_key_exists("password", $body) ? (string) $body["password"] : null;
        if ($newPassword !== null && strlen($newPassword) > 4096) throw new InvalidArgumentException("SMTP password is too long");
        $storedPassword = (string) Ctrl_get(CTRL_SMTP_PASSWORD, "");
        if ($auth && ($username === "" || (($newPassword === null || $newPassword === "") && $storedPassword === ""))) {
            throw new InvalidArgumentException("SMTP authentication requires a username and password");
        }
        $values = [
            CTRL_SMTP_ENABLED => $enabled ? "1" : "0", CTRL_SMTP_HOST => $host,
            CTRL_SMTP_PORT => (string) $port, CTRL_SMTP_ENCRYPTION => $encryption,
            CTRL_SMTP_AUTH => $auth ? "1" : "0", CTRL_SMTP_USERNAME => $username,
            CTRL_SMTP_FROM_EMAIL => $fromEmail, CTRL_SMTP_FROM_NAME => $fromName,
            CTRL_SMTP_PUBLIC_URL => $publicUrl === false ? "" : $publicUrl,
        ];
        if ($newPassword !== null && $newPassword !== "") $values[CTRL_SMTP_PASSWORD] = $newPassword;
        foreach ($values as $key => $value) {
            if (!Ctrl_set($key, $value)) { apiFeatureReply($app, 500, null, "Could not save all SMTP settings"); return; }
        }
        apiFeatureReply($app, 200, ["ok" => true]);
    } catch (InvalidArgumentException $e) {
        apiFeatureReply($app, 400, null, $e->getMessage());
    }
});

$app->put("/api/admin/mail/template/(:kind)", function ($kind) use ($app) {
    if (apiFeatureAdmin($app) === false) return;
    $keys = [
        "welcome" => [CTRL_SMTP_WELCOME_SUBJECT, CTRL_SMTP_WELCOME_BODY],
        "request" => [CTRL_SMTP_REQUEST_SUBJECT, CTRL_SMTP_REQUEST_BODY],
        "test" => [CTRL_SMTP_TEST_SUBJECT, CTRL_SMTP_TEST_BODY],
    ];
    if (!isset($keys[$kind])) { apiFeatureReply($app, 404, null, "Unknown mail template"); return; }
    try {
        $body = apiFeatureBody($app);
        $subject = smtp_single_line(isset($body["subject"]) ? $body["subject"] : "", "subject", 998);
        $html = (string) (isset($body["body"]) ? $body["body"] : "");
        if ($subject === "" || trim($html) === "") throw new InvalidArgumentException("Template subject and body are required");
        if (strlen($html) > 100000) throw new InvalidArgumentException("Template body is too long");
        if (!Ctrl_set($keys[$kind][0], $subject) || !Ctrl_set($keys[$kind][1], $html)) {
            apiFeatureReply($app, 500, null, "Could not save the mail template"); return;
        }
        apiFeatureReply($app, 200, ["ok" => true]);
    } catch (InvalidArgumentException $e) {
        apiFeatureReply($app, 400, null, $e->getMessage());
    }
});

$app->post("/api/admin/mail/test", function () use ($app) {
    if (apiFeatureAdmin($app) === false) return;
    try {
        $body = apiFeatureBody($app);
        $to = isset($body["to"]) ? $body["to"] : "";
        list($savedSubject, $savedBody) = password_reset_template('test');
        $subject = array_key_exists("subject", $body) ? $body["subject"] : $savedSubject;
        $html = array_key_exists("body", $body) ? (string) $body["body"] : $savedBody;
        if (strlen($html) > 100000) throw new InvalidArgumentException("Test email body is too long");
        list($ok, $error) = smtp_send_mail($to, $subject, $html, password_reset_html_to_text($html));
        if (!$ok) { apiFeatureReply($app, 502, null, $error); return; }
        apiFeatureReply($app, 200, ["ok" => true]);
    } catch (InvalidArgumentException $e) {
        apiFeatureReply($app, 400, null, $e->getMessage());
    }
});

$app->get("/api/admin/activity", function () use ($app, $db) {
    if (apiFeatureAdmin($app) === false) return;
    try {
        $variables = $app->request()->get();
        $categories = isset($variables["categories"]) ? explode(",", (string) $variables["categories"]) : [];
        $result = activity_log_fetch(
            $db,
            $categories,
            isset($variables["limit"]) ? $variables["limit"] : 100,
            isset($variables["offset"]) ? $variables["offset"] : 0
        );
        apiFeatureReply($app, 200, $result);
    } catch (Throwable $e) {
        error_log("activity log read failed: " . $e->getMessage());
        apiFeatureReply($app, 500, null, "Could not read the activity log");
    }
});

$app->post("/api/admin/users/(:pod)/password-reset", function ($pod) use ($app, $db) {
    if (apiFeatureAdmin($app) === false) return;
    try {
        $statement = $db->prepare('SELECT pod,username,email,ext_auth FROM users WHERE pod=:pod LIMIT 1');
        $statement->execute(["pod" => (int) $pod]);
        $target = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$target) { apiFeatureReply($app, 404, null, "User not found"); return; }
        if ($target["ext_auth"] === "radius" || $target["ext_auth"] === "ldap") {
            apiFeatureReply($app, 409, null, "Directory-authenticated users must reset their password in the directory"); return;
        }
        list($sent, $error) = password_reset_issue_and_send(
            $db, (int) $target["pod"], $target["username"], $target["email"], 'request'
        );
        if (!$sent) { apiFeatureReply($app, 502, null, $error); return; }
        apiFeatureReply($app, 200, ["ok" => true, "email" => $target["email"]]);
    } catch (Throwable $e) {
        error_log("admin password reset issuance failed: " . $e->getMessage());
        apiFeatureReply($app, 500, null, "Could not issue the password-reset link");
    }
});

$app->get("/api/health", function () use ($app) {
    // B8 platform health — same checks as the pnetlab_doctor CLI
    // (includes/doctor.php). Auth-gated like every other engine endpoint;
    // overall: ok | degraded (warnings) | fail.
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }

    require_once "/opt/unetlab/html/includes/doctor.php";
    $result = doctor_run();
    $output = [
        "code" => 200,
        "status" => "success",
        "message" => "",
        "data" => $result,
    ];
    $app->response->setStatus(200);
    $app->response->setBody(json_encode($output));
});

$app->get("/api/auth/logout", function () use ($app, $db) {
    // Logout (DELETE request does not work with cookies)
    $cookie = $app->getCookie("token");
    $logoutUser = activity_log_user_for_cookie($db, $cookie);
    $app->deleteCookie("token");
    $output = apiLogout($cookie);
    if ($logoutUser && isset($output["code"]) && (int) $output["code"] === 200) {
        activity_log_event($db, $logoutUser, "session", "logout", [
            "session_id" => activity_log_session_id($cookie),
        ]);
    }
    $app->response->setStatus($output["code"]);
    $app->response->setBody(json_encode($output));
});

$app->get("/api/auth", function () use ($app) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );

    $variables = $app->request()->get();
    $lang = get($variables["lang"], "");
    $langData = loadLanguage($lang);

    if ($user === false) {
        // Set 401 not 412 for this page only -> used to refresh after a logout
        $output["code"] = 401;
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }

    if (!isset($user["folder"]) || $user["folder"] == "") {
        $user["folder"] = "/";
    }

    if (checkFolder(BASE_LAB . $user["folder"]) !== 0) {
        // User has an invalid last viewed folder
        $user["folder"] = "/";
    }

    try {
        checkWorkSpace($user["folder"]);
    } catch (Exception $e) {
        $user["folder"] = getWorkspace();
    }

    $user["lang"] = $langData;

    $output["code"] = 200;
    $output["status"] = "success";
    $output["message"] = $GLOBALS["messages"]["90002"];
    $output["data"] = $user;

    $app->response->setStatus($output["code"]);
    $app->response->setBody(json_encode($output));
});

/***************************************************************************
 * List Objects
 **************************************************************************/
// Node templates
$app->get("/api/list/templates/(:template)", function ($template = "") use (
    $app
) {
    try {
        $indent = new \indentify();
        list($user, $tenant, $output) = $indent->authorization(
            $app->getCookie("token")
        );
        if ($user === false) {
            $app->response->setStatus($output["code"]);
            $app->response->setBody(json_encode($output));
            return;
        }

        if (!isset($template) || $template == "") {
            $output["data"] = getTemplates();
            $output["code"] = 200;
            $output["status"] = "success";
            $output["message"] = $GLOBALS["messages"]["60003"];
        } else {
            $output = apiGetLabNodeTemplate($template);
        }

        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

// Live slug -> icon map for every node template, parsed from the template YAMLs,
// so the Add Node picker shows each template's own icon (no stale static map).
$app->get("/api/list/template-icons", function () use ($app) {
    try {
        $indent = new \indentify();
        list($user, $tenant, $output) = $indent->authorization(
            $app->getCookie("token")
        );
        if ($user === false) {
            $app->response->setStatus($output["code"]);
            $app->response->setBody(json_encode($output));
            return;
        }
        $output["data"] = getTemplateIcons();
        $output["code"] = 200;
        $output["status"] = "success";
        $output["message"] = "Template icons";
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
    }
    $app->response->setStatus($output["code"]);
    $app->response->setBody(json_encode($output));
});

$app->get("/api/list/template-types", function () use ($app) {
    try {
        $indent = new \indentify();
        list($user, $tenant, $output) = $indent->authorization(
            $app->getCookie("token")
        );
        if ($user === false) {
            $app->response->setStatus($output["code"]);
            $app->response->setBody(json_encode($output));
            return;
        }
        $output["data"] = getTemplateTypes();
        $output["code"] = 200;
        $output["status"] = "success";
        $output["message"] = "Template types";
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
    }
    $app->response->setStatus($output["code"]);
    $app->response->setBody(json_encode($output));
});

// Per-template default overrides (admin): save / revert / read. Stored in an
// upgrade-safe side store and merged into /api/list/templates/<t> for all future
// Add-Node operations. See includes/api_templatedefaults.php.
$app->post("/api/templatedefaults/(:template)", function ($template = "") use (
    $app
) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
    if (!isAdmin()) {
        $output = array("code" => 403, "status" => "fail",
            "message" => "Admin role required");
        $app->response->setStatus(403);
        $app->response->setBody(json_encode($output));
        return;
    }
    $values = json_decode($app->request()->getBody(), true);
    if (!template_defaults_valid_name($template) || !is_array($values)) {
        $output = array("code" => 400, "status" => "fail",
            "message" => "Invalid template or payload");
        $app->response->setStatus(400);
        $app->response->setBody(json_encode($output));
        return;
    }
    $ok = template_defaults_save($template, $values);
    $output = $ok
        ? array("code" => 200, "status" => "success",
            "message" => "Template defaults saved")
        : array("code" => 500, "status" => "fail",
            "message" => "Could not write template defaults");
    $app->response->setStatus($output["code"]);
    $app->response->setBody(json_encode($output));
});
$app->delete("/api/templatedefaults/(:template)", function ($template = "") use (
    $app
) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
    if (!isAdmin()) {
        $output = array("code" => 403, "status" => "fail",
            "message" => "Admin role required");
        $app->response->setStatus(403);
        $app->response->setBody(json_encode($output));
        return;
    }
    $ok = template_defaults_delete($template);
    $output = $ok
        ? array("code" => 200, "status" => "success",
            "message" => "Reverted to factory defaults")
        : array("code" => 500, "status" => "fail",
            "message" => "Could not revert template defaults");
    $app->response->setStatus($output["code"]);
    $app->response->setBody(json_encode($output));
});
$app->get("/api/templatedefaults/(:template)", function ($template = "") use (
    $app
) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
    $output = array("code" => 200, "status" => "success", "message" => "",
        "data" => template_defaults_load($template));
    $app->response->setStatus(200);
    $app->response->setBody(json_encode($output));
});

// Network types
$app->get("/api/list/networks", function () use ($app) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }

    $output["code"] = 200;
    $output["status"] = "success";
    $output["message"] = $GLOBALS["messages"]["60002"];
    if (isAdmin()) {
        $output["data"] = listNetworkTypes();
    } else {
        $output["data"] = listNetwork_non_admin();
    }

    $app->response->setStatus($output["code"]);
    $app->response->setBody(json_encode($output));
});
/**
 * Live-apply a wireless cell's WLAN change to running APs. For each AP cabled to
 * the cell that is currently running, restart it so device_wifiap::prepare()
 * rebuilds the hostapd multi-BSS config from the (just-saved) cell WLAN list. The
 * broker wifi_ap_refresh clears the AP's auto-generated cidata + first-boot markers
 * between stop and start so the rebuild actually happens (a plain restart would
 * reboot the stale config.iso). Cell-driven APs only: an AP carrying a user-saved
 * startup-config is left alone. Entirely best-effort and self-isolated — never
 * throws into the Save response (the persist already succeeded).
 */
function wifiCellRestartCabledAps($lab, $netId, $tenant)
{
    try {
        $session = (int) $lab->getSession();
        foreach ($lab->getNodes() as $nid => $node) {
            try {
                if ($node->getTemplate() !== 'wifiap') continue;
                $st = $node->getStatus();
                if ($st != 1 && $st != 2) continue;          // only running/started
                $onCell = false;
                foreach ($node->getEthernets() as $iface) {
                    if (method_exists($iface, 'getNetworkId')
                        && (int) $iface->getNetworkId() === (int) $netId) {
                        $onCell = true;
                        break;
                    }
                }
                if (!$onCell) continue;
                // Leave manually-configured APs (user-saved startup-config) untouched.
                if (is_file($node->getRunningPath() . '/startup-config')) continue;

                apiStopLabNode($lab, $nid, $tenant);
                if (function_exists('broker_call')) {
                    @broker_call('wifi_ap_refresh', array(
                        'lab_session'  => $session,
                        'node_session' => (int) $nid,
                    ));
                }
                apiStartLabNode($lab, $nid, $tenant);
            } catch (Exception $e) {
                // one AP failing must not stop the others or the Save
                error_log(date('M d H:i:s ') . 'WARNING: wifi cell live-apply skipped node '
                    . $nid . ': ' . $e->getMessage());
            }
        }
    } catch (Exception $e) {
        error_log(date('M d H:i:s ') . 'WARNING: wifi cell live-apply failed: ' . $e->getMessage());
    }
}
$app->put("/api/labs/session/network/manage", function () use ($app) {
    try {
        $indent = new \indentify();
        list($user, $tenant, $output) = $indent->authorization(
            $app->getCookie("token")
        );
        if ($user === false) {
            $app->response->setStatus($output["code"]);
            $app->response->setBody(json_encode($output));
            return;
        }
        updateOnlineTime($tenant);
        $variables = json_decode($app->request()->getBody(), true);
        $labFile = "";
        $session = get($user["lab"], "");
        $labsession = getLabFromSession($session);
        if (!$labsession) {
            throw new Exception("NO_LAB_SESSION");
        }
        $lab = new Lab(
            BASE_LAB . $labsession["lab_session_path"],
            $tenant,
            $session
        );
        checkLabPermission($lab, USER_PER_EDIT_LAB);
        checkLockLab($lab);
        $p = $variables;
        $network_id = get($p["id"], "");
        $smart = get($p["smart"], "");
        $vlan8021ad = get($p["vlan8021ad"], "");
        $networks = $lab->getNetworks();
        if ((!is_int($network_id) && !(is_string($network_id) && ctype_digit($network_id))) ||
            (int) $network_id < 1 || !array_key_exists((int) $network_id, $networks)) {
            throw new Exception("Undefine network");
        }
        $network_id = (int) $network_id;
        $variables["id"] = $network_id;
        $network = $networks[$network_id];
        // dot1q switches are implicitly smart; their ports carry mode/native/vlans
        // and never use 802.1ad here (applyVlan branches on the dot1q type).
        $isDot1q = isset($network) && method_exists($network, 'getNType')
            && $network->getNType() == "dot1q";
        if ($isDot1q) {
            $smart = "1";
        }
        // soft-router: no per-port VLANs — push the whole gateway config
        // (downlink/uplink/NAT/DHCP/static routes) to the broker, which
        // validates every field before it can reach an `ip`/`iptables` argv.
        $isRouter = isset($network) && method_exists($network, 'getNType')
            && $network->getNType() == "router";
        if ($isRouter) {
            $rtr = get($p["rtr"], array());
            $rargs = array(
                "session" => (int) $lab->getSession(),
                "net_id"  => (int) $network_id,
                "gw_cidr" => get($rtr["gw_cidr"], ""),
                "nat"     => get($rtr["nat"], 0),
                "uplink"  => get($rtr["uplink"], "none"),
                "dhcp"    => get($rtr["dhcp"], 0),
                "routes"  => get($rtr["routes"], array()),
            );
            if ($rargs["uplink"] == "net") {
                $uplinkNetworkId = get($rtr["uplink_net_id"], "");
                if ((!is_int($uplinkNetworkId) &&
                    !(is_string($uplinkNetworkId) && ctype_digit($uplinkNetworkId))) ||
                    (int) $uplinkNetworkId < 1 ||
                    !array_key_exists((int) $uplinkNetworkId, $networks)) {
                    throw new Exception("Undefine uplink network");
                }
                $rargs["uplink_net_id"] = (int) $uplinkNetworkId;
                $rargs["uplink_cidr"]   = get($rtr["uplink_cidr"], "");
                $rargs["uplink_gw"]     = get($rtr["uplink_gw"], "");
            }
            if (get($rtr["dhcp"], 0)) {
                $rargs["dhcp_start"] = get($rtr["dhcp_start"], "");
                $rargs["dhcp_end"]   = get($rtr["dhcp_end"], "");
                $rargs["dhcp_dns"]   = get($rtr["dhcp_dns"], "");
            }
            $resp = broker_call("router_apply", $rargs);
            if (!$resp["ok"] || $resp["rc"] != 0) {
                $output = array(
                    "code" => 400, "status" => "fail",
                    "message" => "Router config rejected: " . $resp["err"],
                );
            } else {
                $output = array(
                    "code" => 200, "status" => "success",
                    "message" => "Router configured",
                );
            }
            $app->response->setStatus($output["code"]);
            $app->response->setBody(json_encode($output));
            return;
        }
        // wireless cell: persist the WLAN list (one or more SSIDs, each on its
        // own VLAN, with its own security). The AP cabled to the cell bakes this
        // into a hostapd multi-BSS config at start. Broker validates every field.
        $isWifiCell = isset($network) && method_exists($network, 'getNType')
            && $network->getNType() == "wireless";
        if ($isWifiCell) {
            $wifi = get($p["wifi"], array());
            $wargs = array(
                "session"   => (int) $lab->getSession(),
                "net_id"    => (int) $network_id,
                "mgmt_vlan" => get($wifi["mgmt_vlan"], 1),
                "wlans"     => get($wifi["wlans"], array()),
            );
            $resp = broker_call("wifi_cell_apply", $wargs);
            if (!$resp["ok"] || $resp["rc"] != 0) {
                $output = array(
                    "code" => 400, "status" => "fail",
                    "message" => "Wireless cell config rejected: " . $resp["err"],
                );
            } else {
                // Live-apply the new WLAN list to running APs cabled to this cell:
                // restart each so it regenerates its hostapd multi-BSS config from
                // the updated cell config on boot. Best-effort — the Save already
                // succeeded; a restart hiccup just means the change lands on the
                // AP's next manual start.
                wifiCellRestartCabledAps($lab, (int) $network_id, $tenant);
                $output = array(
                    "code" => 200, "status" => "success",
                    "message" => "Wireless cell configured",
                );
            }
            $app->response->setStatus($output["code"]);
            $app->response->setBody(json_encode($output));
            return;
        }
        $__ports = (isset($variables["port"]) && is_array($variables["port"])) ? $variables["port"] : array();
        $labNodes = $lab->getNodes();
        foreach ($__ports as $__port) {
            if (!is_array($__port)) {
                throw new Exception("Undefine interface");
            }
            $portNodeId = get($__port["NodeId"], null);
            $portInterfaceId = get($__port["IfId"], null);
            $portNodeName = get($__port["NodeName"], null);
            if ((!is_int($portNodeId) && !(is_string($portNodeId) && ctype_digit($portNodeId))) ||
                (int) $portNodeId < 1 || !is_string($portNodeName) ||
                !isset($labNodes[(int) $portNodeId]) ||
                $labNodes[(int) $portNodeId]->getName() != $portNodeName) {
                throw new Exception("Undefine node");
            }
            $portInterfaces = $labNodes[(int) $portNodeId]->getInterfaces();
            if ((!is_int($portInterfaceId) &&
                !(is_string($portInterfaceId) && ctype_digit($portInterfaceId))) ||
                !isset($portInterfaces[(int) $portInterfaceId]) ||
                $portInterfaces[(int) $portInterfaceId]->getNetworkId() != $network_id) {
                throw new Exception("Undefine interface");
            }
        }
        for ($c = 0; $c < count($__ports); $c++) {
            $vlan = $variables["port"][$c];
            $IfId = $variables["port"][$c]["IfId"];
            $NodeName = $variables["port"][$c]["NodeName"];
            $NodeName = $variables["port"][$c]["NodeName"];
            $NodeId = $variables["port"][$c]["NodeId"];
            if (isset($network)) {
                foreach ($lab->getNodes() as $node_id => $node) {
                    foreach (
                        $node->getInterfaces()
                        as $interface_id => $interface
                    ) {
                        if (
                            $interface->getNetworkId() == $network_id &&
                            $interface_id == $IfId &&
                            $smart == "1" &&
                            $node->getName() == $NodeName &&
                            $NodeId == $node_id
                        ) {
                            $interface->setvlan($vlan, $network_id);
                            if (!$isDot1q && $vlan8021ad == "1") {
                                $interface->setvlan8021ad($network_id);
                            } elseif (!$isDot1q) {
                                $interface->unsetvlan8021ad($network_id);
                            }
                        } elseif (
                            $interface->getNetworkId() == $network_id &&
                            $interface_id == $IfId &&
                            $smart == "0" &&
                            $node->getName() == $NodeName &&
                            $NodeId == $node_id
                        ) {
                            $interface->unsetvlan($vlan, $network_id);
                            $interface->unsetvlan8021ad($network_id);
                        }
                    }
                }
            }
        }

        $output = apiEditLabNetworkmanage($lab, $variables);
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

/***************************************************************************
 * Folders
 **************************************************************************/
// Get folder content
$app->get("/api/folders", function () use ($app) {
    try {
        $indent = new \indentify();
        list($user, $tenant, $output) = $indent->authorization(
            $app->getCookie("token")
        );
        if ($user === false) {
            $app->response->setStatus($output["code"]);
            $app->response->setBody(json_encode($output));
            return;
        }

        updateOnlineTime($tenant);

        $variables = $app->request()->get();
        $path = get($variables["path"], "");

        checkWorkSpace($path, true);

        $output = apiGetFolders($path);
        updateUserFolder($user["pod"], $path);

        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

$app->post("/api/folders/(:action)", function ($action) use ($app) {
    try {
        $indent = new \indentify();
        list($user, $tenant, $output) = $indent->authorization(
            $app->getCookie("token")
        );
        if ($user === false) {
            $app->response->setStatus($output["code"]);
            $app->response->setBody(json_encode($output));
            return;
        }

        updateOnlineTime($tenant);
        $variables = json_decode($app->request()->getBody(), true);
        $output = ["code" => 200, "status" => "success", "message" => ""];

        switch ($action) {
            case "add":
                $path = get($variables["path"], "");
                checkWorkSpace(
                    $path,
                    checkSharePermission(USER_PER_ADD_FOLDER)
                );
                checkPermission(USER_PER_ADD_FOLDER);
                $name = get($variables["name"], null);
                if ($name == null) {
                    throw new Exception("Name is not defined");
                }
                $output = apiAddFolder($name, $path);
                break;
            case "edit":
                $path = get($variables["path"], null);
                if ($path == null) {
                    throw new Exception("Path is not defined");
                }
                checkWorkSpace(
                    $path,
                    checkSharePermission(USER_PER_EDIT_FOLDER)
                );
                checkPermission(USER_PER_EDIT_FOLDER);
                $new_path = get($variables["new_path"], null);
                if ($new_path == null) {
                    throw new Exception("New Path is not defined");
                }
                $output = apiEditFolder($path, $new_path);
                break;
            case "delete":
                $path = get($variables["path"], null);
                if ($path == null) {
                    throw new Exception("Path is not defined");
                }
                checkWorkSpace(
                    $path,
                    checkSharePermission(USER_PER_DEL_FOLDER)
                );
                checkPermission(USER_PER_DEL_FOLDER);
                $output = apiDeleteFolder($path);
                break;
        }

        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

/***************************************************************************
 * Labs
 **************************************************************************/

// Add new lab
$app->post("/api/labs", function () use ($app) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }

    try {
        $event = json_decode($app->request()->getBody());
        $p = json_decode(json_encode($event), true);

        if (isset($p["source"])) {
            checkWorkSpace(
                dirname($p["source"]),
                checkSharePermission(USER_PER_CLONE_LAB)
            );
            checkPermission(USER_PER_CLONE_LAB);
            if (!isset($p["name"]) || !is_string($p["name"]) || !checkLabName($p["name"])) {
                $output = apiCloneLab($p, $tenant, $user["email"]);
                $createdPath = "";
            } else {
                $createdPath = rtrim(dirname($p["source"]), "/") . "/" . $p["name"] . ".unl";
                $output = lab_validation_clone_transaction(
                    BASE_LAB . $p["source"], BASE_LAB . $createdPath,
                    function () use ($p, $tenant, $user) { return apiCloneLab($p, $tenant, $user["email"]); }
                );
            }
        } else {
            checkWorkSpace($p["path"], checkSharePermission(USER_PER_ADD_LAB));
            checkPermission(USER_PER_ADD_LAB);
            $output = apiAddLab($p, $tenant, $user["email"]);
            $createdPath = rtrim($p["path"], "/") . "/" . $p["name"] . ".unl";
        }

        if (isset($output["status"]) && $output["status"] === "success") {
            activity_log_event(null, $user, "lab", "create", [
                "lab_path" => $createdPath,
                "lab_name" => isset($p["name"]) ? $p["name"] : basename($createdPath, ".unl"),
                "detail" => isset($p["source"]) ? ["cloned_from" => $p["source"]] : null,
            ]);
        }

        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

$app->delete("/api/labs", function () use ($app) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
    try {
        $variables = json_decode($app->request()->getBody(), true);
        $lab_path = get($variables["path"], "");
        checkWorkSpace($lab_path, checkSharePermission(USER_PER_DEL_LAB));
        checkPermission(USER_PER_DEL_LAB);
        $output = ["code" => 200];
        try {
            $lab = new Lab(BASE_LAB . $lab_path, $tenant);
        } catch (Exception $e) {
            if (is_file(BASE_LAB . $lab_path)) {
                $output = lab_validation_delete_transaction(BASE_LAB . $lab_path, function () use ($lab_path, $e) {
                    if (!unlink(BASE_LAB . $lab_path)) throw new LabValidationException("Could not delete lab", 500);
                    return array("code" => 200, "status" => "success", "message" => $e->getMessage());
                });
            } else {
                throw new Exception("Lab File is not founded");
            }
        }
        if (isset($lab)) {
            $deletedLabName = $lab->getName();
            $output = apiDeleteLab($lab);
        }
        if (isset($output["status"]) && $output["status"] === "success") {
            activity_log_event(null, $user, "lab", "delete", [
                "lab_path" => $lab_path,
                "lab_name" => isset($deletedLabName) ? $deletedLabName : basename($lab_path, ".unl"),
            ]);
        }
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

$app->post("/api/labs/(:action)", function ($action) use ($app) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }

    updateOnlineTime($tenant);

    try {
        $variables = json_decode($app->request()->getBody(), true);
        $lab_path = get($variables["path"], "");
        checkWorkSpace($lab_path, true);
        $lab = new Lab(BASE_LAB . $lab_path, $tenant);
        $output = ["code" => 200];

        switch ($action) {
            case "preview":
                $networks = [];
                $nodes = [];
                $textObjects = [];
                $labinfo = [];
                $lines = [];

                $output = apiGetLab($lab);
                if ($output["status"] == "success") {
                    $labinfo = $output["data"];
                }
                $output = apiGetLabNodes($lab, $user["html5"]);
                if ($output["status"] == "success") {
                    $nodes = $output["data"];
                    foreach ($nodes as $node_id => &$node) {
                        $node["interfaces"] = [];
                        $interfaceOutput = apiGetLabNodeInterfaces($lab, $node_id);
                        if (
                            isset($interfaceOutput["status"])
                            && $interfaceOutput["status"] == "success"
                            && isset($interfaceOutput["data"])
                            && is_array($interfaceOutput["data"])
                            && isset($interfaceOutput["data"]["ethernet"])
                            && (
                                is_array($interfaceOutput["data"]["ethernet"])
                                || is_object($interfaceOutput["data"]["ethernet"])
                            )
                        ) {
                            foreach ((array) $interfaceOutput["data"]["ethernet"] as $interface_id => $interface) {
                                if (!is_array($interface) && !is_object($interface)) {
                                    continue;
                                }
                                $interface = (array) $interface;
                                if (
                                    !array_key_exists("network_id", $interface)
                                    || !array_key_exists("type", $interface)
                                    || !array_key_exists("name", $interface)
                                ) {
                                    continue;
                                }
                                $node["interfaces"][$interface_id] = [
                                    "network_id" => $interface["network_id"],
                                    "type" => $interface["type"],
                                    "name" => $interface["name"],
                                ];
                            }
                        }
                    }
                    unset($node);
                }
                $output = apiGetLabTextObjects($lab, null);
                if ($output["status"] == "success") {
                    $textObjects = $output["data"];
                }
                $output = apiGetLabNetworks($lab);
                if ($output["status"] == "success") {
                    $networks = $output["data"];
                }

                $lines = $lab->getLineObjects();

                $output["data"] = [
                    "networks" => $networks,
                    "nodes" => $nodes,
                    "textObjects" => $textObjects,
                    "labinfo" => $labinfo,
                    "lines" => $lines,
                ];

                break;

            case "get":
                $output = apiGetLab($lab);
                break;

            case "edit":
                checkLabPermission($lab, USER_PER_EDIT_LAB);
                if (isset($variables["data"])) {
                    $output = apiEditLab($lab, $variables["data"]);
                }
                break;

            case "move":
                $moveSharedable = checkSharePermission(USER_PER_MOVE_LAB);
                checkWorkSpace($lab_path, $moveSharedable);
                checkPermission(USER_PER_MOVE_LAB);
                if (isset($variables["new_path"])) {
                    checkWorkSpace($variables["new_path"], $moveSharedable);
                    $output = apiMoveLab($lab, $variables["new_path"]);
                }
                break;
        }

        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

$app->post("/api/labs/session/factory/(:action)", function ($action) use (
    $app
) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }

    updateOnlineTime($tenant);

    $variables = json_decode($app->request()->getBody(), true);
    $output = ["code" => 200];

    try {
        switch ($action) {
            case "create":
                $path = get($variables["path"], "");
                checkWorkSpace($path, checkSharePermission(USER_PER_OPEN_LAB));
                checkLimit($tenant);
                $lab = new Lab(BASE_LAB . $path, $tenant);
                checkLabPermission($lab, USER_PER_OPEN_LAB);
                $result = addLabSession($lab->getId(), $tenant, $path);
                if (!$result["result"]) {
                    throw new Exception($result["message"]);
                }
                $output["message"] = get($result["data"], "success");
                break;
            case "join":
                $lab_session = get($variables["lab_session"], "");
                $labsession = getLabFromSession($lab_session);
                if (!$labsession) {
                    throw new Exception("NO_LAB_SESSION");
                }
                $lab = new Lab(
                    BASE_LAB . $labsession["lab_session_path"],
                    $tenant,
                    $lab_session
                );
                checkWorkSpace(
                    $labsession["lab_session_path"],
                    checkSharePermission(USER_PER_JOIN_LAB)
                );
                checkLabPermission($lab, USER_PER_JOIN_LAB);
                $result = joinLabSession($tenant, $lab_session);
                if (!$result["result"]) {
                    throw new Exception($result["message"]);
                }
                $output["message"] = get($result["data"], "success");
                activity_log_event(null, $user, "lab", "join", [
                    "lab_path" => $labsession["lab_session_path"],
                    "lab_name" => $lab->getName(),
                    "detail" => ["lab_session" => $lab_session],
                ]);
                break;

            case "leave":
                $lab_session = get($user["lab"], "");
                $labsession = getLabFromSession($lab_session);
                if (!$labsession) {
                    throw new Exception("NO_LAB_SESSION");
                }
                $lab = new Lab(
                    BASE_LAB . $labsession["lab_session_path"],
                    $tenant,
                    $lab_session
                );
                $result = leaveLabSession($tenant, $lab);
                if (!$result["result"]) {
                    throw new Exception($result["message"]);
                }
                $output["message"] = get($result["data"], "success");
                break;

            case "destroy":
                $lab_session = get($variables["lab_session"], "");
                $labsession = getLabFromSession($lab_session);
                if (!$labsession) {
                    throw new Exception("NO_LAB_SESSION");
                }
                checkDestroy($lab_session);
                try {
                    $lab = new Lab(
                        BASE_LAB . $labsession["lab_session_path"],
                        $tenant,
                        $lab_session
                    );
                    $result = destroyLabSession($lab);
                } catch (Exception $th) {
                    // was destroyBrokenLabSession() — a function that never
                    // existed (fw- prefix), so this catch path itself fataled
                    $result = fwdestroyBrokenLabSession($lab_session);
                }

                if (!$result["result"]) {
                    throw new Exception($result["message"]);
                }
                $output["message"] = get($result["data"], "success");
                activity_log_event(null, $user, "lab", "destroy", [
                    "lab_path" => $labsession["lab_session_path"],
                    "lab_name" => isset($lab) ? $lab->getName() : basename($labsession["lab_session_path"], ".unl"),
                    "detail" => ["lab_session" => $lab_session],
                ]);
                break;

            case "stopNodes":
                $lab_session = get($variables["lab_session"], "");
                $labsession = getLabFromSession($lab_session);
                if (!$labsession) {
                    throw new Exception("NO_LAB_SESSION");
                }
                checkStopNodes($lab_session);

                $lab = new Lab(
                    BASE_LAB . $labsession["lab_session_path"],
                    $tenant,
                    $lab_session
                );
                $result = stopLabSession($lab);

                if (!$result["result"]) {
                    throw new Exception($result["message"]);
                }
                $output["message"] = get($result["data"], "success");
                break;
        }

        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

$app->get("/api/labs/session/(:object)", function ($object) use ($app, $db) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );

    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
    updateOnlineTime($tenant);
    $variables = $app->request()->get();
    $session = get($user["lab"], "");

    try {
        $labsession = getLabFromSession($session);
        if (!$labsession) {
            throw new Exception("NO_LAB_SESSION");
        }
        lockSession($session);
        $lab = new Lab(
            BASE_LAB . $labsession["lab_session_path"],
            $tenant,
            $session
        );

        $output = ["code" => 200, "status" => "success", "message" => ""];

        switch ($object) {
            case "info":
                $output = apiGetLab($lab);
                break;
            case "topology":
                $networks = [];
                $nodes = [];
                $textObjects = [];
                $labinfo = [];
                $lines = [];

                $output = apiGetLab($lab);
                if ($output["status"] == "success") {
                    $labinfo = $output["data"];
                }
                $output = apiGetLabNodes($lab, $user["html5"]);
                if ($output["status"] == "success") {
                    $nodes = $output["data"];
                }
                $output = apiGetLabTextObjects($lab, null);
                if ($output["status"] == "success") {
                    $textObjects = $output["data"];
                }
                $output = apiGetLabNetworks($lab);
                if ($output["status"] == "success") {
                    $networks = $output["data"];
                }

                $lines = $lab->getLineObjects();

                $output["data"] = [
                    "networks" => $networks,
                    "nodes" => $nodes,
                    "textObjects" => $textObjects,
                    "labinfo" => $labinfo,
                    "lines" => $lines,
                ];
                break;
            case "html":
                $Parsedown = new Parsedown();
                $output["status"] = "success";
                $output["message"] = $GLOBALS["messages"]["60054"];
                $output["data"] = $Parsedown->text($lab->getBody());
                break;
            case "configs":
                if (isset($variables["id"])) {
                    $output = apiGetLabConfig($lab, $variables["id"]);
                } else {
                    $output = apiGetLabConfigs($lab);
                }
                break;
            case "networks":
                if (isset($variables["id"])) {
                    $output = apiGetLabNetwork($lab, $variables["id"]);
                } else {
                    $output = apiGetLabNetworks($lab);
                }
                break;
            case "textobjects":
                if (isset($variables["id"])) {
                    $output = apiGetLabTextObject($lab, $variables["id"]);
                } else {
                    $output = apiGetLabTextObjects($lab, null);
                }
                break;

            case "pictures":
                if (isset($variables["id"])) {
                    $output = apiGetLabPicture($lab, $variables["id"]);
                } else {
                    $output = apiGetLabPictures($lab);
                }
                break;

            case "picturemapped":
                $id = $variables["id"];
                $output = apiGetLabPictureMapped($lab, $id, $user["html5"]);
                break;

            case "picturedata":
                $id = $variables["id"];
                $height = get($variables["height"], 0);
                $width = get($variables["width"], 0);
                $output = apiGetLabPictureData($lab, $id, $width, $height);
                ob_clean();
                $app->response->headers->set(
                    "Content-Type",
                    $output["encoding"]
                );
                $app->response->setBody(trim($output["data"]));
                unlockSession($session);
                return;

            case "links":
                $output = apiGetLabLinks($lab);
                break;

            case "nodes":
                if (isset($variables["id"])) {
                    $output = apiGetLabNode(
                        $lab,
                        $variables["id"],
                        $user["html5"]
                    );
                } else {
                    $output = apiGetLabNodes($lab, $user["html5"]);
                }
                break;

            case "interfaces":
                $node_id = get($variables["node_id"], null);
                $output = apiGetLabNodeInterfaces($lab, $node_id);
                break;

            case "networkints":
                $p = $variables;
                $network_id = get($p["network_id"], "");
                if ($network_id != "") {
                    $network = $lab->getNetworks()[$network_id];
                }
                $ints = [];
                if (isset($network)) {
                    foreach ($lab->getNodes() as $node_id => $node) {
                        foreach (
                            $node->getInterfaces()
                            as $interface_id => $interface
                        ) {
                            if ($interface->getNetworkId() == $network_id) {
                                $ints[] = [
                                    "node_id" => $node_id,
                                    "node" => $node->getName(),
                                    "id" => $interface_id,
                                    "name" => $interface->getName(),
                                    "quality" => (object) $interface->getQuality(),
                                ];
                            }
                        }
                    }
                }
                $output["message"] = $ints;
                break;

            case "interface":
                $p = $variables;
                $nodeId = get($p["node_id"], "");
                if ($nodeId === "") {
                    throw new Exception("No node defined");
                }
                $interfaceId = get($p["interface_id"], "");
                if ($interfaceId === "") {
                    throw new Exception("No interface defined");
                }
                $node = $lab->getNodes()[$nodeId];
                if (!$node) {
                    throw new Exception("Undefine node");
                }
                $interface = $node->getInterfaces()[$interfaceId];
                if (!$interface) {
                    throw new Exception("Undefine Interface");
                }
                $output["message"] = [
                    "node_id" => $nodeId,
                    "node" => $node->getName(),
                    "id" => $interfaceId,
                    "name" => $interface->getName(),
                    "quality" => (object) $interface->getQuality(),
                ];
                break;

            case "links":
                $output = apiGetLabLinks($lab);
                break;

            case "line":
                $lines = $lab->getLineObjects();
                $output["message"] = $lines;
                break;

            case "workbook":
                $name = get($variables["name"], null);
                $content = get($variables["content"], 1);
                $output["message"] = $lab->getWorkbook($name, $content);
                break;

            case "tasks":
                $name = get($variables["name"], null);
                if ($name === null || $name === "") {
                    $taskList = [];
                    foreach ($lab->getTasks() as $task) {
                        $taskList[] = [
                            "id" => $task["name"],
                            "weight" => $task["weight"],
                        ];
                    }

                    $canEdit = false;
                    try {
                        checkLabPermission($lab, USER_PER_EDIT_TASKS);
                        $canEdit = true;
                    } catch (Exception $e) {
                        // This is an informational probe; lack of permission is not an API error.
                    }
                    $output["message"] = [
                        "tasks" => $taskList,
                        "can_edit" => $canEdit,
                    ];
                } else {
                    $task = $lab->getTasks($name);
                    $output["message"] = [
                        "id" => $task->name,
                        "weight" => $task->weight,
                        "html" => $task->content,
                    ];
                }
                break;

            case "validation":
                $output["message"] = lab_validation_snapshot($lab, $user);
                break;

            case "wireshark":
                $query =
                    "SELECT * FROM wiresharks WHERE ws_tenant=:ws_tenant AND ws_lab=:ws_lab";
                $statement = $db->prepare($query);
                $statement->execute([
                    "ws_tenant" => $tenant,
                    "ws_lab" => $lab->getSession(),
                ]);

                $result = $statement->fetchAll(PDO::FETCH_ASSOC);
                $output["message"] = $result;
                break;

            case "multi_cfg_list":
                checkLabPermission($lab, USER_PER_EDIT_LAB);
                $nodes = $lab->getNodes();
                $cfg_list = [];
                foreach ($nodes as $node) {
                    $nodecfg = array_keys($node->getMulti_config());
                    $cfg_list = array_merge($cfg_list, $nodecfg);
                }
                $cfg_list = array_unique($cfg_list);

                $output["code"] = 200;
                $output["status"] = "success";
                $output["data"] = $cfg_list;
                break;

            case "multi_cfg_detail":
                checkLabPermission($lab, USER_PER_EDIT_LAB);
                $p = $variables;
                $name = get($p["name"], "");
                $nodes = $lab->getNodes();
                $cfg_list = [];
                if ($name == "") {
                    foreach ($nodes as $node) {
                        $cfg_list[$node->getId()] = $node->getConfigData();
                    }
                } else {
                    foreach ($nodes as $node) {
                        $cfg_list[$node->getId()] = $node->getMultiCfg($name);
                    }
                }

                $output["code"] = 200;
                $output["status"] = "success";
                $output["data"] = $cfg_list;

                break;

            case "portcheck":
                // webwait loader: is this node's console web GUI actually
                // answering HTTP(S) yet? A plain TCP check is not enough:
                // docker-proxy accepts TCP on the published host port the
                // instant the container starts, well before the in-container
                // GUI daemon is listening, so a TCP-only probe reports "up"
                // 10-15s too early. apiPortcheckLabNode() issues a real
                // HTTP(S) request instead. Host/port/scheme are derived
                // SERVER-SIDE from the node's own console URL (same source
                // getConsoleUrl/consoleHost use) — the client only supplies
                // the node id, never a host/port, so this can't be turned
                // into an arbitrary-host probe.
                $nodeId = get($variables["id"], "");
                if ($nodeId === "") {
                    throw new Exception("No node defined");
                }
                $which = (int) get($variables["which"], 1);
                $output = apiPortcheckLabNode($lab, $nodeId, $which);
                break;

            case "console_guac_link":
                // get console link for node using html console

                $p = $variables;
                $nodeId = get($p["node_id"], "");
                $index = get($p["index"], 1);
                if ($nodeId === "") {
                    throw new Exception("No node defined");
                }
                $node = $lab->getNodes()[$nodeId];
                if (!$node) {
                    throw new Exception("Undefine node");
                }

                $link = $node->getGuacConsoleLink($index);

                $output["code"] = 200;
                $output["status"] = "success";
                $output["data"] = $link;

                break;
        }

        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        unlockSession($session);
        return;
    } catch (ResponseException $e) {
        unlockSession($session);
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        unlockSession($session);
        $output["code"] = $e instanceof LabValidationException ? $e->getHttpStatus() : 400;
        $output["status"] = "fail";
        $output["message"] = isset($GLOBALS["messages"][$e->getMessage()])
            ? $GLOBALS["messages"][$e->getMessage()] : $e->getMessage();
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

$app->post("/api/nodestatus", function () use ($app) {
    try {
        $indent = new \indentify();
        list($user, $tenant, $output) = $indent->authorization(
            $app->getCookie("token")
        );
        if ($user === false) {
            $app->response->setStatus($output["code"]);
            $app->response->setBody(json_encode($output));
            return;
        }

        $output = ["code" => 200, "status" => "success", "message" => ""];
        $output["data"] = getNodesStatus(null);
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

$app->post("/api/labs/session/nodestatus", function () use ($app) {
    try {
        $indent = new \indentify();
        list($user, $tenant, $output) = $indent->authorization(
            $app->getCookie("token")
        );
        if ($user === false) {
            $app->response->setStatus($output["code"]);
            $app->response->setBody(json_encode($output));
            return;
        }

        $output = ["code" => 200, "status" => "success", "message" => ""];
        // The users.lab_session pointer is per-POD: another login of the same
        // account (second tab, API scripting) repoints it mid-view and this
        // poll would return some other lab's statuses keyed by foreign node
        // ids — the topology badges then never update again. When the client
        // pins the session its page displays, use THAT (if joined).
        $session = "";
        $pin = $app->request()->post("lab_session");
        if (!empty($pin) && ctype_digit((string) $pin)
                && labSessionJoinedBy((int) $pin, $tenant)) {
            $session = (int) $pin;
        }
        if (empty($session)) {
            $session = get($user["lab"], "");
        }
        if ($session == "") {
            throw new Exception("NO_LAB_SESSION");
        }

        $output["data"] = getNodesStatus($session);
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));

        return;
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

$app->post("/api/labs/session/(:object)/(:action)", function (
    $object,
    $action
) use ($app) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
    updateOnlineTime($tenant);
    $variables = json_decode($app->request()->getBody(), true);
    if (!is_array($variables)) $variables = array();
    $labFile = "";
    $session = get($user["lab"], "");

    try {
        $labsession = getLabFromSession($session);
        if (!$labsession) {
            throw new Exception("NO_LAB_SESSION");
        }
        $labFile = BASE_LAB . $labsession["lab_session_path"];
        lockFile($labFile);
        lockSession($session);
        $lab = new Lab($labFile, $tenant, $session);

        $output = ["code" => 200, "status" => "success", "message" => ""];

        switch ($object) {
            case "validation":
                if ($action === "save") {
                    checkLabPermission($lab, USER_PER_EDIT_TASKS);
                    checkLockLab($lab);
                    if (!array_key_exists("tasks", $variables)) {
                        throw new LabValidationException("Validation tasks are required");
                    }
                    lab_validation_save($lab,
                        $variables["tasks"],
                        isset($variables["base_revision"]) ? $variables["base_revision"] : -1);
                    $output["message"] = lab_validation_snapshot($lab, $user);
                } elseif ($action === "import") {
                    checkLabPermission($lab, USER_PER_EDIT_TASKS);
                    $yaml = isset($variables["yaml"]) ? $variables["yaml"] : null;
                    $mapping = isset($variables["node_mapping"]) ? $variables["node_mapping"] : array();
                    if (!is_array($mapping)) throw new LabValidationException("Invalid node mapping");
                    $preview = !empty($variables["preview"]);
                    if (!$preview) checkLockLab($lab);
                    $imported = lab_validation_import($lab, $yaml,
                        isset($variables["base_revision"]) ? $variables["base_revision"] : -1,
                        $mapping, $preview);
                    $output["message"] = $preview ? $imported : lab_validation_snapshot($lab, $user);
                } elseif ($action === "export") {
                    checkLabPermission($lab, USER_PER_EDIT_TASKS);
                    $output["message"] = array(
                        "filename" => $lab->getName() . "-validation-tasks.yaml",
                        "mime" => "application/yaml",
                        "yaml" => lab_validation_export($lab),
                    );
                } elseif ($action === "run") {
                    $checkId = lab_validation_clean_id(
                        isset($variables["check_id"]) ? $variables["check_id"] : "", "check");
                    $doc = lab_validation_load($lab);
                    $tasks = lab_validation_validate_tasks($doc["tasks"], $lab, false, false);
                    $check = lab_validation_find_check($tasks, $checkId);
                    if (!function_exists("lab_validation_run_check")) {
                        throw new LabValidationException("Validation runner is unavailable", 500);
                    }
                    $runResult = lab_validation_run_check($lab, $check, $user);
                    if (!is_array($runResult)) {
                        $runResult = array("status" => "error", "detail" => "Validation runner returned no result");
                    }
                    $savedResult = lab_validation_store_result($lab, $user, $check, $runResult);
                    $savedResult["check_id"] = $checkId;
                    $progress = lab_validation_progress_load($lab, $user);
                    $aggregate = lab_validation_summary($tasks, $progress["checks"]);
                    $output["message"] = array("result" => $savedResult, "summary" => $aggregate["summary"]);
                } else {
                    throw new LabValidationException("Unknown validation action", 404);
                }
                break;

            case "sdwan":
                // "Cisco SDWAN Lab Builder" — list installed image versions, or build
                // the standard SD-WAN topology into the open lab.
                if ($action == "versions") {
                    $output = apiSdwanListImages();
                } elseif ($action == "build") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $output = apiSdwanBuild($lab, $variables, $tenant);
                } else {
                    throw new Exception("Unknown sdwan action");
                }
                break;

            case "ai":
                // "AI Lab Builder" — NL -> plan / build via the in-app agent. The
                // build runs in a SEPARATE root process (the agent) that takes its
                // OWN per-mutation lock on the .unl, so release this request's lock
                // first to avoid a self-deadlock; the route tail's unlock no-ops.
                unlockFile($labFile);
                unLockSession($session);
                if ($action == "access") {
                    // F-RBAC access probe: returns {allowed, enabled} from the
                    // server session. Does NOT require USER_PER_EDIT_LAB and does
                    // NOT re-acquire the lab lock — lightweight, safe for polling.
                    $aiCfgResp = broker_call("ai_settings_read", [], 10);
                    $aiCfgData = [];
                    if (!empty($aiCfgResp["ok"]) && !empty($aiCfgResp["out"][0])) {
                        $parsed = json_decode((string) $aiCfgResp["out"][0], true);
                        if (is_array($parsed)) {
                            // ai_settings_read returns the redacted config dict
                            // DIRECTLY (mcp/provider/limits at top level), not under
                            // a "data" wrapper — read it as-is (fallback kept defensively).
                            $aiCfgData = (isset($parsed["data"]) && is_array($parsed["data"]))
                                ? $parsed["data"] : $parsed;
                        }
                    }
                    $aiEnabled    = isset($aiCfgData["mcp"]["enabled"]) ? (bool) $aiCfgData["mcp"]["enabled"] : false;
                    $allowedRoles = isset($aiCfgData["limits"]["ai_allowed_roles"]) && is_array($aiCfgData["limits"]["ai_allowed_roles"])
                        ? $aiCfgData["limits"]["ai_allowed_roles"]
                        : [];
                    $userRole  = (string) get($user["role"], "");
                    $aiAllowed = ($userRole === "0" || strtolower($userRole) === "admin")
                        || in_array($userRole, $allowedRoles, true);
                    $output = [
                        "code"    => 200,
                        "status"  => "success",
                        "message" => "",
                        "data"    => [
                            "allowed" => $aiAllowed,
                            "enabled" => $aiEnabled,
                        ],
                    ];
                } elseif ($action == "progress") {
                    // Cheap live-progress poll: the broker tees the running build's
                    // JSONL to a per-pod file; return new events since `offset`.
                    $resp = broker_call("ai_progress_read", [
                        "pod"    => (int) $labsession[LAB_SESSION_POD],
                        "offset" => (int) get($variables["offset"], 0),
                    ], 15);
                    if (empty($resp["ok"])) {
                        throw new Exception(get($resp["err"], "progress read failed"));
                    }
                    $pr = json_decode((string) get($resp["out"][0], "{}"), true);
                    $output = [
                        "code"    => 200,
                        "status"  => "success",
                        "message" => "",
                        "data"    => is_array($pr) ? $pr
                            : ["events" => [], "offset" => 0, "running" => false],
                    ];
                } elseif ($action == "plan" || $action == "build") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    // F-RBAC: enforce ai_allowed_roles before invoking the agent.
                    $rbacResp    = broker_call("ai_settings_read", [], 10);
                    $rbacCfgData = [];
                    if (!empty($rbacResp["ok"]) && !empty($rbacResp["out"][0])) {
                        $rbacParsed = json_decode((string) $rbacResp["out"][0], true);
                        if (is_array($rbacParsed)) {
                            // redacted config dict is returned directly (see access probe)
                            $rbacCfgData = (isset($rbacParsed["data"]) && is_array($rbacParsed["data"]))
                                ? $rbacParsed["data"] : $rbacParsed;
                        }
                    }
                    $rbacAllowedRoles = isset($rbacCfgData["limits"]["ai_allowed_roles"]) && is_array($rbacCfgData["limits"]["ai_allowed_roles"])
                        ? $rbacCfgData["limits"]["ai_allowed_roles"]
                        : [];
                    $rbacUserRole = (string) get($user["role"], "");
                    $rbacAllowed  = ($rbacUserRole === "0" || strtolower($rbacUserRole) === "admin")
                        || in_array($rbacUserRole, $rbacAllowedRoles, true);
                    if (!$rbacAllowed) {
                        $output = [
                            "code"    => 403,
                            "status"  => "fail",
                            "message" => "AI Lab Builder is not enabled for your role",
                        ];
                        break;
                    }
                    $prompt = (string) get($variables["prompt"], "");
                    if (trim($prompt) === "") {
                        throw new Exception("Empty prompt");
                    }
                    $mode = ($action == "plan") ? "plan" : "apply";
                    $resp = broker_call("ai_lab_build", [
                        "pod"      => (int) $labsession[LAB_SESSION_POD],
                        "lab_path" => $labsession["lab_session_path"],
                        "prompt"   => $prompt,
                        "mode"     => $mode,
                    ], 600);
                    if (empty($resp["ok"])) {
                        throw new Exception(get($resp["err"], "AI build failed"));
                    }
                    // out = the agent's JSONL events; surface them + the final state
                    $events = [];
                    $done = null;
                    $err = null;
                    foreach ((array) get($resp["out"], []) as $line) {
                        $ev = json_decode($line, true);
                        if (!is_array($ev)) {
                            continue;
                        }
                        $events[] = $ev;
                        if (get($ev["type"], "") === "done") {
                            $done = $ev;
                        }
                        if (get($ev["type"], "") === "error") {
                            $err = $ev;
                        }
                    }
                    if ($err !== null && $done === null) {
                        throw new Exception(get($err["error"], "AI build error"));
                    }
                    $output = [
                        "code"    => 200,
                        "status"  => "success",
                        "message" => $done ? get($done["summary"], "done") : "done",
                        "data"    => [
                            "mode"   => $mode,
                            "events" => $events,
                            "done"   => $done,
                        ],
                    ];
                    // If the agent created a NEW lab (user asked for a separate
                    // lab), make it this pod's open session so the UI can open it;
                    // otherwise refresh the current canvas with the rebuilt lab.
                    $createdPath = $done ? (string) get($done["created_lab_path"], "") : "";
                    $openedNew = false;
                    if ($mode == "apply" && $createdPath !== ""
                        && $createdPath !== $labsession["lab_session_path"]) {
                        try {
                            $newLab = new Lab(BASE_LAB . $createdPath, $tenant);
                            $add = addLabSession($newLab->getId(), $tenant, $createdPath);
                            if (!empty($add["result"])) {
                                $output["data"]["open_lab"] = [
                                    "path" => $createdPath,
                                    "url"  => "/legacy/topology",
                                ];
                                $openedNew = true;
                            }
                        } catch (Exception $e) {
                            // fall through to an in-place refresh of the old lab
                        }
                    }
                    if ($mode == "apply" && !$openedNew) {
                        $fresh = new Lab($labFile, $tenant, $session);
                        $fnodes = apiGetLabNodes($fresh, $user["html5"]);
                        $fnets  = apiGetLabNetworks($fresh);
                        $output["update"] = [
                            "nodes"    => get($fnodes["data"], new stdClass()),
                            "networks" => get($fnets["data"], new stdClass()),
                        ];
                    }
                } else {
                    throw new Exception("Unknown ai action");
                }
                break;

            case "lab":
                if ($action == "lock") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    if ($lab->isLock()) {
                        throw new Exception("Lab is already locked");
                    }
                    $password = get($variables["password"], null);
                    $output = apiLockLab($lab, $password);
                } elseif ($action == "unlock") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    $password = get($variables["password"], "");
                    if ($password == "") {
                        throw new Exception(
                            "Please fill Password to unLock Lab"
                        );
                    }
                    $clearPass = get($variables["clear"], false);
                    $output = apiUnlockLab($lab, $password, $clearPass);
                }

                $data = apiGetLab($lab);
                if ($data["status"] == "success") {
                    $data = $data["data"];
                    $output["update"] = ["labinfo" => $data];
                }

                break;

            case "nodes":
                if (in_array($action, [
                    "start", "stop", "shutdown", "hibernate", "isolate", "freeze", "wipe",
                ], true)) {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                }
                if ($action == "start") {
                    checkLimit($labsession[LAB_SESSION_POD]);
                    checkRunningNodeLimit($labsession[LAB_SESSION_POD]);
                    $node_id = get($variables["id"], null);
                    $output = apiStartLabNode($lab, $node_id, $tenant);
                } elseif ($action == "stop") {
                    $node_id = get($variables["id"], null);
                    $output = apiStopLabNode($lab, $node_id, $tenant);
                } elseif ($action == "shutdown") {
                    $nodeId = get($variables["id"], "");
                    if ($nodeId === "") {
                        throw new Exception("No node defined");
                    }
                    $nodes = $lab->getNodes();
                    if (!isset($nodes[$nodeId])) {
                        throw new Exception("Undefine node");
                    }
                    $node = $nodes[$nodeId];
                    $node->shutdown();                
                } elseif ($action == "hibernate") {
                    $nodeId = get($variables["id"], "");
                    if ($nodeId === "") {
                        throw new Exception("No node defined");
                    }
                    $nodes = $lab->getNodes();
                    if (!isset($nodes[$nodeId])) {
                        throw new Exception("Undefine node");
                    }
                    $node = $nodes[$nodeId];
                    $node->hibernate();                
                } elseif ($action == "isolate") {
                    $nodeId = get($variables["id"], "");
                    if ($nodeId === "") {
                        throw new Exception("No node defined");
                    }
                    $nodes = $lab->getNodes();
                    if (!isset($nodes[$nodeId])) {
                        throw new Exception("Undefine node");
                    }
                    $node = $nodes[$nodeId];
                    $node->isolate();                
                } elseif ($action == "freeze") {
                    $nodeId = get($variables["id"], "");
                    if ($nodeId === "") {
                        throw new Exception("No node defined");
                    }
                    $nodes = $lab->getNodes();
                    if (!isset($nodes[$nodeId])) {
                        throw new Exception("Undefine node");
                    }
                    $node = $nodes[$nodeId];
                    $node->freeze();                
                } elseif ($action == "add") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    checkLimit($labsession[LAB_SESSION_POD]);
                    if (isset($variables["count"])) {
                        unset($variables["count"]);
                    }
                    $duplicateOf = get($variables["duplicate_of"], null);
                    $nodesBeforeAdd = $lab->getNodes();
                    if ($duplicateOf === null || !is_scalar($duplicateOf) || !isset($nodesBeforeAdd[$duplicateOf])) {
                        $duplicateOf = null;
                    }
                    unset($variables["duplicate_of"]);
                    $output = apiAddLabNode($lab, $variables, false);
                    if (isset($output["status"]) && $output["status"] === "success"
                        && isset($output["data"]["ids"]) && is_array($output["data"]["ids"])) {
                        $addedNodes = $lab->getNodes();
                        foreach ($output["data"]["ids"] as $addedId) {
                            $nodeInfo = isset($addedNodes[$addedId]) ? activity_log_node_data($addedNodes[$addedId]) : [];
                            activity_log_event(null, $user, "node", $duplicateOf === null ? "create" : "duplicate", [
                                "lab_path" => activity_log_lab_path($lab), "lab_name" => $lab->getName(),
                                "node_name" => isset($nodeInfo["node_name"]) ? $nodeInfo["node_name"] : null,
                                "node_template" => isset($nodeInfo["node_template"]) ? $nodeInfo["node_template"] : null,
                                "detail" => $duplicateOf === null ? ["node_id" => $addedId] : ["node_id" => $addedId, "duplicate_of" => $duplicateOf],
                            ]);
                        }
                    }
                } elseif ($action == "edit") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $beforeEditNames = [];
                    foreach ($lab->getNodes() as $beforeId => $beforeNode) {
                        $beforeEditNames[(string) $beforeId] = activity_log_node_data($beforeNode);
                    }
                    if (isset($variables["id"])) {
                        // Wireless AP/STA PSK sanity — 8..63 chars for WPA2-PSK/WPA3-SAE,
                        // mirroring the broker's wireless-cell check. Reject on the
                        // interactive edit path (this try/catch returns a clean 400) so
                        // the user never saves a passphrase that makes hostapd/
                        // wpa_supplicant silently refuse to start. Validation lives in the
                        // device class (validateWpaPsk); not in editParams() because that
                        // also runs on .unl load and a throw there aborts the lab open.
                        $wifiNodes = $lab->getNodes();
                        $wifiEditId = $variables["id"];
                        if (isset($wifiNodes[$wifiEditId])
                            && isset($variables["Security"]) && isset($variables["WPA_Passphrase"])) {
                            $wifiTpl = $wifiNodes[$wifiEditId]->getTemplate();
                            $wifiCls = ($wifiTpl === 'wifiap') ? 'device_wifiap'
                                : (($wifiTpl === 'wifista') ? 'device_wifista' : '');
                            if ($wifiCls !== '' && method_exists($wifiCls, 'validateWpaPsk')) {
                                $wifiErr = $wifiCls::validateWpaPsk(
                                    (string) $variables["Security"],
                                    (string) $variables["WPA_Passphrase"]
                                );
                                if ($wifiErr !== '') {
                                    throw new Exception($wifiErr);
                                }
                            }
                        }
                        $output = apiEditLabNode($lab, $variables);
                    } elseif (isset($variables["data"])) {
                        $output = apiEditLabNodes($lab, $variables["data"]);
                    } else {
                        throw new Exception("No data");
                    }
                    if (isset($output["status"]) && $output["status"] === "success") {
                        foreach ($lab->getNodes() as $afterId => $afterNode) {
                            $key = (string) $afterId;
                            $afterInfo = activity_log_node_data($afterNode);
                            if (isset($beforeEditNames[$key]) && $beforeEditNames[$key]["node_name"] !== $afterInfo["node_name"]) {
                                activity_log_event(null, $user, "node", "rename", [
                                    "lab_path" => activity_log_lab_path($lab), "lab_name" => $lab->getName(),
                                    "node_name" => $afterInfo["node_name"], "node_template" => $afterInfo["node_template"],
                                    "detail" => ["node_id" => $afterId, "old_name" => $beforeEditNames[$key]["node_name"]],
                                ]);
                            }
                        }
                    }
                } elseif ($action == "delete") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $node_id = get($variables["id"], null);
                    if ($node_id === null) {
                        throw new Exception("Node ID undefined");
                    }
                    $deleteNodes = $lab->getNodes();
                    $deleteInfo = isset($deleteNodes[$node_id]) ? activity_log_node_data($deleteNodes[$node_id]) : [];
                    $output = apiDeleteLabNode($lab, $node_id, $tenant);
                    if (isset($output["status"]) && $output["status"] === "success") {
                        activity_log_event(null, $user, "node", "delete", [
                            "lab_path" => activity_log_lab_path($lab), "lab_name" => $lab->getName(),
                            "node_name" => isset($deleteInfo["node_name"]) ? $deleteInfo["node_name"] : null,
                            "node_template" => isset($deleteInfo["node_template"]) ? $deleteInfo["node_template"] : null,
                            "detail" => ["node_id" => $node_id],
                        ]);
                    }
                } elseif ($action == "export") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    if (isset($variables["id"])) {
                        $output = apiExportLabNode(
                            $lab,
                            $variables["id"],
                            $tenant
                        );
                    } else {
                        $output = apiExportLabNodes($lab, $tenant);
                    }
                } elseif ($action == "wipe") {
                    $wipeNodes = $lab->getNodes();
                    $wipeTargets = [];
                    if (isset($variables["id"])) {
                        if (isset($wipeNodes[$variables["id"]])) {
                            $wipeTargets[$variables["id"]] = activity_log_node_data($wipeNodes[$variables["id"]]);
                        }
                        $output = apiWipeLabNode(
                            $lab,
                            $variables["id"],
                            $tenant
                        );
                    } else {
                        foreach ($wipeNodes as $wipeId => $wipeNode) {
                            $wipeTargets[$wipeId] = activity_log_node_data($wipeNode);
                        }
                        $output = apiWipeLabNodes($lab, $tenant);
                    }
                    if (isset($output["status"]) && $output["status"] === "success") {
                        foreach ($wipeTargets as $wipeId => $wipeInfo) {
                            activity_log_event(null, $user, "node", "wipe", [
                                "lab_path" => activity_log_lab_path($lab), "lab_name" => $lab->getName(),
                                "node_name" => $wipeInfo["node_name"], "node_template" => $wipeInfo["node_template"],
                                "detail" => ["node_id" => $wipeId],
                            ]);
                        }
                    }
                } elseif ($action == "commit") {
                    // Commit a qemu node's disk overlay: mode=commit folds it
                    // into the SHARED base image, mode=save_as writes a new
                    // named image under addons/qemu. Both are appliance-global
                    // writes, so apiCommitLabNode gates on isAdmin() rather
                    // than lab-edit permission — see the note there.
                    $node_id = get($variables["id"], null);
                    if ($node_id === null) {
                        throw new Exception("Node ID undefined");
                    }
                    $output = apiCommitLabNode(
                        $lab,
                        $node_id,
                        (string) get($variables["mode"], ""),
                        (string) get($variables["dest"], "")
                    );
                } elseif ($action == "lock") {
                    // F-LOCK: set node lock=1 (prevents stop/wipe/delete).
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $node_id = get($variables["id"], null);
                    if ($node_id === null) {
                        throw new Exception("Node ID undefined");
                    }
                    $nodes = $lab->getNodes();
                    if (!isset($nodes[$node_id])) {
                        throw new Exception("Node not found");
                    }
                    $rc = $lab->editNode(["id" => $node_id, "lock" => 1]);
                    if ($rc !== 0) {
                        throw new Exception("Failed to lock node");
                    }
                    $lab->save();
                    $output["code"]    = 201;
                    $output["status"]  = "success";
                    $output["message"] = "Node locked";
                    $data = apiGetLabNodes($lab, $user["html5"]);
                    if ($data["status"] == "success") {
                        $output["update"] = ["nodes" => $data["data"]];
                    }
                } elseif ($action == "unlock") {
                    if (isset($variables["id"])) {
                        $node_id = $variables["id"];
                        $nodes = $lab->getNodes();
                        if (!isset($nodes[$node_id])) {
                            throw new Exception("Undefine node");
                        }
                        // F-LOCK: clear node lock=0 (requires edit permission).
                        checkLabPermission($lab, USER_PER_EDIT_LAB);
                        checkLockLab($lab);
                        $rc = $lab->editNode(["id" => $node_id, "lock" => 0]);
                        if ($rc !== 0) {
                            throw new Exception("Failed to unlock node");
                        }
                        $lab->save();
                        $output["code"]    = 201;
                        $output["status"]  = "success";
                        $output["message"] = "Node unlocked";
                        $data = apiGetLabNodes($lab, $user["html5"]);
                        if ($data["status"] == "success") {
                            $output["update"] = ["nodes" => $data["data"]];
                        }
                        // Also release any console/VNC session lock on this node.
                        $nodes[$node_id]->unlock();
                    }
                } elseif ($action == "port") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    if (isset($variables["id"]) && isset($variables["port"])) {
                        $output = apiEditNodePort(
                            $lab,
                            $variables["id"],
                            $variables["port"]
                        );
                    } else {
                        throw new Exception("No data");
                    }
                }elseif ($action == "port_2nd") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    if (isset($variables["id"]) && isset($variables["port_2nd"])) {
                        $output = apiEditNodePort_2nd( 
                            $lab,
                            $variables["id"],
                            $variables["port_2nd"]
                        );
                    } else {
                        throw new Exception("No data");
                    }
                }

                break;

            case "networks":
                if ($action == "edit") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    if (isset($variables["id"])) {
                        $output = apiEditLabNetwork($lab, $variables);
                    } elseif (isset($variables["data"])) {
                        $output = apiEditLabNetworks($lab, $variables["data"]);
                    } else {
                        throw new Exception("No data");
                    }
                } elseif ($action == "add") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $output = apiAddLabNetwork($lab, $variables, false);
                } elseif ($action == "delete") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    if (isset($variables["id"])) {
                        $output = apiDeleteLabNetwork($lab, $variables["id"]);
                    }
                } elseif ($action == "p2p") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    // A p2p link needs BOTH endpoints. A missing/null id passed the
                    // isset() checks below as absent, so the call "succeeded" while
                    // connecting nothing — refuse it up front instead.
                    foreach (["src_id", "src_if", "dest_id", "dest_if"] as $k) {
                        if (!isset($variables[$k]) || $variables[$k] === "") {
                            throw new Exception("p2p: missing required field " . $k);
                        }
                    }
                    $networkParams["visibility"] = 0;
                    $networkParams["type"] = "bridge";
                    $networkParams["postfix"] = 0;
                    $networkParams["top"] = 0;
                    $networkParams["left"] = 0;
                    // NOTE: this used PHP backticks (`Net-` = shell-exec of a command
                    // named "Net-", returning null) — a stray shell spawn per link and
                    // the prefix never applied. String literal instead.
                    $networkParams["name"] = "Net-" . get($variables["name"], "p2p");
                    $networkParams["count"] = 2;
                    $result = apiAddLabNetwork($lab, $networkParams, false);
                    if ($result["status"] == "success") {
                        $network_id = $result["data"]["id"];
                    } else {
                        throw new Exception("Can not create network");
                    }

                    $output["message"] = "Create connection successfully";
                    $src_id = $variables["src_id"];
                    $src_if = $variables["src_if"];
                    if (isset($src_id) && isset($src_if)) {
                        $hostlink = $lab->connectNode($src_id, [
                            $src_if => $network_id,
                        ]);
                        if ($hostlink == 1) {
                            $output["message"] = "success";
                        }
                    }
                    $dest_id = $variables["dest_id"];
                    $dest_if = $variables["dest_if"];
                    if (isset($dest_id) && isset($dest_if)) {
                        $hostlink = $lab->connectNode($dest_id, [
                            $dest_if => $network_id,
                        ]);
                        if ($hostlink == 1) {
                            $output["message"] = "success";
                        }
                    }
                }

                $output["update"] = [];
                $data = apiGetLabNetworks($lab);
                if ($data["status"] == "success") {
                    $data = $data["data"];
                    $output["update"]["networks"] = $data;
                }
                $data = apiGetLabNodes($lab, $user["html5"]);
                if ($data["status"] == "success") {
                    $data = $data["data"];
                    $output["update"]["nodes"] = $data;
                }
                break;

            case "configs":
                if ($action == "edit") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    if (isset($variables["id"])) {
                        $output = apiEditLabConfig($lab, $variables);
                    }
                }
                break;

            case "interfaces":
                if (in_array($action, ["setquality", "setSuspend", "setSuspendtwo_way"], true)) {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                }
                $updateStyle = function ($p) use ($lab) {
                    $network_id = get($p["network_id"], "");
                    if ($network_id != "") {
                        $network = $lab->getNetworks()[$network_id];
                    }

                    if (isset($network)) {
                        // Per-link fields (label & friends) must not fan out to
                        // every member of a multi-access network. When the client
                        // identifies the clicked spoke (node_id + interface_id,
                        // sent for cloud-member edges), apply those fields to that
                        // interface only; segment-wide styling (style/linkstyle/
                        // color/width/linkcfg) still applies to all members.
                        // Without a target (p2p ethernet, legacy callers) the
                        // behaviour is unchanged: full $p to every member.
                        $perIfKeys = [
                            "label",
                            "labelpos",
                            "fontsize",
                            "srcpos",
                            "dstpos",
                        ];
                        $targetNode = get($p["node_id"], "");
                        $targetIf = get($p["interface_id"], "");
                        $shared = $p;
                        if ($targetNode !== "" && $targetIf !== "") {
                            foreach ($perIfKeys as $k) {
                                unset($shared[$k]);
                            }
                        }
                        foreach ($lab->getNodes() as $node_id => $node) {
                            foreach (
                                $node->getInterfaces()
                                as $interface_id => $interface
                            ) {
                                if ($interface->getNetworkId() == $network_id) {
                                    if (
                                        (string) $node_id ===
                                            (string) $targetNode &&
                                        (string) $interface_id ===
                                            (string) $targetIf
                                    ) {
                                        $interface->setInterfaceStyle($p);
                                    } else {
                                        $interface->setInterfaceStyle($shared);
                                    }
                                }
                            }
                        }
                    } else {
                        $nodeId = get($p["node_id"], "");
                        if ($nodeId === "") {
                            throw new Exception("No node defined");
                        }
                        $interfaceId = get($p["interface_id"], "");
                        if ($interfaceId === "") {
                            throw new Exception("No interface defined");
                        }
                        $nodes = $lab->getNodes();
                        if (!isset($nodes[$nodeId])) {
                            throw new Exception("Undefine node");
                        }
                        $node = $nodes[$nodeId];
                        $interfaces = $node->getInterfaces();
                        if (!isset($interfaces[$interfaceId])) {
                            throw new Exception("Undefine Interface");
                        }
                        $interface = $node->getInterfaces()[$interfaceId];
                        $interface->setInterfaceStyle($p);

                        $remoteId = $interface->getRemoteId();

                        if (isset($nodes[$remoteId])) {
                            $rmnode = $nodes[$remoteId];
                            $rminterfaces = $rmnode->getInterfaces();
                            $remoteIf = $interface->getRemoteIf();
                            if (isset($rminterfaces[$remoteIf])) {
                                $rminterface = $rminterfaces[$remoteIf];
                                $rminterface->setInterfaceStyle($p);
                            }
                        }
                    }
                };

                if ($action == "edit") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    if (
                        isset($variables["node_id"]) &&
                        isset($variables["data"])
                    ) {
                        $output = apiEditLabNodeInterfaces(
                            $lab,
                            $variables["node_id"],
                            $variables["data"]
                        );
                    }
                } elseif ($action == "style") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $p = $variables;
                    $updateStyle($p);
                    $lab->save();
                } elseif ($action == "styles") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $p = $variables["data"];

                    foreach ($p as $param) {
                        $updateStyle($param);
                    }

                    $lab->save();
                } elseif ($action == "setquality") {
                    $p = $variables;
                    $nodeId = get($p["node_id"], "");
                    if ($nodeId === "") {
                        throw new Exception("No node defined");
                    }
                    $interfaceId = get($p["interface_id"], "");
                    if ($interfaceId === "") {
                        throw new Exception("No interface defined");
                    }
                    $nodes = $lab->getNodes();
                    if (!isset($nodes[$nodeId])) {
                        throw new Exception("Undefine node");
                    }
                    $node = $nodes[$nodeId];
                    $interfaces = $node->getInterfaces();
                    if (!isset($interfaces[$interfaceId])) {
                        throw new Exception("Undefine Interface");
                    }
                    $interface = $interfaces[$interfaceId];
                    $interface->setQuality($p);
                } elseif ($action == "setSuspend") {
                    $p = $variables;
                    $nodeId = get($p["node_id"], "");
                    if ($nodeId === "") {
                        throw new Exception("No node defined");
                    }
                    $interfaceId = get($p["interface_id"], "");
                    if ($interfaceId === "") {
                        throw new Exception("No interface defined");
                    }
                    $nodes = $lab->getNodes();
                    if (!isset($nodes[$nodeId])) {
                        throw new Exception("Undefine node");
                    }
                    $node = $nodes[$nodeId];
                    $interfaces = $node->getInterfaces();
                    if (!isset($interfaces[$interfaceId])) {
                        throw new Exception("Undefine Interface");
                    }
                    $interface = $interfaces[$interfaceId];
                    $interface->setSuspendStatus(get($p["status"], "0"));
                    $lab->save();
                } elseif ($action == "setSuspendtwo_way") {
                    $p = $variables;
                    $nodeId = get($p["node_id"], "");
                    if ($nodeId === "") {
                        throw new Exception("No node defined");
                    }
                    $interfaceId = get($p["interface_id"], "");
                    if ($interfaceId === "") {
                        throw new Exception("No interface defined");
                    }
                    $nodes = $lab->getNodes();
                    if (!isset($nodes[$nodeId])) {
                        throw new Exception("Undefine node");
                    }
                    $node = $nodes[$nodeId];
                    $interfaces = $node->getInterfaces();
                    if (!isset($interfaces[$interfaceId])) {
                        throw new Exception("Undefine Interface");
                    }
                    $interface = $interfaces[$interfaceId];
                    $network_id = $interface->getNetworkId();
                    if ($network_id === "") {
                        throw new Exception("No interface defined");
                    }
                    if ($network_id != "") {
                        $network = $lab->getNetworks()[$network_id];
                    }
                    foreach ($lab->getNodes() as $node_id => $node) {
                        foreach (
                            $node->getInterfaces()
                            as $interface_id => $interface_all
                        ) {
                            if ($interface_all->getNetworkId() == $network_id) {
                                if ($network->getVisibility() == "0") {
                                    $interface_all->setSuspendStatus(
                                        get($p["status"], "0")
                                    );
                                } else {
                                    $interface->setSuspendStatus(
                                        get($p["status"], "0")
                                    );
                                }
                            }
                        }
                    }

                    $lab->save();
                }
                $data = apiGetLabNodes($lab, $user["html5"]);
                if ($data["status"] == "success") {
                    $data = $data["data"];
                    $output["update"] = ["nodes" => $data];
                }

                break;

            case "textobjects":
                if ($action == "edit") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    if (isset($variables["id"])) {
                        $output = apiEditLabTextObject($lab, $variables);
                    } elseif (isset($variables["data"])) {
                        $output = apiEditLabTextObjects(
                            $lab,
                            $variables["data"]
                        );
                    } else {
                        throw new Exception("No data");
                    }
                } elseif ($action == "add") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $output = apiAddLabTextObject($lab, $variables, false);
                } elseif ($action == "delete") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    if (isset($variables["id"])) {
                        $output = apiDeleteLabTextObject(
                            $lab,
                            $variables["id"]
                        );
                    }
                }

                $data = apiGetLabTextObjects($lab);
                if ($data["status"] == "success") {
                    $data = $data["data"];
                    $output["update"] = ["textobjects" => $data];
                }

                break;

            case "pictures":
                if ($action == "edit") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    if (isset($variables["id"])) {
                        $output = apiEditLabPicture($lab, $variables);
                    }
                } elseif ($action == "add") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $p = $_POST;
                    if (!empty($_FILES)) {
                        foreach ($_FILES as $file) {
                            if (file_exists($file["tmp_name"])) {
                                $fp = fopen($file["tmp_name"], "r");
                                $size = filesize($file["tmp_name"]);
                                if ($fp !== false) {
                                    $finfo = new finfo(FILEINFO_MIME);
                                    $p["data"] = fread($fp, $size);
                                    $p["type"] = $finfo->buffer(
                                        $p["data"],
                                        FILEINFO_MIME_TYPE
                                    );
                                }
                            }
                        }
                    }

                    $output = apiAddLabPicture($lab, $p);
                } elseif ($action == "delete") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    if (isset($variables["id"])) {
                        $output = apiDeleteLabPicture($lab, $variables["id"]);
                    }
                }
                break;

            case "line":
                $p = $variables;
                if ($action == "add") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    if (!isset($p["data"])) {
                        throw new Exception("No line data");
                    }
                    $lineData = $p["data"];
                    $id = $lineData["id"];
                    $lines = $lab->getLineObjects();
                    $lines[$id] = $lineData;
                    $rc = $lab->setLineObjects($lines);
                    if ($rc !== 0) {
                        throw new Exception($rc);
                    }
                } elseif ($action == "edit") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    if (!isset($p["data"])) {
                        throw new Exception("No line data");
                    }
                    $lineData = $p["data"];
                    $id = $lineData["id"];
                    $lines = $lab->getLineObjects();
                    if (!isset($lines[$id])) {
                        throw new Exception("Line not found");
                    }
                    foreach ($lineData as $key => $value) {
                        $lines[$id][$key] = $value;
                    }
                    $rc = $lab->setLineObjects($lines);
                    if ($rc !== 0) {
                        throw new Exception($rc);
                    }
                } elseif ($action == "delete") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    if (!isset($p["id"])) {
                        throw new Exception("No line data");
                    }
                    $lines = $lab->getLineObjects();
                    unset($lines[$p["id"]]);
                    $rc = $lab->setLineObjects($lines);
                    if ($rc !== 0) {
                        throw new Exception($rc);
                    }
                } elseif ($action == "position") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $lines = $lab->getLineObjects();
                    if (!isset($p["data"])) {
                        throw new Exception("No data");
                    }
                    foreach ($p["data"] as $position) {
                        if (isset($lines[$position["id"]])) {
                            if (isset($position["x1"])) {
                                $lines[$position["id"]]["x1"] = $position["x1"];
                            }
                            if (isset($position["x2"])) {
                                $lines[$position["id"]]["x2"] = $position["x2"];
                            }
                            if (isset($position["y1"])) {
                                $lines[$position["id"]]["y1"] = $position["y1"];
                            }
                            if (isset($position["y2"])) {
                                $lines[$position["id"]]["y2"] = $position["y2"];
                            }
                        }
                    }

                    $rc = $lab->setLineObjects($lines);
                    if ($rc !== 0) {
                        throw new Exception($rc);
                    }
                }

                $output["update"] = ["lines" => $lab->getLineObjects()];

                break;

            case "workbook":
                $p = $variables;
                if ($action == "add") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $name = get($p["name"], null);
                    $type = get($p["type"], null);

                    if ($type != "pdf" && $type != "html") {
                        throw new Exception("Unvalid workbook type");
                    }
                    if ($name == "") {
                        throw new Exception("Unvalid workbook name");
                    }

                    $lab->addWorkbook($name, $type);
                } elseif ($action == "delete") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $name = get($p["name"], null);

                    if ($name == "") {
                        throw new Exception("Unvalid workbook name");
                    }
                    $lab->delWorkbook($name);
                } elseif ($action == "edit") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $name = get($p["name"], null);
                    $new_name = get($p["new_name"], null);

                    if ($name == "") {
                        throw new Exception("Unvalid workbook name");
                    }

                    if (!preg_match('/^[A-Za-z0-9\s\_]+$/', $new_name)) {
                        throw new Exception("Unvalid workbook name");
                    }

                    $lab->editWorkbook($name, $new_name);
                } elseif ($action == "order") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);

                    $src_name = get($p["src_name"], null);
                    $dest_name = get($p["dest_name"], null);

                    if (!preg_match('/^[A-Za-z0-9\s\_]+$/', $src_name)) {
                        throw new Exception("Unvalid workbook name");
                    }

                    if (!preg_match('/^[A-Za-z0-9\s\_]+$/', $dest_name)) {
                        throw new Exception("Unvalid workbook name");
                    }

                    $lab->changeOrder($src_name, $dest_name);
                } elseif ($action == "update") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);

                    $content = get($p["content"], null);
                    if (!isset($content)) {
                        throw new Exception("No content");
                    }
                    $name = get($p["name"], null);
                    if ($name == "") {
                        throw new Exception("Unvalid workbook name");
                    }

                    $menu = get($p["menu"], []);
                    $menu = array_map(function ($item) {
                        return (object) $item;
                    }, $menu);

                    $lab->updateContent($name, $content, $menu);
                }

                break;

            case "tasks":
                $p = is_array($variables) ? $variables : [];
                checkLabPermission($lab, USER_PER_EDIT_TASKS);
                checkLockLab($lab);

                $validateTaskTitleLookup = function ($title) {
                    if (!is_string($title)) {
                        throw new Exception("Invalid task title");
                    }
                    if ($title === "" || preg_match('//u', $title) !== 1) {
                        throw new Exception("Invalid task title");
                    }
                    $length = function_exists("mb_strlen")
                        ? mb_strlen($title, "UTF-8")
                        : preg_match_all('/./us', $title, $unused);
                    if ($length < 1 || $length > 160) {
                        throw new Exception("Invalid task title");
                    }
                    return $title;
                };

                $validateTaskTitleCreate = function ($title) {
                    if (!is_string($title)) {
                        throw new Exception("Invalid task title");
                    }
                    $length = function_exists("mb_strlen")
                        ? mb_strlen($title, "UTF-8")
                        : preg_match_all('/./us', $title, $unused);
                    if (
                        $length < 1 ||
                        $length > 160 ||
                        !preg_match('/^[\p{L}\p{N}\s_.,:;\'"()&\/-]+$/u', $title) ||
                        !preg_match('/[^\s]/u', $title)
                    ) {
                        throw new Exception("Invalid task title");
                    }
                    return $title;
                };

                if ($action == "add") {
                    $name = $validateTaskTitleCreate(get($p["name"], null));
                    if (count($lab->getTasks()) >= 50) {
                        throw new Exception("A lab can contain no more than 50 tasks");
                    }
                    $lab->addTask($name);
                } elseif ($action == "delete") {
                    $name = $validateTaskTitleLookup(get($p["name"], null));
                    $lab->delTask($name);
                } elseif ($action == "edit") {
                    $name = $validateTaskTitleLookup(get($p["name"], null));
                    $new_name = $validateTaskTitleCreate(get($p["new_name"], null));
                    $lab->renameTask($name, $new_name);
                } elseif ($action == "order") {
                    $src_name = $validateTaskTitleLookup(get($p["src_name"], null));
                    $dest_name = $validateTaskTitleLookup(get($p["dest_name"], null));
                    // Confirm both names are task identities before invoking the
                    // deliberately generic legacy changeOrder() implementation.
                    $lab->getTasks($src_name);
                    $lab->getTasks($dest_name);
                    $lab->changeOrder($src_name, $dest_name);
                } elseif ($action == "update") {
                    $name = $validateTaskTitleLookup(get($p["name"], null));
                    $content = get($p["content"], null);
                    if (!is_string($content)) {
                        throw new Exception("No content");
                    }
                    $html = sanitizeTaskHtml($content);
                    $lab->updateTaskContent($name, $html);
                    $output["message"] = [
                        "id" => $name,
                        "html" => $html,
                    ];
                } else {
                    throw new Exception("Unknown tasks action");
                }
                break;

            case "wireshark":
                // Reachability gate: this action block (add/capture/delete/focus/
                // wifiview) launches/tears down capture containers and had NO
                // permission check, unlike every surrounding case. Require edit
                // rights so a mere lab viewer cannot drive the capture lane.
                checkLabPermission($lab, USER_PER_EDIT_LAB);
                $p = $variables;
                if ($action == "add") {
                    $interface_id = get($p["interface_id"], "");
                    $node_id = get($p["node_id"], "");
                    if ($node_id === "") {
                        throw new Exception("No node defined");
                    }
                    addWireshark($lab, $node_id, $interface_id);
                } elseif ($action == "capture") {
                    $interface_id = get($p["interface_id"], "");
                    $node_id = get($p["node_id"], "");
                    $node = $lab->getNodes()[$node_id];
                    if (!$node) {
                        throw new Exception("Undefine node");
                    }
                    $template = $node->getTemplate();

                    // html5 capture uses the pnet-capture-web image (live web packet
                    // UI + .pcap download), rendered via the http console reverse-proxy
                    // (functions.php addWiresharkSystem creates the per-capture container
                    // from it). Verify it is present — Stage 6: read-only broker
                    // listing evaluated as DATA here (no :4243 dial from www-data).
                    $imgs = broker_docker_image_ls('refs');
                    $checkExistLog = "";
                    foreach ($imgs['out'] as $imgRef) {
                        if (strpos($imgRef, 'pnet-capture-web:') === 0) {
                            $checkExistLog = $imgRef;
                            break;
                        }
                    }
                    if ($checkExistLog == "") {
                        throw new Exception(
                            "Capture image not found. Pull it (as root): docker pull rspnet/pnet-capture-web:latest && docker tag rspnet/pnet-capture-web:latest pnet-capture-web:1.0 (or docker load the local docker-store tarball for an airgapped box)."
                        );
                    }
                    if ($template == "mikrotik") {
                        foreach (
                            $node->getEthernets()
                            as $interface_idd => $interface
                        ) {
                            if ($interface_id == $interface_idd) {
                                $name_interface = $interface->getName();
                            }
                        }
                        if ($name_interface === "winbox") {
                            $output = addWinboxSystem(
                                $lab,
                                $node_id,
                                $interface_id
                            );
                        } else {
                            $output = addWiresharkSystem(
                                $lab,
                                $node_id,
                                $interface_id
                            );
                        }
                    } else {
                        $output = addWiresharkSystem(
                            $lab,
                            $node_id,
                            $interface_id
                        );
                    }
                } elseif ($action == "delete") {
					$interface_id = get($p['interface_id'], '');
					$node_id = get($p['node_id'], '');
					if ($interface_id === '' || $node_id === '') throw new Exception('Missing data');

					deleteWireshark($lab, $node_id, $interface_id);
                } elseif ($action == "focus") {
					$interface_id = get($p['interface_id'], '');
					$node_id = get($p['node_id'], '');
					if ($interface_id === '' || $node_id === '') throw new Exception('Missing data');

					$output = focusWiresharkWindow($lab, $node_id, $interface_id);
                } elseif ($action == "wifiview") {
                    // Open a Wi-Fi (802.11) session pcap in the pnet-capture-web viewer
                    // (file mode). medium = airduct (cvap/cwificlient) | vwifi
                    // (wifiap/wifista). Session-scoped + path-jailed inside the helper.
                    $medium = get($p['medium'], 'airduct');
                    $output = addWifiCaptureWeb($lab, $medium === 'vwifi' ? 'vwifi' : 'airduct');
                }
                break;

            case "multi_cfg":
                if ($action == "add") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $name = get($variables["name"], "");
                    if ($name == "") {
                        throw new Exception("Unvalid Name");
                    }
                    $nodes = $lab->getNodes();
                    foreach ($nodes as $node_id => $node) {
                        $node->addMultiCfg($node->getConfigData(), $name);
                    }
                    $lab->save();
                    $output["message"] = "Add Start-up Config successfully.";
                    // }
                } elseif ($action == "active") {
                    $name = get($variables["name"], "");
                    $lab->setMulti_config_active($name);
                    $lab->save();
                    $output["message"] =
                        "Set Start-up Config successfully. Wiped all Nodes for effecting";

                    $data = apiGetLab($lab);
                    if ($data["status"] == "success") {
                        $data = $data["data"];
                        $output["update"] = ["labinfo" => $data];
                    }
                } elseif ($action == "delete") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $name = get($variables["name"], "");
                    if ($name == "") {
                        throw new Exception("Unvalid Name");
                    }

                    $active_cfg = $lab->getMulti_config_active();

                    if ($name == $active_cfg) {
                        $output["status"] = "fail";
                        $output["message"] =
                            "ERROR! " .
                            $name .
                            " is using as Start-up Config of this lab. Please change to another Start-up Config first";
                    } else {
                        $nodes = $lab->getNodes();
                        foreach ($nodes as $node) {
                            $node->delMultiCfg($name);
                        }
                        $lab->save();
                        $output["status"] = "success";
                        $output["message"] = "Delete successfully";
                    }
                } elseif ($action == "rename") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $new_name = get($variables["new_name"], "");
                    $old_name = get($variables["old_name"], "");
                    if ($new_name == "" || $old_name == "") {
                        throw new Exception("Unvalid Name");
                    }

                    $nodes = $lab->getNodes();
                    foreach ($nodes as $node) {
                        $node->renameMultiCfg($old_name, $new_name);
                    }

                    $active_cfg = $lab->getMulti_config_active();
                    if ($old_name == $active_cfg) {
                        $lab->setMulti_config_active($new_name);
                    }

                    $lab->save();
                    $output["code"] = 200;
                    $output["status"] = "success";
                    $output["message"] = "Edit successfully";
                } elseif ($action == "edit") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $name = get($variables["name"], "");
                    $config = get($variables["config"], "");

                    $nodeId = get($variables["node_id"], "");
                    if ($nodeId === "") {
                        throw new Exception("No node defined");
                    }

                    $nodes = $lab->getNodes();
                    if (!isset($nodes[$nodeId])) {
                        throw new Exception("Undefine node");
                    }
                    $node = $nodes[$nodeId];

                    if ($name == "") {
                        $node->setConfigData($config);
                    } else {
                        $node->editMultiCfg($config, $name);
                    }

                    $lab->save();
                    $output["message"] = "Import Start-up Config successfully";
                } elseif ($action == "import") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $name = $variables["import_name"];
                    $configs = $variables["import_config"];
                    if ($name == "") {
                        throw new Exception("Unvalid Name");
                    }

                    $nodes = $lab->getNodes();
                    foreach ($nodes as $node) {
                        $nodeId = $node->getId();
                        if (isset($configs[$nodeId])) {
                            $node->addMultiCfg($configs[$nodeId], $name);
                        } else {
                            $node->addMultiCfg("", $name);
                        }
                    }
                    $lab->save();
                    $output["message"] = "Import Start-up Config successfully";
                } elseif ($action == "export") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $name = $variables["export_name"];
                    $nodes = $lab->getNodes();
                    $configs = [];
                    if ($name == "") {
                        foreach ($nodes as $node) {
                            $nodeId = $node->getId();
                            $configs[$nodeId] = $node->getConfigData();
                        }
                    } else {
                        foreach ($nodes as $node) {
                            $nodeId = $node->getId();
                            $configs[$nodeId] = $node->getMultiCfg($name);
                        }
                    }

                    $output["code"] = 200;
                    $output["status"] = "success";
                    $output["message"] = $configs;
                }

                break;

            case "background":
                if ($action == "edit") {
                    checkLabPermission($lab, USER_PER_EDIT_LAB);
                    checkLockLab($lab);
                    $darkmode = get($variables["darkmode"], 0);
                    $mode3d = get($variables["mode3d"], 0);
                    $nogrid = get($variables["nogrid"], 0);
                    $lab->setBackground($darkmode, $mode3d, $nogrid);
                }
                break;
        }

        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        unlockFile($labFile);
        unLockSession($session);
        return;
    } catch (ResponseException $e) {
        unlockFile($labFile);
        unLockSession($session);
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        unlockFile($labFile);
        unLockSession($session);
        $output["code"] = $e instanceof LabValidationException ? $e->getHttpStatus() : 400;
        $output["status"] = "fail";
        $output["message"] = isset($GLOBALS["messages"][$e->getMessage()])
            ? $GLOBALS["messages"][$e->getMessage()] : $e->getMessage();
        $output["error_code"] = $e->getCode();
        if ($e instanceof LabValidationException && $e->getDetails() !== null) {
            $output["data"] = $e->getDetails();
        }
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

// Export labs
$app->post("/api/export", function () use ($app) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
    try {
        checkPermission(USER_PER_EXPORT_LAB);
        $event = json_decode($app->request()->getBody());
        $p = json_decode(json_encode($event), true);

        $output = apiExportLabs($p);
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

// Import labs
$app->post("/api/import", function () use ($app) {
    $indent = new \indentify();
    list($user, $tenant, $output) = $indent->authorization(
        $app->getCookie("token")
    );
    if ($user === false) {
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }

    try {
        checkPermission(USER_PER_IMPORT_LAB);
        $p = $_POST;
        if (!empty($_FILES)) {
            foreach ($_FILES as $file) {
                $p["name"] = $file["name"];
                $p["file"] = $file["tmp_name"];
                $p["error"] = $file["name"];
            }
        }
        $output = apiImportLabs($p);
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
    } catch (ResponseException $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = $e->getMessage();
        $output["error_code"] = $e->getCode();
        $output["data"] = $e->getData();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    } catch (Exception $e) {
        $output["code"] = 400;
        $output["status"] = "fail";
        $output["message"] = get(
            $GLOBALS["messages"][$e->getMessage()],
            $e->getMessage()
        );
        $output["error_code"] = $e->getCode();
        $app->response->setStatus($output["code"]);
        $app->response->setBody(json_encode($output));
        return;
    }
});

$app->get("/api/icons", function () use ($app) {
    $arr = listNodeIcons();
    $app->response->setStatus(200);
    $app->response->setBody(json_encode($arr));
});

$app->get("/api/workbook/pdf/(:name)", function ($name = "") use ($app) {
    if (session_status() == PHP_SESSION_NONE) {
        session_start();
    }
    if (isset($_SESSION[$name])) {
        $app->response->headers->set("Content-Type", "application/pdf");
        $app->response->setBody($_SESSION[$name]);
    }
    return;
});

/***************************************************************************
 * Run
 **************************************************************************/
// --- PNetLab jammy port: plaintext offline login (replaces Laravel store login) ---
$app->post("/api/auth", function () use ($app) {
    $body = json_decode($app->request->getBody(), true);
    $username = isset($body["username"]) ? trim($body["username"]) : "";
    $password = isset($body["password"]) ? $body["password"] : "";
    $db = checkDatabase();
    $out = array("code"=>401,"status"=>"unauthorized","message"=>"Invalid credentials (90002).");

    // Brute-force containment: this endpoint had no counter, no delay and no
    // lockout, so credentials could be guessed at request rate. Per-IP only,
    // self-clearing in minutes; see authThrottle* in functions.php for the
    // documented reset (rm -rf /dev/shm/pnet-authfail).
    $clientIp = isset($_SERVER["REMOTE_ADDR"]) ? $_SERVER["REMOTE_ADDR"] : "?";
    $retryAfter = authThrottleRetryAfter($clientIp);
    if ($retryAfter > 0) {
        $app->response->headers->set("Retry-After", (string) $retryAfter);
        $app->response->setStatus(429);
        $app->response->setBody(json_encode(array(
            "code" => 429,
            "status" => "fail",
            "message" => "Too many failed login attempts. Try again in " . $retryAfter . " seconds (90007).",
        )));
        return;
    }

    if ($db !== false && $username !== "") {
        // Resilience: `ext_auth` is added by a migration (deb postinst /
        // Users-page ensure_ext_auth_col). If that migration never ran the
        // column is absent — but a missing OPTIONAL-feature column must NEVER
        // brick login. Try the full SELECT; on any failure retry without
        // ext_auth and treat it as absent (NULL => the local-hash path below).
        try {
            $st = $db->prepare("SELECT pod,username,password,role,user_status,active_time,expired_time,access_days,ext_auth FROM users WHERE username = :u");
            $st->bindParam(":u",$username,PDO::PARAM_STR);
            $selOk = $st->execute();
        } catch (PDOException $e) {
            $selOk = false;
        }
        if (!$selOk) {
            $st = $db->prepare("SELECT pod,username,password,role,user_status,active_time,expired_time,access_days FROM users WHERE username = :u");
            $st->bindParam(":u",$username,PDO::PARAM_STR); $st->execute();
        }
        $u = $st->fetch(PDO::FETCH_ASSOC);
        if ($u && !array_key_exists("ext_auth", $u)) { $u["ext_auth"] = null; }

        // Constant-ish time on the miss path: without this, "no such user"
        // returned before any hashing while "wrong password" paid for a
        // sha256 + hash_equals, so response timing enumerated valid usernames.
        // The dummy comparison keeps the miss path doing the same work.
        if (!$u) {
            hash_equals(str_repeat("0", 64), hash("sha256", $password));
        }

        // External authentication (RADIUS / LDAP): ONLY for existing rows the
        // admin explicitly flagged (users.ext_auth) AND only while the feature
        // is enabled in the broker-held config. Every other user — ext_auth
        // NULL — takes the unmodified local-hash path below, so the feature is
        // inert until an admin both flags a user and enables it.
        $extResult = null;   // broker verdict for a completed external attempt
        $extActive = false;
        if ($u && isset($u["ext_auth"])
            && ($u["ext_auth"] === "radius" || $u["ext_auth"] === "ldap")) {
            $extCfg = extauthSettings();
            $extActive = is_array($extCfg) && !empty($extCfg["enabled"]);
        }
        $authOk = false;
        if ($extActive) {
            $extResult = extauthVerify($username, $password, $u["ext_auth"]);
            if (!empty($extResult["ok"])) {
                $authOk = true;
            } elseif (isset($extResult["reason"]) && $extResult["reason"] === "unreachable") {
                // Directory down. fallback_local (default OFF) lets external
                // users authenticate against their stored local hash — an
                // explicit availability-over-strictness opt-in; every use is
                // loudly logged so a quiet downgrade is impossible.
                if (!empty($extCfg["fallback_local"]) && (string) $u["password"] !== "") {
                    error_log(date("M d H:i:s ") .
                        "WARNING: EXTERNAL-UNREACHABLE-LOCAL-FALLBACK " . $username .
                        " (directory unreachable; local password hash used)");
                    $authOk = hash_equals((string) $u["password"], hash("sha256", $password));
                } else {
                    // No fallback: fail closed WITHOUT counting a throttle
                    // strike (nothing was guessed — the directory never
                    // evaluated the password).
                    $app->response->setStatus(503);
                    $app->response->setBody(json_encode(array(
                        "code" => 503, "status" => "fail",
                        "message" => "External authentication unavailable (90020).",
                    )));
                    return;
                }
            }
            // "denied" falls through with $authOk === false -> 401 + throttle
            // (external denials count as guesses, same as local ones).
        } else {
            $authOk = $u && hash_equals((string) $u["password"], hash("sha256", $password));
        }

        if ($authOk) {
            // Containment is enforced HERE, not only on subsequent authenticated
            // requests: without this a disabled / not-yet-active / expired /
            // off-schedule account completed login and was handed a valid token,
            // and was refused only on its next call. Same helper as
            // getUserByCookie() so the two paths cannot drift.
            $violation = userContainmentViolation($u);
            if ($violation !== null) {
                list($reason, $detail) = $violation;
                switch ($reason) {
                    case "unactive":
                        $msg = "Account is not active until " . $detail . " (90003).";
                        break;
                    case "expired":
                        $msg = "Account expired on " . $detail . " (90004).";
                        break;
                    case "days":
                        $msg = "Lab access is not allowed today; your account is limited to scheduled days (90005).";
                        break;
                    default:
                        $msg = "Account is disabled (90006).";
                }
                $out = array("code"=>403,"status"=>"forbidden","message"=>$msg);
                $app->response->setStatus(403);
                $app->response->setBody(json_encode($out));
                return;
            }
            // Directory group -> role mapping (external logins only): the
            // directory is authoritative for the role at each login. Runs
            // AFTER containment, so a blocked/expired account cannot be
            // resurrected by a mapping, and can NEVER yield the built-in
            // admin role (hard denylist in extauthApplyMapping + broker).
            if ($extResult !== null && !empty($extResult["ok"])) {
                extauthApplyMapping($db, $u,
                    isset($extResult["groups"]) ? $extResult["groups"] : array());
            }
            // Credentials were correct and the account is permitted: forgive the
            // IP's accumulated failures (mirrors the MCP throttle's behaviour).
            authThrottleClear($clientIp);
            $token = bin2hex(random_bytes(20));
            updateUserCookie($db, $username, $token);
            // Harden the session cookie (security review 2026-07-06). The vendored
            // Slim 2.6 setCookie() defaults secure/httponly to false and has NO
            // SameSite support at all, leaving the token readable by any XSS, sent
            // over plaintext HTTP, and sent cross-site (CSRF). Set it natively with
            // HttpOnly + Secure + SameSite=Strict. The token is read via $_COOKIE
            // everywhere (not Slim's cookie jar), so native setcookie is compatible;
            // logout still clears it by name/path. Secure is safe here — the
            // appliance is served over HTTPS.
            setcookie("token", $token, [
                // Keep in lock-step with updateUserCookie()'s sliding renewal
                // (includes/functions.php::getSessionTimeoutSeconds()) — both
                // read the same admin-configurable idle-timeout override.
                "expires"  => time() + getSessionTimeoutSeconds(),
                "path"     => "/",
                "secure"   => true,
                "httponly" => true,
                "samesite" => "Strict",
            ]);
            // Login-time console-preference: the "Default Console" selector on the
            // login page sets the INITIAL users.html5 value (same column/semantics
            // as users/api.php's set_html5 self-service toggle). Only touch it when
            // the key is present so non-login callers of this endpoint are unaffected.
            if (array_key_exists("html5", $body)) {
                $html5 = ((string) $body["html5"] === "1") ? 1 : 0;
                $stH = $db->prepare("UPDATE users SET html5 = :v WHERE username = :username");
                $stH->bindParam(":v", $html5, PDO::PARAM_INT);
                $stH->bindParam(":username", $username, PDO::PARAM_STR);
                $stH->execute();
            }
            activity_log_event($db, $u, "session", "login", [
                "session_id" => activity_log_session_id($token),
            ]);
            $out = array("code"=>200,"status"=>"success","message"=>"User authenticated (90013).");
        }
    }
    // Anything that did not authenticate (bad password, unknown user, empty
    // username, DB down) counts against this IP. Containment refusals return
    // earlier and are deliberately NOT counted: those are a correct password
    // on a restricted account, not a guess.
    if ($out["code"] !== 200) {
        authThrottleFail($clientIp);
    }
    $app->response->setStatus($out["code"]);
    $app->response->setBody(json_encode($out));
});

$app->run();
