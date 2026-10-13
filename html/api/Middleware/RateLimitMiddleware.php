<?php
declare(strict_types=1);

namespace PNetLab\Middleware;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface as RequestHandler;
use Slim\Psr7\Response as SlimResponse;

/**
 * In-memory Token Bucket / Sliding Window Rate Limiting Middleware.
 * Critical foundation for preventing brute-force flag submissions and API abuse.
 */
final class RateLimitMiddleware implements MiddlewareInterface
{
    private int $maxRequests;
    private int $windowSeconds;
    private static array $hits = [];

    public function __construct(int $maxRequests = 60, int $windowSeconds = 60)
    {
        $this->maxRequests = $maxRequests;
        $this->windowSeconds = $windowSeconds;
    }

    public function process(Request $request, RequestHandler $handler): Response
    {
        $clientIp = $this->getClientIp($request);
        $currentTime = time();
        $key = md5($clientIp . '_' . $request->getUri()->getPath());

        // Clean expired timestamps
        if (!isset(self::$hits[$key])) {
            self::$hits[$key] = [];
        }
        self::$hits[$key] = array_filter(self::$hits[$key], fn(int $timestamp) => $timestamp > ($currentTime - $this->windowSeconds));

        // Check quota
        if (count(self::$hits[$key]) >= $this->maxRequests) {
            $retryAfter = $this->windowSeconds - ($currentTime - (reset(self::$hits[$key]) ?: $currentTime));
            $response = new SlimResponse(429);
            $payload = json_encode([
                'status' => 'error',
                'code' => 429,
                'message' => 'Too Many Requests: Rate limit exceeded',
                'retry_after' => max(1, $retryAfter)
            ], JSON_UNESCAPED_SLASHES);

            $response->getBody()->write((string) $payload);
            return $response
                ->withHeader('Content-Type', 'application/json')
                ->withHeader('Retry-After', (string) max(1, $retryAfter));
        }

        // Record current hit
        self::$hits[$key][] = $currentTime;

        $response = $handler->handle($request);
        return $response
            ->withHeader('X-RateLimit-Limit', (string) $this->maxRequests)
            ->withHeader('X-RateLimit-Remaining', (string) max(0, $this->maxRequests - count(self::$hits[$key])));
    }

    private function getClientIp(Request $request): string
    {
        $serverParams = $request->getServerParams();
        return $serverParams['HTTP_X_FORWARDED_FOR']
            ?? $serverParams['HTTP_CLIENT_IP']
            ?? $serverParams['REMOTE_ADDR']
            ?? '127.0.0.1';
    }
}
