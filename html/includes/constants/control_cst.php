<?php
defined('CONTROL_TABLE') or define('CONTROL_TABLE', 'control');
defined('CONTROL_NAME') or define('CONTROL_NAME', 'control_name');
defined('CONTROL_VALUE') or define('CONTROL_VALUE', 'control_value');

defined('CTRL_LICENSE') or define('CTRL_LICENSE', 'ctrl_license');
defined('CTRL_USER') or define('CTRL_USER', 'ctrl_user');
defined('CTRL_ACTIVE') or define('CTRL_ACTIVE', 'ctrl_active'); // time user active update from browser
defined('CTRL_VERSION') or define('CTRL_VERSION', 'ctrl_version'); // verion name of box
defined('CTRL_CONSOLE') or define('CTRL_CONSOLE', 'ctrl_console'); // constole type
defined('CTRL_SHARED') or define('CTRL_SHARED', 'ctrl_shared'); // Shared folder. split by ,
defined('CTRL_SHARED_PERMISSION') or define('CTRL_SHARED_PERMISSION', 'ctrl_shared_permission'); // Shared folder. split by ,

defined('CTRL_ONLINE_MODE') or define('CTRL_ONLINE_MODE', 'ctrl_online_mode'); // online mode 0 or 1,
defined('CTRL_OFFLINE_MODE') or define('CTRL_OFFLINE_MODE', 'ctrl_offline_mode'); // offline mode 0 or 1,
defined('CTRL_DEFAULT_MODE') or define('CTRL_DEFAULT_MODE', 'ctrl_default_mode'); // default mode online or offline,
defined('CTRL_ALIVE_KEY') or define('CTRL_ALIVE_KEY', 'ctrl_alive_key'); // alive key for offline verion.
defined('CTRL_CAPTCHA') or define('CTRL_CAPTCHA', 'ctrl_captcha'); // offline captcha 0 or 1, default 1,
defined('CTRL_DOCKER_WIRESHARK') or define('CTRL_DOCKER_WIRESHARK', 'ctrl_docker_wireshark'); // docker wireshark 0 or 1, default 0,
defined('CTRL_DEFAULT_CONSOLE') or define('CTRL_DEFAULT_CONSOLE', 'ctrl_default_console'); // docker wireshark 0 or 1, default 0,
defined('CTRL_DEFAULT_LANG') or define('CTRL_DEFAULT_LANG', 'ctrl_default_lang'); // default language
defined('CTRL_DEFAULT_COLOR') or define('CTRL_DEFAULT_COLOR', 'ctrl_default_color'); // default language

// SMTP and password-reset delivery settings. Secrets are write-only in the
// admin API; reset links use the explicit HTTPS public URL rather than Host.
defined('CTRL_SMTP_ENABLED') or define('CTRL_SMTP_ENABLED', 'ctrl_smtp_enabled');
defined('CTRL_SMTP_HOST') or define('CTRL_SMTP_HOST', 'ctrl_smtp_host');
defined('CTRL_SMTP_PORT') or define('CTRL_SMTP_PORT', 'ctrl_smtp_port');
defined('CTRL_SMTP_ENCRYPTION') or define('CTRL_SMTP_ENCRYPTION', 'ctrl_smtp_encryption'); // none|ssl|tls (STARTTLS)
defined('CTRL_SMTP_AUTH') or define('CTRL_SMTP_AUTH', 'ctrl_smtp_auth');
defined('CTRL_SMTP_USERNAME') or define('CTRL_SMTP_USERNAME', 'ctrl_smtp_username');
defined('CTRL_SMTP_PASSWORD') or define('CTRL_SMTP_PASSWORD', 'ctrl_smtp_password');
defined('CTRL_SMTP_FROM_EMAIL') or define('CTRL_SMTP_FROM_EMAIL', 'ctrl_smtp_from_email');
defined('CTRL_SMTP_FROM_NAME') or define('CTRL_SMTP_FROM_NAME', 'ctrl_smtp_from_name');
defined('CTRL_SMTP_PUBLIC_URL') or define('CTRL_SMTP_PUBLIC_URL', 'ctrl_smtp_public_url');
defined('CTRL_SMTP_WELCOME_SUBJECT') or define('CTRL_SMTP_WELCOME_SUBJECT', 'ctrl_smtp_welcome_subject');
defined('CTRL_SMTP_WELCOME_BODY') or define('CTRL_SMTP_WELCOME_BODY', 'ctrl_smtp_welcome_body');
defined('CTRL_SMTP_REQUEST_SUBJECT') or define('CTRL_SMTP_REQUEST_SUBJECT', 'ctrl_smtp_request_subject');
defined('CTRL_SMTP_REQUEST_BODY') or define('CTRL_SMTP_REQUEST_BODY', 'ctrl_smtp_request_body');
defined('CTRL_SMTP_TEST_SUBJECT') or define('CTRL_SMTP_TEST_SUBJECT', 'ctrl_smtp_test_subject');
defined('CTRL_SMTP_TEST_BODY') or define('CTRL_SMTP_TEST_BODY', 'ctrl_smtp_test_body');

// Site-wide idle/session timeout in seconds. Read by getSessionTimeoutSeconds()
// (includes/functions.php) as an override for the SESSION constant's hardcoded
// default (includes/init.php: define("SESSION","3600")). Every authenticated
// request slides this window forward (indentify::authorization() ->
// updateUserCookie()), so it is a true idle timeout: a user sitting on a lab's
// console/login screen with no authenticated requests in flight is logged back
// out to the login screen once this many seconds elapse. Admin-editable from
// the System page (main/js/system.js) via status/api.php?action=idle_timeout.
defined('CTRL_SESSION_TIMEOUT') or define('CTRL_SESSION_TIMEOUT', 'ctrl_session_timeout');
