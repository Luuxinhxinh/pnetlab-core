<?php
declare(strict_types=1);

namespace PNetLab\Controllers;

use PNetLab\Services\BrokerClient;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Controller for system operations and diagnostic verbs.
 */
final class SystemController
{
    private BrokerClient $broker;

    public function __construct(BrokerClient $broker)
    {
        $this->broker = $broker;
    }

    public function status(Request $request, Response $response): Response
    {
        $platform = $this->broker->call('platform');
        $uuid = $this->broker->call('system_uuid');

        $payload = json_encode([
            'code' => 200,
            'status' => 'success',
            'data' => [
                'platform' => $platform['out'][0] ?? 'unknown',
                'uuid' => $uuid['out'][0] ?? 'unknown',
            ],
        ]);

        $response->getBody()->write((string) $payload);
        return $response->withHeader('Content-Type', 'application/json');
    }

    public function fixPermissions(Request $request, Response $response): Response
    {
        $res = $this->broker->call('fixpermissions');

        $payload = json_encode([
            'code' => $res['rc'] === 0 ? 200 : 500,
            'status' => $res['rc'] === 0 ? 'success' : 'fail',
            'data' => $res,
        ]);

        $response->getBody()->write((string) $payload);
        return $response->withHeader('Content-Type', 'application/json');
    }

    public function cleanupNetwork(Request $request, Response $response): Response
    {
        $res = $this->broker->call('netlink_cleanup');

        $payload = json_encode([
            'code' => $res['rc'] === 0 ? 200 : 500,
            'status' => $res['rc'] === 0 ? 'success' : 'fail',
            'data' => $res,
        ]);

        $response->getBody()->write((string) $payload);
        return $response->withHeader('Content-Type', 'application/json');
    }
}
