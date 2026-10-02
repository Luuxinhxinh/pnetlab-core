<?php
# vim: syntax=php tabstop=4 softtabstop=0 noexpandtab laststatus=1 ruler

/**
 * html/includes/api_labs.php
 *
 * Labs related functions for REST APIs.
 *
 * @author Andrea Dainese <andrea.dainese@gmail.com>
 * @copyright 2014-2016 Andrea Dainese
 * @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
 * @link http://www.unetlab.com/
 * @version 20160719
 */

/*
 * Identity string to seed a lab's per-user permission lists with: the caller's
 * email when set, else their POD number as a string. checkLabPermission()
 * matches an allow-list entry against EITHER the user email OR the pod, so a
 * pod string works for the stock admin account (whose email is NULL). Returns
 * '' only when there is no authenticated user at all.
 */
function _labCreatorIdentity()
{
	$u = getUser();
	if (!$u) {
		return '';
	}
	if (isset($u['email']) && $u['email'] !== '' && $u['email'] !== null) {
		return $u['email'];
	}
	return isset($u['pod']) ? (string) $u['pod'] : '';
}

/*
 * True when the create/import request already carried explicit lab permission
 * intent, so the sensible defaults below must NOT overwrite it.
 */
function _labPermsGiven($p)
{
	return isset($p['openable']) || isset($p['joinable']) || isset($p['editable']) ||
		isset($p['openable_emails']) || isset($p['joinable_emails']) || isset($p['editable_emails']);
}

/*
 * Function to add a lab.
 *
 * @param	Array		$p				Parameters
 * @return	Array						Return code (JSend data)
 */
function apiAddLab($p, $tenant, $email = '')
{
	// Check mandatory parameters
	if (!isset($p['path']) || !isset($p['name'])) {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60017];
		return $output;
	}

	// Parent folder must exist
	if (!is_dir(BASE_LAB . $p['path'])) {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60018];
		return $output;
	}

	if ($p['path'] == '/') {
		$lab_file = '/' . $p['name'] . '.unl';
	} else {
		$lab_file = $p['path'] . '/' . $p['name'] . '.unl';
	}

	if (is_file(BASE_LAB . $lab_file)) {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60016];
		return $output;
	}

	$lab = new Lab(BASE_LAB . $lab_file, $tenant, null, $email);

	// Set author/description/version
	$rc = $lab->edit($p);
	if ($rc !== 0) {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	}

	// Permission defaults when the request set none explicitly. A freshly-seeded
	// lab is born (in __lab.php) openable/joinable/editable=2 with [$email] — but
	// $email is empty for the stock admin, so that list is [''] and NOBODY but an
	// admin can open it. Fix per creator:
	//   non-admin -> keep "specific users" (2) but list them by email-else-pod so
	//                the creator can actually open the lab they just made;
	//   admin     -> admin-only (0), the historical behaviour (change it later in
	//                the dashboard "Edit lab" permission UI).
	if (!_labPermsGiven($p)) {
		if (isAdmin()) {
			$lab->edit([
				'openable' => 0, 'joinable' => 0, 'editable' => 0,
				'openable_emails' => [], 'joinable_emails' => [], 'editable_emails' => [],
			]);
		} else {
			$me = _labCreatorIdentity();
			$lab->edit([
				'openable' => 2, 'joinable' => 2, 'editable' => 2,
				'openable_emails' => [$me], 'joinable_emails' => [$me], 'editable_emails' => [$me],
			]);
		}
	}

	// Printing info
	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = $GLOBALS['messages'][60019];
	return $output;
}

/*
 * Function to add a lab.
 *
 * @param	Array		$p				Parameters
 * @return	Array						Return code (JSend data)
 */
