<?php
/**
 * pnq-roce.php — authenticated, active-lab RXE inventory and health API.
 *
 * GET
 *   Enumerates only nodes whose template is exactly "rxe". The stable vsock
 *   CID is derived from node session + node UUID; browser input never supplies it.
 *
 * POST {"action":"health","node_ids":[1]}
 *   Re-resolves that ID against the same inventory and calls the broker's
 *   fixed, bounded roce_agent_health verb. Clients poll nodes concurrently.
 */
chdir('/opt/unetlab/html');
require_once '/opt/unetlab/html/includes/init.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function roce_out($value, $code = 200)
{
    http_response_code($code);
    echo json_encode($value);
    exit;
}

function roce_cid($node_session, $uuid)
{
    $identity = (string) $node_session . ':' . (string) $uuid;
    return (crc32($identity) % 0x7fff0000) + 0x10000;
}

$indent = new \indentify();
list($user, $tenant, $autherr) = $indent->authorization(
    isset($_COOKIE['token']) ? $_COOKIE['token'] : ''
);
if ($user === false || empty($user)) {
    roce_out(['error' => 'not authenticated'], 401);
}

$session = isset($user['lab']) ? $user['lab'] : '';
if ($session === '') {
    roce_out(['error' => 'no lab session'], 400);
}
$labsession = getLabFromSession($session);
if (!$labsession) {
    roce_out(['error' => 'no lab session'], 400);
}

try {
    $lab = new Lab(BASE_LAB . $labsession['lab_session_path'], $tenant, $session);
} catch (Exception $e) {
    roce_out(['error' => 'cannot open lab'], 400);
}
$lab_session_id = intval($lab->getSession());
if ($lab_session_id <= 0) {
    roce_out(['error' => 'invalid lab session'], 400);
}

/* id => server-owned row. Never populate this from request data. */
$rxe_nodes = [];
$cid_owners = [];
foreach ($lab->getNodes() as $node_id => $node) {
    if ($node->getTemplate() !== 'rxe') {
        continue;
    }
    $options = [];
    try {
        $options = method_exists($node, 'getOptions') ? $node->getOptions() : [];
    } catch (Exception $e) {
        $options = [];
    }
    $uuid = isset($options['uuid']) ? trim((string) $options['uuid']) : '';
    $node_session_id = intval($node->getSession());
    $cid = ($uuid === '' || $node_session_id <= 0)
        ? null : roce_cid($node_session_id, $uuid);
    $id = intval($node_id);
    $row = [
        'id' => $id,
        'name' => (string) $node->getName(),
        'status' => intval($node->getStatus()),
        'node_session' => $node_session_id,
        'node_uuid' => $uuid,
        'control_cid' => $cid,
        'control_error' => $cid === null ? 'node runtime identity is missing' : null,
    ];
    $rxe_nodes[$id] = $row;
    if ($cid !== null) {
        if (!isset($cid_owners[$cid])) {
            $cid_owners[$cid] = [];
        }
        $cid_owners[$cid][] = $id;
    }
}
foreach ($cid_owners as $cid => $owners) {
    if (count($owners) < 2) {
        continue;
    }
    foreach ($owners as $id) {
        $rxe_nodes[$id]['control_error'] = 'derived vsock CID collides in this lab';
    }
}
ksort($rxe_nodes, SORT_NUMERIC);

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
if ($method === 'GET') {
    $public_nodes = [];
    foreach ($rxe_nodes as $node) {
        $public_nodes[] = [
            'id' => $node['id'],
            'name' => $node['name'],
            'status' => $node['status'],
            'control_error' => $node['control_error'],
        ];
    }
    roce_out([
        'nodes' => $public_nodes,
        'poll_interval_seconds' => 5,
        'validity_limit' => 'Functional software-RoCE result. Not representative of RNIC offload, ASIC buffering, PFC propagation, DCQCN firmware response, GPUDirect RDMA, or production latency and throughput.',
    ]);
}
if ($method !== 'POST') {
    roce_out(['error' => 'method'], 405);
}

