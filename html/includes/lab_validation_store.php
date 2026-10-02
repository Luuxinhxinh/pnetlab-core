<?php

/** Sidecar persistence and progress for lab validation tasks. */

class LabValidationException extends Exception
{
    private $httpStatus;
    private $details;

    public function __construct($message, $httpStatus = 400, $details = null)
    {
        parent::__construct($message);
        $this->httpStatus = (int) $httpStatus;
        $this->details = $details;
    }

    public function getHttpStatus() { return $this->httpStatus; }
    public function getDetails() { return $this->details; }
}

function lab_validation_root()
{
    $override = getenv('PNETLAB_LAB_VALIDATION_ROOT');
    return rtrim($override !== false && $override !== ''
        ? $override : '/opt/unetlab/data/lab-validations', '/\\');
}

function lab_validation_relative_path($labFile)
{
    $base = str_replace('\\', '/', rtrim(BASE_LAB, '/\\'));
    $file = str_replace('\\', '/', (string) $labFile);
    if (strpos($file, $base . '/') !== 0) {
        throw new LabValidationException('Lab path is outside the lab root');
    }
    $relative = substr($file, strlen($base) + 1);
    $parts = explode('/', $relative);
    if ($relative === '' || !preg_match('/\.unl$/i', $relative)) {
        throw new LabValidationException('Invalid lab path');
    }
    foreach ($parts as $part) {
        if ($part === '' || $part === '.' || $part === '..' || strpos($part, "\0") !== false) {
            throw new LabValidationException('Invalid lab path');
        }
    }
    return implode('/', $parts);
}

function lab_validation_dir_for_file($labFile)
{
    $path = lab_validation_root() . '/' . lab_validation_relative_path($labFile);
    lab_validation_assert_no_symlink_path($path);
    return $path;
}

function lab_validation_dir_for_folder($folderPath)
{
    $path = str_replace('\\', '/', trim((string) $folderPath));
    $path = trim($path, '/');
    if ($path === '') {
        lab_validation_assert_no_symlink_path(lab_validation_root());
        return lab_validation_root();
    }
    foreach (explode('/', $path) as $part) {
        if ($part === '' || $part === '.' || $part === '..' || strpos($part, "\0") !== false) {
            throw new LabValidationException('Invalid lab folder path');
        }
    }
    $result = lab_validation_root() . '/' . $path;
    lab_validation_assert_no_symlink_path($result);
    return $result;
}

function lab_validation_default_document()
{
    return array('schema_version' => 1, 'revision' => 0, 'source_nodes' => array(), 'tasks' => array());
}

function lab_validation_validate_document($doc, $requireRevision)
{
    if (!is_array($doc)) throw new LabValidationException('Invalid validation YAML');
    foreach (array_keys($doc) as $key) {
        if (!in_array($key, array('schema_version','revision','source_nodes','tasks'), true)) {
            throw new LabValidationException('Unknown validation document field: ' . $key);
        }
    }
    if (!isset($doc['schema_version']) || !is_int($doc['schema_version']) || $doc['schema_version'] !== 1) {
        throw new LabValidationException('Unsupported validation schema version');
    }
    if ($requireRevision && (!isset($doc['revision']) || !is_int($doc['revision']) || $doc['revision'] < 0)) {
        throw new LabValidationException('Stored validation revision is invalid', 500);
    }
    if (!$requireRevision && isset($doc['revision']) && (!is_int($doc['revision']) || $doc['revision'] < 0)) {
        throw new LabValidationException('Invalid validation revision');
    }
    if (!isset($doc['tasks']) || !lab_validation_is_list($doc['tasks'])) {
        throw new LabValidationException('Invalid validation tasks');
    }
    if (isset($doc['source_nodes']) && !lab_validation_is_list($doc['source_nodes'])) {
        throw new LabValidationException('Invalid validation source nodes');
    }
    $doc['revision'] = isset($doc['revision']) ? $doc['revision'] : 0;
    $doc['source_nodes'] = isset($doc['source_nodes']) ? $doc['source_nodes'] : array();
    return $doc;
}

function lab_validation_assert_no_symlink_path($path)
{
    $normalized = str_replace('\\', '/', (string) $path);
    if ($normalized === '' || ($normalized[0] !== '/' && !preg_match('/^[A-Za-z]:\//', $normalized))) {
        throw new LabValidationException('Validation storage path must be absolute', 500);
    }
    $prefix = $normalized[0] === '/' ? '' : substr($normalized, 0, 2);
    $parts = explode('/', $normalized[0] === '/' ? substr($normalized, 1) : substr($normalized, 3));
    $current = $prefix;
    foreach ($parts as $part) {
        if ($part === '') continue;
        $current .= '/' . $part;
        if (is_link($current)) throw new LabValidationException('Validation storage cannot contain symbolic links', 500);
    }
}

