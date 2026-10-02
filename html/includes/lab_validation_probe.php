<?php

/**
 * Typed NetProbe adapter for lab validation checks.
 *
 * Definitions are deliberately converted to a small canonical shape here.
 * The adapter never accepts a command string from a task file.  At run time
 * it gives the broker a command assembled from validated scalar fields and a
 * running-path obtained from the Lab/Node session object.
 *
 * The broker contract is:
 *   node_validate {runpath, command}
 *   -> {transport: done|timeout|unavailable|error, output: string}
 * The cluster_broker() helper is used when the node is placed on a satellite.
 * DHCP lease-origin validation is intentionally not exposed: `show ip` cannot
 * distinguish a DHCP lease from a static address, and `ip dhcp` would mutate
 * the learner's node. It needs a future explicit lease-state sidechannel.
 */

if (!defined('LAB_VALIDATION_PROBE_OUTPUT_MAX')) {
    define('LAB_VALIDATION_PROBE_OUTPUT_MAX', 4096);
}
if (!defined('LAB_VALIDATION_PROBE_BROKER_TIMEOUT')) {
    define('LAB_VALIDATION_PROBE_BROKER_TIMEOUT', 20);
}

function lab_validation_probe_fail($message, $status = 400, $details = null)
{
    if (class_exists('LabValidationException')) {
        throw new LabValidationException($message, $status, $details);
    }
    throw new InvalidArgumentException($message);
}

function lab_validation_probe_text($value, $what, $max, $allowEmpty = false)
{
    if (!is_string($value) || preg_match('//u', $value) !== 1 || strlen($value) > $max ||
        strpos($value, "\0") !== false || strpos($value, "\r") !== false || strpos($value, "\n") !== false) {
        lab_validation_probe_fail('Invalid ' . $what);
    }
    $value = trim($value);
    if (!$allowEmpty && $value === '') lab_validation_probe_fail($what . ' is required');
    return $value;
}

function lab_validation_probe_int($value, $what, $minimum, $maximum)
{
    if (is_bool($value) || is_float($value) || (!is_int($value) && !is_string($value)) ||
        !preg_match('/^-?[0-9]+$/', (string) $value)) {
        lab_validation_probe_fail('Invalid ' . $what);
    }
    $number = (int) $value;
    if ($number < $minimum || $number > $maximum) {
        lab_validation_probe_fail($what . ' must be between ' . $minimum . ' and ' . $maximum);
    }
    return $number;
}

function lab_validation_probe_bool($value, $what)
{
    if (is_bool($value)) return $value;
    if (is_int($value) && ($value === 0 || $value === 1)) return $value === 1;
    if (is_string($value)) {
        $lower = strtolower(trim($value));
        if ($lower === 'true' || $lower === '1') return true;
        if ($lower === 'false' || $lower === '0') return false;
    }
    lab_validation_probe_fail('Invalid ' . $what);
}