$content_length = isset($_SERVER['CONTENT_LENGTH']) ? intval($_SERVER['CONTENT_LENGTH']) : 0;
if ($content_length > 8192) {
    roce_out(['error' => 'request too large'], 413);
}
$raw = file_get_contents('php://input', false, null, 0, 8193);
if ($raw === false || strlen($raw) > 8192) {
    roce_out(['error' => 'request too large'], 413);
}
$body = json_decode($raw, true);
if (!is_array($body) || !isset($body['action']) || !is_string($body['action'])) {
    roce_out(['error' => 'expected a typed action'], 400);
}
if ($body['action'] !== 'health') {
    $actions = ['prepare', 'start-server', 'readiness', 'start-client', 'status', 'cancel', 'result', 'reset-pair'];
    if (!in_array($body['action'], $actions, true) || !function_exists('broker_call')) {
        roce_out(['error' => 'invalid workload action'], 400);
    }
    if ($body['action'] === 'prepare') {
        if (count($body) !== 5 || !isset($body['server_id'], $body['client_id'], $body['tool'], $body['lease_seconds']) ||
            !is_int($body['server_id']) || !is_int($body['client_id']) || !is_string($body['tool']) ||
            !is_int($body['lease_seconds']) || !in_array($body['tool'], ['rping', 'ib_write_lat', 'ib_write_bw'], true) ||
            $body['lease_seconds'] < 1 || $body['lease_seconds'] > 120 || $body['server_id'] === $body['client_id'] ||
            !isset($rxe_nodes[$body['server_id']], $rxe_nodes[$body['client_id']])) {
            roce_out(['error' => 'invalid prepare request'], 400);
        }
        $server = $rxe_nodes[$body['server_id']]; $client = $rxe_nodes[$body['client_id']];
        if ($server['status'] !== 2 || $client['status'] !== 2 || $server['control_error'] !== null || $client['control_error'] !== null) {
            roce_out(['error' => 'both RXE nodes must be running with unique runtime identities'], 409);
        }
        $args = [
            'api_version' => 'rxe-broker/v1', 'operation' => 'prepare', 'lab_session' => $lab_session_id,
            'server' => ['node_session' => $server['node_session'], 'node_uuid' => $server['node_uuid']],
            'client' => ['node_session' => $client['node_session'], 'node_uuid' => $client['node_uuid']],
            'tool' => $body['tool'], 'lease_seconds' => $body['lease_seconds'],
        ];
    } elseif ($body['action'] === 'reset-pair') {
        if (count($body) !== 3 || !isset($body['server_id'], $body['client_id']) ||
            !is_int($body['server_id']) || !is_int($body['client_id']) ||
            $body['server_id'] === $body['client_id'] ||
            !isset($rxe_nodes[$body['server_id']], $rxe_nodes[$body['client_id']])) {
            roce_out(['error' => 'invalid reset request'], 400);
        }
        $server = $rxe_nodes[$body['server_id']]; $client = $rxe_nodes[$body['client_id']];
        if ($server['status'] !== 2 || $client['status'] !== 2 || $server['control_error'] !== null || $client['control_error'] !== null) {
            roce_out(['error' => 'both RXE nodes must be running with unique runtime identities'], 409);
        }
        $args = [
            'api_version' => 'rxe-broker/v1', 'operation' => 'reset-pair', 'lab_session' => $lab_session_id,
            'server' => ['node_session' => $server['node_session'], 'node_uuid' => $server['node_uuid']],
            'client' => ['node_session' => $client['node_session'], 'node_uuid' => $client['node_uuid']],
        ];
    } else {
        if (count($body) !== 2 || !isset($body['run_id']) || !is_string($body['run_id']) ||
            !preg_match('/^[0-9a-f]{32}$/D', $body['run_id'])) {
            roce_out(['error' => 'invalid workload run request'], 400);
        }
        $args = ['api_version' => 'rxe-broker/v1', 'operation' => $body['action'],
                 'lab_session' => $lab_session_id, 'run_id' => $body['run_id']];
    }
    $resp = @broker_call('roce_workload', $args, 8);
    if (empty($resp['ok']) || !isset($resp['out'][0])) {
        roce_out(['error' => 'workload operation failed'], 409);
    }
    $document = json_decode($resp['out'][0], true);
    if (!is_array($document) || !isset($document['api_version']) || $document['api_version'] !== 'rxe-broker/v1') {
        roce_out(['error' => 'invalid workload response'], 502);
    }
    roce_out($document);
}
if (count($body) !== 2 || !array_key_exists('node_ids', $body) || !is_array($body['node_ids'])) {
    roce_out(['error' => 'expected health action and node_ids'], 400);
}
/* One node per request keeps PHP latency bounded; the browser polls endpoints
 * concurrently and brokerd's Unix server is already threaded. */
if (count($body['node_ids']) !== 1) {
    roce_out(['error' => 'health requires exactly one node_id'], 400);
}
if (!function_exists('broker_call')) {
    roce_out(['error' => 'broker unavailable'], 500);
}

$selected = [];
foreach ($body['node_ids'] as $requested_id) {
    if (!is_int($requested_id) || $requested_id <= 0 || !isset($rxe_nodes[$requested_id])) {
        roce_out(['error' => 'node_ids must identify RXE nodes in the active lab'], 400);
    }
    $selected[$requested_id] = true;
}

$health = [];
foreach (array_keys($selected) as $id) {
    $node = $rxe_nodes[$id];
    $result = ['id' => $id, 'reachable' => false, 'health' => null, 'error' => null];
    if ($node['status'] !== 2) {
        roce_out(['error' => 'RXE node is not running'], 409);
    } elseif ($node['control_error'] !== null || $node['control_cid'] === null) {
        $result['error'] = $node['control_error'];
    } else {
        $resp = @broker_call('roce_agent_health', [
            'lab_session' => $lab_session_id,
            'node_session' => $node['node_session'],
            'cid' => $node['control_cid'],
        ], 5);
        if (!empty($resp['ok']) && isset($resp['out'][0])) {
            $document = json_decode($resp['out'][0], true);
            if (is_array($document)) {
                $result['reachable'] = true;
                $result['health'] = $document;
            } else {
                $result['error'] = 'agent returned invalid health data';
            }
        } else {
            $result['error'] = 'agent health probe failed';
        }
    }
    $health[] = $result;
}

roce_out(['health' => $health]);
