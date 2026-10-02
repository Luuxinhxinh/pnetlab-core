<?php
# vim: syntax=php tabstop=4 softtabstop=0 noexpandtab laststatus=1 ruler

/**
 * html/includes/api_templatedefaults.php
 *
 * Per-template default overrides for the Add/Edit Node modal. When an admin
 * saves a node's field values "as the template default", they are persisted
 * here and merged into every subsequent /api/list/templates/<t> response so all
 * future Add-Node operations start from those values. "Revert" deletes the
 * override file, restoring the factory template defaults.
 *
 * Storage is an upgrade-safe side store under /opt/unetlab/data (www-data
 * writable, NOT a deb-owned path), one JSON file per template:
 *     /opt/unetlab/data/template-defaults/<template>.json   = { key: value, ... }
 *
 * On every save/revert the directory is mirrored to all joined satellites via
 * the brokerd `cluster_sync_templdefaults` verb (no-op on single-host installs),
 * so template changes follow the cluster automatically.
 */

define('TEMPLATE_DEFAULTS_DIR', '/opt/unetlab/data/template-defaults');

// Keys that are per-NODE-instance (or server-derived) and must never be stored
// as a template default. 'type'/'template' are also protected at apply time.
$GLOBALS['TEMPLATE_DEFAULTS_SKIP'] = array(
	'id', 'name', 'left', 'top', 'count', 'postfix', 'numberNodes',
	'template', 'type', 'node_id', 'status', 'config_list',
);

/**
 * Validate a template slug to a safe filename component. Templates are flat
 * names like 'vios', 'iol', 'docker-ng'; reject anything with a path separator.
 */
function template_defaults_valid_name($template)
{
	return is_string($template) && $template !== '' &&
		preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/', $template) === 1 &&
		strpos($template, '..') === false;
}

function template_defaults_path($template)
{
	if (!template_defaults_valid_name($template)) {
		return false;
	}
	return TEMPLATE_DEFAULTS_DIR . '/' . $template . '.json';
}

/**
 * Load the stored overrides for a template as an assoc array (empty if none).
 */
function template_defaults_load($template)
{
	$path = template_defaults_path($template);
	if ($path === false || !is_file($path)) {
		return array();
	}
	$data = json_decode(@file_get_contents($path), true);
	return is_array($data) ? $data : array();
}

/**
 * Merge stored overrides into a freshly built options array (the structure
 * returned by apiGetLabNodeTemplate: key => ['value'=>..., ...]). Only keys that
 * already exist in $params are touched, 'type'/'template' are never overridden,
 * and only scalar values are applied — so a stale override can never inject a
 * brand-new field or a non-scalar.
 */
function template_defaults_apply(&$params, $template)
{
	$overrides = template_defaults_load($template);
	if (empty($overrides)) {
		return;
	}
	foreach ($overrides as $key => $value) {
		if ($key === 'type' || $key === 'template') {
			continue;
		}
		if (!isset($params[$key]) || !is_array($params[$key])) {
			continue;
		}
		if (is_array($value) || is_object($value)) {
			continue;
		}
		$params[$key]['value'] = $value;
	}
}

/**
 * Persist the supplied field values as the template default. Strips
 * per-instance/server keys, keeps scalars only, writes atomically, then mirrors
 * to satellites. Returns true on success.
 */
function template_defaults_save($template, $values)
{
	$path = template_defaults_path($template);
	if ($path === false || !is_array($values)) {
		return false;
	}
	$clean = array();
	foreach ($values as $key => $value) {
		if (in_array($key, $GLOBALS['TEMPLATE_DEFAULTS_SKIP'], true)) {
			continue;
		}
		if (is_array($value) || is_object($value)) {
			continue;
		}
		$clean[$key] = $value;
	}
	if (!is_dir(TEMPLATE_DEFAULTS_DIR)) {
		@mkdir(TEMPLATE_DEFAULTS_DIR, 0775, true);
	}
	$tmp = $path . '.tmp';
	if (@file_put_contents($tmp, json_encode($clean, JSON_PRETTY_PRINT)) === false) {
		return false;
	}
	@chmod($tmp, 0664);
	if (!@rename($tmp, $path)) {
		@unlink($tmp);
		return false;
	}
	template_defaults_sync_satellites();
	return true;
}

/**
 * Remove a template's override (revert to factory) and mirror the removal to
 * satellites. Returns true if the file is gone afterwards.
 */
function template_defaults_delete($template)
{
	$path = template_defaults_path($template);
	if ($path === false) {
		return false;
	}
	if (is_file($path)) {
		@unlink($path);
	}
	template_defaults_sync_satellites();
	return !is_file($path);
}

/**
 * Mirror the template-defaults directory to every joined satellite. No-op when
 * no satellite has joined or the broker is unavailable; best-effort (a sync
 * hiccup never fails the save — the master stays the source of truth).
 */
function template_defaults_sync_satellites()
{
	if (!function_exists('cluster_hosts') || !function_exists('broker_call')) {
		return;
	}
	$hosts = cluster_hosts();
	foreach ($hosts as $hid => $h) {
		try {
			broker_call('cluster_sync_templdefaults', array('host' => (int) $hid), 60);
		} catch (Exception $e) {
			error_log(date('M d H:i:s ') . 'WARN: template-defaults sync to host ' .
				$hid . ' failed: ' . $e->getMessage());
		}
	}
}
