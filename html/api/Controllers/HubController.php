<?php
declare(strict_types=1);

namespace PNetLab\Controllers;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;

/**
 * PNetLab Community Hub & Mini-Git Controller for Slim 4.
 * Handles lab packaging (.pnetlabz), snapshot commits, and community catalog.
 */
final class HubController
{
    private string $pythonBinary;
    private string $pluginPath;

    public function __construct(string $pythonBinary = '/usr/bin/python3', string $pluginPath = '/opt/unetlab/plugins/lab_hub')
    {
        $this->pythonBinary = $pythonBinary;
        $this->pluginPath = $pluginPath;
    }

    /**
     * GET /api/v4/hub/catalog
     * Fetch list of public community labs from Cloud Hub.
     */
    public function catalog(Request $request, Response $response): Response
    {
        $script = <<<PYTHON
import json, sys
sys.path.insert(0, '/opt/unetlab')
from plugins.lab_hub.backend.cloud_sync import CloudSyncEngine
print(json.dumps(CloudSyncEngine.fetch_catalog()))
PYTHON;

        $output = $this->execPython($script);
        $data = json_decode($output, true) ?: [];

        return $this->json($response, 200, [
            'code' => 200,
            'status' => 'success',
            'data' => $data,
        ]);
    }

    /**
     * POST /api/v4/hub/export
     * Pack current lab into a .pnetlabz archive.
     */
    public function export(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        $labPath = trim((string) ($body['path'] ?? ''));

        if ($labPath === '') {
            return $this->json($response, 400, ['code' => 400, 'status' => 'fail', 'message' => 'Lab path required']);
        }

        $script = <<<PYTHON
import json, sys
sys.path.insert(0, '/opt/unetlab')
from plugins.lab_hub.backend.packager import LabPackager
ok, path, sha = LabPackager.pack("{$labPath}")
print(json.dumps({"ok": ok, "path": path, "sha256": sha}))
PYTHON;

        $res = json_decode($this->execPython($script), true);

        if (!$res || empty($res['ok'])) {
            return $this->json($response, 500, ['code' => 500, 'status' => 'fail', 'message' => $res['path'] ?? 'Packaging failed']);
        }

        return $this->json($response, 200, [
            'code' => 200,
            'status' => 'success',
            'message' => 'Lab successfully packaged into .pnetlabz',
            'data' => [
                'archive_path' => $res['path'],
                'file_name' => basename($res['path']),
                'sha256' => $res['sha256'],
            ]
        ]);
    }

    /**
     * POST /api/v4/hub/publish
     * Share lab to community catalog with 1-click.
     */
    public function publish(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        $labPath = trim((string) ($body['path'] ?? ''));
        $title = trim((string) ($body['title'] ?? basename($labPath, '.unl')));
        $author = trim((string) ($body['author'] ?? 'Anonymous'));
        $description = trim((string) ($body['description'] ?? ''));

        if ($labPath === '') {
            return $this->json($response, 400, ['code' => 400, 'status' => 'fail', 'message' => 'Lab path required']);
        }

        $script = <<<PYTHON
import json, sys
sys.path.insert(0, '/opt/unetlab')
from plugins.lab_hub.backend.cloud_sync import CloudSyncEngine
ok, archive, entry = CloudSyncEngine.export_for_sharing("{$labPath}", "{$title}", "{$author}", "{$description}")
print(json.dumps({"ok": ok, "archive": archive, "entry": entry}))
PYTHON;

        $res = json_decode($this->execPython($script), true);

        if (!$res || empty($res['ok'])) {
            return $this->json($response, 500, ['code' => 500, 'status' => 'fail', 'message' => 'Failed to publish lab']);
        }

        return $this->json($response, 200, [
            'code' => 200,
            'status' => 'success',
            'message' => 'Lab successfully published to community Hub',
            'data' => $res['entry'],
        ]);
    }

    /**
     * POST /api/v4/hub/snapshot
     * Mini-Git: Save point-in-time snapshot.
     */
    public function createSnapshot(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        $labPath = trim((string) ($body['path'] ?? ''));
        $message = trim((string) ($body['message'] ?? 'Checkpoint'));
        $author = (string) $request->getAttribute('username', 'student');

        $script = <<<PYTHON
import json, sys
sys.path.insert(0, '/opt/unetlab')
from plugins.lab_hub.backend.version_control import LabVersionControl
ok, sid, meta = LabVersionControl.create_snapshot("{$labPath}", "{$message}", "{$author}")
print(json.dumps({"ok": ok, "snapshot_id": sid, "meta": meta}))
PYTHON;

        $res = json_decode($this->execPython($script), true);

        return $this->json($response, 200, [
            'code' => 200,
            'status' => 'success',
            'message' => 'Snapshot commit saved',
            'data' => $res['meta'] ?? [],
        ]);
    }

    /**
     * GET /api/v4/hub/history
     * Mini-Git: View commit history.
     */
    public function history(Request $request, Response $response): Response
    {
        $params = $request->getQueryParams();
        $labPath = trim((string) ($params['path'] ?? ''));

        $script = <<<PYTHON
import json, sys
sys.path.insert(0, '/opt/unetlab')
from plugins.lab_hub.backend.version_control import LabVersionControl
print(json.dumps(LabVersionControl.list_snapshots("{$labPath}")))
PYTHON;

        $res = json_decode($this->execPython($script), true) ?: [];

        return $this->json($response, 200, [
            'code' => 200,
            'status' => 'success',
            'data' => $res,
        ]);
    }

    /**
     * POST /api/v4/hub/rollback
     * Mini-Git: Rollback to previous snapshot.
     */
    public function rollback(Request $request, Response $response): Response
    {
        $body = (array) ($request->getParsedBody() ?? []);
        $labPath = trim((string) ($body['path'] ?? ''));
        $snapshotId = trim((string) ($body['snapshot_id'] ?? ''));

        $script = <<<PYTHON
import json, sys
sys.path.insert(0, '/opt/unetlab')
from plugins.lab_hub.backend.version_control import LabVersionControl
ok, msg = LabVersionControl.rollback_snapshot("{$labPath}", "{$snapshotId}")
print(json.dumps({"ok": ok, "msg": msg}))
PYTHON;

        $res = json_decode($this->execPython($script), true);

        return $this->json($response, !empty($res['ok']) ? 200 : 400, [
            'code' => !empty($res['ok']) ? 200 : 400,
            'status' => !empty($res['ok']) ? 'success' : 'fail',
            'message' => $res['msg'] ?? 'Rollback failed',
        ]);
    }

    private function execPython(string $code): string
    {
        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];
        $process = proc_open("{$this->pythonBinary} -", $descriptors, $pipes);
        if (is_resource($process)) {
            fwrite($pipes[0], $code);
            fclose($pipes[0]);
            $output = stream_get_contents($pipes[1]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);
            return trim((string) $output);
        }
        return '';
    }

    private function json(Response $response, int $status, array $payload): Response
    {
        $response->getBody()->write((string) json_encode($payload, JSON_UNESCAPED_SLASHES));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}