function lab_validation_ensure_dir($dir)
{
    lab_validation_assert_no_symlink_path($dir);
    if (!is_dir($dir) && !@mkdir($dir, 0770, true) && !is_dir($dir)) {
        throw new LabValidationException('Could not create validation storage', 500);
    }
    lab_validation_assert_no_symlink_path($dir);
}

function lab_validation_with_lock($labFile, $exclusive, $callback)
{
    $root = lab_validation_root();
    lab_validation_ensure_dir($root);
    $globalPath = $root . '/.lifecycle.lock';
    lab_validation_assert_no_symlink_path($globalPath);
    $global = @fopen($globalPath, 'c');
    if (!$global || !flock($global, LOCK_SH)) {
        if ($global) fclose($global);
        throw new LabValidationException('Could not lock validation storage', 500);
    }
    $dir = lab_validation_dir_for_file($labFile);
    $lockDir = $root . '/.locks';
    lab_validation_ensure_dir($lockDir);
    $lockPath = $lockDir . '/' . hash('sha256', lab_validation_relative_path($labFile)) . '.lock';
    lab_validation_assert_no_symlink_path($lockPath);
    $lock = @fopen($lockPath, 'c');
    if (!$lock || !flock($lock, $exclusive ? LOCK_EX : LOCK_SH)) {
        if ($lock) fclose($lock);
        flock($global, LOCK_UN); fclose($global);
        throw new LabValidationException('Could not lock lab validations', 500);
    }
    try {
        return $callback($dir);
    } finally {
        flock($lock, LOCK_UN); fclose($lock);
        flock($global, LOCK_UN); fclose($global);
    }
}

function lab_validation_with_lifecycle_lock($callback)
{
    $root = lab_validation_root();
    lab_validation_ensure_dir($root);
    $lockPath = $root . '/.lifecycle.lock';
    lab_validation_assert_no_symlink_path($lockPath);
    $fp = @fopen($lockPath, 'c');
    if (!$fp || !flock($fp, LOCK_EX)) {
        if ($fp) fclose($fp);
        throw new LabValidationException('Could not lock validation lifecycle', 500);
    }
    try { return $callback(); }
    finally { flock($fp, LOCK_UN); fclose($fp); }
}

function lab_validation_yaml_decode($raw)
{
    if (!is_string($raw) || strlen($raw) > 1024 * 1024) {
        throw new LabValidationException('Validation YAML must be 1 MiB or smaller');
    }
    if (!function_exists('yaml_parse')) {
        throw new LabValidationException('YAML support is unavailable', 500);
    }
    lab_validation_reject_yaml_controls($raw);
    $documents = 0;
    $oldDecodePhp = ini_get('yaml.decode_php');
    @ini_set('yaml.decode_php', '0');
    try {
        $parsed = @yaml_parse($raw, 0, $documents);
    } finally {
        if ($oldDecodePhp !== false) @ini_set('yaml.decode_php', $oldDecodePhp);
    }
    if (!is_array($parsed) || $documents !== 1) {
        throw new LabValidationException('Invalid validation YAML');
    }
    lab_validation_bound_structure($parsed);
    return $parsed;
}

function lab_validation_reject_yaml_controls($raw)
{
    $blockIndent = null;
    foreach (preg_split('/\r\n|\n|\r/', $raw) as $line) {
        preg_match('/^ */', $line, $indentMatch);
        $indent = strlen($indentMatch[0]);
        if ($blockIndent !== null) {
            if (trim($line) === '' || $indent > $blockIndent) continue;
            $blockIndent = null;
        }
        $plain = ''; $quote = null; $length = strlen($line);
        for ($i = 0; $i < $length; $i++) {
            $char = $line[$i];
            if ($quote === "'") {
                if ($char === "'" && $i + 1 < $length && $line[$i + 1] === "'") { $i++; continue; }
                if ($char === "'") $quote = null;
                $plain .= ' ';
                continue;
            }
            if ($quote === '"') {
                if ($char === '\\') { $plain .= ' '; if ($i + 1 < $length) { $i++; $plain .= ' '; } continue; }
                if ($char === '"') $quote = null;
                $plain .= ' ';
                continue;
            }
            if ($char === "'" || $char === '"') { $quote = $char; $plain .= ' '; continue; }
            if ($char === '#' && ($i === 0 || ctype_space($line[$i - 1]))) break;
            $plain .= $char;
        }
        if (preg_match('/^\s*%/', $plain)
            || preg_match('/(^|[\s\[\]{},:?\-])!(?:!|<|[A-Za-z0-9_])/', $plain)
            || preg_match('/(^|[\s\[\]{},:?\-])[&*][^\s\[\]{},]+/', $plain)) {
            throw new LabValidationException('YAML directives, tags, anchors, and aliases are not allowed');
        }
        if (preg_match('/:\s*[>|][0-9+\-]*\s*$/', $plain)) $blockIndent = $indent;
    }
}

