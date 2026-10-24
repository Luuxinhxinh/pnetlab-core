<?php
declare(strict_types=1);

namespace PNetLab\Controllers;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * Folder Management Controller for Slim 4.
 * Replaces legacy anonymous routes for /api/folders.
 */
final class FolderController
{
    private string $labsRoot;

    public function __construct(string $labsRoot = '/opt/unetlab/labs')
    {
        $this->labsRoot = rtrim($labsRoot, '/');
    }

    /**
     * GET /api/v4/folders
     * List folders and lab files in given path.
     */
    public function list(Request $request, Response $response): Response
    {
        $params = $request->getQueryParams();
        $subPath = trim((string) ($params['path'] ?? ''), '/');
        
        // Prevent path traversal
        if (str_contains($subPath, '..')) {
            return $this->json($response, 400, [
                'code' => 400,
                'status' => 'fail',
                'message' => 'Invalid directory path'
            ]);
        }

        $targetDir = $this->labsRoot . ($subPath !== '' ? '/' . $subPath : '');
        if (!is_dir($targetDir)) {
            return $this->json($response, 404, [
                'code' => 404,
                'status' => 'fail',
                'message' => 'Folder not found'
            ]);
        }

        $folders = [];
        $labs = [];

        $items = scandir($targetDir) ?: [];
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $fullPath = $targetDir . '/' . $item;
            if (is_dir($fullPath)) {
                $folders[] = [
                    'name' => $item,
                    'path' => ($subPath !== '' ? $subPath . '/' : '') . $item,
                ];
            } elseif (str_ends_with($item, '.unl') || str_ends_with($item, '.zip')) {
                $labs[] = [
                    'file' => $item,
                    'path' => ($subPath !== '' ? $subPath . '/' : '') . $item,
                    'size' => filesize($fullPath),
                    'modified' => filemtime($fullPath),
                ];
            }
        }

        return $this->json($response, 200, [
            'code' => 200,
            'status' => 'success',
            'data' => [
                'current_path' => '/' . $subPath,
                'folders' => $folders,
                'labs' => $labs,
            ]
        ]);
    }

    private function json(Response $response, int $status, array $payload): Response
    {
        $response->getBody()->write((string) json_encode($payload, JSON_UNESCAPED_SLASHES));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}
