<?php
/**
 * login/index.php — Dynamic Entrypoint for Login Portal with Automatic Git Cache-Busting.
 * Serves login UI with automated ?v=<git_commit_or_mtime> so developers never have to
 * manually bump version query strings when editing CSS/JS.
 */
function getAssetVersion(string $relPath): string
{
    static $gitHash = null;
    if ($gitHash === null) {
        $gitFile = '/opt/unetlab/.git/HEAD';
        if (is_readable($gitFile)) {
            $headContent = trim((string) @file_get_contents($gitFile));
            if (str_starts_with($headContent, 'ref:')) {
                $refPath = '/opt/unetlab/.git/' . trim(substr($headContent, 4));
                if (is_readable($refPath)) {
                    $gitHash = substr(trim((string) @file_get_contents($refPath)), 0, 8);
                }
            } elseif (strlen($headContent) >= 8) {
                $gitHash = substr($headContent, 0, 8);
            }
        }
        if (!$gitHash) {
            $gitHash = 'v8';
        }
    }

    $fullPath = '/opt/unetlab/html' . $relPath;
    $mtime = is_file($fullPath) ? filemtime($fullPath) : 0;
    return $gitHash . ($mtime ? '.' . substr(md5((string)$mtime), 0, 6) : '');
}

$html = file_get_contents(__DIR__ . '/index.html');

// Automatically replace ?v=... on CSS and JS with dynamic asset version
$html = preg_replace_callback(
    '/(href|src)=["\'](\/login\/[^"\']+\.(?:css|js))(?:\?v=[^"\']*)?["\']/i',
    function ($matches) {
        $attr = $matches[1];
        $file = $matches[2];
        $ver = getAssetVersion($file);
        return sprintf('%s="%s?v=%s"', $attr, $file, $ver);
    },
    $html
);

header('Content-Type: text/html; charset=utf-8');
echo $html;