function lab_validation_probe_ipv4($value, $what = 'IPv4 address')
{
    $value = lab_validation_probe_text($value, $what, 15);
    if (filter_var($value, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
        lab_validation_probe_fail('Invalid ' . $what);
    }
    return $value;
}

function lab_validation_probe_hostname($value)
{
    $value = lab_validation_probe_text($value, 'DNS name', 253);
    if (substr($value, -1) === '.') $value = substr($value, 0, -1);
    if ($value === '' || !preg_match('/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/', $value)) {
        lab_validation_probe_fail('Invalid DNS name');
    }
    return strtolower($value);
}

function lab_validation_probe_assoc($value, $what)
{
    if (!is_array($value)) lab_validation_probe_fail('Invalid ' . $what);
    foreach (array_keys($value) as $key) {
        if (is_int($key) || !is_string($key) || $key === '') lab_validation_probe_fail('Invalid ' . $what);
    }
    return $value;
}

function lab_validation_probe_alias(&$params, $canonical, $aliases)
{
    if (array_key_exists($canonical, $params)) return;
    foreach ($aliases as $alias) {
        if (array_key_exists($alias, $params)) {
            $params[$canonical] = $params[$alias];
            unset($params[$alias]);
            return;
        }
    }
}

function lab_validation_probe_allowed_params($params, $allowed, $type)
{
    foreach (array_keys($params) as $key) {
        if (!in_array($key, $allowed, true)) {
            lab_validation_probe_fail('Unknown ' . $type . ' parameter: ' . $key);
        }
    }
}

function lab_validation_probe_common($check, $type, $params)
{
    ksort($params);
    $result = array(
        'id' => $check['id'],
        'title' => $check['title'],
        'source_node' => (int) $check['source_node'],
        'type' => $type,
        'params' => $params,
    );
    if (array_key_exists('source_interface', $check)) {
        $iface = lab_validation_probe_text($check['source_interface'], 'source interface', 32, true);
        if ($iface !== '' && $iface !== 'eth0') {
            lab_validation_probe_fail('Invalid source interface');
        }
        $result['source_interface'] = $iface;
    }
    if (array_key_exists('expected', $check)) {
        if (!is_string($check['expected']) || strlen($check['expected']) > 512 || preg_match('//u', $check['expected']) !== 1) {
            lab_validation_probe_fail('Invalid expected value');
        }
        if (trim($check['expected']) !== '') {
            lab_validation_probe_fail('Use typed parameters for expected values');
        }
    }
    return $result;
}

function lab_validation_probe_expectation(&$params, $default = true)
{
    lab_validation_probe_alias($params, 'expect', array('reachable', 'expect_reachable', 'allow'));
    $params['expect'] = array_key_exists('expect', $params)
        ? lab_validation_probe_bool($params['expect'], 'expect') : $default;
    return $params['expect'];
}

function lab_validation_probe_ping_params($params, $type, $targetRequired = true)
{
    $params = lab_validation_probe_assoc($params, $type . ' parameters');
    lab_validation_probe_alias($params, 'target', array('host', 'destination', 'address'));
    lab_validation_probe_alias($params, 'dont_fragment', array('df'));
    lab_validation_probe_alias($params, 'max_loss', array('expected_loss', 'packet_loss'));
    lab_validation_probe_expectation($params);
    lab_validation_probe_allowed_params($params, array(
        'target', 'count', 'size', 'dont_fragment', 'expect', 'max_loss', 'min_received',
    ), $type);
    if ($targetRequired && !array_key_exists('target', $params)) {
        lab_validation_probe_fail($type . ' target is required');
    }
    if (array_key_exists('target', $params)) $params['target'] = lab_validation_probe_ipv4($params['target'], $type . ' target');
    $params['count'] = array_key_exists('count', $params)
        ? lab_validation_probe_int($params['count'], $type . ' count', 1, 5) : 3;
    $size = array_key_exists('size', $params)
        ? lab_validation_probe_int($params['size'], $type . ' size', 0, 1472) : 56;
    /* The broker accepts zero as the schema's default-size sentinel, while
     * NetProbe's actual -s parser requires a positive value. */
    $params['size'] = $size === 0 ? 56 : $size;
    $params['dont_fragment'] = array_key_exists('dont_fragment', $params)
        ? lab_validation_probe_bool($params['dont_fragment'], 'dont_fragment') : false;
    $params['expect'] = lab_validation_probe_expectation($params);
    $params['max_loss'] = array_key_exists('max_loss', $params)
        ? lab_validation_probe_int($params['max_loss'], $type . ' maximum loss', 0, 100) : 0;
    $params['min_received'] = array_key_exists('min_received', $params)
        ? lab_validation_probe_int($params['min_received'], $type . ' minimum replies', 0, $params['count'])
        : $params['count'];
    return $params;
}

function lab_validation_validate_check($check)
{
    if (!is_array($check)) lab_validation_probe_fail('Invalid validation check');
    foreach (array_keys($check) as $key) {
        if (!in_array($key, array('id', 'title', 'source_node', 'type', 'params', 'source_interface', 'expected'), true)) {
            lab_validation_probe_fail('Unknown validation check field: ' . $key);
        }
    }
    if (!isset($check['id']) || !is_string($check['id']) || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $check['id'])) {
        lab_validation_probe_fail('Invalid check id');
    }
    if (!isset($check['title']) || !is_string($check['title']) || preg_match('//u', $check['title']) !== 1 ||
        strlen($check['title']) > 160 || trim($check['title']) === '') {
        lab_validation_probe_fail('Check title is required');
    }
    if (!array_key_exists('source_node', $check) || is_bool($check['source_node']) ||
        (!is_int($check['source_node']) && !is_string($check['source_node'])) ||
        !preg_match('/^[0-9]+$/', (string) $check['source_node']) || (int) $check['source_node'] < 1) {
        lab_validation_probe_fail('Check source_node must be a positive integer');
    }
    if (!isset($check['type']) || !is_string($check['type'])) lab_validation_probe_fail('Check type is required');
    $type = strtolower(trim($check['type']));
    if (!in_array($type, array('ping', 'trace', 'dns', 'tcp', 'gateway', 'mtu'), true)) {
        lab_validation_probe_fail('Unsupported validation check type: ' . $type);
    }
    $params = array_key_exists('params', $check) ? lab_validation_probe_assoc($check['params'], $type . ' parameters') : array();

    if ($type === 'ping') {
        $params = lab_validation_probe_ping_params($params, $type);
    } elseif ($type === 'trace') {
        lab_validation_probe_alias($params, 'target', array('host', 'destination', 'address'));
        lab_validation_probe_expectation($params);
        if (!array_key_exists('target', $params)) lab_validation_probe_fail('trace target is required');
        $params['target'] = lab_validation_probe_ipv4($params['target'], 'trace target');
        if (array_key_exists('max_ttl', $params)) {
            if (array_key_exists('max_hops', $params)) lab_validation_probe_fail('trace maximum hops is specified twice');
            $params['max_hops'] = $params['max_ttl']; unset($params['max_ttl']);
        }
        lab_validation_probe_allowed_params($params, array('target', 'max_hops', 'expect', 'contains'), $type);
        $params['max_hops'] = array_key_exists('max_hops', $params)
            ? lab_validation_probe_int($params['max_hops'], 'trace maximum hops', 1, 8) : 8;
        $params['expect'] = lab_validation_probe_expectation($params);
        if (array_key_exists('contains', $params)) {
            if (!is_array($params['contains']) || count($params['contains']) > 8) lab_validation_probe_fail('trace contains must be an IPv4 list');
            $values = array();
            foreach ($params['contains'] as $value) $values[] = lab_validation_probe_ipv4($value, 'trace expected hop');
            $params['contains'] = $values;
        } else {
            $params['contains'] = array();
        }
    } elseif ($type === 'dns') {
        lab_validation_probe_alias($params, 'name', array('hostname', 'query'));
        lab_validation_probe_alias($params, 'record', array('query_type', 'rrtype', 'type'));
        lab_validation_probe_alias($params, 'server', array('dns_server'));
        lab_validation_probe_expectation($params);
        lab_validation_probe_allowed_params($params, array('name', 'record', 'server', 'expect', 'answer', 'contains'), $type);
        if (!array_key_exists('name', $params)) lab_validation_probe_fail('dns name is required');
        $params['name'] = lab_validation_probe_hostname($params['name']);
        $params['record'] = strtoupper(array_key_exists('record', $params) ? lab_validation_probe_text($params['record'], 'DNS record type', 8) : 'A');
        if (!in_array($params['record'], array('A', 'AAAA', 'CNAME', 'PTR'), true)) lab_validation_probe_fail('Unsupported DNS record type');
        if (array_key_exists('server', $params)) $params['server'] = lab_validation_probe_ipv4($params['server'], 'DNS server');
        $params['expect'] = lab_validation_probe_expectation($params);
        if (array_key_exists('answer', $params)) $params['answer'] = lab_validation_probe_text($params['answer'], 'DNS answer', 253);
        if (array_key_exists('contains', $params)) $params['contains'] = lab_validation_probe_text($params['contains'], 'DNS answer substring', 253);
    } elseif ($type === 'tcp') {
        lab_validation_probe_alias($params, 'target', array('host', 'destination', 'address'));
        lab_validation_probe_expectation($params);
        lab_validation_probe_allowed_params($params, array('target', 'port', 'expect'), $type);
        if (!array_key_exists('target', $params)) lab_validation_probe_fail('tcp target is required');
        if (!array_key_exists('port', $params)) lab_validation_probe_fail('tcp port is required');
        $params['target'] = lab_validation_probe_ipv4($params['target'], 'tcp target');
        $params['port'] = lab_validation_probe_int($params['port'], 'tcp port', 1, 65535);
        $params['expect'] = lab_validation_probe_expectation($params);
    } elseif ($type === 'gateway') {
        if (array_key_exists('target', $params) || array_key_exists('host', $params) ||
            array_key_exists('destination', $params) || array_key_exists('address', $params)) {
            lab_validation_probe_fail('gateway target is derived from show ip');
        }
        $params = lab_validation_probe_ping_params($params, $type, false);
    } elseif ($type === 'mtu') {
        lab_validation_probe_alias($params, 'target', array('host', 'destination', 'address'));
        lab_validation_probe_alias($params, 'dont_fragment', array('df'));
        lab_validation_probe_alias($params, 'expected_mtu', array('mtu', 'expected'));
        lab_validation_probe_expectation($params);
        lab_validation_probe_allowed_params($params, array(
            'target', 'count', 'size', 'dont_fragment', 'expect', 'max_loss', 'min_received', 'expected_mtu',
        ), $type);
        if (!array_key_exists('target', $params) && !array_key_exists('expected_mtu', $params)) {
            lab_validation_probe_fail('mtu requires target or expected_mtu');
        }
        if (array_key_exists('target', $params)) $params['target'] = lab_validation_probe_ipv4($params['target'], 'mtu target');
        if (array_key_exists('expected_mtu', $params)) $params['expected_mtu'] = lab_validation_probe_int($params['expected_mtu'], 'expected MTU', 68, 65535);
        $params['expect'] = lab_validation_probe_expectation($params);
        if (array_key_exists('target', $params)) {
            $params['count'] = array_key_exists('count', $params) ? lab_validation_probe_int($params['count'], 'mtu count', 1, 5) : 1;
            $params['size'] = array_key_exists('size', $params) ? lab_validation_probe_int($params['size'], 'mtu size', 1, 1472) : 1400;
            $params['dont_fragment'] = array_key_exists('dont_fragment', $params) ? lab_validation_probe_bool($params['dont_fragment'], 'dont_fragment') : true;
            $params['max_loss'] = array_key_exists('max_loss', $params) ? lab_validation_probe_int($params['max_loss'], 'mtu maximum loss', 0, 100) : 0;
            $params['min_received'] = array_key_exists('min_received', $params) ? lab_validation_probe_int($params['min_received'], 'mtu minimum replies', 0, $params['count']) : $params['count'];
        } else {
            foreach (array('count', 'size', 'dont_fragment', 'max_loss', 'min_received') as $field) {
                if (array_key_exists($field, $params)) lab_validation_probe_fail('mtu ' . $field . ' requires target');
            }
        }
    }
    return lab_validation_probe_common($check, $type, $params);
}

