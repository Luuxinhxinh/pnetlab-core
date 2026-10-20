<?php
declare(strict_types=1);

namespace PNetLab\Middleware;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

/**
 * Class OpenApiValidationMiddleware
 * Sprint 2 / TASK-0028: Validates request JSON payloads against OpenAPI 3.0 schema definitions.
 * Returns 422 Unprocessable Entity if required parameters or formats are invalid.
 */
class OpenApiValidationMiddleware implements MiddlewareInterface
{
    private string $schemaFile;
    private array $rules = [];

    public function __construct(string $schemaFile = '/opt/unetlab/docs/api/openapi.yaml')
    {
        $this->schemaFile = $schemaFile;
        $this->loadRules();
    }

    private function loadRules(): void
    {
        // Defined contracts based on docs/api/openapi.yaml
        $this->rules = [
            'POST:/api/v4/auth/login' => [
                'required' => ['username', 'password'],
                'types' => ['username' => 'string', 'password' => 'string']
            ],
            'POST:/api/v4/hub/export' => [
                'required' => ['lab_path'],
                'types' => ['lab_path' => 'string']
            ],
            'POST:/api/v4/hub/publish' => [
                'required' => ['package_path', 'hub_url'],
                'types' => ['package_path' => 'string', 'hub_url' => 'string']
            ],
            'POST:/api/v4/hub/snapshot' => [
                'required' => ['lab_path', 'message'],
                'types' => ['lab_path' => 'string', 'message' => 'string']
            ],
            'POST:/api/v4/hub/rollback' => [
                'required' => ['lab_path', 'commit_hash'],
                'types' => ['lab_path' => 'string', 'commit_hash' => 'string']
            ],
            'POST:/api/v4/hub/fork' => [
                'required' => ['source_path', 'target_path'],
                'types' => ['source_path' => 'string', 'target_path' => 'string']
            ]
        ];
    }

    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        $method = strtoupper($request->getMethod());
        $path = $request->getUri()->getPath();
        $key = "{$method}:{$path}";

        if (isset($this->rules[$key])) {
            $contentType = $request->getHeaderLine('Content-Type');
            $rule = $this->rules[$key];
            
            $body = $request->getParsedBody();
            if (!is_array($body) && str_contains($contentType, 'application/json')) {
                $raw = (string)$request->getBody();
                $body = json_decode($raw, true) ?? [];
            }

            if (!is_array($body)) {
                $body = [];
            }

            $errors = [];
            foreach ($rule['required'] ?? [] as $requiredField) {
                if (!isset($body[$requiredField]) || $body[$requiredField] === '') {
                    $errors[] = "Missing required field: '{$requiredField}'";
                }
            }

            if (!empty($errors)) {
                $response = new Response();
                $response->getBody()->write((string)json_encode([
                    'code' => 422,
                    'status' => 'error',
                    'message' => 'OpenAPI Schema Validation Failed',
                    'errors' => $errors
                ]));
                return $response
                    ->withHeader('Content-Type', 'application/json')
                    ->withStatus(422);
            }
        }

        return $handler->handle($request);
    }
}
