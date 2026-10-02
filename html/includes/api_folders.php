<?php
# vim: syntax=php tabstop=4 softtabstop=0 noexpandtab laststatus=1 ruler

/**
 * html/includes/api_folders.php
 *
 * Folders related functions for REST APIs.
 *
 * @author Andrea Dainese <andrea.dainese@gmail.com>
 * @copyright 2014-2016 Andrea Dainese
 * @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
 * @link http://www.unetlab.com/
 * @version 20160719
 */

/*
 * Function to add a folder to a path.
 *
 * @param   string     $name            Folder name
 * @param   string     $path            Path
 * @return  Array                       Return code (JSend data)
 */
function apiAddFolder($name, $path) {
	$rc = checkFolder(BASE_LAB.$path);
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

	if ($path == '/') {
		// Avoid double '/'
		$path = '';
	}

	// Check if exists
	if (is_dir(BASE_LAB.$path.'/'.$name)) {
		// Folder already exists
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60013];
	} else {
		try {
			mkdir(BASE_LAB.$path.'/'.$name);
			$output['code'] = 200;
			$output['status'] = 'success';
			$output['message'] = $GLOBALS['messages'][60014];
		} catch (Exception $e) {
			error_log(date('M d H:i:s ').'ERROR: '.$GLOBALS['messages'][60015]);
			error_log(date('M d H:i:s ').(string) $e);
			$output['code'] = 400;
			$output['status'] = 'fail';
			$output['message'] = $GLOBALS['messages'][60015];
		}
	}

	return $output;
}

/**
 * Function to delete a folder.
 *
 * @param   string     $path            Path
 * @return  Array                       Return code (JSend data)
 */
function apiDeleteFolder($path) {
	securePath($path);
	$rc = checkFolder(BASE_LAB.$path);
	checkLabFolder(BASE_LAB.$path);

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

	if ($path == '/') {
		// Cannot delete '/'
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60010];
		return $output;
	}

	return lab_validation_folder_delete_transaction($path, function () use ($path) {
		// The web tier runs as www-data; retry root-owned lab trees via broker.
		$cmd = 'rm -rf "'.BASE_LAB.$path.'" 2>&1';
		$o = array(); $deleteRc = 0;
		exec($cmd, $o, $deleteRc);
		if ($deleteRc != 0 && is_dir(BASE_LAB.$path)) {
			require_once BASE_DIR.'/html/includes/broker.php';
			$resp = broker_call('folder_delete', ['path' => BASE_LAB.$path]);
			clearstatcache(true, BASE_LAB.$path);
			if (!empty($resp['ok']) && !is_dir(BASE_LAB.$path)) $deleteRc = 0;
		}
		if ($deleteRc == 0 && !is_dir(BASE_LAB.$path)) {
			return array('code' => 200, 'status' => 'success', 'message' => $GLOBALS['messages'][60012]);
		}
		return array('code' => 400, 'status' => 'fail', 'message' => $GLOBALS['messages'][60011]);
	});
}

/**
 * Function to edit a folder.
 *
 * @param   string     $s	            Full path of the source folder
 * @param   string     $d				Full path of the destination folder
 * @return  Array                       Return code (JSend data)
 */
function apiEditFolder($s, $d) {
	securePath($s);
	securePath($d);
	$rc = checkFolder(BASE_LAB.$s);
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

	$rc = checkFolder(BASE_LAB.$d);
	if ($rc === 2) {
		// Folder is not valid
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60047];
		return $output;
	} else if ($rc === 0) {
		// Folder already exists
		$output['code'] = 400;
		$output['status'] = 'fail';
		$output['message'] = $GLOBALS['messages'][60046];
		return $output;
	}

	return lab_validation_folder_move_transaction($s, $d, function () use ($s, $d) {
		$cmd = 'mv "'.BASE_LAB.$s.'" "'.BASE_LAB.$d.'" 2>&1';
		$o = array(); $moveRc = 0;
		exec($cmd, $o, $moveRc);
		if ($moveRc == 0) {
			$search = $s; $replacement = $d;
			if($s[-1] != '/') $search .= '/';
			if($d[-1] != '/') $replacement .= '/';
			replaceLabSessionPath($search, $replacement);
			return array('code' => 200, 'status' => 'success', 'message' => $GLOBALS['messages'][60049]);
		}
		return array('code' => 400, 'status' => 'fail', 'message' => $GLOBALS['messages'][60048]);
	});
}