function apiCloneLab($p, $tenant, $email = '')
{
	// The clone name is written into a filesystem path below (copy() target)
	// with no basename()/checkLabPath() in between, unlike apiAddLab (which
	// routes through the Lab constructor's checkLabFilename() gate). Validate
	// it against the same canonical lab_name rule used everywhere else, so a
	// name like "../../../etc/foo" or "x/../../y" can't escape the source's
	// folder. This matches what any real "New lab"/rename/clone already
	// produces (checkLabName is the shared charset for a legal lab name).
	if (!isset($p['name']) || $p['name'] === '' || !checkLabName($p['name'])) {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60017];
		return $output;
	}

	$rc = checkFolder(BASE_LAB . dirname($p['source']));
	if ($rc === 2) {
		// Folder is not valid
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60009];
		return $output;
	} else if ($rc === 1) {
		// Folder does not exist
		$output['code'] = 404;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60008];
		return $output;
	}

	if (!is_file(BASE_LAB . $p['source'])) {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60000];
		return $output;
	}

	if (!copy(BASE_LAB . $p['source'], BASE_LAB . dirname($p['source']) . '/' . $p['name'] . '.unl')) {
		// Failed to copy
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60037];
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][60037]);
		return $output;
	}


	$lab = new Lab(BASE_LAB . dirname($p['source']) . '/' . $p['name'] . '.unl', $tenant, null, $email);


	$rc = $lab->edit($p);
	$lab->setId();
	if ($rc !== 0) {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	} else {
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60036];
	}

	return $output;
}

/*
 * Function to delete a lab.
 *
 * @param	string		$lab_id			Lab ID
 * @param	string		$lab_file		Lab file
 * @return	Array						Return code (JSend data)
 */
function apiDeleteLab($lab)
{
	if ($lab->isRunning()) throw new ResponseException('error_lab_running', ['data' => $lab->getName()]);
	return lab_validation_delete_transaction($lab->getFile(), function () use ($lab) {
		if (!unlink($lab->getFile())) throw new LabValidationException('Could not delete lab', 500);
		return array('code' => 200, 'status' => 'success', 'message' => $GLOBALS['messages'][60022]);
	});
}

/*
 * Function to edit a lab.
 *
 * @param	Lab			$lab			Lab
 * @param	Array		$lab			Parameters
 * @return	Array						Return code (JSend data)
 */
function apiEditLab($lab, $p)
{
	$oldFile = $lab->getFile();
	$newFile = $oldFile;
	$willRename = isset($p['name']) && $lab->getName() != $p['name']
		&& checkLabFilename($p['name'] . '.unl');
	if ($willRename) {
		$newFile = $lab->getPath() . '/' . $p['name'] . '.unl';
	}
	// Set author/description/version
	if (isset($p['name']) && $lab->getName() != $p['name']) {
		checkWorkSpace(substr($lab->getFile(), strlen(BASE_LAB)), checkSharePermission(USER_PER_RENAME_LAB));
		checkPermission(USER_PER_RENAME_LAB);
	}

	$oldName = $lab->getName();
	$wasRunning = $lab->isRunning();
	$editOperation = function () use ($lab, $p, $oldName, $wasRunning, $willRename) {
		$rc = $lab->edit($p);
		if ($rc !== 0) return array('code' => 400, 'status' => 'fail', 'message' => $GLOBALS['messages'][$rc]);
		if ($wasRunning && $willRename) {
			replaceLabSessionPath('/' . $oldName . '.', '/' . $p['name'] . '.');
		}
		return array('code' => 200, 'status' => 'success', 'message' => $GLOBALS['messages'][60023]);
	};
	if ($oldFile !== $newFile) {
		return lab_validation_move_transaction($oldFile, $newFile, $editOperation);
	}
	return $editOperation();
}

/*
 * Function to export labs.
 *
 * @param	Array		$p				Parameters
 * @return	Array						Return code (JSend data)
 */
function apiExportLabs($p)
{
	$export_url = '/Exports/pnetlab_export-' . date('Ymd-His') . '.zip';
	$export_file = '/opt/unetlab/data' . $export_url;
	if (!is_dir('/opt/unetlab/data/Exports')) {
		mkdir('/opt/unetlab/data/Exports', 0755, true);
	}
	if (is_file($export_file)) {
		unlink($export_file);
	}

	if (checkFolder(BASE_LAB . $p['path']) !== 0) {
		// Path is not valid
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][80077];
		return $output;
	}

	if (!chdir(BASE_LAB . $p['path'])) {
		// Cannot set CWD
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS[80072];
		return $output;
	}

	foreach ($p as $key => $element) {
		if ($key === 'path') {
			continue;
		}

		// Using "element" relative to "path", adding '/' if missing
		$relement = substr($element, strlen($p['path']));
		if ($relement[0] != '/') {
			$relement = '/' . $relement;
		}

		if (is_file(BASE_LAB . $p['path'] . $relement)) {
			// Adding a file
			$cmd = 'zip ' . $export_file . ' ".' . $relement . '"';
			secureCmd($cmd);
			exec($cmd, $o, $rc);
			if ($rc != 0) {
				$output['code'] = 400;
				$output['status'] = 'fail';
				$output['message'] = $GLOBALS['messages'][80073];
				return $output;
			}
		}

		if (checkFolder(BASE_LAB . $p['path'] . $relement) === 0) {
			// Adding a dir
			$cmd = 'zip -r ' . $export_file . ' ".' . $relement . '"';
			secureCmd($cmd);
			exec($cmd, $o, $rc);
			if ($rc != 0) {
				$output['code'] = 400;
				$output['status'] = 'fail';
				$output['message'] = $GLOBALS['messages'][80074];
				return $output;
			}
		}
	}

	// Now remove UUID from labs
	$cmd = BASE_DIR . '/scripts/remove_uuid.sh "' . $export_file . '"';
	secureCmd($cmd);
	exec($cmd, $o, $rc);
	if ($rc != 0) {
		if (is_file($export_file)) {
			unlink($export_file);
		}
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
		return $output;
	}

	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = $GLOBALS['messages'][80075];
	$output['data'] = $export_url;
	return $output;
}

