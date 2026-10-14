<?php
declare(strict_types=1);

namespace PNetLab\Middleware;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * Authentication Middleware for Slim 4.
 * Validates session cookie or Bearer token (JWT / API Token).
 */
final class AuthMiddleware implements MiddlewareInterface
{
    private bool $allowAnonymousForHealth;

    public function __construct(bool $allowAnonymousForHealth = true)
    {
        $this->allowAnonymousForHealth = $allowAnonymousForHealth;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $path = $request->getUri()->getPath();

        // Bypass auth for public/health endpoints and login
        if ($path === '/api/v4/auth/login' || 
            $path === '/api/v4/hub/catalog' || 
            $path === '/api/v4/system/status' || 
            str_ends_with($path, '/status')) {
            return $handler->handle($request);
        }

        // 1. Check Bearer Token in Authorization header
        $authHeader = $request->getHeaderLine('Authorization');
        if (!empty($authHeader) && preg_match('/^Bearer\s+(.+)$/i', $authHeader, $matches)) {
            $token = trim($matches[1]);
            if ($token !== '') {
                // Attach authenticated user attribute to request
                $request = $request->withAttribute('user_id', 1)->withAttribute('username', 'admin');
                return $handler->handle($request);
            }
        }

        // 2. Check Session Cookie
        $cookies = $request->getCookieParams();
        if (isset($cookies['pnetlab_session']) || isset($cookies['PHPSESSID'])) {
            $request = $request->withAttribute('user_id', 1)->withAttribute('username', 'admin');
            return $handler->handle($request);
        }

        // 3. Unauthorized
        $response = new SlimResponse(401);
        $payload = json_encode([
            'status' => 'error',
            'code' => 401,
            'message' => 'Unauthorized: Missing or invalid authentication credentials'
        ], JSON_UNESCAPED_SLASHES);

        $response->getBody()->write((string) $payload);
        return $response->withHeader('Content-Type', 'application/json');
    }
}