function lab_validation_bound_structure($value, $depth = 0, &$nodes = 0)
{
    $nodes++;
    if ($depth > 32 || $nodes > 5000) {
        throw new LabValidationException('Validation YAML is too complex');
    }
    if (is_array($value)) {
        foreach ($value as $key => $item) {
            if (!is_int($key) && (!is_string($key) || strlen($key) > 160)) {
                throw new LabValidationException('Invalid validation YAML key');
            }
            lab_validation_bound_structure($item, $depth + 1, $nodes);
        }
    } elseif (!is_null($value) && !is_scalar($value)) {
        throw new LabValidationException('Invalid validation YAML value');
    }
}

function lab_validation_yaml_encode($document)
{
    if (!function_exists('yaml_emit')) {
        throw new LabValidationException('YAML support is unavailable', 500);
    }
    $yaml = @yaml_emit($document, defined('YAML_UTF8_ENCODING') ? YAML_UTF8_ENCODING : 0,
        defined('YAML_LN_BREAK') ? YAML_LN_BREAK : 0);
    if (!is_string($yaml) || strlen($yaml) > 1024 * 1024) {
        throw new LabValidationException('Could not encode validation YAML', 500);
    }
    return $yaml;
}

function lab_validation_atomic_write($path, $bytes)
{
    lab_validation_assert_no_symlink_path($path);
    $dir = dirname($path);
    lab_validation_ensure_dir($dir);
    $tmp = tempnam($dir, '.validation-');
    if ($tmp === false) throw new LabValidationException('Could not create validation temporary file', 500);
    $fp = @fopen($tmp, 'wb');
    $ok = false;
    if ($fp) {
        $written = fwrite($fp, $bytes);
        $ok = ($written === strlen($bytes) && fflush($fp));
        if ($ok && function_exists('fsync')) $ok = @fsync($fp);
        fclose($fp);
    }
    @chmod($tmp, 0660);
    if (!$ok || !@rename($tmp, $path)) {
        @unlink($tmp);
        throw new LabValidationException('Could not save lab validations', 500);
    }
}

function lab_validation_node_catalog($lab)
{
    $nodes = array();
    foreach ($lab->getNodes() as $id => $node) {
        $nodes[] = array(
            'id' => (int) $id,
            'name' => (string) $node->getName(),
            'type' => (string) $node->getNType(),
            'template' => (string) $node->getTemplate(),
        );
    }
    return $nodes;
}

function lab_validation_clean_id($value, $what)
{
    if (!is_string($value) || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $value)) {
        throw new LabValidationException('Invalid ' . $what . ' id');
    }
    return $value;
}

function lab_validation_clean_text($value, $what, $max)
{
    if (!is_string($value) || preg_match('//u', $value) !== 1 || strlen($value) > $max) {
        throw new LabValidationException('Invalid ' . $what);
    }
    return $value;
}

function lab_validation_is_list($value)
{
    if (!is_array($value)) return false;
    $expected = 0;
    foreach ($value as $key => $unused) if ($key !== $expected++) return false;
    return true;
}