/*
 * Function to get a lab.
 *
 * @param	Lab			$lab			Lab
 * @return	Array						Return code (JSend data)
 */
function apiGetLab($lab)
{
	// Printing info
	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = $GLOBALS['messages'][60020];
	$output['data'] = array(
		'author' => $lab->getAuthor(),
		'description' => $lab->getDescription(),
		'body' => $lab->getBody(),
		'filename' => $lab->getFilename(),
		'id' => $lab->getId(),
		'name' => $lab->getName(),
		'version' => $lab->getVersion(),
		'scripttimeout' => $lab->getScriptTimeout(),
		'countdown' => $lab->getCountdown(),
		'lock' => $lab->isLock(),
		'password' => $lab->getPassword() == '' ? 0 : 1,
		'openable' => $lab->getOpenable(),
		'joinable' => $lab->getJoinable(),
		'editable' => $lab->getEditable(),
		'openable_emails' => $lab->getOpenableEmails(),
		'joinable_emails' => $lab->getJoinableEmails(),
		'editable_emails' => $lab->getEditableEmails(),
		'darkmode' => $lab->getDarkMode(),
		'mode3d' => $lab->get3dMode(),
		'nogrid' => $lab->getNoGrid(),
		'session' => $lab->getSession(),
		'multi_config_active' => $lab->getMulti_config_active(),
	);
	return $output;
}

/*
 * Function to get all lab links (networks and serial endpoints).
 *
 * @param	Lab			$lab			Lab file
 * @return	Array						Return code (JSend data)
 */
function apiGetLabLinks($lab)
{
	$output['data'] = array();

	// Get ethernet links
	$ethernets = array();
	$networks = $lab->getNetworks();
	if (!empty($networks)) {
		foreach ($lab->getNetworks() as $network_id => $network) {
			$ethernets[$network_id] = $network->getName();
		}
	}

	// Get serial links
	$serials = array();
	$nodes = $lab->getNodes();
	if (!empty($nodes)) {
		foreach ($nodes as $node_id => $node) {
			if (!empty($node->getSerials())) {
				$serials[$node_id] = array();
				foreach ($node->getSerials() as $interface_id => $interface) {
					// Print all available serial links
					$serials[$node_id][$interface_id] = $node->getName() . ' ' . $interface->getName();
				}
			}
		}
	}

	// Printing info
	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = $GLOBALS['messages'][60024];
	$output['data']['ethernet'] = $ethernets;
	$output['data']['serial'] = $serials;
	return $output;
}

/*
 * Function to import labs.
 *
 * @param	Array		$p				Parameters
 * @return	Array						Return code (JSend data)
 */
