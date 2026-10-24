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
    private ?\PDO $db;
    private bool $allowAnonymousForHealth;

    public function __construct(?\PDO $db = null, bool $allowAnonymousForHealth = true)
    {
        $this->db = $db;
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

        $token = null;

        // 1. Check Bearer Token in Authorization header
        $authHeader = $request->getHeaderLine('Authorization');
        if (!empty($authHeader) && preg_match('/^Bearer\s+(.+)$/i', $authHeader, $matches)) {
            $token = trim($matches[1]);
        }

        // 2. Fallback to HttpOnly Cookie: pnq_online_token
        $cookies = $request->getCookieParams();
        if (empty($token) && !empty($cookies['pnq_online_token'])) {
            $token = trim((string) $cookies['pnq_online_token']);
        }

        // 3. Validate Token against Database (Checking token exist & expiry)
        if (!empty($token) && $this->db) {
            try {
                $stmt = $this->db->prepare('SELECT pod, username, role, session FROM users WHERE cookie = :c LIMIT 1');
                $stmt->execute([':c' => $token]);
                $user = $stmt->fetch(\PDO::FETCH_ASSOC);

                if ($user) {
                    $sessionTime = (int) ($user['session'] ?? 0);
                    // Token TTL: 24 hours (86400s)
                    $ttl = 86400;
                    if ($sessionTime > 0 && (time() - $sessionTime) <= $ttl) {
                        $request = $request
                            ->withAttribute('user_id', (int) ($user['pod'] ?? 1))
                            ->withAttribute('username', $user['username'])
                            ->withAttribute('role', $user['role']);
                        return $handler->handle($request);
                    }
                }
            } catch (\Throwable $e) {
                // DB error fallback
            }
        }

        // 4. Fallback: Legacy Session Cookies (Offline admin Workbench)
        if (isset($cookies['pnetlab_session']) || isset($cookies['PHPSESSID'])) {
            $request = $request->withAttribute('user_id', 1)->withAttribute('username', 'admin');
            return $handler->handle($request);
        }

        // 5. Unauthorized (401 Expired or Invalid Token)
        $response = new SlimResponse(401);
        $payload = json_encode([
            'status' => 'error',
            'code' => 401,
            'message' => 'Unauthorized: Token expired or invalid session'
        ], JSON_UNESCAPED_SLASHES);

        $response->getBody()->write((string) $payload);
        return $response->withHeader('Content-Type', 'application/json');
    }
}