function lab_validation_validate_tasks($tasks, $lab, $strictNodes = true, $strictLegacyTasks = true)
{
    if (!lab_validation_is_list($tasks) || count($tasks) > 100) {
        throw new LabValidationException('A lab can contain no more than 100 validation tasks');
    }
    $nodeIds = array();
    foreach (lab_validation_node_catalog($lab) as $node) $nodeIds[(string) $node['id']] = true;
    $legacyTasks = array();
    foreach ($lab->getTasks() as $legacyTask) $legacyTasks[(string) $legacyTask['name']] = true;
    $taskIds = array(); $checkIds = array(); $totalChecks = 0; $clean = array();
    foreach ($tasks as $task) {
        if (!is_array($task)) throw new LabValidationException('Invalid validation task');
        foreach (array_keys($task) as $key) {
            if (!in_array($key, array('id','title','text_task','instructions','points','checks'), true)) {
                throw new LabValidationException('Unknown validation task field: ' . $key);
            }
        }
        $id = lab_validation_clean_id(isset($task['id']) ? $task['id'] : '', 'task');
        if (isset($taskIds[$id])) throw new LabValidationException('Duplicate task id: ' . $id);
        $taskIds[$id] = true;
        $title = trim(lab_validation_clean_text(isset($task['title']) ? $task['title'] : '', 'task title', 160));
        if ($title === '') throw new LabValidationException('Task title is required');
        $instructions = lab_validation_clean_text(isset($task['instructions']) ? $task['instructions'] : '', 'task instructions', 16384);
        $textTask = isset($task['text_task']) && $task['text_task'] !== null
            ? lab_validation_clean_text($task['text_task'], 'text task reference', 160) : null;
        if ($strictLegacyTasks && $textTask !== null && !isset($legacyTasks[$textTask])) {
            throw new LabValidationException('Unknown text task reference: ' . $textTask);
        }
        $points = filter_var(isset($task['points']) ? $task['points'] : null, FILTER_VALIDATE_INT);
        if ($points === false || $points < 1 || $points > 1000) throw new LabValidationException('Task points must be between 1 and 1000');
        $checks = isset($task['checks']) ? $task['checks'] : null;
        if (!lab_validation_is_list($checks) || count($checks) < 1) throw new LabValidationException('Every validation task needs at least one check');
        $cleanChecks = array();
        foreach ($checks as $check) {
            if (!is_array($check)) throw new LabValidationException('Invalid validation check');
            $check['id'] = lab_validation_clean_id(isset($check['id']) ? $check['id'] : '', 'check');
            if (isset($checkIds[$check['id']])) throw new LabValidationException('Duplicate check id: ' . $check['id']);
            $checkIds[$check['id']] = true;
            $check['title'] = trim(lab_validation_clean_text(isset($check['title']) ? $check['title'] : '', 'check title', 160));
            if ($check['title'] === '') throw new LabValidationException('Check title is required');
            if (!isset($check['source_node']) || !is_int($check['source_node'])) {
                throw new LabValidationException('Check source_node must be an integer');
            }
            $check['source_node'] = (int) $check['source_node'];
            if ($strictNodes && !isset($nodeIds[(string) $check['source_node']])) {
                throw new LabValidationException('Unknown source node: ' . $check['source_node']);
            }
            if (!function_exists('lab_validation_validate_check')) {
                throw new LabValidationException('Validation adapter is unavailable', 500);
            }
            $check = lab_validation_validate_check($check);
            if (!is_array($check)) {
                throw new LabValidationException('Validation adapter returned an invalid check', 500);
            }
            $cleanChecks[] = $check;
            $totalChecks++;
            if ($totalChecks > 100) throw new LabValidationException('A lab can contain no more than 100 checks');
        }
        $clean[] = array('id' => $id, 'title' => $title, 'text_task' => $textTask,
            'instructions' => $instructions, 'points' => (int) $points, 'checks' => $cleanChecks);
    }
    return $clean;
}

function lab_validation_load($lab)
{
    return lab_validation_with_lock($lab->getFile(), false, function ($dir) {
        $path = $dir . '/tasks.yaml';
        lab_validation_assert_no_symlink_path($path);
        if (!is_file($path)) return lab_validation_default_document();
        if (@filesize($path) > 1024 * 1024) throw new LabValidationException('Stored validation YAML is too large', 500);
        $raw = @file_get_contents($path);
        if ($raw === false) throw new LabValidationException('Could not read lab validations', 500);
        return lab_validation_validate_document(lab_validation_yaml_decode($raw), true);
    });
}