function lab_validation_probe_command($type, $params, $targetOverride = null)
{
    if ($type === 'show_ip') return 'show ip';
    if ($type === 'ping' || $type === 'gateway' || $type === 'mtu') {
        $target = $targetOverride !== null ? $targetOverride : $params['target'];
        $command = 'ping ' . $target . ' -c ' . (int) $params['count'];
        if ((int) $params['size'] > 0) $command .= ' -s ' . (int) $params['size'];
        if (!empty($params['dont_fragment'])) $command .= ' -D';
        return $command;
    }
    if ($type === 'trace') return 'trace ' . $params['target'] . ' -m ' . (int) $params['max_hops'] . ' -q 1';
    if ($type === 'dns') return 'nslookup ' . $params['name'] . ' ' . $params['record'] . (isset($params['server']) ? ' @' . $params['server'] : '');
    if ($type === 'tcp') return 'tcp connect ' . $params['target'] . ' ' . (int) $params['port'];
    lab_validation_probe_fail('Unsupported validation command type', 500);
}

function lab_validation_probe_output($value)
{
    $value = is_string($value) ? $value : '';
    if (strlen($value) > LAB_VALIDATION_PROBE_OUTPUT_MAX) $value = substr($value, 0, LAB_VALIDATION_PROBE_OUTPUT_MAX) . "\n[output truncated]";
    $clean = @preg_replace('/[^\P{C}\r\n\t]/u', '?', $value);
    return is_string($clean) ? $clean : '';
}

