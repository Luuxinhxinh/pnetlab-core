<?php

/**
 * Session membership helpers shared by the engine APIs.
 *
 * lab_sessions.lab_session_joined is a legacy comma-separated list. Do not
 * use substring matching on it: pod 2 must not match pod 12. Values are
 * normalized as decimal strings so nulls, surrounding whitespace, and legacy
 * zero padding are harmless without relying on a platform-sized integer.
 */
function labSessionNormalizePod($value)
{
    $value = trim((string) $value);
    if ($value === '' || !preg_match('/^\d+$/D', $value)) {
        return null;
    }
    $value = ltrim($value, '0');
    return $value === '' ? '0' : $value;
}

function labSessionPodEquals($left, $right)
{
    $left = labSessionNormalizePod($left);
    $right = labSessionNormalizePod($right);
    return $left !== null && $right !== null && $left === $right;
}

function labSessionJoinedCsvContainsPod($joined, $tenant)
{
    $wanted = labSessionNormalizePod($tenant);
    if ($wanted === null) {
        return false;
    }
    foreach (preg_split('/\s*,\s*/', (string) $joined, -1, PREG_SPLIT_NO_EMPTY) as $candidate) {
        if (labSessionPodEquals($candidate, $wanted)) {
            return true;
        }
    }
    return false;
}

/** TRUE when an authenticated non-admin may see this session row. */
function labSessionVisibleTo($session, $tenant, $isAdmin = false)
{
    if ($isAdmin) {
        return true;
    }
    if (!is_array($session)) {
        return false;
    }
    return labSessionPodEquals(
        isset($session['lab_session_pod']) ? $session['lab_session_pod'] : null,
        $tenant
    ) || labSessionJoinedCsvContainsPod(
        isset($session['lab_session_joined']) ? $session['lab_session_joined'] : null,
        $tenant
    );
}

/** TRUE only for administrators or the session owner (not a joiner). */
function labSessionCanManage($session, $tenant, $isAdmin = false)
{
    return $isAdmin || (
        is_array($session) && labSessionPodEquals(
            isset($session['lab_session_pod']) ? $session['lab_session_pod'] : null,
            $tenant
        )
    );
}