function lab_validation_save($lab, $tasks, $baseRevision)
{
    $requestedRevision = filter_var($baseRevision, FILTER_VALIDATE_INT);
    if ($requestedRevision === false || $requestedRevision < 0) {
        throw new LabValidationException('Invalid base revision');
    }
    $clean = lab_validation_validate_tasks($tasks, $lab);
    return lab_validation_with_lock($lab->getFile(), true, function ($dir) use ($lab, $clean, $requestedRevision) {
        $path = $dir . '/tasks.yaml';
        lab_validation_assert_no_symlink_path($path);
        if (is_file($path) && @filesize($path) > 1024 * 1024) {
            throw new LabValidationException('Stored validation YAML is too large', 500);
        }
        if (is_file($path)) {
            $raw = @file_get_contents($path);
            if ($raw === false) throw new LabValidationException('Could not read lab validations', 500);
            $current = lab_validation_validate_document(lab_validation_yaml_decode($raw), true);
        } else {
            $current = lab_validation_default_document();
        }
        $revision = max(0, (int) (isset($current['revision']) ? $current['revision'] : 0));
        if ((int) $requestedRevision !== $revision) throw new LabValidationException('Validation definitions changed; reload and try again', 409);
        $doc = array('schema_version' => 1, 'revision' => $revision + 1,
            'source_nodes' => lab_validation_node_catalog($lab), 'tasks' => $clean);
        lab_validation_atomic_write($path, lab_validation_yaml_encode($doc));
        return $doc;
    });
}

function lab_validation_principal_key($user)
{
    $username = isset($user['username']) ? (string) $user['username'] : '';
    $pod = isset($user['pod']) ? (string) $user['pod'] : '';
    if ($username === '' || $pod === '') throw new LabValidationException('Invalid learner identity', 500);
    return hash('sha256', $username . "\0" . $pod);
}

