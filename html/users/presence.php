<?php
// Read-only summaries. Never return cookies, passwords or session identifiers.
function pnq_user_last_logins($db) {
    try {
        $rows = $db->query("SELECT pod, MAX(created_at) AS last_login_at FROM activity_log WHERE category='session' AND action='login' AND pod IS NOT NULL GROUP BY pod")->fetchAll(PDO::FETCH_ASSOC);
        $logins = [];
        foreach ($rows as $row) $logins[(int) $row['pod']] = (int) $row['last_login_at'];
        return $logins;
    } catch (Exception $e) {
        // Older appliances may not have audit history; do not invent a login.
        error_log('Users last-login history unavailable: ' . $e->getMessage());
        return [];
    }
}

function pnq_user_presence($row, $lastLogin, $allowed, $now) {
    $online = $allowed && !empty($row['has_login']) && (int) ($row['session'] ?? 0) >= $now;
    return [
        'login_status' => $online ? 'online' : 'offline',
        'last_login_at' => $lastLogin !== null && (int) $lastLogin > 0 ? (int) $lastLogin : null,
    ];
}