function lab_validation_probe_response($response)
{
    if (!is_array($response)) return array('transport' => 'error', 'output' => '', 'detail' => 'Invalid probe response');
    if (isset($response['transport'])) {
        $transport = (string) $response['transport'];
        return array('transport' => in_array($transport, array('done', 'timeout', 'unavailable', 'error'), true) ? $transport : 'error',
            'output' => lab_validation_probe_output(isset($response['output']) ? $response['output'] : ''),
            'detail' => isset($response['detail']) ? lab_validation_probe_output($response['detail']) : '');
    }
    $raw = isset($response['out']) ? $response['out'] : '';
    if (is_array($raw)) $raw = implode("\n", array_map('strval', $raw));
    if (is_string($raw)) {
        $decoded = json_decode($raw, true);
        if (is_array($decoded) && isset($decoded['transport'])) return lab_validation_probe_response($decoded);
    }
    if (isset($response['ok']) && !$response['ok']) return array('transport' => 'error', 'output' => lab_validation_probe_output($raw),
        'detail' => isset($response['err']) ? lab_validation_probe_output($response['err']) : 'Probe broker error');
    return array('transport' => 'error', 'output' => lab_validation_probe_output($raw), 'detail' => 'Invalid probe response');
}

function lab_validation_probe_transport($node, $host, $runpath, $command, $timeout)
{
    $timeout = max((int) $timeout, LAB_VALIDATION_PROBE_BROKER_TIMEOUT);
    $args = array('runpath' => $runpath, 'command' => $command);
    if (isset($GLOBALS['lab_validation_probe_transport']) && is_callable($GLOBALS['lab_validation_probe_transport'])) {
        return lab_validation_probe_response(call_user_func($GLOBALS['lab_validation_probe_transport'], $args, $timeout, (int) $host));
    }
    if ((int) $host > 0 && function_exists('cluster_broker')) {
        return lab_validation_probe_response(cluster_broker((int) $host, 'node_validate', $args, $timeout));
    }
    if (function_exists('broker_call')) return lab_validation_probe_response(broker_call('node_validate', $args, $timeout));
    return array('transport' => 'unavailable', 'output' => '', 'detail' => 'Validation probe broker is unavailable');
}

