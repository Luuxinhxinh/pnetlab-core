<?php
/**
 * Minimal SMTP client for appliance-generated mail.
 *
 * TLS certificates and hostnames are always verified.  SMTP commands and
 * RFC 5322 headers are built only from validated, single-line values, and
 * authentication failures never echo the AUTH payload back to callers.
 */

function smtp_settings()
{
    return [
        'enabled' => (string) Ctrl_get(CTRL_SMTP_ENABLED, '0') === '1',
        'host' => trim((string) Ctrl_get(CTRL_SMTP_HOST, '')),
        'port' => (int) Ctrl_get(CTRL_SMTP_PORT, '587'),
        'encryption' => strtolower((string) Ctrl_get(CTRL_SMTP_ENCRYPTION, 'tls')),
        'auth' => (string) Ctrl_get(CTRL_SMTP_AUTH, '1') === '1',
        'username' => (string) Ctrl_get(CTRL_SMTP_USERNAME, ''),
        'password' => (string) Ctrl_get(CTRL_SMTP_PASSWORD, ''),
        'from_email' => trim((string) Ctrl_get(CTRL_SMTP_FROM_EMAIL, '')),
        'from_name' => (string) Ctrl_get(CTRL_SMTP_FROM_NAME, 'PNetLab'),
        'public_url' => trim((string) Ctrl_get(CTRL_SMTP_PUBLIC_URL, '')),
    ];
}

function smtp_single_line($value, $label, $maxLength = 255)
{
    $value = trim((string) $value);
    if (preg_match('/[\r\n]/', $value)) {
        throw new InvalidArgumentException($label . ' must not contain line breaks');
    }
    if (strlen($value) > $maxLength) {
        throw new InvalidArgumentException($label . ' is too long');
    }
    return $value;
}

function smtp_valid_mailbox($value)
{
    try {
        $value = smtp_single_line($value, 'email address', 254);
    } catch (InvalidArgumentException $e) {
        return false;
    }
    return $value !== '' && filter_var($value, FILTER_VALIDATE_EMAIL) !== false;
}

function smtp_valid_host($host)
{
    try {
        $host = smtp_single_line($host, 'SMTP host', 253);
    } catch (InvalidArgumentException $e) {
        return false;
    }
    if ($host === '' || preg_match('/\s/', $host)) return false;
    if (filter_var($host, FILTER_VALIDATE_IP) !== false) return true;
    return preg_match('/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i', $host) === 1;
}

function smtp_encode_header($value)
{
    $value = smtp_single_line($value, 'mail header', 998);
    if ($value === '') return '';
    if (preg_match('/^[\x20-\x7e]+$/', $value)) return $value;
    return '=?UTF-8?B?' . base64_encode($value) . '?=';
}

function smtp_encode_phrase($value)
{
    $value = smtp_single_line($value, 'from name', 160);
    if ($value === '') return '';
    if (preg_match('/^[\x20-\x7e]+$/', $value)) {
        return '"' . str_replace(['\\', '"'], ['\\\\', '\\"'], $value) . '"';
    }
    return smtp_encode_header($value);
}

function smtp_read_reply($socket)
{
    $lines = [];
    $code = 0;
    for ($i = 0; $i < 50; $i++) {
        $line = fgets($socket, 4096);
        if ($line === false) break;
        $lines[] = rtrim($line, "\r\n");
        if (preg_match('/^(\d{3})([ -])/', $line, $match)) {
            $code = (int) $match[1];
            if ($match[2] === ' ') break;
        }
    }
    return [$code, implode(' ', $lines)];
}

function smtp_safe_reply($reply)
{
    $reply = preg_replace('/[\x00-\x1f\x7f]+/', ' ', (string) $reply);
    return substr(trim($reply), 0, 300);
}

function smtp_command($socket, $command, $expectedCodes, $phase, $sensitive = false)
{
    if (fwrite($socket, $command . "\r\n") === false) {
        return [false, 'SMTP connection closed during ' . $phase];
    }
    list($code, $reply) = smtp_read_reply($socket);
    if (!in_array($code, $expectedCodes, true)) {
        if ($sensitive) {
            return [false, 'SMTP authentication failed (server returned ' . $code . ')'];
        }
        $detail = smtp_safe_reply($reply);
        return [false, 'SMTP server rejected ' . $phase . ' (code ' . $code . ')' . ($detail !== '' ? ': ' . $detail : '')];
    }
    return [true, ''];
}

function smtp_normalize_body($body)
{
    $body = str_replace(["\r\n", "\r"], "\n", (string) $body);
    $body = str_replace("\n", "\r\n", $body);
    return preg_replace('/(?m)^\./', '..', $body);
}

/**
 * Send an HTML email with a text alternative. Returns [success, error].
 */
