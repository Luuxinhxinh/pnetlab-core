<?php

/**
 * Track node starts (every type) during this host boot.
 *
 * node_session_running is durable database state, so it can remain set when an
 * appliance reboots underneath running containers. These markers deliberately
 * live in /dev/shm: a Docker node is eligible for a startup warning only after
 * a Start request during the current boot, and reboot clears old attempts.
 */
function pnqDockerStartMarkerPath($sessionId, $baseDir = null)
{
    $sessionId = (int) $sessionId;
    if ($sessionId <= 0) {
        return null;
    }

    $baseDir = $baseDir === null ? '/dev/shm/pnetlab-docker-starts' : $baseDir;
    return rtrim($baseDir, '/\\') . '/' . $sessionId . '.attempt';
}

function pnqMarkDockerStartAttempt($sessionId, $baseDir = null)
{
    $path = pnqDockerStartMarkerPath($sessionId, $baseDir);
    if ($path === null) {
        return false;
    }

    $dir = dirname($path);
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    if (!is_dir($dir) || is_link($dir)) {
        return false;
    }
    // Node lifecycle calls run through the root wrapper while the self-check
    // runs as www-data. The marker carries no user data; a shared writable
    // directory lets either path create or clear it.
    @chmod($dir, 0777);
    if (!@touch($path)) {
        return false;
    }
    return true;
}

function pnqHasDockerStartAttempt($sessionId, $baseDir = null)
{
    $path = pnqDockerStartMarkerPath($sessionId, $baseDir);
    return $path !== null && is_file($path);
}

function pnqClearDockerStartAttempt($sessionId, $baseDir = null)
{
    $path = pnqDockerStartMarkerPath($sessionId, $baseDir);
    return $path === null || !is_file($path) || @unlink($path);
}

/** A delayed start that is later observed live has completed; discard its failure marker. */
function pnqClearDockerStartAttemptIfRunning($sessionId, $status, $baseDir = null)
{
    if (!in_array((int) $status, [2, 3], true)) {
        return false;
    }
    return pnqClearDockerStartAttempt($sessionId, $baseDir);
}

/**
 * A startup warning needs a Start attempt during this host boot, for every node
 * type. node_session_running is durable and survives a reboot (or a never-started
 * lab), so on its own it only says "was running once", not "a start just failed".
 */
function pnqNodeErrorCandidateEligible($type, $runningFlag, $startPending)
{
    return (bool) $startPending;
}

/** Reconcile one known local Docker inspect result into the stored lab tally. */
function pnqReconcileDockerRunningCount($currentCount, $storedRunning, $inspectKnown, $actuallyRunning)
{
    if (!$inspectKnown) {
        return (int) $currentCount;
    }
    return max(0, (int) $currentCount - ((int) $storedRunning === 1 ? 1 : 0) + ($actuallyRunning ? 1 : 0));
}
