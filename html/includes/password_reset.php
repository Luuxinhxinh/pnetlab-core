<?php
/** Secure, admin-initiated password-reset token lifecycle. */

require_once __DIR__ . '/smtp_mailer.php';

defined('PASSWORD_RESET_TTL_SECONDS') or define('PASSWORD_RESET_TTL_SECONDS', 48 * 3600);

defined('PASSWORD_RESET_WELCOME_SUBJECT_DEFAULT') or define('PASSWORD_RESET_WELCOME_SUBJECT_DEFAULT', 'Set your PNetLab password');
defined('PASSWORD_RESET_WELCOME_BODY_DEFAULT') or define('PASSWORD_RESET_WELCOME_BODY_DEFAULT',
    '<p>Hello {{username}},</p><p>An administrator created your PNetLab account.</p>' .
    '<p><a href="{{link}}">Set your password</a>. This single-use link expires in {{hours}} hours.</p>' .
    '<p>If you were not expecting this account, contact your administrator.</p>');
defined('PASSWORD_RESET_REQUEST_SUBJECT_DEFAULT') or define('PASSWORD_RESET_REQUEST_SUBJECT_DEFAULT', 'Reset your PNetLab password');
defined('PASSWORD_RESET_REQUEST_BODY_DEFAULT') or define('PASSWORD_RESET_REQUEST_BODY_DEFAULT',
    '<p>Hello {{username}},</p><p>An administrator requested a password reset for your PNetLab account.</p>' .
    '<p><a href="{{link}}">Choose a new password</a>. This single-use link expires in {{hours}} hours.</p>' .
    '<p>If you were not expecting this message, contact your administrator.</p>');
defined('PASSWORD_RESET_TEST_SUBJECT_DEFAULT') or define('PASSWORD_RESET_TEST_SUBJECT_DEFAULT', 'PNetLab SMTP test');
defined('PASSWORD_RESET_TEST_BODY_DEFAULT') or define('PASSWORD_RESET_TEST_BODY_DEFAULT',
    '<p>This is a test email from your PNetLab appliance.</p>');

function password_reset_validate_base_url($url)
{
    $url = trim((string) $url);
    if ($url === '' || preg_match('/[\r\n]/', $url) || filter_var($url, FILTER_VALIDATE_URL) === false) return false;
    $parts = parse_url($url);
    if (!is_array($parts) || strtolower((string) ($parts['scheme'] ?? '')) !== 'https' || empty($parts['host'])) return false;
    if (isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) return false;
    if (isset($parts['path']) && $parts['path'] !== '' && $parts['path'] !== '/') return false;
    return rtrim($url, '/');
}

function password_reset_public_base_url()
{
    return password_reset_validate_base_url(Ctrl_get(CTRL_SMTP_PUBLIC_URL, ''));
}

function password_reset_template($kind)
{
    if ($kind === 'welcome') {
        return [
            (string) Ctrl_get(CTRL_SMTP_WELCOME_SUBJECT, PASSWORD_RESET_WELCOME_SUBJECT_DEFAULT),
            (string) Ctrl_get(CTRL_SMTP_WELCOME_BODY, PASSWORD_RESET_WELCOME_BODY_DEFAULT),
        ];
    }
    if ($kind === 'request') {
        return [
            (string) Ctrl_get(CTRL_SMTP_REQUEST_SUBJECT, PASSWORD_RESET_REQUEST_SUBJECT_DEFAULT),
            (string) Ctrl_get(CTRL_SMTP_REQUEST_BODY, PASSWORD_RESET_REQUEST_BODY_DEFAULT),
        ];
    }
    if ($kind === 'test') {
        return [
            (string) Ctrl_get(CTRL_SMTP_TEST_SUBJECT, PASSWORD_RESET_TEST_SUBJECT_DEFAULT),
            (string) Ctrl_get(CTRL_SMTP_TEST_BODY, PASSWORD_RESET_TEST_BODY_DEFAULT),
        ];
    }
    throw new InvalidArgumentException('unknown mail template');
}

