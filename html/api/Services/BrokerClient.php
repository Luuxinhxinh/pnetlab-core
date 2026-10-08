<?php
declare(strict_types=1);

namespace PNetLab\Services;

/**
 * Native Unix Domain Socket client for PNetLab privilege broker.
 */
final class BrokerClient
{
    private string $socketPath;
    private int $timeout;

    public function __construct(string $socketPath = '/run/pnetlab/broker.sock', int $timeout = 60)
    {
        $this->socketPath = $socketPath;
        $this->timeout = $timeout;
    }

    /**
     * Call an allowlisted broker verb.
     *
     * @param string $verb Allowlisted verb name
     * @param array<string, mixed> $args Arguments payload
     * @return array{ok: bool, rc: int, out: list<string>, err: string}
     */
    public function call(string $verb, array $args = []): array
    {
        if (!file_exists($this->socketPath)) {
            return [
                'ok' => false,
                'rc' => 255,
                'out' => [],
                'err' => "Broker socket not found at {$this->socketPath}",
            ];
        }

        $fp = @stream_socket_client('unix://' . $this->socketPath, $errno, $errstr, (float) $this->timeout);
        if (!$fp) {
            return [
                'ok' => false,
                'rc' => $errno,
                'out' => [],
                'err' => "Connect error: {$errstr} ({$errno})",
            ];
        }

        stream_set_timeout($fp, $this->timeout);

        $payload = json_encode(['verb' => $verb, 'args' => $args], JSON_UNESCAPED_SLASHES);
        fwrite($fp, $payload . "\n");

        $buf = '';
        while (!feof($fp)) {
            $line = fgets($fp, 8192);
            if ($line === false) {
                break;
            }
            $buf .= $line;
            if (str_ends_with($line, "\n")) {
                break;
            }
        }
        fclose($fp);

        $decoded = json_decode(trim($buf), true);
        if (!is_array($decoded)) {
            return [
                'ok' => false,
                'rc' => 254,
                'out' => [],
                'err' => 'Malformed JSON response from broker',
            ];
        }

        return [
            'ok' => (bool) ($decoded['ok'] ?? false),
            'rc' => (int) ($decoded['rc'] ?? 1),
            'out' => (array) ($decoded['out'] ?? []),
            'err' => (string) ($decoded['err'] ?? ''),
        ];
    }
}