function lab_validation_probe_node($lab, $nodeId)
{
    if (!is_object($lab) || !method_exists($lab, 'getNodes')) return array('error' => 'Lab node catalog is unavailable');
    $nodes = $lab->getNodes();
    $node = isset($nodes[(int) $nodeId]) ? $nodes[(int) $nodeId] : null;
    if (!$node) return array('error' => 'Validation source node was not found');
    if (!is_object($node)) return array('error' => 'Validation source node is invalid');
    if (method_exists($node, 'getNType') && strtolower((string) $node->getNType()) !== 'vpcs') {
        return array('unknown' => 'Source node is not a NetProbe/VPCS node');
    }
    if (!method_exists($node, 'getRunningPath')) return array('unknown' => 'Source node runtime is unavailable');
    $runpath = $node->getRunningPath();
    if (!is_string($runpath) || $runpath === '' || strpos($runpath, "\0") !== false) {
        return array('unknown' => 'Source node is not running');
    }
    $host = 0;
    if (method_exists($node, 'getSessionHost')) $host = (int) $node->getSessionHost();
    elseif (function_exists('cluster_session_host')) $host = (int) cluster_session_host($lab, (int) $nodeId);
    else return array('unknown' => 'Source node placement is unavailable');
    if ($host < 0 || $host > 16) return array('unknown' => 'Source node placement is invalid');
    return array('node' => $node, 'host' => $host, 'runpath' => $runpath);
}

function lab_validation_probe_result($status, $detail, $observed)
{
    return array('status' => $status, 'detail' => lab_validation_probe_output($detail), 'observed' => $observed);
}

function lab_validation_probe_transport_result($call, $command, $observed = array())
{
    $observed['transport'] = $call['transport'];
    $observed['command'] = $command;
    $observed['output'] = $call['output'];
    if ($call['transport'] === 'unavailable' || $call['transport'] === 'timeout') {
        $detail = $call['detail'] !== '' ? $call['detail'] : ($call['output'] !== '' ? $call['output'] : 'Validation probe ' . $call['transport']);
        return lab_validation_probe_result('unknown', $detail, $observed);
    }
    if ($call['transport'] !== 'done') {
        $detail = $call['detail'] !== '' ? $call['detail'] : ($call['output'] !== '' ? $call['output'] : 'Validation probe failed');
        return lab_validation_probe_result('error', $detail, $observed);
    }
    return null;
}