function apiImportLabs($p)
{
	ini_set('max_execution_time', '600');
	ini_set('memory_limit', '1024M');

	$user = getUser();

	if (!isset($p['file']) || empty($p['file'])) {
		// Upload failed
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][80081];
		return $output;
	}

	if (!isset($p['path'])) {
		// Path is not set
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][80076];
		return $output;
	}

	if (checkFolder(BASE_LAB . $p['path']) !== 0) {
		// Path is not valid
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][80077];
		return $output;
	}

	$finfo = new finfo(FILEINFO_MIME);
	if (strpos($finfo->file($p['file']), 'application/zip') !== False) {
		// UNetLab export
		$tmpFolder = null;
		$tmpFolderCreated = false;
		try {
			// Each request gets its own extraction directory. Do not remove a
			// directory that another concurrent import may be using.
			$tmpFolder = rtrim(sys_get_temp_dir(), '/') . '/pnetlab-import-' . bin2hex(random_bytes(8));
			if (!mkdir($tmpFolder, 0700)) {
				throw new Exception('Could not create temporary import directory');
			}
			$tmpFolderCreated = true;
			$labFolder = BASE_LAB . $p['path'];

			$cmd = 'unzip -o -d "' . $tmpFolder . '" ' . $p['file'] . ' *.unl';
			secureCmd($cmd);
			exec($cmd, $o, $rc);
			if ($rc != 0) {
				$output['code'] = 400;
				$output['status'] = 'fail';
				$output['message'] = $GLOBALS['messages'][80079];
				return $output;
			}

			$importLabs = scanDirFiles($tmpFolder);
			$errorLabs = [];
			$errorDetails = [];
			$eveTotal = 0;
			$eveImported = 0;
			$eveSkipped = 0;
			$eveLabs = 0;

		foreach ($importLabs as $importLab) {

			$relativePath = preg_replace('/^' . preg_quote($tmpFolder, '/') . '/', '', $importLab);
			$backupFailure = false;

			try {
				// Lab construction can save and discard EVE's <objects><tasks>, so
				// retain the pristine bytes before constructing the object.
				$rawUnlBytes = file_get_contents($importLab);
				if ($rawUnlBytes === false) {
					throw new Exception('Could not read imported lab file');
				}

				$labObj = new Lab($importLab, $user['pod'], null, $user['email']);
				$stats = $labObj->getEveImportStats();
				$statsTotal = (int) $stats['total'];
				$statsImported = (int) $stats['imported'];
				$statsSkipped = (int) $stats['skipped'];
				$eveTotal += $statsTotal;
				$eveImported += $statsImported;
				$eveSkipped += $statsSkipped;
				if ($statsTotal > 0) {
					$eveLabs++;
				}

				$labFileName = $labFolder . $relativePath;
				$labFileDir = dirname($labFileName);

				// A task-bearing import gets a recovery copy in the final
				// destination, never in the temporary extraction directory. A
				// skipped task makes that copy a precondition for committing this
				// .unl; with no skips it is best-effort insurance only.
				if ($statsTotal > 0) {
					if (!is_dir($labFileDir) && !mkdir($labFileDir, 0755, true) && !is_dir($labFileDir)) {
						throw new Exception('Could not create destination directory');
					}
					$backupPath = $labFileDir . '/.' . basename($labFileName)
						. '.pre-import-' . bin2hex(random_bytes(8)) . '.bak';
					$backupHandle = fopen($backupPath, 'x');
					if ($backupHandle === false) {
						$backupFailure = ($statsSkipped > 0);
						if ($statsSkipped > 0) {
							throw new Exception(
								'Could not create recovery backup, ' . $statsSkipped
								. ' task(s) would have been skipped -- import of this lab aborted'
							);
						}
						error_log('Could not create optional recovery backup for ' . $relativePath);
					} else {
						$backupOk = true;
						$backupOffset = 0;
						$backupLength = strlen($rawUnlBytes);
						while ($backupOffset < $backupLength) {
							$written = fwrite($backupHandle, substr($rawUnlBytes, $backupOffset));
							if ($written === false || $written === 0) {
								$backupOk = false;
								break;
							}
							$backupOffset += $written;
						}
						if (!fclose($backupHandle)) {
							$backupOk = false;
						}

						if (!$backupOk) {
							@unlink($backupPath);
							if ($statsSkipped > 0) {
								$backupFailure = true;
								throw new Exception(
									'Could not create recovery backup, ' . $statsSkipped
									. ' task(s) would have been skipped -- import of this lab aborted'
								);
							}
							error_log('Could not write optional recovery backup for ' . $relativePath);
						} else {
							chmod($backupPath, 0644);
						}
					}
				}

				// Only seed default permissions when the imported .unl carries NONE
				// of its own — otherwise we would (a) destroy the sharing intent the
				// lab shipped with and (b) with a NULL importer email (stock admin)
				// produce a [null]/[''] allow-list that locks EVERYONE but admins out.
				// A flag getter returns '' when the attribute was absent in the XML.
				$hasPerms = ((string) $labObj->getOpenable() !== '')
					|| ((string) $labObj->getJoinable() !== '')
					|| ((string) $labObj->getEditable() !== '');
				if (!$hasPerms) {
					$me = ($user['email'] !== '' && $user['email'] !== null)
						? $user['email'] : (string) $user['pod'];
					$labObj->edit([
						'openable' => 2,
						'joinable' => 2,
						'editable' => 2,
						'openable_emails' => [$me],
						'joinable_emails' => [$me],
						'editable_emails' => [$me],
					]);
				}
				if (!is_dir($labFileDir) && !mkdir($labFileDir, 0755, true) && !is_dir($labFileDir)) {
					throw new Exception('Could not create destination directory');
				}
				if (!rename($importLab, $labFileName)) {
					throw new Exception('Could not move imported lab to destination');
				}
			} catch (Exception $th) {
				error_log($th->getMessage());
				$errorLabs[] = $relativePath;
				if ($backupFailure || strpos($th->getMessage(), 'Could not move imported lab') === 0) {
					$errorDetails[] = $relativePath . ': ' . $th->getMessage();
				}
				continue;
			}
		}

		if (count($errorLabs) > 0) {
			$errorMessage = 'Some Labs can not be imported: ' . implode(', ', $errorLabs);
			if (count($errorDetails) > 0) {
				$errorMessage .= ' (' . implode('; ', $errorDetails) . ')';
			}
			throw new Exception($errorMessage);
		}

		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][80080];
		if ($eveTotal > 0) {
			$output['message'] .= ' Imported ' . $eveImported . ' of ' . $eveTotal
				. ' tasks across ' . $eveLabs . ' lab(s) (' . $eveSkipped
				. ' skipped -- see server log)';
		}
		return $output;
		} finally {
			if ($tmpFolderCreated && $tmpFolder !== null && is_dir($tmpFolder)) {
				$cleanupOutput = [];
				$cleanupRc = 0;
				exec('rm -rf -- ' . escapeshellarg($tmpFolder), $cleanupOutput, $cleanupRc);
				if ($cleanupRc != 0 && is_dir($tmpFolder)) {
					error_log('Could not clean temporary import directory ' . $tmpFolder);
				}
			}
		}
	} else {
		// File is not a Zip
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][80078];
		return $output;
	}
}