function checkLabFolder($path){
	$labFiles = scanDirFiles($path);
	$user = getUser();
	if(!$user) throw new Exception('No User');

	$db = checkDatabase();
	$query = 'SELECT user_role_workspace, user_role_name FROM user_roles';
	$statement = $db->prepare($query);
	$statement->execute();
	$result = $statement->fetchAll(PDO::FETCH_ASSOC);

	foreach($result as $workspace){
		$workspacePath = BASE_LAB.$workspace['user_role_workspace'];
		if (strpos($workspacePath, $path) === 0) {
			throw new ResponseException( 'error_folder_workspace', ['folder' => $workspacePath, 'role' => $workspace['user_role_name']]);
		}
	}

	foreach ($labFiles as $file){
		try {
			$lab = new Lab($file, $user['pod']);
		} catch (Exception $e) {
			continue;
		}
		if(isset($lab) && $lab->isRunning()) throw new ResponseException('error_folder_running', ['data' => $path]);
		
		
	}


	return true;
}


/**
 * Function to get all folders from a path.
 *
 * @param   string     $path            Path
 * @return  Array                       List of folders (JSend data)
 */
function apiGetFolders($path) {
	$rc = checkFolder(BASE_LAB.$path);
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

	// Listing content
	$folders = Array();
	$labs = Array();

	if ($path != '/') {
		// Adding '..' folder
		$folders[] = Array(
			'name' => '..',
			'path' => dirname($path)
		);
	}

	// Scanning directory
	foreach (scandir(BASE_LAB.$path) as $element) {
		if (!in_array($element, array('.', '..'))) {
			if (is_dir(BASE_LAB.$path.'/'.$element)) {
				if ($path == '/') {
					$folders[] = Array(
						'name' => $element,
						'path' => '/'.$element
					);
				} else {
					$folders[] = Array(
						'name' => $element,
						'path' => $path.'/'.$element
					);
				}
				continue;
			}
			if (is_file(BASE_LAB.$path.'/'.$element) && preg_match('/^.+\.unl$/', $element)) {
				if ($path == '/') {
					$labs[] = Array(
						'file' => $element,
						'path' => '/'.$element,
						'umtime' => filemtime(BASE_LAB.$path.'/'.$element),
						'mtime' => date ("d M Y H:i", filemtime(BASE_LAB.$path.'/'.$element))
					);
				} else {
					$labs[] = Array(
						'file' => $element,
						'path' => $path.'/'.$element,
						'umtime' => filemtime(BASE_LAB.$path.'/'.$element),
						'mtime' => date ("d M Y  H:i", filemtime(BASE_LAB.$path.'/'.$element))
					);
				}
				continue;
			}
		}
	}


	//EVE_STORE sell lab
	foreach ($labs as $key => $lab){
		$labs[$key]['owner'] = file_get_contents(BASE_LAB.$lab['path'], false, null, 0, 5) == '<?xml';
	}

	$sharedFolders = getSharedFolder();
	
	foreach($sharedFolders as $sharedFolder){
		$sharedFolder = preg_replace('/' . preg_quote(BASE_LAB, '/') . '/', '', $sharedFolder);
		foreach ($folders as $key=>$folder){
			if($folder['path'] == $sharedFolder) $folders[$key]['shared'] = true;
		}
	}
	

	// Sorting
	usort($folders, function($a, $b){
		return strnatcasecmp($b['name'], $a['name']);
	});

	usort($labs, function($a, $b){
		return strnatcasecmp($b['umtime'], $a['umtime']);
	});

	usort($labs, function($a, $b){
		return strnatcasecmp($b['file'], $a['file']);
	});

	


	// Printing info
	$output['code'] = 200;
	$output['status'] = 'success';
	$output['message'] = $GLOBALS['messages'][60007];
	$output['data'] = Array(
		'folders' => $folders,
		'labs' => $labs
	);
	return $output;
}
?>