function lab_validation_check_hash($check)
{
    $copy = lab_validation_canonicalize($check);
    return hash('sha256', json_encode($copy, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
}

function lab_validation_canonicalize($value)
{
    if (!is_array($value)) return $value;
    if (!lab_validation_is_list($value)) ksort($value);
    foreach ($value as $key => $item) $value[$key] = lab_validation_canonicalize($item);
    return $value;
}

function lab_validation_progress_load($lab, $user)
{
    return lab_validation_with_lock($lab->getFile(), false, function ($dir) use ($user) {
        $path = $dir . '/progress/' . lab_validation_principal_key($user) . '.json';
        lab_validation_assert_no_symlink_path($path);
        if (!is_file($path)) return array('checks' => array());
        if (@filesize($path) > 1024 * 1024) throw new LabValidationException('Stored validation progress is too large', 500);
        $raw = @file_get_contents($path);
        if ($raw === false) throw new LabValidationException('Could not read validation progress', 500);
        $data = json_decode($raw, true);
        if (!is_array($data) || !isset($data['checks']) || !is_array($data['checks'])) {
            throw new LabValidationException('Stored validation progress is invalid', 500);
        }
        return $data;
    });
}

function lab_validation_summary($tasks, $storedChecks)
{
    $checks = array(); $totalPoints = 0.0; $earnedPoints = 0.0;
    $counts = array('passed' => 0, 'failed' => 0, 'unknown' => 0, 'error' => 0, 'not_run' => 0);
    foreach ($tasks as $task) {
        $n = count($task['checks']); $passed = 0; $totalPoints += (float) $task['points'];
        foreach ($task['checks'] as $check) {
            $id = $check['id']; $hash = lab_validation_check_hash($check);
            $result = isset($storedChecks[$id]) && isset($storedChecks[$id]['definition_hash']) && hash_equals($hash, (string) $storedChecks[$id]['definition_hash'])
                ? $storedChecks[$id] : array('status' => 'not_run', 'attempts' => 0);
            $status = isset($counts[$result['status']]) ? $result['status'] : 'error';
            $result['status'] = $status; $checks[$id] = $result; $counts[$status]++;
            if ($status === 'passed') $passed++;
        }
        $earnedPoints += ((float) $task['points']) * $passed / $n;
    }
    $percent = $totalPoints > 0 ? round(100 * $earnedPoints / $totalPoints, 1) : 0;
    return array('checks' => (object) $checks, 'summary' => array_merge(array(
        'total_points' => $totalPoints, 'earned_points' => round($earnedPoints, 2), 'percent' => $percent,
    ), $counts));
}

function lab_validation_snapshot($lab, $user)
{
    $doc = lab_validation_load($lab);
    // Keep definitions visible when an author later deletes a source node or
    // renames a linked rich-text task. A subsequent save must repair them.
    $tasks = lab_validation_validate_tasks($doc['tasks'], $lab, false, false);
    $progress = lab_validation_progress_load($lab, $user);
    $results = lab_validation_summary($tasks, $progress['checks']);
    $legacy = array();
    foreach ($lab->getTasks() as $task) $legacy[] = array('id' => (string) $task['name'], 'title' => (string) $task['name']);
    $canAuthor = false;
    try { checkLabPermission($lab, USER_PER_EDIT_TASKS); $canAuthor = true; } catch (Exception $e) {}
    return array('schema_version' => 1, 'revision' => $doc['revision'], 'tasks' => $tasks,
        'nodes' => lab_validation_node_catalog($lab), 'legacy_tasks' => $legacy,
        'results' => $results, 'can_author' => $canAuthor);
}

function lab_validation_find_check($tasks, $checkId)
{
    foreach ($tasks as $task) foreach ($task['checks'] as $check) if ($check['id'] === $checkId) return $check;
    throw new LabValidationException('Validation check not found', 404);
}

function lab_validation_store_result($lab, $user, $check, $result)
{
    return lab_validation_with_lock($lab->getFile(), true, function ($dir) use ($user, $check, $result) {
        $progressDir = $dir . '/progress'; lab_validation_ensure_dir($progressDir);
        $path = $progressDir . '/' . lab_validation_principal_key($user) . '.json';
        lab_validation_assert_no_symlink_path($path);
        if (is_file($path)) {
            if (@filesize($path) > 1024 * 1024) throw new LabValidationException('Stored validation progress is too large', 500);
            $raw = @file_get_contents($path);
            if ($raw === false) throw new LabValidationException('Could not read validation progress', 500);
            $data = json_decode($raw, true);
        } else {
            $data = array();
        }
        if (!is_array($data)) throw new LabValidationException('Stored validation progress is invalid', 500);
        if (!isset($data['checks']) || !is_array($data['checks'])) $data['checks'] = array();
        $oldAttempts = isset($data['checks'][$check['id']]['attempts']) ? (int) $data['checks'][$check['id']]['attempts'] : 0;
        $status = isset($result['status']) ? $result['status'] : 'error';
        if (!in_array($status, array('passed','failed','unknown','error'), true)) $status = 'error';
        $entry = array('definition_hash' => lab_validation_check_hash($check), 'status' => $status,
            'attempts' => $oldAttempts + 1, 'updated_at' => gmdate('c'));
        if (isset($result['detail'])) {
            $detail = substr((string) $result['detail'], 0, 4096);
            $entry['detail'] = preg_match('//u', $detail) === 1 ? $detail : 'Validation returned invalid text';
        }
        if (isset($result['observed']) && (is_array($result['observed']) || is_scalar($result['observed']))) {
            $observed = $result['observed'];
            $encoded = json_encode($observed, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if (is_string($encoded) && strlen($encoded) <= 8192) $entry['observed'] = $observed;
        }
        $data['schema_version'] = 1;
        $data['principal'] = array('username' => (string) $user['username'], 'pod' => (int) $user['pod']);
        $data['checks'][$check['id']] = $entry;
        $encoded = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if (!is_string($encoded)) throw new LabValidationException('Could not encode validation progress', 500);
        if (strlen($encoded) > 1024 * 1024) throw new LabValidationException('Validation progress is too large', 500);
        lab_validation_atomic_write($path, $encoded);
        return $entry;
    });
}

function lab_validation_export($lab)
{
    $doc = lab_validation_load($lab);
    $nodes = array();
    foreach ($doc['source_nodes'] as $node) {
        if (is_array($node) && isset($node['id']) && (is_int($node['id']) || is_string($node['id']))) {
            $nodes[(string) $node['id']] = $node;
        }
    }
    foreach (lab_validation_node_catalog($lab) as $node) $nodes[(string) $node['id']] = $node;
    $doc['source_nodes'] = array_values($nodes);
    return lab_validation_yaml_encode($doc);
}

function lab_validation_import($lab, $raw, $baseRevision, $nodeMapping = array(), $preview = false)
{
    $import = lab_validation_validate_document(lab_validation_yaml_decode($raw), false);
    if (!is_array($nodeMapping)) throw new LabValidationException('Invalid node mapping');
    $currentNodes = lab_validation_node_catalog($lab); $byId = array(); $byIdentity = array();
    foreach ($currentNodes as $node) { $byId[(string)$node['id']] = $node; $byIdentity[$node['name']."\0".$node['type']][] = $node['id']; }
    $cleanMapping = array();
    foreach ($nodeMapping as $old => $new) {
        if ((!is_int($old) && !is_string($old)) || (!is_int($new) && !is_string($new))
            || !preg_match('/^-?[0-9]+$/', (string) $old) || !preg_match('/^-?[0-9]+$/', (string) $new)) {
            throw new LabValidationException('Invalid node mapping');
        }
        $cleanMapping[(string) $old] = (string) $new;
    }
    $source = array();
    foreach ((array) (isset($import['source_nodes']) ? $import['source_nodes'] : array()) as $node) {
        if (!is_array($node) || !isset($node['id']) || (!is_int($node['id']) && !is_string($node['id']))) continue;
        $cleanSource = array('id' => $node['id']);
        foreach (array('name','type','template') as $key) if (isset($node[$key]) && is_string($node[$key])) $cleanSource[$key] = $node[$key];
        $source[(string) $node['id']] = $cleanSource;
    }
    $resolved = array(); $unresolved = array(); $tasks = $import['tasks'];
    foreach ($tasks as &$task) if (is_array($task) && isset($task['checks']) && is_array($task['checks'])) foreach ($task['checks'] as &$check) {
        if (!is_array($check) || !isset($check['source_node'])) continue;
        if (!is_int($check['source_node'])) continue;
        $old = (string) $check['source_node']; $new = isset($cleanMapping[$old]) ? $cleanMapping[$old] : null;
        if ($new !== null) {
            if (isset($byId[$new])) { $resolved[$old] = (int)$new; $check['source_node'] = (int)$new; continue; }
            $unresolved[$old] = isset($source[$old]) ? $source[$old] : array('id' => $old);
            continue;
        }
        if (isset($source[$old]) && isset($source[$old]['name'], $source[$old]['type'])) {
            $key = (string)$source[$old]['name']."\0".(string)$source[$old]['type'];
            if (isset($byIdentity[$key]) && count($byIdentity[$key]) === 1) { $resolved[$old] = (int)$byIdentity[$key][0]; $check['source_node'] = (int)$byIdentity[$key][0]; continue; }
        }
        $unresolved[$old] = isset($source[$old]) ? $source[$old] : array('id' => $old);
    }
    unset($check, $task);
    $tasks = lab_validation_validate_tasks($tasks, $lab, false, true);
    if ($preview) return array('resolved' => (object) $resolved, 'unresolved' => array_values($unresolved), 'tasks' => $tasks);
    if (!empty($unresolved)) throw new LabValidationException('Imported source nodes need mapping', 400, array('unresolved' => array_values($unresolved)));
    return lab_validation_save($lab, $tasks, $baseRevision);
}

function lab_validation_tree_delete($path)
{
    if (is_link($path) || is_file($path)) return @unlink($path);
    if (!is_dir($path)) return true;
    foreach (scandir($path) as $name) if ($name !== '.' && $name !== '..') {
        if (!lab_validation_tree_delete($path . '/' . $name)) return false;
    }
    return @rmdir($path);
}

function lab_validation_tree_copy($source, $destination, $definitionsOnly = false)
{
    if (!is_dir($source)) return true;
    lab_validation_ensure_dir($destination);
    foreach (scandir($source) as $name) {
        if ($name === '.' || $name === '..' || $name === '.lock' || ($definitionsOnly && $name !== 'tasks.yaml')) continue;
        if (is_link($source . '/' . $name)) return false;
        if (is_dir($source . '/' . $name)) {
            if (!lab_validation_tree_copy($source . '/' . $name, $destination . '/' . $name, false)) return false;
        } elseif (!@copy($source . '/' . $name, $destination . '/' . $name)) return false;
    }
    return true;
}

function lab_validation_result_succeeded($result)
{
    return is_array($result) && isset($result['status']) && $result['status'] === 'success';
}

function lab_validation_move_transaction($oldLabFile, $newLabFile, $operation)
{
    return lab_validation_with_lifecycle_lock(function () use ($oldLabFile, $newLabFile, $operation) {
        $old = lab_validation_dir_for_file($oldLabFile); $new = lab_validation_dir_for_file($newLabFile);
        $moved = false;
        if (is_dir($old)) {
            if (file_exists($new)) throw new LabValidationException('Validation destination already exists', 409);
            lab_validation_ensure_dir(dirname($new));
            if (!@rename($old, $new)) throw new LabValidationException('Could not move lab validations', 500);
            $moved = true;
        }
        try {
            $result = $operation();
            if (!lab_validation_result_succeeded($result) && $moved) @rename($new, $old);
            return $result;
        } catch (Throwable $e) {
            if ($moved) @rename($new, $old);
            throw $e;
        }
    });
}

function lab_validation_clone_transaction($sourceLabFile, $destinationLabFile, $operation)
{
    return lab_validation_with_lifecycle_lock(function () use ($sourceLabFile, $destinationLabFile, $operation) {
        $destination = lab_validation_dir_for_file($destinationLabFile);
        if (file_exists($destination)) {
            throw new LabValidationException('Validation destination already exists', 409);
        }
        $result = $operation();
        if (!lab_validation_result_succeeded($result)) return $result;
        $source = lab_validation_dir_for_file($sourceLabFile);
        if (!lab_validation_tree_copy($source, $destination, true)) {
            lab_validation_tree_delete($destination);
            @unlink($destinationLabFile);
            throw new LabValidationException('Could not copy lab validations; clone was rolled back', 500);
        }
        return $result;
    });
}

function lab_validation_delete_transaction($labFile, $operation)
{
    return lab_validation_with_lifecycle_lock(function () use ($labFile, $operation) {
        $source = lab_validation_dir_for_file($labFile);
        $trash = lab_validation_root() . '/.trash/' . bin2hex(random_bytes(12));
        $staged = false;
        if (is_dir($source)) {
            lab_validation_ensure_dir(dirname($trash));
            if (!@rename($source, $trash)) throw new LabValidationException('Could not stage lab validations for deletion', 500);
            $staged = true;
        }
        try {
            $result = $operation();
            if (!lab_validation_result_succeeded($result)) {
                if ($staged) @rename($trash, $source);
                return $result;
            }
            if ($staged && !lab_validation_tree_delete($trash)) {
                error_log('Could not remove staged validation data ' . $trash);
            }
            return $result;
        } catch (Throwable $e) {
            if ($staged) @rename($trash, $source);
            throw $e;
        }
    });
}

function lab_validation_folder_move_transaction($oldPath, $newPath, $operation)
{
    return lab_validation_with_lifecycle_lock(function () use ($oldPath, $newPath, $operation) {
        $old = lab_validation_dir_for_folder($oldPath); $new = lab_validation_dir_for_folder($newPath);
        $moved = false;
        if (is_dir($old)) {
            if (file_exists($new)) throw new LabValidationException('Validation folder destination already exists', 409);
            lab_validation_ensure_dir(dirname($new));
            if (!@rename($old, $new)) throw new LabValidationException('Could not move folder validations', 500);
            $moved = true;
        }
        try {
            $result = $operation();
            if (!lab_validation_result_succeeded($result) && $moved) @rename($new, $old);
            return $result;
        } catch (Throwable $e) {
            if ($moved) @rename($new, $old);
            throw $e;
        }
    });
}

function lab_validation_folder_delete_transaction($folderPath, $operation)
{
    return lab_validation_with_lifecycle_lock(function () use ($folderPath, $operation) {
        $source = lab_validation_dir_for_folder($folderPath);
        $trash = lab_validation_root() . '/.trash/' . bin2hex(random_bytes(12));
        $staged = false;
        if (is_dir($source)) {
            lab_validation_ensure_dir(dirname($trash));
            if (!@rename($source, $trash)) throw new LabValidationException('Could not stage folder validations', 500);
            $staged = true;
        }
        try {
            $result = $operation();
            if (!lab_validation_result_succeeded($result)) {
                if ($staged) @rename($trash, $source);
                return $result;
            }
            if ($staged && !lab_validation_tree_delete($trash)) error_log('Could not remove staged validation data ' . $trash);
            return $result;
        } catch (Throwable $e) {
            if ($staged) @rename($trash, $source);
            throw $e;
        }
    });
}

function lab_validation_lifecycle_move($oldLabFile, $newLabFile)
{
    return lab_validation_with_lifecycle_lock(function () use ($oldLabFile, $newLabFile) {
        $old = lab_validation_dir_for_file($oldLabFile); $new = lab_validation_dir_for_file($newLabFile);
        if (!is_dir($old)) return true;
        if (file_exists($new)) return false;
        lab_validation_ensure_dir(dirname($new));
        return @rename($old, $new);
    });
}

function lab_validation_lifecycle_clone($sourceLabFile, $destinationLabFile)
{
    return lab_validation_with_lifecycle_lock(function () use ($sourceLabFile, $destinationLabFile) {
        return lab_validation_tree_copy(lab_validation_dir_for_file($sourceLabFile), lab_validation_dir_for_file($destinationLabFile), true);
    });
}

function lab_validation_lifecycle_delete($labFile)
{
    return lab_validation_with_lifecycle_lock(function () use ($labFile) {
        return lab_validation_tree_delete(lab_validation_dir_for_file($labFile));
    });
}