function lab_validation_probe_ping_parse($output, $params)
{
    $replies = array();
    preg_match_all('/Reply from\s+([0-9.]+):\s+bytes=([0-9]+)\s+time=([0-9.]+)ms\s+ttl=([0-9]+)/i', $output, $matches, PREG_SET_ORDER);
    foreach ($matches as $match) $replies[] = array('address' => $match[1], 'bytes' => (int) $match[2], 'time_ms' => (float) $match[3], 'ttl' => (int) $match[4]);
    $sent = 0; $received = 0; $loss = 100.0; $summaryValid = false;
    if (preg_match('/([0-9]+)\s+packets transmitted,\s*([0-9]+)\s+received,\s*([0-9.]+)%\s+packet loss/i', $output, $summary)) {
        $sent = (int) $summary[1]; $received = (int) $summary[2]; $loss = (float) $summary[3];
        $expectedLoss = $sent > 0 ? (100 * ($sent - $received) / $sent) : 100;
        /* The pinned NetProbe formatter emits integer floor(loss), so allow
         * the one percentage point rounding interval while still requiring
         * the counters and loss to agree. */
        $summaryValid = $sent === (int) $params['count'] && $received >= 0 && $received <= $sent &&
            $loss >= 0 && $loss <= 100 && abs($loss - $expectedLoss) <= 1.0;
    }
    $condition = $summaryValid && $received >= (int) $params['min_received'] && $loss <= (float) $params['max_loss'];
    $negativeCondition = $summaryValid && $received === 0;
    return array('condition' => $condition, 'negative_condition' => $negativeCondition, 'verified' => $summaryValid,
        'parsed' => array('target' => $params['target'], 'sent' => $sent, 'received' => $received,
            'loss_percent' => $loss, 'verified_summary' => $summaryValid, 'replies' => $replies));
}