function password_reset_render($template, $username, $link, $hours, $html = true)
{
    if ($html) {
        $username = htmlspecialchars((string) $username, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $link = htmlspecialchars((string) $link, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        $hours = htmlspecialchars((string) $hours, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }
    return strtr((string) $template, [
        '{{username}}' => (string) $username,
        '{{link}}' => (string) $link,
        '{{hours}}' => (string) $hours,
    ]);
}

function password_reset_html_to_text($html)
{
    $html = preg_replace('/<\s*br\s*\/?>/i', "\n", (string) $html);
    $html = preg_replace('/<\/(p|div|h[1-6]|li)>/i', "\n", $html);
    return trim(html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
}

function password_reset_delivery_error($email)
{
    if (!smtp_valid_mailbox($email)) return 'the user does not have a valid email address';
    if (password_reset_public_base_url() === false) return 'configure the HTTPS Public appliance URL in Mail settings';
    $cfg = smtp_settings();
    if (!$cfg['enabled']) return 'SMTP is not enabled';
    if (!smtp_valid_host($cfg['host']) || !smtp_valid_mailbox($cfg['from_email'])) return 'SMTP settings are incomplete';
    if ($cfg['auth'] && ($cfg['username'] === '' || $cfg['password'] === '')) return 'SMTP credentials are incomplete';
    return null;
}

/** Caller owns the surrounding transaction. */
function password_reset_create_token($db, $pod)
{
    $now = time();
    $invalidate = $db->prepare('UPDATE password_resets SET used_at=:now WHERE pod=:pod AND used_at IS NULL');
    $invalidate->execute(['now' => $now, 'pod' => (int) $pod]);
    $token = bin2hex(random_bytes(32));
    $insert = $db->prepare('INSERT INTO password_resets (token_hash,pod,created_at,expires_at,used_at) VALUES (:hash,:pod,:created,:expires,NULL)');
    $insert->execute([
        'hash' => hash('sha256', $token),
        'pod' => (int) $pod,
        'created' => $now,
        'expires' => $now + PASSWORD_RESET_TTL_SECONDS,
    ]);
    return $token;
}

function password_reset_send_token($username, $email, $token, $kind)
{
    $deliveryError = password_reset_delivery_error($email);
    if ($deliveryError !== null) return [false, $deliveryError];
    $base = password_reset_public_base_url();
    // URL fragments are not sent in HTTP requests, access logs, or Referer
    // headers. The public page reads the token and submits it to the API.
    $link = $base . '/reset-password/#token=' . rawurlencode($token);
    $hours = (int) (PASSWORD_RESET_TTL_SECONDS / 3600);
    list($subjectTemplate, $bodyTemplate) = password_reset_template($kind);
    $subject = password_reset_render($subjectTemplate, $username, $link, $hours, false);
    $html = password_reset_render($bodyTemplate, $username, $link, $hours, true);
    return smtp_send_mail($email, $subject, $html, password_reset_html_to_text($html));
}

function password_reset_issue_and_send($db, $pod, $username, $email, $kind = 'request')
{
    $deliveryError = password_reset_delivery_error($email);
    if ($deliveryError !== null) return [false, $deliveryError];
    try {
        $db->beginTransaction();
        $token = password_reset_create_token($db, $pod);
        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
    return password_reset_send_token($username, $email, $token, $kind);
}

function password_reset_lookup($db, $token)
{
    $token = strtolower(trim((string) $token));
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) return [false, 'This reset link is invalid or has expired.'];
    $query = $db->prepare(
        'SELECT u.username FROM password_resets pr JOIN users u ON u.pod=pr.pod ' .
        'WHERE pr.token_hash=:hash AND pr.used_at IS NULL AND pr.expires_at>=:now LIMIT 1'
    );
    $query->execute(['hash' => hash('sha256', $token), 'now' => time()]);
    $username = $query->fetchColumn();
    return $username === false
        ? [false, 'This reset link is invalid or has expired.']
        : [true, (string) $username];
}

function password_reset_consume($db, $token, $newPassword)
{
    $token = strtolower(trim((string) $token));
    $newPassword = (string) $newPassword;
    if (!preg_match('/^[a-f0-9]{64}$/', $token)) return [false, 'This reset link is invalid or has expired.'];
    if (strlen($newPassword) < 8) return [false, 'Use at least 8 characters for the new password.'];
    if (strlen($newPassword) > 1024) return [false, 'The new password is too long.'];

    $now = time();
    try {
        $db->beginTransaction();
        $select = $db->prepare(
            'SELECT pr.id,pr.pod FROM password_resets pr JOIN users u ON u.pod=pr.pod ' .
            'WHERE pr.token_hash=:hash AND pr.used_at IS NULL AND pr.expires_at>=:now FOR UPDATE'
        );
        $select->execute(['hash' => hash('sha256', $token), 'now' => $now]);
        $row = $select->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            $db->rollBack();
            return [false, 'This reset link is invalid or has expired.'];
        }
        $consume = $db->prepare('UPDATE password_resets SET used_at=:now WHERE id=:id AND used_at IS NULL AND expires_at>=:now');
        $consume->execute(['now' => $now, 'id' => (int) $row['id']]);
        if ($consume->rowCount() !== 1) {
            $db->rollBack();
            return [false, 'This reset link has already been used.'];
        }
        $update = $db->prepare('UPDATE users SET password=:password,cookie=NULL,session=NULL WHERE pod=:pod');
        $update->execute(['password' => hash('sha256', $newPassword), 'pod' => (int) $row['pod']]);
        $invalidate = $db->prepare('UPDATE password_resets SET used_at=:now WHERE pod=:pod AND used_at IS NULL');
        $invalidate->execute(['now' => $now, 'pod' => (int) $row['pod']]);
        $db->commit();
        return [true, ''];
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
}