function smtp_send_mail($to, $subject, $htmlBody, $textBody)
{
    try {
        $to = smtp_single_line($to, 'recipient address', 254);
        $subject = smtp_single_line($subject, 'subject', 998);
    } catch (InvalidArgumentException $e) {
        return [false, $e->getMessage()];
    }
    if (!smtp_valid_mailbox($to)) return [false, 'recipient address is not valid'];

    $cfg = smtp_settings();
    if (!$cfg['enabled']) return [false, 'SMTP is not enabled'];
    if (!smtp_valid_host($cfg['host'])) return [false, 'SMTP host is not valid'];
    if ($cfg['port'] < 1 || $cfg['port'] > 65535) return [false, 'SMTP port is not valid'];
    if (!in_array($cfg['encryption'], ['none', 'ssl', 'tls'], true)) return [false, 'SMTP encryption mode is not valid'];
    if (!smtp_valid_mailbox($cfg['from_email'])) return [false, 'SMTP from address is not valid'];
    try {
        $fromName = smtp_single_line($cfg['from_name'], 'from name', 160);
    } catch (InvalidArgumentException $e) {
        return [false, $e->getMessage()];
    }
    if ($cfg['auth'] && ($cfg['username'] === '' || $cfg['password'] === '')) {
        return [false, 'SMTP authentication is enabled but its credentials are incomplete'];
    }

    $peerName = $cfg['host'];
    $connectHost = filter_var($peerName, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false
        ? '[' . $peerName . ']'
        : $peerName;
    $context = stream_context_create([
        'ssl' => [
            'verify_peer' => true,
            'verify_peer_name' => true,
            'allow_self_signed' => false,
            'peer_name' => $peerName,
            'SNI_enabled' => true,
            'disable_compression' => true,
        ],
    ]);
    $transport = $cfg['encryption'] === 'ssl' ? 'tls' : 'tcp';
    $socket = @stream_socket_client(
        $transport . '://' . $connectHost . ':' . $cfg['port'],
        $errno,
        $error,
        15,
        STREAM_CLIENT_CONNECT,
        $context
    );
    if ($socket === false) {
        return [false, 'Could not connect to the SMTP server' . ($errno ? ' (error ' . (int) $errno . ')' : '')];
    }
    stream_set_timeout($socket, 15);

    list($code, $banner) = smtp_read_reply($socket);
    if ($code !== 220) {
        fclose($socket);
        return [false, 'SMTP server did not present a valid banner'];
    }

    $ehloName = preg_replace('/[^A-Za-z0-9.-]/', '', (string) gethostname());
    if ($ehloName === '') $ehloName = 'pnetlab.local';
    list($ok, $err) = smtp_command($socket, 'EHLO ' . $ehloName, [250], 'EHLO');
    if (!$ok) { fclose($socket); return [false, $err]; }

    if ($cfg['encryption'] === 'tls') {
        list($ok, $err) = smtp_command($socket, 'STARTTLS', [220], 'STARTTLS');
        if (!$ok) { fclose($socket); return [false, $err]; }
        if (@stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT) !== true) {
            fclose($socket);
            return [false, 'SMTP TLS negotiation or certificate verification failed'];
        }
        list($ok, $err) = smtp_command($socket, 'EHLO ' . $ehloName, [250], 'post-TLS EHLO');
        if (!$ok) { fclose($socket); return [false, $err]; }
    }

    if ($cfg['auth']) {
        list($ok, $err) = smtp_command($socket, 'AUTH LOGIN', [334], 'authentication', true);
        if (!$ok) { fclose($socket); return [false, $err]; }
        list($ok, $err) = smtp_command($socket, base64_encode($cfg['username']), [334], 'authentication', true);
        if (!$ok) { fclose($socket); return [false, $err]; }
        list($ok, $err) = smtp_command($socket, base64_encode($cfg['password']), [235], 'authentication', true);
        if (!$ok) { fclose($socket); return [false, $err]; }
    }

    list($ok, $err) = smtp_command($socket, 'MAIL FROM:<' . $cfg['from_email'] . '>', [250], 'sender address');
    if (!$ok) { fclose($socket); return [false, $err]; }
    list($ok, $err) = smtp_command($socket, 'RCPT TO:<' . $to . '>', [250, 251], 'recipient address');
    if (!$ok) { fclose($socket); return [false, $err]; }
    list($ok, $err) = smtp_command($socket, 'DATA', [354], 'message data');
    if (!$ok) { fclose($socket); return [false, $err]; }

    $boundary = '=_pnetlab_' . bin2hex(random_bytes(12));
    $fromHeader = ($fromName !== '' ? smtp_encode_phrase($fromName) . ' ' : '') . '<' . $cfg['from_email'] . '>';
    $headers = [
        'Date: ' . date(DATE_RFC2822),
        'From: ' . $fromHeader,
        'To: <' . $to . '>',
        'Subject: ' . smtp_encode_header($subject),
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
    ];
    $message = '--' . $boundary . "\r\n"
        . "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
        . smtp_normalize_body($textBody) . "\r\n"
        . '--' . $boundary . "\r\n"
        . "Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"
        . smtp_normalize_body($htmlBody) . "\r\n"
        . '--' . $boundary . "--\r\n";
    $wire = implode("\r\n", $headers) . "\r\n\r\n" . $message . '.';
    list($ok, $err) = smtp_command($socket, $wire, [250], 'message body');
    smtp_command($socket, 'QUIT', [221, 0], 'QUIT');
    fclose($socket);
    return $ok ? [true, ''] : [false, $err];
}