function lab_validation_probe_show_ip_parse($output)
{
    $parsed = array('matched' => false, 'address' => null, 'gateway' => null, 'dns' => null, 'mac' => null, 'mtu' => null);
    if (preg_match('/eth0:\s+([^\s]+)(?:\s+gateway\s+([^\s]+))?.*?\bmtu\s+([0-9]+)/i', $output, $match)) {
        $address = strtolower($match[1]);
        $valid = $address === 'unaddressed';
        if (!$valid && preg_match('/^([^\/]+)\/([0-9]+)$/', $match[1], $cidr) === 1) {
            $valid = filter_var($cidr[1], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false &&
                (int) $cidr[2] >= 1 && (int) $cidr[2] <= 32;
        }
        if (isset($match[2]) && $match[2] !== '' && strtolower($match[2]) !== 'none') {
            $valid = $valid && filter_var($match[2], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false;
        }
        $mtu = (int) $match[3];
        $valid = $valid && $mtu >= 68 && $mtu <= 65535;
        if (!$valid) return $parsed;
        $parsed['matched'] = true;
        if ($address !== 'unaddressed') $parsed['address'] = $match[1];
        if (isset($match[2]) && $match[2] !== '' && strtolower($match[2]) !== 'none') $parsed['gateway'] = $match[2];
        $parsed['mtu'] = $mtu;
        if (preg_match('/\bdns\s+([^\s]+)/i', $output, $dns)) {
            if (strtolower($dns[1]) === 'none') $parsed['dns'] = null;
            elseif (filter_var($dns[1], FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) $parsed['dns'] = $dns[1];
            else return array('matched' => false, 'address' => null, 'gateway' => null, 'dns' => null, 'mac' => null, 'mtu' => null);
        }
        if (preg_match('/\bmac\s+([0-9a-f:]{17})/i', $output, $mac)) $parsed['mac'] = strtolower($mac[1]);
    }
    return $parsed;
}

function lab_validation_run_check($lab, $check, $user)
{
    $check = lab_validation_validate_check($check);
    $type = $check['type']; $params = $check['params'];
    $nodeInfo = lab_validation_probe_node($lab, $check['source_node']);
    if (isset($nodeInfo['error'])) return lab_validation_probe_result('error', $nodeInfo['error'], array('type' => $type));
    if (isset($nodeInfo['unknown'])) return lab_validation_probe_result('unknown', $nodeInfo['unknown'], array('type' => $type));
    $node = $nodeInfo['node']; $host = $nodeInfo['host']; $runpath = $nodeInfo['runpath'];
    $request = function ($command, $timeout) use ($node, $host, $runpath) {
        return lab_validation_probe_transport($node, $host, $runpath, $command, $timeout);
    };
    $baseObserved = array('type' => $type, 'source_node' => (int) $check['source_node']);
    if ($type === 'gateway') {
        $showCommand = lab_validation_probe_command('show_ip', array());
        $show = $request($showCommand, 4); $showObserved = array('transport' => $show['transport'], 'command' => $showCommand, 'output' => $show['output']);
        if ($show['transport'] !== 'done') return lab_validation_probe_transport_result($show, $showCommand, $baseObserved);
        $ip = lab_validation_probe_show_ip_parse($show['output']); $showObserved['parsed'] = $ip; $baseObserved['show_ip'] = $showObserved;
        if (!$ip['matched']) return lab_validation_probe_result('unknown', 'Could not parse show ip output', $baseObserved);
        $hasGateway = $ip['gateway'] !== null;
        if (!$hasGateway) return lab_validation_probe_result($params['expect'] ? 'failed' : 'passed', $params['expect'] ? 'No gateway is configured' : 'No gateway is configured as expected', $baseObserved);
        $command = lab_validation_probe_command('gateway', $params, $ip['gateway']); $ping = $request($command, 12);
        $pingObserved = array('transport' => $ping['transport'], 'command' => $command, 'output' => $ping['output']);
        $baseObserved['gateway'] = $ip['gateway']; $baseObserved['ping'] = $pingObserved;
        $transportResult = lab_validation_probe_transport_result($ping, $command, $baseObserved);
        if ($transportResult !== null) return $transportResult;
        $parsed = lab_validation_probe_ping_parse($ping['output'], array_merge($params, array('target' => $ip['gateway']))); $baseObserved['ping']['parsed'] = $parsed['parsed'];
        if (!$parsed['verified']) return lab_validation_probe_result('unknown', 'Could not verify complete gateway ping output', $baseObserved);
        $ok = $params['expect'] ? $parsed['condition'] : $parsed['negative_condition'];
        return lab_validation_probe_result($ok ? 'passed' : 'failed', $ok ? 'Gateway check passed' : 'Gateway did not meet the expected reachability', $baseObserved);
    }
    if ($type === 'mtu') {
        $showCommand = 'show ip'; $show = $request($showCommand, 4); $showObserved = array('transport' => $show['transport'], 'command' => $showCommand, 'output' => $show['output']);
        if ($show['transport'] !== 'done') return lab_validation_probe_transport_result($show, $showCommand, $baseObserved);
        $ip = lab_validation_probe_show_ip_parse($show['output']); $showObserved['parsed'] = $ip; $baseObserved['show_ip'] = $showObserved;
        if (!$ip['matched']) return lab_validation_probe_result('unknown', 'Could not parse show ip output', $baseObserved);
        if ($ip['mtu'] === null) return lab_validation_probe_result('unknown', 'Could not determine interface MTU', $baseObserved);
        $mtuOk = $ip['mtu'] !== null && (!array_key_exists('expected_mtu', $params) || (int) $ip['mtu'] === (int) $params['expected_mtu']);
        $condition = $mtuOk; $negativeCondition = !$mtuOk;
        $detail = $mtuOk ? 'Interface MTU matched' : 'Interface MTU did not match the expected value';
        if (isset($params['target'])) {
            $command = lab_validation_probe_command('mtu', $params); $ping = $request($command, 12);
            $pingObserved = array('transport' => $ping['transport'], 'command' => $command, 'output' => $ping['output']); $baseObserved['ping'] = $pingObserved;
            $transportResult = lab_validation_probe_transport_result($ping, $command, $baseObserved);
            if ($transportResult !== null) return $transportResult;
            $parsed = lab_validation_probe_ping_parse($ping['output'], $params); $baseObserved['ping']['parsed'] = $parsed['parsed'];
            if (!$parsed['verified']) return lab_validation_probe_result('unknown', 'Could not verify complete MTU ping output', $baseObserved);
            $condition = $condition && $parsed['condition'];
            $negativeCondition = $negativeCondition || $parsed['negative_condition'];
            $detail = $condition ? 'MTU and no-fragment probe passed' : 'MTU or no-fragment probe did not meet the expectation';
        }
        $ok = $params['expect'] ? $condition : $negativeCondition;
        return lab_validation_probe_result($ok ? 'passed' : 'failed', $ok ? $detail : 'MTU check did not meet the expected result', $baseObserved);
    }
    $command = lab_validation_probe_command($type, $params);
    $timeout = $type === 'dns' ? 6 : ($type === 'tcp' ? 7 : ($type === 'trace' ? 12 : 12));
    $call = $request($command, $timeout); $transportResult = lab_validation_probe_transport_result($call, $command, $baseObserved);
    if ($transportResult !== null) return $transportResult;
    $observed = array_merge($baseObserved, array('transport' => $call['transport'], 'command' => $command, 'output' => $call['output']));
    if ($type === 'ping') {
        $parsed = lab_validation_probe_ping_parse($call['output'], $params); $observed['parsed'] = $parsed['parsed'];
        if (!$parsed['verified']) return lab_validation_probe_result('unknown', 'Could not verify complete ping output', $observed);
        $ok = $params['expect'] ? $parsed['condition'] : $parsed['negative_condition'];
        return lab_validation_probe_result($ok ? 'passed' : 'failed', $ok ? 'Ping check passed' : 'Ping did not meet the expected reachability', $observed);
    }
    if ($type === 'trace') {
        $hops = array(); preg_match_all('/^\s*[0-9]+\s+([0-9.]+)/m', $call['output'], $matches);
        foreach ($matches[1] as $hop) if (filter_var($hop, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false) $hops[] = $hop;
        $complete = stripos($call['output'], 'ICMP traceroute complete') !== false;
        $verified = $complete && count($hops) > 0;
        $condition = $verified && (empty($params['contains']) ? in_array($params['target'], $hops, true) : !array_diff($params['contains'], $hops));
        $observed['parsed'] = array('target' => $params['target'], 'complete' => $complete, 'verified' => $verified, 'hops' => $hops);
        if (!$verified) return lab_validation_probe_result('unknown', 'Could not verify complete traceroute output', $observed);
        $ok = $params['expect'] ? $condition : !$condition;
        return lab_validation_probe_result($ok ? 'passed' : 'failed', $ok ? 'Trace check passed' : 'Trace did not meet the expected path', $observed);
    }
    if ($type === 'dns') {
        $answers = array(); $quoted = preg_quote($params['name'], '/');
        foreach (preg_split('/\R/', $call['output']) as $line) if (preg_match('/^\s*' . $quoted . '\.?\s*:\s*(\S.*)$/i', $line, $match)) $answers[] = trim($match[1]);
        $knownNoAnswer = preg_match('/nslookup:\s+' . $quoted . ':\s+no answer\b/i', $call['output']) === 1;
        $knownError = preg_match('/nslookup:\s+' . $quoted . ':\s+(?:request timed out|no reachable DNS server|malformed response|response truncated|server returned an error|too many answers|unable to |invalid )/i', $call['output']) === 1 ||
            stripos($call['output'], 'no DNS server configured') !== false;
        $observed['parsed'] = array('name' => $params['name'], 'record' => $params['record'], 'answers' => $answers, 'no_answer' => $knownNoAnswer);
        if (!$answers && !$knownNoAnswer && $knownError) return lab_validation_probe_result('unknown', 'DNS result was unavailable or malformed', $observed);
        if (!$answers && !$knownNoAnswer) return lab_validation_probe_result('unknown', 'Could not verify DNS response', $observed);
        $condition = count($answers) > 0;
        if (isset($params['answer'])) $condition = in_array(strtolower($params['answer']), array_map('strtolower', $answers), true);
        if (isset($params['contains'])) { $condition = false; foreach ($answers as $answer) if (stripos($answer, $params['contains']) !== false) $condition = true; }
        $ok = $params['expect'] ? $condition : !$condition;
        return lab_validation_probe_result($ok ? 'passed' : 'failed', $ok ? 'DNS check passed' : 'DNS did not meet the expected answer', $observed);
    }
    $connected = preg_match('/\bTCP:\s+(?:connected|connection established)\b/i', $call['output']) === 1;
    $refused = preg_match('/%\s*TCP:\s+(?:connection reset by peer|connection refused)\b/i', $call['output']) === 1;
    if (!$connected && !$refused) {
        $observed['parsed'] = array('target' => $params['target'], 'port' => $params['port'], 'connected' => false, 'refused' => false);
        return lab_validation_probe_result('unknown', 'Could not verify TCP connection result', $observed);
    }
    $condition = $connected; $observed['parsed'] = array('target' => $params['target'], 'port' => $params['port'], 'connected' => $connected, 'refused' => $refused); $ok = $params['expect'] ? $condition : $refused;
    return lab_validation_probe_result($ok ? 'passed' : 'failed', $ok ? 'TCP connection check passed' : 'TCP connection did not meet the expected reachability', $observed);
}