/*
 * Function to move a lab inside another folder.
 *
 * @param	Lab			$lab			Lab
 * @param	string		$path			Destination path
 * @return	Array						Return code (JSend data)
 */
function apiMoveLab($lab, $path)
{

	$rc = checkFolder(BASE_LAB . $path);
	if ($rc === 2) {
		// Folder is not valid
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60009];
		return $output;
	} else if ($rc === 1) {
		// Folder does not exist
		$output['code'] = 404;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60008];
		return $output;
	}

	if (is_file(BASE_LAB . $path . '/' . $lab->getFilename())) {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60016];
		return $output;
	}

	$oldFile = $lab->getPath() . '/' . $lab->getFilename();
	$newFile = BASE_LAB . $path . '/' . $lab->getFilename();
	return lab_validation_move_transaction($oldFile, $newFile, function () use ($lab, $path, $oldFile, $newFile) {
		if (rename($oldFile, $newFile)) {
			$search = str_replace([BASE_LAB, '//'], ['', '/'], $oldFile);
			$replacement = str_replace('//', '/', $path . '/' . $lab->getFilename());
			replaceLabSessionPath($search, $replacement);
			return array('code' => 200, 'status' => 'success', 'message' => $GLOBALS['messages'][60035]);
		}
		error_log(date('M d H:i:s ') . 'ERROR: ' . $GLOBALS['messages'][60034]);
		return array('code' => 400, 'status' => 'fail', 'message' => $GLOBALS['messages'][60034]);
	});
}

/*
 * Function to Lock  a lab 
 *
 * @param       Lab                     $lab                    Lab
 * @return      Array                                           Return code (JSend data)
 */

function apiLockLab($lab, $pass)
{
	$rc = $lab->lockLab($pass);
	if ($rc !== 0) {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	} else {
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60023];
	}
	return $output;
}

/*
 * Function to Unlock  a lab
 *
 * @param       Lab                     $lab                    Lab
 * @return      Array                                           Return code (JSend data)
 */

function apiUnlockLab($lab, $pass, $clearPass)
{
	$rc = $lab->unlockLab($pass, $clearPass);
	if ($rc !== 0) {
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][$rc];
	} else {
		$output['code'] = 200;
		$output['status'] = 'success';
		$output['message'] = $GLOBALS['messages'][60023];
	}
	return $output;
}
