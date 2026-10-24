<?php
declare(strict_types=1);

namespace PNetLab\Middleware;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * Class Slim2CompatMiddleware
 * Sprint 2 / TASK-0020: Strangler Fig compatibility bridge adapter.
 * Wraps Slim 4 PSR-7 Request/Response while preserving backward-compatible headers,
 * cookies and session state expected by existing PNetLab legacy frontend modules.
 */
class Slim2CompatMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        // Extract token from Cookie or Bearer header for cross-compatibility
        $cookies = $request->getCookieParams();
        $token = $cookies['token'] ?? null;

        if (!$token) {
            $authHeader = $request->getHeaderLine('Authorization');
            if (str_starts_with($authHeader, 'Bearer ')) {
                $token = substr($authHeader, 7);
                $request = $request->withAttribute('token', $token);
            }
        } else {
            $request = $request->withAttribute('token', $token);
        }

        $response = $handler->handle($request);

        // Ensure legacy standard response headers are consistently provided
        return $response
            ->withHeader('X-Framework-Version', 'Slim-4.14-StranglerFig')
            ->withHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
            ->withHeader('Pragma', 'no-cache');
    }
}
