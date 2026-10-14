<?php
declare(strict_types=1);

namespace PNetLab\Controllers;

use PDO;
use PNetLab\Services\BrokerClient;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Lab Lifecycle & Topology Controller for Slim 4.
 * Replaces legacy anonymous routes for /api/labs.
 */
final class LabController
{
    private PDO $db;
    private BrokerClient $broker;
    private string $labsRoot;

    public function __construct(PDO $db, BrokerClient $broker, string $labsRoot = '/opt/unetlab/labs')
    {
        $this->db = $db;
        $this->broker = $broker;
        $this->labsRoot = rtrim($labsRoot, '/');
    }

    /**
     * GET /api/v4/labs/{path:.*}
     * Get lab details / XML topology info.
     */
    public function get(Request $request, Response $response, array $args): Response
    {
        $labPath = trim((string) ($args['path'] ?? ''), '/');
        if (str_contains($labPath, '..')) {
            return $this->json($response, 400, ['code' => 400, 'status' => 'fail', 'message' => 'Invalid lab path']);
        }

        $fullPath = $this->labsRoot . '/' . $labPath;
        if (!str_ends_with($fullPath, '.unl')) {
            $fullPath .= '.unl';
        }

        if (!file_exists($fullPath)) {
            return $this->json($response, 404, ['code' => 404, 'status' => 'fail', 'message' => 'Lab file not found']);
        }

        $xmlContent = file_get_contents($fullPath);
        if ($xmlContent === false) {
            return $this->json($response, 500, ['code' => 500, 'status' => 'fail', 'message' => 'Failed to read lab file']);
        }

        $xml = @simplexml_load_string($xmlContent);
        $labName = $xml ? (string) $xml['name'] : basename($fullPath, '.unl');
        $nodeCount = $xml && isset($xml->topology->nodes->node) ? count($xml->topology->nodes->node) : 0;

        return $this->json($response, 200, [
            'code' => 200,
            'status' => 'success',
            'data' => [
                'name' => $labName,
                'path' => $labPath,
                'nodes_count' => $nodeCount,
                'version' => $xml ? (string) $xml['version'] : '1',
            ]
        ]);
    }

    /**
     * POST /api/v4/labs/start-all
     */
    public function startAll(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        $labPath = (string) ($body['path'] ?? '');

        // Delegate execution safely to Python Broker Daemon
        $res = $this->broker->call('node_start_all', ['lab' => $labPath]);

        return $this->json($response, $res['ok'] ? 200 : 500, [
            'code' => $res['ok'] ? 200 : 500,
            'status' => $res['ok'] ? 'success' : 'fail',
            'message' => $res['ok'] ? 'Started all nodes' : ($res['err'] ?: 'Failed to start nodes'),
            'out' => $res['out'],
        ]);
    }

    /**
     * POST /api/v4/labs/stop-all
     */
    public function stopAll(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        $labPath = (string) ($body['path'] ?? '');

        $res = $this->broker->call('node_stop_all', ['lab' => $labPath]);

        return $this->json($response, $res['ok'] ? 200 : 500, [
            'code' => $res['ok'] ? 200 : 500,
            'status' => $res['ok'] ? 'success' : 'fail',
            'message' => $res['ok'] ? 'Stopped all nodes' : ($res['err'] ?: 'Failed to stop nodes'),
            'out' => $res['out'],
        ]);
    }

    private function json(Response $response, int $status, array $payload): Response
    {
        $response->getBody()->write((string) json_encode($payload, JSON_UNESCAPED_SLASHES));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}
