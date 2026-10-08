<?php
declare(strict_types=1);

namespace PNetLab\Controllers;

use PNetLab\Services\BrokerClient;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Controller managing Node operations (start, stop, wipe).
 */
final class NodeController
{
    private BrokerClient $broker;

    public function __construct(BrokerClient $broker)
    {
        $this->broker = $broker;
    }

    public function start(Request $request, Response $response, array $args): Response
    {
        $nodeId = (int) ($args['id'] ?? 0);
        $body = (array) $request->getParsedBody();
        $tenant = (int) ($body['tenant'] ?? 0);
        $session = (int) ($body['session'] ?? 0);
        $lab = (string) ($body['lab'] ?? '');

        $result = $this->broker->call('wrapper', [
            'action' => 'start',
            'tenant' => $tenant,
            'session' => $session,
            'node' => $nodeId,
            'lab' => $lab,
        ]);

        $payload = json_encode([
            'code' => $result['rc'] === 0 ? 200 : 400,
            'status' => $result['rc'] === 0 ? 'success' : 'fail',
            'data' => $result,
        ]);

        $response->getBody()->write((string) $payload);
        return $response->withHeader('Content-Type', 'application/json');
    }

    public function stop(Request $request, Response $response, array $args): Response
    {
        $nodeId = (int) ($args['id'] ?? 0);
        $body = (array) $request->getParsedBody();
        $tenant = (int) ($body['tenant'] ?? 0);
        $session = (int) ($body['session'] ?? 0);
        $lab = (string) ($body['lab'] ?? '');

        $result = $this->broker->call('wrapper', [
            'action' => 'stop',
            'tenant' => $tenant,
            'session' => $session,
            'node' => $nodeId,
            'lab' => $lab,
        ]);

        $payload = json_encode([
            'code' => $result['rc'] === 0 ? 200 : 400,
            'status' => $result['rc'] === 0 ? 'success' : 'fail',
            'data' => $result,
        ]);

        $response->getBody()->write((string) $payload);
        return $response->withHeader('Content-Type', 'application/json');
    }

    public function wipe(Request $request, Response $response, array $args): Response
    {
        $nodeId = (int) ($args['id'] ?? 0);
        $body = (array) $request->getParsedBody();
        $tenant = (int) ($body['tenant'] ?? 0);
        $session = (int) ($body['session'] ?? 0);
        $lab = (string) ($body['lab'] ?? '');

        $result = $this->broker->call('wrapper', [
            'action' => 'wipe',
            'tenant' => $tenant,
            'session' => $session,
            'node' => $nodeId,
            'lab' => $lab,
        ]);

        $payload = json_encode([
            'code' => $result['rc'] === 0 ? 200 : 400,
            'status' => $result['rc'] === 0 ? 'success' : 'fail',
            'data' => $result,
        ]);

        $response->getBody()->write((string) $payload);
        return $response->withHeader('Content-Type', 'application/json');
    }
}
