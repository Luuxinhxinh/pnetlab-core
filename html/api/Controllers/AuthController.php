<?php
declare(strict_types=1);

namespace PNetLab\Controllers;

use PDO;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Authentication Controller for Slim 4.
 * Replaces legacy anonymous routes for /api/auth.
 */
final class AuthController
{
    private PDO $db;

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    /**
     * POST /api/v4/auth/login
     */
    public function login(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        $username = trim((string) ($body['username'] ?? ''));
        $password = (string) ($body['password'] ?? '');

        if ($username === '' || $password === '') {
            return $this->json($response, 400, [
                'code' => 400,
                'status' => 'fail',
                'message' => 'Username and password are required',
            ]);
        }

        $stmt = $this->db->prepare('SELECT pod, username, password, role, user_status FROM users WHERE username = :u LIMIT 1');
        $stmt->execute([':u' => $username]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$user || !password_verify($password, (string) $user['password'])) {
            // Also support legacy MD5/sha fallback if existing PNetLab accounts
            $legacyValid = $user && (hash('sha256', $password) === $user['password'] || md5($password) === $user['password']);
            if (!$legacyValid) {
                return $this->json($response, 401, [
                    'code' => 401,
                    'status' => 'unauthorized',
                    'message' => 'Invalid credentials (90002)',
                ]);
            }
        }

        // Generate token session
        $token = bin2hex(random_bytes(32));
        $updateStmt = $this->db->prepare('UPDATE users SET cookie = :c, session = :s WHERE username = :u');
        $updateStmt->execute([
            ':c' => $token,
            ':s' => session_id() ?: $token,
            ':u' => $username,
        ]);

        return $this->json($response, 200, [
            'code' => 200,
            'status' => 'success',
            'message' => 'Login successful',
            'data' => [
                'token' => $token,
                'username' => $user['username'],
                'role' => $user['role'],
                'pod' => $user['pod'],
            ]
        ]);
    }

    /**
     * GET /api/v4/auth/status
     */
    public function status(Request $request, Response $response): Response
    {
        $userId = $request->getAttribute('user_id');
        $username = $request->getAttribute('username', 'admin');

        return $this->json($response, 200, [
            'code' => 200,
            'status' => 'success',
            'data' => [
                'authenticated' => true,
                'user_id' => $userId,
                'username' => $username,
            ]
        ]);
    }

    /**
     * POST /api/v4/auth/logout
     */
    public function logout(Request $request, Response $response): Response
    {
        $cookies = $request->getCookieParams();
        $token = $cookies['token'] ?? null;

        if ($token) {
            $stmt = $this->db->prepare('UPDATE users SET cookie = NULL, session = NULL WHERE cookie = :c');
            $stmt->execute([':c' => $token]);
        }

        return $this->json($response, 200, [
            'code' => 200,
            'status' => 'success',
            'message' => 'Logged out successfully',
        ]);
    }

    private function json(Response $response, int $status, array $payload): Response
    {
        $response->getBody()->write((string) json_encode($payload, JSON_UNESCAPED_SLASHES));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}
