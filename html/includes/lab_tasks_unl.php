<?php

/**
 * Decode one EVE task payload under the compatibility limits.
 *
 * @return array{ok: bool, html: ?string, reason: ?string}
 */
function unlTaskDecodeDetailed(string $b64): array
{
    try {
        $maxEncodedBytes = 2 * 1024 * 1024;
        $maxDecodedBytes = 3 * 1024 * 1024 / 2;

        if (strlen($b64) > $maxEncodedBytes) {
            return ['ok' => false, 'html' => null, 'reason' => 'too_large'];
        }

        $html = base64_decode($b64, true);
        if ($html === false) {
            return ['ok' => false, 'html' => null, 'reason' => 'decode_failed'];
        }

        if (strlen($html) > $maxDecodedBytes) {
            return ['ok' => false, 'html' => null, 'reason' => 'too_large'];
        }

        if (!function_exists('mb_check_encoding') || !mb_check_encoding($html, 'UTF-8')) {
            return ['ok' => false, 'html' => null, 'reason' => 'invalid_utf8'];
        }

        return ['ok' => true, 'html' => $html, 'reason' => null];
    } catch (\Throwable $exception) {
        return ['ok' => false, 'html' => null, 'reason' => 'decode_failed'];
    }
}

/**
 * Decode one base64 <data> payload under the plan's D9 size/format limits.
 */
function unlTaskDecode(string $b64): ?string
{
    $decoded = unlTaskDecodeDetailed($b64);

    return $decoded['ok'] ? $decoded['html'] : null;
}

/**
 * Read an EVE task attribute without applying validation or normalization.
 */
function unlTaskEveAttribute($task, string $name): string
{
    try {
        $attributes = $task->attributes();

        if ($attributes !== null && isset($attributes[$name])) {
            return (string) $attributes[$name];
        }
    } catch (\Throwable $exception) {
        // The public parser is deliberately best-effort for malformed XML.
    }

    return '';
}

/**
 * Parse EVE-NG <objects><tasks> out of raw .unl XML.
 *
 * The parser intentionally walks direct children instead of using a broad
 * descendant query. This handles EVE's empty trailing <objects/> sibling and
 * keeps unrelated XML elements out of the task stream.
 */
function unlTasksParseEve(string $xmlRaw): array
{
    $empty = ['tasks' => [], 'skipped' => []];

    try {
        if ($xmlRaw === '' || !function_exists('simplexml_load_string')) {
            return $empty;
        }

        $xmlFlags = 0;
        if (defined('LIBXML_NONET')) {
            $xmlFlags |= LIBXML_NONET;
        }
        if (defined('LIBXML_NOERROR')) {
            $xmlFlags |= LIBXML_NOERROR;
        }
        if (defined('LIBXML_NOWARNING')) {
            $xmlFlags |= LIBXML_NOWARNING;
        }
        if (defined('LIBXML_NOCDATA')) {
            $xmlFlags |= LIBXML_NOCDATA;
        }

        $lab = @simplexml_load_string($xmlRaw, 'SimpleXMLElement', $xmlFlags);
        if ($lab === false || (string) $lab->getName() !== 'lab') {
            return $empty;
        }

        $maxTasks = 200;
        $maxDecodedBytesPerLab = 8 * 1024 * 1024;
        $taskElementsSeen = 0;
        $decodedBytesInLab = 0;
        $result = $empty;

        foreach ($lab->children() as $objects) {
            if ((string) $objects->getName() !== 'objects') {
                continue;
            }

            foreach ($objects->children() as $tasksBlock) {
                if ((string) $tasksBlock->getName() !== 'tasks') {
                    continue;
                }

                foreach ($tasksBlock->children() as $task) {
                    if ((string) $task->getName() !== 'task') {
                        continue;
                    }

                    $taskElementsSeen++;
                    $id = unlTaskEveAttribute($task, 'id');
                    $name = unlTaskEveAttribute($task, 'name');
                    $type = unlTaskEveAttribute($task, 'type');

                    if ($taskElementsSeen > $maxTasks) {
                        $result['skipped'][] = [
                            'id' => $id,
                            'name' => $name,
                            'reason' => 'too_many',
                        ];
                        continue;
                    }

                    if ($name === '') {
                        $result['skipped'][] = [
                            'id' => $id,
                            'name' => '',
                            'reason' => 'missing_name',
                        ];
                        continue;
                    }

                    $hasData = false;
                    $data = '';
                    foreach ($task->children() as $taskChild) {
                        if ((string) $taskChild->getName() === 'data') {
                            $hasData = true;
                            $data = (string) $taskChild;
                            break;
                        }
                    }

                    if (!$hasData) {
                        $result['skipped'][] = [
                            'id' => $id,
                            'name' => $name,
                            'reason' => 'decode_failed',
                        ];
                        continue;
                    }

                    $decoded = unlTaskDecodeDetailed($data);
                    if (!$decoded['ok']) {
                        $result['skipped'][] = [
                            'id' => $id,
                            'name' => $name,
                            'reason' => $decoded['reason'],
                        ];
                        continue;
                    }

                    $html = $decoded['html'];
                    $htmlBytes = strlen($html);
                    if ($decodedBytesInLab + $htmlBytes > $maxDecodedBytesPerLab) {
                        $result['skipped'][] = [
                            'id' => $id,
                            'name' => $name,
                            'reason' => 'too_large',
                        ];
                        continue;
                    }

                    $decodedBytesInLab += $htmlBytes;
                    $result['tasks'][] = [
                        'id' => $id,
                        'name' => $name,
                        'type' => $type,
                        'html' => $html,
                    ];
                }
            }
        }

        return $result;
    } catch (\Throwable $exception) {
        return $empty;
    }
}
